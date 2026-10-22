<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CircleCheckBigIcon,
  ClipboardCheckIcon,
  GitPullRequestArrowIcon,
  GaugeIcon,
  UsersIcon,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import StatCard from '@/components/common/StatCard.vue'
import VerdictBadge from '@/components/common/VerdictBadge.vue'
import { useHistoryStore } from '@/core/store/history'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'
import { attentionWeight, followUpEntries, needsFollowUp, scoreTone } from '@/core/domain/verdict'
import { todayKey } from '@/lib/format'
import { cn } from '@/lib/utils'

const router = useRouter()
const history = useHistoryStore()
const reportStore = useReportStore()
const settingsStore = useSettingsStore()

/** 概览默认看最近一次检查的日期；还没检查过就落到今天。 */
const focusDate = computed(() => history.dates[0] ?? todayKey())
const results = computed(() => history.byDate(focusDate.value))

const stats = computed(() => {
  const list = results.value
  const scored = list.filter(r => r.summary.checkedHours > 0)
  return {
    members: list.length,
    /**
     * 没有任何可核对内容时不给平均分。
     * 显示 0 会让「全员项目未映射」看起来像「全员不合格」，方向完全相反。
     */
    avgScore: scored.length
      ? Math.round((scored.reduce((s, r) => s + r.summary.score, 0) / scored.length) * 10) / 10
      : null,
    scoredMembers: scored.length,
    flagged: list.filter(r => r.entries.some(needsFollowUp)).length,
    orphans: list.reduce((s, r) => s + r.orphanCommits.length, 0),
    clean: list.filter(r =>
      r.summary.checkedHours > 0
      && r.summary.score >= 85
      && !r.orphanCommits.length,
    ).length,
  }
})

/** 需要关注的排在前面。权重口径见 attentionWeight —— 没有可核对内容的人不会被推上来。 */
const attention = computed(() =>
  [...results.value]
    .map(result => ({ result, weight: attentionWeight(result) }))
    .filter(x => x.weight > 0.15)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8),
)

const onboarded = computed(() =>
  history.results.length === 0,
)

function scoreClass(score: number) {
  return {
    good: 'text-emerald-600 dark:text-emerald-500',
    warn: 'text-amber-600 dark:text-amber-500',
    bad: 'text-red-600 dark:text-red-500',
  }[scoreTone(score)]
}

onMounted(() => history.load())
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-5 p-5">
      <!-- 首次使用的引导 -->
      <Card v-if="onboarded" class="gap-0 py-8">
        <CardContent class="space-y-4 px-6 text-center">
          <ClipboardCheckIcon :size="28" class="mx-auto text-muted-foreground" />
          <div class="space-y-1">
            <h2 class="text-base font-medium">还没有检查记录</h2>
            <p class="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground">
              这个工具把日报里申报的工作内容和当天在 GitLab 上的实际代码提交逐条对照，
              看日报是否能被提交自证，以及有没有「提交了却没写进日报」的漏报。
            </p>
          </div>
          <div class="flex justify-center gap-2">
            <Button @click="router.push({ name: 'settings' })">
              先配置 GitLab 与模型
            </Button>
            <Button variant="outline" @click="router.push({ name: 'inspect' })">
              直接试跑演示数据
            </Button>
          </div>
        </CardContent>
      </Card>

      <template v-else>
        <div class="flex items-center gap-3">
          <h2 class="text-sm font-medium">
            检查概览
            <span class="ml-2 font-normal tabular-nums text-muted-foreground">{{ focusDate }}</span>
          </h2>
          <Button
            variant="outline"
            size="sm"
            class="ml-auto"
            @click="router.push({ name: 'inspect' })"
          >
            执行新检查
            <ArrowRightIcon :size="13" class="ml-1.5" />
          </Button>
        </div>

        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="覆盖人数"
            :value="stats.members"
            :icon="UsersIcon"
            :hint="`当日已检查 ${stats.members} 人`"
          />
          <StatCard
            label="平均符合度"
            :value="stats.avgScore ?? '—'"
            :icon="GaugeIcon"
            :tone="stats.avgScore === null ? 'default' : scoreTone(stats.avgScore)"
            :hint="stats.scoredMembers
              ? `按可核对工时加权，覆盖 ${stats.scoredMembers} 人`
              : '当日没有可核对的工作内容'"
          />
          <StatCard
            label="待关注"
            :value="stats.flagged"
            :icon="AlertTriangleIcon"
            :tone="stats.flagged ? 'warn' : 'good'"
            hint="存在不一致或无提交的实质工作"
          />
          <StatCard
            label="未引用提交"
            :value="stats.orphans"
            :icon="GitPullRequestArrowIcon"
            :tone="stats.orphans ? 'warn' : 'good'"
            hint="有提交但未被任何日报条目引用"
          />
        </div>

        <!-- 需要关注的人 -->
        <Card class="gap-0 py-4">
          <CardHeader class="px-4 pb-2">
            <CardTitle class="flex items-center gap-2 text-sm">
              <AlertTriangleIcon :size="14" class="text-amber-600 dark:text-amber-500" />
              需要关注
              <span class="font-normal text-muted-foreground">{{ attention.length }} 人</span>
            </CardTitle>
          </CardHeader>
          <CardContent class="px-4">
            <div
              v-if="!attention.length"
              class="flex items-center gap-2 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground"
            >
              <CircleCheckBigIcon :size="15" class="text-emerald-600 dark:text-emerald-500" />
              当日没有需要特别关注的情况。
            </div>

            <div v-else class="divide-y">
              <button
                v-for="{ result } in attention"
                :key="result.memberId"
                type="button"
                class="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-accent/40"
                @click="router.push({ name: 'result', params: { date: result.date, memberId: result.memberId } })"
              >
                <span class="w-16 shrink-0 text-sm font-medium">{{ result.memberName }}</span>
                <span
                  :class="cn('w-10 shrink-0 text-sm font-semibold tabular-nums', scoreClass(result.summary.score))"
                >
                  {{ result.summary.checkedHours > 0 ? result.summary.score : '—' }}
                </span>

                <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  <VerdictBadge
                    v-for="e in followUpEntries(result.entries).slice(0, 3)"
                    :key="e.entryId"
                    :verdict="e.verdict"
                    compact
                    :title="e.content"
                  />
                  <span
                    v-if="result.orphanCommits.length"
                    class="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"
                  >
                    未引用 {{ result.orphanCommits.length }}
                  </span>
                </div>

                <ArrowRightIcon :size="13" class="shrink-0 text-muted-foreground" />
              </button>
            </div>
          </CardContent>
        </Card>

        <!-- 历史日期 -->
        <Card v-if="history.dates.length > 1" class="gap-0 py-4">
          <CardHeader class="px-4 pb-2">
            <CardTitle class="text-sm">近期检查</CardTitle>
          </CardHeader>
          <CardContent class="flex flex-wrap gap-1.5 px-4">
            <Button
              v-for="d in history.dates.slice(0, 14)"
              :key="d"
              variant="outline"
              size="sm"
              :class="cn('tabular-nums', d === focusDate && 'border-primary/50 bg-accent')"
              @click="router.push({ name: 'history' })"
            >
              {{ d }}
            </Button>
          </CardContent>
        </Card>
      </template>

      <Skeleton v-if="history.loading && !history.results.length" class="h-32 w-full" />

      <!-- 数据源提示 -->
      <p v-if="settingsStore.settings.dailyReport.source !== 'http'" class="text-center text-[11px] text-muted-foreground">
        当前日报来源是「{{ settingsStore.settings.dailyReport.source === 'csv' ? '本地导入' : '演示数据' }}」，
        共 {{ reportStore.totalReports }} 条记录。接入内部日报系统请到「设置 → 日报系统」。
      </p>
    </div>
  </div>
</template>
