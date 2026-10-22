<script setup lang="ts">
import type { InspectionResult } from '@/core/domain/types'
import { computed, ref } from 'vue'
import { ClockIcon, CpuIcon, GitPullRequestArrowIcon, ListChecksIcon, SparklesIcon } from '@lucide/vue'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import CommitTimeline from './CommitTimeline.vue'
import EntryRow from './EntryRow.vue'
import OrphanCommits from './OrphanCommits.vue'
import ProjectCompare from './ProjectCompare.vue'
import VerdictBreakdown from './VerdictBreakdown.vue'
import WorkloadCompare from './WorkloadCompare.vue'
import { needsFollowUp, scoreTone, VERDICT_ORDER } from '@/core/domain/verdict'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'

const props = defineProps<{
  result: InspectionResult
  /** 嵌入执行页时用紧凑排版 */
  compact?: boolean
}>()

const hasScore = computed(() => props.result.summary.checkedHours > 0)

const tone = computed(() => scoreTone(props.result.summary.score))

const toneClass = computed(() => ({
  good: 'text-emerald-600 dark:text-emerald-500',
  warn: 'text-amber-600 dark:text-amber-500',
  bad: 'text-red-600 dark:text-red-500',
}[tone.value]))

const tab = ref('entries')

/** 「待关注」只数真正需要跟进的，口径见 needsFollowUp */
const problems = computed(() => props.result.entries.filter(needsFollowUp).length)

/** 一致计 1、部分一致计 0.5；这就是分数的分子 */
const earnedHours = computed(() => {
  const s = props.result.summary
  return Math.round((s.matchedHours + s.partialHours * 0.5) * 10) / 10
})

const scoreHint = computed(() => {
  const s = props.result.summary
  if (s.checkedHours === 0)
    return '当日没有可核对的工作内容'
  return `加权得分工时 ${earnedHours.value}h ÷ 可核对 ${s.checkedHours}h`
})

/** 可核对工时占申报工时的比例；分数高但覆盖率低时最容易被误读 */
const coverage = computed(() => {
  const s = props.result.summary
  if (s.totalHours <= 0)
    return null
  return Math.round((s.checkedHours / s.totalHours) * 100)
})

const excludedParts = computed(() => {
  const s = props.result.summary
  const parts: Array<{ label: string, hours: number, hint: string }> = []
  if (s.unresolvedHours > 0) {
    parts.push({
      label: '无法核对',
      hours: s.unresolvedHours,
      hint: '项目没有映射到 GitLab 仓库，或材料不足；不计入得分',
    })
  }
  if (s.nonCodingHours > 0) {
    parts.push({
      label: '非编码工作',
      hours: s.nonCodingHours,
      hint: '会议、评审、文档等不产生提交的工作；不计入得分',
    })
  }
  return parts
})

/**
 * 一句话结论由数据算出，不再让模型转述。
 *
 * 模型写的分析放在下面，但「几条对得上、几条对不上」这种数字必须是确定的，
 * 读的人要能直接引用。
 */
const conclusion = computed(() => {
  const s = props.result.summary
  const counts = Object.fromEntries(VERDICT_ORDER.map(v => [v, 0])) as Record<string, number>
  for (const entry of props.result.entries)
    counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1

  const pieces: string[] = []
  if (counts.matched)
    pieces.push(`${counts.matched} 条有提交佐证`)
  if (counts.partial)
    pieces.push(`${counts.partial} 条部分吻合`)
  if (counts.mismatched)
    pieces.push(`${counts.mismatched} 条与提交不符`)
  if (counts['no-commit'])
    pieces.push(`${counts['no-commit']} 条没有对应提交`)
  if (counts.unverified)
    pieces.push(`${counts.unverified} 条无法核对`)

  const orphanText = s.orphanCommitCount > 0 ? `；另有 ${s.orphanCommitCount} 个提交未被日报条目引用` : ''
  const coverageText = coverage.value === null ? '' : `；可核对覆盖率 ${coverage.value}%`

  if (!props.result.entries.length) {
    return s.orphanCommitCount > 0
      ? `当日没有日报记录，但检测到 ${s.orphanCommitCount} 个提交。`
      : '当日既没有日报记录，也没有提交。'
  }
  return `共 ${props.result.entries.length} 条日报${pieces.length ? `：${pieces.join('、')}` : ''}${coverageText}${orphanText}。`
})

const hasAttention = computed(() =>
  props.result.summary.mismatchedHours > 0
  || props.result.summary.noCommitHours > 0
  || props.result.summary.orphanCommitCount > 0,
)
</script>

<template>
  <div class="space-y-4">
    <!-- 第一屏：分数 + 判定分布 -->
    <div class="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <div class="rounded-lg border bg-card p-4">
        <div
          class="text-xs text-muted-foreground"
          title="分数 = 加权得分工时 ÷ 可核对工时。一致计 1、部分一致计 0.5；无法核对和非编码工作不计入"
        >
          可核对部分符合度
        </div>
        <!--
          没有可核对的内容时显示「—」而不是 0：
          用红色 0 配上一句「当日没有可核对的工作内容」是自相矛盾的，
          而且很容易被误读成对员工的负面结论。
        -->
        <div
          v-if="hasScore"
          :class="cn('mt-1 text-4xl font-semibold tabular-nums', toneClass)"
        >
          {{ result.summary.score }}
          <span class="text-base font-normal text-muted-foreground">/ 100</span>
        </div>
        <div v-else class="mt-1 text-4xl font-semibold text-muted-foreground">
          —
        </div>
        <div class="mt-1 text-[11px] text-muted-foreground">{{ scoreHint }}</div>

        <!-- 分数高不代表核对得全：把覆盖率单独摆出来 -->
        <div v-if="coverage !== null" class="mt-3 space-y-1.5">
          <div class="flex items-center justify-between text-[11px]">
            <span class="text-muted-foreground">可核对覆盖率</span>
            <span class="tabular-nums">
              <strong class="font-semibold text-foreground">{{ coverage }}%</strong>
              <span class="text-muted-foreground"> · {{ result.summary.checkedHours }}h / {{ result.summary.totalHours }}h</span>
            </span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              class="h-full rounded-full bg-primary/60"
              :style="{ width: `${coverage}%` }"
            />
          </div>
          <div
            v-for="part in excludedParts"
            :key="part.label"
            class="flex items-center justify-between text-[11px] text-muted-foreground"
            :title="part.hint"
          >
            <span>未计入：{{ part.label }}</span>
            <span class="tabular-nums">{{ part.hours }}h</span>
          </div>
        </div>

        <p
          :class="cn(
            'mt-3 border-t pt-3 text-xs leading-relaxed',
            hasAttention ? 'text-foreground' : 'text-muted-foreground',
          )"
        >
          {{ conclusion }}
        </p>

        <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span class="inline-flex items-center gap-1">
            <CpuIcon :size="11" /> {{ result.meta.model }}
          </span>
          <span class="inline-flex items-center gap-1">
            <ClockIcon :size="11" /> {{ formatDuration(result.meta.durationMs) }}
          </span>
          <span v-if="result.meta.scopedProjects.length">
            {{ result.meta.scopedProjects.length }} 个仓库
          </span>
        </div>
      </div>

      <div class="rounded-lg border bg-card p-4">
        <div class="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="text-xs font-medium">判定分布</span>
          <span class="text-[11px] text-muted-foreground">
            {{ result.entries.length }} 条日报 · 待关注
            <span :class="problems ? 'text-amber-600 dark:text-amber-500' : ''">{{ problems }}</span> 条
          </span>
        </div>
        <p class="mb-2 text-[11px] text-muted-foreground">
          只有一致 / 部分一致 / 不一致 / 无提交参与得分；无法核对与非编码工作不计入。
        </p>
        <VerdictBreakdown :entries="result.entries" />
      </div>
    </div>

    <!-- 第二屏：工时对照 + 提交时间线 -->
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="rounded-lg border bg-card p-4">
        <div class="mb-3 flex flex-wrap items-baseline gap-3">
          <span class="text-xs font-medium">工时对照</span>
          <span class="text-[11px] text-muted-foreground">申报 / 可核对 / 代码估算 · 三者口径不同，不参与符合度得分</span>
        </div>
        <WorkloadCompare :summary="result.summary" />
      </div>

      <div class="rounded-lg border bg-card p-4">
        <div class="mb-3 flex flex-wrap items-baseline gap-3">
          <span class="text-xs font-medium">提交时间线</span>
          <span class="text-[11px] text-muted-foreground">未引用提交仍计入工时估算，但不影响符合度得分</span>
        </div>
        <CommitTimeline
          :entries="result.entries"
          :orphan-commits="result.orphanCommits"
          :summary="result.summary"
        />
      </div>
    </div>

    <!-- 第三屏：项目维度对比 -->
    <div class="rounded-lg border bg-card p-4">
      <div class="mb-3 flex flex-wrap items-baseline gap-3">
        <span class="text-xs font-medium">项目对比</span>
        <span class="text-[11px] text-muted-foreground">
          按项目并排申报与实际提交；标色行为需要跟进的偏差
        </span>
      </div>
      <ProjectCompare
        v-if="result.entries.length || result.orphanCommits.length"
        :entries="result.entries"
        :orphan-commits="result.orphanCommits"
        :repo-project-names="result.meta.repoProjectNames"
      />
      <p v-else class="text-xs text-muted-foreground">没有可对比的项目。</p>
    </div>

    <!-- 模型分析 -->
    <div v-if="result.narrative" class="rounded-lg border bg-card p-4">
      <div class="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <SparklesIcon :size="13" class="text-muted-foreground" />
        分析
      </div>
      <Message from="assistant" class="max-w-none">
        <MessageContent class="max-w-none">
          <MessageResponse :content="result.narrative" class="prose-measure" />
        </MessageContent>
      </Message>
    </div>

    <!-- 明细 -->
    <Tabs v-model="tab">
      <TabsList>
        <TabsTrigger value="entries">
          <ListChecksIcon :size="14" class="mr-1.5" />
          逐条核对
          <span class="ml-1.5 text-muted-foreground">{{ result.entries.length }}</span>
          <span
            v-if="problems"
            class="ml-1.5 rounded-full bg-amber-500/15 px-1.5 text-[11px] text-amber-700 dark:text-amber-400"
          >
            {{ problems }} 项待关注
          </span>
        </TabsTrigger>
        <TabsTrigger value="orphans">
          <GitPullRequestArrowIcon :size="14" class="mr-1.5" />
          未引用提交
          <span class="ml-1.5 text-muted-foreground">{{ result.orphanCommits.length }}</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="entries" class="mt-3 space-y-2.5">
        <div v-if="!result.entries.length" class="rounded-lg border border-dashed p-8 text-center">
          <p class="text-sm text-muted-foreground">
            当日没有查到该成员的日报记录。如确有工作提交，属于漏报日报。
          </p>
        </div>
        <EntryRow
          v-for="(entry, i) in result.entries"
          :key="entry.entryId"
          :entry="entry"
          :index="i"
        />
      </TabsContent>

      <TabsContent value="orphans" class="mt-3">
        <div v-if="!result.orphanCommits.length" class="rounded-lg border border-dashed p-8 text-center">
          <!--
            区分「拉到了提交且全部有对应」和「压根没拉到提交」。
            后者说成「没有漏报」是把没数据当成没问题——和把无分数显示成 0 分是同一类错误。
          -->
          <p v-if="!result.meta.scopedProjects.length" class="text-sm text-muted-foreground">
            本次没有拉到任何提交（未配置 GitLab，或日报项目未映射到仓库），无法判断是否有未被引用的提交。
          </p>
          <p v-else class="text-sm text-muted-foreground">
            已拉到 {{ result.meta.scopedProjects.length }} 个仓库的提交，全部能被日报条目引用，没有未引用提交。
          </p>
        </div>
        <OrphanCommits
          v-else
          :commits="result.orphanCommits"
          :repo-project-names="result.meta.repoProjectNames"
        />
      </TabsContent>
    </Tabs>
  </div>
</template>
