<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import ThemeToggle from '@/components/common/ThemeToggle.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { applyTheme } from '@/composables/theme'
import { useSettingsStore } from '@/core/store/settings'
import { useHistoryStore } from '@/core/store/history'
import { useReportStore } from '@/core/store/reports'
import { migrateMappingsToEntities } from '@/core/store/bootstrap'

const route = useRoute()
const settingsStore = useSettingsStore()
const historyStore = useHistoryStore()
const reportStore = useReportStore()

const title = computed(() => (route.meta.title as string | undefined) ?? '研发工作核查')
/** 页头的一句话说明：每个页面只回答一个问题，入口处就说清楚，避免三个分析页混淆 */
const description = computed(() => (route.meta.description as string | undefined) ?? '')

// 设置加载完成或用户在页头切换后立即应用；默认值 auto 与挂载前的行为一致
watch(
  () => settingsStore.settings.appearance.theme,
  theme => applyTheme(theme),
  { immediate: true },
)

onMounted(async () => {
  await Promise.all([
    settingsStore.load(),
    reportStore.load(),
    historyStore.load(),
  ])
  // 旧版把项目/人员放在 settings 的映射里，这里搬成实体（幂等，没有旧数据时什么都不做）
  await migrateMappingsToEntities()
  // 保留期清理放在后台，不阻塞首屏
  void historyStore.prune(settingsStore.settings.retention.keepDays)
})
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-background">
    <AppSidebar />

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="drag-region flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div class="min-w-0">
          <h1 class="text-sm font-medium leading-tight">{{ title }}</h1>
          <p
            v-if="description"
            class="truncate text-xs leading-tight text-muted-foreground"
            :title="description"
          >
            {{ description }}
          </p>
        </div>
        <slot name="header" />

        <div class="ml-auto flex shrink-0 items-center gap-1">
          <ThemeToggle />
        </div>
      </header>

      <Alert
        v-if="settingsStore.error"
        variant="destructive"
        class="mx-5 mt-4 w-auto shrink-0"
      >
        <AlertDescription>{{ settingsStore.error }}</AlertDescription>
      </Alert>

      <main class="min-h-0 flex-1 overflow-hidden">
        <RouterView />
      </main>
    </div>
  </div>
</template>
