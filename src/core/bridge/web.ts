import type {
  DailyReport,
  GitCommit,
  InspectionResult,
  MemberProfile,
  Project,
} from '../domain/types'
import type {
  DataStore,
  HttpRequestInput,
  HttpResponseOutput,
  InspectionFilter,
  LlmChatRequest,
  LlmStreamEvent,
  Transport,
} from './types'
import { buildLlmRequest, parseLlmStream } from './protocol'

/**
 * 浏览器开发态实现。
 *
 * 只在 `pnpm dev` 直接开页面时使用：这样调 UI 不必每次编译 Rust。
 * 受 CORS 限制，直连内网 GitLab 可能被拦，需要在桌面端里跑。
 *
 * 桌面端的数据落在 SQLite 里，这里的 localStorage 只是等价替代，
 * 两种模式的数据互不相通——调界面用这个，验证数据行为要用桌面端。
 */

const KEY_SETTINGS = 'ti:db:settings'
const KEY_REPORTS = 'ti:db:reports'
const KEY_INSPECTIONS = 'ti:db:inspections'
const KEY_PROJECTS = 'ti:db:projects'
const KEY_MEMBERS = 'ti:db:members'

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key)
  if (!raw)
    return fallback
  try {
    return JSON.parse(raw) as T
  }
  catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

/**
 * 把上一版浏览器存储里的数据搬到新的 key 下。
 *
 * 旧版是「每个命名空间一个 key」的自由格式，配置存在 `ti:app:settings`。
 * 用户在预览里填过的配置只存在于那一份，改 key 而不迁移就等于把配置删了。
 */
function migrateLegacyStorage() {
  if (!localStorage.getItem(KEY_SETTINGS)) {
    const legacy = localStorage.getItem('ti:app:settings')
    if (legacy)
      localStorage.setItem(KEY_SETTINGS, legacy)
  }

  if (!localStorage.getItem(KEY_REPORTS)) {
    const legacy = localStorage.getItem('ti:reports:imported')
    if (legacy)
      localStorage.setItem(KEY_REPORTS, legacy)
  }

  if (!localStorage.getItem(KEY_INSPECTIONS)) {
    const collected: InspectionResult[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith('ti:inspections:'))
        continue
      const raw = localStorage.getItem(key)
      if (!raw)
        continue
      try {
        collected.push(JSON.parse(raw))
      }
      catch {
        // 单条损坏不影响其余记录的迁移
      }
    }
    if (collected.length)
      writeJson(KEY_INSPECTIONS, collected)
  }
}

/**
 * 翻译浏览器里失败的 fetch。
 *
 * 浏览器对「没发出去」这件事只给一句 "Failed to fetch"，自签证书、缺 CORS 头、
 * 网络不通三种原因在 JS 侧完全区分不了。这里把可能性按常见程度列出来，
 * 尤其要说清**浏览器模式绕不过证书校验**——不点破的话，用户会一直在设置里找那个开关。
 */
function describeFetchFailure(url: string, err: unknown): string {
  const host = url.split('//')[1]?.split('/')[0] ?? url

  if (err instanceof DOMException && err.name === 'AbortError')
    return `请求超时：${host} 在超时时间内没有响应`

  return `请求没发出去，浏览器没有给出原因。${host} 常见是这三种：`
    + '① 服务端证书不被信任（内网自签证书）——浏览器模式下页面绕不过证书校验，'
    + '要么先在浏览器里直接打开这个地址、手动信任证书，要么改用桌面端并在设置里打开「跳过 TLS 证书校验」；'
    + '② 服务端没返回 CORS 头，跨域被拦——这个只能改用桌面端；'
    + '③ 本机连不上该网络，或被代理、防火墙拦了'
}

export function createWebTransport(): Transport {
  migrateLegacyStorage()

  /* --- 日报聚合：供人员面板的「出现在几天的日报里」用 --- */

  function reportStats() {
    const byId = new Map<string, { count: number, lastDate: string }>()
    const byName = new Map<string, { count: number, lastDate: string }>()

    for (const [date, reports] of Object.entries(loadReports())) {
      for (const report of reports) {
        const bump = (map: Map<string, { count: number, lastDate: string }>, key: string) => {
          const cur = map.get(key) ?? { count: 0, lastDate: '' }
          map.set(key, {
            count: cur.count + 1,
            lastDate: date > cur.lastDate ? date : cur.lastDate,
          })
        }
        bump(byId, report.memberId)
        bump(byName, report.memberName)
      }
    }

    return { byId, byName }
  }

  /* --- 检查历史：整体存一个数组，按 (date, memberId) 去重 --- */

  function loadInspections(): InspectionResult[] {
    return readJson<InspectionResult[]>(KEY_INSPECTIONS, [])
  }

  function saveInspections(list: InspectionResult[]) {
    writeJson(KEY_INSPECTIONS, list)
  }

  /* --- 日报：按日期分桶 --- */

  function loadReports(): Record<string, DailyReport[]> {
    return readJson<Record<string, DailyReport[]>>(KEY_REPORTS, {})
  }

  const store: DataStore = {
    async settingsGet() {
      return localStorage.getItem(KEY_SETTINGS)
    },

    async settingsSet(value: string) {
      localStorage.setItem(KEY_SETTINGS, value)
    },

    async reportsUpsert(date, reports) {
      const all = loadReports()
      // 与桌面端一致：整天替换而不是逐条合并，避免留下当天已被删除的成员
      all[date] = reports
      writeJson(KEY_REPORTS, all)
      return reports.length
    },

    async reportsByDate(date) {
      return loadReports()[date] ?? []
    },

    async reportsDates() {
      return Object.keys(loadReports()).sort().reverse()
    },

    async reportsClear() {
      writeJson(KEY_REPORTS, {})
    },

    async inspectionsUpsert(result) {
      const list = loadInspections()
      const rest = list.filter(r => !(r.date === result.date && r.memberId === result.memberId))
      rest.push(result)
      saveInspections(rest)
    },

    async inspectionsList(filter?: InspectionFilter) {
      return loadInspections()
        .filter(r => !filter?.from || r.date >= filter.from)
        .filter(r => !filter?.to || r.date <= filter.to)
        .filter(r => !filter?.memberId || r.memberId === filter.memberId)
        .sort((a, b) => b.date.localeCompare(a.date) || a.memberName.localeCompare(b.memberName))
    },

    async inspectionsByKey(date, memberId) {
      return loadInspections().find(r => r.date === date && r.memberId === memberId) ?? null
    },

    async inspectionsDelete(date, memberId) {
      saveInspections(loadInspections().filter(r => !(r.date === date && r.memberId === memberId)))
    },

    async inspectionsClear() {
      saveInspections([])
    },

    async dataReset(mode: 'business' | 'all') {
      for (const key of [KEY_REPORTS, KEY_INSPECTIONS, KEY_PROJECTS, KEY_MEMBERS])
        localStorage.removeItem(key)
      if (mode === 'all')
        localStorage.removeItem(KEY_SETTINGS)
    },

    async inspectionsPrune(keepDays) {
      if (keepDays <= 0)
        return 0
      const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10)
      const list = loadInspections()
      const kept = list.filter(r => r.date >= cutoff)
      saveInspections(kept)
      return list.length - kept.length
    },

    async commitsUpsert(commits: GitCommit[]) {
      // 浏览器模式没有全文检索，提交缓存只用于留痕，直接丢弃即可
      return commits.length
    },

    /* --- 项目与人员：localStorage 里各存一个数组 --- */

    async projectsList() {
      const projects = readJson<Project[]>(KEY_PROJECTS, [])
      // 早先存下的数据没有 followed 字段。桌面端由迁移补默认值，
      // localStorage 没有迁移，不在这里回填的话会被当成「未关注」而全部隐藏。
      for (const p of projects) {
        if (p.followed === undefined)
          p.followed = true
      }
      return projects
    },

    async projectsUpsert(project) {
      const list = readJson<Project[]>(KEY_PROJECTS, [])
      const rest = list.filter(p => p.id !== project.id)
      writeJson(KEY_PROJECTS, [...rest, project])
      return project.id
    },

    async projectsDelete(id: string) {
      writeJson(KEY_PROJECTS, readJson<Project[]>(KEY_PROJECTS, []).filter(p => p.id !== id))
    },

    async projectsSyncFromGitlab(projects) {
      // 与 Rust 侧的 reconcile 保持同样的语义：新增 / 刷新 / 标 missing
      const list = readJson<Project[]>(KEY_PROJECTS, [])
      const claimed = new Set<string>()
      const outcome = { added: 0, updated: 0, missing: 0 }
      const now = new Date().toISOString()

      for (const remote of projects) {
        const local = list.find(p =>
          p.gitlabProjectId === remote.id || p.pathWithNamespace === remote.pathWithNamespace,
        )
        if (local) {
          claimed.add(local.id)
          Object.assign(local, {
            gitlabProjectId: remote.id,
            pathWithNamespace: remote.pathWithNamespace,
            webUrl: remote.webUrl,
            cloneUrl: remote.sshUrl ?? remote.httpUrl,
            defaultBranch: remote.defaultBranch,
            visibility: remote.visibility,
            namespace: remote.pathWithNamespace.split('/').slice(0, -1).join('/'),
            archived: Boolean(remote.archived),
            description: local.description ?? remote.description,
            syncStatus: 'synced' as const,
            syncError: undefined,
            syncedAt: now,
            updatedAt: now,
          })
          outcome.updated += 1
        }
        else {
          list.push({
            id: `gl-${remote.id}`,
            name: remote.name,
            description: remote.description,
            gitlabProjectId: remote.id,
            pathWithNamespace: remote.pathWithNamespace,
            webUrl: remote.webUrl,
            cloneUrl: remote.sshUrl ?? remote.httpUrl,
            defaultBranch: remote.defaultBranch,
            visibility: remote.visibility,
            namespace: remote.pathWithNamespace.split('/').slice(0, -1).join('/'),
            archived: Boolean(remote.archived),
            aliases: [],
            matchMode: 'exact',
            devMode: 'manual',
            enabled: true,
            followed: true,
            // GitLab 对账生成的项目没有关联配置，读取时会按 pathWithNamespace 拼一条
            links: [],
            repos: [],
            origin: 'synced' as const,
            syncStatus: 'synced' as const,
            syncedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          outcome.added += 1
        }
      }

      for (const p of list) {
        // 纯手工建、还没关联仓库的项目不该被标 missing
        if (claimed.has(p.id) || (!p.gitlabProjectId && !p.pathWithNamespace))
          continue
        p.syncStatus = 'missing'
        p.syncError = '在 GitLab 上未找到（可能已被删除或改名）'
        outcome.missing += 1
      }

      writeJson(KEY_PROJECTS, list)
      return outcome
    },

    async membersList() {
      const members = readJson<MemberProfile[]>(KEY_MEMBERS, [])
      for (const m of members) {
        if (m.followed === undefined)
          m.followed = true
      }
      // 桌面端这几个派生字段是 Rust 从 daily_reports 聚合出来的，
      // 这里补一份等价实现，否则浏览器预览下「日报」列永远是空的，
      // 看起来像功能坏了，实际只是两种模式的数据源不同
      const stats = reportStats()
      for (const member of members) {
        const hit = (member.reportMemberId && stats.byId.get(member.reportMemberId))
          || stats.byName.get(member.name)
        member.usageCount = hit?.count
        member.lastReportDate = hit?.lastDate
      }
      return members
    },

    async membersUpsert(member) {
      const list = readJson<MemberProfile[]>(KEY_MEMBERS, [])
      writeJson(KEY_MEMBERS, [...list.filter(m => m.id !== member.id), member])
      return member.id
    },

    async membersDelete(id: string) {
      writeJson(KEY_MEMBERS, readJson<MemberProfile[]>(KEY_MEMBERS, []).filter(m => m.id !== id))
    },

    async membersImport(members) {
      const list = readJson<MemberProfile[]>(KEY_MEMBERS, [])
      // 和 Rust 侧对齐：upsert 而不是无脑 push。
      // 直接 push 的话，导入已经存在的人会在 localStorage 里留下重复条目，
      // 而桌面端不会——两个模式行为不一致比其中一个有 bug 更难查
      const byId = new Map(list.map(m => [m.id, m]))
      for (const member of members)
        byId.set(member.id, member)
      writeJson(KEY_MEMBERS, [...byId.values()])
      return members.length
    },

    async ldapSync() {
      // LDAP 是二进制协议，浏览器里连不了；桌面端由 Rust 侧实现
      throw new Error('LDAP 同步只在桌面端可用，浏览器预览模式无法连接 LDAP 服务器')
    },

    async ldapProbe() {
      throw new Error('LDAP 诊断只在桌面端可用，浏览器预览模式无法连接 LDAP 服务器')
    },
  }

  return {
    kind: 'web',
    ...store,

    async toolStatus(kind) {
      // 浏览器里没有子进程，探不到本地工具；返回「未安装」让界面照常渲染
      return {
        found: false,
        error: `浏览器预览模式不检测 ${kind}，请在桌面端使用`,
      }
    },

    async analysisDefaults() {
      // 浏览器里没有应用数据目录，返回空值让界面按「未配置」展示，
      // 而不是把一句占位文案当成真实路径
      return {
        appDataDir: '（浏览器预览模式）',
        defaultCacheDir: '',
        defaultCodeRoot: '',
      }
    },

    async dirUsage(path: string) {
      return { exists: false, bytes: 0, files: 0, path }
    },

    async clearCache() {
      throw new Error('缓存清理只在桌面端可用')
    },

    async installTool() {
      throw new Error('工具安装只在桌面端可用')
    },

    async cancelInstall() {
      // 浏览器里没有安装进程可取消，静默返回
    },

    async analysisIndex() {
      throw new Error('codegraph 索引只在桌面端可用')
    },

    async scanRepo() {
      throw new Error('代码扫描只在桌面端可用')
    },

    async gitHotspots() {
      return []
    },

    async gitHead() {
      return ''
    },

    async gitBranches() {
      return { current: null, defaultBranch: null, latestBranch: null, latestRef: null, branches: [] }
    },

    async gitWorktreeAdd() {
      throw new Error('分支工作树只在桌面端可用')
    },

    async gitWorktreeRemove() {
      // 浏览器没有 worktree 可清理
    },

    async ensureDirs() {
      return []
    },

    async gitClone() {
      throw new Error('克隆仓库只在桌面端可用')
    },

    async readTextFile() {
      throw new Error('读取本地文件只在桌面端可用')
    },

    async shellRun() {
      throw new Error('命令执行只在桌面端可用，浏览器预览模式无法运行本机命令')
    },

    async shellCancel() {
      // 浏览器没有进程可取消
    },

    async profilesGet() {
      return []
    },

    async profileUpsert() {
      throw new Error('项目画像只在桌面端可用')
    },

    async profilesDelete() {
      // 浏览器预览没有画像存储，静默返回
    },

    async http(req: HttpRequestInput): Promise<HttpResponseOutput> {
      const started = performance.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 30000)
      try {
        const res = await fetch(req.url, {
          method: req.method ?? 'GET',
          headers: req.headers,
          body: req.body,
          signal: controller.signal,
        })
        const body = await res.text()
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          headers[k] = v
        })
        return {
          status: res.status,
          ok: res.ok,
          headers,
          body,
          durationMs: Math.round(performance.now() - started),
        }
      }
      catch (err) {
        throw new Error(describeFetchFailure(req.url, err))
      }
      finally {
        clearTimeout(timer)
      }
    },

    async llmStream(req: LlmChatRequest, onEvent: (event: LlmStreamEvent) => void) {
      const controller = new AbortController()
      const { url, headers, body } = buildLlmRequest(req, true)

      const done = (async () => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => '')
            onEvent({ type: 'error', message: `HTTP ${res.status} ${text.slice(0, 400)}` })
            return
          }
          const usage = await parseLlmStream(res.body, req.provider, onEvent)
          onEvent({ type: 'done', usage })
        }
        catch (err) {
          if (controller.signal.aborted) {
            onEvent({ type: 'error', message: '已取消' })
            return
          }
          onEvent({ type: 'error', message: String(err) })
        }
      })()

      return { cancel: () => controller.abort(), done }
    },
  }
}
