<script setup lang="ts">
import type { GitCommit } from '@/core/domain/types'
import { computed } from 'vue'
import { CalendarClockIcon, GitCommitHorizontalIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateCN } from '@/lib/format'

/**
 * 日报核对窗口详情。
 *
 * 回答三个问题：窗口有多大、窗口里每天有没有日报、窗口里有哪些提交。
 */
const props = defineProps<{
  open: boolean
  title: string
  offset: number
  from?: string
  to?: string
  dates?: string[]
  commits: GitCommit[]
  logs: Array<{ date: string, content: string }>
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const dates = computed(() => props.dates?.length
  ? props.dates
  : [props.from, props.to].filter(Boolean) as string[])

const commitsByDate = computed(() => {
  const map = new Map<string, GitCommit[]>()
  for (const commit of props.commits) {
    const date = commit.authoredDate.slice(0, 10)
    const list = map.get(date) ?? []
    list.push(commit)
    map.set(date, list)
  }
  return map
})

const logsByDate = computed(() => new Map(props.logs.map(log => [log.date, log.content])))

const commitCount = computed(() => props.commits.length)
const logDays = computed(() => new Set(props.logs.map(log => log.date)).size)

function weekday(date: string) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T00:00:00`).getDay()]
}
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-sm">
          <CalendarClockIcon :size="15" class="text-muted-foreground" />
          {{ title }}
        </DialogTitle>
        <DialogDescription>
          核对窗口：{{ from }} ~ {{ to }}，前后各最多 {{ offset }} 个工作日（不跨自然月）。
          窗口内 {{ commitCount }} 条提交，{{ logDays }} 天有日报。
        </DialogDescription>
      </DialogHeader>

      <div class="max-h-[60vh] overflow-y-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-28">日期</TableHead>
              <TableHead class="w-20">星期</TableHead>
              <TableHead>当天日报</TableHead>
              <TableHead class="w-1/3">当天提交</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="date in dates" :key="date">
              <TableCell class="text-xs tabular-nums">{{ formatDateCN(date) }}</TableCell>
              <TableCell class="text-xs text-muted-foreground">{{ weekday(date) }}</TableCell>
              <TableCell class="text-xs leading-relaxed whitespace-pre-wrap break-words">
                {{ logsByDate.get(date) || '—' }}
              </TableCell>
              <TableCell class="text-xs">
                <template v-if="commitsByDate.get(date)?.length">
                  <ul class="space-y-0.5">
                    <li
                      v-for="commit in commitsByDate.get(date)!.slice(0, 4)"
                      :key="commit.id"
                      class="truncate"
                      :title="commit.title"
                    >
                      {{ commit.title }}
                    </li>
                  </ul>
                  <div v-if="commitsByDate.get(date)!.length > 4" class="mt-0.5 text-[10px] text-muted-foreground">
                    另 {{ commitsByDate.get(date)!.length - 4 }} 条
                  </div>
                </template>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="outline" class="text-[10px]">窗口 {{ dates.length }} 天</Badge>
        <Badge variant="outline" class="text-[10px]">提交 {{ commitCount }} 条</Badge>
        <span class="inline-flex items-center gap-1">
          <GitCommitHorizontalIcon :size="11" />
          提交按作者时间归到日期，用于核对窗口内是否有可自证的产出
        </span>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">
          关闭
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
