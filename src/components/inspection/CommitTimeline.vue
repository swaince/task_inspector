<script setup lang="ts">
import type { EntryInspection, GitCommit, InspectionSummary } from '@/core/domain/types'
import { computed } from 'vue'

/**
 * 提交时间线：把当天所有提交按小时落在一根 24 小时的轴上。
 *
 * 这是「什么时候在干活」的维度——同样的提交数，集中在 22:00–23:00
 * 还是分散在 09:00–18:00，含义完全不同（前者更像补提交）。
 * 已写进日报的提交和未被引用的提交用两种颜色区分，不需要再回明细里数。
 */
const props = defineProps<{
  entries: EntryInspection[]
  orphanCommits: GitCommit[]
  summary: InspectionSummary
}>()

interface Point {
  id: string
  title: string
  hour: number
  covered: boolean
}

const points = computed<Point[]>(() => {
  const map = new Map<string, Point>()
  for (const entry of props.entries) {
    for (const ev of entry.evidence ?? []) {
      if (map.has(ev.commitId))
        continue
      const date = new Date(ev.authoredDate)
      if (Number.isNaN(date.getTime()))
        continue
      map.set(ev.commitId, {
        id: ev.commitId,
        title: ev.title,
        hour: date.getHours(),
        covered: true,
      })
    }
  }
  for (const commit of props.orphanCommits) {
    if (map.has(commit.id))
      continue
    const date = new Date(commit.authoredDate)
    if (Number.isNaN(date.getTime()))
      continue
    map.set(commit.id, {
      id: commit.id,
      title: commit.title,
      hour: date.getHours(),
      covered: false,
    })
  }
  return [...map.values()]
})

const bins = computed(() => {
  const out = Array.from({ length: 24 }, () => ({ covered: 0, orphan: 0, titles: [] as string[] }))
  for (const p of points.value) {
    const bin = out[p.hour]
    if (p.covered)
      bin.covered++
    else
      bin.orphan++
    if (bin.titles.length < 3)
      bin.titles.push(p.title)
  }
  return out
})

const max = computed(() => Math.max(1, ...bins.value.map(b => b.covered + b.orphan)))

const totalCovered = computed(() => points.value.filter(p => p.covered).length)
const totalOrphan = computed(() => points.value.filter(p => !p.covered).length)

function height(count: number) {
  return `${(count / max.value) * 100}%`
}

function titleOf(hour: number) {
  const bin = bins.value[hour]
  const total = bin.covered + bin.orphan
  const range = `${pad(hour)}:00–${hour === 23 ? '24:00' : `${pad(hour + 1)}:00`}`
  if (!total)
    return `${range}：没有提交`
  const parts = [`${range}：${total} 个提交`]
  if (bin.covered)
    parts.push(`已引用 ${bin.covered}`)
  if (bin.orphan)
    parts.push(`未引用 ${bin.orphan}`)
  return `${parts.join('，')}\n${bin.titles.join('\n')}`
}

function pad(n: number) {
  return String(n % 24).padStart(2, '0')
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-4 text-[11px] text-muted-foreground">
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-sm" :style="{ backgroundColor: 'var(--verdict-matched)' }" />
        日报已引用 <span class="tabular-nums text-foreground">{{ totalCovered }}</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-sm" :style="{ backgroundColor: 'var(--verdict-partial)' }" />
        未引用 <span class="tabular-nums text-foreground">{{ totalOrphan }}</span>
      </span>
    </div>

    <div class="relative">
      <div class="flex h-14 items-end gap-[2px]">
        <div
          v-for="(bin, hour) in bins"
          :key="hour"
          class="flex h-full flex-1 flex-col justify-end rounded-sm bg-muted/40"
          :title="titleOf(hour)"
        >
          <div
            v-if="bin.orphan"
            class="w-full"
            :style="{
              height: height(bin.orphan),
              backgroundColor: 'var(--verdict-partial)',
              borderTopLeftRadius: '2px',
              borderTopRightRadius: '2px',
            }"
          />
          <div
            v-if="bin.covered"
            class="w-full"
            :style="{
              height: height(bin.covered),
              backgroundColor: 'var(--verdict-matched)',
            }"
          />
        </div>
      </div>

      <div class="relative mt-1 h-3 text-[10px] text-muted-foreground">
        <span
          v-for="h in [0, 6, 12, 18, 24]"
          :key="h"
          class="absolute -translate-x-1/2 tabular-nums"
          :style="{ left: `${(h / 24) * 100}%` }"
        >
          {{ h === 24 ? '24' : pad(h) }}
        </span>
      </div>
    </div>

    <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span>提交会话 <span class="tabular-nums text-foreground">{{ summary.sessions ?? 0 }}</span></span>
      <span>活跃时段 <span class="tabular-nums text-foreground">{{ summary.activeBuckets ?? 0 }}</span>（{{ Math.round((summary.activeHours ?? 0) * 10) / 10 }}h）</span>
      <span>在场跨度 <span class="tabular-nums text-foreground">{{ Math.round((summary.presenceHours ?? 0) * 10) / 10 }}h</span></span>
    </div>

    <p v-if="!points.length" class="text-[11px] text-muted-foreground">
      当天没有拉到提交，时间线为空。
    </p>
  </div>
</template>
