<script setup lang="ts">
import { nextTick, onMounted, watch } from 'vue'
import { useStickToBottomContext } from 'vue-stick-to-bottom'

/**
 * 会话的滚动跟随。
 *
 * StickToBottom 能处理「内容变高时贴着底部」，但它首次挂载时 Markdown 还没渲染完，
 * 等表格和代码块把内容撑开，滚动位置可能已经停在顶部了。这里在挂载后和新增消息时
 * 主动滚一次；流式追加的中间过程交给 StickToBottom，不强拉用户的滚动位置。
 */
const props = defineProps<{ trigger: number }>()

const { scrollToBottom } = useStickToBottomContext()

onMounted(async () => {
  await nextTick()
  // 等 Markdown/表格完成首帧布局再滚，否则会在内容变高之前就滚到底
  setTimeout(() => scrollToBottom(), 80)
})

watch(() => props.trigger, async () => {
  await nextTick()
  scrollToBottom()
})
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
