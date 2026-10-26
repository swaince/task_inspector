import type { WorkloadSettings } from '../config/settings'
import type { DevMode, GitCommit, WorkSignal } from '../domain/types'
import { DEFAULT_WORKLOAD } from '../config/settings'

/**
 * 工作量指标。
 *
 * 提交记录不是考勤数据：它只能证明「有代码产出」，证明不了开会、评审、答疑、
 * 排查线上问题这些同样耗时的活动。所以这里不再把「提交会话」直接当成有效工时，
 * 而是分成三层证据：
 *
 * 1. **代码可核对下限**：提交会话按首尾缓冲估算，乘一个保守系数；
 * 2. **活动证据**：提交 + MR / 评审 / Issue 事件拼出的工作片段；
 * 3. **在岗跨度**：当天首末活动之间的跨度，按比例折算成上限参考。
 *
 * 最终给区间 `effectiveLow ~ effectiveHigh`：下限只认代码，上限把其他信号也算进来。
 * 参数全部来自设置里的「工时估算口径」，不同公司可以标定，而不是写死在代码里。
 */

const BUCKET_MS = 30 * 60 * 1000
const PRESENCE_CAP_HOURS = 12
const LOW_FACTOR = 0.8
const EXTERNAL_LOW_FACTOR = 0.5

/**
 * 各开发模式下代码量的修正参数。
 *
 * factor = 1 + weight × log10(1 + 改动量 / baseline)，再封顶。
 * 人工开发时改动量能明显拉长工时；AI 开发时同样的行数并不代表同样的投入，
 * 所以权重和上限都收小。默认 manual。
 */
const MODE_PARAMS: Record<DevMode, { weight: number, baseline: number, cap: number, label: string }> = {
  manual: { weight: 0.20, baseline: 300, cap: 1.6, label: '人工开发' },
  'ai-assisted': { weight: 0.10, baseline: 1000, cap: 1.25, label: 'AI 辅助' },
  'ai-driven': { weight: 0.03, baseline: 3000, cap: 1.08, label: 'AI 开发为主' },
}

export interface DayMetricsOptions {
  /** 项目开发模式；缺省按 manual */
  devMode?: DevMode
  /** 提交之外的 MR / 评审 / Issue 事件 */
  signals?: WorkSignal[]
  /** 工时口径；缺省用默认值 */
  workload?: WorkloadSettings
  /** 模型按任务估算的区间，只作为上限参考 */
  llm?: { low: number, high: number } | null
}

export interface DayMetrics {
  commits: number
  additions: number
  deletions: number
  firstAt?: string
  lastAt?: string
  /** 首末活动跨度，封顶 12h */
  presenceHours: number
  /** 有提交的 30 分钟时段数 */
  activeBuckets: number
  /** 活跃时段折算工时（每段 0.5h） */
  activeHours: number
  /** 提交会话数（间隔超过设置值算新会话） */
  sessions: number
  /** 提交会话折算的原始时长 */
  sessionHours: number
  /** 提交之外的证据条数 */
  signalCount: number
  /** 提交 + 事件拼出的工作片段时长 */
  activityHours: number
  /** 仅事件拼出的工作片段时长 */
  externalHours: number
  /** 代码证据下限 */
  codeLow: number
  /** 代码证据上限（含代码量修正） */
  codeHigh: number
  /** 有效工时估算使用的开发模式 */
  devMode: DevMode
  /** 预估有效工时区间 */
  effectiveLow: number
  effectiveHigh: number
  /** 区间中值，用于算饱和度 */
  effectiveMid: number
  /** 证据置信度：提交多且活动密时更高 */
  confidence: 'low' | 'medium' | 'high'
  /** 提交集中在很短的时间里但改动量很大：可能是一次数天的补提交 */
  batchSuspect: boolean
  /** 估算依据，界面上直接展示 */
  basis: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function round1(value: number) {
  return Math.round(value * 10) / 10
}

/**
 * 把有序时间戳切成工作片段。
 *
 * 每个片段 = 首末间隔 + 前置投入 + 收尾，封顶 `sessionCapHours`；
 * 片段再短也按「前置 + 收尾」计——一次提交背后通常不止按下提交按钮的那几秒。
 */
function episodesOf(
  stamps: number[],
  workload: WorkloadSettings,
): { count: number, hours: number } {
  if (!stamps.length)
    return { count: 0, hours: 0 }

  const gapMs = Math.max(1, workload.sessionGapMinutes) * 60_000
  const lead = Math.max(0, workload.sessionLeadMinutes) / 60
  const tail = Math.max(0, workload.sessionTailMinutes) / 60
  const cap = Math.max(0.5, workload.sessionCapHours)
  const minHours = Math.min(cap, lead + tail || 0.5)

  let count = 0
  let hours = 0
  let start = stamps[0]
  let prev = stamps[0]

  const flush = () => {
    const span = (prev - start) / 3_600_000
    hours += clamp(span + lead + tail, minHours, cap)
    count++
  }

  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i] - prev > gapMs) {
      flush()
      start = stamps[i]
    }
    prev = stamps[i]
  }
  flush()

  return { count, hours }
}

function stampsOf(commits: GitCommit[]) {
  return commits
    .map(c => Date.parse(c.authoredDate))
    .filter(t => Number.isFinite(t))
    .sort((a, b) => a - b)
}

function signalStampsOf(signals: WorkSignal[]) {
  return signals
    .map(s => Date.parse(s.at))
    .filter(t => Number.isFinite(t))
    .sort((a, b) => a - b)
}

function emptyMetrics(mode: DevMode, workload: WorkloadSettings): DayMetrics {
  return {
    commits: 0,
    additions: 0,
    deletions: 0,
    presenceHours: 0,
    activeBuckets: 0,
    activeHours: 0,
    sessions: 0,
    sessionHours: 0,
    signalCount: 0,
    activityHours: 0,
    externalHours: 0,
    codeLow: 0,
    codeHigh: 0,
    devMode: mode,
    effectiveLow: 0,
    effectiveHigh: 0,
    effectiveMid: 0,
    confidence: 'low',
    batchSuspect: false,
    basis: `当天没有提交或活动记录（口径：会话间隔 ${workload.sessionGapMinutes} 分钟）`,
  }
}

export function dayMetrics(commits: GitCommit[], opts: DayMetricsOptions = {}): DayMetrics {
  const mode = opts.devMode ?? 'manual'
  const params = MODE_PARAMS[mode]
  const workload = opts.workload ?? DEFAULT_WORKLOAD
  const signals = opts.signals ?? []

  const commitStamps = stampsOf(commits)
  const signalStamps = signalStampsOf(signals.filter(s => s.kind !== 'pipeline'))
  const externalStamps = signalStamps
  const allStamps = [...commitStamps, ...signalStamps].sort((a, b) => a - b)

  if (!allStamps.length)
    return emptyMetrics(mode, workload)

  const additions = commits.reduce((sum, c) => sum + (c.stats?.additions ?? 0), 0)
  const deletions = commits.reduce((sum, c) => sum + (c.stats?.deletions ?? 0), 0)
  const volume = additions + deletions

  const first = allStamps[0]
  const last = allStamps[allStamps.length - 1]
  const commitBuckets = new Set(commitStamps.map(t => Math.floor(t / BUCKET_MS)))

  const presenceHours = round1(clamp((last - first) / 3_600_000, 0, PRESENCE_CAP_HOURS))
  const activeBuckets = commitBuckets.size
  const activeHours = round1(clamp(activeBuckets * 0.5, 0, PRESENCE_CAP_HOURS))

  const sessions = episodesOf(commitStamps, workload)
  const activity = episodesOf(allStamps, workload)
  const external = episodesOf(externalStamps, workload)

  // 代码量只做有上限的修正，避免 AI 生成的大改动把工时推到天花板
  const factor = Math.min(params.cap, 1 + params.weight * Math.log10(1 + volume / params.baseline))
  const codeLow = round1(clamp(sessions.hours * LOW_FACTOR, 0, workload.maxHours))
  const codeHigh = round1(clamp(sessions.hours * factor, 0, workload.maxHours))

  const presenceHigh = presenceHours * clamp(workload.presenceFactor, 0, 1)
  const hasHumanActivity = commits.length > 0 || signals.some(s => s.kind !== 'pipeline')
  const activeFloor = hasHumanActivity ? Math.max(0, workload.activeFloorHours) : 0
  const llmHigh = Math.max(0, opts.llm?.high ?? 0)

  /*
   * 下限只认能落到具体提交/事件上的证据；事件本身不是「写代码」，折半计。
   * 上限取几路证据里最宽的一路，不在它们之间相加——同一天的工作会在
   * 提交、事件、在岗跨度里重复出现，相加等于把一份工作算两遍。
   */
  const low = round1(clamp(Math.max(codeLow, external.hours * EXTERNAL_LOW_FACTOR), 0, workload.maxHours))
  const high = round1(clamp(
    Math.max(low, codeHigh, activity.hours, presenceHigh, activeFloor, llmHigh),
    low,
    workload.maxHours,
  ))

  const spanMinutes = commitStamps.length > 1
    ? (commitStamps[commitStamps.length - 1] - commitStamps[0]) / 60_000
    : 0
  const batchSuspect = volume >= 500 && ((commits.length <= 2 && spanMinutes <= 30) || sessions.hours < 1.5)

  const confidence: DayMetrics['confidence'] = commits.length >= 4 && (presenceHours >= 4 || signals.length >= 3)
    ? 'high'
    : commits.length >= 2 || (commits.length >= 1 && signals.length >= 2)
      ? 'medium'
      : 'low'

  const notes: string[] = []
  if (batchSuspect)
    notes.push('提交集中在很短的时间里，可能是一次补提交')
  if (signals.length)
    notes.push(`另有 ${signals.length} 条 MR/评审/Issue 活动`)

  const llmText = llmHigh > 0 ? `；模型任务估算上限 ${round1(llmHigh)}h` : ''

  return {
    commits: commits.length,
    additions,
    deletions,
    firstAt: new Date(first).toISOString(),
    lastAt: new Date(last).toISOString(),
    presenceHours,
    activeBuckets,
    activeHours,
    sessions: sessions.count,
    sessionHours: round1(sessions.hours),
    signalCount: signals.length,
    activityHours: round1(activity.hours),
    externalHours: round1(external.hours),
    codeLow,
    codeHigh,
    devMode: mode,
    effectiveLow: low,
    effectiveHigh: high,
    effectiveMid: round1((low + high) / 2),
    confidence,
    batchSuspect,
    basis: `代码可核对 ${low}–${codeHigh}h：${sessions.count} 个提交会话，会话间隔 ${workload.sessionGapMinutes} 分钟，`
      + `首尾各补 ${workload.sessionLeadMinutes}/${workload.sessionTailMinutes} 分钟，`
      + `代码量 +${additions}/-${deletions} 按「${params.label}」修正（最多 ${params.cap} 倍）；`
      + `活动证据 ${activity.hours ? `${round1(activity.hours)}h` : '无'}（提交 + 事件片段），`
      + `在岗跨度 ${presenceHours}h 按 ${Math.round(clamp(workload.presenceFactor, 0, 1) * 100)}% 折算；`
      + `有效工时取 ${low}–${high}h${llmText}`
      + (notes.length ? `。${notes.join('；')}` : ''),
  }
}

/**
 * 一天涉及多个项目时的估算。
 *
 * 不同项目可能标注了不同的开发模式，所以先按项目分别算代码证据；
 * 首末跨度取最长的那一段（同一个人同一天不会同时在两处），事件按项目归属。
 */
export function groupedDayMetrics(
  commits: GitCommit[],
  modeOf: (commit: GitCommit) => DevMode,
  opts: { signals?: WorkSignal[], workload?: WorkloadSettings, llm?: { low: number, high: number } | null } = {},
): DayMetrics {
  const workload = opts.workload ?? DEFAULT_WORKLOAD
  const signals = opts.signals ?? []
  if (!commits.length && !signals.length) {
    const empty = emptyMetrics('manual', workload)
    /*
     * 只有日报、没有提交/活动的日子：确定性证据为 0，但模型仍可能
     * 根据申报内容给出一个上限。不显示下限，只把上限带出去。
     */
    const llmHigh = Math.max(0, opts.llm?.high ?? 0)
    if (llmHigh > 0) {
      empty.effectiveHigh = round1(clamp(llmHigh, 0, workload.maxHours))
      empty.effectiveMid = round1(empty.effectiveHigh / 2)
      empty.basis = `没有提交或活动证据；仅模型按日报内容估算上限 ${empty.effectiveHigh}h`
    }
    return empty
  }

  const commitGroups = new Map<string, GitCommit[]>()
  for (const commit of commits) {
    const key = commit.projectPath || String(commit.projectId)
    const list = commitGroups.get(key) ?? []
    list.push(commit)
    commitGroups.set(key, list)
  }

  const signalGroups = new Map<string, WorkSignal[]>()
  for (const signal of signals) {
    const key = signal.projectPath || String(signal.projectId)
    const list = signalGroups.get(key) ?? []
    list.push(signal)
    signalGroups.set(key, list)
  }

  const keys = new Set([...commitGroups.keys(), ...signalGroups.keys()])
  const parts = [...keys].map((key) => {
    const groupCommits = commitGroups.get(key) ?? []
    const groupSignals = signalGroups.get(key) ?? []
    return dayMetrics(groupCommits, {
      devMode: groupCommits.length ? modeOf(groupCommits[0]) : 'manual',
      signals: groupSignals,
      workload,
    })
  })

  const maxHours = workload.maxHours
  const low = round1(clamp(parts.reduce((s, p) => s + p.effectiveLow, 0), 0, maxHours))
  const codeHighSum = parts.reduce((s, p) => s + p.codeHigh, 0)
  const activitySum = parts.reduce((s, p) => s + p.activityHours, 0)
  const presenceMax = Math.max(...parts.map(p => p.presenceHours))
  const signalCount = parts.reduce((s, p) => s + p.signalCount, 0)
  const floor = commits.length || signals.some(s => s.kind !== 'pipeline')
    ? Math.max(0, workload.activeFloorHours)
    : 0
  const llmHigh = Math.max(0, opts.llm?.high ?? 0)
  const high = round1(clamp(
    Math.max(low, codeHighSum, activitySum, presenceMax * clamp(workload.presenceFactor, 0, 1), floor, llmHigh),
    low,
    maxHours,
  ))
  const basisParts = [...new Set(parts.map(p => MODE_PARAMS[p.devMode].label))]

  return {
    commits: commits.length,
    additions: parts.reduce((s, p) => s + p.additions, 0),
    deletions: parts.reduce((s, p) => s + p.deletions, 0),
    firstAt: parts.map(p => p.firstAt).filter(Boolean).sort()[0],
    lastAt: parts.map(p => p.lastAt).filter(Boolean).sort().reverse()[0],
    presenceHours: parts.reduce((max, p) => Math.max(max, p.presenceHours), 0),
    activeBuckets: parts.reduce((s, p) => s + p.activeBuckets, 0),
    activeHours: round1(parts.reduce((s, p) => s + p.activeHours, 0)),
    sessions: parts.reduce((s, p) => s + p.sessions, 0),
    sessionHours: round1(parts.reduce((s, p) => s + p.sessionHours, 0)),
    signalCount,
    activityHours: round1(activitySum),
    externalHours: round1(parts.reduce((s, p) => s + p.externalHours, 0)),
    codeLow: round1(parts.reduce((s, p) => s + p.codeLow, 0)),
    codeHigh: round1(codeHighSum),
    devMode: parts[0].devMode,
    effectiveLow: low,
    effectiveHigh: high,
    effectiveMid: round1((low + high) / 2),
    confidence: parts.some(p => p.confidence === 'high')
      ? 'high'
      : parts.some(p => p.confidence === 'medium') ? 'medium' : 'low',
    batchSuspect: parts.some(p => p.batchSuspect),
    basis: `代码可核对 ${round1(parts.reduce((s, p) => s + p.codeLow, 0))}–${round1(codeHighSum)}h（${parts.reduce((s, p) => s + p.sessions, 0)} 个提交会话，`
      + `开发模式 ${basisParts.join('、')}）；活动证据 ${round1(activitySum)}h，在岗跨度 ${round1(presenceMax)}h；`
      + `有效工时 ${low}–${high}h`
      + (signalCount ? `；含 ${signalCount} 条 MR/评审/Issue 活动` : '')
      + (parts.some(p => p.batchSuspect) ? '；存在提交集中在短时间的日期，可能是一次补提交' : ''),
  }
}

export interface DayRowMetricsInput {
  commits: GitCommit[]
  signals?: WorkSignal[]
  devMode: DevMode
}

/**
 * 「一个人 × 一天」跨项目的统一汇总。
 *
 * 人员活动和项目活动都必须走这里：两页之前各自把行级结果相加，
 * 多项目时会把有活动日的下限重复计入，模型估算也会被逐行相加。
 * 这里先合并同一天的全部提交/活动，再调用 groupedDayMetrics 统一封顶。
 */
export function memberDayMetrics(
  rows: DayRowMetricsInput[],
  workload: WorkloadSettings,
  llm?: { low: number, high: number } | null,
): DayMetrics {
  const commits = rows.flatMap(row => row.commits)
  const signals = rows.flatMap(row => row.signals ?? [])
  if (!commits.length && !signals.length)
    return emptyMetrics(rows[0]?.devMode ?? 'manual', workload)

  const modeByCommit = new Map<string, DevMode>()
  for (const row of rows) {
    for (const commit of row.commits)
      modeByCommit.set(commit.id, row.devMode)
  }

  return groupedDayMetrics(
    commits,
    commit => modeByCommit.get(commit.id) ?? rows[0]?.devMode ?? 'manual',
    { signals, workload, llm },
  )
}

/** 工作饱和度：预估有效工时中值 / 标准工时 */
export function saturationOf(
  metrics: { effectiveMid: number },
  standardHours = DEFAULT_WORKLOAD.standardHours,
) {
  if (!standardHours)
    return null
  return metrics.effectiveMid / standardHours
}

export interface RangeWorkload {
  /** 有提交的天数 */
  activeDays: number
  /** 统计用的工作日数（分母） */
  workingDays: number
  commits: number
  activeHours: number
  effectiveLow: number
  effectiveHigh: number
  /** 区间饱和度：有效工时合计 /（工作日 × 标准工时） */
  saturation: number | null
}

export function aggregateWorkload(
  days: DayMetrics[],
  workingDays: number,
  standardHours = DEFAULT_WORKLOAD.standardHours,
): RangeWorkload {
  const activeDays = days.filter(d => d.commits > 0 || d.signalCount > 0).length
  const effectiveLow = round1(days.reduce((s, d) => s + d.effectiveLow, 0))
  const effectiveHigh = round1(days.reduce((s, d) => s + d.effectiveHigh, 0))
  const mid = (effectiveLow + effectiveHigh) / 2
  const denominator = Math.max(0, workingDays) * standardHours
  return {
    activeDays,
    workingDays,
    commits: days.reduce((s, d) => s + d.commits, 0),
    activeHours: round1(days.reduce((s, d) => s + d.activeHours, 0)),
    effectiveLow,
    effectiveHigh,
    saturation: denominator > 0 ? round1(mid / denominator) : null,
  }
}
