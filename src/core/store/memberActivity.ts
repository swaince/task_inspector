import type { ActivityFailure, ProjectBranchActivity } from '../engine/activity'
import type { ShareEstimate } from '../engine/estimate'
import type { GitCommit } from '../domain/types'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 人员活动的一次分析结果（人 × 时间段 × 项目）。
 *
 * 与项目活动一样放 store：分析本身要扫全部关注项目的仓库、还要调模型估算，
 * 离开页面再回来重跑代价太高。
 */
export interface MemberActivityRow {
  date: string
  /** 项目 id，或 `path:` / `entry:` 兜底键 */
  projectKey: string
  projectName: string
  projectPath: string
  commits: GitCommit[]
  reportedHours: number
  reportedContents: string[]
}

export interface MemberActivitySnapshot {
  memberId: string
  from: string
  to: string
  rows: MemberActivityRow[]
  /** 区间内有提交的分支活动 */
  branches: ProjectBranchActivity[]
  failures: ActivityFailure[]
  estimate: ShareEstimate | null
  analyzedAt: string
  liveFailed: string | null
  report: string
  reportAt: string | null
}

export const useMemberActivityStore = defineStore('memberActivity', () => {
  const snapshot = ref<MemberActivitySnapshot | null>(null)
  const generatingReport = ref(false)
  const reportError = ref<string | null>(null)

  function save(next: MemberActivitySnapshot) {
    snapshot.value = next
  }

  /** 命中「同一个人 + 同一区间」时返回快照 */
  function take(memberId: string, from: string, to: string): MemberActivitySnapshot | null {
    const s = snapshot.value
    if (!s || s.memberId !== memberId || s.from !== from || s.to !== to)
      return null
    return s
  }

  function clear() {
    snapshot.value = null
    reportError.value = null
  }

  return {
    snapshot,
    generatingReport,
    reportError,
    save,
    take,
    clear,
  }
})
