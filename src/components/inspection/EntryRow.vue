<script setup lang="ts">
import type { EntryInspection } from '@/core/domain/types'
import { computed } from 'vue'
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  LightbulbIcon,
  MessagesSquareIcon,
} from '@lucide/vue'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import VerdictBadge from '@/components/common/VerdictBadge.vue'
import { openExternal } from '@/core/bridge'
import { formatDateTime } from '@/lib/format'

const props = defineProps<{
  entry: EntryInspection
  index: number
}>()

const evidence = computed(() => props.entry.evidence ?? [])

const flags = computed(() => {
  const out: string[] = []
  if (props.entry.nonCodingWork)
    out.push('非编码工作')
  if (props.entry.projectUnresolved)
    out.push('项目未映射')
  return out
})

/**
 * 证据强度。
 *
 * 和「模型把握度」分开显示：把握度是模型自评，证据强度由代码统计得出
 * （有没有改动正文、日报关键词能不能在提交里找到）。两者不一致时，
 * 以证据强度为准更可靠。
 */
const strength = computed(() => {
  const level = props.entry.evidenceStrength ?? 'none'
  return {
    label: { strong: '证据充分', medium: '证据一般', weak: '证据薄弱', none: '无提交证据' }[level],
    cls: {
      strong: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
      medium: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
      weak: 'border-red-500/40 text-red-700 dark:text-red-400',
      none: 'text-muted-foreground',
    }[level],
    title: {
      strong: '命中的提交有具体改动，或日报关键词能在提交里找到',
      medium: '有提交且判定一致，但没有可落到具体改动的证据',
      weak: '判定不符或证据不足',
      none: '当天没有提交',
    }[level],
  }
})
</script>

<template>
  <div class="rounded-lg border bg-card">
    <!-- 日报声明 -->
    <div class="flex items-start gap-3 p-3.5">
      <span class="mt-0.5 w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {{ index + 1 }}
      </span>

      <div class="min-w-0 flex-1 space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium">{{ entry.projectName }}</span>
          <VerdictBadge :verdict="entry.verdict" compact />
          <span
            class="rounded border px-1.5 py-0.5 text-[11px]"
            :class="strength.cls"
            :title="strength.title"
          >
            {{ strength.label }}
          </span>
          <span class="text-xs tabular-nums text-muted-foreground">
            {{ entry.hours }}h · 占比 {{ (entry.ratio * 100).toFixed(0) }}%
          </span>
          <span
            v-for="flag in flags"
            :key="flag"
            class="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            {{ flag }}
          </span>
          <span
            v-if="entry.verdict !== 'unverified'"
            class="ml-auto text-[11px] text-muted-foreground"
            :title="`模型自评把握度 ${(entry.confidence * 100).toFixed(0)}%`"
          >
            把握度 {{ (entry.confidence * 100).toFixed(0) }}%
          </span>
        </div>

        <p class="text-sm leading-relaxed text-foreground/90">
          {{ entry.content }}
        </p>

        <!-- 判定理由 -->
        <div
          v-if="entry.reason"
          class="flex items-start gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
        >
          <AlertTriangleIcon
            v-if="entry.verdict === 'mismatched' || (entry.verdict === 'no-commit' && !entry.nonCodingWork)"
            :size="13"
            class="mt-0.5 shrink-0 text-amber-600 dark:text-amber-500"
          />
          <MessagesSquareIcon v-else :size="13" class="mt-0.5 shrink-0" />
          <span>{{ entry.reason }}</span>
        </div>

        <!-- 建议写法 -->
        <div
          v-if="entry.suggestions?.length"
          class="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
        >
          <LightbulbIcon :size="13" class="mt-0.5 shrink-0" />
          <ul class="space-y-0.5">
            <li v-for="(s, i) in entry.suggestions" :key="i">
              {{ s }}
            </li>
          </ul>
        </div>

        <!-- 命中的提交证据 -->
        <Sources v-if="evidence.length" class="mb-0">
          <SourcesTrigger :count="evidence.length">
            <p class="font-medium">
              命中 {{ evidence.length }} 个提交
            </p>
          </SourcesTrigger>
          <SourcesContent class="w-full">
            <div
              v-for="ev in evidence"
              :key="ev.commitId"
              class="rounded-md border bg-background/60 p-2.5"
            >
              <div class="flex items-center gap-2">
                <Source
                  :href="ev.webUrl"
                  :title="ev.shortId"
                  class="font-mono text-xs text-primary hover:underline"
                  @click.prevent="openExternal(ev.webUrl)"
                >
                  <span class="font-mono text-xs">{{ ev.shortId }}</span>
                </Source>
                <span class="truncate text-xs text-foreground">{{ ev.title }}</span>
                <ExternalLinkIcon
                  :size="11"
                  class="ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                  @click="openExternal(ev.webUrl)"
                />
              </div>
              <div class="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                <span>{{ ev.projectPath }}</span>
                <span v-if="ev.branches?.length" class="font-mono">
                  {{ ev.branches.join('、') }}
                </span>
                <span class="tabular-nums">{{ formatDateTime(ev.authoredDate) }}</span>
              </div>
              <p v-if="ev.relevance" class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {{ ev.relevance }}
              </p>
              <div v-if="ev.files.length" class="mt-1.5 flex flex-wrap gap-1">
                <span
                  v-for="f in ev.files"
                  :key="f"
                  class="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  {{ f }}
                </span>
              </div>
            </div>
          </SourcesContent>
        </Sources>
      </div>
    </div>
  </div>
</template>
