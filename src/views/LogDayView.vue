<script setup lang="ts">
import type { DailyReport } from '@/core/domain/types'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  ClockIcon,
  SearchIcon,
} from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useReportStore } from '@/core/store/reports'
import { formatDateCN, formatDateTime } from '@/lib/format'

/**
 * 日志中间页：某一天所有人的日报卡片。
 *
 * 列表页只看得到「这一天有多少人、多少条」，真正判断某个人写了什么
 * 需要把当天的项目列表和内容摊开。卡片作为中间层，再点一次进入单人详情。
 */
const route = useRoute()
const router = useRouter()
const reportStore = useReportStore()

const date = computed(() => String(route.params.date))
const scan = ref('')

const reports = computed(() => reportStore.cache[date.value] ?? [])
const filtered = computed(() => {
  const keyword = scan.value.trim().toLowerCase()
  if (!keyword)
    return reports.value
  return reports.value.filter(report =>
    report.memberName.toLowerCase().includes(keyword)
    || report.entries.some(entry =>
      entry.projectName.toLowerCase().includes(keyword)
      || entry.content.toLowerCase().includes(keyword),
    ),
  )
})

const totalHours = computed(() => reports.value.reduce((sum, report) => sum + report.totalHours, 0))
const entryCount = computed(() => reports.value.reduce((sum, report) => sum + report.entries.length, 0))
const lastSyncedAt = computed(() => {
  const times = reports.value.map(report => report.syncedAt).filter(Boolean) as string[]
  return times.length ? times.sort().reverse()[0] : null
})

function projectSummary(report: DailyReport) {
  return report.entries.slice(0, 3).map(entry => `${entry.projectName} ${entry.hours}h`)
}

function contentPreview(report: DailyReport) {
  const text = report.entries.map(entry => entry.content).filter(Boolean).join('；')
  return text.length > 120 ? `${text.slice(0, 120)}…` : text || '（没有填写工作内容）'
}

function openReport(report: DailyReport) {
  void router.push({
    name: 'log-detail',
    params: { date: date.value, memberId: report.memberId },
  })
}

onMounted(async () => {
  await reportStore.load()
})
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <div class="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" class="text-xs" @click="router.push({ name: 'logs' })">
          <ArrowLeftIcon :size="13" class="mr-1.5" />
          返回日志
        </Button>
        <div class="min-w-0">
          <h2 class="text-sm font-medium">{{ formatDateCN(date) }} 的日志</h2>
          <p class="text-[11px] text-muted-foreground">
            {{ reports.length }} 人，{{ entryCount }} 条项目记录，合计 {{ Math.round(totalHours * 10) / 10 }}h
            <template v-if="lastSyncedAt"> · 最近同步 {{ formatDateTime(lastSyncedAt) }}</template>
          </p>
        </div>
        <div class="ml-auto flex items-center gap-1.5">
          <SearchIcon :size="13" class="text-muted-foreground" />
          <Input v-model="scan" placeholder="按人员、项目或内容筛选" class="h-8 w-56 text-xs" />
        </div>
      </div>

      <div v-if="filtered.length" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Card
          v-for="report in filtered"
          :key="report.memberId"
          class="group cursor-pointer gap-0 py-0 transition-colors hover:border-primary/40"
          @click="openReport(report)"
        >
          <CardContent class="space-y-2.5 p-4">
            <div class="flex items-start gap-2">
              <div class="min-w-0">
                <div class="truncate text-sm font-medium">{{ report.memberName }}</div>
                <div class="mt-0.5 text-[10px] text-muted-foreground">
                  {{ report.entries.length }} 个项目
                  <template v-if="report.syncedAt"> · 同步于 {{ formatDateTime(report.syncedAt) }}</template>
                </div>
              </div>
              <Badge variant="secondary" class="ml-auto shrink-0 text-[10px] tabular-nums">
                {{ Math.round(report.totalHours * 10) / 10 }}h
              </Badge>
            </div>

            <div class="flex flex-wrap gap-1">
              <span
                v-for="item in projectSummary(report)"
                :key="item"
                class="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {{ item }}
              </span>
              <span v-if="report.entries.length > 3" class="px-1 text-[10px] text-muted-foreground">
                另 {{ report.entries.length - 3 }} 个
              </span>
              <span v-if="!report.entries.length" class="text-[10px] text-muted-foreground">
                没有项目条目
              </span>
            </div>

            <p class="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
              {{ contentPreview(report) }}
            </p>

            <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
              <ClockIcon :size="10" />
              查看项目列表与完整内容
              <ChevronRightIcon :size="11" class="ml-auto transition-transform group-hover:translate-x-0.5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card v-else class="border-dashed py-10">
        <CardContent class="flex flex-col items-center gap-2 text-center">
          <p class="text-sm text-muted-foreground">
            {{ reports.length ? '没有匹配的日志' : '这一天没有日报记录' }}
          </p>
          <Button variant="outline" size="sm" class="text-xs" @click="router.push({ name: 'logs' })">
            去日志同步页
            <ArrowRightIcon :size="12" class="ml-1.5" />
          </Button>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
