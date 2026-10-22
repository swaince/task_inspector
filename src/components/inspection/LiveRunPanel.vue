<script setup lang="ts">
import { computed } from 'vue'
import { Loader } from '@/components/ai-elements/loader'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Progress } from '@/components/ui/progress'
import { useRunnerStore } from '@/core/store/runner'

/**
 * 运行中的实时面板。
 *
 * 模型判定一条日报内容通常要几秒到几十秒，这里把增量输出直接摊开显示，
 * 一方面是让人看到确实在干活，另一方面判定理由写得不合适时能当场看出来。
 */
const runner = useRunnerStore()

const activeId = computed(() => runner.activeEntryId)
const activeText = computed(() => (activeId.value ? runner.thinking[activeId.value] ?? '' : ''))
const summaryText = computed(() => runner.thinking.__summary__ ?? '')

const stageLabel = computed(() => {
  const map: Record<string, string> = {
    idle: '待开始',
    'collecting-report': '获取日报',
    'collecting-commits': '拉取代码提交',
    matching: '匹配项目',
    judging: '逐条判定',
    summarizing: '生成结论',
    done: '已完成',
    failed: '已中断',
  }
  return map[runner.progress.stage] ?? runner.progress.stage
})
</script>

<template>
  <div class="space-y-4">
    <div class="space-y-2 rounded-lg border bg-card p-4">
      <div class="flex items-center gap-2">
        <Loader v-if="runner.running" :size="14" class="text-primary" />
        <span class="text-sm font-medium">{{ stageLabel }}</span>
        <span v-if="runner.currentLabel" class="text-xs text-muted-foreground">
          {{ runner.currentLabel }}
        </span>
        <span class="ml-auto text-xs tabular-nums text-muted-foreground">
          {{ runner.overallPercent }}%
        </span>
      </div>

      <Progress :model-value="runner.progress.percent" class="h-1.5" />

      <p class="text-xs leading-relaxed text-muted-foreground">
        {{ runner.progress.message || '准备中…' }}
      </p>
    </div>

    <Reasoning
      v-if="activeText"
      :is-streaming="runner.running"
      :default-open="true"
    >
      <ReasoningTrigger>
        <span class="text-sm">正在判定当前日报内容</span>
      </ReasoningTrigger>
      <ReasoningContent :content="activeText" />
    </Reasoning>

    <Reasoning
      v-if="summaryText"
      :is-streaming="runner.running"
      :default-open="true"
    >
      <ReasoningTrigger>
        <span class="text-sm">正在生成整体结论</span>
      </ReasoningTrigger>
      <ReasoningContent :content="summaryText" />
    </Reasoning>

    <div v-if="runner.failures.length" class="space-y-1.5">
      <div
        v-for="f in runner.failures"
        :key="f.memberId"
        class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
      >
        <span class="font-medium">{{ f.memberName }}</span>
        <span class="text-muted-foreground">：{{ f.message }}</span>
      </div>
    </div>
  </div>
</template>
