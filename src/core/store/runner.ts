import type { AppSettings } from '../config/settings'
import type { DailyReport, GitCommit, GitLabProjectRef, InspectionProgress, InspectionResult, MemberIdentityInput, MemberProfile, WorkSignal } from '../domain/types'
import type { ProjectCatalog } from '../engine/projectCatalog'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { transport } from '../bridge'
import { GitLabClient } from '../adapters/gitlab'
import type { CommitQuery } from '../adapters/gitlab'
import { createDailyReportSource } from '../adapters/dailyReport'
import { createLlmClient } from '../llm/client'
import { runInspection } from '../engine/inspector'
import { collectBranchCommits } from '../engine/branchCommits'
import { collectWorkSignals } from '../engine/workSignals'
import { buildProjectCatalog, catalogFingerprint } from '../engine/projectCatalog'
import { useSettingsStore } from './settings'
import { useReportStore } from './reports'
import { useHistoryStore } from './history'
import { useProjectStore } from './projects'
import { useMemberStore } from './members'
import { shiftDate } from '../engine/window'
import { formatDateCN } from '@/lib/format'

/**
 * 检查执行器。
 *
 * 负责把配置、数据源、GitLab 客户端、模型客户端组装成一次检查，
 * 并把进度与模型的增量输出暴露给界面。
 * 检查引擎本身是无状态的纯函数，状态都收在这里，便于「重跑/取消」。
 */

export interface RunTarget {
  member: MemberIdentityInput
  report?: DailyReport
}

export interface RunFailure {
  memberId: string
  memberName: string
  /** 区间检查时用来定位是哪一天失败 */
  date?: string
  message: string
}

export interface RunPlan {
  date: string
  targets: RunTarget[]
}

/** 一次执行的区间信息；历史页据此把多条结果归为同一个批次 */
export interface RunRange {
  from: string
  to: string
  /** 区间内实际检查的工作日数（工作日历跳过节假日/周末后） */
  checkedWorkdays?: number
  /** 被工作日历跳过的天数 */
  skippedDays?: number
}

export interface RunOptions {
  saveToHistory?: boolean
  range?: RunRange
}

export const useRunnerStore = defineStore('runner', () => {
  const settingsStore = useSettingsStore()
  const reportStore = useReportStore()
  const historyStore = useHistoryStore()
  const projectStore = useProjectStore()
  const memberStore = useMemberStore()

  const running = ref(false)
  const progress = ref<InspectionProgress>({ stage: 'idle', message: '', percent: 0 })
  /** 当前正在判定的日报条目，界面上高亮用 */
  const activeEntryId = ref<string | null>(null)
  /** 模型增量输出，按条目 ID 分组；'__summary__' 是整体结论 */
  const thinking = shallowRef<Record<string, string>>({})

  const queue = ref<RunTarget[]>([])
  const results = ref<InspectionResult[]>([])
  const failures = ref<RunFailure[]>([])
  const catalog = ref<ProjectCatalog | null>(null)
  const catalogError = ref<string | null>(null)
  const buildingCatalog = ref(false)
  const currentLabel = ref('')

  let abort: AbortController | null = null
  let catalogFingerprintValue = ''

  const finished = computed(() => results.value.length + failures.value.length)
  const total = computed(() => queue.value.length)
  const overallPercent = computed(() => {
    if (!total.value)
      return 0
    const inFlight = activeEntryId.value ? 0.5 : 0
    return Math.min(100, Math.round(((finished.value + inFlight) / total.value) * 100))
  })

  /*
   * 模型增量如果每个 token 都写响应式对象，LiveRunPanel 和 Markdown
   * 会以每秒几十次的频率重渲染；24 个目标跑下来主线程会被拖住。
   * 按 80ms 合并一次，既跟得上阅读节奏，也不会把页面卡死。
   */
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null
  const thinkingBuffer = new Map<string, string>()

  function flushThinking() {
    if (thinkingTimer) {
      clearTimeout(thinkingTimer)
      thinkingTimer = null
    }
    if (!thinkingBuffer.size)
      return

    const next = { ...thinking.value }
    for (const [id, text] of thinkingBuffer)
      next[id] = text.slice(-4000)
    thinkingBuffer.clear()
    thinking.value = next
  }

  function pushThinking(delta: string, entryId: string) {
    activeEntryId.value = entryId === '__summary__' ? null : entryId
    thinkingBuffer.set(entryId, (thinkingBuffer.get(entryId) ?? thinking.value[entryId] ?? '') + delta)
    if (!thinkingTimer)
      thinkingTimer = setTimeout(flushThinking, 100)
  }

  async function ensureCatalog(force = false): Promise<ProjectCatalog | null> {
    const settings = settingsStore.settings
    const fingerprint = catalogFingerprint(settings)
    if (!force && catalog.value && fingerprint === catalogFingerprintValue)
      return catalog.value

    buildingCatalog.value = true
    catalogError.value = null
    try {
      const built = await buildProjectCatalog({
        settings,
        gitlab: new GitLabClient(settings.gitlab),
        onProgress: (message) => {
          progress.value = { stage: 'matching', message, percent: 5 }
        },
      })
      catalog.value = built
      catalogFingerprintValue = fingerprint
      return built
    }
    catch (err) {
      catalogError.value = err instanceof Error ? err.message : String(err)
      return null
    }
    finally {
      buildingCatalog.value = false
    }
  }

  function buildDeps(
    settings: AppSettings,
    signal: AbortSignal,
    date: string,
    gitlab: GitLabClient,
    llm: ReturnType<typeof createLlmClient>,
    reportSource: ReturnType<typeof createDailyReportSource>,
    commitCache: Map<string, Promise<GitCommit[]>>,
    signalCache: Map<string, Promise<WorkSignal[]>>,
    useLlmEffort: boolean,
  ) {
    return {
      settings,
      gitlab,
      reportSource,
      llm,
      knownProjects: catalog.value?.projects ?? [],
      projects: projectStore.items,
      members: memberStore.items,
      useLlmEffort,
      /*
       * 同一天、同一个仓库的提交列表在整次执行里只请求一次。
       * 两个成员检查同一天时，第二个成员直接复用；文件变更由引擎按作者
       * 筛出本人提交后再补，不会再给全项目所有人的提交逐条拉 diff。
       */
      fetchCommits: (project: GitLabProjectRef, query: CommitQuery) => {
        const key = [
          date,
          project.id,
          query.since,
          query.until,
          query.refName ?? '',
          query.perPage,
          query.maxCommits,
          query.fetchFileChanges ? '1' : '0',
        ].join('|')
        let pending = commitCache.get(key)
        if (!pending) {
          pending = collectBranchCommits(gitlab, project, query, { maxBranches: 24 })
            .then(result => result.commits)
            .catch((err) => {
              // 失败不要留在缓存里，下一个人/下一次还能重试
              commitCache.delete(key)
              throw err
            })
          commitCache.set(key, pending)
        }
        return pending
      },
      /*
       * 活动事件同样按「日期 + 仓库」缓存：同一天多个成员共享一次请求。
       * 失败时返回空数组而不是抛出——事件只是工时估算的补充证据，
       * 不能因为 GitLab 不让读事件就让整次检查失败。
       */
      fetchSignals: (project: GitLabProjectRef, day: string) => {
        const key = `${day}|${project.id}`
        let pending = signalCache.get(key)
        if (!pending) {
          pending = collectWorkSignals(gitlab, [project], day, day, { maxEventsPerProject: 400, signal })
            .then(result => result.signals)
            .catch((err) => {
              signalCache.delete(key)
              throw err
            })
          signalCache.set(key, pending)
        }
        return pending
      },
      signal,
      onProgress: (p: InspectionProgress) => {
        progress.value = p
      },
      onThinking: pushThinking,
      // 提交落库：留一份审计痕迹，同时作为全文检索的语料。
      // 这里刻意把 diff 正文剥掉再传：Rust 侧只存文件路径，正文传给过去也是白占 IPC，
      // 200 条提交的 diff 加起来能有几十 MB。
      onCommitsFetched: async (commits: GitCommit[]) => {
        const lean = commits.map(c => ({
          ...c,
          fileChanges: c.fileChanges?.map(({ patch: _patch, ...rest }) => rest),
        }))
        await transport().commitsUpsert(lean)
      },
    }
  }

  /**
   * 按「日期 → 目标」的计划执行检查。
   *
   * 单日检查传一个 plan；区间检查传多个。结果和时间进度都按日期累计，
   * 历史仍然是一条「日期 + 成员」记录，和单日检查完全一样。
   */
  async function execute(
    plans: RunPlan[],
    opts: RunOptions = {},
  ): Promise<{ results: InspectionResult[], failures: RunFailure[] }> {
    if (running.value)
      throw new Error('已有检查在进行中')

    const settings = settingsStore.settings
    const totalTargets = plans.reduce((s, p) => s + p.targets.length, 0)

    // 整次执行共用一组客户端和数据源；提交列表按「日期 + 仓库」缓存
    const gitlab = new GitLabClient(settings.gitlab)
    const llm = createLlmClient(settings.llm)
    const reportSource = createDailyReportSource(
      settings.dailyReport,
      Object.values(reportStore.cache).flat(),
    )
    const commitCache = new Map<string, Promise<GitCommit[]>>()
    const signalCache = new Map<string, Promise<WorkSignal[]>>()

    /*
     * 一次执行（单日或区间）共用同一个 runId。
     * 历史页按它把「人 × 工作日」的多条结果收成一个批次，而不是散成一堆日期。
     */
    const runId = globalThis.crypto?.randomUUID?.()
      ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const runFrom = opts.range?.from ?? plans[0]?.date ?? ''
    const runTo = opts.range?.to ?? plans[plans.length - 1]?.date ?? ''
    const checkedWorkdays = opts.range?.checkedWorkdays ?? plans.length
    const skippedDays = opts.range?.skippedDays ?? 0

    running.value = true
    results.value = []
    failures.value = []
    queue.value = plans.flatMap(p => p.targets)
    if (thinkingTimer) {
      clearTimeout(thinkingTimer)
      thinkingTimer = null
    }
    thinkingBuffer.clear()
    thinking.value = {}
    activeEntryId.value = null
    abort = new AbortController()

    try {
      if (!catalog.value)
        await ensureCatalog()

      let done = 0
      for (const plan of plans) {
        for (const target of plan.targets) {
          if (abort.signal.aborted)
            break

          currentLabel.value = plans.length > 1
            ? `${formatDateCN(plan.date)} · ${target.member.name}（${done + 1}/${totalTargets}）`
            : `${target.member.name}（${done + 1}/${totalTargets}）`

          const report = target.report
            ?? reportStore.findMember(plan.date, target.member.id, target.member.name)

          try {
            const result = await runInspection(
              { date: plan.date, member: target.member, report },
              buildDeps(settings, abort.signal, plan.date, gitlab, llm, reportSource, commitCache, signalCache, plans.length === 1),
            )
            const enriched: InspectionResult = {
              ...result,
              meta: {
                ...result.meta,
                runId,
                runFrom,
                runTo,
                checkedWorkdays,
                skippedDays,
              },
            }
            results.value = [...results.value, enriched]
            if (opts.saveToHistory !== false)
              await historyStore.save(enriched)
          }
          catch (err) {
            if (abort.signal.aborted)
              break
            failures.value = [
              ...failures.value,
              {
                memberId: target.member.id,
                memberName: target.member.name,
                date: plan.date,
                message: err instanceof Error ? err.message : String(err),
              },
            ]
          }
          done++
          activeEntryId.value = null
        }
        if (abort.signal.aborted)
          break
      }
    }
    finally {
      flushThinking()
      running.value = false
      currentLabel.value = ''
      abort = null
      progress.value = progress.value.stage === 'failed'
        ? progress.value
        : { stage: 'done', message: '检查结束', percent: 100 }
    }

    return { results: results.value, failures: failures.value }
  }

  async function run(
    date: string,
    targets: RunTarget[],
    opts: RunOptions = {},
  ): Promise<{ results: InspectionResult[], failures: RunFailure[] }> {
    return execute([{ date, targets }], {
      saveToHistory: opts.saveToHistory,
      range: { from: date, to: date, checkedWorkdays: 1, skippedDays: 0 },
    })
  }

  async function runDays(
    plans: RunPlan[],
    opts: RunOptions = {},
  ): Promise<{ results: InspectionResult[], failures: RunFailure[] }> {
    return execute(plans, opts)
  }

  function cancel() {
    abort?.abort()
    running.value = false
    progress.value = { stage: 'failed', message: '已取消', percent: 0 }
  }

  return {
    running,
    progress,
    activeEntryId,
    thinking,
    results,
    failures,
    queue,
    catalog,
    catalogError,
    buildingCatalog,
    currentLabel,
    finished,
    total,
    overallPercent,
    ensureCatalog,
    run,
    runDays,
    cancel,
  }
})

/* ------------------------------------------------------------------ *
 * 目标成员收集
 * ------------------------------------------------------------------ */

export interface MemberOption {
  id: string
  name: string
  /** 这个人在 Git 里用过的用户名，可能多个 */
  gitlabUsernames: string[]
  emails: string[]
  /** 来源：已配置的人员实体，还是仅在日报里出现过 */
  source: 'profile' | 'report'
  enabled: boolean
  /** 关注标记。检查页默认只勾选关注的人，未关注的仍列出来，可以手动勾上 */
  followed: boolean
}

/** 某天的检查对象 = 已启用的人员实体 ∪ 当天有日报的人。 */
export function collectMembers(date: string, profiles: MemberProfile[], reports: DailyReport[]): MemberOption[] {
  const map = new Map<string, MemberOption>()

  for (const profile of profiles) {
    if (!profile.enabled)
      continue
    // 人员实体的 id 是本地 uuid，日报里用的是 reportMemberId；
    // 用日报 ID 作为 key 才能和下面的日报数据对上，没有日报 ID 才退回 uuid
    const key = profile.reportMemberId || profile.id
    map.set(key, {
      id: key,
      name: profile.name,
      gitlabUsernames: profile.gitlabUsernames ?? [],
      emails: profile.emails,
      source: 'profile',
      enabled: true,
      followed: profile.followed,
    })
  }

  for (const report of reports.filter(r => r.date === date)) {
    const existing = map.get(report.memberId) ?? map.get(report.memberName)
    if (existing) {
      existing.name = report.memberName
      continue
    }
    // 只在日报里出现过、还没有人员实体的人：没有关注设置可读，
    // 按「默认全部关注」处理，否则他们会一上来就被排除在默认勾选之外
    map.set(report.memberId, {
      id: report.memberId,
      name: report.memberName,
      gitlabUsernames: [],
      emails: [],
      source: 'report',
      enabled: true,
      followed: true,
    })
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export { shiftDate }
