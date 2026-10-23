<script setup lang="ts">
import type { DevMode, GitCommit, Project } from '@/core/domain/types'
import type { ActivityFailure } from '@/core/engine/activity'
import type { ShareEstimate } from '@/core/engine/estimate'
import type { MemberActivityRow as Row } from '@/core/store/memberActivity'
import { computed, onMounted, ref } from 'vue'
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlayIcon,
  SparklesIcon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import DatePicker from '@/components/common/DatePicker.vue'
import MemberPicker from '@/components/common/MemberPicker.vue'
import MetricLegend from '@/components/common/MetricLegend.vue'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import StructuredReport from '@/components/activity/StructuredReport.vue'
import DailyCharts from '@/components/activity/DailyCharts.vue'
import ShareComparison from '@/components/activity/ShareComparison.vue'
import CommitInspectorDialog from '@/components/inspection/CommitInspectorDialog.vue'
import { GitLabClient } from '@/core/adapters/gitlab'
import { buildIdentities, collectProjectCommits, commitOwner, SCAN_WARN_THRESHOLD } from '@/core/engine/activity'
import { estimateShares } from '@/core/engine/estimate'
import { projectMatches, toProjectRefs } from '@/core/engine/matching'
import { assignCommitDate, dateRange } from '@/core/engine/window'
import { dayMetrics } from '@/core/engine/metrics'
import { createLlmClient } from '@/core/llm/client'
import { useWorkCalendar } from '@/core/calendar/useWorkCalendar'
import { useMemberActivityStore } from '@/core/store/memberActivity'
import { useMemberStore } from '@/core/store/members'
import { useProjectStore } from '@/core/store/projects'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'
import { dateKeyOffset, formatDateCN, formatDateTime } from '@/lib/format'

/**
 * 人员活动：某个人在一段时间里，在各项目上的产出与申报构成。
 *
 * 两个分析维度，回答的是不同的问题：
 * - **按天**：开发节奏——哪天有产出、哪天断了、申报覆盖到哪；
 * - **按项目**：投入结构——时间落在哪些项目上，和日报申报的分布差多少。
 *
 * 估算那一列是在「看不到日报」的前提下算的（见 engine/estimate.ts），
 * 否则它只会照着申报的数字复述，对照就没意义了。
 */

const TABS = [
  { key: 'day', label: '按天' },
  { key: 'project', label: '按项目' },
  { key: 'report', label: '分析报告' },
] as const

type ViewMode = typeof TABS[number]['key']

/** 指标口径，显示在对应表格底部 */
const DAY_LEGEND = [
  { label: '日期', desc: '提交按「前一天 20:00 ~ 次日 08:00」的窗口归属，与执行检查一致' },
  { label: '项目数', desc: '当天有提交的项目个数，同一项目的多个仓库合并算一个' },
  { label: '提交', desc: '当天本人名下所有项目的提交条数，按配置的多个 Git 身份归集' },
  { label: '代码量', desc: '当天累计 +新增 / -删除行数，来自 GitLab 提交统计' },
  { label: '活跃时段', desc: '有提交的 30 分钟时段数，反映当天敲代码的密度' },
  { label: '有效工时', desc: '按提交会话估算的区间，代码量按项目开发模式修正；仅代码产出，不含会议/评审' },
  { label: '申报工时', desc: '当天日报申报的总工时，所有项目合计' },
]

const PROJECT_LEGEND = [
  { label: '项目', desc: '日报项目按配置的名称/编码/别名匹配到的项目实体' },
  { label: '提交 / 活跃', desc: '区间内该项目下本人的提交条数，以及有提交的天数' },
  { label: '代码量', desc: '区间内累计 +新增 / -删除行数' },
  { label: '申报工时', desc: '区间内该项目在日报里的工时合计' },
  { label: '申报占比', desc: '该项目工时 ÷ 区间内申报总工时' },
  { label: '估算占比', desc: '模型只看提交（不看日报）给出的占比，只在有提交的项目之间归一化' },
  { label: '偏离', desc: '申报占比 − 估算占比；绝对值 ≥ 15% 时标色，正为申报高于估算' },
  { label: '估算依据 / 提交', desc: '模型给出该占比的理由；点行展开可看日报原文与区间内全部提交' },
]

const memberStore = useMemberStore()
const projectStore = useProjectStore()
const reportStore = useReportStore()
const settingsStore = useSettingsStore()
const activityStore = useMemberActivityStore()

const memberId = ref('')
const from = ref(dateKeyOffset(-7))
const to = ref(dateKeyOffset(-1))

const loading = ref(false)
const progress = ref('')
const error = ref<string | null>(null)
const failures = ref<ActivityFailure[]>([])
const rows = ref<Row[]>([])
const estimate = ref<ShareEstimate | null>(null)
const analyzedAt = ref<string | null>(null)
/** 实时拉日报失败时置位：此时「申报」两列来自本地缓存，可能已经过期 */
const liveFailed = ref<string | null>(null)

const viewMode = ref<ViewMode>('day')

/** 点开的提交。diff 逐条拉一次请求，所以不在扫描阶段预先取 */
const inspectedCommit = ref<GitCommit | null>(null)
const commitOpen = ref(false)

function inspect(commit: GitCommit) {
  inspectedCommit.value = commit
  commitOpen.value = true
}

/**
 * 展开的行：估算依据是一整段话、提交可能有几十条，一行里塞不下。
 * 折起来只留摘要，展开看全文。
 */
const expanded = ref<Set<string>>(new Set())

function toggleExpand(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  expanded.value = next
}

const members = computed(() =>
  memberStore.items
    .filter(m => m.enabled)
    .sort((a, b) => Number(b.followed) - Number(a.followed) || a.name.localeCompare(b.name, 'zh-Hans-CN')),
)

const selected = computed(() => members.value.find(m => m.id === memberId.value) ?? null)

/** 扫描范围 = 关注且启用的项目，和检查的范围一致 */
const targets = computed(() => projectStore.items.filter(p => p.enabled && p.followed))

/** 扫描是逐仓库串行的，项目一多就慢到没法用；先提醒，再看数量硬拦 */
const tooManyTargets = computed(() => targets.value.length > 120)
const manyTargets = computed(() => targets.value.length > SCAN_WARN_THRESHOLD)

const rangeDays = computed(() => dateRange(from.value, to.value))

/* 工作日历：节假日不计入缺报和活跃天数分母 */
const { isWorkday, dayInfo } = useWorkCalendar()
const workdayList = computed(() => rangeDays.value.filter(d => isWorkday(d)))

const totalReported = computed(() => rows.value.reduce((s, r) => s + r.reportedHours, 0))
const totalCommits = computed(() => rows.value.reduce((s, r) => s + r.commits.length, 0))

function volumeOf(commits: GitCommit[]) {
  let additions = 0
  let deletions = 0
  for (const commit of commits) {
    additions += commit.stats?.additions ?? 0
    deletions += commit.stats?.deletions ?? 0
  }
  return { additions, deletions }
}

onMounted(async () => {
  await Promise.all([memberStore.load(), projectStore.load(), reportStore.load()])

  // 回到页面时恢复上次分析，避免重跑一次扫描 + 模型估算
  const snap = activityStore.snapshot
  if (snap) {
    memberId.value = snap.memberId
    from.value = snap.from
    to.value = snap.to
    rows.value = snap.rows
    failures.value = snap.failures
    estimate.value = snap.estimate
    analyzedAt.value = snap.analyzedAt
    liveFailed.value = snap.liveFailed
    return
  }

  if (!memberId.value) {
    const first = members.value.find(m => m.followed) ?? members.value[0]
    if (first)
      memberId.value = first.id
  }
})

async function analyze() {
  const member = selected.value
  if (!member) {
    error.value = '先选一个人'
    return
  }
  if (!member.gitlabUsernames?.length && !member.emails.length) {
    error.value = `「${member.name}」还没配置任何 Git 身份，无法认出哪些提交是他的。到「人员」面板补上用户名或邮箱。`
    return
  }
  if (!rangeDays.value.length) {
    error.value = '日期范围不合法：起始日期不能晚于结束日期'
    return
  }
  if (rangeDays.value.length > 62) {
    error.value = '范围最多 62 天。范围再大，逐个仓库扫过去会慢到没法用'
    return
  }
  if (tooManyTargets.value) {
    error.value = `当前关注了 ${targets.value.length} 个项目，逐个扫描会非常慢。先到「项目」面板缩小关注范围，或取消关注暂时不看的项目。`
    return
  }

  loading.value = true
  error.value = null
  failures.value = []
  rows.value = []
  estimate.value = null
  liveFailed.value = null
  progress.value = '正在读取日报…'

  try {
    await reportStore.load()
    // 日报会补写：这段区间直接问源系统要最新版本，缓存只作兜底
    progress.value = '正在拉取最新日报…'
    const live = await reportStore.refreshRange(from.value, to.value)
    liveFailed.value = live.ok ? null : (live.error ?? '未知原因')

    const settings = settingsStore.settings
    const refs = targets.value.flatMap(p => toProjectRefs(p))

    progress.value = '正在扫描仓库…'
    const { batches, failures: failed } = await collectProjectCommits(refs, from.value, to.value, {
      gitlab: new GitLabClient(settings.gitlab),
      rules: settings.rules,
      perPage: settings.gitlab.perPage,
      maxCommitsPerProject: settings.rules.maxCommitsPerProject,
      // 不传 author：一个人可能有多个 Git 身份，author 只能给一个值，
      // 传了就会漏掉其它身份提交的代码。归属在下面按身份列表筛。
      onProgress: p => (progress.value = p.message),
    })
    failures.value = failed

    const identities = buildIdentities(memberStore.items)
    const ownBatches = batches
      .map(b => ({ ...b, commits: b.commits.filter(c => commitOwner(c, identities)?.id === member.id) }))
      .filter(b => b.commits.length)

    rows.value = buildRows(ownBatches, member.reportMemberId || member.id, rangeDays.value)

    progress.value = '正在估算工时占比…'
    /*
     * 估算失败不把整次分析判死：提交和申报两列已经算好了，它们才是事实。
     */
    try {
      // 用项目实体的名称喂给模型：估算结果按这个名字返回，页面也按它匹配
      const byRepoId = projectByRepoId()
      estimate.value = await estimateShares(
        member.name,
        `${from.value} ~ ${to.value}`,
        ownBatches.map(b => ({
          projectName: byRepoId.get(b.projectId)?.name ?? b.projectName,
          projectPath: b.projectPath,
          commits: b.commits,
        })),
        createLlmClient(settings.llm),
      )
    }
    catch (err) {
      estimate.value = {
        shares: [],
        confidence: 0,
        insufficient: false,
        sampleSize: ownBatches.reduce((s, b) => s + b.commits.length, 0),
        note: `模型调用失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }

    analyzedAt.value = new Date().toLocaleTimeString()

    const previous = activityStore.take(memberId.value, from.value, to.value)
    activityStore.save({
      memberId: memberId.value,
      from: from.value,
      to: to.value,
      rows: rows.value,
      failures: failures.value,
      estimate: estimate.value,
      analyzedAt: analyzedAt.value ?? '',
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

function buildRows(
  batches: Array<{ projectId: number, projectPath: string, projectName: string, commits: GitCommit[] }>,
  reportMemberId: string,
  range: string[],
): Row[] {
  const rules = settingsStore.settings.rules
  const map = new Map<string, Row>()
  const byRepoId = projectByRepoId()

  const ensure = (date: string, key: string, projectName: string, projectPath: string): Row => {
    const rowKey = `${date}|${key}`
    let row = map.get(rowKey)
    if (!row) {
      row = {
        date,
        projectKey: key,
        projectName,
        projectPath,
        commits: [],
        reportedHours: 0,
        reportedContents: [],
      }
      map.set(rowKey, row)
    }
    return row
  }

  for (const batch of batches) {
    const entity = byRepoId.get(batch.projectId)
    const key = entity ? entity.id : `path:${batch.projectPath}`
    for (const commit of batch.commits) {
      const date = assignCommitDate(commit.authoredDate, range, rules)
      if (!date)
        continue
      ensure(date, key, entity?.name ?? batch.projectName, batch.projectPath).commits.push(commit)
    }
  }

  for (const date of range) {
    const report = (reportStore.cache[date] ?? [])
      .find(r => r.memberId === reportMemberId || r.memberId === selected.value?.reportMemberId)
    if (!report)
      continue
    for (const entry of report.entries) {
      const entity = findProjectFor(entry)
      const key = entity ? entity.id : `entry:${entry.projectName}`
      const row = ensure(date, key, entity?.name ?? entry.projectName, entity?.pathWithNamespace ?? '')
      row.reportedHours += entry.hours
      if (entry.content)
        row.reportedContents.push(entry.content)
    }
  }

  return [...map.values()].sort((a, b) =>
    b.date.localeCompare(a.date) || a.projectName.localeCompare(b.projectName, 'zh-Hans-CN'),
  )
}

function findProjectFor(entry: { projectName: string, projectCode?: string }): Project | undefined {
  return projectStore.items.find(p => p.enabled && projectMatches(p, entry))
}

/**
 * 仓库 id → 项目实体。
 *
 * 估算结果按项目名返回，而页面上显示的是项目实体的名称；不先做这层映射，
 * 仓库名（如 phoenix-project）和项目名（如「甘肃省气象局…」）对不上，
 * 估算占比就会全部显示成「数据不足」。
 */
function projectByRepoId(): Map<number, Project> {
  const map = new Map<number, Project>()
  for (const p of projectStore.items) {
    if (p.gitlabProjectId != null)
      map.set(p.gitlabProjectId, p)
    for (const repo of p.repos ?? [])
      map.set(repo.id, p)
  }
  return map
}

const DEV_MODE_LABEL: Record<DevMode, string> = {
  manual: '人工开发',
  'ai-assisted': 'AI 辅助',
  'ai-driven': 'AI 开发为主',
}

/** 行里的 projectKey 可能是项目 id，也可能是 `path:` / `entry:` 兜底键 */
function devModeOfProject(projectKey: string): DevMode {
  return projectStore.items.find(p => p.id === projectKey)?.devMode ?? 'manual'
}

/* ------------------------------------------------------------------ *
 * 两个维度
 * ------------------------------------------------------------------ */

interface DayStat {
  date: string
  projects: number
  commits: number
  additions: number
  deletions: number
  hours: number
  activeBuckets: number
  effectiveLow: number
  effectiveHigh: number
  batchSuspect: boolean
}

const byDay = computed<DayStat[]>(() => {
  const byDate = new Map<string, Row[]>()
  for (const row of rows.value) {
    const list = byDate.get(row.date) ?? []
    list.push(row)
    byDate.set(row.date, list)
  }

  return [...byDate.entries()]
    .map(([date, list]) => {
      let commits = 0
      let additions = 0
      let deletions = 0
      let activeBuckets = 0
      let effectiveLow = 0
      let effectiveHigh = 0
      let batchSuspect = false
      let hours = 0
      const projects = new Set<string>()

      for (const row of list) {
        // 不同项目可能标注了不同的开发模式，按项目分别估算再相加
        const metrics = dayMetrics(row.commits, { devMode: devModeOfProject(row.projectKey) })
        commits += metrics.commits
        additions += metrics.additions
        deletions += metrics.deletions
        activeBuckets += metrics.activeBuckets
        effectiveLow += metrics.effectiveLow
        effectiveHigh += metrics.effectiveHigh
        batchSuspect ||= metrics.batchSuspect
        hours += row.reportedHours
        if (metrics.commits)
          projects.add(row.projectKey)
      }

      return {
        date,
        projects: projects.size,
        commits,
        additions,
        deletions,
        hours,
        activeBuckets,
        effectiveLow: Math.round(effectiveLow * 10) / 10,
        effectiveHigh: Math.round(effectiveHigh * 10) / 10,
        batchSuspect,
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date))
})

interface ProjectStat {
  key: string
  name: string
  path: string
  commits: GitCommit[]
  activeDays: number
  additions: number
  deletions: number
  reportedHours: number
  reportedContents: string[]
  reportedShare: number | null
  estimatedShare: number | null
  estimateReason: string
}

const byProject = computed<ProjectStat[]>(() => {
  const map = new Map<string, { stat: ProjectStat, days: Set<string> }>()
  for (const row of rows.value) {
    const hit = map.get(row.projectKey) ?? {
      stat: {
        key: row.projectKey,
        name: row.projectName,
        path: row.projectPath,
        commits: [],
        activeDays: 0,
        additions: 0,
        deletions: 0,
        reportedHours: 0,
        reportedContents: [],
        reportedShare: null,
        estimatedShare: null,
        estimateReason: '',
      },
      days: new Set<string>(),
    }
    hit.stat.commits.push(...row.commits)
    if (row.commits.length)
      hit.days.add(row.date)
    hit.stat.reportedHours += row.reportedHours
    hit.stat.reportedContents.push(...row.reportedContents)
    map.set(row.projectKey, hit)
  }

  const list = [...map.values()].map(({ stat, days }) => {
    const volume = volumeOf(stat.commits)
    return { ...stat, activeDays: days.size, additions: volume.additions, deletions: volume.deletions }
  })

  const reportedTotal = list.reduce((sum, s) => sum + s.reportedHours, 0)
  for (const stat of list) {
    stat.reportedShare = reportedTotal > 0 ? stat.reportedHours / reportedTotal : null
    const share = estimate.value?.shares.find(s => s.projectName === stat.name)
    if (share) {
      stat.estimatedShare = share.share
      stat.estimateReason = share.reason
    }
  }

  return list.sort((a, b) => (b.reportedHours + b.commits.length) - (a.reportedHours + a.commits.length))
})

function pct(value: number | null) {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

function deviation(stat: ProjectStat) {
  if (stat.reportedShare === null || stat.estimatedShare === null)
    return null
  return stat.reportedShare - stat.estimatedShare
}

function deviationClass(stat: ProjectStat) {
  const d = deviation(stat)
  if (d === null || Math.abs(d) < 0.15)
    return 'text-muted-foreground'
  return d > 0 ? 'text-amber-600 dark:text-amber-500' : 'text-sky-600 dark:text-sky-500'
}

function fmtTime(iso: string) {
  return formatDateTime(iso)
}

/* ------------------------------------------------------------------ *
 * 报告页的图表数据
 * ------------------------------------------------------------------ */

/** ShareComparison 只关心每个项目的提交条数和两种占比 */
const shareRows = computed(() =>
  byProject.value.map(p => ({
    key: p.key,
    name: p.name,
    commits: p.commits.length,
    reportedShare: p.reportedShare,
    estimatedShare: p.estimatedShare,
  })),
)

/**
 * 报告页的日序列：补齐区间里没有记录的天，空档本身就是结论的一部分。
 */
const reportDays = computed(() => {  const map = new Map(byDay.value.map(d => [d.date, d]))
  return rangeDays.value.map((date) => {
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
  const empty = workdayList.value.filter((d) => {
    const point = dayMap.get(d)
    return !point || (point.commits === 0 && !point.hasReport)
  }).length

  const dev = byProject.value
    .filter((p): p is ProjectStat & { reportedShare: number, estimatedShare: number } =>
      p.reportedShare !== null && p.estimatedShare !== null,
    )
    .map(p => ({ name: p.name, diff: Math.round((p.reportedShare - p.estimatedShare) * 100) }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0]

  return [
    {
      label: '峰值日',
      value: peak ? `${formatDateCN(peak.date)} · ${peak.commits} 条` : '—',
      hint: '提交条数最多的一天',
    },
    {
      label: '活跃工作日',
      value: `${active.length} / ${workdayList.value.length} 天`,
      hint: '有提交的工作日，节假日不计入分母',
    },
    {
      label: '无记录工作日',
      value: `${empty} 天`,
      hint: '工作日里既没有提交，日报也没有记录',
    },
    {
      label: '申报与估算差异最大',
      value: dev ? `${dev.name} ${dev.diff > 0 ? '+' : ''}${dev.diff}` : '—',
      hint: dev ? '单位：百分点，正数表示申报占比更高' : '没有可对比的项目',
    },
  ]
})

/* ------------------------------------------------------------------ *
 * 分析报告
 * ------------------------------------------------------------------ */

const REPORT_SYSTEM = `你是研发效能分析师。根据一个人在给定时间段内的提交记录与日报申报，写一份结构化的分析报告。
硬性要求：
1. 所有数字必须来自给定数据；数据不足写「数据不足」，不得猜测；
2. 不评价个人绩效，只陈述事实和可跟进的点；
3. 报告必须包含表格和图表（图表用 chart 代码块输出 JSON 规格），数字优先放进表格，不要用大段文字复述；
4. 每个文字段落不超过三句话；
5. 图表一律使用 chart 代码块，不要使用 mermaid；
6. 只输出 markdown 正文：不要一级标题，不要开场白，不要套话总结；
7. 日期一律写成完整中文日期（例如「2026年10月21日」），不要写成「10-21」「10月21日」或 ISO 日期。`

const report = computed(() => activityStore.snapshot?.report ?? '')
const reportAt = computed(() => activityStore.snapshot?.reportAt ?? null)

function buildReportPrompt(): string {
  const member = selected.value
  const dayLines = byDay.value.map(d =>
    `${formatDateCN(d.date)}：提交 ${d.commits} 条，${d.projects} 个项目，+${d.additions}/-${d.deletions}，`
    + `活跃时段 ${d.activeBuckets} 个，有效工时 ${d.effectiveLow}-${d.effectiveHigh}h（仅代码产出），申报 ${d.hours}h`,
  )
  const projectLines = byProject.value.map(p =>
    `${p.name}（${DEV_MODE_LABEL[devModeOfProject(p.key)]}）：提交 ${p.commits.length} 条，活跃 ${p.activeDays} 天，`
    + `+${p.additions}/-${p.deletions}，申报 ${p.reportedHours}h（占比 ${pct(p.reportedShare)}），`
    + `估算占比 ${pct(p.estimatedShare)}`,
  )
  /*
   * 日报正文必须带上：只给工时，模型只能写「未提供工作内容」，
   * 而用户明明写了「整理需求文档、梳理架构设计」。
   */
  const declared = rows.value
    .filter(r => r.reportedHours || r.reportedContents.length)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 80)
    .map(r => `${formatDateCN(r.date)} ${r.projectName}：${r.reportedHours}h — ${r.reportedContents.join('；') || '（未填写内容）'}`)

  const recent = rows.value
    .flatMap(r => r.commits.map(c => `${formatDateCN(r.date)} ${c.title}`))
    .sort()
    .reverse()
    .slice(0, 25)

  /*
   * 图表要按完整日序列画，包括没有记录的天；只给有数据的日子，
   * 模型画出来的 x 轴会缺天，趋势就断了。
   */
  const chartDays = reportDays.value.map(d =>
    `${formatDateCN(d.date)}：提交 ${d.commits} 条，申报 ${d.reportedHours}h，代码估算 ${d.effectiveLow}-${d.effectiveHigh}h`,
  )

  return `人员：${member?.name ?? ''}\n`
    + `区间：${formatDateCN(from.value)} ~ ${formatDateCN(to.value)}（${rangeDays.value.length} 个自然日，其中工作日 ${workdayList.value.length} 天）\n`
    + `提交 ${totalCommits.value} 条，申报 ${totalReported.value}h，涉及 ${byProject.value.length} 个项目。\n`
    + `口径：有效工时按提交会话估算，代码量按各项目开发模式修正；只统计代码产出，`
    + `不含会议、评审、答疑；工作饱和度 = 有效工时中值 / 8h。\n\n`
    + `按天：\n${dayLines.join('\n') || '（无）'}\n\n`
    + `按项目：\n${projectLines.join('\n') || '（无）'}\n\n`
    + `日报申报内容：\n${declared.join('\n') || '（无）'}\n\n`
    + `最近的提交标题：\n${recent.join('\n') || '（无）'}\n\n`
    + `每日序列（含无记录的天）：\n${chartDays.join('\n') || '（无）'}\n\n`
    + `判断「有申报无提交」的日子时，以「日报申报内容」为准：里面写了需求文档、架构设计、评审、`
    + `会议、答疑这类工作，就属于非编码工作，不要笼统写成「未提供工作内容」。\n`
    + `周末和法定节假日没有提交、没有日报是正常的，不要写成漏报或缺勤；活跃天数、无记录天数都只按工作日计算。\n\n`
    + `请严格按以下结构输出，不要增删章节，也不要用文字重复表格里已有的数字：\n\n`
    + `## 总览\n`
    + `一张三列表格：| 指标 | 数值 | 说明 |，至少包含提交条数、申报工时、代码估算有效工时、活跃工作日、无记录工作日。\n\n`
    + `## 每日趋势\n`
    + `用上面的「每日序列」原样输出两个图表，每个图表放在一个 chart 代码块里，内容是合法 JSON，数字不得改动：\n`
    + `1) 每日提交条数（柱状）；2) 每日申报工时（柱状）与代码估算（折线）。\n`
    + '第一个图的格式：\n```chart\n{"title":"每日提交","unit":"条","labels":["2026年10月12日","2026年10月13日"],"series":[{"name":"提交","type":"bar","data":[8,6]}]}\n```\n'
    + `labels 一律写成「2026年10月21日」这种完整中文日期，不要用「10-21」「10月21日」。\n`
    + `第二个图在同一份 series 里放两项：{"name":"申报工时","type":"bar","data":[...]} 和 {"name":"代码估算","type":"line","data":[...]}。\n`
    + `labels 必须覆盖区间内每一天，没提交的天写 0；JSON 里不要写注释，也不要包进 markdown 表格。\n\n`
    + `## 项目投入\n`
    + `一张表格：| 项目 | 提交 | 申报占比 | 估算占比 | 偏离 |。没有估算写「—」，偏离用百分点。\n`
    + `表格之后，再输出一个 donut 图表展示各项目的申报工时占比：\n`
    + '```chart\n{"type":"donut","title":"项目投入占比","unit":"h","labels":["项目A","项目B"],"series":[{"name":"申报工时","data":[51,6]}]}\n```\n'
    + `数据用各项目的申报工时，labels 与表格里的项目一一对应。\n\n`
    + `## 与日报的对照\n`
    + `一张表格：| 日期 | 项目 | 问题 | 依据 |，只列异常（有提交未申报 / 已申报无提交 / 无记录）。\n\n`
    + `## 建议\n不超过 3 条列表，每条一句话。`
}

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
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <Card class="gap-0 py-4">
        <CardContent class="space-y-3 px-4">
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="space-y-1.5">
              <Label class="text-xs">人员</Label>
              <MemberPicker
                v-model="memberId"
                :members="members"
                placeholder="搜索并选择人员"
              />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">起始日期</Label>
              <DatePicker v-model="from" class="h-8" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">结束日期</Label>
              <DatePicker v-model="to" class="h-8" />
            </div>
            <div class="flex items-end justify-end">
              <Button :disabled="loading || !selected" @click="analyze">
                <Loader2Icon v-if="loading" :size="13" class="mr-1.5 animate-spin" />
                <PlayIcon v-else :size="13" class="mr-1.5" />
                分析这段时间
              </Button>
            </div>
          </div>

          <div v-if="progress || analyzedAt" class="flex flex-wrap items-center gap-2">
            <span v-if="progress" class="text-xs text-muted-foreground">{{ progress }}</span>
            <span v-else-if="analyzedAt" class="text-xs text-muted-foreground">{{ analyzedAt }} 分析</span>
          </div>

          <p v-if="manyTargets && !tooManyTargets" class="text-[11px] text-amber-600 dark:text-amber-500">
            当前关注了 {{ targets.length }} 个项目，会逐个扫描，可能要等一会儿。
          </p>

          <details class="text-[11px] text-muted-foreground">
            <summary class="cursor-pointer select-none">
              估算口径说明
            </summary>
            <p class="mt-1 max-w-prose leading-relaxed">
              只扫描「关注且启用」的项目——未关注的项目不参与检查，这里也不看。
              「估算占比」是把提交单独交给模型估的，<strong>故意不把日报内容告诉它</strong>，
              这样估算才是对申报的独立参照；申报数据本身照常读取（见「申报工时」列和报告）。
              估算只覆盖有提交的项目，报了但没提交的项目不会出现在估算里。
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
          实时拉取日报失败：{{ liveFailed }}。「申报」两列来自本地缓存，可能不是最新。
        </AlertDescription>
      </Alert>

      <Alert v-if="failures.length" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          {{ failures.length }} 个仓库拉取失败，结果不完整：
          {{ failures.slice(0, 3).map(f => `${f.projectPath}（${f.message}）`).join('；') }}
        </AlertDescription>
      </Alert>

      <Alert v-if="estimate?.insufficient">
        <AlertDescription>
          这段时间只有 {{ estimate.sampleSize }} 条提交，样本不足，不给工时占比估算——
          三条提交以下任何占比都是噪声。
        </AlertDescription>
      </Alert>

      <Alert v-else-if="estimate && !estimate.shares.length && estimate.note">
        <AlertDescription>{{ estimate.note }}</AlertDescription>
      </Alert>

      <template v-if="rows.length">
        <div class="flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
          <span>提交 {{ totalCommits }} 条</span>
          <span>申报工时 {{ totalReported }}h</span>
          <span>{{ byProject.length }} 个项目 · {{ byDay.length }} 个活跃日</span>
          <span v-if="estimate && estimate.shares.length" class="inline-flex items-center gap-1">
            <SparklesIcon :size="11" />
            估算置信度 {{ Math.round(estimate.confidence * 100) }}%
          </span>
        </div>

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

        <Card v-if="viewMode === 'day'" class="gap-0 py-4">
          <CardContent class="px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-28">日期</TableHead>
                  <TableHead class="w-20 text-right">项目数</TableHead>
                  <TableHead class="w-20 text-right">提交</TableHead>
                  <TableHead class="w-32 text-right">代码量</TableHead>
                  <TableHead class="w-24 text-right">活跃时段</TableHead>
                  <TableHead class="w-28 text-right">有效工时</TableHead>
                  <TableHead class="w-24 text-right">申报工时</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="day in byDay" :key="day.date">
                  <TableCell class="text-xs tabular-nums">
                    {{ formatDateCN(day.date) }}
                    <Badge
                      v-if="!isWorkday(day.date)"
                      variant="outline"
                      class="ml-1 text-[10px]"
                      :title="dayInfo(day.date).name"
                    >
                      {{ dayInfo(day.date).source === 'weekend' ? '周末' : '休' }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-right text-xs tabular-nums">{{ day.projects }}</TableCell>
                  <TableCell class="text-right text-xs tabular-nums">{{ day.commits }}</TableCell>
                  <TableCell class="text-right text-xs tabular-nums">
                    +{{ day.additions }} / -{{ day.deletions }}
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
                  <TableCell class="text-right text-xs tabular-nums">
                    {{ day.hours ? `${day.hours}h` : '—' }}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <MetricLegend title="指标说明" :items="DAY_LEGEND" />
          </CardContent>
        </Card>

        <Card v-else-if="viewMode === 'project'" class="gap-0 py-4">
          <CardContent class="px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-full max-w-0">项目</TableHead>
                  <TableHead class="w-14 text-right">提交</TableHead>
                  <TableHead class="w-24 text-right">代码量</TableHead>
                  <TableHead class="w-20 text-right">申报工时</TableHead>
                  <TableHead class="w-20 text-right">申报占比</TableHead>
                  <TableHead class="w-20 text-right">估算占比</TableHead>
                  <TableHead class="w-16 text-right">偏离</TableHead>
                  <TableHead class="max-w-[22rem]">估算依据 / 提交</TableHead>
                  <TableHead class="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="stat in byProject" :key="stat.key">
                  <TableRow
                    class="cursor-pointer"
                    :title="expanded.has(stat.key) ? '收起' : '展开提交与估算依据'"
                    @click="toggleExpand(stat.key)"
                  >
                    <TableCell class="max-w-0">
                      <div class="truncate font-medium" :title="stat.name">{{ stat.name }}</div>
                      <div v-if="stat.path" class="truncate text-[10px] text-muted-foreground" :title="stat.path">
                        {{ stat.path }} · 活跃 {{ stat.activeDays }} 天
                      </div>
                    </TableCell>
                    <TableCell class="text-right text-xs tabular-nums">{{ stat.commits.length || '—' }}</TableCell>
                    <TableCell class="text-right text-xs tabular-nums">
                      +{{ stat.additions }} / -{{ stat.deletions }}
                    </TableCell>
                    <TableCell class="text-right text-xs tabular-nums">
                      {{ stat.reportedHours ? `${stat.reportedHours}h` : '—' }}
                    </TableCell>
                    <TableCell class="text-right text-xs tabular-nums">{{ pct(stat.reportedShare) }}</TableCell>
                    <TableCell class="text-right text-xs tabular-nums">{{ pct(stat.estimatedShare) }}</TableCell>
                    <TableCell class="text-right text-xs tabular-nums" :class="deviationClass(stat)">
                      <template v-if="deviation(stat) !== null">
                        {{ deviation(stat)! > 0 ? '+' : '' }}{{ Math.round(deviation(stat)! * 100) }}%
                      </template>
                      <span v-else class="text-muted-foreground">—</span>
                    </TableCell>
                    <TableCell class="max-w-[22rem]">
                      <div v-if="stat.estimateReason" class="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                        {{ stat.estimateReason }}
                      </div>
                      <div v-if="stat.commits.length" class="mt-0.5 space-y-0.5">
                        <button
                          v-for="c in stat.commits.slice(0, 1)"
                          :key="c.id"
                          type="button"
                          class="block w-full truncate text-left text-xs hover:underline"
                          title="点击查看改动内容"
                          @click.stop="inspect(c)"
                        >
                          <span class="text-muted-foreground">{{ fmtTime(c.authoredDate) }}</span>
                          {{ c.title }}
                        </button>
                        <div v-if="stat.commits.length > 1" class="text-[11px] text-muted-foreground">
                          另 {{ stat.commits.length - 1 }} 条，点开看全部
                        </div>
                      </div>
                      <span v-else-if="stat.reportedHours" class="text-[11px] text-amber-600 dark:text-amber-500">
                        报了工时，但区间内没有提交
                      </span>
                    </TableCell>
                    <TableCell class="text-muted-foreground">
                      <ChevronDownIcon v-if="expanded.has(stat.key)" :size="14" />
                      <ChevronRightIcon v-else :size="14" />
                    </TableCell>
                  </TableRow>

                  <TableRow v-if="expanded.has(stat.key)" class="hover:bg-transparent">
                    <TableCell :colspan="9" class="bg-muted/20 px-4 py-3 whitespace-normal">
                      <div class="space-y-3">
                        <div v-if="stat.estimateReason">
                          <div class="text-[11px] font-medium">估算依据</div>
                          <p class="mt-1 text-xs leading-relaxed break-words text-muted-foreground">
                            {{ stat.estimateReason }}
                          </p>
                        </div>

                        <div v-if="stat.reportedContents.length">
                          <div class="text-[11px] font-medium">日报内容</div>
                          <ul class="mt-1 space-y-1">
                            <li
                              v-for="(text, i) in stat.reportedContents"
                              :key="i"
                              class="text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
                            >
                              {{ text }}
                            </li>
                          </ul>
                        </div>

                        <div v-if="stat.commits.length">
                          <div class="text-[11px] font-medium">区间内提交 {{ stat.commits.length }} 条</div>
                          <ul class="mt-1 max-h-72 divide-y overflow-auto rounded-md border bg-background">
                            <li v-for="c in [...stat.commits].sort((a, b) => b.authoredDate.localeCompare(a.authoredDate))" :key="c.id">
                              <button
                                type="button"
                                class="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/40"
                                title="点击查看改动内容"
                                @click.stop="inspect(c)"
                              >
                                <span class="shrink-0 tabular-nums text-muted-foreground">{{ fmtTime(c.authoredDate) }}</span>
                                <span class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ c.shortId }}</span>
                                <span class="truncate">{{ c.title }}</span>
                                <span
                                  v-if="c.stats"
                                  class="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground"
                                >
                                  +{{ c.stats.additions }}/-{{ c.stats.deletions }}
                                </span>
                              </button>
                            </li>
                          </ul>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
            </Table>
            <MetricLegend title="指标说明" :items="PROJECT_LEGEND" />
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
                <span class="text-xs font-medium">项目投入对比</span>
                <span class="text-[11px] text-muted-foreground">申报占比 vs 代码估算占比</span>
              </div>
              <ShareComparison :rows="shareRows" />
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

      <Card v-else-if="!loading && analyzedAt" class="py-10">
        <CardContent class="text-center text-sm text-muted-foreground">
          这段时间里，这个人既没有提交，也没有在日报里提到相关项目。
        </CardContent>
      </Card>
    </div>

    <CommitInspectorDialog v-model:open="commitOpen" :commit="inspectedCommit" />
  </div>
</template>
