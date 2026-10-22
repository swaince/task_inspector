<script setup lang="ts">
import type { Component } from 'vue'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  label: string
  value: string | number
  hint?: string
  icon?: Component
  /** 数值语义色，缺省用前景色 */
  tone?: 'default' | 'good' | 'warn' | 'bad'
  class?: string
}>(), {
  tone: 'default',
})

const toneClass: Record<string, string> = {
  default: 'text-foreground',
  good: 'text-emerald-600 dark:text-emerald-500',
  warn: 'text-amber-600 dark:text-amber-500',
  bad: 'text-red-600 dark:text-red-500',
}
</script>

<template>
  <Card :class="cn('gap-0 py-4', props.class)">
    <CardContent class="px-4">
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <component :is="props.icon" v-if="props.icon" :size="13" />
        <span>{{ props.label }}</span>
      </div>
      <div :class="cn('mt-1.5 text-2xl font-semibold tabular-nums', toneClass[props.tone])">
        {{ props.value }}
      </div>
      <div v-if="props.hint" class="mt-1 text-[11px] leading-tight text-muted-foreground">
        {{ props.hint }}
      </div>
    </CardContent>
  </Card>
</template>
