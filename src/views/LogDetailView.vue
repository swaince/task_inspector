<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowLeftIcon,
  ClockIcon,
  Loader2Icon,
  RefreshCwIcon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useMemberStore } from '@/core/store/members'
import { useReportStore } from '@/core/store/reports'
import { formatDateCN, formatDateTime } from '@/lib/format'

/**
 * 单人单日日志详情：这一天报的所有项目、工时和完整内容。
 *
 * 中间页负责「这一天有哪些人」，这里回答「这个人具体报了什么」，
 * 并提供只更新这个人的强制同步入口。
 */
const route = useRoute()
const router = useRouter()
const reportStore = useReportStore()
const memberStore = useMemberStore()

const date = computed(() => String(route.params.date))
const memberId = computed(() => String(route.params.memberId))
const busy = ref(false)
const message = ref<string | null>(null)

const report = computed(() =>
  reportStore.cache[date.value]?.find(item => item.memberId === memberId.value) ?? null,
)

const member = computed(() =>
  memberStore.items.find(item =>
    item.reportMemberId === memberId.value || item.id === memberId.value,
  ) ?? null,
)

const memberName = computed(() => report.value?.memberName ?? member.value?.name ?? memberId.value)
const totalHours = computed(() => report.value?.totalHours ?? 0)
const entryCount = computed(() => report.value?.entries.length ?? 0)

async function forceUpdate() {
  if (busy.value)
    return
  busy.value = true
  message.value = null
  try {
    const result = await reportStore.forceMemberDay(memberId.value, memberName.value, date.value)
    message.value = result.found
      ? '已从日志中心更新这一天的日报'
      : '日志中心已经没有这一天的日报，本地记录已清除'
  }
  catch (err) {
    message.value = `强制更新失败：${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    busy.value = false
  }
}

onMounted(async () => {
  await Promise.all([reportStore.load(), memberStore.load()])
})
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <div class="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          class="text-xs"
          @click="router.push({ name: 'log-day', params: { date } })"
        >
          <ArrowLeftIcon :size="13" class="mr-1.5" />
          返回 {{ formatDateCN(date) }}
        </Button>
        <div class="min-w-0">
          <h2 class="text-sm font-medium">{{ memberName }} · {{ formatDateCN(date) }}</h2>
          <p class="text-[11px] text-muted-foreground">
            {{ entryCount }} 个项目，合计 {{ Math.round(totalHours * 10) / 10 }}h
            <template v-if="report?.syncedAt"> · 同步于 {{ formatDateTime(report.syncedAt) }}</template>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          class="ml-auto text-xs"
          :disabled="busy"
          @click="forceUpdate"
        >
          <Loader2Icon v-if="busy" :size="12" class="mr-1.5 animate-spin" />
          <RefreshCwIcon v-else :size="12" class="mr-1.5" />
          强制更新这一天
        </Button>
      </div>

      <Alert v-if="message">
        <AlertDescription>{{ message }}</AlertDescription>
      </Alert>

      <template v-if="report">
        <div class="grid gap-3 lg:grid-cols-2">
          <Card v-for="entry in report.entries" :key="entry.id" class="gap-0 py-0">
            <CardHeader class="border-b px-4 py-3">
              <CardTitle class="flex flex-wrap items-center gap-2 text-sm">
                <span>{{ entry.projectName }}</span>
                <Badge variant="secondary" class="text-[10px] tabular-nums">{{ entry.hours }}h</Badge>
                <span v-if="entry.projectCode" class="font-mono text-[10px] text-muted-foreground">
                  {{ entry.projectCode }}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent class="space-y-2 px-4 py-3">
              <p class="text-xs leading-relaxed whitespace-pre-wrap break-words">
                {{ entry.content || '（未填写工作内容）' }}
              </p>
              <div v-if="entry.taskRefs?.length" class="flex flex-wrap gap-1">
                <span
                  v-for="task in entry.taskRefs"
                  :key="task"
                  class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {{ task }}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card v-if="!report.entries.length" class="border-dashed py-8">
          <CardContent class="text-center text-xs text-muted-foreground">
            这一天有日志记录，但没有项目条目。
          </CardContent>
        </Card>

        <Card class="py-3">
          <CardContent class="flex flex-wrap items-center gap-3 px-4 text-[11px] text-muted-foreground">
            <span class="inline-flex items-center gap-1">
              <ClockIcon :size="11" />
              日报条目 {{ entryCount }} 条
            </span>
            <span>合计 {{ Math.round(totalHours * 10) / 10 }}h</span>
            <span v-if="report.syncedAt">本地同步于 {{ formatDateTime(report.syncedAt) }}</span>
            <span v-if="member?.name" class="ml-auto">人员实体：{{ member.name }}</span>
          </CardContent>
        </Card>
      </template>

      <Card v-else class="border-dashed py-10">
        <CardContent class="space-y-2 text-center">
          <p class="text-sm text-muted-foreground">本地还没有这一天的日志</p>
          <p class="text-[11px] text-muted-foreground">
            可以点右上角「强制更新这一天」直接从日志中心拉取。
          </p>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
