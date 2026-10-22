<script setup lang="ts">
import type { EntryInspection, EvidenceStrength } from '@/core/domain/types'
import { computed } from 'vue'
import { VERDICT_META, VERDICT_ORDER } from '@/core/domain/verdict'
import { cn } from '@/lib/utils'

/**
 * 判定分布：按**条目数**统计（工时构成见「工时对照」）。
 *
 * 两个口径分开是因为它们回答的问题不同：
 * 条目数看「几件事被证实」，工时看「多少时间被证实」。
 * 一条 0.5h 的会议和一条 6h 的开发在工时条上权重完全不同，
 * 但在「今天有几件事说得清」这个问题上是一条对一条。
 */
const props = defineProps<{
  entries: EntryInspection[]
}>()

const rows = computed(() =>
  VERDICT_ORDER.map((verdict) => {
    const list = props.entries.filter(e => e.verdict === verdict)
    return {
      verdict,
      meta: VERDICT_META[verdict],
      count: list.length,
      hours: round1(list.reduce((s, e) => s + e.hours, 0)),
    }
  }),
)

const total = computed(() => props.entries.length || 1)

const evidenceLevels: Array<{ key: EvidenceStrength, label: string, dot: string }> = [
  { key: 'strong', label: '证据充分', dot: 'bg-emerald-500' },
  { key: 'medium', label: '证据一般', dot: 'bg-amber-500' },
  { key: 'weak', label: '证据薄弱', dot: 'bg-red-500' },
  { key: 'none', label: '无提交证据', dot: 'bg-muted-foreground/40' },
]

const evidenceRows = computed(() =>
  evidenceLevels.map(level => ({
    ...level,
    count: props.entries.filter(e => (e.evidenceStrength ?? 'none') === level.key).length,
  })),
)

function round1(n: number) {
  return Math.round(n * 10) / 10
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex h-3 w-full overflow-hidden rounded-full bg-muted">
      <div
        v-for="row in rows"
        v-show="row.count"
        :key="row.verdict"
        class="h-full transition-all"
        :style="{ width: `${(row.count / total) * 100}%`, backgroundColor: row.meta.color }"
        :title="`${row.meta.label}：${row.count} 条 · ${row.hours}h`"
      />
    </div>

    <div class="grid grid-cols-2 gap-x-5 gap-y-1.5">
      <div v-for="row in rows" :key="row.verdict" class="flex items-center gap-1.5 text-[11px] whitespace-nowrap">
        <span class="size-2 shrink-0 rounded-sm" :style="{ backgroundColor: row.meta.color }" />
        <span :class="cn(row.count ? 'text-foreground' : 'text-muted-foreground/60')">
          {{ row.meta.label }}
        </span>
        <span :class="cn('ml-auto tabular-nums', row.count ? 'text-foreground' : 'text-muted-foreground/60')">
          {{ row.count }} 条
        </span>
        <span class="w-10 text-right tabular-nums text-muted-foreground">{{ row.hours }}h</span>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2.5 text-[11px] text-muted-foreground">
      <span class="text-muted-foreground">证据强度</span>
      <span v-for="row in evidenceRows" :key="row.key" class="inline-flex items-center gap-1.5">
        <span :class="cn('size-1.5 rounded-full', row.dot)" />
        {{ row.label }}
        <span class="tabular-nums text-foreground">{{ row.count }}</span>
      </span>
    </div>
  </div>
</template>
