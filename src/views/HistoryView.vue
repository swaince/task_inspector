<script setup lang="ts">
import type { InspectionResult } from '@/core/domain/types'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChevronDownIcon, ChevronRightIcon, HistoryIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import DatePicker from '@/components/common/DatePicker.vue'
import VerdictBadge from '@/components/common/VerdictBadge.vue'
import { useHistoryStore } from '@/core/store/history'
import { needsFollowUp, scoreTone } from '@/core/domain/verdict'
import { formatDateCN } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * 检查历史。
 *
 * 检查已经按「工作日区间 × 关注成员」执行，一次执行会产生多条「人 × 天」结果。
 * 所以先按 runId 聚成批次，再在批次里按日期展开；旧记录没有 runId，按日期归为单日批次。
 */
const router = useRouter()
const route = useRoute()
const history = useHistoryStore()

/** 从概览的日期快捷入口进来时，直接筛到那一天 */
function queryDate(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

const filter = ref('')
const from = ref(queryDate(route.query.date))
const to = ref(queryDate(route.query.date))
const expanded = ref<Set<string>>(new Set())
const confirmClearOpen = ref(false)

watch(
  () => route.query.date,
  (value) => {
    const date = queryDate(value)
    if (!date)
      return
    from.value = date
    to.value = date
  },
)

const filtered = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  return history.results.filter((r) => {
    if (from.value && r.date < from.value)
      return false
    if (to.value && r.date > to.value)
      return false
    if (!keyword)
      return true
    return r.memberName.toLowerCase().includes(keyword)
      || r.memberId.toLowerCase().includes(keyword)
      || r.entries.some(e => e.projectName.toLowerCase().includes(keyword))
      || (r.meta.scopedProjects ?? []).some(p => p.toLowerCase().includes(keyword))
  })
})

/** 日期筛选后，批次只包含区间内的结果，不能再拿整次执行的「工作日数」当分母 */
const dateFiltered = computed(() => Boolean(from.value || to.value))

interface Batch {  id: string
  legacy: boolean
  from: string
  to: string
  results: InspectionResult[]
  dates: string[]
  members: number
  checkedWorkdays?: number
  skippedDays?: number
  avg: number | null
  flagged: number
  uncited: number
}

const batches = computed<Batch[]>(() => {
  const map = new Map<string, Batch>()

  for (const result of filtered.value) {
    const runId = result.meta.runId
    const key = runId ?? `legacy:${result.date}`
    let batch = map.get(key)
    if (!batch) {
      batch = {
        id: key,
        legacy: !runId,
        from: result.meta.runFrom || result.date,
        to: result.meta.runTo || result.date,
        results: [],
        dates: [],
        members: 0,
        checkedWorkdays: result.meta.checkedWorkdays,
        skippedDays: result.meta.skippedDays,
        avg: null,
        flagged: 0,
        uncited: 0,
      }
      map.set(key, batch)
    }
    batch.results.push(result)
    if (runId) {
      batch.from = result.meta.runFrom || batch.from
      batch.to = result.meta.runTo || batch.to
    }
  }

  const out = [...map.values()].map((batch) => {
    batch.results.sort((a, b) =>
      b.date.localeCompare(a.date) || a.memberName.localeCompare(b.memberName, 'zh-Hans-CN'),
    )
    const scored = batch.results.filter(r => r.summary.checkedHours > 0)
    batch.avg = scored.length
      ? Math.round((scored.reduce((s, r) => s + r.summary.score, 0) / scored.length) * 10) / 10
      : null
    batch.flagged = batch.results.filter(r => r.entries.some(needsFollowUp)).length
    batch.uncited = batch.results.reduce((s, r) => s + r.orphanCommits.length, 0)
    batch.members = new Set(batch.results.map(r => r.memberId)).size
    batch.dates = [...new Set(batch.results.map(r => r.date))].sort((a, b) => b.localeCompare(a))
    batch.checkedWorkdays = batch.checkedWorkdays ?? batch.dates.length
    batch.skippedDays = batch.skippedDays ?? 0
    return batch
  })

  return out.sort((a, b) => b.to.localeCompare(a.to) || b.from.localeCompare(a.from))
})

/** 首次加载后自动展开最新的一批，省一次点击 */
let autoExpanded = false
watch(batches, (list) => {
  if (!autoExpanded && list.length) {
    expanded.value = new Set([list[0].id])
    autoExpanded = true
  }
}, { immediate: true })

const totals = computed(() => {
  const results = filtered.value
  const scored = results.filter(r => r.summary.checkedHours > 0)
  const avg = scored.length
    ? Math.round((scored.reduce((s, r) => s + r.summary.score, 0) / scored.length) * 10) / 10
    : null
  const dates = new Set(results.map(r => r.date))
  return {
    batches: batches.value.length,
    results: results.length,
    dates: dates.size,
    avg,
    flagged: results.filter(r => r.entries.some(needsFollowUp)).length,
    uncited: results.reduce((s, r) => s + r.orphanCommits.length, 0),
  }
})

function toggleBatch(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expanded.value = next
}

function resultsOfDate(batch: Batch, date: string) {
  return batch.results.filter(r => r.date === date)
}

function summaryOf(results: InspectionResult[]) {
  const scored = results.filter(r => r.summary.checkedHours > 0)
  return {
    avg: scored.length
      ? Math.round((scored.reduce((s, r) => s + r.summary.score, 0) / scored.length) * 10) / 10
      : null,
    flagged: results.filter(r => r.entries.some(needsFollowUp)).length,
    uncited: results.reduce((s, r) => s + r.orphanCommits.length, 0),
  }
}

function scoreClass(score: number) {
  return {
    good: 'text-emerald-600 dark:text-emerald-500',
    warn: 'text-amber-600 dark:text-amber-500',
    bad: 'text-red-600 dark:text-red-500',
  }[scoreTone(score)]
}

function formatRange(batch: Batch) {
  return batch.from === batch.to
    ? formatDateCN(batch.from)
    : `${formatDateCN(batch.from)} ~ ${formatDateCN(batch.to)}`
}

function clearRange() {
  from.value = ''
  to.value = ''
}

onMounted(() => history.load())

async function clearAll() {
  await history.clear()
  confirmClearOpen.value = false
}
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <!-- 筛选 -->
      <div class="flex flex-wrap items-center gap-2">
        <Input
          v-model="filter"
          placeholder="按姓名、项目或仓库筛选…"
          class="h-8 w-64"
        />
        <DatePicker v-model="from" class="w-44" placeholder="起始日期" />
        <DatePicker v-model="to" class="w-44" placeholder="结束日期" />
        <Button v-if="from || to" variant="ghost" @click="clearRange">
          全部时间
        </Button>

        <span class="text-xs text-muted-foreground">
          {{ totals.batches }} 个批次 · {{ totals.results }} 条记录 · 覆盖 {{ totals.dates }} 天
        </span>

        <Button
          v-if="history.results.length"
          variant="ghost"
          class="ml-auto"
          @click="confirmClearOpen = true"
        >
          清空历史
        </Button>
      </div>

      <!-- 指标 -->
      <div v-if="filtered.length" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-lg border bg-card px-4 py-3">
          <div class="text-[11px] text-muted-foreground">检查批次</div>
          <div class="mt-0.5 text-lg font-semibold tabular-nums">{{ totals.batches }}</div>
          <div class="text-[11px] text-muted-foreground">{{ totals.results }} 条人日结果</div>
        </div>
        <div class="rounded-lg border bg-card px-4 py-3">
          <div class="text-[11px] text-muted-foreground">平均符合度</div>
          <div class="mt-0.5 text-lg font-semibold tabular-nums">
            {{ totals.avg ?? '—' }}
          </div>
          <div class="text-[11px] text-muted-foreground">只统计有可核对内容的记录</div>
        </div>
        <div class="rounded-lg border bg-card px-4 py-3">
          <div class="text-[11px] text-muted-foreground">待关注</div>
          <div
            class="mt-0.5 text-lg font-semibold tabular-nums"
            :class="totals.flagged ? 'text-amber-600 dark:text-amber-500' : undefined"
          >
            {{ totals.flagged }}
          </div>
          <div class="text-[11px] text-muted-foreground">存在需要跟进的条目</div>
        </div>
        <div class="rounded-lg border bg-card px-4 py-3">
          <div class="text-[11px] text-muted-foreground">未引用提交</div>
          <div class="mt-0.5 text-lg font-semibold tabular-nums">{{ totals.uncited }}</div>
          <div class="text-[11px] text-muted-foreground">未被任何日报条目引用</div>
        </div>
      </div>

      <Skeleton v-if="history.loading && !history.results.length" class="h-64 w-full" />

      <!-- 完全没有历史 -->
      <div
        v-else-if="!history.results.length"
        class="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-20"
      >
        <HistoryIcon :size="28" class="text-muted-foreground" />
        <p class="text-sm text-muted-foreground">还没有检查记录</p>
        <Button size="sm" @click="router.push({ name: 'inspect' })">
          去执行一次检查
        </Button>
      </div>

      <!-- 有历史但没有匹配项 -->
      <div v-else-if="!filtered.length" class="rounded-lg border border-dashed p-12 text-center">
        <p class="text-sm text-muted-foreground">没有匹配的检查记录</p>
      </div>

      <!-- 批次列表 -->
      <div v-for="batch in batches" :key="batch.id" class="overflow-hidden rounded-lg border">
        <button
          type="button"
          class="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-accent/40"
          @click="toggleBatch(batch.id)"
        >
          <ChevronDownIcon v-if="expanded.has(batch.id)" :size="14" class="shrink-0 text-muted-foreground" />
          <ChevronRightIcon v-else :size="14" class="shrink-0 text-muted-foreground" />

          <span class="text-sm font-medium tabular-nums">{{ formatRange(batch) }}</span>
          <Badge v-if="batch.legacy" variant="outline" class="text-[10px] text-muted-foreground">
            旧记录
          </Badge>

          <span class="text-xs text-muted-foreground">
            {{ batch.members }} 名成员 · {{ batch.dates.length }} 天
            <template v-if="!batch.legacy && !dateFiltered">
              · 工作日 {{ batch.checkedWorkdays }} 天
              <template v-if="batch.skippedDays">（跳过 {{ batch.skippedDays }} 天）</template>
            </template>
            · {{ batch.results.length }} 条结果
          </span>

          <span class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span v-if="batch.avg !== null" class="tabular-nums">
              平均 <span :class="scoreClass(batch.avg)">{{ batch.avg }}</span> 分
            </span>
            <span v-if="batch.flagged" class="tabular-nums text-amber-600 dark:text-amber-500">
              待关注 {{ batch.flagged }}
            </span>
            <span v-if="batch.uncited" class="tabular-nums text-muted-foreground">
              未引用 {{ batch.uncited }}
            </span>
          </span>
        </button>

        <div v-if="expanded.has(batch.id)" class="border-t">
          <div
            v-for="date in batch.dates"
            :key="date"
            class="border-b last:border-b-0"
          >
            <div class="flex flex-wrap items-baseline gap-3 bg-muted/30 px-4 py-2 text-xs">
              <span class="font-medium tabular-nums">{{ formatDateCN(date) }}</span>
              <span class="text-muted-foreground">
                {{ resultsOfDate(batch, date).length }} 人
                <template v-if="summaryOf(resultsOfDate(batch, date)).avg !== null">
                  · 平均 {{ summaryOf(resultsOfDate(batch, date)).avg }} 分
                </template>
                · 待关注 {{ summaryOf(resultsOfDate(batch, date)).flagged }} 人
                <template v-if="summaryOf(resultsOfDate(batch, date)).uncited">
                  · 未引用 {{ summaryOf(resultsOfDate(batch, date)).uncited }} 个
                </template>
              </span>
            </div>

            <Table>
              <TableHeader>
                <TableRow class="hover:bg-transparent">
                  <TableHead class="h-9 w-[8rem]">成员</TableHead>
                  <TableHead class="h-9 w-[4.5rem]">符合度</TableHead>
                  <TableHead class="h-9">判定分布</TableHead>
                  <TableHead class="h-9 w-[5.5rem]">工时</TableHead>
                  <TableHead class="h-9 w-[5.5rem]">未引用</TableHead>
                  <TableHead class="h-9 w-[4.5rem]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow
                  v-for="item in resultsOfDate(batch, date)"
                  :key="item.memberId"
                  class="cursor-pointer"
                  @click="router.push({ name: 'result', params: { date: item.date, memberId: item.memberId } })"
                >
                  <TableCell class="font-medium">{{ item.memberName }}</TableCell>
                  <TableCell>
                    <span
                      v-if="item.summary.checkedHours > 0"
                      :class="cn('font-semibold tabular-nums', scoreClass(item.summary.score))"
                    >
                      {{ item.summary.score }}
                    </span>
                    <span v-else class="text-muted-foreground">—</span>
                  </TableCell>
                  <TableCell>
                    <div class="flex flex-wrap items-center gap-1">
                      <VerdictBadge
                        v-for="e in item.entries.filter(en => en.verdict !== 'matched').slice(0, 4)"
                        :key="e.entryId"
                        :verdict="e.verdict"
                        compact
                      />
                      <span
                        v-if="!item.entries.length"
                        class="text-xs text-muted-foreground"
                      >
                        无日报条目
                      </span>
                      <span
                        v-else-if="!item.entries.some(en => en.verdict !== 'matched')"
                        class="text-xs text-muted-foreground"
                      >
                        全部一致
                      </span>
                    </div>
                  </TableCell>
                  <TableCell class="tabular-nums text-muted-foreground">
                    {{ item.summary.totalHours }}h
                  </TableCell>
                  <TableCell class="tabular-nums">
                    <span :class="item.orphanCommits.length ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'">
                      {{ item.orphanCommits.length || '—' }}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ChevronRightIcon :size="14" class="text-muted-foreground" />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>

    <Dialog v-model:open="confirmClearOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>清空全部检查历史？</DialogTitle>
        </DialogHeader>
        <p class="text-sm leading-relaxed text-muted-foreground">
          所有批次的检查结果都会被删除，
          <strong class="font-medium text-foreground">无法撤销</strong>。
          项目、人员和配置不受影响，但已经生成的结论不会保留。
        </p>
        <DialogFooter>
          <Button variant="outline" @click="confirmClearOpen = false">
            取消
          </Button>
          <Button variant="destructive" @click="clearAll">
            清空
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
