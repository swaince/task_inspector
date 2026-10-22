import type { LlmChatMessage } from '../bridge/types'
import type { LlmSettings } from '../config/settings'
import type { ProjectContext } from '../engine/projectContext'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { createLlmClient } from '../llm/client'
import { uid } from '@/lib/format'

/**
 * 单个项目的对话。
 *
 * 消息只存在内存 + localStorage：它是「当前项目的临时问答」，
 * 不是需要审计的工作记录，也不该因为换个项目就丢掉。
 * 资料（ProjectContext）不持久化——提交和日报都会变，重新进入页面时重建。
 */

export interface ProjectChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** 生成中断、请求失败等；有值时界面上用错误样式显示，不当作正常回答 */
  error?: string
}

export interface ProjectChatState {
  messages: ProjectChatMessage[]
  /** 已拼好的资料包；没有时不能提问（至少要先尝试构建一次） */
  context: ProjectContext | null
  contextBuiltAt: string | null
  building: boolean
  buildProgress: string
  buildError: string | null
  streaming: boolean
}

const STORAGE_KEY = 'task-inspector.project-chat.v1'
const MAX_STORED_MESSAGES = 40
const MAX_STORED_CHARS = 20_000
const MAX_HISTORY_MESSAGES = 12

export const CHAT_SYSTEM_PROMPT = `你是「研发工作核查」工具中的项目助手，围绕一个研发项目回答研发管理者的问题。

你会收到按区块组织的项目资料：项目基本信息、项目代码画像、最近提交、相关日报条目。

回答要求：
1. 只依据资料回答。资料没有的信息，直接说「现有资料里没有这项信息」，并说明需要补充什么（例如先生成项目画像、扩大时间范围、配置 GitLab）。
2. 不要编造模块名、文件名、提交记录、人员或业务细节。不确定时明确说不确定。
3. 架构、模块、核心功能类问题：先给结论，再用表格或列表列证据；最近开发情况：按时间、人员或主题归纳，不要逐条复述所有提交。
4. 区分事实来源：代码画像和提交记录是事实（画像可能已过时），日报是成员自述。
5. 用中文回答，简洁清晰；除非用户要求展开，控制在 500 字以内。
6. 问题与当前项目无关时，简要说明你只掌握这个项目的资料。`

function emptyState(): ProjectChatState {
  return {
    messages: [],
    context: null,
    contextBuiltAt: null,
    building: false,
    buildProgress: '',
    buildError: null,
    streaming: false,
  }
}

function loadStored(): Record<string, ProjectChatState> {
  if (typeof localStorage === 'undefined')
    return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return {}
    const parsed = JSON.parse(raw) as Record<string, ProjectChatMessage[]>
    const states: Record<string, ProjectChatState> = {}
    for (const [projectId, messages] of Object.entries(parsed)) {
      if (!Array.isArray(messages) || !messages.length)
        continue
      states[projectId] = {
        ...emptyState(),
        messages: messages
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map(m => ({
            id: m.id || uid(),
            role: m.role,
            content: m.content,
            createdAt: m.createdAt || new Date().toISOString(),
            error: typeof m.error === 'string' ? m.error : undefined,
          })),
      }
    }
    return states
  }
  catch {
    // 本地数据损坏时从空白开始，不能让整个页面打不开
    return {}
  }
}

export const useProjectChatStore = defineStore('projectChat', () => {
  const states = ref<Record<string, ProjectChatState>>(loadStored())
  /** 进行中的请求不放进响应式状态：AbortController 不能被代理 */
  const aborters = new Map<string, AbortController>()

  function stateOf(projectId: string): ProjectChatState {
    let state = states.value[projectId]
    if (!state) {
      state = emptyState()
      states.value = { ...states.value, [projectId]: state }
    }
    return state
  }

  function persist() {
    if (typeof localStorage === 'undefined')
      return
    try {
      const data: Record<string, ProjectChatMessage[]> = {}
      for (const [projectId, state] of Object.entries(states.value)) {
        const messages = state.messages
          .filter(m => m.content.trim())
          .slice(-MAX_STORED_MESSAGES)
          .map(m => ({
            ...m,
            content: m.content.length > MAX_STORED_CHARS
              ? `${m.content.slice(0, MAX_STORED_CHARS)}…`
              : m.content,
          }))
        if (messages.length)
          data[projectId] = messages
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    }
    catch {
      // 配额满等情况不影响当前对话，静默降级为仅内存
    }
  }

  function beginBuild(projectId: string) {
    const state = stateOf(projectId)
    state.building = true
    state.buildError = null
    state.buildProgress = '正在准备项目资料…'
  }

  function setBuildProgress(projectId: string, message: string) {
    stateOf(projectId).buildProgress = message
  }

  function finishBuild(projectId: string, context: ProjectContext | null, error?: string) {
    const state = stateOf(projectId)
    state.building = false
    state.buildProgress = ''
    if (context) {
      state.context = context
      state.contextBuiltAt = context.stats.builtAt
      state.buildError = null
    }
    if (error)
      state.buildError = error
  }

  function clearMessages(projectId: string) {
    stop(projectId)
    const state = stateOf(projectId)
    state.messages = []
    persist()
  }

  function stop(projectId: string) {
    aborters.get(projectId)?.abort()
  }

  async function send(
    projectId: string,
    text: string,
    opts: { context: string, llm: LlmSettings },
  ): Promise<void> {
    const state = stateOf(projectId)
    const content = text.trim()
    if (!content || state.streaming)
      return

    state.messages.push({
      id: uid(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    })

    /*
     * 这条消息在生成过程中会被反复改写，必须先转成响应式对象再放进数组。
     * 直接 push 原始对象、再改它自己的字段，Vue 不会跟踪——表现就是
     * 流式增量全攒到最后，等 streaming 变 false 触发重渲染时才一次性出现。
     */
    const assistant = reactive<ProjectChatMessage>({
      id: uid(),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    })
    state.messages.push(assistant)
    state.streaming = true

    const controller = new AbortController()
    aborters.set(projectId, controller)

    // 只带最近几轮：更早的内容已经在资料包里，重复发送既贵又容易把上下文挤满
    const history = state.messages
      .filter(m => m.id !== assistant.id && m.content.trim())
      .slice(-MAX_HISTORY_MESSAGES)
      .map(m => ({ role: m.role, content: m.content }) as LlmChatMessage)

    const messages: LlmChatMessage[] = [
      { role: 'system', content: `${CHAT_SYSTEM_PROMPT}\n\n# 项目资料\n${opts.context}` },
      ...history,
    ]

    /*
     * 流式增量可能每个 token 一次，直接写进响应式对象会让 markdown 整篇重解析。
     * 攒 50ms 再刷一次，既跟得上打字节奏，也不会把主线程占满。
     * 不用 requestAnimationFrame：窗口不可见时它会被暂停，表现成「流式结束才一次性出现」。
     */
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      assistant.content = buffer
    }

    try {
      const result = await createLlmClient(opts.llm).complete(messages, {
        signal: controller.signal,
        onDelta: (delta) => {
          buffer += delta
          if (!timer)
            timer = setTimeout(flush, 50)
        },
      })
      if (timer)
        clearTimeout(timer)
      timer = null
      assistant.content = buffer
      if (controller.signal.aborted)
        assistant.error = '已停止生成'
      else if (result.errored)
        assistant.error = `生成中断：${result.errored}`
      else if (!assistant.content.trim())
        assistant.error = '模型没有返回内容，请重试。'
    }
    catch (err) {
      if (timer)
        clearTimeout(timer)
      timer = null
      assistant.content = buffer
      const aborted = controller.signal.aborted
      assistant.error = aborted
        ? '已停止生成'
        : `请求失败：${err instanceof Error ? err.message : String(err)}`
    }
    finally {
      state.streaming = false
      aborters.delete(projectId)
      persist()
    }
  }

  return {
    states,
    stateOf,
    beginBuild,
    setBuildProgress,
    finishBuild,
    clearMessages,
    stop,
    send,
  }
})
