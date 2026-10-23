import type { AppSettings } from '@/core/config/settings'
import type { GitLabClient } from '@/core/adapters/gitlab'

/**
 * 内置工具与人工确认的通用契约。
 *
 * 对话里有两类工具：外部 MCP 服务，以及应用自带的内置工具。
 * 两者共用一个规划器和执行循环；区别只在于执行时走 MCP 还是本地实现。
 *
 * 写操作（命令执行、人员/项目维护）必须先 prepare 出「将要发生什么」，
 * 交给用户确认后才 apply。确认是这类工具唯一的安全边界。
 */

export type ToolSource = 'mcp' | 'builtin'
export type ToolRiskLevel = 'normal' | 'high'
export type ApprovalKind = 'shell' | 'member' | 'project'

export interface ToolDescriptor {
  /** 内置工具用稳定 id，例如 shell.run、docs.search */
  id: string
  source: ToolSource
  /** MCP 沿用服务器 id；内置工具用 builtin-* 保留前缀 */
  serverId: string
  serverName: string
  name: string
  qualifiedName: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}

export interface ApprovalRisk {
  level: ToolRiskLevel
  /** 命中的高风险模式，仅用于提示，不参与拦截 */
  matches: string[]
}

export interface ApprovalDetail {
  label: string
  value: string
  mono?: boolean
}

export interface ApprovalCommand {
  text: string
  cwd: string
  timeoutMs: number
}

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  title: string
  /** 卡片正文的短句，一行一件事 */
  summary: string[]
  details?: ApprovalDetail[]
  command?: ApprovalCommand
  risk: ApprovalRisk
  /** 只是提示，不能因此跳过确认 */
  readOnlyHint?: boolean
}

export interface ApprovalDecision {
  approved: boolean
  message?: string
}

export interface ToolApplyResult {
  /** 交给模型的结果文本 */
  text: string
  /** 给界面用的结构化元数据，例如命令退出码、是否截断 */
  meta?: Record<string, unknown>
}

export interface PreparedAction {
  approval: ApprovalRequest
  /** 执行并把结果交给模型；异常会转成 trace 错误 */
  apply: () => Promise<ToolApplyResult>
}

/** prepare 的结果：要么无需确认直接给结果，要么等待用户确认后执行 */
export type ToolPreparation =
  | { kind: 'result', result: string }
  | { kind: 'action', action: PreparedAction }

export interface BuiltinToolContext {
  /** 当前项目的本地仓库目录；全局助手为空数组 */
  projectPaths: string[]
  settings: AppSettings
  gitlab: GitLabClient | null
  projectId: string
  signal?: AbortSignal
  onStatus?: (status: string) => void
}

export interface BuiltinTool {
  descriptor: ToolDescriptor
  /** 只读工具：直接执行 */
  run?: (args: Record<string, unknown>, ctx: BuiltinToolContext) => Promise<string>
  /** 写工具：计算变更并返回待确认动作 */
  prepare?: (args: Record<string, unknown>, ctx: BuiltinToolContext) => Promise<ToolPreparation>
}

/** 规划器返回的一次调用 */
export interface PlannedCall {
  tool: string
  arguments: Record<string, unknown>
}
