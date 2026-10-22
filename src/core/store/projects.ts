import type { Project } from '../domain/types'
import type { GitLabProjectInput, ProjectSyncOutcome } from '../bridge/types'
import type { LogSystemProject } from '../adapters/dailyReport'
import { transport } from '../bridge'
import { projectMatches } from '../engine/matching'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useReportStore } from './reports'
import { uid } from '@/lib/format'

/** 新建项目时的默认值，字段与 Rust 侧的 ProjectRow 一一对应 */
export function createProjectDraft(name = ''): Project {
  const now = new Date().toISOString()
  return {
    id: uid(),
    logProjectId: undefined,
    name,
    code: undefined,
    description: undefined,
    links: [],
    repos: [],
    archived: false,
    aliases: [],
    matchMode: 'exact',
    devMode: 'manual',
    enabled: true,
    followed: true,
    origin: 'manual',
    syncStatus: 'unsynced',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 项目实体。
 *
 * 替代了原先 settings 里的「项目映射」：日报里写的名字/编码/别名就是项目自身的匹配键，
 * GitLab 的 id/路径/地址是它的同步结果，不再分两处维护同一件事。
 */
export const useProjectStore = defineStore('projects', () => {
  const items = ref<Project[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const syncing = ref(false)
  const lastSync = ref<ProjectSyncOutcome | null>(null)
  /** 引用次数是拿日报算的，所以这个 store 要读日报那份内存视图 */
  const reportStore = useReportStore()

  const enabled = computed(() => items.value.filter(p => p.enabled))

  /**
   * 每个项目在已载入的日报里命中多少条。
   *
   * 判定复用引擎的 projectMatches，而不是自己按名称全等数一遍：这个数字是用来
   * 发现「配了匹配键却从没命中」的，两边规则不一致的话，配成「包含」或「正则」
   * 的项目会被一律报成未引用，等于把正确的配置报成错的。
   *
   * 先把日报里的项目名去重再比：同一个项目名会在很多天、很多人身上重复出现，
   * 逐条去和整个项目表比是 N×M。
   */
  const usage = computed(() => {
    const distinct = new Map<string, { entry: { projectName: string, projectCode?: string }, times: number }>()
    for (const list of Object.values(reportStore.cache)) {
      for (const report of list) {
        for (const entry of report.entries) {
          const key = `${entry.projectName}\u0000${entry.projectCode ?? ''}`
          const hit = distinct.get(key)
          if (hit)
            hit.times++
          else
            distinct.set(key, { entry, times: 1 })
        }
      }
    }

    const counts = new Map<string, number>()
    for (const { entry, times } of distinct.values()) {
      for (const project of items.value) {
        if (projectMatches(project, entry))
          counts.set(project.id, (counts.get(project.id) ?? 0) + times)
      }
    }
    return counts
  })

  function usageOf(id: string) {
    return usage.value.get(id) ?? 0
  }

  /** 与 GitLab 对不上的项目：同步失败或已被删除，检查时会拉不到提交 */
  const problematic = computed(() =>
    items.value.filter(p => p.syncStatus === 'missing' || p.syncStatus === 'error'),
  )

  /** 配了却从没在日报里出现过，多半是匹配键写错了 */
  const unused = computed(() =>
    items.value.filter(p => p.enabled && usageOf(p.id) === 0),
  )

  async function load() {
    if (loading.value)
      return
    loading.value = true
    try {
      items.value = await transport().projectsList()
      loaded.value = true
    }
    catch (err) {
      error.value = `读取项目失败：${err instanceof Error ? err.message : String(err)}`
    }
    finally {
      loading.value = false
    }
  }

  async function save(project: Project) {
    const next = { ...project, updatedAt: new Date().toISOString() }
    await transport().projectsUpsert(next)
    const index = items.value.findIndex(p => p.id === next.id)
    if (index === -1)
      items.value = [...items.value, next].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    else
      items.value = items.value.map(p => (p.id === next.id ? next : p))
  }

  async function remove(id: string) {
    await transport().projectsDelete(id)
    items.value = items.value.filter(p => p.id !== id)
  }

  /**
   * 批量改关注。
   *
   * 先算好整份新数组再一次性替换，而不是逐个走 `save()`——`save` 每次都重排整个列表，
   * 选中几百个时会退化成 O(n²)，界面上能看出卡顿。
   */
  async function setFollowedMany(ids: string[], followed: boolean) {
    const wanted = new Set(ids)
    if (!wanted.size)
      return
    const now = new Date().toISOString()
    const next: Project[] = []
    for (const project of items.value) {
      if (!wanted.has(project.id)) {
        next.push(project)
        continue
      }
      const updated = { ...project, followed, updatedAt: now }
      next.push(updated)
      await transport().projectsUpsert(updated)
    }
    items.value = next
  }

  /** 批量删除。列表最后一次性过滤，避免每删一个就重建一遍数组 */
  async function removeMany(ids: string[]) {
    const wanted = new Set(ids)
    if (!wanted.size)
      return
    for (const id of wanted)
      await transport().projectsDelete(id)
    items.value = items.value.filter(p => !wanted.has(p.id))
  }

  /** 用 GitLab 的仓库清单与本地表对账。仓库清单由调用方先拉好。 */
  async function syncFrom(remote: GitLabProjectInput[]) {
    syncing.value = true
    error.value = null
    try {
      lastSync.value = await transport().projectsSyncFromGitlab(remote)
      await load()
      return lastSync.value
    }
    catch (err) {
      error.value = `同步失败：${err instanceof Error ? err.message : String(err)}`
      throw err
    }
    finally {
      syncing.value = false
    }
  }

  /* ------------------------------------------------------------------ *
   * 从日志系统同步
   * ------------------------------------------------------------------ */

  interface LogSyncOutcome {
    remote: number
    /** 本地没有、按选项新建的 */
    created: number
    /** 补上了日志中心项目 ID 的（这批以前和日志中心对不上） */
    linked: number
    /** 本地已有、补了编码或名称的 */
    filled: number
    /** 本地有、编码已一致，没动 */
    unchanged: number
    /** 没开「同时新建」时，本地没有的那些 */
    skipped: number
    /** 一条远程项目同时命中两个本地项目，需要人工裁决 */
    conflicts: string[]
  }

  /**
   * 以日志中心的项目清单为准建项目。
   *
   * 认项目的顺序：日志中心 ID（最稳）→ 编码 → 名称。编码和名称都按归一化比较
   * （去空白、忽略大小写），因为人在两个系统里填同一个编号时，空格和大小写经常不一致。
   *
   * 名称和编码：**来自日志中心的项目跟着日志中心更新**，手工建的项目只补空——
   * 后者可能被人改过名字，自动覆盖会把他的配置冲掉。
   *
   * 默认新建：项目本来就该以日志中心为准，不建的话面板里永远是空的。
   * 调用方仍可以用 createMissing=false 只做「补齐」。
   */
  async function syncFromLogSystem(
    remote: LogSystemProject[],
    opts: { createMissing?: boolean } = {},
  ): Promise<LogSyncOutcome> {
    const outcome: LogSyncOutcome = {
      remote: remote.length,
      created: 0,
      linked: 0,
      filled: 0,
      unchanged: 0,
      skipped: 0,
      conflicts: [],
    }

    const norm = (s: string) => s.trim().toLowerCase()
    const next = [...items.value]
    const now = new Date().toISOString()

    for (const r of remote) {
      const name = r.name?.trim()
      if (!name)
        continue
      const number = r.number?.trim()
      const logId = r.id?.trim()

      const byLogId = logId ? next.find(p => p.logProjectId === logId) : undefined
      const byCode = number ? next.find(p => p.code && norm(p.code) === norm(number)) : undefined
      const byName = next.find(p => norm(p.name) === norm(name))

      if (byCode && byName && byCode.id !== byName.id) {
        outcome.conflicts.push(`「${name}」（${number}）同时命中「${byCode.name}」和「${byName.name}」`)
        continue
      }

      const hit = byLogId ?? byCode ?? byName
      if (hit) {
        const patch: Partial<Project> = {}
        if (!hit.logProjectId && logId)
          patch.logProjectId = logId

        if (hit.origin === 'log') {
          if (hit.name !== name)
            patch.name = name
          if (number && hit.code !== number)
            patch.code = number
        }
        else if (!hit.code && number) {
          patch.code = number
        }

        if (!Object.keys(patch).length) {
          outcome.unchanged++
          continue
        }

        const updated = { ...hit, ...patch, updatedAt: now }
        await transport().projectsUpsert(updated)
        next[next.findIndex(p => p.id === hit.id)] = updated
        if (patch.logProjectId)
          outcome.linked++
        else
          outcome.filled++
        continue
      }

      if (!opts.createMissing) {
        outcome.skipped++
        continue
      }

      const draft: Project = {
        ...createProjectDraft(name),
        logProjectId: logId,
        code: number,
        origin: 'log',
        updatedAt: now,
      }
      await transport().projectsUpsert(draft)
      next.push(draft)
      outcome.created++
    }

    items.value = next.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return outcome
  }

  return {
    items,
    loaded,
    loading,
    error,
    syncing,
    lastSync,
    enabled,
    problematic,
    unused,
    usageOf,
    load,
    save,
    remove,
    setFollowedMany,
    removeMany,
    syncFrom,
    syncFromLogSystem,
  }
})
