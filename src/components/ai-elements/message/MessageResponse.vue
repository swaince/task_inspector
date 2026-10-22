<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { computed, useSlots } from 'vue'
import { Markdown } from 'vue-stream-markdown'
import { useMarkdownExtensions } from './useMarkdownExtensions'
import 'vue-stream-markdown/index.css'
import 'katex/dist/katex.min.css'

interface Props {
  content?: string
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()

const slots = useSlots()
const slotContent = computed<string | undefined>(() => {
  const nodes = slots.default?.()
  if (!Array.isArray(nodes)) {
    return undefined
  }
  let text = ''
  for (const node of nodes) {
    if (typeof node.children === 'string')
      text += node.children
  }
  return text || undefined
})

const md = computed(() => (slotContent.value ?? props.content ?? '') as string)

const { extensions } = useMarkdownExtensions()
</script>

<template>
  <!--
    mode="static" 是必须的：默认的 streaming 模式会在内容末尾常驻一个加载转圈，
    报告是一次性生成完再渲染的，不该出现这个「还在生成」的提示。
  -->
  <Markdown
    :content="md"
    :extensions="extensions"
    mode="static"
    :class="
      cn(
        'size-full [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!',
        props.class,
      )
    "
    v-bind="$attrs"
  />
</template>
