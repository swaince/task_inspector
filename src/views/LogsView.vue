<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import DatePicker from '@/components/common/DatePicker.vue'
import MemberPicker from '@/components/common/MemberPicker.vue'
import { dateRange } from '@/core/engine/window'
import { useMemberStore } from '@/core/store/members'
import { useActivityHistoryStore } from '@/core/store/activityHistory'
import { useReportStore } from '@/core/store/reports'
import type { ReportChange } from '@/core/store/reports'
import { dateKeyOffset, formatDateCN, formatDateTime, todayKey } from '@/lib/format'

/**
 * 日志同步。
 *
 * 日报不是只读数据：员工可以补写、修改，甚至删除。本地库只是某个时刻的快照，
 * 所以这里把「同步」做成显式操作：
 * - 增量：按选定区间重拉，只覆盖源系统返回的日期；
 * - 全量：按选定区间重拉，源系统里没有的日期会被清空；
 * - 强制更新：只替换某人某天，不影响同一天其他人。
 */

const reportStore = useReportStore()
const memberStore = useMemberStore()
const activityHistory = useActivityHistoryStore()
const router = useRouter()

const syncOpen = ref(false)
const syncMode = ref<'incremental' | 'full'>('incremental')
const syncFrom = ref(dateKeyOffset(-30))
const syncTo = ref(todayKey())
const forceMemberId = ref('')
const forceFrom = ref(dateKeyOffset(-30))
const forceTo = ref(todayKey())
const forceBusy = ref(false)
const forceMessage = ref<string | null>(null)
const message = ref<string | null>(null)
const scan = ref('')
const changeOpen = ref(false)
const changes = ref<ReportChange[]>([])
const changedDates = ref<string[]>([])
const staleMarked = ref(0)

const dates = computed(() => reportStore.allDates)
const filteredDates = computed(() => {
  const keyword = scan.value.trim()
  if (!keyword)
    return dates.value
  return dates.value.filter(date => date.includes(keyword))
})

/** 这一天最近一次同步时间，取当天各条日报 syncedAt 的最大值 */
function lastSynced(date: string) {
  const list = reportStore.cache[date] ?? []
  const times = list.map(report => report.syncedAt).filter(Boolean) as string[]
  return times.length ? times.sort().reverse()[0] : null
}

function lastSyncedText(date: string) {
  const value = lastSynced(date)
  return value ? formatDateTime(value) : '—'
}

function countOf(date: string) {
  return (reportStore.cache[date] ?? []).filter(report => report.entries.length).length
}

/** 当天有日报的人数（含没有有效条目的记录） */
function detailCount(date: string) {
  return (reportStore.cache[date] ?? []).length
}

function stateText() {
  const state = reportStore.syncState
  const parts: string[] = []
  if (state.lastIncrementalAt)
    parts.push(`增量 ${formatDateTime(state.lastIncrementalAt)}（${state.lastIncrementalFrom} ~ ${state.lastIncrementalTo}）`)
  if (state.lastFullAt)
    parts.push(`全量 ${formatDateTime(state.lastFullAt)}（${state.lastFullFrom} ~ ${state.lastFullTo}）`)
  return parts.length ? parts.join('；') : '还没有同步记录'
}

function openSync(mode: 'incremental' | 'full') {
  syncMode.value = mode
  syncFrom.value = dateKeyOffset(-30)
  syncTo.value = todayKey()
  syncOpen.value = true
}

async function runSync() {
  const mode = syncMode.value
  syncOpen.value = false
  message.value = null
  changes.value = []
  changedDates.value = []
  staleMarked.value = 0
  try {
    const outcome = mode === 'full'
      ? await reportStore.syncFull(syncFrom.value, syncTo.value)
      : await reportStore.syncIncremental(syncFrom.value, syncTo.value)

    changes.value = outcome.changes
    changedDates.value = outcome.changedDates

    if (outcome.changedDates.length) {
      try {
        staleMarked.value = await activityHistory.markStale(
          outcome.changedDates,
          `日志在 ${formatDateTime(outcome.at)} 同步时发现变更`,
        )
      }
      catch {
        // 标记失败不影响同步结果本身
      }
    }

    const added = outcome.changes.filter(item => item.type === 'added').length
    const updated = outcome.changes.filter(item => item.type === 'updated').length
    const removed = outcome.changes.filter(item => item.type === 'removed').length
    message.value = `${mode === 'full' ? '全量' : '增量'}同步完成：${outcome.from} ~ ${outcome.to}，拉取 ${outcome.fetched} 条，写入 ${outcome.writtenDates} 天`
      + (outcome.removedDates ? `，清空 ${outcome.removedDates} 天` : '')
      + (outcome.failedDates.length ? `；${outcome.failedDates.length} 天写入失败` : '')
      + (outcome.changes.length
        ? `；比对到 ${outcome.changes.length} 条变化（新增 ${added} / 更新 ${updated} / 删除 ${removed}），涉及 ${outcome.changedDates.length} 天`
        : '；没有检测到内容变化')
      + (staleMarked.value ? `；已标记 ${staleMarked.value} 条分析历史待重新分析` : '')
  }
  catch (err) {
    message.value = `${mode === 'full' ? '全量' : '增量'}同步失败：${err instanceof Error ? err.message : String(err)}`
  }
}

function openDate(date: string) {
  void router.push({ name: 'log-day', params: { date } })
}

async function forcePicked() {
  const member = memberStore.items.find(item => item.id === forceMemberId.value)
  if (!member || forceBusy.value)
    return
  if (forceFrom.value > forceTo.value) {
    forceMessage.value = '起始日期不能晚于结束日期'
    return
  }

  forceBusy.value = true
  forceMessage.value = null
  const dates = dateRange(forceFrom.value, forceTo.value)
  let found = 0
  let missing = 0
  let failed = 0
  let firstError: string | null = null

  try {
    for (let i = 0; i < dates.length; i++) {
      forceMessage.value = `正在更新 ${member.name} ${dates[i]}（${i + 1}/${dates.length}）…`
      try {
        const result = await reportStore.forceMemberDay(
          member.reportMemberId || member.id,
          member.name,
          dates[i],
        )
        if (result.found)
          found++
        else
          missing++
      }
      catch (err) {
        failed++
        if (!firstError)
          firstError = err instanceof Error ? err.message : String(err)
      }
    }

    forceMessage.value = `已更新 ${member.name} ${formatDateCN(forceFrom.value)} ~ ${formatDateCN(forceTo.value)}：`
      + `${found} 天有日志，${missing} 天源系统无记录`
      + (failed ? `，${failed} 天失败${firstError ? `（${firstError}）` : ''}` : '')
  }
  finally {
    forceBusy.value = false
  }
}

onMounted(async () => {
  await Promise.all([reportStore.load(), memberStore.load()])
  await reportStore.loadSyncState()
})
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <Card class="gap-0 py-4">
        <CardHeader class="px-4 pb-3">
          <CardTitle class="flex items-center gap-1.5 text-sm">
            <CalendarClockIcon :size="14" class="text-muted-foreground" />
            日志同步
          </CardTitle>
          <CardDescription class="text-xs">
            日报可以被员工补写或修改。点「增量同步」或「全量同步」后选择区间，默认最近 30 天；
            增量只覆盖源系统返回的日期，全量还会清空区间内已不存在的日志。
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 px-4">
          <p class="text-[11px] text-muted-foreground">
            {{ stateText() }}
          </p>

          <div class="flex flex-wrap items-center gap-3">
            <Button size="sm" class="text-xs" :disabled="reportStore.syncing" @click="openSync('incremental')">
              <Loader2Icon v-if="reportStore.syncing" :size="12" class="mr-1.5 animate-spin" />
              <RefreshCwIcon v-else :size="12" class="mr-1.5" />
              增量同步
            </Button>
            <Button variant="outline" size="sm" class="text-xs" :disabled="reportStore.syncing" @click="openSync('full')">
              <DownloadIcon :size="12" class="mr-1.5" />
              全量同步
            </Button>
            <span v-if="reportStore.syncProgress" class="text-[11px] text-muted-foreground">
              {{ reportStore.syncProgress.message }}
            </span>
          </div>

          <Progress v-if="reportStore.syncing && reportStore.syncProgress" :model-value="reportStore.syncProgress.total
            ? Math.round((reportStore.syncProgress.done / reportStore.syncProgress.total) * 100)
            : 0" />

          <Alert v-if="reportStore.syncError" variant="destructive">
            <AlertTriangleIcon :size="14" />
            <AlertDescription>{{ reportStore.syncError }}</AlertDescription>
          </Alert>
          <Alert v-else-if="message">
            <AlertDescription>{{ message }}</AlertDescription>
          </Alert>

          <Button
            v-if="changes.length"
            variant="outline"
            size="sm"
            class="text-xs"
            @click="changeOpen = true"
          >
            查看增量变更（{{ changes.length }}）
          </Button>
        </CardContent>
      </Card>

      <Card class="gap-0 py-4">
        <CardHeader class="px-4 pb-3">
          <CardTitle class="text-sm">更新某人某段时间</CardTitle>
          <CardDescription class="text-xs">
            直接问日志中心要这个人这段时间的日志，逐天替换他的记录；即使本地还没有这些天的数据也可以补拉。
            某一天的单独更新仍可以在日期详情里操作。
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 px-4">
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
            <div class="space-y-1.5">
              <Label class="text-xs">人员</Label>
              <MemberPicker v-model="forceMemberId" :members="memberStore.items" placeholder="搜索并选择人员" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">起始日期</Label>
              <DatePicker v-model="forceFrom" class="h-8 text-xs" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">结束日期</Label>
              <DatePicker v-model="forceTo" class="h-8 text-xs" />
            </div>
            <div class="flex items-end">
              <Button size="sm" class="text-xs" :disabled="forceBusy || !forceMemberId" @click="forcePicked">
                <Loader2Icon v-if="forceBusy" :size="12" class="mr-1.5 animate-spin" />
                <RefreshCwIcon v-else :size="12" class="mr-1.5" />
                强制更新
              </Button>
            </div>
          </div>
          <p v-if="forceMessage" class="text-[11px] text-muted-foreground">{{ forceMessage }}</p>
        </CardContent>
      </Card>

      <Card class="gap-0 py-4">
        <CardHeader class="flex flex-row items-center gap-3 px-4 pb-3">
          <div class="min-w-0">
            <CardTitle class="text-sm">已同步的日志</CardTitle>
            <CardDescription class="text-xs">
              共 {{ reportStore.totalReports }} 条记录，覆盖 {{ dates.length }} 天。点日期查看当天全部人员和条目。
            </CardDescription>
          </div>
          <div class="ml-auto flex items-center gap-1.5">
            <SearchIcon :size="13" class="text-muted-foreground" />
            <Input v-model="scan" placeholder="按日期筛选，如 2026-10" class="h-8 w-40 text-xs" />
          </div>
        </CardHeader>
        <CardContent class="px-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="w-40">日期</TableHead>
                <TableHead class="w-24 text-right">人数</TableHead>
                <TableHead class="w-28 text-right">日报条数</TableHead>
                <TableHead>最近同步</TableHead>
                <TableHead class="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="date in filteredDates"
                :key="date"
                class="cursor-pointer"
                title="查看当天所有人的日志"
                @click="openDate(date)"
              >
                <TableCell class="text-xs tabular-nums">{{ formatDateCN(date) }}</TableCell>
                <TableCell class="text-right text-xs tabular-nums">{{ detailCount(date) }}</TableCell>
                <TableCell class="text-right text-xs tabular-nums">{{ countOf(date) }}</TableCell>
                <TableCell class="text-xs tabular-nums text-muted-foreground">
                  {{ lastSyncedText(date) }}
                </TableCell>
                <TableCell class="text-right">
                  <Button variant="ghost" size="sm" class="text-xs" @click="openDate(date)">
                    查看
                  </Button>
                </TableCell>
              </TableRow>
              <TableRow v-if="!filteredDates.length">
                <TableCell colspan="5" class="py-8 text-center text-xs text-muted-foreground">
                  还没有同步过日志。先点上面的「增量同步」或「全量同步」。
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog v-model:open="changeOpen">
        <DialogContent class="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>本次同步的增量变更</DialogTitle>
            <DialogDescription>
              共 {{ changes.length }} 条记录变化，涉及 {{ changedDates.length }} 天
              <template v-if="staleMarked">；{{ staleMarked }} 条分析历史已被标记为待重新分析</template>。
            </DialogDescription>
          </DialogHeader>
          <div class="max-h-[60vh] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-32">日期</TableHead>
                  <TableHead>人员</TableHead>
                  <TableHead class="w-24">变更</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="change in changes.slice(0, 300)" :key="`${change.date}|${change.memberId}|${change.type}`">
                  <TableCell class="text-xs tabular-nums">{{ formatDateCN(change.date) }}</TableCell>
                  <TableCell class="text-xs">{{ change.memberName }}</TableCell>
                  <TableCell class="text-xs">
                    {{ change.type === 'added' ? '新增' : change.type === 'updated' ? '修改' : '删除' }}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <p v-if="changes.length > 300" class="text-[11px] text-muted-foreground">
            只显示前 300 条，其余请按日期到详情页查看。
          </p>
          <DialogFooter>
            <Button variant="outline" @click="changeOpen = false">
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog v-model:open="syncOpen">
        <DialogContent class="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{{ syncMode === 'full' ? '全量同步日志' : '增量同步日志' }}</DialogTitle>
            <DialogDescription>
              {{ syncMode === 'full'
                ? '按区间重新拉取并写入本地库，区间内源系统已没有的日期会被清空。'
                : '按区间重拉并覆盖源系统返回的日期，本地已有的其他日期不会被删除。' }}
              默认最近 30 天，可以按需要调整。
            </DialogDescription>
          </DialogHeader>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-1.5">
              <Label class="text-xs">起始日期</Label>
              <DatePicker v-model="syncFrom" class="h-8 text-xs" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">结束日期</Label>
              <DatePicker v-model="syncTo" class="h-8 text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" @click="syncOpen = false">
              取消
            </Button>
            <Button :disabled="reportStore.syncing" @click="runSync">
              开始{{ syncMode === 'full' ? '全量' : '增量' }}同步
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  </div>
</template>
