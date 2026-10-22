<script setup lang="ts">
import { computed } from 'vue'
import MessageResponse from '@/components/ai-elements/message/MessageResponse.vue'
import ReportChart from './ReportChart.vue'

/**
 * 渲染模型生成的分析报告。
 *
 * 报告里的所有代码围栏都在这里先拆出来，再决定怎么渲染：
 * - 合法的 chart 规格 → 画成 SVG 图表；
 * - mermaid → 旧格式，显示说明，不再交给渲染器（它会在某些环境里一直停在加载态）；
 * - 其它代码块 → 用自己的 pre 渲染。
 *
 * 关键点是**任何围栏都不再进入 markdown/代码预览组件**。那个组件处理未知语言时
 * 会异步加载预览器，环境不满足时表现为永远转圈，而且从界面上看不出原因。
 */
const props = defineProps<{
  content: string
}>()

type Segment =
  | { type: 'md', value: string }
  | { type: 'chart', spec: Record<string, unknown> }
  | { type: 'broken-chart', raw: string }
  | { type: 'mermaid', raw: string }
  | { type: 'code', raw: string, lang: string }

/*
 * 支持 3 个以上反引号或波浪线围栏（模型有时用四个反引号包代码），
 * 结束围栏必须与开始等长。
 */
const FENCE = /(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?[ \t]*\3[ \t]*(?=\n|$)/g

function looksLikeChart(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null
    const obj = parsed as Record<string, unknown>
    return Array.isArray(obj.labels) && Array.isArray(obj.series) ? obj : null
  }
  catch {
    return null
  }
}

const segments = computed<Segment[]>(() => {
  const text = props.content ?? ''
  const out: Segment[] = []
  let last = 0

  for (const match of text.matchAll(FENCE)) {
    const matchStart = match.index + match[1].length
    const info = (match[4] ?? '').trim()
    const lang = (info.split(/\s+/)[0] ?? '').toLowerCase()
    const body = match[5] ?? ''
    const spec = looksLikeChart(body)

    if (matchStart > last) {
      const value = text.slice(last, matchStart)
      if (value.trim())
        out.push({ type: 'md', value })
    }

    if (lang.startsWith('mermaid')) {
      out.push({ type: 'mermaid', raw: body.trim() })
    }
    else if (lang.startsWith('chart') || spec) {
      out.push(spec ? { type: 'chart', spec } : { type: 'broken-chart', raw: body.trim() })
    }
    else {
      out.push({ type: 'code', raw: body, lang })
    }

    last = match.index + match[0].length
  }

  if (last < text.length) {
    const value = text.slice(last)
    if (value.trim())
      out.push({ type: 'md', value })
  }

  return out
})
</script>

<template>
  <div class="space-y-3">
    <template v-for="(seg, i) in segments" :key="i">
      <ReportChart v-if="seg.type === 'chart'" :spec="seg.spec" />

      <div
        v-else-if="seg.type === 'broken-chart'"
        class="rounded-lg border border-dashed px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
      >
        这段图表数据不是合法 JSON，已跳过渲染；数字仍以上方表格为准。
        <details class="mt-1">
          <summary class="cursor-pointer text-[10px]">查看原始内容</summary>
          <pre class="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10px]">{{ seg.raw }}</pre>
        </details>
      </div>

      <div
        v-else-if="seg.type === 'mermaid'"
        class="rounded-lg border border-dashed px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
      >
        旧版报告里的 mermaid 图表已停止渲染，避免一直卡在加载状态。重新生成报告即可得到可交互的图表。
        <details class="mt-1">
          <summary class="cursor-pointer text-[10px]">查看原始内容</summary>
          <pre class="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10px]">{{ seg.raw }}</pre>
        </details>
      </div>

      <div v-else-if="seg.type === 'code'" class="overflow-hidden rounded-lg border bg-muted/20">
        <div class="border-b px-3 py-1 font-mono text-[10px] text-muted-foreground">
          {{ seg.lang || 'text' }}
        </div>
        <pre class="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{{ seg.raw }}</pre>
      </div>

      <MessageResponse v-else-if="seg.type === 'md'" :content="seg.value" />
    </template>
  </div>
</template>
