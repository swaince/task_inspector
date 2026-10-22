<script setup lang="ts">
import type { ActivityRow as Row } from '@/core/store/activity'
import type { GitCommit } from '@/core/domain/types'
import type { ActivityFailure } from '@/core/engine/activity'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangleIcon, ChevronRightIcon, Loader2Icon, PlayIcon, RefreshCwIcon, SparklesIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import DatePicker from '@/components/common/DatePicker.vue'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import StructuredReport from '@/components/activity/StructuredReport.vue'
import DailyCharts from '@/components/activity/DailyCharts.vue'
import PersonContribution from '@/components/activity/PersonContribution.vue'
import CommitInspectorDialog from '@/components/inspection/CommitInspectorDialog.vue'
import ProjectPicker from '@/components/common/ProjectPicker.vue'
import MetricLegend from '@/components/common/MetricLegend.vue'
import { GitLabClient } from '@/core/adapters/gitlab'
import { useWorkCalendar } from '@/core/calendar/useWorkCalendar'
import { buildIdentities, collectProjectCommits, commitOwner } from '@/core/engine/activity'
import { projectMatches, toProjectRefs } from '@/core/engine/matching'
import { assignCommitDate, dateRange } from '@/core/engine/window'
import { dayMetrics } from '@/core/engine/metrics'
import { createLlmClient } from '@/core/llm/client'
import { useActivityStore } from '@/core/store/activity'
import { useMemberStore } from '@/core/store/members'
import { useProjectStore } from '@/core/store/projects'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'
import { dateKeyOffset, formatDateTime } from '@/lib/format'

/**
 * 项目活动：某个项目在一段时间里，谁提交了什么、谁在日报里报了什么。
 *
 * 和「执行检查」的区别是视角：检查是「一天 × 一个人」，由日报驱动；
 * 这里是「一个项目 × 一段时间」，由项目驱动。两边用的是同一套时间窗规则和同一套
 * 人员/项目匹配，所以同一个提交在两边归属的日子是一致的。
 *
 * 结果存进 activity store：点进「详情」再返回时组件会重建，
 * 但扫描结果不该跟着丢——用户要的是「回去接着看」，不是重扫一遍。
 */

const TABS = [
  { key: 'rows', label: '明细' },
  { key: 'day', label: '按天' },
  { key: 'person', label: '按人' },
  { key: 'report', label: '分析报告' },
] as const

type ViewMode = typeof TABS[number]['key']

/** 指标口径，显示在对应表格底部 */
const DAY_LEGEND = [
  { label: '日期', desc: '提交按「前一天 20:00 ~ 次日 08:00」的窗口归属，与执行检查一致' },
  { label: '提交', desc: '当天该项目下的提交条数，只统计仓库默认分支' },
  { label: '参与人', desc: '当天有提交的人数；没匹配到人员实体的作者按邮箱单列' },
  { label: '代码量', desc: '+新增 / -删除行数，来自 GitLab 提交统计，生成文件与格式化也会计入' },
  { label: '申报工时', desc: '当天日报里写到这个项目的工时合计，同一人多条会相加' },
  { label: '活跃时段', desc: '有提交的 30 分钟时段数之和，按人分别计算再相加' },
  { label: '有效工时', desc: '按人按天的提交会话估算后求和，代码量按项目开发模式修正；只覆盖代码产出，不含会议/评审' },
  { label: '有提交未申报', desc: '当天有提交、但日报没有提到这个项目的人数' },
]

const PERSON_LEGEND = [
  { label: '人员', desc: '按配置的 Git 用户名/邮箱把提交归到人；匹配不上的按作者邮箱单列' },
  { label: '提交', desc: '区间内该项目下的提交条数' },
  { label: '活跃天数', desc: '区间内有提交的天数，不是提交条数' },
  { label: '代码量', desc: '区间内累计 +新增 / -删除行数' },
  { label: '申报工时', desc: '区间内这个人在日报里为该项目申报的工时合计' },
  { label: '有提交未申报', desc: '有提交、但当天日报没写这个项目的天数' },
  { label: '最近提交', desc: '区间内最后一次提交的作者时间' },
]

const projectStore = useProjectStore()
const memberStore = useMemberStore()
const reportStore = useReportStore()
const settingsStore = useSettingsStore()
const router = useRouter()

const projectId = ref('')
const from = ref(dateKeyOffset(-7))
const to = ref(dateKeyOffset(-1))

const loading = ref(false)
const progress = ref('')
const error = ref<string | null>(null)
const failures = ref<ActivityFailure[]>([])
const rows = ref<Row[]>([])
const scannedAt = ref<string | null>(null)
/** 实时拉日报失败时置位：此时「申报」列来自本地缓存，可能已经过期 */
const liveFailed = ref<string | null>(null)

const activityStore = useActivityStore()
const viewMode = ref<ViewMode>('rows')

/** 点开的提交。diff 逐条拉一次请求，所以不在扫描阶段预先取 */
const inspectedCommit = ref<GitCommit | null>(null)
const commitOpen = ref(false)

function inspect(commit: GitCommit) {
  inspectedCommit.value = commit
  commitOpen.value = true
}

/**
 * 打开详情页。
 *
 * 表格一行只放得下 3 条提交，剩下的被截掉了；要看清「这天这个人干了什么」
 * 必须把提交和日报两边摊开，那是另一页的事，不塞进表格里。
 */
function openDetail(row: Row) {
  router.push({
    name: 'activity-detail',
    params: { projectId: projectId.value, date: row.date, memberKey: row.memberKey },
  })
}

/** 只让「启用且关注」的项目出现在这里——和检查的范围保持一致 */
const candidates = computed(() =>
  projectStore.items
    .filter(p => p.enabled && p.followed)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
)

const selected = computed(() => candidates.value.find(p => p.id === projectId.value) ?? null)

/** 有效工时的代码量修正按项目开发模式定；老数据没有标注时按人工开发 */
const devMode = computed(() => selected.value?.devMode ?? 'manual')

const DEV_MODE_LABEL: Record<'manual' | 'ai-assisted' | 'ai-driven', string> = {
  manual: '人工开发',
  'ai-assisted': 'AI 辅助',
  'ai-driven': 'AI 开发为主',
}

const dates = computed(() => dateRange(from.value, to.value))

/* 工作日历：节假日不计入缺报和活跃天数分母 */
const { isWorkday, dayInfo } = useWorkCalendar()
const workdayList = computed(() => dates.value.filter(d => isWorkday(d)))

/** 区间内完全没有日报数据时，结果会全是「未申报」，容易误读成漏报 */
const noReportData = computed(() =>
  !loading.value && dates.value.length > 0 && dates.value.every(d => !(reportStore.cache[d]?.length)),
)

const totals = computed(() => ({
  commits: rows.value.reduce((s, r) => s + r.commits.length, 0),
  people: new Set(rows.value.map(r => r.memberKey)).size,
  missingInReport: rows.value.filter(r => r.missingInReport).length,
  missingCommits: rows.value.filter(r => r.missingCommits).length,
}))

/* ------------------------------------------------------------------ *
 * 两个维度的汇总
 * ------------------------------------------------------------------ */

function volumeOf(commits: GitCommit[]) {
  let additions = 0
  let deletions = 0
  for (const commit of commits) {
    additions += commit.stats?.additions ?? 0
    deletions += commit.stats?.deletions ?? 0
  }
  return { additions, deletions }
}

interface DayStat {
  date: string
  commits: number
  people: number
  additions: number
  deletions: number
  hours: number
  /** 当天有提交但没写日报的人数 */
  missingPeople: number
  /** 按人分别计算后求和：活跃时段数 */
  activeBuckets: number
  /** 预估有效工时区间（Σ 各人） */
  effectiveLow: number
  effectiveHigh: number
  /** 有人在短时间集中提交：可能是一次补提交 */
  batchSuspect: boolean
}

const byDay = computed<DayStat[]>(() => {
  const map = new Map<string, DayStat>()
  for (const row of rows.value) {
    const stat = map.get(row.date) ?? {
      date: row.date,
      commits: 0,
      people: 0,
      additions: 0,
      deletions: 0,
      hours: 0,
      missingPeople: 0,
      activeBuckets: 0,
      effectiveLow: 0,
      effectiveHigh: 0,
      batchSuspect: false,
    }
    const volume = volumeOf(row.commits)
    // 按人算再汇总：把不同人的提交混在一起算「在场时长」会跨出一天
    const metrics = dayMetrics(row.commits, { devMode: devMode.value })
    stat.commits += row.commits.length
    if (row.commits.length)
      stat.people++
    stat.additions += volume.additions
    stat.deletions += volume.deletions
    stat.hours += row.hours
    stat.activeBuckets += metrics.activeBuckets
    stat.effectiveLow += metrics.effectiveLow
    stat.effectiveHigh += metrics.effectiveHigh
    stat.batchSuspect ||= metrics.batchSuspect
    if (row.missingInReport)
      stat.missingPeople++
    map.set(row.date, stat)
  }
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date))
})

interface PersonStat {
  key: string
  name: string
  unmatched: boolean
  commits: number
  activeDays: number
  additions: number
  deletions: number
  hours: number
  missingDays: number
  lastCommit: string
}

const byPerson = computed<PersonStat[]>(() => {
  const map = new Map<string, PersonStat>()
  for (const row of rows.value) {
    const stat = map.get(row.memberKey) ?? {
      key: row.memberKey,
      name: row.memberName,
      unmatched: row.memberKey.startsWith('author:'),
      commits: 0,
      activeDays: 0,
      additions: 0,
      deletions: 0,
      hours: 0,
      missingDays: 0,
      lastCommit: '',
    }
    const volume = volumeOf(row.commits)
    stat.commits += row.commits.length
    if (row.commits.length)
      stat.activeDays++
    stat.additions += volume.additions
    stat.deletions += volume.deletions
    stat.hours += row.hours
    if (row.missingInReport)
      stat.missingDays++
    for (const commit of row.commits) {
      if (commit.authoredDate > stat.lastCommit)
        stat.lastCommit = commit.authoredDate
    }
    map.set(row.memberKey, stat)
  }
  return [...map.values()].sort((a, b) => b.commits - a.commits)
})

/* ------------------------------------------------------------------ *
 * 报告页的图表数据
 * ------------------------------------------------------------------ */

/**
 * 报告页的日序列：补齐区间里没有记录的天。
 * 只画有数据的日子会把空档抹掉，「某几天完全没动」这个事实就看不见了。
 */
const reportDays = computed(() => {
  const map = new Map(byDay.value.map(d => [d.date, d]))
  return dates.value.map((date) => {
    const stat = map.get(date)
    return {
      date,
      commits: stat?.commits ?? 0,
      reportedHours: stat?.hours ?? 0,
      effectiveLow: stat?.effectiveLow ?? 0,
      effectiveHigh: stat?.effectiveHigh ?? 0,
      hasReport: (stat?.hours ?? 0) > 0,
    }
  })
})

const reportHighlights = computed(() => {
  const days = reportDays.value
  const dayMap = new Map(days.map(d => [d.date, d]))
  const active = workdayList.value.filter(d => (dayMap.get(d)?.commits ?? 0) > 0)
  const peak = days.filter(d => d.commits > 0).sort((a, b) => b.commits - a.commits)[0]
  const total = days.reduce((s, d) => s + d.commits, 0)
  return [
    {
      label: '峰值日',
      value: peak ? `${peak.date.slice(5)} · ${peak.commits} 条` : '—',
      hint: peak && total ? `占区间提交的 ${Math.round((peak.commits / total) * 100)}%` : '区间内没有提交',
    },
    {
      label: '活跃工作日',
      value: `${active.length} / ${workdayList.value.length} 天`,
      hint: '有提交的工作日，节假日不计入分母',
    },
    {
      label: '有提交未申报',
      value: `${totals.value.missingInReport} 条记录`,
      hint: '工作日有提交但日报没写这个项目',
    },
    {
      label: '已申报无提交',
      value: `${totals.value.missingCommits} 条记录`,
      hint: '工作日写了工时但当天没有提交',
    },
  ]
})

/* ------------------------------------------------------------------ *
 * 分析报告
 * ------------------------------------------------------------------ */

const REPORT_SYSTEM = `你是研发效能分析师。根据一个项目在一段时间内的提交记录与日报申报，写一份结构化的分析报告。
硬性要求：
1. 所有数字必须来自给定数据；数据不足写「数据不足」，不得猜测；
2. 不评价个人绩效，只陈述事实和可跟进的点；
3. 报告必须包含表格和图表（图表用 chart 代码块输出 JSON 规格），数字优先放进表格，不要用大段文字复述；
4. 每个文字段落不超过三句话；
5. 图表一律使用 chart 代码块，不要使用 mermaid；
6. 只输出 markdown 正文：不要一级标题，不要开场白，不要套话总结。`

function buildReportPrompt(): string {
  const project = selected.value
  const dayLines = byDay.value.slice(0, 62).map(d =>
    `${d.date}：提交 ${d.commits} 条，${d.people} 人参与，+${d.additions}/-${d.deletions}，`
    + `申报 ${d.hours}h，有效工时 ${d.effectiveLow}-${d.effectiveHigh}h（仅代码产出），`
    + `有提交未申报 ${d.missingPeople} 人`,
  )
  const personLines = byPerson.value.slice(0, 50).map(p =>
    `${p.name}${p.unmatched ? '（未匹配到人员）' : ''}：提交 ${p.commits} 条，活跃 ${p.activeDays} 天，`
    + `+${p.additions}/-${p.deletions}，申报 ${p.hours}h，有提交未申报 ${p.missingDays} 天`,
  )
  const recent = rows.value
    .flatMap(r => r.commits.map(c => `${r.date} ${c.authorName}：${c.title}`))
    .sort()
    .reverse()
    .slice(0, 25)

  /* 图表要按完整日序列画，包括没有记录的天，否则趋势会断 */
  const chartDays = reportDays.value.map(d =>
    `${d.date}：提交 ${d.commits} 条，申报 ${d.reportedHours}h，代码估算 ${d.effectiveLow}-${d.effectiveHigh}h`,
  )

  /*
   * 日报正文必须带上。
   *
   * 之前只传了「日期 + 工时」，模型看不到申报内容，只能写「未提供工作内容」——
   * 而用户明明写了「整理需求文档、梳理架构设计」。凡是「有申报没提交」的天数，
   * 判断依据全在这段正文里。
   */
  const declared = rows.value
    .filter(r => r.reported && (r.contents.length || r.hours))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 80)
    .map(r => `${r.date} ${r.memberName}：${r.hours}h — ${r.contents.join('；') || '（日报未填写内容）'}`)

  return `项目：${project?.name ?? ''}${project?.code ? `（${project.code}）` : ''}\n`
    + `区间：${from.value} ~ ${to.value}（${dates.value.length} 个自然日，其中工作日 ${workdayList.value.length} 天）\n`
    + `提交 ${totals.value.commits} 条，涉及 ${totals.value.people} 人；有提交未申报 ${totals.value.missingInReport} 条记录。\n`
    + `口径：有效工时按人按天估算后求和（代码量按「${DEV_MODE_LABEL[devMode.value]}」模式修正），`
    + `只统计代码产出（提交、活跃时段、改动量），不含会议、评审、答疑；数值是区间，不是精确工时。\n\n`
    + `按天：\n${dayLines.join('\n') || '（无）'}\n\n`
    + `按人：\n${personLines.join('\n') || '（无）'}\n\n`
    + `日报申报内容：\n${declared.join('\n') || '（无）'}\n\n`
    + `最近的提交标题：\n${recent.join('\n') || '（无）'}\n\n`
    + `每日序列（含无记录的天）：\n${chartDays.join('\n') || '（无）'}\n\n`
    + `判断「有申报无提交」的日子时，以「日报申报内容」为准：里面写了需求文档、架构设计、评审、`
    + `会议、答疑这类工作，就属于非编码工作，不要笼统写成「未提供工作内容」。\n`
    + `周末和法定节假日没有提交、没有日报是正常的，不要写成漏报或缺勤；活跃天数、未申报记录都只按工作日判断。\n\n`
    + `请严格按以下结构输出，不要增删章节，也不要用文字重复表格里已有的数字：\n\n`
    + `## 总览\n`
    + `一张三列表格：| 指标 | 数值 | 说明 |，至少包含提交条数、涉及人员、申报工时、代码估算有效工时、活跃工作日、有提交未申报记录、已申报无提交记录。\n\n`
    + `## 每日趋势\n`
    + `用上面的「每日序列」原样输出两个图表，每个图表放在一个 chart 代码块里，内容是合法 JSON，数字不得改动：\n`
    + `1) 每日提交条数（柱状）；2) 每日申报工时（柱状）与代码估算（折线）。\n`
    + '第一个图的格式：\n```chart\n{"title":"每日提交","unit":"条","labels":["10-12","10-13"],"series":[{"name":"提交","type":"bar","data":[8,6]}]}\n```\n'
    + `第二个图在同一份 series 里放两项：{"name":"申报工时","type":"bar","data":[...]} 和 {"name":"代码估算","type":"line","data":[...]}。\n`
    + `labels 必须覆盖区间内每一天，没提交的天写 0；JSON 里不要写注释，也不要包进 markdown 表格。\n\n`
    + `## 人员投入\n`
    + `一张表格：| 人员 | 提交 | 活跃天数 | 申报工时 | 有提交未申报 |。\n`
    + `表格之后，再输出一个 donut 图表展示各人的提交占比：\n`
    + '```chart\n{"type":"donut","title":"人员提交占比","unit":"条","labels":["张三","李四"],"series":[{"name":"提交","data":[85,9]}]}\n```\n'
    + `数据用表格里的提交条数，labels 与表格里的人一一对应。\n\n`
    + `## 与日报的对照\n`
    + `一张表格：| 日期 | 人员 | 问题 | 依据 |，只列异常（有提交未申报 / 已申报无提交 / 无记录）。\n\n`
    + `## 建议\n不超过 3 条列表，每条一句话。`
}

const report = computed(() => activityStore.snapshot?.report ?? '')
const reportAt = computed(() => activityStore.snapshot?.reportAt ?? null)

async function generateReport() {
  if (!selected.value || !rows.value.length)
    return
  activityStore.generatingReport = true
  activityStore.reportError = null
  try {
    const client = createLlmClient(settingsStore.settings.llm)
    const completion = await client.complete([
      { role: 'system', content: REPORT_SYSTEM },
      { role: 'user', content: buildReportPrompt() },
    ])
    const snap = activityStore.snapshot
    if (snap)
      activityStore.save({ ...snap, report: completion.text.trim(), reportAt: new Date().toISOString() })
    viewMode.value = 'report'
  }
  catch (err) {
    activityStore.reportError = err instanceof Error ? err.message : String(err)
  }
  finally {
    activityStore.generatingReport = false
  }
}

onMounted(async () => {
  await Promise.all([projectStore.load(), memberStore.load(), reportStore.load()])

  // 从详情页返回时组件会重建：把上次的扫描结果直接恢复出来，
  // 用户不需要为了「看一眼再回去」重新扫一遍
  const snap = activityStore.snapshot
  if (snap) {
    projectId.value = snap.projectId
    from.value = snap.from
    to.value = snap.to
    rows.value = snap.rows
    failures.value = snap.failures
    scannedAt.value = snap.scannedAt
    liveFailed.value = snap.liveFailed
    return
  }

  // 默认选中第一个关注的项目，省一次点击
  if (!projectId.value && candidates.value.length)
    projectId.value = candidates.value[0].id
})

async function load() {
  const project = selected.value
  if (!project) {
    error.value = '先选一个项目'
    return
  }

  const refs = toProjectRefs(project)
  if (!refs.length) {
    error.value = `项目「${project.name}」还没有关联到任何仓库。到「项目」面板加上仓库或组，然后点「解析关联仓库」`
    return
  }

  const range = dates.value
  if (!range.length) {
    error.value = '日期范围不合法'
    return
  }
  if (range.length > 62) {
    error.value = '范围最多 62 天。范围再大，逐个仓库扫过去会慢到没法用'
    return
  }

  loading.value = true
  error.value = null
  failures.value = []
  rows.value = []
  liveFailed.value = null
  progress.value = '正在读取日报…'

  try {
    await reportStore.load()
    // 日报会被补写：每次扫描都直接问源系统要这一段的最新版本，
    // 本地那份只当拉取失败时的兜底
    progress.value = '正在拉取最新日报…'
    const live = await reportStore.refreshRange(from.value, to.value)
    liveFailed.value = live.ok ? null : (live.error ?? '未知原因')

    progress.value = '正在扫描仓库…'

    const settings = settingsStore.settings
    const { batches, failures: failed } = await collectProjectCommits(refs, from.value, to.value, {
      gitlab: new GitLabClient(settings.gitlab),
      rules: settings.rules,
      perPage: settings.gitlab.perPage,
      maxCommitsPerProject: settings.rules.maxCommitsPerProject,
      onProgress: p => (progress.value = p.message),
    })
    failures.value = failed

    rows.value = buildRows(batches.flatMap(b => b.commits), range)
    scannedAt.value = new Date().toLocaleTimeString()

    // 同一个项目 + 区间重扫时保留已有报告，否则清空（报告讲的是另一段数据）
    const previous = activityStore.take(projectId.value, from.value, to.value)
    activityStore.save({
      projectId: projectId.value,
      from: from.value,
      to: to.value,
      rows: rows.value,
      failures: failures.value,
      scannedAt: scannedAt.value,
      liveFailed: liveFailed.value,
      report: previous?.report ?? '',
      reportAt: previous?.reportAt ?? null,
    })
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
    progress.value = ''
  }
}

/**
 * 把「提交」和「日报条目」拼成一张 (日期 × 人员) 的表。
 *
 * 两边各自先归集、再按同一个 key 合并：key 用人员的日报 ID，
 * 因为提交侧匹配到的人员实体和日报侧指向的是同一个人，只有日报 ID 是两边共有的。
 * 匹配不上人员实体的提交（外包、机器人、还没建实体）单独成行，不并进别人那里——
 * 并错比漏掉更难发现。
 */
function buildRows(commits: GitCommit[], range: string[]): Row[] {
  const rules = settingsStore.settings.rules
  const identities = buildIdentities(memberStore.items)
  const map = new Map<string, Row>()

  const keyOf = (date: string, memberKey: string) => `${date}|${memberKey}`
  const ensure = (date: string, memberKey: string, memberName: string): Row => {
    const key = keyOf(date, memberKey)
    let row = map.get(key)
    if (!row) {
      row = {
        date,
        memberKey,
        memberName,
        commits: [],
        reported: false,
        hours: 0,
        contents: [],
        missingInReport: false,
        missingCommits: false,
      }
      map.set(key, row)
    }
    return row
  }

  for (const commit of commits) {
    const date = assignCommitDate(commit.authoredDate, range, rules)
    if (!date)
      continue
    const owner = commitOwner(commit, identities)
    const memberKey = owner ? (owner.reportMemberId || owner.id) : `author:${commit.authorEmail}`
    const row = ensure(date, memberKey, owner?.name ?? commit.authorName)
    row.commits.push(commit)
  }

  for (const date of range) {
    for (const report of reportStore.cache[date] ?? []) {
      const entries = report.entries.filter(e => matchReportEntry(e))
      if (!entries.length)
        continue
      const row = ensure(date, report.memberId, report.memberName)
      row.reported = true
      row.hours += entries.reduce((s, e) => s + e.hours, 0)
      row.contents.push(...entries.map(e => e.content).filter(Boolean))
    }
  }

  for (const row of map.values()) {
    // 节假日没有提交/日报是正常的，不算漏报；只有工作日才标记
    row.missingInReport = isWorkday(row.date) && row.commits.length > 0 && !row.reported
    row.missingCommits = isWorkday(row.date) && row.reported && row.commits.length === 0
  }

  return [...map.values()].sort((a, b) =>
    b.date.localeCompare(a.date) || a.memberName.localeCompare(b.memberName, 'zh-Hans-CN'),
  )
}

function matchReportEntry(entry: { projectName: string, projectCode?: string }) {
  const project = selected.value
  return project ? projectMatches(project, entry) : false
}

function fmtTime(iso: string) {
  return iso.replace('T', ' ').slice(5, 16)
}
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <Card class="gap-0 py-4">
        <CardContent class="space-y-3 px-4">
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="space-y-1.5 lg:col-span-2">
              <Label class="text-xs">项目</Label>
              <ProjectPicker
                v-model="projectId"
                :projects="candidates"
                placeholder="搜索并选择项目"
              />
              <p v-if="!candidates.length" class="text-[11px] text-muted-foreground">
                没有可选的关注项目。到「项目」面板新建或打开关注——未关注的项目不参与检查，
                也不出现在这里。
              </p>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs">起始日期</Label>
              <DatePicker v-model="from" class="h-8 text-xs" />
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs">结束日期</Label>
              <DatePicker v-model="to" class="h-8 text-xs" />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 border-t pt-3">
            <span v-if="progress" class="text-xs text-muted-foreground">{{ progress }}</span>
            <span v-else-if="scannedAt" class="text-xs text-muted-foreground">
              <RefreshCwIcon :size="11" class="mr-1 inline" />
              {{ scannedAt }} 扫描
            </span>
            <Button class="ml-auto" :disabled="loading || !selected" @click="load">
              <Loader2Icon v-if="loading" :size="13" class="mr-1.5 animate-spin" />
              <PlayIcon v-else :size="13" class="mr-1.5" />
              查这段时间
            </Button>
          </div>

          <details class="text-[11px] text-muted-foreground">
            <summary class="cursor-pointer select-none">
              时间口径说明
            </summary>
            <p class="mt-1 max-w-prose leading-relaxed">
              提交按「前一天 20:00 ~ 次日 08:00」的窗口归属到日期，和「执行检查」用的是同一套规则，
              所以同一个提交在两个页面归属的日子一致。默认最近 7 天（截止昨天）——日报当天晚上才上报，
              含今天会不完整；周末和节假日按工作日历自动排除在缺报判断之外。
            </p>
          </details>
        </CardContent>
      </Card>

      <Alert v-if="error" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Alert v-if="liveFailed" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          实时拉取日报失败：{{ liveFailed }}。下面的「申报」列来自本地缓存，可能不是最新——
          日志系统支持补写，缓存里的内容未必是当前版本。
        </AlertDescription>
      </Alert>

      <Alert v-if="noReportData">
        <AlertDescription>
          {{ from }} ~ {{ to }} 这几天源系统没有返回任何日报，所以「申报」一列会全是空的——
          这不代表员工漏报。先确认「设置 → 日报系统」能连上、日期区间没填错。
        </AlertDescription>
      </Alert>

      <Alert v-if="failures.length" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          {{ failures.length }} 个仓库拉取失败，结果不完整：
          {{ failures.slice(0, 3).map(f => `${f.projectPath}（${f.message}）`).join('；') }}
        </AlertDescription>
      </Alert>

      <div v-if="rows.length" class="grid gap-3 sm:grid-cols-4">
        <Card class="py-3">
          <CardContent class="px-4">
            <div class="text-xs text-muted-foreground">提交</div>
            <div class="text-xl font-semibold tabular-nums">{{ totals.commits }}</div>
          </CardContent>
        </Card>
        <Card class="py-3">
          <CardContent class="px-4">
            <div class="text-xs text-muted-foreground">涉及人员</div>
            <div class="text-xl font-semibold tabular-nums">{{ totals.people }}</div>
          </CardContent>
        </Card>
        <Card class="py-3">
          <CardContent class="px-4">
            <div class="text-xs text-muted-foreground">有提交未申报</div>
            <div
              class="text-xl font-semibold tabular-nums"
              :class="totals.missingInReport ? 'text-amber-600 dark:text-amber-500' : undefined"
            >
              {{ totals.missingInReport }}
            </div>
          </CardContent>
        </Card>
        <Card class="py-3">
          <CardContent class="px-4">
            <div class="text-xs text-muted-foreground">已申报无提交</div>
            <div class="text-xl font-semibold tabular-nums">{{ totals.missingCommits }}</div>
          </CardContent>
        </Card>
      </div>

      <template v-if="rows.length">
        <div class="flex flex-wrap items-center gap-1.5">
          <Button
            v-for="tab in TABS"
            :key="tab.key"
            size="sm"
            :variant="viewMode === tab.key ? 'secondary' : 'ghost'"
            class="text-xs"
            @click="viewMode = tab.key"
          >
            {{ tab.label }}
          </Button>
          <Button
            size="sm"
            class="ml-auto text-xs"
            :disabled="activityStore.generatingReport"
            @click="generateReport"
          >
            <Loader2Icon v-if="activityStore.generatingReport" :size="12" class="mr-1.5 animate-spin" />
            <SparklesIcon v-else :size="12" class="mr-1.5" />
            {{ report ? '重新生成报告' : '生成报告' }}
          </Button>
        </div>

        <Card v-if="viewMode === 'rows'" class="gap-0 py-4">
        <CardContent class="px-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="w-24">日期</TableHead>
                <TableHead class="w-32">人员</TableHead>
                <TableHead class="w-20 text-right">提交</TableHead>
                <TableHead class="max-w-[30rem]">提交内容</TableHead>
                <TableHead class="w-24 text-right">申报工时</TableHead>
                <TableHead class="max-w-[24rem]">日报内容</TableHead>
                <TableHead class="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="row in rows"
                :key="`${row.date}|${row.memberKey}`"
                class="cursor-pointer"
                title="查看当天详情"
                @click="openDetail(row)"
              >
                <TableCell class="text-xs tabular-nums">{{ row.date }}</TableCell>
                <TableCell class="text-xs">
                  {{ row.memberName }}
                  <span v-if="row.memberKey.startsWith('author:')" class="ml-1 text-[10px] text-muted-foreground">
                    未匹配到人员
                  </span>
                </TableCell>
                <TableCell class="text-right text-xs tabular-nums">
                  <span v-if="row.commits.length">{{ row.commits.length }}</span>
                  <span v-else-if="row.missingCommits" class="text-amber-600 dark:text-amber-500">无提交</span>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
                <TableCell class="max-w-[30rem] text-xs">
                  <div v-if="row.commits.length" class="space-y-0.5">
                    <button
                      v-for="c in row.commits.slice(0, 2)"
                      :key="c.id"
                      type="button"
                      class="block w-full truncate text-left hover:underline"
                      :title="'点击查看改动内容'"
                      @click.stop="inspect(c)"
                    >
                      <span class="text-muted-foreground">{{ fmtTime(c.authoredDate) }}</span>
                      {{ c.title }}
                    </button>
                    <div v-if="row.commits.length > 2" class="text-muted-foreground">
                      另 {{ row.commits.length - 2 }} 条
                    </div>
                  </div>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
                <TableCell class="text-right text-xs tabular-nums">
                  <span v-if="row.reported">{{ row.hours }}h</span>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
                <TableCell class="max-w-[24rem] text-xs">
                  <div v-if="row.contents.length" class="space-y-0.5">
                    <div v-for="(c, i) in row.contents.slice(0, 2)" :key="i" class="truncate">
                      {{ c }}
                    </div>
                  </div>
                  <span v-else-if="row.missingInReport" class="text-amber-600 dark:text-amber-500">
                    有提交，日报没写
                  </span>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
                <TableCell class="text-muted-foreground">
                  <ChevronRightIcon :size="14" />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
        </Card>

        <Card v-else-if="viewMode === 'day'" class="gap-0 py-4">
          <CardContent class="px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-28">日期</TableHead>
                  <TableHead class="w-20 text-right">提交</TableHead>
                  <TableHead class="w-20 text-right">参与人</TableHead>
                  <TableHead class="w-32 text-right">代码量</TableHead>
                  <TableHead class="w-24 text-right">申报工时</TableHead>
                  <TableHead class="w-24 text-right">活跃时段</TableHead>
                  <TableHead class="w-28 text-right">有效工时</TableHead>
                  <TableHead class="w-32 text-right">有提交未申报</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="day in byDay" :key="day.date">
                  <TableCell class="text-xs tabular-nums">
                    {{ day.date }}
                    <Badge
                      v-if="!isWorkday(day.date)"
                      variant="outline"
                      class="ml-1 text-[10px]"
                      :title="dayInfo(day.date).name"
                    >
                      {{ dayInfo(day.date).source === 'weekend' ? '周末' : '休' }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-right text-xs tabular-nums">{{ day.commits }}</TableCell>
                  <TableCell class="text-right text-xs tabular-nums">{{ day.people }}</TableCell>
                  <TableCell class="text-right text-xs tabular-nums">
                    +{{ day.additions }} / -{{ day.deletions }}
                  </TableCell>
                  <TableCell class="text-right text-xs tabular-nums">
                    {{ day.hours ? `${day.hours}h` : '—' }}
                  </TableCell>
                  <TableCell class="text-right text-xs tabular-nums">
                    {{ day.activeBuckets || '—' }}
                  </TableCell>
                  <TableCell class="text-right text-xs tabular-nums">
                    <span>{{ day.effectiveHigh ? `${day.effectiveLow}–${day.effectiveHigh}h` : '—' }}</span>
                    <AlertTriangleIcon
                      v-if="day.batchSuspect"
                      :size="11"
                      class="ml-1 inline align-text-bottom text-amber-600 dark:text-amber-500"
                      title="提交集中在很短时间内，可能是一次补提交"
                    />
                  </TableCell>
                  <TableCell
                    class="text-right text-xs tabular-nums"
                    :class="day.missingPeople ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'"
                  >
                    {{ day.missingPeople ? `${day.missingPeople} 人` : '—' }}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <MetricLegend title="指标说明" :items="DAY_LEGEND" />
          </CardContent>
        </Card>

        <Card v-else-if="viewMode === 'person'" class="gap-0 py-4">
          <CardContent class="px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="max-w-[16rem]">人员</TableHead>
                  <TableHead class="w-16 text-right">提交</TableHead>
                  <TableHead class="w-20 text-right">活跃天数</TableHead>
                  <TableHead class="w-32 text-right">代码量</TableHead>
                  <TableHead class="w-24 text-right">申报工时</TableHead>
                  <TableHead class="w-28 text-right">未申报天数</TableHead>
                  <TableHead class="w-32">最近提交</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="person in byPerson" :key="person.key">
                  <TableCell class="max-w-[16rem] text-xs">
                    <span class="truncate">{{ person.name }}</span>
                    <span v-if="person.unmatched" class="ml-1 text-[10px] text-muted-foreground">
                      未匹配到人员
                    </span>
                  </TableCell>
                  <TableCell class="text-right text-xs tabular-nums">{{ person.commits }}</TableCell>
                  <TableCell class="text-right text-xs tabular-nums">{{ person.activeDays }}</TableCell>
                  <TableCell class="text-right text-xs tabular-nums">
                    +{{ person.additions }} / -{{ person.deletions }}
                  </TableCell>
                  <TableCell class="text-right text-xs tabular-nums">
                    {{ person.hours ? `${person.hours}h` : '—' }}
                  </TableCell>
                  <TableCell
                    class="text-right text-xs tabular-nums"
                    :class="person.missingDays ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'"
                  >
                    {{ person.missingDays ? `${person.missingDays} 天` : '—' }}
                  </TableCell>
                  <TableCell class="text-xs tabular-nums text-muted-foreground">
                    {{ person.lastCommit ? fmtTime(person.lastCommit) : '—' }}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <MetricLegend title="指标说明" :items="PERSON_LEGEND" />
          </CardContent>
        </Card>

        <Card v-else class="gap-0 py-4">
          <CardHeader class="px-4 pb-2">
            <CardTitle class="text-sm">分析报告</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4 px-4">
            <Alert v-if="activityStore.reportError" variant="destructive">
              <AlertTriangleIcon :size="14" />
              <AlertDescription>生成报告失败：{{ activityStore.reportError }}</AlertDescription>
            </Alert>

            <!-- 报告要点：先给结论数字，再看图，最后才是文字分析 -->
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div v-for="item in reportHighlights" :key="item.label" class="rounded-md border bg-muted/20 px-3 py-2">
                <div class="text-[11px] text-muted-foreground">{{ item.label }}</div>
                <div class="mt-0.5 text-sm font-semibold tabular-nums">{{ item.value }}</div>
                <div v-if="item.hint" class="mt-0.5 text-[10px] text-muted-foreground">{{ item.hint }}</div>
              </div>
            </div>

            <DailyCharts :days="reportDays" :workday-dates="workdayList" />

            <div class="space-y-2">
              <div class="flex items-baseline gap-3">
                <span class="text-xs font-medium">人员投入</span>
                <span class="text-[11px] text-muted-foreground">按提交量排序，申报工时为区间合计</span>
              </div>
              <PersonContribution :people="byPerson" />
            </div>

            <div v-if="report" class="space-y-2 border-t pt-3">
              <div class="flex items-center gap-1.5 text-xs font-medium">
                <SparklesIcon :size="13" class="text-muted-foreground" />
                分析
              </div>
              <StructuredReport :content="report" />
              <p v-if="reportAt" class="text-[11px] text-muted-foreground">
                生成于 {{ formatDateTime(reportAt) }}
              </p>
            </div>
            <div v-else class="border-t pt-3">
              <p class="text-xs leading-relaxed text-muted-foreground">
                还没有生成文字分析。上面的数字和图表来自提交与日报数据；点右上角「生成报告」，
                会再基于同一份数据写一段分析。
              </p>
            </div>
          </CardContent>
        </Card>
      </template>

      <Card v-else-if="!loading && scannedAt" class="py-10">
        <CardContent class="text-center text-sm text-muted-foreground">
          这段时间里，这个项目没有任何提交，也没有人在日报里提到它。
        </CardContent>
      </Card>
    </div>

    <CommitInspectorDialog v-model:open="commitOpen" :commit="inspectedCommit" />
  </div>
</template>
