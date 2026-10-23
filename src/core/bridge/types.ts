/** 传输层的请求/响应契约，桌面端与浏览器端实现共用。 */

import type { LdapSettings } from '../config/settings'
import type { DailyReport, GitCommit, InspectionResult, MemberProfile, Project } from '../domain/types'

/** 从 GitLab 拉回来的仓库信息，用于与本地项目表对账 */
export interface GitLabProjectInput {
  id: number
  pathWithNamespace: string
  name: string
  webUrl?: string
  description?: string
  defaultBranch?: string
  visibility?: string
  archived?: boolean
  sshUrl?: string
  httpUrl?: string
}

export interface ProjectSyncOutcome {
  added: number
  updated: number
  missing: number
}

export interface HttpRequestInput {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** 内部自签名证书时跳过 TLS 校验 */
  allowInsecureTls?: boolean
}

export interface HttpResponseOutput {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
  durationMs: number
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmChatRequest {
  provider: 'anthropic' | 'openai-compatible'
  baseUrl: string
  apiKey: string
  model: string
  messages: LlmChatMessage[]
  temperature: number
  maxTokens: number
  timeoutMs: number
  /** 强制 JSON 输出（判定环节需要结构化结果） */
  jsonMode?: boolean
}

export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
}

export type LlmStreamEvent
  = | { type: 'delta', text: string }
    | { type: 'done', usage?: LlmUsage }
    | { type: 'error', message: string }

export interface LlmStreamHandle {
  /** 主动中断本次流式请求 */
  cancel: () => void
  /**
   * 流结束（正常结束、出错或取消）时 resolve。
   * 实现方保证：resolve 之前一定会先回调过 done 或 error 事件。
   */
  done: Promise<void>
}

/** 本机命令执行。stdout/stderr 按行推给前端，最终结果由 invoke 的 Promise 返回。 */
export type ShellEvent
  = | { type: 'stdout', text: string }
    | { type: 'stderr', text: string }

export interface ShellRunRequest {
  command: string
  /** 必须是 allowedCwds 之一；Rust 侧会再次校验 */
  cwd: string
  allowedCwds: string[]
  timeoutMs: number
  runId: string
}

export interface ShellRunResult {
  exitCode: number | null
  durationMs: number
  truncated: boolean
  cancelled: boolean
  timedOut: boolean
  output: string
}

export interface InspectionFilter {
  from?: string
  to?: string
  memberId?: string
}

/**
 * 本地数据的存取接口。
 *
 * 桌面端由 Rust 侧的 SQLite 实现（见 src-tauri/src/db），浏览器开发态降级成
 * localStorage。上层 store 只依赖这个接口，两种模式下行为一致。
 *
 * 方法按「实体」而不是通用的 read/write key 来设计：
 * 通用 KV 让上层自己去拼 key、自己序列化，等于把存储结构泄漏到了业务代码里，
 * 换成数据库时每处调用都要改。按实体划分则换实现不动调用方。
 */
export interface DataStore {
  settingsGet(): Promise<string | null>
  settingsSet(value: string): Promise<void>

  reportsUpsert(date: string, reports: DailyReport[]): Promise<number>
  reportsByDate(date: string): Promise<DailyReport[]>
  reportsDates(): Promise<string[]>
  reportsClear(): Promise<void>

  inspectionsUpsert(result: InspectionResult): Promise<void>
  inspectionsList(filter?: InspectionFilter): Promise<InspectionResult[]>
  inspectionsByKey(date: string, memberId: string): Promise<InspectionResult | null>
  inspectionsDelete(date: string, memberId: string): Promise<void>
  inspectionsClear(): Promise<void>
  /**
   * 清空本地数据。
   * business = 只清业务数据（日报、检查历史、提交、项目、人员），保留配置
   * all = 连配置一起清，回到首次安装的状态
   */
  dataReset(mode: 'business' | 'all'): Promise<void>
  /** 清理超过保留期的历史，返回删除条数；keepDays <= 0 表示永久保留 */
  inspectionsPrune(keepDays: number): Promise<number>

  /** 写入提交缓存：留审计痕迹，同时作为全文检索的语料 */
  commitsUpsert(commits: GitCommit[]): Promise<number>

  /* --- 项目与人员实体 --- */

  projectsList(): Promise<Project[]>
  projectsUpsert(project: Project): Promise<string>
  projectsDelete(id: string): Promise<void>
  /** 用 GitLab 的仓库清单与本地项目表对账 */
  projectsSyncFromGitlab(projects: GitLabProjectInput[]): Promise<ProjectSyncOutcome>

  membersList(): Promise<MemberProfile[]>
  membersUpsert(member: MemberProfile): Promise<string>
  membersDelete(id: string): Promise<void>
  membersImport(members: MemberProfile[]): Promise<number>
  /** 从 LDAP 拉取人员并与本地表对账 */
  ldapSync(config: LdapSettings): Promise<MemberSyncOutcome>
  /** 探测目录属性，用于校正属性映射 */
  ldapProbe(config: LdapSettings): Promise<LdapProbeReport>
}

/* ------------------------------------------------------------------ *
 * LDAP 诊断
 * ------------------------------------------------------------------ */

export interface LdapAttributeStat {
  name: string
  /** 在抽样条目里出现的次数 */
  present: number
  sample: string | null
}

export interface LdapMappedAttribute extends LdapAttributeStat {
  /** username / name / email / employeeNo / department / title */
  field: string
}

export interface LdapAttributeSuggestion {
  field: string
  /** 当前配置的属性，在目录里一条都没命中 */
  current: string
  suggested: string
  suggestedPresent: number
}

export interface LdapProbeReport {
  baseDn: string
  filter: string
  total: number
  /** 属性统计基于抽样，不是全量 */
  sampled: number
  mapped: LdapMappedAttribute[]
  available: LdapAttributeStat[]
  samples: Array<{ dn: string, attributes: Array<[string, string]> }>
  suggestions: LdapAttributeSuggestion[]
  /** 目录返回了这些敏感属性（值已隐去），出现即说明目录 ACL 可能过宽 */
  sensitiveAttributes: string[]
}

export interface MemberSyncOutcome {
  added: number
  updated: number
  /** 缺少必要属性（比如没有姓名）而被跳过的条目 */
  skipped: number
}

/** 代码分析工具的探测结果 */
export interface ToolStatus {
  found: boolean
  path?: string
  version?: string
  /** configured = 设置里指定；path = 从 PATH 找到；bundled = 随应用分发 */
  source?: string
  error?: string
}

/** 应用数据目录与分析默认路径 */
export interface AnalysisDefaults {
  appDataDir: string
  defaultCacheDir: string
  defaultCodeRoot: string
}

export interface DirUsage {
  exists: boolean
  bytes: number
  files: number
  path: string
}

export interface ClearResult {
  removedBytes: number
  removedEntries: number
}

/** 安装进度：最后一条 done=true */
export interface InstallEvent {
  line?: string
  done: boolean
  ok: boolean
  path?: string
  message?: string
}

/** 仓库扫描结果：文件清单 + 从内容里认出的结构标记 */
export interface RepoFile {
  path: string
  language: string
  bytes: number
  flags: string[]
  /** Java import 全名 / 前端 import 说明符，用来推导模块依赖 */
  imports?: string[]
}

export interface RepoScan {
  root: string
  files: RepoFile[]
  truncated: boolean
}

export interface Hotspot {
  path: string
  changes: number
}

export interface RepoBranch {
  name: string
  sha: string
  /** 来自 refs/remotes/origin/* */
  remote: boolean
  current: boolean
  default: boolean
  latest: boolean
  /** 最近一次提交时间（ISO） */
  committedAt: string
}

export interface RepoBranches {
  current: string | null
  defaultBranch: string | null
  /** 最近提交的分支名 */
  latestBranch: string | null
  /** 用于创建 worktree 的完整引用 */
  latestRef: string | null
  branches: RepoBranch[]
}

/** 项目画像的存储行：payload 是前端定义的画像 JSON */
export interface ProfileRow {
  projectId: string
  repoId: number
  headCommit?: string
  generatedAt: string
  payload: string
}

export interface Transport extends DataStore {
  readonly kind: 'tauri' | 'web'
  http(req: HttpRequestInput): Promise<HttpResponseOutput>
  llmStream(
    req: LlmChatRequest,
    onEvent: (event: LlmStreamEvent) => void,
  ): Promise<LlmStreamHandle>
  /** 执行本机命令（仅桌面端）；cwd 必须在 allowedCwds 里 */
  shellRun(
    req: ShellRunRequest,
    onEvent: (event: ShellEvent) => void,
  ): Promise<ShellRunResult>
  /** 取消正在执行的命令并杀掉进程树 */
  shellCancel(runId: string): Promise<void>
  /** 探测分析工具与环境依赖（codegraph / graphify / git）是否可用（仅桌面端） */
  toolStatus(kind: 'codegraph' | 'graphify' | 'git', configuredPath?: string): Promise<ToolStatus>
  analysisDefaults(): Promise<AnalysisDefaults>
  dirUsage(path: string): Promise<DirUsage>
  /** 清空缓存目录的内容（保留目录），仅桌面端可用。codeRoot 用于校验两者不重叠 */
  clearCache(path: string, codeRoot?: string): Promise<ClearResult>
  /** 后台安装分析工具，进度通过回调推送；命令立即返回 */
  installTool(kind: 'codegraph' | 'graphify', onEvent: (event: InstallEvent) => void): Promise<void>
  cancelInstall(kind: 'codegraph' | 'graphify'): Promise<void>
  /** 扫描本地仓库的文件清单（桌面端） */
  scanRepo(path: string): Promise<RepoScan>
  /** 近期改动热点（基于本地 git 历史） */
  gitHotspots(path: string, days: number): Promise<Hotspot[]>
  /** 当前 HEAD；没有 git 仓库时返回空串 */
  gitHead(path: string): Promise<string>
  /** 本地与远程分支引用；画像用它确认默认分支 */
  gitBranches(path: string): Promise<RepoBranches>
  /** 为一个引用创建临时 worktree，返回目录；用于不改工作区地分析默认分支 */
  gitWorktreeAdd(path: string, reference: string): Promise<string>
  gitWorktreeRemove(path: string, worktree: string): Promise<void>
  /** 在代码根目录下按仓库路径递归建目录，返回实际新建的路径 */
  ensureDirs(root: string, paths: string[]): Promise<string[]>
  /** 浅克隆仓库；目录里已有内容时跳过（skipped=true） */
  gitClone(url: string, dest: string, branch?: string, depth?: number): Promise<{ path: string, skipped: boolean }>
  /** 读取文本文件（skill 用），限 64KB */
  readTextFile(path: string): Promise<string>
  profilesGet(projectId: string): Promise<ProfileRow[]>
  profileUpsert(row: ProfileRow): Promise<void>
  profilesDelete(projectId: string): Promise<void>
}
