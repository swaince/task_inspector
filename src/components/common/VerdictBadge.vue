<script setup lang="ts">
import type { VerdictLevel } from '@/core/domain/types'
import { computed } from 'vue'
import { verdictMeta } from '@/core/domain/verdict'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  verdict: VerdictLevel
  /** 紧凑模式用于列表行内 */
  compact?: boolean
  /** 悬浮提示，缺省用档位本身的说明 */
  title?: string
  class?: string
}>(), {
  compact: false,
})

const meta = computed(() => verdictMeta(props.verdict))
</script>

<template>
  <span
    :class="cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-md border font-medium',
      props.compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs',
      props.class,
    )"
    :style="{
      color: meta.color,
      borderColor: `color-mix(in oklab, ${meta.color} 35%, transparent)`,
      backgroundColor: `color-mix(in oklab, ${meta.color} 12%, transparent)`,
    }"
    :title="props.title ?? meta.description"
  >
    <span class="size-1.5 rounded-full" :style="{ backgroundColor: meta.color }" />
    {{ meta.label }}
  </span>
</template>
