import type { DailyReport } from '../domain/types'
import { transport } from '../bridge'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createDailyReportSource, parseDailyReportCsv } from '../adapters/dailyReport'
import { dateRange } from '../engine/window'
import { useSettingsStore } from './settings'

/**
 * 日报数据 store。
 *
 * 这里有两层数据，用途不同：
 *
 * - **本地库**：显式「同步 / 导入」进来的快照，给离线查看和 CSV 来源用。
 * - **实时拉取**：检查、项目活动、人员活动打开时直接问源系统要最新的，
 *   因为日志系统支持补写——一条日报提交以后还能改，本地存的随时可能是旧的。
 *
 * 实时结果只更新内存视图，不写库：写库会让「本地快照」和「刚拉的最新」
 * 混成一锅，之后谁也说不清界面上看到的是哪一份。
 */
export const useReportStore = defineStore('reports', () => {
  const cache = ref<Record<string, DailyReport[]>>({})
  const loaded = ref(false)
  const lastError = ref<string | null>(null)
  /** 最近一次实时拉取失败的原因；界面据此提示「你看到的是本地缓存」 */
  const liveError = ref<string | null>(null)

  const settingsStore = useSettingsStore()

  const allDates = computed(() => Object.keys(cache.value).sort().reverse())

  const totalReports = computed(() =>
    Object.values(cache.value).reduce((s, list) => s + list.length, 0),
  )

  async function load() {
    if (loaded.value)
      return
    try {
      const dates = await transport().reportsDates()
      const entries = await Promise.all(
        dates.map(async date => [date, await transport().reportsByDate(date)] as const),
      )
      cache.value = Object.fromEntries(entries)
    }
    catch (err) {
      lastError.value = `读取日报失败：${err instanceof Error ? err.message : String(err)}`
      cache.value = {}
    }
    finally {
      loaded.value = true
    }
  }

  async function put(date: string, reports: DailyReport[]) {
    await transport().reportsUpsert(date, reports)
    cache.value = { ...cache.value, [date]: reports }
  }

  /**
   * 直接从源系统刷新一段日期。
   *
   * 不抛异常：拉取失败时保留本地缓存继续展示，把原因交给界面提示。
   * 静默失败比报错更危险——补写过的日报不会自己出现在屏幕上，
   * 用户会以为「这个人当天没写」。
   */
  async function refreshRange(from: string, to: string): Promise<{ ok: boolean, error?: string }> {
    const cfg = settingsStore.settings.dailyReport
    // 演示数据和 CSV 没有源系统可问，本地那份就是全部
    if (cfg.source !== 'http') {
      liveError.value = null
      return { ok: true }
    }

    try {
      const source = createDailyReportSource(cfg)
      const dates = dateRange(from, to)
      const reports = source.fetchRange
        ? await source.fetchRange(from, to)
        : (await Promise.all(dates.map(d => source.fetchByDate(d)))).flat()

      const next = { ...cache.value }
      // 区间内先清空：源系统说这天没有，就是没有，不能让上一次的遗留物留着
      for (const date of dates)
        next[date] = []
      for (const report of reports) {
        if (!report.date)
          continue
        ;(next[report.date] ??= []).push(report)
      }
      cache.value = next
      liveError.value = null
      return { ok: true }
    }
    catch (err) {
      liveError.value = err instanceof Error ? err.message : String(err)
      return { ok: false, error: liveError.value }
    }
  }

  function get(date: string): DailyReport[] | undefined {
    return cache.value[date]
  }

  function findMember(date: string, memberId: string, memberName?: string) {
    const list = cache.value[date]
    if (!list)
      return undefined
    return list.find(r => r.memberId === memberId)
      ?? (memberName ? list.find(r => r.memberName === memberName) : undefined)
  }

  /** 导入 CSV。返回本次覆盖的日期与日报条数。 */
  async function importCsv(text: string) {
    const reports = parseDailyReportCsv(text)

    // 同一天可能有多份日报，先在内存里聚合再整体写库，
    // 逐条 put 会把同一日期反复重写
    const touched = new Map<string, DailyReport[]>(Object.entries(cache.value))
    for (const report of reports) {
      const existing = touched.get(report.date) ?? []
      touched.set(report.date, [...existing.filter(r => r.memberId !== report.memberId), report])
    }

    const changedDates = [...new Set(reports.map(r => r.date))]
    for (const date of changedDates)
      await transport().reportsUpsert(date, touched.get(date) ?? [])

    cache.value = Object.fromEntries(touched)
    return { reports: reports.length, dates: changedDates.sort() }
  }

  async function clear() {
    await transport().reportsClear()
    cache.value = {}
  }

  return {
    cache,
    loaded,
    lastError,
    liveError,
    allDates,
    totalReports,
    load,
    put,
    refreshRange,
    get,
    findMember,
    importCsv,
    clear,
  }
})
