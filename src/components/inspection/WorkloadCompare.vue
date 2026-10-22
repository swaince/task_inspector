<script setup lang="ts">
import type { InspectionSummary } from '@/core/domain/types'
import { computed } from 'vue'

/**
 * 工时对照：把「申报」「可核对」「代码估算」放在同一条刻度上。
 *
 * 三个数不是同一口径，所以每条都单独标注：
 * - 申报：日报里填的总工时，包含会议等非编码工作；
 * - 可核对：能对上仓库和提交的部分，分数的分母；
 * - 预估：只由提交会话和代码量推算，**不含会议/评审**。
 * 把口径混在一起比，会得出「申报多了」的假结论——差距可能只是会议时间。
 */
const props = defineProps<{
  summary: InspectionSummary
}>()

const s = computed(() => props.summary)

/** 旧检查结果没有工作量字段，统一兜底成 0，避免算出 NaN */
const low = computed(() => s.value.effectiveLow ?? 0)
const high = computed(() => s.value.effectiveHigh ?? 0)

const scale = computed(() => Math.max(8, s.value.totalHours ?? 0, high.value, 1))

function pct(v: number) {
  return Math.min(100, Math.max(0, (v / scale.value) * 100))
}

const rows = computed(() => [
  {
    key: 'reported',
    label: '日报申报',
    value: `${round1(s.value.totalHours)}h`,
    hint: '含会议、评审等非编码工作',
    left: 0,
    width: pct(s.value.totalHours),
    class: 'bg-foreground/35',
  },
  {
    key: 'checked',
    label: '可核对',
    value: `${round1(s.value.checkedHours)}h`,
    hint: '能对应到仓库和提交的部分，分数按它计算',
    left: 0,
    width: pct(s.value.checkedHours),
    class: 'bg-primary/70',
  },
])

const estimate = computed(() => ({
  low: low.value,
  high: high.value,
  left: pct(low.value),
  width: Math.max(0.8, pct(high.value) - pct(low.value)),
  text: high.value > 0
    ? `${round1(low.value)}–${round1(high.value)}h`
    : '—',
}))

const verdict = computed(() => {
  const v = s.value
  if ((v.checkedHours ?? 0) <= 0)
    return { text: '没有可核对的工作内容', color: 'var(--muted-foreground)' }
  if (high.value <= 0)
    return { text: '当天没有足够提交，无法估算有效工时', color: 'var(--muted-foreground)' }
  const over = (v.checkedHours ?? 0) - high.value
  const under = low.value - (v.checkedHours ?? 0)
  if (over > 1)
    return { text: `可核对工时比代码估算高 ${round1(over)}h`, color: 'var(--verdict-partial)' }
  if (under > 1)
    return { text: `可核对工时比代码估算低 ${round1(under)}h`, color: 'var(--verdict-nocommit)' }
  return { text: '申报与代码估算基本吻合', color: 'var(--verdict-matched)' }
})

const stats = computed(() => {
  const v = s.value
  const out = [
    { label: '提交会话', value: `${v.sessions ?? 0}` },
    { label: '活跃时段', value: `${v.activeBuckets ?? 0} 个 / ${round1(v.activeHours ?? 0)}h` },
    { label: '在场跨度', value: `${round1(v.presenceHours ?? 0)}h` },
    { label: '饱和度', value: high.value > 0 ? `${Math.round((v.saturation ?? 0) * 100)}%` : '—' },
  ]
  return out
})

function round1(n: number) {
  return Math.round(n * 10) / 10
}
</script>

<template>
  <div class="space-y-3">
    <!-- 8 小时参考线贯穿所有行 -->
    <div class="relative space-y-2.5">
      <div
        class="pointer-events-none absolute inset-y-0 w-px bg-border"
        :style="{ left: `calc(${pct(8)}% - 1px)` }"
        title="8 小时工作制参考线"
      />

      <div v-for="row in rows" :key="row.key" class="flex items-center gap-2.5">
        <span class="w-16 shrink-0 text-[11px] text-muted-foreground">{{ row.label }}</span>
        <div class="relative h-2.5 flex-1 rounded-full bg-muted/70">
          <div
            class="absolute inset-y-0 rounded-full"
            :class="row.class"
            :style="{ left: `${row.left}%`, width: `${row.width}%` }"
            :title="`${row.label} ${row.value}`"
          />
        </div>
        <span class="w-14 shrink-0 text-right text-[11px] font-medium tabular-nums">{{ row.value }}</span>
      </div>

      <div class="flex items-center gap-2.5">
        <span class="w-16 shrink-0 text-[11px] text-muted-foreground">代码估算</span>
        <div class="relative h-2.5 flex-1 rounded-full bg-muted/70">
          <div
            class="absolute inset-y-0 rounded-full"
            :style="{
              left: `${estimate.left}%`,
              width: `${estimate.width}%`,
              backgroundColor: 'color-mix(in oklab, var(--verdict-matched) 70%, transparent)',
            }"
            :title="`代码估算 ${estimate.text}`"
          />
        </div>
        <span class="w-14 shrink-0 text-right text-[11px] font-medium tabular-nums">{{ estimate.text }}</span>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <span
        class="rounded-md px-1.5 py-0.5 text-[11px]"
        :style="{
          color: verdict.color,
          backgroundColor: `color-mix(in oklab, ${verdict.color} 12%, transparent)`,
        }"
      >
        {{ verdict.text }}
      </span>
      <span
        v-if="s.batchSuspect"
        class="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"
        title="提交集中在短时间且改动量大，可能是多天工作合并提交，自证工时会被低估"
      >
        可能是一次补提交
      </span>
    </div>

    <div class="flex flex-wrap gap-x-4 gap-y-1 border-t pt-2.5 text-[11px] text-muted-foreground">
      <span v-for="item in stats" :key="item.label">
        {{ item.label }}
        <span class="ml-0.5 tabular-nums text-foreground">{{ item.value }}</span>
      </span>
    </div>
  </div>
</template>
