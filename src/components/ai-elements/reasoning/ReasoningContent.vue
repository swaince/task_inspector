<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { computed, useSlots } from 'vue'
import { Markdown } from 'vue-stream-markdown'
import { useMarkdownExtensions } from '../message/useMarkdownExtensions'
import 'vue-stream-markdown/index.css'
import 'katex/dist/katex.min.css'

interface Props {
  class?: HTMLAttributes['class']
  content: string
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
  <CollapsibleContent
    :class="cn(
      'mt-4 text-sm',
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2',
      'data-[state=open]:slide-in-from-top-2 text-muted-foreground',
      'outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      props.class,
    )"
  >
    <!--
      实时推理文本会高频追加；streaming 模式会再挂一个常驻加载动画并做增量解析，
      检查一次要处理几十条，主线程很容易被拖住。这里按普通文本渲染，
      Reasoning 自己的 is-streaming 已经负责表达「还在生成」。
    -->
    <Markdown :content="md" :extensions="extensions" mode="static" />
  </CollapsibleContent>
</template>
