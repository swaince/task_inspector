<script setup lang="ts">
import type { DailyReportEntry, GitCommit } from '@/core/domain/types'
import type { ActivityFailure } from '@/core/engine/activity'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ClockIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  Loader2Icon,
  RefreshCwIcon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import CommitInspectorDialog from '@/components/inspection/CommitInspectorDialog.vue'
import StatCard from '@/components/common/StatCard.vue'
import { GitLabClient } from '@/core/adapters/gitlab'
import { openExternal } from '@/core/bridge'
import { buildIdentities, collectProjectCommits, commitOwner } from '@/core/engine/activity'
import { projectMatches, toProjectRefs } from '@/core/engine/matching'
import { assignCommitDate } from '@/core/engine/window'
import { useMemberStore } from '@/core/store/members'
import { useProjectStore } from '@/core/store/projects'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'
import { formatDateCN, formatDateTime } from '@/lib/format'

/**
 * 项目活动 · 单日单人详情。
 *
 * 列表页一行只放得下 3 条提交、2 条日报，剩下的都被截掉了；真正要判断
 * 「这天这个人到底干了什么」得把两边摊开看。所以这里不复用表格，而是
 * 左提交、右日报，把当天的全部内容铺开。
 *
 * 数据不复用列表页的内存结果：那是一次跨度扫描的切片，刷新或深链就没了。
 * 这里按 URL 里的项目 + 日期重扫一次，范围只有一天，代价很小，换来的是
 * 这个页面可以被直接打开、刷新、收藏。
 */

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const memberStore = useMemberStore()
const reportStore = useReportStore()
const settingsStore = useSettingsStore()

const projectId = computed(() => String(route.params.projectId))
const date = computed(() => String(route.params.date))
const memberKey = computed(() => String(route.params.memberKey))

const project = computed(() => projectStore.items.find(p => p.id === projectId.value) ?? null)

/** 没匹配到人员实体的提交，memberKey 是 `author:<邮箱>`，没有对应的成员 */
const member = computed(() => {
  if (memberKey.value.startsWith('author:'))
    return null
  return memberStore.items.find(m => (m.reportMemberId || m.id) === memberKey.value) ?? null
})

const commits = ref<GitCommit[]>([])
const failures = ref<ActivityFailure[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const scannedAt = ref<string | null>(null)

const inspectedCommit = ref<GitCommit | null>(null)
const commitOpen = ref(false)

const report = computed(() =>
  reportStore.cache[date.value]?.find(r => r.memberId === memberKey.value) ?? null,
)

/** 日报里只取这个项目的条目，别的项目的工时不该算进来 */
const entries = computed<DailyReportEntry[]>(() => {
  const p = project.value
  if (!p || !report.value)
    return []
  return report.value.entries.filter(e => projectMatches(p, e))
})

const hours = computed(() => entries.value.reduce((sum, e) => sum + e.hours, 0))

const memberName = computed(() =>
  member.value?.name ?? commits.value[0]?.authorName ?? '未知人员',
)

const totals = computed(() => commits.value.reduce(
  (acc, c) => ({
    additions: acc.additions + (c.stats?.additions ?? 0),
    deletions: acc.deletions + (c.stats?.deletions ?? 0),
  }),
  { additions: 0, deletions: 0 },
))

/**
 * 结论只有四种，直接说清楚，别让人自己对照两列去推。
 */
const verdict = computed(() => {
  if (loading.value)
    return { label: '扫描中', tone: 'default' as const }
  if (commits.value.length && report.value)
    return { label: '有提交有日报', tone: 'good' as const }
  if (commits.value.length)
    return { label: '有提交未申报', tone: 'warn' as const }
  if (report.value)
    return { label: '有日报无提交', tone: 'warn' as const }
  return { label: '无记录', tone: 'default' as const }
})

onMounted(async () => {
  await Promise.all([projectStore.load(), memberStore.load()])
  await reportStore.load()
  await load()
})

// 同一个路由记录内换参数（比如从别人分享的链接跳到另一天）不会重新 mount，
// 提交列表得跟着重新扫，否则页面显示的还是上一条的数据
watch([projectId, date, memberKey], () => load())

async function load() {
  const p = project.value
  if (!p) {
    error.value = '找不到这个项目，可能已被删除'
    return
  }

  const refs = toProjectRefs(p)
  if (!refs.length) {
    error.value = `项目「${p.name}」还没有关联到任何仓库。到「项目」面板加上仓库或组，然后点「解析关联仓库」`
    return
  }

  loading.value = true
  error.value = null
  failures.value = []

  try {
    // 日志可以补写，这一天的日报直接问源系统要；失败时用本地缓存继续展示
    await reportStore.refreshRange(date.value, date.value)
    const settings = settingsStore.settings
    const { batches, failures: failed } = await collectProjectCommits(refs, date.value, date.value, {
      gitlab: new GitLabClient(settings.gitlab),
      rules: settings.rules,
      perPage: settings.gitlab.perPage,
      maxCommitsPerProject: settings.rules.maxCommitsPerProject,
      // 这一页只要清单，diff 等点开某一条再单独拉
    })
    failures.value = failed

    // 和列表页同一套归属规则：按时间窗落日期、按身份落人，否则两处会对不上
    const identities = buildIdentities(memberStore.items)
    commits.value = batches
      .flatMap(b => b.commits)
      .filter(c => assignCommitDate(c.authoredDate, [date.value], settings.rules) === date.value)
      .filter(c => ownerKeyOf(c, identities) === memberKey.value)
      .sort((a, b) => b.authoredDate.localeCompare(a.authoredDate))

    scannedAt.value = new Date().toLocaleTimeString()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

function ownerKeyOf(commit: GitCommit, identities: ReturnType<typeof buildIdentities>) {
  const owner = commitOwner(commit, identities)
  return owner ? (owner.reportMemberId || owner.id) : `author:${commit.authorEmail}`
}

function inspect(commit: GitCommit) {
  inspectedCommit.value = commit
  commitOpen.value = true
}

function fmtTime(iso: string) {
  return formatDateTime(iso)
}
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="mx-auto max-w-6xl space-y-4 p-5">
      <div class="flex items-start gap-2">
        <Button variant="ghost" size="sm" class="-ml-2 shrink-0" @click="router.push({ name: 'project-activity' })">
          <ArrowLeftIcon :size="14" class="mr-1.5" />
          返回
        </Button>

        <div class="min-w-0">
          <h1 class="truncate text-base leading-6 font-medium">
            {{ project?.name ?? '项目活动详情' }}
          </h1>
          <div class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
            <span class="tabular-nums">{{ formatDateCN(date) }}</span>
            <span>·</span>
            <span>{{ memberName }}</span>
            <Badge v-if="!member" variant="outline" class="text-[10px] font-normal text-amber-600 dark:text-amber-500">
              未匹配到人员
            </Badge>
            <template v-if="member?.team">
              <span>·</span>
              <span class="truncate">{{ member.team }}</span>
            </template>
          </div>
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-2">
          <span v-if="scannedAt" class="text-[11px] text-muted-foreground">{{ scannedAt }} 扫描</span>
          <Button variant="outline" size="sm" :disabled="loading" @click="load">
            <Loader2Icon v-if="loading" :size="13" class="mr-1.5 animate-spin" />
            <RefreshCwIcon v-else :size="13" class="mr-1.5" />
            重新扫描
          </Button>
        </div>
      </div>

      <Alert v-if="error" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Alert v-if="failures.length" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          {{ failures.length }} 个仓库拉取失败，结果可能不完整：
          {{ failures.slice(0, 3).map(f => `${f.projectPath}（${f.message}）`).join('；') }}
        </AlertDescription>
      </Alert>

      <Alert v-if="reportStore.liveError" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          实时拉取日报失败：{{ reportStore.liveError }}。右侧显示的是本地缓存，可能不是最新。
        </AlertDescription>
      </Alert>

      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="提交" :value="commits.length" hint="当天该项目下的提交" />
        <StatCard
          label="代码量"
          :value="`+${totals.additions} / -${totals.deletions}`"
          hint="仅统计提交里报告的行数"
        />
        <StatCard
          label="申报工时"
          :value="report ? `${hours}h` : '—'"
          :hint="report ? `日报里 ${entries.length} 条提到这个项目` : '当天没有日报记录'"
        />
        <StatCard
          label="结论"
          :value="verdict.label"
          :tone="verdict.tone === 'good' ? 'good' : verdict.tone === 'warn' ? 'warn' : 'default'"
          hint="按「有提交 / 有日报」两两组合判断"
        />
      </div>

      <div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <!-- 提交 -->
        <Card class="gap-0 overflow-hidden py-0">
          <CardHeader class="flex flex-row items-center gap-2 border-b px-4 py-3">
            <CardTitle class="text-sm">提交记录</CardTitle>
            <Badge variant="secondary" class="text-[10px] tabular-nums">{{ commits.length }}</Badge>
            <span class="ml-auto text-[11px] text-muted-foreground">点标题查看改动内容</span>
          </CardHeader>

          <CardContent class="p-0">
            <div v-if="loading" class="space-y-3 p-4">
              <Skeleton v-for="i in 4" :key="i" class="h-14 w-full" />
            </div>

            <p v-else-if="!commits.length" class="px-4 py-12 text-center text-xs text-muted-foreground">
              这一天该项目下没有提交记录。
            </p>

            <ul v-else class="divide-y">
              <li v-for="c in commits" :key="c.id" class="px-4 py-3">
                <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <ClockIcon :size="11" class="shrink-0" />
                  <span class="tabular-nums">{{ fmtTime(c.authoredDate) }}</span>
                  <span class="font-mono">{{ c.shortId }}</span>
                  <span v-if="c.stats" class="tabular-nums">
                    <span class="text-emerald-600 dark:text-emerald-500">+{{ c.stats.additions }}</span>
                    <span class="ml-1 text-red-600 dark:text-red-500">-{{ c.stats.deletions }}</span>
                  </span>
                  <Button
                    v-if="c.webUrl"
                    variant="ghost"
                    size="icon-xs"
                    class="ml-auto"
                    title="在 GitLab 上打开"
                    @click="openExternal(c.webUrl)"
                  >
                    <ExternalLinkIcon :size="12" />
                  </Button>
                </div>

                <button
                  type="button"
                  class="mt-1 block w-full text-left text-sm leading-relaxed break-words hover:underline"
                  title="点击查看改动内容"
                  @click="inspect(c)"
                >
                  {{ c.title }}
                </button>

                <div class="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span class="truncate font-mono" :title="c.projectPath">{{ c.projectPath }}</span>
                  <span
                    v-if="c.refName"
                    class="inline-flex shrink-0 items-center gap-1 rounded border px-1 py-0.5 font-mono text-[10px]"
                    :title="`只统计 ${c.refName} 分支上的提交`"
                  >
                    <GitBranchIcon :size="9" />
                    {{ c.refName }}
                  </span>
                  <span class="ml-auto shrink-0">{{ c.authorName }}</span>
                </div>
              </li>
            </ul>
          </CardContent>
        </Card>

        <!-- 日报 + 人员 -->
        <div class="space-y-4 xl:sticky xl:top-4">
          <Card class="gap-0 py-0">
            <CardHeader class="border-b px-4 py-3">
              <CardTitle class="text-sm">当天日报</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3 p-4">
              <p v-if="!report" class="rounded-md border border-dashed p-3 text-[11px] leading-relaxed text-muted-foreground">
                这一天源系统里没有这个人的日报。如果「设置 → 日报系统」还没配好或者连不上，
                检查时也会因为缺日报而把这一天的提交算成「未申报」。
              </p>

              <template v-else>
                <div class="flex items-baseline gap-1.5">
                  <span class="text-2xl font-semibold tabular-nums">{{ hours }}</span>
                  <span class="text-xs text-muted-foreground">小时 · 本项目 · {{ entries.length }} 条</span>
                </div>

                <p v-if="!entries.length" class="text-[11px] text-amber-600 dark:text-amber-500">
                  日报里没有提到这个项目。
                </p>

                <ul class="space-y-2">
                  <li
                    v-for="(e, i) in entries"
                    :key="i"
                    class="rounded-md border bg-muted/30 p-2.5"
                  >
                    <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span class="truncate">{{ e.projectName }}</span>
                      <span class="ml-auto shrink-0 tabular-nums">{{ e.hours }}h</span>
                    </div>
                    <p class="mt-1 text-xs leading-relaxed break-words whitespace-pre-wrap">
                      {{ e.content }}
                    </p>
                  </li>
                </ul>

                <p class="text-[11px] text-muted-foreground">
                  当天日报共 {{ report.entries.length }} 条、{{ report.totalHours }}h，
                  这里只列出提到「{{ project?.name ?? '本项目' }}」的部分。
                </p>
              </template>
            </CardContent>
          </Card>

          <Card class="gap-0 py-0">
            <CardHeader class="border-b px-4 py-3">
              <CardTitle class="text-sm">人员</CardTitle>
            </CardHeader>
            <CardContent class="space-y-2 p-4">
              <template v-if="member">
                <div class="text-sm font-medium">{{ member.name }}</div>
                <div class="text-[11px] text-muted-foreground">
                  {{ [member.employeeNo, member.team, member.role].filter(Boolean).join(' · ') || '未填写工号 / 团队' }}
                </div>
                <div class="flex flex-wrap gap-1 pt-1">
                  <Badge
                    v-for="u in member.gitlabUsernames"
                    :key="u"
                    variant="outline"
                    class="font-mono text-[10px] font-normal"
                  >
                    @{{ u }}
                  </Badge>
                  <Badge
                    v-for="mail in member.emails"
                    :key="mail"
                    variant="outline"
                    class="text-[10px] font-normal"
                  >
                    {{ mail }}
                  </Badge>
                </div>
                <Button
                  variant="link"
                  size="sm"
                  class="h-auto p-0 text-[11px]"
                  @click="router.push({ name: 'members' })"
                >
                  到人员面板调整身份
                </Button>
              </template>

              <template v-else>
                <div class="text-sm font-medium">{{ commits[0]?.authorName ?? '未知作者' }}</div>
                <p class="text-[11px] leading-relaxed text-muted-foreground">
                  GitLab 上的提交作者，还没对应到任何人员实体，所以这一天的提交不会归到任何人头上。
                  到「人员」面板给某个人加上这个用户名或邮箱即可。
                </p>
                <div class="flex flex-wrap gap-1 pt-1">
                  <Badge variant="outline" class="text-[10px] font-normal">
                    {{ memberKey.replace(/^author:/, '') }}
                  </Badge>
                </div>
                <Button
                  variant="link"
                  size="sm"
                  class="h-auto p-0 text-[11px]"
                  @click="router.push({ name: 'members' })"
                >
                  去绑定人员身份
                </Button>
              </template>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>

    <CommitInspectorDialog v-model:open="commitOpen" :commit="inspectedCommit" />
  </div>
</template>
