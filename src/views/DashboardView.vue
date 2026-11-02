<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  ActivityIcon,
  ArrowRightIcon,
  BarChart3Icon,
  FileTextIcon,
  UsersRoundIcon,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import StatCard from '@/components/common/StatCard.vue'
import { useActivityHistoryStore } from '@/core/store/activityHistory'
import { formatDateCN, formatDateTime } from '@/lib/format'

/**
 * 分析概览。
 *
 * 执行检查和检查历史下线后，首页改为看「活动分析」：
 * 项目活动、人员活动各自保存了什么、累计覆盖多少，以及最近的分析记录。
 * 多维统计在对应活动页的「分析历史」里。
 */
const router = useRouter()
const history = useActivityHistoryStore()

const projectItems = computed(() => history.projectItems)
const memberItems = computed(() => history.memberItems)

const stats = computed(() => {
  const items = history.items
  return {
    total: items.length,
    projects: new Set(projectItems.value.map(item => item.scopeId)).size,
    members: new Set(memberItems.value.map(item => item.scopeId)).size,
    commits: items.reduce((sum, item) => sum + item.commits, 0),
    reported: round1(items.reduce((sum, item) => sum + item.reportedHours, 0)),
    effectiveLow: round1(items.reduce((sum, item) => sum + item.effectiveLow, 0)),
    effectiveHigh: round1(items.reduce((sum, item) => sum + item.effectiveHigh, 0)),
  }
})

const recent = computed(() => history.items.slice(0, 8))

function round1(value: number) {
  return Math.round(value * 10) / 10
}

function openActivity(kind: 'project' | 'member') {
  void router.push({ name: kind === 'project' ? 'project-activity' : 'member-activity' })
}

onMounted(() => history.load())
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-5 p-5">
      <Card v-if="!history.loading && !history.items.length" class="gap-0 py-8">
        <CardContent class="space-y-4 px-6 text-center">
          <BarChart3Icon :size="28" class="mx-auto text-muted-foreground" />
          <div class="space-y-1">
            <h2 class="text-base font-medium">还没有分析记录</h2>
            <p class="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground">
              现在按「项目活动」和「人员活动」做分析：选一个项目或一个人、一段时间，
              看提交、日报和有效工时。每次分析会自动保存历史，可以回看和按维度汇总。
            </p>
          </div>
          <div class="flex flex-wrap justify-center gap-2">
            <Button @click="openActivity('project')">
              去看项目活动
              <ArrowRightIcon :size="13" class="ml-1.5" />
            </Button>
            <Button variant="outline" @click="openActivity('member')">
              去看人员活动
            </Button>
            <Button variant="outline" @click="router.push({ name: 'logs' })">
              先同步日志
            </Button>
          </div>
        </CardContent>
      </Card>

      <template v-else>
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0">
            <h2 class="text-sm font-medium">分析概览</h2>
            <p class="text-[11px] text-muted-foreground">
              已保存 {{ stats.total }} 次分析，覆盖 {{ stats.projects }} 个项目、{{ stats.members }} 个人
            </p>
          </div>
          <div class="ml-auto flex gap-2">
            <Button variant="outline" size="sm" class="text-xs" @click="openActivity('project')">
              <ActivityIcon :size="12" class="mr-1.5" />
              项目活动
            </Button>
            <Button variant="outline" size="sm" class="text-xs" @click="openActivity('member')">
              <UsersRoundIcon :size="12" class="mr-1.5" />
              人员活动
            </Button>
          </div>
        </div>

        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="分析次数" :value="stats.total" :icon="BarChart3Icon" hint="项目活动 + 人员活动" />
          <StatCard label="覆盖项目" :value="stats.projects" :icon="ActivityIcon" hint="按项目分析过的唯一项目" />
          <StatCard label="覆盖人员" :value="stats.members" :icon="UsersRoundIcon" hint="按人员分析过的唯一人员" />
          <StatCard
            label="申报 / 证据工时"
            :value="`${stats.reported}h`"
            :icon="FileTextIcon"
            :hint="`有效工时 ${stats.effectiveLow}–${stats.effectiveHigh}h`"
          />
        </div>

        <Card class="gap-0 py-4">
          <CardHeader class="flex flex-row items-center gap-2 px-4 pb-2">
            <CardTitle class="text-sm">最近分析</CardTitle>
            <Button variant="ghost" size="sm" class="ml-auto text-xs" @click="openActivity('project')">
              查看全部
              <ArrowRightIcon :size="12" class="ml-1" />
            </Button>
          </CardHeader>
          <CardContent class="px-4">
            <div class="divide-y">
              <button
                v-for="item in recent"
                :key="item.id"
                type="button"
                class="flex w-full flex-wrap items-center gap-2 py-2.5 text-left hover:bg-muted/30"
                @click="openActivity(item.kind)"
              >
                <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {{ item.kind === 'project' ? '项目' : '人员' }}
                </span>
                <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ item.scopeName }}</span>
                <span class="text-[11px] tabular-nums text-muted-foreground">
                  {{ formatDateCN(item.from) }} ~ {{ formatDateCN(item.to) }}
                </span>
                <span class="w-20 text-right text-[11px] tabular-nums text-muted-foreground">
                  {{ item.commits }} 条
                </span>
                <span class="w-28 text-right text-[11px] tabular-nums text-muted-foreground">
                  {{ round1(item.effectiveLow) }}–{{ round1(item.effectiveHigh) }}h
                </span>
                <span class="w-36 text-right text-[10px] tabular-nums text-muted-foreground">
                  {{ formatDateTime(item.analyzedAt) }}
                </span>
              </button>
            </div>
          </CardContent>
        </Card>

        <p class="text-[11px] leading-relaxed text-muted-foreground">
          多维统计（按项目、按人员、按月份）在项目活动 / 人员活动的「分析历史」里；
          同一对象同一区间重新分析会覆盖旧记录，避免重复累加。
        </p>
      </template>

      <Skeleton v-if="history.loading && !history.items.length" class="h-32 w-full" />
    </div>
  </div>
</template>
