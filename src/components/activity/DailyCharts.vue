<script setup lang="ts">
import { computed } from 'vue'
import ReportChart from './ReportChart.vue'
import { formatDateCN } from '@/lib/format'

/**
 * 活动页内嵌的每日趋势图。
 *
 * 直接复用报告里的 ReportChart（SVG 绘制），而不是再写一套 CSS 柱状图：
 * 两套实现会慢慢长成两种观感和两种交互——之前的版本就没有悬停、图例和刻度。
 * 这里只负责把日数据翻译成图表规格，并指定语义色。
 */
interface DayPoint {
  date: string
  commits: number
  reportedHours: number
  effectiveLow: number
  effectiveHigh: number
  /** 当天日报里提到过这个项目 / 这个人 */
  hasReport: boolean
}

const props = defineProps<{
  days: DayPoint[]
  /** 工作日日期；传入后「无记录」只统计工作日，周末/节假日不算缺报 */
  workdayDates?: string[]
}>()

const labels = computed(() => props.days.map(d => formatDateCN(d.date)))

const commitSpec = computed(() => ({
  title: '每日提交',
  unit: '条',
  type: 'bar',
  labels: labels.value,
  series: [
    { name: '提交', type: 'bar', data: props.days.map(d => d.commits) },
  ],
}))

const hoursSpec = computed(() => ({
  title: '每日申报工时与代码估算',
  unit: 'h',
  type: 'bar-line',
  labels: labels.value,
  series: [
    { name: '日报申报', type: 'bar', data: props.days.map(d => d.reportedHours) },
    { name: '代码估算', type: 'line', data: props.days.map(d => d.effectiveHigh) },
  ],
}))

const emptyDays = computed(() => {
  const allowed = props.workdayDates ? new Set(props.workdayDates) : null
  return props.days.filter(d =>
    (!allowed || allowed.has(d.date))
    && d.commits === 0
    && !d.hasReport,
  ).length
})
</script>

<template>
  <div class="space-y-2">
    <div class="grid gap-4 lg:grid-cols-2">
      <ReportChart :spec="commitSpec" :palette="['var(--verdict-nocommit)']" />
      <ReportChart
        :spec="hoursSpec"
        :palette="['var(--verdict-partial)', 'var(--verdict-matched)']"
      />
    </div>

    <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span class="size-1.5 rounded-full" :style="{ backgroundColor: 'var(--verdict-mismatched)' }" />
      无记录 {{ emptyDays }} 天（工作日里既没有提交，日报也没有记录）
    </div>
  </div>
</template>
