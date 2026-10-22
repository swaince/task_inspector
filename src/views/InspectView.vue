<script setup lang="ts">
import type { InspectionResult, MemberProfile, VerdictLevel } from '@/core/domain/types'
import { computed, ref } from 'vue'
import {
  ArrowRightIcon,
  CircleStopIcon,
  CloudDownloadIcon,
  InfoIcon,
  PlayIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UsersIcon,
} from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import InspectionReport from '@/components/inspection/InspectionReport.vue'
import LiveRunPanel from '@/components/inspection/LiveRunPanel.vue'
import VerdictBadge from '@/components/common/VerdictBadge.vue'
import DatePicker from '@/components/common/DatePicker.vue'
import { useRunnerStore } from '@/core/store/runner'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'
import { useMemberStore } from '@/core/store/members'
import { dateRange } from '@/core/engine/window'
import { useWorkCalendar } from '@/core/calendar/useWorkCalendar'
import { followUpVerdicts, scoreTone } from '@/core/domain/verdict'
import { dateKeyOffset } from '@/lib/format'

const settingsStore = useSettingsStore()
const reportStore = useReportStore()
const runner = useRunnerStore()
const memberStore = useMemberStore()

/* 默认最近 7 天（截止昨天）：日报当天晚上才上报，含今天会拉不到完整数据 */
const from = ref(dateKeyOffset(-7))
const to = ref(dateKeyOffset(-1))
const expanded = ref<Set<string>>(new Set())
const syncing = ref(false)
const syncError = ref<string | null>(null)

const { isWorkday } = useWorkCalendar()

const rangeDays = computed(() => dateRange(from.value, to.value))
/** 区间内的工作日；周末和法定节假日直接跳过，不产生「无记录」结论 */
const workdayList = computed(() => rangeDays.value.filter(d => isWorkday(d)))
const skippedDays = computed(() => rangeDays.value.length - workdayList.value.length)

/** 检查对象不再是手选：关注且启用的成员就是日常范围，项目则用关注的项目 */
const followedMembers = computed(() =>
  memberStore.items
    .filter(m => m.enabled && m.followed)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
)

const reportsLoaded = computed(() =>
  rangeDays.value.reduce((sum, d) => sum + (reportStore.cache[d]?.length ?? 0), 0),
)

const sourceLabel = computed(() => {
  const s = settingsStore.settings.dailyReport
  if (s.source === 'http')
    return s.baseUrl ? `日报系统接口 ${s.baseUrl}` : '日报系统接口（未配置地址）'
  if (s.source === 'csv')
    return `本地导入的日报（${reportStore.totalReports} 条）`
  return '演示数据'
})

/** 检查一次会逐天 × 逐人调用模型，范围放太大既慢又费钱 */
const MAX_RANGE_DAYS = 31

const canRun = computed(() =>
  !runner.running
  && followedMembers.value.length > 0
  && workdayList.value.length > 0
  && from.value <= to.value
  && rangeDays.value.length <= MAX_RANGE_DAYS,
)

const blockers = computed(() => {
  const out: string[] = []
  if (from.value > to.value)
    out.push('起始日期不能晚于结束日期')
  else if (rangeDays.value.length > MAX_RANGE_DAYS)
    out.push(`检查范围最多 ${MAX_RANGE_DAYS} 天，请缩小日期区间`)
  else if (!followedMembers.value.length)
    out.push('没有关注且启用的人员。到「人员」页把需要检查的人设为关注')
  else if (!workdayList.value.length)
    out.push('这段时间没有工作日，检查已跳过')
  return out
})

function memberIdentity(m: MemberProfile) {
  return {
    id: m.reportMemberId || m.id,
    name: m.name,
    gitlabUsernames: m.gitlabUsernames ?? [],
    emails: m.emails ?? [],
  }
}

/**
 * 取某人某天的日报。
 *
 * 找不到时给一份空的：检查引擎拿到 report 就不会再向日报系统查这个人，
 * 否则区间 × 成员会退化成每人每天一次请求。空日报表示「当天没有他的记录」，
 * 后面的未引用提交检测照常进行。
 */
function reportFor(date: string, m: MemberProfile) {
  const id = m.reportMemberId || m.id
  return reportStore.findMember(date, id, m.name) ?? {
    id: `${id}@${date}`,
    date,
    memberId: id,
    memberName: m.name,
    entries: [],
    totalHours: 0,
  }
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expanded.value = next
}

function applyDefaultRange() {
  from.value = dateKeyOffset(-7)
  to.value = dateKeyOffset(-1)
}

/**
 * 刷新区间日报。
 *
 * 检查引擎拿到传入的日报就不会再问源系统，所以必须先把区间内的日报拉一遍，
 * 否则可能拿旧快照（甚至上一种数据源留下的快照）下结论。拉取失败就停止检查。
 */
async function refreshReports(): Promise<boolean> {
  if (settingsStore.settings.dailyReport.source !== 'http')
    return true

  syncing.value = true
  syncError.value = null
  try {
    const live = await reportStore.refreshRange(from.value, to.value)
    if (!live.ok) {
      syncError.value = `拉取区间日报失败，已停止检查：${live.error ?? '未知原因'}`
      return false
    }
    return true
  }
  finally {
    syncing.value = false
  }
}

async function start() {
  if (!canRun.value)
    return
  if (!(await refreshReports()))
    return

  const plans = workdayList.value.map(date => ({
    date,
    targets: followedMembers.value.map(m => ({
      member: memberIdentity(m),
      report: reportFor(date, m),
    })),
  }))

  expanded.value = new Set()
  await runner.runDays(plans, {
    range: {
      from: from.value,
      to: to.value,
      checkedWorkdays: workdayList.value.length,
      skippedDays: skippedDays.value,
    },
  })
}

function scoreClass(score: number) {
  return {
    good: 'text-emerald-600 dark:text-emerald-500',
    warn: 'text-amber-600 dark:text-amber-500',
    bad: 'text-red-600 dark:text-red-500',
  }[scoreTone(score)]
}

function flaggedVerdicts(result: InspectionResult): VerdictLevel[] {
  return followUpVerdicts(result.entries)
}

const resultDays = computed(() => new Set(runner.results.map(r => r.date)).size)
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <!-- 参数区 -->
      <Card class="gap-0 py-4">
        <CardContent class="space-y-4 px-4">
          <div class="flex flex-wrap items-end gap-3">
            <div class="space-y-1.5">
              <Label class="text-xs">起始日期</Label>
              <DatePicker v-model="from" class="w-40" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">结束日期</Label>
              <DatePicker v-model="to" class="w-40" />
            </div>

            <Button variant="outline" @click="applyDefaultRange">
              最近 7 天
            </Button>

            <Separator orientation="vertical" class="h-9" />

            <div class="min-w-0 flex-1">
              <div class="text-xs text-muted-foreground">日报来源</div>
              <div class="mt-1 flex items-center gap-2">
                <span class="truncate text-sm">{{ sourceLabel }}</span>
                <Badge variant="secondary" class="shrink-0">
                  区间内已载入 {{ reportsLoaded }} 份
                </Badge>
              </div>
            </div>

            <Button variant="outline" :disabled="syncing || runner.running" @click="refreshReports">
              <CloudDownloadIcon :size="14" class="mr-1.5" />
              {{ syncing ? '同步中…' : '刷新日报' }}
            </Button>
          </div>

          <Alert v-if="syncError" variant="destructive">
            <AlertDescription>{{ syncError }}</AlertDescription>
          </Alert>

          <Alert v-if="!settingsStore.configured && !settingsStore.llmConfigured">
            <InfoIcon :size="14" />
            <AlertTitle>还没配置外部依赖</AlertTitle>
            <AlertDescription>
              去「设置」填 GitLab 地址与 Token 才能拉到提交；填了模型之后判定才会走 AI，
              否则只按「有没有提交」做粗略判断。
              <Button variant="link" class="h-auto p-0 text-xs" @click="$router.push({ name: 'settings' })">
                前往设置
                <ArrowRightIcon :size="12" class="ml-0.5" />
              </Button>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <!-- 检查范围：不再手选人员，关注即范围 -->
      <Card class="gap-0 py-4">
        <CardContent class="px-4">
          <div v-if="followedMembers.length" class="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div class="flex items-center gap-2 text-sm">
              <UsersIcon :size="14" class="text-muted-foreground" />
              <span>
                将检查 <strong class="font-semibold">{{ followedMembers.length }}</strong> 名关注成员 ×
                <strong class="font-semibold">{{ workdayList.length }}</strong> 个工作日
              </span>
            </div>
            <span class="text-[11px] text-muted-foreground">
              {{ rangeDays.length }} 个自然日，已跳过 {{ skippedDays }} 个周末/节假日；项目按「关注」
              范围匹配
            </span>
            <Button
              variant="ghost"
              size="sm"
              class="ml-auto text-xs"
              @click="$router.push({ name: 'members' })"
            >
              调整关注名单
              <ArrowRightIcon :size="12" class="ml-1" />
            </Button>
          </div>

          <div v-else class="flex flex-wrap items-center gap-3 py-1 text-sm text-muted-foreground">
            <UsersIcon :size="14" />
            没有关注且启用的人员。检查范围由「人员」页的关注标记决定。
            <Button variant="outline" size="sm" @click="$router.push({ name: 'members' })">
              去人员页设置
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- 操作 -->
      <div class="flex items-center gap-3">
        <Button v-if="!runner.running" :disabled="!canRun" @click="start">
          <PlayIcon :size="14" class="mr-1.5" />
          开始检查 {{ followedMembers.length }} 人 × {{ workdayList.length }} 天
        </Button>
        <Button v-else variant="destructive" @click="runner.cancel()">
          <CircleStopIcon :size="14" class="mr-1.5" />
          中止
        </Button>

        <Button
          v-if="runner.catalog"
          variant="ghost"
          size="sm"
          :disabled="runner.buildingCatalog"
          :title="`发现范围：${runner.catalog.scope}`"
          @click="runner.ensureCatalog(true)"
        >
          <RefreshCwIcon :size="13" class="mr-1.5" :class="runner.buildingCatalog && 'animate-spin'" />
          重建仓库目录（{{ runner.catalog.projects.length }} 个）
        </Button>

        <span v-if="blockers.length" class="text-xs text-muted-foreground">
          {{ blockers[0] }}
        </span>
      </div>

      <!--
        缺 GitLab 不拦着运行（方便先验证流程），但必须在运行前说清后果，
        否则满屏「无法核对」容易被读成「员工没问题」。
      -->
      <Alert v-if="!settingsStore.configured" class="border-amber-500/40 bg-amber-500/5">
        <TriangleAlertIcon :size="14" class="text-amber-600 dark:text-amber-500" />
        <AlertTitle>GitLab 未配置，本次不会有任何提交参与比对</AlertTitle>
        <AlertDescription>
          所有日报内容都会判为「无法核对」，不产生符合度分数（显示为「—」）。
          这条路径只用来确认流程能跑通，结果不代表任何实际结论。
          <Button variant="link" class="h-auto p-0 text-xs" @click="$router.push({ name: 'settings' })">
            去配置 GitLab
            <ArrowRightIcon :size="12" class="ml-0.5" />
          </Button>
        </AlertDescription>
      </Alert>

      <Alert v-if="runner.catalogError" variant="destructive">
        <AlertTitle>仓库目录构建失败</AlertTitle>
        <AlertDescription>{{ runner.catalogError }}</AlertDescription>
      </Alert>

      <!--
        触达上限说明「候选池不完整」，模糊匹配会因此漏掉项目。
        这跟「项目没配映射」是两回事，必须单独提示，否则用户只会看到一堆无法核对却找不到原因。
      -->
      <Alert v-if="runner.catalog?.truncated" class="border-amber-500/40 bg-amber-500/5">
        <TriangleAlertIcon :size="14" class="text-amber-600 dark:text-amber-500" />
        <AlertTitle>仓库数量达到上限，目录不完整</AlertTitle>
        <AlertDescription>
          已同步 {{ runner.catalog.projects.length }} 个仓库后截断（上限
          {{ settingsStore.settings.gitlab.maxProjects }}）。
          未同步到的仓库里的项目会匹配不上，建议到「设置 → GitLab」用 group 收窄范围，
          或调高上限。
        </AlertDescription>
      </Alert>

      <Alert v-if="runner.catalog?.failures.length">
        <InfoIcon :size="14" />
        <AlertTitle>{{ runner.catalog.failures.length }} 个仓库路径无法访问</AlertTitle>
        <AlertDescription>
          <div class="space-y-0.5">
            <div v-for="f in runner.catalog.failures" :key="f.path">
              <span class="font-mono">{{ f.path }}</span>：{{ f.reason }}
            </div>
          </div>
        </AlertDescription>
      </Alert>

      <p v-else-if="runner.catalog" class="text-[11px] text-muted-foreground">
        仓库目录：{{ runner.catalog.projects.length }} 个 · 发现范围 {{ runner.catalog.scope }}
      </p>

      <!-- 运行中 -->
      <LiveRunPanel v-if="runner.running || runner.progress.stage === 'failed'" />

      <!-- 失败 -->
      <Alert v-if="runner.failures.length" variant="destructive">
        <AlertTitle>{{ runner.failures.length }} 条检查失败</AlertTitle>
        <AlertDescription>
          <div v-for="f in runner.failures.slice(0, 5)" :key="`${f.date}-${f.memberId}`" class="text-xs">
            {{ f.date ? `${f.date} ` : '' }}{{ f.memberName }}：{{ f.message }}
          </div>
        </AlertDescription>
      </Alert>

      <!-- 结果 -->
      <div v-if="runner.results.length" class="space-y-3 pt-2">
        <h2 class="text-sm font-medium">
          检查结果
          <span class="text-muted-foreground">
            {{ runner.results.length }} 条 · {{ resultDays }} 天
          </span>
        </h2>

        <div v-if="runner.running" class="space-y-2">
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <Skeleton class="h-3 w-3 rounded-full" />
            正在检查 {{ runner.currentLabel }}…
          </div>
        </div>

        <Card v-for="result in runner.results" :key="result.id" class="gap-0 py-0">
          <button
            type="button"
            class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40"
            @click="toggleExpand(result.id)"
          >
            <Badge variant="outline" class="shrink-0 font-mono text-[10px]">
              {{ result.date.slice(5) }}
            </Badge>
            <span class="text-sm font-medium">{{ result.memberName }}</span>

            <span
              v-if="result.summary.checkedHours > 0"
              class="text-lg font-semibold tabular-nums"
              :class="scoreClass(result.summary.score)"
            >
              {{ result.summary.score }}
            </span>
            <!-- 没有可核对内容时不给分数，避免一个红色 0 被读成对员工的结论 -->
            <span v-else class="text-lg font-semibold text-muted-foreground">—</span>

            <div class="flex flex-wrap items-center gap-1.5">
              <VerdictBadge
                v-for="v in flaggedVerdicts(result)"
                :key="v"
                :verdict="v"
                compact
              />
              <span
                v-if="result.orphanCommits.length"
                class="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"
                title="这些提交没有被任何日报条目引用；如果项目本身已在日报里提到，通常只是证据没引用到，不等于是整个项目漏报"
              >
                未被引用 {{ result.orphanCommits.length }} 个提交
              </span>
            </div>

            <span class="ml-auto text-xs tabular-nums text-muted-foreground">
              {{ result.summary.totalHours }}h · {{ result.entries.length }} 条
            </span>
          </button>

          <Separator v-if="expanded.has(result.id)" />

          <div v-if="expanded.has(result.id)" class="bg-muted/20 p-4">
            <InspectionReport :result="result" compact />
          </div>
        </Card>
      </div>

      <!-- 已保存历史时的入口 -->
      <div v-if="!runner.running && runner.results.length" class="flex justify-end pt-1">
        <Button variant="outline" size="sm" @click="$router.push({ name: 'history' })">
          查看全部历史
          <ArrowRightIcon :size="13" class="ml-1.5" />
        </Button>
      </div>
    </div>
  </div>
</template>
