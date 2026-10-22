<script setup lang="ts">
import type { Component } from 'vue'
import type { ThemeMode } from '@/core/config/settings'
import { MonitorIcon, MoonIcon, SunIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { applyTheme } from '@/composables/theme'
import { useSettingsStore } from '@/core/store/settings'

/**
 * 主题切换：跟随系统 → 浅色 → 深色。
 *
 * 放在页头而不是设置里，是因为它影响的是整个界面的可读性，
 * 用户在任何页面都可能想切；切换立即生效并落盘。
 */

const settingsStore = useSettingsStore()

const order: ThemeMode[] = ['auto', 'light', 'dark']

const mode = computed<ThemeMode>(() => settingsStore.settings.appearance?.theme ?? 'auto')

const meta = computed<{ icon: Component, label: string }>(() => ({
  auto: { icon: MonitorIcon, label: '跟随系统' },
  light: { icon: SunIcon, label: '浅色' },
  dark: { icon: MoonIcon, label: '深色' },
}[mode.value]))

async function cycle() {
  const next = order[(order.indexOf(mode.value) + 1) % order.length] ?? 'auto'
  applyTheme(next)
  await settingsStore.patch((draft) => {
    draft.appearance.theme = next
  })
}
</script>

<template>
  <Button
    variant="ghost"
    size="sm"
    class="no-drag px-2 text-xs text-muted-foreground"
    :title="`主题：${meta.label}（点击切换）`"
    :aria-label="`主题：${meta.label}，点击切换`"
    @click="cycle"
  >
    <component :is="meta.icon" :size="14" />
    <span class="ml-1.5 hidden lg:inline">{{ meta.label }}</span>
  </Button>
</template>
