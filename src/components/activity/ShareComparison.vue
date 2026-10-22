<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/lib/utils'

/**
 * 项目投入对比：申报占比 vs 模型估算占比。
 *
 * 估算是在「看不到日报」的前提下算的，所以两条横条的差距才是有效信息：
 * 差得多不一定是谁错了，但值得看一眼——可能是项目工时填错了，
 * 也可能是这段时间的提交不能代表实际工作（调研、联调、改配置都算）。
 */
interface ShareRow {
  key: string
  name: string
  commits: number
  reportedShare: number | null
  estimatedShare: number | null
}

const props = defineProps<{
  rows: ShareRow[]
}>()

const visible = computed(() =>
  props.rows
    .filter(r => r.reportedShare !== null || r.estimatedShare !== null)
    .sort((a, b) =>
      Math.max(b.reportedShare ?? 0, b.estimatedShare ?? 0)
      - Math.max(a.reportedShare ?? 0, a.estimatedShare ?? 0),
    )
    .slice(0, 8),
)

function width(share: number | null) {
  return `${Math.max(0, Math.min(1, share ?? 0)) * 100}%`
}

function label(share: number | null) {
  return share === null ? '—' : `${Math.round(share * 100)}%`
}

function deviation(row: ShareRow) {
  if (row.reportedShare === null || row.estimatedShare === null)
    return null
  return Math.round((row.reportedShare - row.estimatedShare) * 100)
}

function deviationClass(row: ShareRow) {
  const d = deviation(row)
  if (d === null || Math.abs(d) < 15)
    return 'text-muted-foreground'
  return d > 0 ? 'text-amber-600 dark:text-amber-500' : 'text-sky-600 dark:text-sky-500'
}

function deviationText(row: ShareRow) {
  const d = deviation(row)
  if (d === null)
    return '估算不足'
  return `${d > 0 ? '+' : ''}${d} 个百分点`
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="!visible.length" class="text-xs text-muted-foreground">
      没有可对比的项目：要么这段时间没有提交，要么估算样本不足。
    </div>

    <div v-for="row in visible" :key="row.key" class="space-y-1">
      <div class="flex items-baseline gap-2">
        <span class="truncate text-xs font-medium" :title="row.name">{{ row.name }}</span>
        <span class="shrink-0 text-[10px] text-muted-foreground">{{ row.commits }} 条提交</span>
        <span :class="cn('ml-auto shrink-0 text-[11px] tabular-nums', deviationClass(row))">
          {{ deviationText(row) }}
        </span>
      </div>

      <div class="flex items-center gap-2">
        <span class="w-9 shrink-0 text-[10px] text-muted-foreground">申报</span>
        <div class="h-1.5 flex-1 rounded-full bg-muted/70">
          <div
            class="h-full rounded-full"
            :style="{ width: width(row.reportedShare), backgroundColor: 'var(--verdict-partial)' }"
          />
        </div>
        <span class="w-10 shrink-0 text-right text-[10px] tabular-nums">{{ label(row.reportedShare) }}</span>
      </div>

      <div class="flex items-center gap-2">
        <span class="w-9 shrink-0 text-[10px] text-muted-foreground">估算</span>
        <div class="h-1.5 flex-1 rounded-full bg-muted/70">
          <div
            class="h-full rounded-full"
            :style="{ width: width(row.estimatedShare), backgroundColor: 'var(--verdict-matched)' }"
          />
        </div>
        <span class="w-10 shrink-0 text-right text-[10px] tabular-nums">{{ label(row.estimatedShare) }}</span>
      </div>
    </div>

    <p class="text-[10px] leading-relaxed text-muted-foreground">
      估算只看提交、看不到日报，占比在有提交的项目之间归一化；差距大说明两种口径对不上，值得核对，不直接等于问题。
    </p>
  </div>
</template>
