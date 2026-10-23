<script setup lang="ts">
import { computed, ref, useId } from 'vue'

/**
 * 报告里的图表块。
 *
 * 模型输出的是 JSON 规格（见报告提示词），由这里画成 SVG。
 * 支持柱状、折线、柱线混合和环形图；每个序列都有名字，所以图例始终存在。
 */
interface RawSeries {
  name?: unknown
  data?: unknown
  type?: unknown
}

interface RawSpec {
  title?: unknown
  unit?: unknown
  type?: unknown
  labels?: unknown
  series?: unknown
}

const props = defineProps<{
  spec: RawSpec
  /** 覆盖默认配色，按序列顺序取色；应用内嵌图表用它对齐语义色 */
  palette?: string[]
}>()

interface Series {
  name: string
  type: 'bar' | 'line'
  data: number[]
}

const PALETTE = [
  'var(--verdict-nocommit)',
  'var(--verdict-partial)',
  'var(--verdict-matched)',
  'var(--verdict-mismatched)',
  'var(--verdict-unverified)',
]

const labels = computed<string[]>(() =>
  Array.isArray(props.spec.labels) ? props.spec.labels.map(v => String(v)) : [],
)

const series = computed<Series[]>(() => {
  const raw = Array.isArray(props.spec.series) ? (props.spec.series as RawSeries[]) : []
  const specType = props.spec.type
  return raw
    .map((item, index) => {
      const data = Array.isArray(item.data)
        ? item.data.map(v => Number(v)).map(v => (Number.isFinite(v) ? v : 0))
        : []
      let type: 'bar' | 'line'
      if (item.type === 'line' || item.type === 'bar')
        type = item.type
      else if (specType === 'line')
        type = 'line'
      else if (specType === 'bar-line' && index > 0)
        type = 'line'
      else
        type = 'bar'
      return {
        name: typeof item.name === 'string' && item.name.trim() ? item.name : `系列 ${index + 1}`,
        type,
        data,
      }
    })
    .filter(s => s.data.length > 0)
})

const isDonut = computed(() => props.spec.type === 'donut' || props.spec.type === 'pie')

const title = computed(() => (typeof props.spec.title === 'string' ? props.spec.title : ''))
const unit = computed(() => (typeof props.spec.unit === 'string' ? props.spec.unit : ''))

const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

/* ------------------------------------------------------------------ *
 * 环图
 * ------------------------------------------------------------------ */

const donutSeries = computed(() => series.value[0])
const donutTotal = computed(() =>
  (donutSeries.value?.data ?? []).reduce((s, v) => s + v, 0),
)

const DONUT_R = 56
const DONUT_C = 2 * Math.PI * DONUT_R

const donutSegments = computed(() => {
  const data = donutSeries.value?.data ?? []
  const total = donutTotal.value
  let acc = 0
  return data
    .map((value, i) => {
      const frac = total > 0 ? value / total : 0
      const seg = {
        label: labels.value[i] ?? `第 ${i + 1} 项`,
        value,
        frac,
        offset: acc,
        color: colorOf(i),
      }
      acc += frac
      return seg
    })
    .filter(seg => seg.value > 0)
})

/* ------------------------------------------------------------------ *
 * 柱状 / 折线
 * ------------------------------------------------------------------ */

const pointCount = computed(() =>
  Math.max(labels.value.length, ...series.value.map(s => s.data.length), 0),
)

const maxValue = computed(() =>
  Math.max(1, ...series.value.flatMap(s => s.data)),
)

const Y_TICKS = 4

/** 取一个「好看」的刻度：步长落在 1/2/2.5/5/10 × 10^n */
const scale = computed(() => {
  const max = maxValue.value
  if (max <= Y_TICKS)
    return { max: Y_TICKS, step: 1 }
  const raw = max / Y_TICKS
  const pow = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / pow
  const multiplier = [1, 2, 2.5, 5, 10].find(c => norm <= c) ?? 10
  const step = multiplier * pow
  return { max: step * Y_TICKS, step }
})

const yMax = computed(() => scale.value.max)
const yTicks = computed(() =>
  Array.from({ length: Y_TICKS + 1 }, (_, i) => i * scale.value.step),
)

const W = 720
const H = 230
/* 底部留够空间：中文全日期（2026年10月21日）要斜着放，横排会互相压住 */
const PAD = { top: 16, right: 18, bottom: 42, left: 46 }
const plotW = W - PAD.left - PAD.right
const plotH = H - PAD.top - PAD.bottom

const band = computed(() => plotW / Math.max(1, pointCount.value))

function xCenter(i: number) {
  return PAD.left + band.value * (i + 0.5)
}

function yOf(value: number) {
  return PAD.top + plotH * (1 - value / yMax.value)
}

const barSeries = computed(() => series.value.filter(s => s.type === 'bar'))
const lineSeries = computed(() => series.value.filter(s => s.type === 'line'))

const barWidth = computed(() => {
  const count = Math.max(1, barSeries.value.length)
  return (band.value * 0.62) / count
})

function barX(seriesIndex: number, i: number) {
  const groupWidth = barWidth.value * barSeries.value.length
  return PAD.left + band.value * i + (band.value - groupWidth) / 2 + barWidth.value * seriesIndex
}

function barHeight(value: number) {
  return Math.max(0, plotH * (value / yMax.value))
}

function linePath(data: number[]) {
  return data
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xCenter(i).toFixed(1)} ${yOf(v).toFixed(1)}`)
    .join(' ')
}

function areaPath(data: number[]) {
  if (!data.length)
    return ''
  const baseline = PAD.top + plotH
  return `${linePath(data)} L ${xCenter(data.length - 1).toFixed(1)} ${baseline} L ${xCenter(0).toFixed(1)} ${baseline} Z`
}

/** 全日期标签比「10-21」宽一倍多，刻度就得少一半，否则斜排也会叠在一起 */
const longLabels = computed(() => labels.value.some(label => label.length > 6))
const tickEvery = computed(() =>
  Math.max(1, Math.ceil(pointCount.value / (longLabels.value ? 6 : 10))),
)

function showLabel(i: number) {
  return i % tickEvery.value === 0 || i === pointCount.value - 1
}

function colorOf(index: number) {
  return props.palette?.[index] ?? PALETTE[index % PALETTE.length]
}

/** 每个柱状系列一个渐变，顶部实、底部略透 */
function gradientId(index: number) {
  return `chart-grad-${uid}-${index}`
}

function formatTick(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function formatNumber(v: number) {
  const r = Math.round(v * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

const primary = computed(() => series.value.find(s => s.type === 'bar') ?? series.value[0])

const primaryStats = computed(() => {
  const s = primary.value
  if (!s || !s.data.length)
    return null
  const total = s.data.reduce((a, b) => a + b, 0)
  const avg = total / s.data.length
  let peak = 0
  for (let i = 1; i < s.data.length; i++) {
    if (s.data[i] > s.data[peak])
      peak = i
  }
  return {
    total,
    avg,
    peakValue: s.data[peak],
    peakLabel: labels.value[peak] ?? `第 ${peak + 1} 项`,
  }
})

const hasData = computed(() => series.value.length > 0 && pointCount.value > 0)

/* ------------------------------------------------------------------ *
 * 悬停
 * ------------------------------------------------------------------ */

const hover = ref<number | null>(null)

const tooltipLeft = computed(() => {
  if (hover.value === null)
    return '50%'
  const pct = (xCenter(hover.value) / W) * 100
  return `${Math.min(88, Math.max(12, pct))}%`
})

const hoveredLabel = computed(() =>
  hover.value === null ? '' : (labels.value[hover.value] ?? `第 ${hover.value + 1} 项`),
)

function isEmptyPoint(i: number) {
  return series.value.every(s => (s.data[i] ?? 0) === 0)
}
</script>

<template>
  <div class="rounded-lg border bg-gradient-to-b from-muted/30 to-muted/10 p-3">
    <!-- 环图 -->
    <template v-if="isDonut">
      <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span v-if="title" class="text-xs font-medium">{{ title }}</span>
        <span v-if="unit" class="text-[10px] text-muted-foreground">单位：{{ unit }}</span>
      </div>

      <div v-if="hasData && donutTotal > 0" class="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        <svg viewBox="0 0 160 160" class="size-40 shrink-0" role="img" :aria-label="title || '占比图'">
          <circle
            cx="80"
            cy="80"
            :r="DONUT_R"
            fill="none"
            stroke="currentColor"
            stroke-opacity="0.08"
            stroke-width="18"
          />
          <circle
            v-for="seg in donutSegments"
            :key="seg.label"
            cx="80"
            cy="80"
            :r="DONUT_R"
            fill="none"
            :stroke="seg.color"
            stroke-width="18"
            :stroke-dasharray="`${seg.frac * DONUT_C} ${DONUT_C}`"
            :stroke-dashoffset="-seg.offset * DONUT_C"
            transform="rotate(-90 80 80)"
          >
            <title>{{ seg.label }}：{{ formatNumber(seg.value) }}{{ unit }}（{{ Math.round(seg.frac * 100) }}%）</title>
          </circle>
          <text x="80" y="76" text-anchor="middle" font-size="18" font-weight="600" fill="currentColor">
            {{ formatNumber(donutTotal) }}
          </text>
          <text x="80" y="94" text-anchor="middle" font-size="9" fill="currentColor" fill-opacity="0.55">
            {{ unit ? `合计（${unit}）` : '合计' }}
          </text>
        </svg>

        <div class="w-full min-w-0 space-y-1.5">
          <div v-for="seg in donutSegments" :key="seg.label" class="flex items-center gap-2 text-[11px]">
            <span class="size-2 shrink-0 rounded-sm" :style="{ backgroundColor: seg.color }" />
            <span class="truncate text-muted-foreground" :title="seg.label">{{ seg.label }}</span>
            <span class="ml-auto shrink-0 tabular-nums text-foreground">{{ formatNumber(seg.value) }}{{ unit }}</span>
            <span class="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{{ Math.round(seg.frac * 100) }}%</span>
          </div>
        </div>
      </div>

      <p v-else class="py-6 text-center text-[11px] text-muted-foreground">
        图表数据不完整，无法渲染。
      </p>
    </template>

    <!-- 柱状 / 折线 -->
    <template v-else>
      <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span v-if="title" class="text-xs font-medium">{{ title }}</span>
        <span v-if="unit" class="text-[10px] text-muted-foreground">单位：{{ unit }}</span>
        <div class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            v-for="(item, i) in series"
            :key="item.name"
            class="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <span
              v-if="item.type === 'bar'"
              class="size-2 rounded-sm"
              :style="{ backgroundColor: colorOf(i) }"
            />
            <svg v-else width="14" height="8" class="shrink-0" aria-hidden="true">
              <line x1="0" y1="4" x2="14" y2="4" :stroke="colorOf(i)" stroke-width="2" />
              <circle cx="7" cy="4" r="2.5" :fill="colorOf(i)" />
            </svg>
            {{ item.name }}
          </span>
        </div>
      </div>

      <div v-if="primaryStats" class="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span>合计 <span class="tabular-nums text-foreground">{{ formatNumber(primaryStats.total) }}{{ unit }}</span></span>
        <span>日均 <span class="tabular-nums text-foreground">{{ formatNumber(primaryStats.avg) }}{{ unit }}</span></span>
        <span>峰值 <span class="tabular-nums text-foreground">{{ primaryStats.peakLabel }}（{{ formatNumber(primaryStats.peakValue) }}{{ unit }}）</span></span>
      </div>

      <div v-if="hasData" class="relative">
        <!-- 悬停提示：同时显示这一天的所有序列，避免只看一根柱子误判 -->
        <div
          v-if="hover !== null"
          class="pointer-events-none absolute top-1 z-10 min-w-[7rem] -translate-x-1/2 rounded-md border bg-popover px-2 py-1.5 text-[10px] shadow-lg"
          :style="{ left: tooltipLeft }"
        >
          <div class="mb-1 font-medium">{{ hoveredLabel }}</div>
          <div v-for="(item, i) in series" :key="item.name" class="flex items-center gap-1.5">
            <span class="size-1.5 shrink-0 rounded-full" :style="{ backgroundColor: colorOf(i) }" />
            <span class="text-muted-foreground">{{ item.name }}</span>
            <span class="ml-auto pl-2 tabular-nums">{{ formatNumber(item.data[hover] ?? 0) }}{{ unit }}</span>
          </div>
        </div>

        <svg
          :viewBox="`0 0 ${W} ${H}`"
          class="h-auto w-full"
          role="img"
          :aria-label="title || '图表'"
          @mouseleave="hover = null"
        >
          <defs>
            <linearGradient
              v-for="(_, i) in barSeries"
              :id="gradientId(i)"
              :key="gradientId(i)"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0" :stop-color="colorOf(series.indexOf(barSeries[i]))" stop-opacity="0.95" />
              <stop offset="1" :stop-color="colorOf(series.indexOf(barSeries[i]))" stop-opacity="0.55" />
            </linearGradient>
            <linearGradient
              v-for="(item, i) in lineSeries"
              :id="`area-${uid}-${i}`"
              :key="`area-${uid}-${i}`"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0" :stop-color="colorOf(series.indexOf(item))" stop-opacity="0.22" />
              <stop offset="1" :stop-color="colorOf(series.indexOf(item))" stop-opacity="0" />
            </linearGradient>
          </defs>

          <!-- 没有任何数据的一天：淡底纹，空档要看得出来 -->
          <rect
            v-for="i in pointCount"
            v-show="isEmptyPoint(i - 1)"
            :key="`empty-${i}`"
            :x="PAD.left + band * (i - 1)"
            :y="PAD.top"
            :width="band"
            :height="plotH"
            fill="currentColor"
            fill-opacity="0.035"
          />

          <!-- 悬停竖带 -->
          <rect
            v-if="hover !== null"
            :x="PAD.left + band * hover"
            :y="PAD.top"
            :width="band"
            :height="plotH"
            fill="currentColor"
            fill-opacity="0.06"
          />

          <!-- 横向网格与 y 轴刻度 -->
          <g v-for="tick in yTicks" :key="`y-${tick}`">
            <line
              :x1="PAD.left"
              :x2="W - PAD.right"
              :y1="yOf(tick)"
              :y2="yOf(tick)"
              stroke="currentColor"
              stroke-opacity="0.08"
              stroke-dasharray="3 4"
            />
            <text
              :x="PAD.left - 8"
              :y="yOf(tick) + 3"
              text-anchor="end"
              font-size="9"
              fill="currentColor"
              fill-opacity="0.55"
            >
              {{ formatTick(tick) }}
            </text>
          </g>

          <!-- 柱子 -->
          <g v-for="(item, si) in barSeries" :key="`bar-${item.name}`">
            <g v-for="(value, i) in item.data" :key="`bar-${si}-${i}`">
              <rect
                v-if="value > 0"
                :x="barX(si, i)"
                :y="yOf(value)"
                :width="Math.max(0, barWidth - 1)"
                :height="barHeight(value)"
                rx="2"
                :fill="`url(#${gradientId(si)})`"
                :opacity="hover === null || hover === i ? 1 : 0.72"
              >
                <title>{{ labels[i] ?? `第 ${i + 1} 项` }}：{{ item.name }} {{ value }}{{ unit }}</title>
              </rect>
            </g>
          </g>

          <!-- 折线与面积 -->
          <g v-for="(item, li) in lineSeries" :key="`line-${item.name}`">
            <path
              :d="areaPath(item.data)"
              :fill="`url(#area-${uid}-${li})`"
              stroke="none"
            />
            <path
              :d="linePath(item.data)"
              fill="none"
              :stroke="colorOf(series.indexOf(item))"
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <circle
              v-for="(value, i) in item.data"
              :key="`pt-${li}-${i}`"
              :cx="xCenter(i)"
              :cy="yOf(value)"
              :r="hover === i ? 4 : 3"
              :fill="colorOf(series.indexOf(item))"
            >
              <title>{{ labels[i] ?? `第 ${i + 1} 项` }}：{{ item.name }} {{ value }}{{ unit }}</title>
            </circle>
          </g>

          <!-- x 轴标签 -->
          <text
            v-for="i in pointCount"
            :key="`x-${i}`"
            v-show="showLabel(i - 1)"
            :x="xCenter(i - 1)"
            :y="longLabels ? H - 32 : H - 10"
            :text-anchor="longLabels ? 'end' : 'middle'"
            :transform="longLabels ? `rotate(-32 ${xCenter(i - 1)} ${H - 32})` : undefined"
            font-size="9"
            fill="currentColor"
            fill-opacity="0.55"
          >
            {{ labels[i - 1] ?? i }}
          </text>

          <!-- 悬停捕获层：放在最上面，不挡柱子本身的 tooltip -->
          <rect
            v-for="i in pointCount"
            :key="`hit-${i}`"
            :x="PAD.left + band * (i - 1)"
            :y="PAD.top"
            :width="band"
            :height="plotH"
            fill="transparent"
            @mouseenter="hover = i - 1"
          />
        </svg>
      </div>

      <p v-else class="py-6 text-center text-[11px] text-muted-foreground">
        图表数据不完整，无法渲染。
      </p>
    </template>
  </div>
</template>
