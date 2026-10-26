<script setup lang="ts">
import type { GitLabClient } from '@/core/adapters/gitlab'
import type { GitCommit, Project } from '@/core/domain/types'
import type { EvidenceReportEntry } from '@/core/engine/codeEvidence'
import { computed, ref } from 'vue'
import { AlertTriangleIcon, Loader2Icon, ScanSearchIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import StructuredReport from '@/components/activity/StructuredReport.vue'
import { analyzeActivityEvidence } from '@/core/engine/codeEvidence'
import { createLlmClient } from '@/core/llm/client'
import { useProfileStore } from '@/core/store/profile'
import { useSettingsStore } from '@/core/store/settings'

/**
 * 申报 vs 代码证据。
 *
 * 和「分析报告」的区别：分析报告偏统计和趋势；这里逐条回答
 * 「日报说做了 X，代码里实际改了什么」。代码证据来自 codegraph，
 * 不是提交标题的复述。
 */
const props = defineProps<{
  projects: Project[]
  commits: GitCommit[]
  reports: EvidenceReportEntry[]
  scopeLabel: string
  gitlab?: GitLabClient | null
}>()

const settingsStore = useSettingsStore()
const profileStore = useProfileStore()
const running = ref(false)
const progress = ref('')
const error = ref<string | null>(null)
const markdown = ref('')
const usedCodegraph = ref(false)
const repoNotes = ref<string[]>([])
const failures = ref<string[]>([])

const canRun = computed(() =>
  Boolean(props.commits.length || props.reports.length) && !running.value,
)

async function run() {
  if (!canRun.value)
    return
  running.value = true
  error.value = null
  markdown.value = ''
  failures.value = []
  repoNotes.value = []
  try {
    // 代码证据依赖画像里的本地仓库路径；先按需读取，不触发生成
    for (const project of props.projects) {
      if (!(project.id in profileStore.byProject))
        await profileStore.load(project.id)
    }
    const profiles = props.projects.map(project => profileStore.byProject[project.id] ?? null)
    const result = await analyzeActivityEvidence({
      projects: props.projects,
      profiles,
      commits: props.commits,
      reports: props.reports,
      settings: settingsStore.settings,
      llm: createLlmClient(settingsStore.settings.llm),
      gitlab: props.gitlab,
      scopeLabel: props.scopeLabel,
      onProgress: message => (progress.value = message),
    })
    markdown.value = result.markdown
    usedCodegraph.value = result.usedCodegraph
    failures.value = result.failures
    repoNotes.value = result.repos.map(repo =>
      `${repo.path}${repo.action ? `：索引 ${repo.action}` : repo.error ? `：${repo.error}` : ''}`,
    )
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    running.value = false
    progress.value = ''
  }
}
</script>

<template>
  <Card class="gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="text-sm">申报 vs 代码证据</CardTitle>
      <CardDescription class="text-xs">
        逐条对照日报申报和实际代码改动。先确保本地仓库有 codegraph 索引，再用改动文件检索符号和源码，
        最后让模型判断「报了什么」和「干了什么」是否一致。
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3 px-4">
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" class="text-xs" :disabled="!canRun" @click="run">
          <Loader2Icon v-if="running" :size="12" class="mr-1.5 animate-spin" />
          <ScanSearchIcon v-else :size="12" class="mr-1.5" />
          {{ markdown ? '重新分析代码证据' : '分析申报与代码' }}
        </Button>
        <span v-if="progress" class="text-[11px] text-muted-foreground">{{ progress }}</span>
        <span v-else-if="markdown" class="text-[11px] text-muted-foreground">
          {{ usedCodegraph ? '已使用 codegraph 代码证据' : '未取得 codegraph 结果，仅依据提交和文件' }}
        </span>
      </div>

      <Alert v-if="error" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Alert v-if="failures.length">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          <span class="block">{{ failures.slice(0, 4).join('；') }}</span>
        </AlertDescription>
      </Alert>

      <p v-if="repoNotes.length" class="text-[10px] leading-relaxed text-muted-foreground">
        {{ repoNotes.join('；') }}
      </p>

      <div v-if="markdown" class="prose-measure">
        <StructuredReport :content="markdown" />
      </div>

      <p v-else-if="!running" class="text-[11px] leading-relaxed text-muted-foreground">
        点上面的按钮才会调用模型和 codegraph，平时不会自动消耗调用次数。
        codegraph 索引基于本地工作区；功能分支上尚未合并的代码可能不在索引里，
        这类提交仍会用改动文件和提交正文作为证据。
      </p>
    </CardContent>
  </Card>
</template>
