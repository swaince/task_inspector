import type { ActivitySnapshot, ActivityRow } from './activity'
import type { MemberActivitySnapshot, MemberActivityRow } from './memberActivity'
import { transport } from '../bridge'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * 项目活动 / 人员活动的分析历史。
 *
 * 一次扫描的结果原本只存在内存里，离开页面或重启就没了。这里把完整快照
 * 持久化到 SQLite，并额外保存一份按成员/项目拆好的 facets，
 * 让历史列表和跨记录统计不需要解析整包快照。
 */

export type ActivityAnalysisKind = 'project' | 'member'

export interface ActivityFacet {
  name: string
  commits: number
  reportedHours: number
}

export interface ActivityFacets {
  members: ActivityFacet[]
  projects: ActivityFacet[]
}

export interface ActivityAnalysisSummary {
  id: string
  kind: ActivityAnalysisKind
  scopeId: string
  scopeName: string
  from: string
  to: string
  analyzedAt: string
  commits: number
  people: number
  projects: number
  reportedHours: number
  effectiveLow: number
  effectiveHigh: number
  facets: ActivityFacets
  /** 日志同步发现这个区间有变更，结果可能已过期 */
  stale?: boolean
  staleReason?: string | null
  staleAt?: string | null
}

export interface ProjectActivityPayload {
  kind: 'project'
  scopeId: string
  scopeName: string
  from: string
  to: string
  analyzedAt: string
  snapshot: ActivitySnapshot
}

export interface MemberActivityPayload {
  kind: 'member'
  scopeId: string
  scopeName: string
  from: string
  to: string
  analyzedAt: string
  snapshot: MemberActivitySnapshot
}

export type ActivityAnalysisPayload = ProjectActivityPayload | MemberActivityPayload

function facetsOfProject(rows: ActivityRow[]): ActivityFacets {
  const members = new Map<string, ActivityFacet>()
  for (const row of rows) {
    const hit = members.get(row.memberName) ?? { name: row.memberName, commits: 0, reportedHours: 0 }
    hit.commits += row.commits.length
    hit.reportedHours += row.hours
    members.set(row.memberName, hit)
  }
  return { members: [...members.values()], projects: [] }
}

function facetsOfMember(rows: MemberActivityRow[]): ActivityFacets {
  const projects = new Map<string, ActivityFacet>()
  for (const row of rows) {
    const hit = projects.get(row.projectName) ?? { name: row.projectName, commits: 0, reportedHours: 0 }
    hit.commits += row.commits.length
    hit.reportedHours += row.reportedHours
    projects.set(row.projectName, hit)
  }
  return { members: [], projects: [...projects.values()] }
}

function idOf(kind: ActivityAnalysisKind, scopeId: string, from: string, to: string) {
  return `${kind}:${scopeId}:${from}:${to}`
}

export const useActivityHistoryStore = defineStore('activityHistory', () => {
  const items = ref<ActivityAnalysisSummary[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const projectItems = computed(() => items.value.filter(item => item.kind === 'project'))
  const memberItems = computed(() => items.value.filter(item => item.kind === 'member'))

  async function load(kind?: ActivityAnalysisKind) {
    loading.value = true
    error.value = null
    try {
      const raw = await transport().activityAnalysesList(kind)
      items.value = JSON.parse(raw) as ActivityAnalysisSummary[]
      loaded.value = true
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
    finally {
      loading.value = false
    }
  }

  async function get(id: string): Promise<ActivityAnalysisPayload | null> {
    const raw = await transport().activityAnalysesGet(id)
    if (!raw)
      return null
    try {
      return JSON.parse(raw) as ActivityAnalysisPayload
    }
    catch {
      return null
    }
  }

  async function saveProject(
    snapshot: ActivitySnapshot,
    meta: { projectName: string, effectiveLow: number, effectiveHigh: number },
  ) {
    const analyzedAt = new Date().toISOString()
    const facets = facetsOfProject(snapshot.rows)
    const payload: ProjectActivityPayload = {
      kind: 'project',
      scopeId: snapshot.projectId,
      scopeName: meta.projectName,
      from: snapshot.from,
      to: snapshot.to,
      analyzedAt,
      snapshot,
    }
    const summary: ActivityAnalysisSummary = {
      id: idOf('project', snapshot.projectId, snapshot.from, snapshot.to),
      kind: 'project',
      scopeId: snapshot.projectId,
      scopeName: meta.projectName,
      from: snapshot.from,
      to: snapshot.to,
      analyzedAt,
      commits: snapshot.rows.reduce((sum, row) => sum + row.commits.length, 0),
      people: new Set(snapshot.rows.map(row => row.memberKey)).size,
      projects: 1,
      reportedHours: round1(snapshot.rows.reduce((sum, row) => sum + row.hours, 0)),
      effectiveLow: meta.effectiveLow,
      effectiveHigh: meta.effectiveHigh,
      facets,
    }
    await transport().activityAnalysesUpsert(JSON.stringify({ ...summary, payload: JSON.stringify(payload) }))
    await load()
  }

  async function saveMember(
    snapshot: MemberActivitySnapshot,
    meta: { memberName: string, effectiveLow: number, effectiveHigh: number },
  ) {
    const analyzedAt = new Date().toISOString()
    const facets = facetsOfMember(snapshot.rows)
    const payload: MemberActivityPayload = {
      kind: 'member',
      scopeId: snapshot.memberId,
      scopeName: meta.memberName,
      from: snapshot.from,
      to: snapshot.to,
      analyzedAt,
      snapshot,
    }
    const summary: ActivityAnalysisSummary = {
      id: idOf('member', snapshot.memberId, snapshot.from, snapshot.to),
      kind: 'member',
      scopeId: snapshot.memberId,
      scopeName: meta.memberName,
      from: snapshot.from,
      to: snapshot.to,
      analyzedAt,
      commits: snapshot.rows.reduce((sum, row) => sum + row.commits.length, 0),
      people: 1,
      projects: new Set(snapshot.rows.map(row => row.projectKey)).size,
      reportedHours: round1(snapshot.rows.reduce((sum, row) => sum + row.reportedHours, 0)),
      effectiveLow: meta.effectiveLow,
      effectiveHigh: meta.effectiveHigh,
      facets,
    }
    await transport().activityAnalysesUpsert(JSON.stringify({ ...summary, payload: JSON.stringify(payload) }))
    await load()
  }

  /**
   * 只更新 AI 产物（报告、申报对照），不重置分析时间或过期标记。
   *
   * 生成报告发生在扫描之后；如果这里走 saveProject/saveMember，
   * 会把 analyzed_at 推到现在，并把「日志已更新」的标记误清掉。
   */
  async function updateProjectArtifacts(snapshot: ActivitySnapshot, projectName: string) {
    const id = idOf('project', snapshot.projectId, snapshot.from, snapshot.to)
    if (!items.value.some(item => item.id === id)) {
      await saveProject(snapshot, {
        projectName,
        effectiveLow: 0,
        effectiveHigh: 0,
      })
      return
    }
    const at = items.value.find(item => item.id === id)?.analyzedAt ?? new Date().toISOString()
    const payload: ProjectActivityPayload = {
      kind: 'project',
      scopeId: snapshot.projectId,
      scopeName: projectName,
      from: snapshot.from,
      to: snapshot.to,
      analyzedAt: at,
      snapshot,
    }
    await transport().activityAnalysesUpdatePayload(id, JSON.stringify(payload))
  }

  async function updateMemberArtifacts(snapshot: MemberActivitySnapshot, memberName: string) {
    const id = idOf('member', snapshot.memberId, snapshot.from, snapshot.to)
    if (!items.value.some(item => item.id === id)) {
      await saveMember(snapshot, {
        memberName,
        effectiveLow: 0,
        effectiveHigh: 0,
      })
      return
    }
    const at = items.value.find(item => item.id === id)?.analyzedAt ?? new Date().toISOString()
    const payload: MemberActivityPayload = {
      kind: 'member',
      scopeId: snapshot.memberId,
      scopeName: memberName,
      from: snapshot.from,
      to: snapshot.to,
      analyzedAt: at,
      snapshot,
    }
    await transport().activityAnalysesUpdatePayload(id, JSON.stringify(payload))
  }

  async function remove(id: string) {
    await transport().activityAnalysesDelete(id)
    items.value = items.value.filter(item => item.id !== id)
  }

  /** 日志同步发现变更后，把区间覆盖这些日期的记录标记为待重新分析 */
  async function markStale(dates: string[], reason: string) {
    if (!dates.length)
      return 0
    const marked = await transport().activityAnalysesMarkStale(dates, reason)
    if (marked > 0)
      await load()
    return marked
  }

  async function clear(kind?: ActivityAnalysisKind) {
    await transport().activityAnalysesClear()
    items.value = kind ? items.value.filter(item => item.kind !== kind) : []
  }

  async function prune(keepDays: number) {
    const removed = await transport().activityAnalysesPrune(keepDays)
    if (removed > 0)
      await load()
    return removed
  }

  return {
    items,
    projectItems,
    memberItems,
    loaded,
    loading,
    error,
    load,
    get,
    saveProject,
    saveMember,
    updateProjectArtifacts,
    updateMemberArtifacts,
    markStale,
    remove,
    clear,
    prune,
  }
})

function round1(value: number) {
  return Math.round(value * 10) / 10
}
