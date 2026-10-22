import type { GitLabSettings } from '../config/settings'
import type { CommitFileChange, GitCommit, GitLabProjectRef } from '../domain/types'
import type { HttpResponseOutput, Transport } from '../bridge/types'
import { transport } from '../bridge'

/** 适配器层的统一错误，UI 上直接展示 message 即可。 */
export class AdapterError extends Error {
  readonly status?: number
  readonly detail?: string

  constructor(message: string, status?: number, detail?: string) {
    super(message)
    this.name = 'AdapterError'
    this.status = status
    this.detail = detail
  }
}

interface RawGitLabCommit {
  id: string
  short_id: string
  title: string
  message: string
  author_name: string
  author_email: string
  authored_date: string
  committed_date: string
  created_at: string
  web_url: string
  stats?: { additions: number, deletions: number, total: number }
}

interface RawGitLabProject {
  id: number
  name: string
  path_with_namespace: string
  web_url: string
  default_branch?: string
  description?: string | null
  visibility?: string
  archived?: boolean
  ssh_url_to_repo?: string
  http_url_to_repo?: string
  namespace?: { full_path?: string }
}

interface RawGitLabDiff {
  old_path: string
  new_path: string
  a_mode: string
  b_mode: string
  new_file: boolean
  renamed_file: boolean
  deleted_file: boolean
  /** 统一 diff 文本。提交列表接口不返回，单个提交的 diff 接口才有 */
  diff?: string
}

/** 单个提交里一个文件的改动，带 diff 正文 */
export interface CommitPatch {
  path: string
  oldPath?: string
  isNew: boolean
  isDeleted: boolean
  isRenamed: boolean
  /** 统一 diff 文本；二进制文件或超大改动时可能为空 */
  patch: string
}

export interface CommitQuery {
  since: string
  until: string
  /** GitLab 的 author 参数接受 username 或 email，留空则只按时间过滤 */
  author?: string
  refName?: string
  perPage: number
  maxCommits: number
  /** 需要 fileChanges 时逐条拉 diff，请求数会明显上升 */
  fetchFileChanges: boolean
  signal?: AbortSignal
}

export interface ProjectDiscoveryOptions {
  perPage: number
  /** 数量上限，达到即截断，避免在大实例上无限翻页 */
  maxProjects: number
  onProgress?: (fetched: number, page: number) => void
}

export interface ProjectDiscoveryResult {
  projects: GitLabProjectRef[]
  /** 是否因达到上限而截断 */
  truncated: boolean
}

/**
 * GitLab REST v4 客户端。
 *
 * 只读，不做任何写操作。所有请求都经由传输层，桌面端里实际由 Rust 发出，
 * 因此不受浏览器 CORS 限制，token 也不会出现在页面上下文中。
 */
export class GitLabClient {
  private readonly tp: Transport
  private readonly cfg: GitLabSettings

  constructor(cfg: GitLabSettings, tp?: Transport) {
    this.cfg = cfg
    this.tp = tp ?? transport()
  }

  private get apiBase() {
    const base = this.cfg.baseUrl.trim().replace(/\/+$/, '')
    if (!base)
      throw new AdapterError('未配置 GitLab 地址，请到「设置 → GitLab」填写')
    return `${base}/api/v4`
  }

  private headers(): Record<string, string> {
    if (!this.cfg.token.trim())
      throw new AdapterError('未配置 GitLab Access Token，请到「设置 → GitLab」填写')
    return {
      'PRIVATE-TOKEN': this.cfg.token.trim(),
      'accept': 'application/json',
    }
  }

  private async raw(path: string, query: Record<string, string | number | boolean | undefined | null> = {}) {
    const url = new URL(`${this.apiBase}${path}`)
    for (const [k, v] of Object.entries(query)) {
      // null 也要跳过：Rust 侧的 Option 字段序列化出来就是 null，
      // 照发会变成字面量 `ref_name=null`，GitLab 会当成一条不存在的分支，直接返回空
      if (v !== undefined && v !== null && v !== '')
        url.searchParams.set(k, String(v))
    }

    const res: HttpResponseOutput = await this.tp.http({
      url: url.toString(),
      method: 'GET',
      headers: this.headers(),
      timeoutMs: 30000,
      allowInsecureTls: this.cfg.allowInsecureTls,
    })

    if (!res.ok) {
      throw new AdapterError(
        describeHttpError(res.status, path),
        res.status,
        res.body.slice(0, 500),
      )
    }
    return res
  }

  private async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const res = await this.raw(path, query)
    try {
      return JSON.parse(res.body) as T
    }
    catch {
      throw new AdapterError(`${path} 返回的不是合法 JSON`, res.status, res.body.slice(0, 200))
    }
  }

  /** 连通性自检，设置页的「测试连接」用这个。 */
  async ping(): Promise<{ version: string, user: string }> {
    const [version, user] = await Promise.all([
      this.get<{ version: string }>('/version'),
      this.get<{ username: string, name: string }>('/user'),
    ])
    return { version: version.version, user: user.name || user.username }
  }

  async searchProjects(search: string, limit = 30): Promise<GitLabProjectRef[]> {
    const raw = await this.get<RawGitLabProject[]>('/projects', {
      search,
      membership: true,
      simple: true,
      order_by: 'last_activity_at',
      per_page: limit,
    })
    return raw.map(p => this.toProjectRef(p))
  }

  /**
   * 同步 token 有权限的全部仓库，这是仓库目录的默认来源。
   *
   * `membership=true` 取的是「当前用户是其成员」的项目——包含通过 group 继承的成员身份。
   * 不加这个参数会返回实例上所有公开/内部项目，在 gitlab.com 这类大实例上是天文数字，
   * 而且与「这个人可能提交代码的仓库」毫无关系。
   */
  async listAccessibleProjects(opts: ProjectDiscoveryOptions): Promise<ProjectDiscoveryResult> {
    return this.paginateProjects('/projects', { membership: true }, opts)
  }

  /** 列出某个 group（含子 group）下的全部项目，用于把范围收窄到特定业务线。 */
  async listGroupProjects(
    groupPath: string,
    opts: ProjectDiscoveryOptions,
  ): Promise<ProjectDiscoveryResult> {
    return this.paginateProjects(
      `/groups/${encodeURIComponent(groupPath)}/projects`,
      { include_subgroups: true },
      opts,
    )
  }

  /**
   * 翻页遍历项目列表。
   *
   * GitLab 的 per_page 上限是 100，所以请求值要先夹住；
   * 结束条件用「本页数量 < 请求数量」而不是「本页为空」，
   * 这样最后一页刚好装满时也能少发一次空请求。
   */
  private async paginateProjects(
    path: string,
    baseQuery: Record<string, string | number | boolean>,
    opts: ProjectDiscoveryOptions,
  ): Promise<ProjectDiscoveryResult> {
    const size = Math.max(1, Math.min(opts.perPage, 100))
    const byId = new Map<number, GitLabProjectRef>()
    let page = 1
    let truncated = false

    for (;;) {
      const batch = await this.get<RawGitLabProject[]>(path, {
        ...baseQuery,
        simple: true,
        order_by: 'last_activity_at',
        per_page: size,
        page,
      })

      if (!batch.length)
        break

      for (const raw of batch)
        byId.set(raw.id, this.toProjectRef(raw))

      opts.onProgress?.(byId.size, page)

      if (byId.size >= opts.maxProjects) {
        truncated = true
        break
      }
      if (batch.length < size)
        break
      page += 1
    }

    return {
      projects: [...byId.values()].slice(0, opts.maxProjects),
      truncated,
    }
  }

  /** 按 path_with_namespace 精确取项目。 */
  async getProject(pathWithNamespace: string): Promise<GitLabProjectRef> {
    const raw = await this.get<RawGitLabProject>(`/projects/${encodeURIComponent(pathWithNamespace)}`)
    return this.toProjectRef(raw)
  }

  /**
   * simple=true 时 GitLab 只返回部分字段，web_url 有可能缺失，
   * 这种情况下按 path_with_namespace 拼一个，保证界面上的跳转链接始终可用。
   */
  private toProjectRef(raw: RawGitLabProject): GitLabProjectRef {
    return {
      id: raw.id,
      pathWithNamespace: raw.path_with_namespace,
      name: raw.name,
      webUrl: raw.web_url || `${this.cfg.baseUrl.trim().replace(/\/+$/, '')}/${raw.path_with_namespace}`,
      defaultBranch: raw.default_branch || undefined,
    }
  }

  /**
   * 拉取时间窗内的提交。
   *
   * **只取一条分支**，默认是仓库的默认分支（调用方传 refName）。
   * 这里刻意不带 `all=true`：它会把所有 ref 上的提交都拉回来，实测在一个
   * 多分支仓库里多出 11 条「Merge branch …」提交，而这些提交不属于任何当前分支
   * （`/commits/:sha/refs?type=branch` 返回空）。这类提交既不是本人写的工作，
   * 也没法归到任何一条线上，混进来只会把「今天有没有提交」这件事搅浑。
   *
   * 另一个现实原因：这个实例里不少仓库的默认分支本身就是 `feature/*`
   * （还有几个 master 已经几个月没提交），所以「主分支」只能是仓库的默认分支，
   * 不能想当然地按 main/master 去取，否则会得到一片空白。
   */
  async listCommits(project: GitLabProjectRef, query: CommitQuery): Promise<GitCommit[]> {
    const commits: GitCommit[] = []
    let page = 1

    while (commits.length < query.maxCommits) {
      if (query.signal?.aborted)
        break

      const batch = await this.get<RawGitLabCommit[]>(
        `/projects/${project.id}/repository/commits`,
        {
          since: query.since,
          until: query.until,
          with_stats: true,
          author: query.author,
          ref_name: query.refName,
          per_page: Math.min(query.perPage, query.maxCommits - commits.length),
          page,
        },
      )

      if (!batch.length)
        break

      for (const c of batch) {
        commits.push({
          id: c.id,
          shortId: c.short_id,
          projectId: project.id,
          projectPath: project.pathWithNamespace,
          title: c.title,
          message: c.message,
          authorName: c.author_name,
          authorEmail: c.author_email,
          authoredDate: c.authored_date,
          committedDate: c.committed_date,
          webUrl: c.web_url,
          refName: query.refName,
          stats: c.stats,
        })
      }

      if (batch.length < query.perPage)
        break
      page += 1
    }

    const trimmed = commits.slice(0, query.maxCommits)
    if (query.fetchFileChanges && trimmed.length) {
      await this.attachFileChanges(project.id, trimmed, query.signal)
    }
    return trimmed
  }

  /** 并发拉取各提交的变更文件列表，单个失败不影响其它提交。 */
  private async attachFileChanges(projectId: number, commits: GitCommit[], signal?: AbortSignal) {
    const limit = 6
    let cursor = 0

    const worker = async () => {
      while (cursor < commits.length) {
        const commit = commits[cursor++]
        if (signal?.aborted)
          return
        try {
          commit.fileChanges = await this.getCommitDiff(projectId, commit.id)
        }
        catch {
          commit.fileChanges = []
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(limit, commits.length) }, worker))
  }

  /**
   * 单个提交的改动文件与正文。
   *
   * 正文是给判定用的：提交信息不规范时，只有代码能说明做了什么。
   * 单个文件正文截到 20k 字符——生成文件、vendored 代码可能有几十万行，
   * 整段留在内存里没有意义，判定侧也只会取其中几十行。
   */
  async getCommitDiff(projectId: number, sha: string): Promise<CommitFileChange[]> {
    const raw = await this.get<RawGitLabDiff[]>(
      `/projects/${projectId}/repository/commits/${sha}/diff`,
      { per_page: 100 },
    )
    return raw.map((d) => {
      const patch = (d.diff ?? '').slice(0, 20_000)
      let additions = 0
      let deletions = 0
      for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++'))
          additions++
        else if (line.startsWith('-') && !line.startsWith('---'))
          deletions++
      }
      return {
        path: d.new_path,
        oldPath: d.old_path !== d.new_path ? d.old_path : undefined,
        isNew: d.new_file,
        isDeleted: d.deleted_file,
        isRenamed: d.renamed_file,
        additions,
        deletions,
        patch,
      }
    })
  }

  /**
   * 单个提交的改动正文。
   *
   * 和 `getCommitDiff` 打的是同一个接口，区别在于要不要 diff 文本：
   * 检查引擎只关心「改了哪些文件」，正文是噪音，存进库里也没人看；
   * 而人工核查「这条提交到底改了什么」时，文件清单回答不了问题，只有 diff 能。
   */
  async getCommitPatch(projectId: number, sha: string): Promise<CommitPatch[]> {
    const raw = await this.get<RawGitLabDiff[]>(
      `/projects/${projectId}/repository/commits/${sha}/diff`,
      { per_page: 100 },
    )
    return raw.map(d => ({
      path: d.new_path,
      oldPath: d.old_path !== d.new_path ? d.old_path : undefined,
      isNew: d.new_file,
      isDeleted: d.deleted_file,
      isRenamed: d.renamed_file,
      patch: d.diff ?? '',
    }))
  }

  /** 通过 email 反查 GitLab 用户，用于自动补全成员映射。 */
  async findUserByEmail(email: string): Promise<{ id: number, username: string, name: string } | null> {
    const users = await this.get<Array<{ id: number, username: string, name: string }>>('/users', {
      search: email,
      per_page: 10,
    })
    return users.find(u => u.username && u.name) ?? null
  }
}

function describeHttpError(status: number, path: string): string {
  if (status === 401)
    return 'GitLab Token 无效或已过期'
  if (status === 403)
    return 'GitLab Token 权限不足，需要 read_api 权限'
  if (status === 404)
    return `GitLab 上找不到该资源（${path}），可能是项目路径写错或 Token 无权访问`
  if (status === 429)
    return 'GitLab 请求过于频繁，请稍后重试或在设置里调低并发'
  return `GitLab 请求失败：HTTP ${status}（${path}）`
}
