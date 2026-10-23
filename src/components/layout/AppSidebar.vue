<script setup lang="ts">
import type { Component } from 'vue'
import {
  ActivityIcon,
  ClipboardCheckIcon,
  FolderGit2Icon,
  HistoryIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  SparklesIcon,
  UsersIcon,
  UsersRoundIcon,
} from '@lucide/vue'
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { cn } from '@/lib/utils'
import { isDesktop } from '@/core/bridge'
import { useSettingsStore } from '@/core/store/settings'
import { useRunnerStore } from '@/core/store/runner'

const route = useRoute()
const settingsStore = useSettingsStore()
const runner = useRunnerStore()

interface NavItem {
  name: string
  label: string
  icon: Component
  hint?: string
}

const items: NavItem[] = [
  { name: 'dashboard', label: '概览', icon: LayoutDashboardIcon },
  { name: 'inspect', label: '执行检查', icon: ClipboardCheckIcon },
  { name: 'history', label: '检查历史', icon: HistoryIcon },
  { name: 'assistant', label: '应用助手', icon: SparklesIcon },
  { name: 'project-activity', label: '项目活动', icon: ActivityIcon },
  { name: 'member-activity', label: '人员活动', icon: UsersRoundIcon },
  { name: 'projects', label: '项目', icon: FolderGit2Icon },
  { name: 'members', label: '人员', icon: UsersIcon },
  { name: 'settings', label: '设置', icon: SettingsIcon },
]

// 详情页挂在哪条线下面由路由自己声明（meta.activeName），没有就按路由名匹配
const activeName = computed(() =>
  (route.meta.activeName as string | undefined)
  ?? (route.name === 'result' ? 'history' : route.name),
)

const gitlabReady = computed(() => settingsStore.configured)
const llmReady = computed(() => settingsStore.llmConfigured)
</script>

<template>
  <aside class="drag-region flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
    <div class="flex h-14 items-center gap-2 px-4">
      <div class="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <ClipboardCheckIcon :size="16" />
      </div>
      <div class="min-w-0">
        <div class="truncate text-sm font-medium">研发工作核查</div>
        <div class="truncate text-[11px] text-muted-foreground">日报 × 代码提交一致性</div>
      </div>
    </div>

    <nav class="no-drag flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
      <template v-for="(item, index) in items" :key="item.name">
        <div v-if="index === 4 || index === 6" class="my-1 h-px bg-sidebar-border/70" />
        <RouterLink
          :to="{ name: item.name }"
          :class="
            cn(
              'relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
              activeName === item.name
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
            )
          "
        >
          <component :is="item.icon" :size="16" class="shrink-0" />
          <span class="truncate">{{ item.label }}</span>
          <span
            v-if="item.name === 'inspect' && runner.running"
            class="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
          />
        </RouterLink>
      </template>
    </nav>

    <div class="no-drag space-y-1.5 border-t px-4 py-3 text-[11px] text-muted-foreground">
      <div class="flex items-center gap-1.5">
        <span
          class="size-1.5 rounded-full"
          :class="gitlabReady ? 'bg-emerald-500' : 'bg-amber-500'"
        />
        <span>{{ gitlabReady ? 'GitLab 已配置' : 'GitLab 未配置' }}</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span
          class="size-1.5 rounded-full"
          :class="llmReady ? 'bg-emerald-500' : 'bg-amber-500'"
        />
        <span>{{ llmReady ? '模型已配置' : '模型未配置' }}</span>
      </div>
      <div v-if="!isDesktop()" class="flex items-center gap-1.5 text-amber-600 dark:text-amber-500">
        <span class="size-1.5 rounded-full bg-amber-500" />
        <span>浏览器预览模式</span>
      </div>
    </div>
  </aside>
</template>
