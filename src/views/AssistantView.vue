<script setup lang="ts">
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import type { ToolTrace } from '@/core/agent/toolChat'
import {
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  Loader2Icon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
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
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputButton,
} from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import ConversationAutoScroll from '@/components/chat/ConversationAutoScroll.vue'
import ToolApprovalCard from '@/components/chat/ToolApprovalCard.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { GitLabClient } from '@/core/adapters/gitlab'
import { createBuiltinTools } from '@/core/agent/builtin'
import { DOCS, listDocs } from '@/core/knowledge'
import { ASSISTANT_SYSTEM_PROMPT, useProjectChatStore } from '@/core/store/projectChat'
import { useSettingsStore } from '@/core/store/settings'
import { cn } from '@/lib/utils'

/**
 * 应用级助手。
 *
 * 和项目对话共用消息/流式/确认机制，但不加载任何项目资料：
 * 它回答「这个应用怎么用」，并在确认后维护人员、项目关联。
 * 项目代码类问题请进入对应项目的「项目对话」。
 */

const CONVERSATION_ID = '__app__'
const settingsStore = useSettingsStore()
const chat = useProjectChatStore()

chat.stateOf(CONVERSATION_ID)
const state = computed(() => chat.stateOf(CONVERSATION_ID))
const llmReady = computed(() => settingsStore.llmConfigured)
const canAsk = computed(() => llmReady.value && !state.value.streaming)
const pendingApproval = computed(() => state.value.pendingApproval)

const docsOpen = ref(false)
const docs = listDocs()
const selectedDocId = ref(docs[0]?.id ?? '')
const selectedDoc = computed(() => DOCS[selectedDocId.value as keyof typeof DOCS] ?? docs[0])

const suggestions = [
  { title: '怎么配置日报接口？', question: '日报系统怎么从 CSV 切换成接口？需要填哪些字段？' },
  { title: '符合度怎么算？', question: '检查结果里的符合度和有效工时分别是什么意思？100% 代表什么？' },
  { title: '关联人员账号', question: '张三关联账号 zhangsan@126.com' },
  { title: '关联项目 GitLab 组', question: '项目「示例项目」的 GitLab 组是 group/subgroup' },
]

onMounted(() => {
  void settingsStore.load()
})

function onSubmit(payload: PromptInputMessage) {
  void ask(payload.text)
}

async function ask(text: string) {
  const content = text.trim()
  if (!content || state.value.streaming)
    return
  if (!llmReady.value)
    return

  const builtinTools = createBuiltinTools({
    settings: settingsStore.settings,
    projectPaths: [],
    projectId: CONVERSATION_ID,
  })
  const gitlab = settingsStore.configured
    ? new GitLabClient(settingsStore.settings.gitlab)
    : null

  void chat.send(CONVERSATION_ID, content, {
    context: '（这是应用级助手，没有绑定具体项目的代码、提交或日报资料。）',
    llm: settingsStore.settings.llm,
    settings: settingsStore.settings,
    servers: [],
    builtinTools,
    projectPaths: [],
    gitlab,
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
  })
}

function stop() {
  chat.stop(CONVERSATION_ID)
}

function clear() {
  chat.clearMessages(CONVERSATION_ID)
}

function approveTool() {
  const pending = pendingApproval.value
  if (pending)
    chat.approveTool(CONVERSATION_ID, pending.id)
}

function denyTool() {
  const pending = pendingApproval.value
  if (pending)
    chat.denyTool(CONVERSATION_ID, pending.id)
}

function approveAllTools() {
  const pending = pendingApproval.value
  if (pending)
    chat.approveAll(CONVERSATION_ID, pending.id, pending.kind)
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
  return parts.join(' · ')
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex shrink-0 items-start gap-3 border-b px-5 py-4">
      <div class="min-w-0">
        <h1 class="flex items-center gap-1.5 text-sm font-medium">
          <SparklesIcon :size="15" class="text-muted-foreground" />
          应用助手
        </h1>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
          查官方文档、问功能和数据口径，或在确认后维护人员与项目关联。项目代码类问题请进入对应项目的「项目对话」。
        </p>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" class="text-xs" @click="docsOpen = true">
          <BookOpenIcon :size="12" class="mr-1" />
          内置文档
        </Button>
        <Button
          v-if="state.messages.length"
          variant="ghost"
          size="sm"
          class="text-xs"
          :disabled="state.streaming"
          @click="clear"
        >
          <Trash2Icon :size="12" class="mr-1" />
          清空
        </Button>
      </div>
    </div>

    <div v-if="!llmReady" class="mx-5 mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      还没有配置模型。请先到「设置 → 模型」填写模型名和 API Key，助手才能回答问题。
    </div>

    <Conversation v-if="state.messages.length" class="min-h-0 flex-1">
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
              <p class="whitespace-pre-wrap break-words">{{ message.content }}</p>
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
                    <span v-if="traceMeta(trace)" class="shrink-0 text-muted-foreground">{{ traceMeta(trace) }}</span>
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
                工具或操作未完成：{{ message.toolErrors.slice(0, 2).join('；') }}
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
                <Shimmer>{{ message.status || '正在查资料…' }}</Shimmer>
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

    <ConversationEmptyState v-else class="flex-1">
      <div class="mx-auto w-full max-w-2xl space-y-4 px-5">
        <div class="text-center">
          <BookOpenIcon :size="26" class="mx-auto text-muted-foreground" />
          <h2 class="mt-2 text-sm font-medium">可以用自然语言使用这个应用</h2>
          <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
            官方文档随应用下发；人员/项目的修改会在执行前向你确认。
          </p>
        </div>
        <div class="grid gap-2 sm:grid-cols-2">
          <button
            v-for="item in suggestions"
            :key="item.title"
            type="button"
            class="flex items-start gap-2 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
            @click="ask(item.question)"
          >
            <ArrowRightIcon :size="13" class="mt-0.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0">
              <span class="block text-xs font-medium">{{ item.title }}</span>
              <span class="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{{ item.question }}</span>
            </span>
          </button>
        </div>
      </div>
    </ConversationEmptyState>

    <div class="shrink-0 border-t bg-background px-5 py-3">
      <div class="mx-auto max-w-3xl space-y-1.5">
        <PromptInput @submit="onSubmit">
          <PromptInputBody>
            <PromptInputTextarea
              :disabled="!canAsk"
              :placeholder="llmReady
                ? '问功能怎么用、数据怎么算，或让我维护人员/项目关联…'
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
            <PromptInputButton v-if="state.streaming" variant="secondary" title="停止生成" @click="stop">
              <SquareIcon :size="13" />
            </PromptInputButton>
            <PromptInputSubmit v-else :status="'ready'" :disabled="!canAsk" />
          </PromptInputFooter>
        </PromptInput>
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          Enter 发送，Shift + Enter 换行。所有写操作都会先显示确认卡片。
        </p>
      </div>
    </div>

    <Dialog v-model:open="docsOpen">
      <DialogContent class="max-h-[85vh] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>内置官方文档</DialogTitle>
          <DialogDescription>
            随应用下发的使用文档。助手回答功能、设置和数据口径问题时，也以这些内容为准。
          </DialogDescription>
        </DialogHeader>
        <div class="flex h-[60vh] min-h-0 gap-3">
          <nav class="w-36 shrink-0 space-y-0.5 overflow-y-auto border-r pr-2">
            <button
              v-for="doc in docs"
              :key="doc.id"
              type="button"
              class="block w-full rounded px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent/50"
              :class="doc.id === selectedDocId
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground'"
              @click="selectedDocId = doc.id"
            >
              {{ doc.title }}
            </button>
          </nav>
          <div class="min-w-0 flex-1 overflow-y-auto pr-1">
            <MessageResponse
              v-if="selectedDoc"
              :content="`# ${selectedDoc.title}\n\n${selectedDoc.body.replace(/^#\s+.*\r?\n?/, '')}`"
              :streaming="false"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
