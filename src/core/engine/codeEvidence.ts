import type { GitLabClient } from '../adapters/gitlab'
import type { AnalysisMcpServer, AppSettings } from '../config/settings'
import type { GitCommit, Project, WorkSignal } from '../domain/types'
import type { LlmClient } from '../llm/client'
import type { ProjectProfile } from './profile'
import { invoke } from '@tauri-apps/api/core'
import { isDesktop, transport } from '../bridge'
import { formatDateCN } from '@/lib/format'

/**
 * 申报 vs 代码证据。
 *
 * 活动页之前只能看「申报了什么」和「提交了几条」；提交标题不规范时，
 * 两列都说明不了实际在干什么。这里换一个方向：
 *
 * 1. 先确保本地仓库有 codegraph 索引（没有索引时工具只会返回空结果）；
 * 2. 拉取提交的改动文件，用 codegraph 按文件/标题检索相关符号和源码；
 * 3. 把「申报内容」和「代码证据」一起交给模型，逐条判断是否对得上。
 *
 * 模型看到的是代码符号和源码片段，不是只用提交消息复述。
 */

export interface EvidenceReportEntry {
  date: string
  memberName: string
  content: string
  hours: number
}

export interface EvidenceInput {
  /** 人员活动可能跨多个项目；项目活动只传一个 */
  projects: Project[]
  profiles: Array<ProjectProfile | null>
  commits: GitCommit[]
  signals?: WorkSignal[]
  reports: EvidenceReportEntry[]
  settings: AppSettings
  llm: LlmClient
  gitlab?: GitLabClient | null
  scopeLabel: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export interface EvidenceRepoState {
  path: string
  localPath?: string
  action?: string
  error?: string
}

export interface EvidenceResult {
  markdown: string
  usedCodegraph: boolean
  repos: EvidenceRepoState[]
  failures: string[]
}

interface McpTool {
  serverId: string
  serverName: string
  name: string
  qualifiedName: string
}

interface McpListResponse {
  tools: McpTool[]
  errors: string[]
}

const MAX_COMMITS = 60
const MAX_REPORTS = 40
const MAX_FILE_COMMITS = 80
const MAX_FILES_PER_COMMIT = 8
const MAX_CODE_CHARS = 2500
const MAX_REPO_CODE = 2
const MAX_PROMPT_CHARS = 18_000

function clip(text: string, max: number) {
  const value = text.trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function codegraphServers(settings: AppSettings): AnalysisMcpServer[] {
  const configured = (settings.analysis.mcpServers ?? [])
    .filter(server => server.enabled && server.command.trim())
  const named = configured.find(server => server.name.trim().toLowerCase() === 'codegraph')
  if (named)
    return [named]

  const command = settings.analysis.codegraphPath.trim() || 'codegraph'
  return [{
    id: 'builtin-codegraph',
    name: 'codegraph',
    transport: 'stdio',
    command,
    args: 'serve --mcp',
    env: '',
    enabled: true,
  }]
}

async function listTools(servers: AnalysisMcpServer[]): Promise<McpListResponse> {
  if (!isDesktop())
    return { tools: [], errors: ['浏览器模式不能调用 codegraph'] }
  try {
    return await invoke<McpListResponse>('mcp_list_tools', { servers })
  }
  catch (err) {
    return {
      tools: [],
      errors: [`连接 codegraph 失败：${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

function toolText(raw: unknown): string {
  if (!raw || typeof raw !== 'object')
    return String(raw ?? '')
  const obj = raw as Record<string, unknown>
  const content = obj.content
  if (!Array.isArray(content))
    return clip(JSON.stringify(raw), MAX_CODE_CHARS)
  const text = content.map((item) => {
    if (!item || typeof item !== 'object')
      return String(item)
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string')
      return block.text
    if (block.type === 'resource') {
      const resource = block.resource as Record<string, unknown> | undefined
      if (resource && typeof resource.text === 'string')
        return resource.text
    }
    return JSON.stringify(item)
  }).join('\n')
  return clip(text, MAX_CODE_CHARS)
}

async function queryCodegraph(
  servers: AnalysisMcpServer[],
  tool: McpTool,
  query: string,
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted)
    return ''
  try {
    const raw = await invoke<unknown>('mcp_call_tool', {
      server: tool.serverId,
      tool: tool.name,
      args: {
        query,
        projectPath,
        maxFiles: 6,
      },
      servers,
    })
    return toolText(raw)
  }
  catch (err) {
    return `codegraph 查询失败：${err instanceof Error ? err.message : String(err)}`
  }
}

/** 确保每个本地仓库都有索引；失败只记录，不阻断对比 */
async function ensureIndexes(
  settings: AppSettings,
  repos: Array<{ path: string, localPath?: string }>,
  onProgress?: (message: string) => void,
): Promise<EvidenceRepoState[]> {
  const states: EvidenceRepoState[] = []
  for (const repo of repos) {
    if (!repo.localPath) {
      states.push({ path: repo.path, error: '没有本地代码目录，无法建立索引' })
      continue
    }
    if (!isDesktop()) {
      states.push({ path: repo.path, localPath: repo.localPath, error: '浏览器模式不能建立 codegraph 索引' })
      continue
    }
    onProgress?.(`正在确保 ${repo.path} 的 codegraph 索引…`)
    try {
      const result = await transport().analysisIndex(repo.localPath, settings.analysis.codegraphPath)
      states.push({ path: repo.path, localPath: repo.localPath, action: result.action })
    }
    catch (err) {
      states.push({
        path: repo.path,
        localPath: repo.localPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return states
}

function commitLine(commit: GitCommit) {
  const files = (commit.fileChanges ?? [])
    .slice(0, MAX_FILES_PER_COMMIT)
    .map(file => file.path)
  const branches = commit.branches?.length ? ` [分支 ${commit.branches.join('、')}]` : ''
  return `- ${formatDateCN(commit.authoredDate.slice(0, 10))} ${commit.authorName}${branches}：${commit.title}`
    + (files.length ? `\n  改动文件：${files.join('、')}` : '')
}

function reportLine(entry: EvidenceReportEntry) {
  return `- ${formatDateCN(entry.date)} ${entry.memberName}（${entry.hours}h）：${clip(entry.content, 200)}`
}

function fallbackMarkdown(input: EvidenceInput, states: EvidenceRepoState[], failures: string[]) {
  const rows = input.reports.slice(0, MAX_REPORTS).map((entry) => {
    const sameDay = input.commits.filter(commit =>
      commit.authoredDate.slice(0, 10) === entry.date
      && commit.authorName === entry.memberName,
    )
    const evidence = sameDay.length
      ? sameDay.map(commit => commit.title).join('；')
      : '没有对应提交'
    const files = [...new Set(sameDay.flatMap(commit => (commit.fileChanges ?? []).map(file => file.path)))]
      .slice(0, 6)
      .join('、')
    return `| ${formatDateCN(entry.date)} | ${entry.memberName} | ${clip(entry.content, 120)} | ${evidence} | ${files || '—'} |`
  })
  return [
    '## 申报与代码证据',
    '',
    '| 日期 | 人员 | 申报内容 | 代码证据 | 改动文件 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    states.length
      ? `索引状态：${states.map(state => `${state.path}${state.action ? `（${state.action}）` : state.error ? `（${state.error}）` : ''}`).join('；')}`
      : '没有可用的本地代码目录，未建立 codegraph 索引。',
    ...(failures.length ? ['', `未完成项：${failures.slice(0, 5).join('；')}`] : []),
  ].join('\n')
}

export async function analyzeActivityEvidence(input: EvidenceInput): Promise<EvidenceResult> {
  const failures: string[] = []
  const profileRepos = new Map<string, string>()
  for (const profile of input.profiles) {
    for (const repo of profile?.repos ?? []) {
      if (repo.localPath)
        profileRepos.set(repo.repoPath, repo.localPath)
    }
  }

  /*
   * 不要求一定生成过画像：本地代码根目录按 `<namespace>/<repo>` 约定
   * 直接拼出候选路径。没有画像的项目也能尝试建索引；路径不存在时
   * analysisIndex 会明确报错，不会静默跳过。
   */
  const codeRoot = input.settings.analysis.codeRoot.trim().replace(/[\\/]+$/, '')
  const repos: Array<{ path: string, localPath?: string }> = []
  const seen = new Set<string>()
  for (const project of input.projects) {
    for (const repo of project.repos ?? []) {
      if (seen.has(repo.pathWithNamespace))
        continue
      seen.add(repo.pathWithNamespace)
      repos.push({
        path: repo.pathWithNamespace,
        localPath: repo.localPath
          || profileRepos.get(repo.pathWithNamespace)
          || (codeRoot ? `${codeRoot}/${repo.pathWithNamespace}` : undefined),
      })
    }
  }
  for (const [path, localPath] of profileRepos) {
    if (seen.has(path))
      continue
    seen.add(path)
    repos.push({ path, localPath })
  }

  /*
   * 只给「这段时间真的有提交」的仓库建索引。项目可能关联几十个仓库，
   * 把没提交的也索引一遍既慢又会把索引失败提示刷满页面。
   */
  const commitPaths = new Set(input.commits.map(commit => commit.projectPath))
  const relevantRepos = repos.filter((repo) => {
    if (commitPaths.has(repo.path))
      return true
    const leaf = repo.path.split('/').pop()
    return Boolean(leaf && [...commitPaths].some(path => path.endsWith(`/${leaf}`) || path === leaf))
  })
  const repoStates = await ensureIndexes(input.settings, relevantRepos, input.onProgress)

  /*
   * 活动分析里提交默认没有 fileChanges（逐条拉 diff 太贵）。这里只给
   * 最近的一批提交补文件列表，用来给 codegraph 提供检索入口。
   */
  if (input.gitlab) {
    const recent = [...input.commits]
      .sort((a, b) => b.authoredDate.localeCompare(a.authoredDate))
      .filter(commit => !commit.fileChanges?.length)
      .slice(0, MAX_FILE_COMMITS)
    const byProject = new Map<number, GitCommit[]>()
    for (const commit of recent) {
      const list = byProject.get(commit.projectId) ?? []
      list.push(commit)
      byProject.set(commit.projectId, list)
    }
    for (const [projectId, commits] of byProject) {
      input.onProgress?.(`正在读取 ${commits.length} 条提交的改动文件…`)
      try {
        await input.gitlab.attachFileChanges(projectId, commits, input.signal)
      }
      catch (err) {
        failures.push(`提交改动文件读取失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  let codegraphUsed = false
  const codeSections: string[] = []
  const servers = codegraphServers(input.settings)
  const listed = await listTools(servers)
  const explore = listed.tools.find(tool => /codegraph/i.test(tool.serverName) && /explore/i.test(tool.name))
    ?? listed.tools.find(tool => /explore/i.test(tool.name))

  if (listed.errors.length)
    failures.push(...listed.errors)

  if (explore) {
    const usableRepos = repoStates.filter(state => state.localPath && !state.error)
    for (const state of usableRepos.slice(0, MAX_REPO_CODE)) {
      const repoSuffix = state.localPath!.replace(/[\\/]+$/, '')
      const repoCommits = input.commits
        .filter(commit => commit.projectPath === state.path || commit.projectPath.endsWith(state.path.split('/').pop() ?? ''))
        .slice(0, 60)
      const files = [...new Set(repoCommits.flatMap(commit => (commit.fileChanges ?? []).map(file => file.path)))]
        .slice(0, 20)
      const query = [
        ...repoCommits.slice(0, 8).map(commit => commit.title),
        ...files.slice(0, 20),
      ].join('\n')
      if (!query.trim())
        continue
      input.onProgress?.(`正在用 codegraph 检索 ${state.path} 的相关代码…`)
      const text = await queryCodegraph(servers, explore, query, repoSuffix, input.signal)
      if (text && !/查询失败/.test(text)) {
        codegraphUsed = true
        codeSections.push(`### ${state.path}\n${text}`)
      }
      else if (text) {
        failures.push(`${state.path}：${clip(text, 200)}`)
      }
    }
  }

  const commits = [...input.commits]
    .sort((a, b) => b.authoredDate.localeCompare(a.authoredDate))
    .slice(0, MAX_COMMITS)
  const reports = input.reports.slice(0, MAX_REPORTS)

  if (!input.llm.configured) {
    return {
      markdown: fallbackMarkdown(input, repoStates, failures),
      usedCodegraph: false,
      repos: repoStates,
      failures: [...failures, '模型未配置，只输出提交/文件层面的对照'],
    }
  }

  const rawPrompt = [
    `范围：${input.scopeLabel}`,
    `项目：${input.projects.map(project => `${project.name}${project.code ? `（${project.code}）` : ''}`).join('、') || '—'}`,
    '',
    '## 日报申报',
    reports.map(reportLine).join('\n') || '（没有申报记录）',
    '',
    '## 提交与改动文件',
    commits.map(commitLine).join('\n') || '（没有提交）',
    '',
    codeSections.length
      ? `## codegraph 检索到的代码证据\n${codeSections.join('\n\n')}`
      : '## codegraph 检索到的代码证据\n（没有可用的本地索引或查询结果，只能依据提交标题和改动文件判断）',
  ].join('\n')
  /*
   * 内网模型对超长提示很敏感：实测 7 万字符时直接返回空内容。
   * 先压到 1.8 万字符以内；超出部分不是丢掉结论，而是丢掉较早的
   * 提交/申报明细——代码证据和最近记录优先保留。
   */
  const prompt = rawPrompt.length > MAX_PROMPT_CHARS
    ? `${rawPrompt.slice(0, MAX_PROMPT_CHARS)}\n…（内容过长已截断）`
    : rawPrompt

  const system = `你是研发工作核查员。给你一个人或项目在一段时间内的日报申报、提交记录和代码证据（codegraph 抽取的符号/源码），请判断「报了什么」和「实际干了什么」是否对得上。

纪律：
1. 先看代码证据，再看申报；不要因为申报写了就认为做了。
2. 逐条给出：日期、人员、申报内容摘要、代码实际改动（具体到模块/文件/符号）、判定（一致 / 部分一致 / 无代码证据 / 无法核对）、依据。
3. 没有对应提交或代码证据时，写「无代码证据」，但不要说成「没工作」——会议、评审、调研可能没有代码痕迹；这类写「无法核对」。
4. 代码证据只覆盖检索到的片段；不要因为片段里没看到某个功能就断言「没做」。
5. 提交标题不规范时，以改动文件和 codegraph 的符号/源码为准。
6. 不评价绩效，只陈述事实和可跟进的点。

输出 markdown：
## 结论
不超过三句话，说明申报与代码的整体吻合程度和主要缺口。
## 逐条对照
表格：| 日期 | 人员 | 申报 | 代码实际改动 | 判定 | 依据 |
## 建议
不超过 3 条列表。`

  input.onProgress?.('正在让模型对照申报与代码证据…')
  try {
    let completion
    try {
      completion = await input.llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        { signal: input.signal, maxTokens: 8192 },
      )
    }
    catch (first) {
      /*
       * 长上下文 + 推理型模型时，输出额度可能先被 reasoning 消耗光，
       * 表现为「没有返回任何内容」。用截短后的提示再试一次；
       * 重试成功时不再把第一次失败展示成错误，避免用户以为整体失败了。
       */
      const retryPrompt = prompt.length > 16_000 ? `${prompt.slice(0, 16_000)}\n…（内容过长已截断）` : prompt
      try {
        completion = await input.llm.complete(
          [
            { role: 'system', content: system },
            { role: 'user', content: retryPrompt },
          ],
          { signal: input.signal, maxTokens: 8192 },
        )
      }
      catch (second) {
        throw new Error(
          `首次：${first instanceof Error ? first.message : String(first)}；`
          + `重试：${second instanceof Error ? second.message : String(second)}`,
        )
      }
    }
    const text = completion.text.trim()
    if (!text)
      failures.push('模型返回了空内容，已退回提交和文件层面的对照')
    return {
      markdown: text || fallbackMarkdown(input, repoStates, failures),
      usedCodegraph: codegraphUsed,
      repos: repoStates,
      failures,
    }
  }
  catch (err) {
    failures.push(`模型分析失败：${err instanceof Error ? err.message : String(err)}`)
    return {
      markdown: fallbackMarkdown(input, repoStates, failures),
      usedCodegraph: codegraphUsed,
      repos: repoStates,
      failures,
    }
  }
}
