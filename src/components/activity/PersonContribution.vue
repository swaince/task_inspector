<script setup lang="ts">
import { computed } from 'vue'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/**
 * 人员投入对比：同一项目里谁的提交多、谁日报没写。
 *
 * 「有提交未申报」按天计，不是按条：一天里提交十次但没写日报，仍然是一天没申报。
 */
interface PersonRow {
  key: string
  name: string
  unmatched: boolean
  commits: number
  activeDays: number
  hours: number
  missingDays: number
}

const props = defineProps<{
  people: PersonRow[]
}>()

const rows = computed(() => props.people)
const maxCommits = computed(() => Math.max(1, ...rows.value.map(p => p.commits)))

function barWidth(commits: number) {
  return `${(commits / maxCommits.value) * 100}%`
}
</script>

<template>
  <div class="table-expand overflow-x-auto">
    <Table>
      <TableHeader>
        <TableRow class="hover:bg-transparent">
          <TableHead class="h-8 min-w-[9rem]">人员</TableHead>
          <TableHead class="h-8 min-w-[10rem]">提交</TableHead>
          <TableHead class="h-8 w-24 text-right">活跃天数</TableHead>
          <TableHead class="h-8 w-24 text-right">申报工时</TableHead>
          <TableHead class="h-8 w-32 text-right">有提交未申报</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="person in rows" :key="person.key">
          <TableCell class="py-2">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-xs font-medium" :title="person.name">{{ person.name }}</span>
              <span
                v-if="person.unmatched"
                class="shrink-0 rounded border border-amber-500/40 px-1 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
                title="提交作者没能匹配到人员实体，可能是 Git 身份没配全"
              >
                未匹配
              </span>
            </div>
          </TableCell>

          <TableCell class="py-2">
            <div class="flex items-center gap-2">
              <div class="h-1.5 w-24 shrink-0 rounded-full bg-muted/70">
                <div
                  class="h-full rounded-full"
                  :style="{ width: barWidth(person.commits), backgroundColor: 'var(--primary)' }"
                />
              </div>
              <span class="text-xs tabular-nums">{{ person.commits }}</span>
            </div>
          </TableCell>

          <TableCell class="text-right text-xs tabular-nums">{{ person.activeDays }}</TableCell>
          <TableCell class="text-right text-xs tabular-nums">{{ person.hours }}h</TableCell>
          <TableCell class="text-right text-xs tabular-nums">
            <span :class="person.missingDays ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'">
              {{ person.missingDays ? `${person.missingDays} 天` : '—' }}
            </span>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
