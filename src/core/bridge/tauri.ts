import type { Channel } from '@tauri-apps/api/core'
import type {
  HttpRequestInput,
  HttpResponseOutput,
  InstallEvent,
  LlmChatRequest,
  LlmStreamEvent,
  ProfileRow,
  RepoBranches,
  ShellEvent,
  ShellRunRequest,
  ShellRunResult,
  Transport,
} from './types'

/**
 * 桌面端传输实现：所有网络请求与本地文件读写都交给 Rust。
 *
 * 走 Rust 而不是 webview 的 fetch，原因有三个：内网 GitLab 通常不带 CORS 头；
 * token 留在 Rust 侧不落到页面上下文；流式响应可以用 Tauri Channel 推。
 */
export function createTauriTransport(): Transport {
  let api: typeof import('@tauri-apps/api/core') | null = null
  let channelCtor: typeof Channel | null = null

  async function core() {
    if (!api)
      api = await import('@tauri-apps/api/core')
    return api
  }

  async function getChannelCtor() {
    if (!channelCtor) {
      const mod = await import('@tauri-apps/api/core')
      channelCtor = mod.Channel
    }
    return channelCtor
  }

  return {
    kind: 'tauri',

    async http(req: HttpRequestInput): Promise<HttpResponseOutput> {
      const { invoke } = await core()
      return invoke<HttpResponseOutput>('http_request', { req })
    },

    async llmStream(req: LlmChatRequest, onEvent: (event: LlmStreamEvent) => void) {
      const { invoke } = await core()
      const ChannelCtor = await getChannelCtor()
      const streamId = crypto.randomUUID()
      let cancelled = false
      const channel = new ChannelCtor<LlmStreamEvent>()
      channel.onmessage = (event) => {
        if (!cancelled)
          onEvent(event)
      }

      // Rust 侧保证在命令返回前发出终止事件，所以 invoke 的 resolve 就是流结束信号，
      // 不需要在 JS 侧猜什么时候读完了。
      const done = invoke<void>('llm_stream', { req, streamId, onEvent: channel })
        .catch((err) => {
          if (!cancelled)
            onEvent({ type: 'error', message: String(err) })
        })
        .then(() => {})

      return {
        cancel: () => {
          cancelled = true
          void invoke('llm_cancel', { streamId })
        },
        done,
      }
    },

    async shellRun(req: ShellRunRequest, onEvent: (event: ShellEvent) => void) {
      const { invoke } = await core()
      const ChannelCtor = await getChannelCtor()
      const channel = new ChannelCtor<ShellEvent>()
      channel.onmessage = onEvent

      // Rust 在命令退出、超时或被杀掉后返回；结束信号就是 invoke 的 resolve
      return invoke<ShellRunResult>('shell_run', {
        command: req.command,
        cwd: req.cwd,
        allowedCwds: req.allowedCwds,
        timeoutMs: req.timeoutMs,
        runId: req.runId,
        onEvent: channel,
      })
    },

    async shellCancel(runId: string) {
      const { invoke } = await core()
      await invoke('shell_cancel', { runId })
    },

    async settingsGet() {
      const { invoke } = await core()
      return invoke<string | null>('settings_get')
    },

    async settingsSet(value: string) {
      const { invoke } = await core()
      await invoke('settings_set', { value })
    },

    async reportsUpsert(date: string, reports) {
      const { invoke } = await core()
      return invoke<number>('reports_upsert', { date, payload: JSON.stringify(reports) })
    },

    async reportsByDate(date: string) {
      const { invoke } = await core()
      const raw = await invoke<string>('reports_by_date', { date })
      return JSON.parse(raw)
    },

    async reportsDates() {
      const { invoke } = await core()
      return invoke<string[]>('reports_dates')
    },

    async reportsClear() {
      const { invoke } = await core()
      await invoke('reports_clear')
    },

    async inspectionsUpsert(result) {
      const { invoke } = await core()
      await invoke('inspections_upsert', { payload: JSON.stringify(result) })
    },

    async inspectionsList(filter) {
      const { invoke } = await core()
      const raw = await invoke<string>('inspections_list', {
        from: filter?.from ?? null,
        to: filter?.to ?? null,
        memberId: filter?.memberId ?? null,
      })
      return JSON.parse(raw)
    },

    async inspectionsByKey(date: string, memberId: string) {
      const { invoke } = await core()
      const raw = await invoke<string | null>('inspections_by_key', { date, memberId })
      return raw ? JSON.parse(raw) : null
    },

    async inspectionsDelete(date: string, memberId: string) {
      const { invoke } = await core()
      await invoke('inspections_delete', { date, memberId })
    },

    async inspectionsClear() {
      const { invoke } = await core()
      await invoke('inspections_clear')
    },

    async dataReset(mode: 'business' | 'all') {
      const { invoke } = await core()
      await invoke('data_reset', { mode })
    },

    async inspectionsPrune(keepDays: number) {
      const { invoke } = await core()
      return invoke<number>('inspections_prune', { keepDays })
    },

    async commitsUpsert(commits) {
      if (!commits.length)
        return 0
      const { invoke } = await core()
      return invoke<number>('commits_upsert', { payload: JSON.stringify(commits) })
    },

    async projectsList() {
      const { invoke } = await core()
      return invoke('projects_list')
    },

    async projectsUpsert(project) {
      const { invoke } = await core()
      return invoke<string>('projects_upsert', { payload: JSON.stringify(project) })
    },

    async projectsDelete(id: string) {
      const { invoke } = await core()
      await invoke('projects_delete', { id })
    },

    async projectsSyncFromGitlab(projects) {
      const { invoke } = await core()
      return invoke('projects_sync_from_gitlab', { payload: JSON.stringify(projects) })
    },

    async membersList() {
      const { invoke } = await core()
      return invoke('members_list')
    },

    async membersUpsert(member) {
      const { invoke } = await core()
      return invoke<string>('members_upsert', { payload: JSON.stringify(member) })
    },

    async membersDelete(id: string) {
      const { invoke } = await core()
      await invoke('members_delete', { id })
    },

    async membersImport(members) {
      if (!members.length)
        return 0
      const { invoke } = await core()
      return invoke<number>('members_import', { payload: JSON.stringify(members) })
    },

    async ldapSync(config) {
      const { invoke } = await core()
      return invoke('ldap_sync', { payload: JSON.stringify(config) })
    },

    async ldapProbe(config) {
      const { invoke } = await core()
      return invoke('ldap_probe', { payload: JSON.stringify(config) })
    },

    async toolStatus(kind, configuredPath) {
      const { invoke } = await core()
      return invoke('tool_status', { kind, configured: configuredPath ?? null })
    },

    async analysisDefaults() {
      const { invoke } = await core()
      return invoke('analysis_defaults')
    },

    async dirUsage(path) {
      const { invoke } = await core()
      return invoke('dir_usage', { path })
    },

    async clearCache(path, codeRoot) {
      const { invoke } = await core()
      return invoke('clear_cache', { path, codeRoot: codeRoot ?? null })
    },

    async installTool(kind, onEvent) {
      const { invoke } = await core()
      const ChannelCtor = await getChannelCtor()
      const channel = new ChannelCtor<InstallEvent>()
      channel.onmessage = onEvent
      // 命令本身立刻返回，真正的安装在 Rust 后台线程里跑
      await invoke('analysis_install', { kind, channel })
    },

    async cancelInstall(kind) {
      const { invoke } = await core()
      await invoke('analysis_install_cancel', { kind })
    },

    async analysisIndex(path, configuredPath) {
      const { invoke } = await core()
      return invoke('analysis_index', { path, configured: configuredPath ?? null })
    },

    async scanRepo(path) {
      const { invoke } = await core()
      return invoke('scan_repo', { path })
    },

    async gitHotspots(path, days) {
      const { invoke } = await core()
      return invoke('git_hotspots', { path, days })
    },

    async gitHead(path) {
      const { invoke } = await core()
      return invoke('git_head', { path })
    },

    async gitBranches(path) {
      const { invoke } = await core()
      return invoke<RepoBranches>('git_branches', { path })
    },

    async gitWorktreeAdd(path, reference) {
      const { invoke } = await core()
      return invoke<string>('git_worktree_add', { path, reference })
    },

    async gitWorktreeRemove(path, worktree) {
      const { invoke } = await core()
      await invoke('git_worktree_remove', { path, worktree })
    },

    async ensureDirs(root, paths) {
      const { invoke } = await core()
      return invoke('ensure_dirs', { root, paths })
    },

    async gitClone(url, dest, branch, depth) {
      const { invoke } = await core()
      return invoke('git_clone', { url, dest, branch: branch ?? null, depth: depth ?? 0 })
    },

    async readTextFile(path) {
      const { invoke } = await core()
      return invoke('read_text_file', { path })
    },

    async profilesGet(projectId) {
      const { invoke } = await core()
      return invoke('profiles_get', { projectId })
    },

    async profileUpsert(row: ProfileRow) {
      const { invoke } = await core()
      await invoke('profile_upsert', { payload: JSON.stringify(row) })
    },

    async profilesDelete(projectId) {
      const { invoke } = await core()
      await invoke('profiles_delete', { projectId })
    },
  }
}
