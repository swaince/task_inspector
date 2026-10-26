<script setup lang="ts">
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import type { ProjectContext } from '@/core/engine/projectContext'
import type { ToolTrace } from '@/core/agent/toolChat'
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckIcon,
  DatabaseIcon,
  GitCommitHorizontalIcon,
  InfoIcon,
  Loader2Icon,
  MessagesSquareIcon,
  NetworkIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import ConversationAutoScroll from '@/components/chat/ConversationAutoScroll.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { GitLabClient } from '@/core/adapters/gitlab'
import { resolveMcpServers } from '@/core/agent/toolChat'
import { createBuiltinTools } from '@/core/agent/builtin'
import { isDesktop, transport } from '@/core/bridge'
import ToolApprovalCard from '@/components/chat/ToolApprovalCard.vue'
import { contextRange, loadProjectContext } from '@/core/engine/projectContext'
import { useProfileStore } from '@/core/store/profile'
import { useProjectChatStore } from '@/core/store/projectChat'
import { useProjectStore } from '@/core/store/projects'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * 单个项目的自由问答。
 *
 * 和「执行检查」的区别：检查是拿日报逐条对提交、给结论；这里不判定，
 * 只是把项目画像、最近提交和日报摊开，让人用自然语言去问。
 * 所以页面上刻意不出现分数，回答也不允许编造资料里没有的内容。
 */

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const reportStore = useReportStore()
const profileStore = useProfileStore()
const chat = useProjectChatStore()

const projectId = computed(() => String(route.params.id ?? ''))
const project = computed(() => projectStore.items.find(p => p.id === projectId.value) ?? null)
// 先同步建好当前项目的状态，模板首次渲染时不会在 computed 里写 store
chat.stateOf(projectId.value)
const state = computed(() => chat.stateOf(projectId.value))

const DAYS = 30

const contextOpen = ref(false)
const starting = ref(false)
const initToken = ref(0)
let buildPromise: Promise<ProjectContext | null> | null = null
let buildAbort: AbortController | null = null

const llmReady = computed(() => settingsStore.llmConfigured)
const context = computed(() => state.value.context)
const stats = computed(() => context.value?.stats ?? null)

const notFound = computed(() => projectStore.loaded && !project.value)

const canAsk = computed(() =>
  Boolean(project.value)
  && llmReady.value
  && Boolean(context.value)
  && !state.value.streaming
  && !starting.value,
)

const pendingApproval = computed(() => state.value.pendingApproval)

function approveTool() {
  const pending = pendingApproval.value
  if (!pending)
    return
  chat.approveTool(projectId.value, pending.id)
}

function denyTool() {
  const pending = pendingApproval.value
  if (!pending)
    return
  chat.denyTool(projectId.value, pending.id)
}

function approveAllTools() {
  const pending = pendingApproval.value
  if (!pending)
    return
  chat.approveAll(projectId.value, pending.id, pending.kind)
}

function traceMeta(trace: ToolTrace) {
  const meta = trace.meta
  if (!meta)
    return ''
  const parts: string[] = []
  if (meta.exitCode !== null && meta.exitCode !== undefined)
    parts.push(`退出码 ${String(meta.exitCode)}`)
  if (meta.timedOut)
    parts.push('超时')
  if (meta.truncated)
    parts.push('已截断')
  if (meta.cancelled)
    parts.push('已取消')
  return parts.join(' · ')
}

const statusText = computed(() => {
  const s = stats.value
  if (!s)
    return ''
  const parts = [
    s.profile ? `项目画像${s.modules ? `（${s.modules} 个模块）` : ''}` : '未生成项目画像',
    `最近 ${s.days} 天 ${s.commits} 个提交`,
    ...(s.signals ? [`${s.signals} 条 MR/评审/Issue 活动`] : []),
    `${s.reportEntries} 条日报`,
  ]
  if (s.repos)
    parts.push(`${s.repos} 个仓库`)
  if (s.failures.length)
    parts.push(`${s.failures.length} 条资料限制`)
  if (state.value.contextBuiltAt)
    parts.push(`整理于 ${formatDateTime(state.value.contextBuiltAt)}`)
  return parts.join(' · ')
})

const devModeText = computed(() => {
  const mode = project.value?.devMode
  return {
    manual: '人工开发',
    'ai-assisted': 'AI 辅助',
    'ai-driven': 'AI 开发',
  }[mode ?? 'manual']
})

const suggestions = [
  {
    icon: NetworkIcon,
    title: '整体架构',
    question: '这个项目的整体架构和主要模块是什么？模块之间是怎么协作的？',
    hint: '整体架构和主要模块是什么？',
  },
  {
    icon: SparklesIcon,
    title: '核心功能',
    question: '这个项目对外提供的核心功能有哪些？主要入口在哪里？',
    hint: '核心功能和主要入口有哪些？',
  },
  {
    icon: GitCommitHorizontalIcon,
    title: '最近开发',
    question: '最近 30 天这个项目主要在开发什么？请按主题或人员归纳。',
    hint: '最近 30 天主要在开发什么？',
  },
  {
    icon: ShieldAlertIcon,
    title: '风险与技术债',
    question: '从代码画像和最近提交看，这个项目有哪些值得关注的风险或技术债？',
    hint: '有哪些值得关注的风险或技术债？',
  },
]

watch(projectId, (id) => {
  if (!id)
    return
  chat.stateOf(id)
  buildAbort?.abort()
  buildPromise = null
  void init()
}, { flush: 'sync' })

onMounted(() => {
  chat.stateOf(projectId.value)
  void init()
})

onBeforeUnmount(() => {
  // 只取消资料构建；已经发出的问答继续在 store 里跑完，回来还能看到
  buildAbort?.abort()
})

async function init() {
  const token = ++initToken.value
  const tasks: Promise<unknown>[] = [settingsStore.load(), reportStore.load()]
  if (!projectStore.loaded)
    tasks.push(projectStore.load())
  await Promise.all(tasks)
  if (token !== initToken.value)
    return
  if (project.value)
    await ensureContext(false)
}

/**
 * 构建资料包。
 *
 * 强制刷新时也复用正在进行的构建，避免连点几次「刷新资料」并发拉一遍 GitLab。
 */
async function ensureContext(force = false): Promise<ProjectContext | null> {
  const p = project.value
  if (!p)
    return null
  const id = p.id
  const current = chat.stateOf(id)
  if (!force && current.context)
    return current.context
  if (buildPromise)
    return buildPromise

  buildAbort?.abort()
  const controller = new AbortController()
  buildAbort = controller
  chat.beginBuild(id)

  buildPromise = (async () => {
    try {
      await profileStore.load(id)
      /*
       * codegraph 的 MCP 工具只有在仓库有 `.codegraph/` 索引时才有效。
       * 会话开始前先确保索引；失败只影响代码工具，不阻塞资料整理。
       */
      if (settingsStore.settings.analysis.autoIndex && isDesktop()) {
        const profile = profileStore.byProject[id]
        for (const repo of profile?.repos ?? []) {
          if (!repo.localPath)
            continue
          chat.setBuildProgress(id, `正在确保 ${repo.repoPath} 的 codegraph 索引…`)
          try {
            await transport().analysisIndex(repo.localPath, settingsStore.settings.analysis.codegraphPath)
          }
          catch {
            // 索引失败时工具会明确提示；这里不打断会话
          }
        }
      }
      const { from, to } = contextRange(DAYS)
      const notes: string[] = []

      if (settingsStore.settings.dailyReport.source === 'http') {
        chat.setBuildProgress(id, `正在刷新 ${from} ~ ${to} 的日报…`)
        const refreshed = await reportStore.refreshRange(from, to)
        if (!refreshed.ok)
          notes.push(`日报刷新失败：${refreshed.error ?? '未知错误'}（使用本地缓存）`)
      }

      const built = await loadProjectContext({
        project: p,
        profile: profileStore.byProject[id] ?? null,
        reports: Object.values(reportStore.cache).flat(),
        rules: settingsStore.settings.rules,
        gitlab: settingsStore.configured ? new GitLabClient(settingsStore.settings.gitlab) : undefined,
        useSignals: settingsStore.settings.workload.useSignals,
        days: DAYS,
        notes,
        signal: controller.signal,
        onProgress: message => chat.setBuildProgress(id, message),
      })

      if (controller.signal.aborted) {
        // 取消时未必抛异常（例如拉完提交才发现已取消），必须显式收尾，否则 building 会一直转
        chat.finishBuild(id, null)
        return null
      }

      chat.finishBuild(id, built)
      return built
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      chat.finishBuild(
        id,
        null,
        controller.signal.aborted ? undefined : `资料整理失败：${message}`,
      )
      return null
    }
    finally {
      // 切换到另一个项目后，旧构建的收尾不能把新构建的 promise 清掉
      if (buildAbort === controller) {
        buildAbort = null
        buildPromise = null
      }
    }
  })()

  return buildPromise
}

function onSubmit(payload: PromptInputMessage) {
  void ask(payload.text)
}

async function ask(text: string) {
  const content = text.trim()
  if (!content || state.value.streaming || starting.value)
    return
  if (!llmReady.value) {
    state.value.buildError = '还没有配置模型。请到「设置 → 模型」填写后再提问。'
    return
  }
  if (!context.value) {
    const built = await ensureContext(false)
    if (!built)
      return
  }
  const active = context.value
  if (!active)
    return

  starting.value = true
  try {
    // 代码工具按当前项目画像里的本地目录发现；没有画像就只做普通资料问答
    const profile = profileStore.byProject[projectId.value]
    const projectPaths = (profile?.repos ?? [])
      .map(repo => repo.localPath?.trim())
      .filter((path): path is string => Boolean(path))
    const servers = await resolveMcpServers(settingsStore.settings, projectPaths, projectId.value)
    const builtinTools = createBuiltinTools({
      settings: settingsStore.settings,
      projectPaths,
      projectId: projectId.value,
    })
    const gitlab = settingsStore.configured
      ? new GitLabClient(settingsStore.settings.gitlab)
      : null

    void chat.send(projectId.value, content, {
      context: active.text,
      llm: settingsStore.settings.llm,
      settings: settingsStore.settings,
      servers,
      builtinTools,
      projectPaths,
      gitlab,
    })
  }
  finally {
    starting.value = false
  }
}

function stop() {
  chat.stop(projectId.value)
}

function clearMessages() {
  chat.clearMessages(projectId.value)
}

function back() {
  router.push({ name: 'projects' })
}

function openProfile() {
  router.push({ name: 'project-profile', params: { id: projectId.value } })
}

function openSettings() {
  router.push({ name: 'settings' })
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- 项目条：页面标题已在应用页头，这里只保留当前项目和操作 -->
    <div class="flex shrink-0 items-center gap-3 border-b px-5 py-2">
      <Button variant="ghost" size="sm" class="px-1.5" title="返回项目" @click="back">
        <ArrowLeftIcon :size="14" />
      </Button>

      <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-sm font-medium" :title="project?.description">{{ project?.name ?? '项目对话' }}</span>
          <Badge v-if="project?.code" variant="outline" class="font-mono">
            {{ project.code }}
          </Badge>
          <Badge v-if="project" variant="secondary">
            {{ devModeText }}
          </Badge>
          <Badge v-if="project && !project.followed" variant="outline" class="text-muted-foreground">
            未关注
          </Badge>
        </div>
        <div
          class="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11px] text-muted-foreground"
          :title="state.building ? state.buildProgress : (statusText || project?.description || '')"
        >
          <Loader2Icon v-if="state.building" :size="11" class="shrink-0 animate-spin" />
          <DatabaseIcon v-else :size="11" class="shrink-0" />
          <span class="truncate">
            <template v-if="state.building">
              {{ state.buildProgress || '正在整理项目资料…' }}
            </template>
            <template v-else-if="stats">
              {{ statusText }}
            </template>
            <template v-else>
              资料还没有载入
            </template>
          </span>
        </div>
      </div>

      <div class="ml-auto flex shrink-0 items-center gap-1">
        <Button
          v-if="stats"
          variant="ghost"
          size="sm"
          class="px-1.5"
          title="查看本次对话使用的资料"
          @click="contextOpen = true"
        >
          <InfoIcon :size="13" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="state.building"
          title="重新读取项目画像、最近提交和日报"
          @click="ensureContext(true)"
        >
          <Loader2Icon v-if="state.building" :size="13" class="mr-1.5 animate-spin" />
          <RefreshCwIcon v-else :size="13" class="mr-1.5" />
          刷新资料
        </Button>
        <Button variant="ghost" size="sm" title="查看项目画像" @click="openProfile">
          <NetworkIcon :size="13" class="mr-1.5" />
          画像
        </Button>
        <Button
          variant="ghost"
          size="sm"
          :disabled="!state.messages.length"
          title="清空当前项目的对话（不影响资料）"
          @click="clearMessages"
        >
          <Trash2Icon :size="13" />
        </Button>
      </div>
    </div>

    <!-- 资料状态已经并进项目条，避免页头叠三层 -->

    <Alert v-if="!llmReady" class="mx-5 mt-3 w-auto shrink-0">
      <AlertDescription class="flex flex-wrap items-center justify-between gap-3">
        <span>还没有配置模型，项目对话无法生成回答。资料可以正常整理，但问题发不出去。</span>
        <Button variant="outline" size="sm" @click="openSettings">
          去设置
        </Button>
      </AlertDescription>
    </Alert>

    <Alert v-if="state.buildError" variant="destructive" class="mx-5 mt-3 w-auto shrink-0">
      <AlertTriangleIcon :size="14" />
      <AlertDescription class="flex flex-wrap items-center justify-between gap-3">
        <span>{{ state.buildError }}</span>
        <Button variant="outline" size="sm" :disabled="state.building" @click="ensureContext(true)">
          重试
        </Button>
      </AlertDescription>
    </Alert>

    <div v-if="notFound" class="flex flex-1 items-center justify-center p-8">
      <div class="max-w-md space-y-3 text-center">
        <p class="text-sm font-medium">
          找不到这个项目
        </p>
        <p class="text-xs text-muted-foreground">
          它可能已经被删除，或者项目列表还没有同步完成。
        </p>
        <Button variant="outline" size="sm" @click="back">
          返回项目列表
        </Button>
      </div>
    </div>

    <template v-else>
      <!-- 空状态单独铺开：放进聊天滚动区会被 StickToBottom 一上来就滚到底部，标题被顶出视野 -->
      <div v-if="!state.messages.length" class="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div class="mx-auto flex min-h-full max-w-3xl flex-col">
          <div class="my-auto space-y-5">
            <ConversationEmptyState
              class="h-auto! min-h-0! p-0!"
              title="问这个项目什么？"
              description="回答会先读取项目画像、最近 30 天提交和日报；配置了 codegraph / graphify 时，会按问题调用代码工具查符号和调用关系，资料里没有的会直接说明。"
            >
              <template #icon>
                <MessagesSquareIcon :size="28" />
              </template>
            </ConversationEmptyState>

            <div class="grid gap-2 sm:grid-cols-2">
              <button
                v-for="suggestion in suggestions"
                :key="suggestion.title"
                type="button"
                :disabled="!canAsk"
                :class="cn(
                  'flex items-start gap-2.5 rounded-lg border bg-card p-2.5 text-left transition-colors',
                  canAsk ? 'hover:border-foreground/20 hover:bg-accent/40' : 'cursor-not-allowed opacity-50',
                )"
                @click="ask(suggestion.question)"
              >
                <component :is="suggestion.icon" :size="15" class="mt-0.5 shrink-0 text-muted-foreground" />
                <span class="min-w-0">
                  <span class="block text-xs font-medium">{{ suggestion.title }}</span>
                  <span class="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                    {{ suggestion.hint }}
                  </span>
                </span>
              </button>
            </div>

            <div v-if="state.building" class="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
              <Loader2Icon :size="13" class="animate-spin" />
              <Shimmer>{{ state.buildProgress || '正在整理项目资料…' }}</Shimmer>
            </div>
          </div>
        </div>
      </div>

      <Conversation v-else class="min-h-0 flex-1">
        <ConversationAutoScroll :trigger="state.messages.length" />
        <ConversationContent class="mx-auto w-full max-w-3xl gap-6 px-5 py-6">
          <Message
            v-for="(message, index) in state.messages"
            :key="message.id"
            :from="message.role"
            :class="message.role === 'assistant' ? 'max-w-none' : undefined"
          >
            <MessageContent :class="message.role === 'assistant' ? 'w-full max-w-none' : undefined">
              <template v-if="message.role === 'user'">
                <p class="whitespace-pre-wrap break-words">
                  {{ message.content }}
                </p>
              </template>
              <template v-else>
                <ToolApprovalCard
                  v-if="pendingApproval && pendingApproval.messageId === message.id"
                  :approval="pendingApproval"
                  class="mb-2"
                  @approve="approveTool"
                  @approve-all="approveAllTools"
                  @deny="denyTool"
                />

                <div v-if="message.approvalDecisions?.length" class="mb-2 space-y-1">
                  <div
                    v-for="decision in message.approvalDecisions"
                    :key="decision.id"
                    class="flex items-center gap-1.5 text-[11px]"
                    :class="decision.decision === 'allowed'
                      ? 'text-emerald-600 dark:text-emerald-500'
                      : 'text-muted-foreground'"
                  >
                    <CheckIcon v-if="decision.decision === 'allowed'" :size="12" class="shrink-0" />
                    <XIcon v-else :size="12" class="shrink-0" />
                    <span class="truncate">
                      {{ decision.decision === 'allowed' ? '已允许' : '未执行' }}：{{ decision.title }}
                      <template v-if="decision.message"> · {{ decision.message }}</template>
                    </span>
                  </div>
                </div>

                <div v-if="message.toolTraces?.length" class="mb-2 space-y-1">
                  <details
                    v-for="(trace, traceIndex) in message.toolTraces"
                    :key="traceIndex"
                    class="overflow-hidden rounded-md border bg-muted/20"
                  >
                    <summary class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[11px]">
                      <WrenchIcon :size="12" class="shrink-0 text-muted-foreground" />
                      <span class="truncate font-mono">{{ trace.tool }}</span>
                      <span v-if="traceMeta(trace)" class="shrink-0 text-muted-foreground">
                        {{ traceMeta(trace) }}
                      </span>
                      <span
                        class="ml-auto shrink-0"
                        :class="trace.error ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-500'"
                      >
                        {{ trace.error ? '失败' : `${(trace.durationMs / 1000).toFixed(1)}s` }}
                      </span>
                    </summary>
                    <div class="space-y-1 border-t px-2 py-1.5">
                      <pre class="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{{ JSON.stringify(trace.arguments, null, 2) }}</pre>
                      <pre
                        v-if="trace.error || trace.result"
                        class="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground"
                      >{{ trace.error || trace.result }}</pre>
                    </div>
                  </details>
                </div>

                <div
                  v-if="message.status && (message.content || !state.streaming)"
                  class="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                >
                  <Loader2Icon v-if="state.streaming" :size="11" class="animate-spin" />
                  <WrenchIcon v-else :size="11" />
                  {{ message.status }}
                </div>

                <div
                  v-if="message.toolErrors?.length"
                  class="mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
                >
                  工具或命令未完成：{{ message.toolErrors.slice(0, 2).join('；') }}
                </div>

                <MessageResponse
                  v-if="message.content"
                  :content="message.content"
                  :streaming="state.streaming && index === state.messages.length - 1"
                />
                <div
                  v-else-if="state.streaming && index === state.messages.length - 1"
                  class="flex items-center gap-2 py-1 text-xs text-muted-foreground"
                >
                  <Loader2Icon :size="13" class="animate-spin" />
                  <Shimmer>{{ message.status || '正在阅读项目资料…' }}</Shimmer>
                </div>
                <p
                  v-if="message.error"
                  :class="cn('text-[11px] text-red-600 dark:text-red-400', message.content && 'mt-2')"
                >
                  {{ message.error }}
                </p>
              </template>
            </MessageContent>
          </Message>
        </ConversationContent>

        <ConversationScrollButton />
      </Conversation>

      <div class="shrink-0 border-t bg-background px-5 py-3">
        <div class="mx-auto max-w-3xl space-y-1.5">
          <PromptInput @submit="onSubmit">
            <PromptInputBody>
              <PromptInputTextarea
                :disabled="!canAsk"
                :placeholder="state.building
                  ? '正在整理项目资料…'
                  : llmReady
                    ? '问这个项目的架构、模块、核心功能或最近的开发情况…'
                    : '请先在设置里配置模型'"
                class="min-h-16"
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <span class="px-1.5 text-[11px] text-muted-foreground">
                  模型：{{ settingsStore.settings.llm.model || '未配置' }}
                </span>
              </PromptInputTools>

              <PromptInputButton
                v-if="state.streaming"
                variant="secondary"
                title="停止生成"
                @click="stop"
              >
                <SquareIcon :size="13" />
              </PromptInputButton>
              <PromptInputSubmit v-else :status="'ready'" :disabled="!canAsk" />
            </PromptInputFooter>
          </PromptInput>

          <p class="text-[11px] leading-relaxed text-muted-foreground">
            Enter 发送，Shift + Enter 换行。项目资料和代码工具查询结果会发送给「设置 → 模型」中配置的服务。
          </p>
        </div>
      </div>
    </template>

    <Dialog v-model:open="contextOpen">
      <DialogContent class="max-h-[85vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>本次对话使用的资料</DialogTitle>
          <DialogDescription>
            下面是发送给模型的完整项目资料。资料里没有的内容，模型不应该回答。
          </DialogDescription>
        </DialogHeader>
        <div class="max-h-[60vh] overflow-y-auto rounded-md border bg-muted/30 p-3">
          <pre class="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{{ context?.text }}</pre>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
