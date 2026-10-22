import type { InspectionResult } from '../domain/types'
import { transport } from '../bridge'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * 检查历史。
 *
 * 存在本地库里（桌面端是 SQLite 的 inspections 表），主键是 (date, member_id)，
 * 所以重跑同一天同一人直接覆盖，语义上等同于「该人该日的最新结论」。
 * 摘要列（分数、工时、漏报数）单独成列供历史列表和统计查询，
 * 完整结果整体存在 payload 里。
 */
export const useHistoryStore = defineStore('history', () => {
  const results = ref<InspectionResult[]>([])
  const loaded = ref(false)
  const loading = ref(false)

  const sorted = computed(() => results.value)

  const dates = computed(() => [...new Set(results.value.map(r => r.date))].sort().reverse())

  function byDate(date: string) {
    return results.value.filter(r => r.date === date)
  }

  function findByKey(date: string, memberId: string) {
    return results.value.find(r => r.date === date && r.memberId === memberId)
  }

  async function load() {
    if (loaded.value || loading.value)
      return
    loading.value = true
    try {
      // 排序由 SQL 负责（date DESC, member_name），这里不再重排
      results.value = await transport().inspectionsList()
    }
    finally {
      loading.value = false
      loaded.value = true
    }
  }

  async function save(result: InspectionResult) {
    await transport().inspectionsUpsert(result)
    const rest = results.value.filter(r => !(r.date === result.date && r.memberId === result.memberId))
    // 保持与 SQL 一致的排序，避免列表在保存后跳位
    results.value = [...rest, result].sort(
      (a, b) => b.date.localeCompare(a.date) || a.memberName.localeCompare(b.memberName),
    )
  }

  async function remove(date: string, memberId: string) {
    await transport().inspectionsDelete(date, memberId)
    results.value = results.value.filter(r => !(r.date === date && r.memberId === memberId))
  }

  async function clear() {
    await transport().inspectionsClear()
    results.value = []
  }

  /** 清理超过保留期的历史，返回删除条数。启动时调用。 */
  async function prune(keepDays: number) {
    const removed = await transport().inspectionsPrune(keepDays)
    if (removed > 0) {
      const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10)
      results.value = results.value.filter(r => r.date >= cutoff)
    }
    return removed
  }

  return {
    results,
    sorted,
    dates,
    loaded,
    loading,
    byDate,
    findByKey,
    load,
    save,
    remove,
    clear,
    prune,
  }
})
