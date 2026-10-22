import type { ActivityFailure } from '../engine/activity'
import type { GitCommit } from '../domain/types'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 项目活动的一次扫描结果。
 *
 * 之前这些数据存在视图组件里，点进「详情」再返回时组件被卸载重建，
 * 结果就没了——用户看到的是一张空表，只能重新扫一遍。
 * 放到 store 里，返回时按「项目 + 区间」命中就直接恢复。
 */
export interface ActivityRow {
  date: string
  memberKey: string
  memberName: string
  /** 该日该项目下这个人的提交 */
  commits: GitCommit[]
  /** 日报里有没有这条项目 */
  reported: boolean
  hours: number
  contents: string[]
  /** 有提交但日报没写 —— 漏报 */
  missingInReport: boolean
  /** 日报写了但当天没提交 —— 无法自证 */
  missingCommits: boolean
}

export interface ActivitySnapshot {
  projectId: string
  from: string
  to: string
  rows: ActivityRow[]
  failures: ActivityFailure[]
  scannedAt: string
  /** 实时拉日报失败的原因；非空时申报列来自本地缓存 */
  liveFailed: string | null
  /** 模型生成的分析报告（markdown） */
  report: string
  reportAt: string | null
}

export const useActivityStore = defineStore('activity', () => {
  const snapshot = ref<ActivitySnapshot | null>(null)
  const generatingReport = ref(false)
  const reportError = ref<string | null>(null)

  /** 只保留最近一次扫描：换项目/换区间就应该重扫，缓存多了反而容易看到过期结果 */
  function save(next: ActivitySnapshot) {
    snapshot.value = next
  }

  /** 命中当前选择时返回快照，否则 null */
  function take(projectId: string, from: string, to: string): ActivitySnapshot | null {
    const s = snapshot.value
    if (!s || s.projectId !== projectId || s.from !== from || s.to !== to)
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
