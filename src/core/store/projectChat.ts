import type { LlmChatMessage } from '../bridge/types'
import type { AnalysisMcpServer, AppSettings, LlmSettings } from '../config/settings'
import type { ProjectContext } from '../engine/projectContext'
import type { ApprovalDecision, ApprovalKind, ApprovalRequest, BuiltinTool } from '../agent/types'
import type { ToolTrace } from '../agent/toolChat'
import type { GitLabClient } from '../adapters/gitlab'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { runToolChat } from '../agent/toolChat'
import { looksLikeToolCallSyntax, stripToolCallSyntax } from '../agent/text'
import { buildAppSkill } from '@/core/knowledge/skill'
import { uid } from '@/lib/format'

/**
 * 单个项目的对话。
 *
 * 消息只存在内存 + localStorage：它是「当前项目的临时问答」，
 * 不是需要审计的工作记录，也不该因为换个项目就丢掉。
 * 资料（ProjectContext）不持久化——提交和日报都会变，重新进入页面时重建。
 */

export interface ApprovalDecisionRecord {
  id: string
  kind: ApprovalRequest['kind']
  title: string
  decision: 'allowed' | 'denied'
  message?: string
  decidedAt: string
}

export interface PendingApproval extends ApprovalRequest {
  messageId: string
  createdAt: string
}

export interface ProjectChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** 生成中断、请求失败等；有值时界面上用错误样式显示，不当作正常回答 */
  error?: string
  /** 正在连接、规划或查询代码工具时的状态文案 */
  status?: string
  /** 本次回答调用过的工具，按发生顺序 */
  toolTraces?: ToolTrace[]
  /** MCP/内置工具失败的原因；最终回答仍然保留 */
  toolErrors?: string[]
  /** 已完成的确认记录（允许/拒绝），用于卡片消失后的留痕 */
  approvalDecisions?: ApprovalDecisionRecord[]
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
  /** 等待用户确认的命令/写操作；同一项目同一时刻最多一个 */
  pendingApproval: PendingApproval | null
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
6. 日期一律写成完整中文日期（例如「2026年10月21日」），不要写成「10-21」「10月21日」或 ISO 日期。
7. 问题与当前项目无关时，简要说明你只掌握这个项目的资料。
8. 内置官方文档、人员/项目查询结果和命令输出也是允许的依据；功能、设置、数据口径类问题先查官方文档，不要凭印象补充功能。
9. 不要输出工具调用语法（DSML、<|...|>、<function_calls>、<tool_call> 等），也不要伪造工具调用；系统会在回答前执行工具，你只需要基于结果作答。`

export const ASSISTANT_SYSTEM_PROMPT = `你是「研发工作核查」的应用助手，没有绑定具体项目。

你可以：
1. 回答这个应用怎么用、设置在哪、数据口径是什么；
2. 在用户确认后维护本应用的人员和项目关联；
3. 根据内置官方文档解释功能，不要凭印象补充不存在的功能。

回答要求：
- 功能、设置、口径、报错类问题先查官方文档；文档没有覆盖时直接说「官方文档没有这项说明」。
- 不要假装看过某个项目的代码或提交；需要项目上下文时，请用户进入对应项目的「项目对话」。
- 所有写操作都要等待用户在确认卡片里允许；未允许前不得声称已经完成。
- 被拒绝、取消或超时的操作没有发生，要如实说明。
- 不要输出工具调用语法（DSML、<|...|>、<function_calls>、<tool_call> 等），也不要伪造工具调用；系统会执行工具并把结果交给你。
- 用中文回答，简洁清晰；日期写成完整中文日期。`

function emptyState(): ProjectChatState {
  return {
    messages: [],
    context: null,
    contextBuiltAt: null,
    building: false,
    buildProgress: '',
    buildError: null,
    streaming: false,
    pendingApproval: null,
  }
}

/** 持久化时不保存可点击的 resolver，只留一个只读标记，刷新后转成中断提示 */
interface StoredApprovalPending {
  title: string
  kind: ApprovalRequest['kind']
  summary: string[]
  command?: string
  cwd?: string
  riskLevel: ApprovalRequest['risk']['level']
}

interface StoredChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  error?: string
  approvalPending?: StoredApprovalPending
}

function loadStored(): Record<string, ProjectChatState> {
  if (typeof localStorage === 'undefined')
    return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return {}
    const parsed = JSON.parse(raw) as Record<string, StoredChatMessage[]>
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
            error: m.approvalPending
              ? '等待确认时页面已刷新，操作未执行'
              : (typeof m.error === 'string' ? m.error : undefined),
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
  /**
   * 等待确认的 resolver 同样不能进响应式状态。
   * settle 时先删表再 resolve，双击/重复调用天然幂等。
   */
  const approvalResolvers = new Map<string, {
    projectId: string
    messageId: string
    request: ApprovalRequest
    resolve: (decision: ApprovalDecision) => void
    cleanup: () => void
  }>()

  /**
   * 本次回答内已经选择“全部允许”的操作类型。
   * 只在当前 send 生命周期内有效，新回答/停止后清空。
   */
  const autoApproveKinds = new Map<string, Set<ApprovalKind>>()

  function allowKinds(projectId: string, kinds: ApprovalKind[]) {
    let set = autoApproveKinds.get(projectId)
    if (!set) {
      set = new Set<ApprovalKind>()
      autoApproveKinds.set(projectId, set)
    }
    for (const kind of kinds)
      set.add(kind)
  }

  function isAutoApproved(projectId: string, kind: ApprovalKind) {
    return autoApproveKinds.get(projectId)?.has(kind) ?? false
  }

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
      const data: Record<string, StoredChatMessage[]> = {}
      for (const [projectId, state] of Object.entries(states.value)) {
        const messages = state.messages
          .map((m) => {
            const pending = state.pendingApproval?.messageId === m.id
              ? {
                  title: state.pendingApproval.title,
                  kind: state.pendingApproval.kind,
                  summary: state.pendingApproval.summary,
                  command: state.pendingApproval.command?.text,
                  cwd: state.pendingApproval.command?.cwd,
                  riskLevel: state.pendingApproval.risk.level,
                }
              : undefined
            return { message: m, pending }
          })
          .filter(({ message, pending }) => message.content.trim() || message.error || pending)
          .slice(-MAX_STORED_MESSAGES)
          .map(({ message, pending }): StoredChatMessage => ({
            id: message.id,
            role: message.role,
            content: message.content.length > MAX_STORED_CHARS
              ? `${message.content.slice(0, MAX_STORED_CHARS)}…`
              : message.content,
            createdAt: message.createdAt,
            error: message.error,
            approvalPending: pending,
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
    const state = stateOf(projectId)
    if (state.pendingApproval)
      settleApproval(projectId, state.pendingApproval.id, false, '已停止生成')
    autoApproveKinds.delete(projectId)
  }

  /**
   * 结束一次确认。先删 resolver 再 resolve，重复点击/重复调用只生效一次。
   */
  function settleApproval(
    projectId: string,
    id: string,
    approved: boolean,
    message?: string,
  ) {
    const entry = approvalResolvers.get(id)
    if (!entry || entry.projectId !== projectId)
      return
    approvalResolvers.delete(id)
    entry.cleanup()

    const state = stateOf(projectId)
    if (state.pendingApproval?.id === id)
      state.pendingApproval = null

    const target = state.messages.find(m => m.id === entry.messageId)
    if (target) {
      target.approvalDecisions = [
        ...(target.approvalDecisions ?? []),
        {
          id,
          kind: entry.request.kind,
          title: entry.request.title,
          decision: approved ? 'allowed' : 'denied',
          message,
          decidedAt: new Date().toISOString(),
        },
      ]
      target.status = approved ? '正在执行操作…' : ''
    }

    persist()
    entry.resolve({ approved, message })
  }

  function approveTool(projectId: string, id: string) {
    settleApproval(projectId, id, true)
  }

  function denyTool(projectId: string, id: string, message = '用户拒绝执行') {
    settleApproval(projectId, id, false, message)
  }

  /**
   * 本次回答内全部允许：
   * - 成员/项目写操作直接放行；
   * - 如果当前卡片就是命令，连后续命令一起放行；
   * - 只对当前回答有效，新回答/停止后恢复逐条确认。
   */
  function approveAll(projectId: string, id: string, kind: ApprovalKind) {
    const entry = approvalResolvers.get(id)
    if (!entry || entry.projectId !== projectId)
      return
    const kinds: ApprovalKind[] = kind === 'shell'
      ? ['member', 'project', 'shell']
      : ['member', 'project']
    allowKinds(projectId, kinds)
    settleApproval(
      projectId,
      id,
      true,
      kind === 'shell'
        ? '本次回答内已允许所有命令和写操作'
        : '本次回答内已全部允许',
    )
  }

  async function send(
    projectId: string,
    text: string,
    opts: {
      context: string
      llm: LlmSettings
      settings: AppSettings
      /** 已解析好的 MCP 服务；空数组表示这次不启用代码工具 */
      servers?: AnalysisMcpServer[]
      /** 项目画像里的本地代码目录，工具查询用 */
      projectPaths?: string[]
      /** 应用内置工具；不传则只有 MCP */
      builtinTools?: BuiltinTool[]
      gitlab?: GitLabClient | null
      /** 全局助手用不同的系统提示；不传用项目对话的提示 */
      systemPrompt?: string
    },
  ): Promise<void> {
    const state = stateOf(projectId)
    const content = text.trim()
    if (!content || state.streaming)
      return

    // 每次新回答都从“逐条确认”开始
    autoApproveKinds.delete(projectId)

    const userMessage: ProjectChatMessage = {
      id: uid(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    state.messages.push(userMessage)
    // 用户消息先落盘：即使随后刷新/重载，也不会整轮对话凭空消失
    persist()

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
      .filter(m =>
        m.id !== userMessage.id
        && m.id !== assistant.id
        && m.content.trim(),
      )
      .slice(-MAX_HISTORY_MESSAGES)
      .map(m => ({ role: m.role, content: m.content }) as LlmChatMessage)

    /*
     * 流式增量可能每个 token 一次，直接写进响应式对象会让 markdown 整篇重解析。
     * 攒 50ms 再刷一次，既跟得上打字节奏，也不会把主线程占满。
     * 不用 requestAnimationFrame：窗口不可见时它会被暂停，表现成「流式结束才一次性出现」。
     */
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      // 有些模型会把 DSML/XML 工具调用语法写进正文，流式过程中也要先过滤
      assistant.content = stripToolCallSyntax(buffer)
    }

    assistant.status = '正在准备项目资料…'

    try {
      const result = await runToolChat({
        question: content,
        history,
        context: opts.context,
        systemPrompt: [
          opts.systemPrompt ?? CHAT_SYSTEM_PROMPT,
          buildAppSkill((opts.builtinTools ?? []).map(tool => tool.descriptor)),
        ].join('\n\n'),
        llm: opts.llm,
        settings: opts.settings,
        projectId,
        gitlab: opts.gitlab ?? null,
        servers: opts.servers ?? [],
        builtinTools: opts.builtinTools ?? [],
        projectPaths: opts.projectPaths ?? [],
        signal: controller.signal,
        onDelta: (delta) => {
          buffer += delta
          if (!timer)
            timer = setTimeout(flush, 50)
        },
        onStatus: (status) => {
          assistant.status = status
        },
        onTool: (trace) => {
          assistant.toolTraces = [...(assistant.toolTraces ?? []), trace]
        },
        requestApproval: request => new Promise<ApprovalDecision>((resolve) => {
          if (controller.signal.aborted) {
            resolve({ approved: false, message: '已停止生成' })
            return
          }

          if (isAutoApproved(projectId, request.kind)) {
            assistant.approvalDecisions = [
              ...(assistant.approvalDecisions ?? []),
              {
                id: request.id,
                kind: request.kind,
                title: request.title,
                decision: 'allowed',
                message: '本次回答内自动允许',
                decidedAt: new Date().toISOString(),
              },
            ]
            resolve({ approved: true, message: '本次回答内自动允许' })
            return
          }

          const entry = {
            projectId,
            messageId: assistant.id,
            request,
            resolve,
            cleanup: () => {},
          }
          const onAbort = () => settleApproval(projectId, request.id, false, '已停止生成')
          controller.signal.addEventListener('abort', onAbort, { once: true })
          entry.cleanup = () => controller.signal.removeEventListener('abort', onAbort)
          approvalResolvers.set(request.id, entry)

          state.pendingApproval = {
            ...request,
            messageId: assistant.id,
            createdAt: new Date().toISOString(),
          }
          assistant.status = '等待确认操作…'
          persist()
        }),
      })
      if (timer)
        clearTimeout(timer)
      timer = null
      const raw = buffer || result.text
      const cleaned = stripToolCallSyntax(raw)
      // result.text 可能已经被工具层纠正过（例如模型声称“没有执行”，但写操作其实成功了）；
      // 流式 buffer 是原始文本，最终展示要以纠正后的 result.text 为准。
      const finalText = result.text || cleaned
      const leakedOnly = looksLikeToolCallSyntax(raw) && finalText.trim().length < 120
      assistant.content = leakedOnly ? '' : finalText
      assistant.status = ''
      assistant.toolErrors = result.toolErrors.length ? result.toolErrors : undefined
      if (controller.signal.aborted)
        assistant.error = '已停止生成'
      else if (result.error)
        assistant.error = `生成中断：${result.error}`
      else if (leakedOnly)
        assistant.error = '模型返回了工具调用语法而不是回答，已拦截。请重试，或在设置里换一个模型。'
      else if (!assistant.content.trim())
        assistant.error = '模型没有返回内容，请重试。'
    }
    catch (err) {
      if (timer)
        clearTimeout(timer)
      timer = null
      assistant.content = buffer
      assistant.status = ''
      const aborted = controller.signal.aborted
      assistant.error = aborted
        ? '已停止生成'
        : `请求失败：${err instanceof Error ? err.message : String(err)}`
    }
    finally {
      for (const [id, entry] of [...approvalResolvers.entries()]) {
        if (entry.projectId === projectId)
          settleApproval(projectId, id, false, '请求已结束')
      }
      state.pendingApproval = null
      autoApproveKinds.delete(projectId)
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
    approveTool,
    denyTool,
    approveAll,
    send,
  }
})
