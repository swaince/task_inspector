<script setup lang="ts">
import type { ActivityAnalysisKind, ActivityAnalysisSummary } from '@/core/store/activityHistory'
import { computed, onMounted, ref } from 'vue'
import {
  AlertTriangleIcon,
  BarChart3Icon,
  HistoryIcon,
  Loader2Icon,
  Trash2Icon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useActivityHistoryStore } from '@/core/store/activityHistory'
import { formatDateCN, formatDateTime } from '@/lib/format'

/**
 * 分析历史 + 多维统计。
 *
 * 项目活动按「项目 / 月份 / 人员」汇总，人员活动按「人员 / 月份 / 项目」汇总。
 * 历史记录可以重新打开，回到当时的分析结果。
 */
const props = defineProps<{
  kind: ActivityAnalysisKind
}>()

const emit = defineEmits<{
  open: [id: string]
  rerun: [item: ActivityAnalysisSummary]
}>()

const store = useActivityHistoryStore()
const dimension = ref('scope')
const removing = ref<string | null>(null)

const dimensions = computed(() => props.kind === 'project'
  ? [
      { key: 'scope', label: '按项目' },
      { key: 'month', label: '按月份' },
      { key: 'member', label: '按人员' },
    ]
  : [
      { key: 'scope', label: '按人员' },
      { key: 'month', label: '按月份' },
      { key: 'project', label: '按项目' },
    ])

const items = computed(() => props.kind === 'project' ? store.projectItems : store.memberItems)

interface Bucket {
  key: string
  label: string
  analyses: number
  commits: number
  reportedHours: number
  effectiveLow: number
  effectiveHigh: number
  hasEffective: boolean
}

const buckets = computed<Bucket[]>(() => {
  const map = new Map<string, Bucket>()
  const ensure = (key: string, label: string): Bucket => {
    const hit = map.get(key) ?? {
      key,
      label,
      analyses: 0,
      commits: 0,
      reportedHours: 0,
      effectiveLow: 0,
      effectiveHigh: 0,
      hasEffective: false,
    }
    map.set(key, hit)
    return hit
  }
  const add = (bucket: Bucket, item: ActivityAnalysisSummary) => {
    bucket.analyses++
    bucket.commits += item.commits
    bucket.reportedHours += item.reportedHours
    bucket.effectiveLow += item.effectiveLow
    bucket.effectiveHigh += item.effectiveHigh
    bucket.hasEffective = true
  }

  for (const item of items.value) {
    if (dimension.value === 'scope') {
      add(ensure(item.scopeId, item.scopeName), item)
      continue
    }
    if (dimension.value === 'month') {
      const month = item.to.slice(0, 7)
      add(ensure(month, month), item)
      continue
    }

    const facets = dimension.value === 'member' ? item.facets.members : item.facets.projects
    const seen = new Set<string>()
    for (const facet of facets) {
      if (seen.has(facet.name))
        continue
      seen.add(facet.name)
      const bucket = ensure(facet.name, facet.name)
      bucket.analyses++
      bucket.commits += facet.commits
      bucket.reportedHours += facet.reportedHours
    }
  }

  return [...map.values()].sort((a, b) => b.commits - a.commits)
})

function round1(value: number) {
  return Math.round(value * 10) / 10
}

function rangeText(item: ActivityAnalysisSummary) {
  return `${formatDateCN(item.from)} ~ ${formatDateCN(item.to)}`
}

async function remove(id: string) {
  removing.value = id
  try {
    await store.remove(id)
  }
  finally {
    removing.value = null
  }
}

onMounted(() => store.load())
</script>

<template>
  <div class="space-y-4">
    <Card class="gap-0 py-4">
      <CardHeader class="px-4 pb-3">
        <CardTitle class="flex items-center gap-1.5 text-sm">
          <BarChart3Icon :size="14" class="text-muted-foreground" />
          多维统计
        </CardTitle>
        <CardDescription class="text-xs">
          基于已保存的分析记录汇总。同一区间重复分析会覆盖，不会重复累加。
          「按人员/按项目」拆分的记录只统计提交和申报工时，证据工时以整体分析为准。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 px-4">
        <div class="flex flex-wrap gap-1.5">
          <Button
            v-for="option in dimensions"
            :key="option.key"
            size="sm"
            class="text-xs"
            :variant="dimension === option.key ? 'secondary' : 'ghost'"
            @click="dimension = option.key"
          >
            {{ option.label }}
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{{ dimensions.find(d => d.key === dimension)?.label ?? '维度' }}</TableHead>
              <TableHead class="w-24 text-right">分析次数</TableHead>
              <TableHead class="w-24 text-right">提交</TableHead>
              <TableHead class="w-28 text-right">申报工时</TableHead>
              <TableHead class="w-32 text-right">有效工时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="bucket in buckets" :key="bucket.key">
              <TableCell class="max-w-[24rem] truncate text-xs">{{ bucket.label }}</TableCell>
              <TableCell class="text-right text-xs tabular-nums">{{ bucket.analyses }}</TableCell>
              <TableCell class="text-right text-xs tabular-nums">{{ bucket.commits }}</TableCell>
              <TableCell class="text-right text-xs tabular-nums">{{ round1(bucket.reportedHours) }}h</TableCell>
              <TableCell class="text-right text-xs tabular-nums">
                {{ bucket.hasEffective ? `${round1(bucket.effectiveLow)}–${round1(bucket.effectiveHigh)}h` : '—' }}
              </TableCell>
            </TableRow>
            <TableRow v-if="!buckets.length">
              <TableCell colspan="5" class="py-8 text-center text-xs text-muted-foreground">
                还没有已保存的分析记录。
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Card class="gap-0 py-4">
      <CardHeader class="px-4 pb-3">
        <CardTitle class="flex items-center gap-1.5 text-sm">
          <HistoryIcon :size="14" class="text-muted-foreground" />
          分析历史
        </CardTitle>
        <CardDescription class="text-xs">
          每次扫描一个{{ kind === 'project' ? '项目' : '人员' }}一段时间都会保存一条记录；同一区间重新分析会覆盖旧记录。
        </CardDescription>
      </CardHeader>
      <CardContent class="px-4">
        <Alert v-if="store.error" variant="destructive">
          <AlertTriangleIcon :size="14" />
          <AlertDescription>{{ store.error }}</AlertDescription>
        </Alert>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{{ kind === 'project' ? '项目' : '人员' }}</TableHead>
              <TableHead class="w-56">区间</TableHead>
              <TableHead class="w-40">分析时间</TableHead>
              <TableHead class="w-20 text-right">提交</TableHead>
              <TableHead class="w-24 text-right">申报</TableHead>
              <TableHead class="w-28 text-right">有效工时</TableHead>
              <TableHead class="w-32 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="item in items" :key="item.id">
              <TableCell class="max-w-[20rem] truncate text-xs">
                {{ item.scopeName }}
                <span
                  v-if="item.stale"
                  class="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-700 dark:text-amber-400"
                  :title="item.staleReason ?? '日志同步发现这个区间有变更'"
                >
                  日志已更新
                </span>
              </TableCell>
              <TableCell class="text-xs tabular-nums">{{ rangeText(item) }}</TableCell>
              <TableCell class="text-xs tabular-nums text-muted-foreground">{{ formatDateTime(item.analyzedAt) }}</TableCell>
              <TableCell class="text-right text-xs tabular-nums">{{ item.commits }}</TableCell>
              <TableCell class="text-right text-xs tabular-nums">{{ round1(item.reportedHours) }}h</TableCell>
              <TableCell class="text-right text-xs tabular-nums">
                {{ round1(item.effectiveLow) }}–{{ round1(item.effectiveHigh) }}h
              </TableCell>
              <TableCell class="text-right">
                <Button
                  v-if="item.stale"
                  variant="secondary"
                  size="sm"
                  class="text-xs"
                  @click="emit('rerun', item)"
                >
                  重新分析
                </Button>
                <Button v-else variant="ghost" size="sm" class="text-xs" @click="emit('open', item.id)">
                  查看
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="text-xs text-destructive"
                  :disabled="removing === item.id"
                  @click="remove(item.id)"
                >
                  <Loader2Icon v-if="removing === item.id" :size="11" class="animate-spin" />
                  <Trash2Icon v-else :size="11" />
                </Button>
              </TableCell>
            </TableRow>
            <TableRow v-if="!items.length">
              <TableCell colspan="7" class="py-8 text-center text-xs text-muted-foreground">
                还没有分析历史。完成一次{{ kind === 'project' ? '项目' : '人员' }}分析后会自动保存。
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  </div>
</template>
