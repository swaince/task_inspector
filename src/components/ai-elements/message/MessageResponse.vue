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
  /**
   * 内容还在流式追加。
   *
   * 报告这类「生成完才渲染」的内容不要开，否则末尾会常驻一个加载圈；
   * 对话里开着才能看到逐段生成的 Markdown。生成结束后调用方要立刻关掉。
   */
  streaming?: boolean
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
    streaming 模式会在内容末尾显示生成中的加载圈，适合对话的实时追加；
    报告是一次性生成完再渲染的，传 false 走 static，不出现这个「还在生成」的提示。
  -->
  <Markdown
    :content="md"
    :extensions="extensions"
    :mode="streaming ? 'streaming' : 'static'"
    :class="
      cn(
        'size-full [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!',
        props.class,
      )
    "
    v-bind="$attrs"
  />
</template>
