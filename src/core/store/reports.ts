import type { DailyReport } from '../domain/types'
import type { ReportSyncState } from '../bridge/types'
import { transport } from '../bridge'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createDailyReportSource, parseDailyReportCsv } from '../adapters/dailyReport'
import { dateRange } from '../engine/window'
import { useSettingsStore } from './settings'

/**
 * 日报数据 store。
 *
 * 日报会被员工补写、修改，甚至删除，所以本地库永远只是某个时刻的快照。
 * 这里提供三种获取方式：
 *
 * - **增量同步**：重拉最近一段（默认 14 天），覆盖期间被改过的日报；
 * - **全量同步**：按指定区间重拉，源系统里已不存在的日期会被清空；
 * - **强制更新单人单日**：只替换某个人某天的记录，不影响同一天其他人。
 *
 * 打开检查/活动页时的实时拉取也会落库，避免「这次看到了最新、下次又变回旧值」。
 */

export interface ReportSyncProgress {
  done: number
  total: number
  message: string
}

export type ReportChangeType = 'added' | 'updated' | 'removed'

export interface ReportChange {
  date: string
  memberId: string
  memberName: string
  type: ReportChangeType
}

export interface ReportSyncOutcome {
  mode: 'incremental' | 'full'
  from: string
  to: string
  fetched: number
  writtenDates: number
  removedDates: number
  failedDates: string[]
  /** 本次同步相对本地实际发生变化的记录 */
  changes: ReportChange[]
  /** 发生变化的日期（去重、升序） */
  changedDates: string[]
  at: string
}

const EMPTY_SYNC_STATE: ReportSyncState = {
  lastIncrementalAt: null,
  lastIncrementalFrom: null,
  lastIncrementalTo: null,
  lastFullAt: null,
  lastFullFrom: null,
  lastFullTo: null,
}

/** 只比较会被判定用到的字段；顺序变化不算内容变化 */
function reportSignature(report: DailyReport) {
  return JSON.stringify({
    memberName: report.memberName,
    totalHours: report.totalHours,
    submittedAt: report.submittedAt ?? null,
    entries: [...report.entries]
      .map(entry => ({
        projectName: entry.projectName,
        projectCode: entry.projectCode ?? null,
        hours: entry.hours,
        content: entry.content,
        taskRefs: entry.taskRefs ?? [],
      }))
      .sort((a, b) => `${a.projectName}|${a.hours}|${a.content}`.localeCompare(`${b.projectName}|${b.hours}|${b.content}`)),
  })
}

function diffReports(date: string, before: DailyReport[], after: DailyReport[]): ReportChange[] {
  const oldMap = new Map(before.map(report => [report.memberId, report]))
  const newMap = new Map(after.map(report => [report.memberId, report]))
  const changes: ReportChange[] = []

  for (const [memberId, report] of newMap) {
    const old = oldMap.get(memberId)
    if (!old) {
      changes.push({ date, memberId, memberName: report.memberName, type: 'added' })
    }
    else if (reportSignature(old) !== reportSignature(report)) {
      changes.push({ date, memberId, memberName: report.memberName, type: 'updated' })
    }
  }
  for (const [memberId, report] of oldMap) {
    if (!newMap.has(memberId))
      changes.push({ date, memberId, memberName: report.memberName, type: 'removed' })
  }
  return changes
}
export const useReportStore = defineStore('reports', () => {
  const cache = ref<Record<string, DailyReport[]>>({})
  const loaded = ref(false)
  const lastError = ref<string | null>(null)
  /** 最近一次实时拉取失败的原因；界面据此提示「你看到的是本地缓存」 */
  const liveError = ref<string | null>(null)
  /** 同步状态（最近增量/全量同步时间与区间） */
  const syncState = ref<ReportSyncState>({ ...EMPTY_SYNC_STATE })
  const syncing = ref(false)
  const syncError = ref<string | null>(null)
  const syncProgress = ref<ReportSyncProgress | null>(null)

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

      /*
       * 实时结果也落库。否则「检查时看到的是最新、下次打开又变回旧快照」，
       * 员工改过的内容会被本地旧值覆盖，这个现象比多写几次库难查得多。
       */
      let failed = 0
      const writtenAt = new Date().toISOString()
      for (const date of dates) {
        try {
          await transport().reportsUpsert(date, next[date] ?? [])
          next[date] = (next[date] ?? []).map(report => ({ ...report, syncedAt: writtenAt }))
        }
        catch {
          failed++
        }
      }
      cache.value = next
      if (failed)
        syncError.value = `实时数据已更新，但有 ${failed} 天写入本地库失败`
      liveError.value = null
      return { ok: true }
    }
    catch (err) {
      liveError.value = err instanceof Error ? err.message : String(err)
      return { ok: false, error: liveError.value }
    }
  }

  /**
   * 增量/全量同步的唯一实现。
   *
   * 先把源系统给的区间结果按日期分组，再和本地已有日期的并集逐天写库：
   * - 源系统有数据的日期：整天替换，员工改过的内容会被覆盖成最新；
   * - 本地有、源系统已没有的日期：写成空数组，清掉被删除的日志；
   * - 两边都没有的日期：跳过，不产生空写。
   */
  async function syncRange(
    mode: 'incremental' | 'full',
    from: string,
    to: string,
    onProgress?: (progress: ReportSyncProgress) => void,
  ): Promise<ReportSyncOutcome> {
    const cfg = settingsStore.settings.dailyReport
    if (cfg.source !== 'http')
      throw new Error('当前日报来源不是接口，无法同步；CSV 导入请继续使用「导入 CSV」')

    if (from > to)
      throw new Error('同步起始日期不能晚于结束日期')

    syncing.value = true
    syncError.value = null
    syncProgress.value = { done: 0, total: 1, message: '正在读取日报…' }
    try {
      await load()
      const source = createDailyReportSource(cfg)
      const dates = dateRange(from, to)
      let reports: DailyReport[] = []

      if (source.fetchRange) {
        onProgress?.({ done: 0, total: 1, message: `正在拉取 ${from} ~ ${to} 的日报…` })
        reports = await source.fetchRange(from, to)
      }
      else {
        for (let i = 0; i < dates.length; i++) {
          const message = `正在拉取 ${dates[i]}（${i + 1}/${dates.length}）…`
          syncProgress.value = { done: i, total: dates.length, message }
          onProgress?.({ done: i, total: dates.length, message })
          reports.push(...await source.fetchByDate(dates[i]))
        }
      }

      const grouped = new Map<string, DailyReport[]>()
      for (const report of reports) {
        if (!report.date || report.date < from || report.date > to)
          continue
        const list = grouped.get(report.date) ?? []
        list.push(report)
        grouped.set(report.date, list)
      }

      const localDates = Object.keys(cache.value).filter(date => date >= from && date <= to)
      /*
       * 源系统返回 0 条时不要按「全删」处理：接口配置错、分页上限、
       * 临时权限问题都会表现成空结果，而本地历史删掉不可恢复。
       * 真要把一段区间清空，应该先确认源系统确实没有数据，再手动清。
       */
      if (mode === 'full' && reports.length === 0 && localDates.length > 0) {
        throw new Error('源系统这次返回 0 条日报，已保留本地数据。请先确认日报接口、日期范围和权限')
      }
      /*
       * 条数刚好等于「每页 × 最多页」时很可能被分页上限截断；
       * 这时候按全量语义清空区间会删掉没拉到的日期。
       */
      const pageCap = Math.max(1, cfg.pageSize) * Math.max(1, cfg.maxPages)
      if (mode === 'full' && reports.length >= pageCap && localDates.length > 0) {
        throw new Error(
          `返回条数达到分页上限（${pageCap} 条），可能没有拉全，已保留本地数据。`
          + '请到「设置 → 日报系统」调大每页条数或最多页数后重试',
        )
      }
      /*
       * 增量只覆盖源系统这次返回的日期，不主动清空本地日期：分页上限、
       * 临时权限问题都可能让某天「看起来没有日报」，把本地历史删掉不可恢复。
       * 删除只在全量同步里做——那是一次明确的区间重建。
       */
      const datesToWrite = mode === 'full'
        ? [...new Set([...grouped.keys(), ...localDates])].sort()
        : [...grouped.keys()].sort()

      let writtenDates = 0
      let removedDates = 0
      const failedDates: string[] = []
      let firstError: string | null = null
      const changes: ReportChange[] = []
      const changedDates = new Set<string>()
      const nextCache = { ...cache.value }
      const writtenAt = new Date().toISOString()

      for (let i = 0; i < datesToWrite.length; i++) {
        const date = datesToWrite[i]
        const list = grouped.get(date) ?? []
        const before = cache.value[date] ?? []
        const dateChanges = diffReports(date, before, list)
        const message = `正在写入 ${date}（${i + 1}/${datesToWrite.length}）…`
        syncProgress.value = { done: i, total: datesToWrite.length, message }
        onProgress?.({ done: i, total: datesToWrite.length, message })
        try {
          await transport().reportsUpsert(date, list)
          // 写入后带上本地同步时间，界面不用等重新读库才能显示「同步于」
          nextCache[date] = list.map(report => ({ ...report, syncedAt: writtenAt }))
          writtenDates++
          if (!list.length)
            removedDates++
          if (dateChanges.length) {
            changes.push(...dateChanges)
            changedDates.add(date)
          }
        }
        catch (err) {
          failedDates.push(date)
          if (!firstError)
            firstError = err instanceof Error ? err.message : String(err)
        }
      }

      cache.value = nextCache
      const at = new Date().toISOString()
      const nextState: ReportSyncState = mode === 'full'
        ? { ...syncState.value, lastFullAt: at, lastFullFrom: from, lastFullTo: to }
        : { ...syncState.value, lastIncrementalAt: at, lastIncrementalFrom: from, lastIncrementalTo: to }
      await transport().reportsSetSyncState(nextState)
      syncState.value = nextState

      const outcome: ReportSyncOutcome = {
        mode,
        from,
        to,
        fetched: reports.length,
        writtenDates,
        removedDates,
        failedDates,
        changes,
        changedDates: [...changedDates].sort(),
        at,
      }
      if (failedDates.length)
        syncError.value = `${failedDates.length} 天写入失败：${failedDates.slice(0, 3).join('、')}`
          + (firstError ? `。首个错误：${firstError}` : '')
      return outcome
    }
    catch (err) {
      syncError.value = err instanceof Error ? err.message : String(err)
      throw err
    }
    finally {
      syncing.value = false
      syncProgress.value = null
    }
  }

  /** 增量同步：只覆盖选定区间，源系统没返回的日期保持本地原样 */
  function syncIncremental(
    from: string,
    to: string,
    onProgress?: (progress: ReportSyncProgress) => void,
  ) {
    return syncRange('incremental', from, to, onProgress)
  }

  /** 全量同步：按指定区间重拉，并清掉源系统已没有的日期 */
  function syncFull(from: string, to: string, onProgress?: (progress: ReportSyncProgress) => void) {
    return syncRange('full', from, to, onProgress)
  }

  /**
   * 强制刷新某人某天。
   *
   * 只替换这个成员的行；同一天其他人的日报原样保留。源系统里已经
   * 没有这条日志时传 null，让 DB 删掉它——「员工删除了日志」也是需要同步的事实。
   */
  async function forceMemberDay(
    memberId: string,
    memberName: string,
    date: string,
  ): Promise<{ found: boolean, report: DailyReport | null }> {
    const cfg = settingsStore.settings.dailyReport
    if (cfg.source !== 'http')
      throw new Error('当前日报来源不是接口，无法强制同步')

    const source = createDailyReportSource(cfg)
    const reports = await source.fetchByDate(date)
    const hit = reports.find(r => r.memberId === memberId)
      ?? (memberName ? reports.find(r => r.memberName === memberName) : undefined)

    await transport().reportsUpsertMember(date, memberId, hit ? [hit] : null)
    const next = (cache.value[date] ?? []).filter(r => r.memberId !== memberId)
    if (hit)
      next.push({ ...hit, syncedAt: new Date().toISOString() })
    cache.value = { ...cache.value, [date]: next }
    liveError.value = null
    return { found: Boolean(hit), report: hit ?? null }
  }

  async function loadSyncState() {
    try {
      syncState.value = await transport().reportsSyncState()
    }
    catch {
      // 老版本/浏览器环境读不到状态时按从未同步处理，不影响同步本身
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
    const empty = { ...EMPTY_SYNC_STATE }
    try {
      await transport().reportsSetSyncState(empty)
      syncState.value = empty
    }
    catch {
      // 清空日报成功但状态没重置时，下次同步仍可正常覆盖
    }
  }

  return {
    cache,
    loaded,
    lastError,
    liveError,
    syncState,
    syncing,
    syncError,
    syncProgress,
    allDates,
    totalReports,
    load,
    loadSyncState,
    put,
    refreshRange,
    syncIncremental,
    syncFull,
    forceMemberDay,
    get,
    findMember,
    importCsv,
    clear,
  }
})
