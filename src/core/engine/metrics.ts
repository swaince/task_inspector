import type { DevMode, GitCommit } from '../domain/types'

/**
 * 工作量指标。
 *
 * 提交记录不是考勤数据：它只能证明「有代码产出」，证明不了开会、评审、答疑、
 * 排查线上问题这些同样耗时的活动；而且同事可能几天才提交一次、AI 开发又会让
 * 一天的代码量远超人工。所以这里**不用提交频率、也不按行数线性折算工时**，
 * 改用「提交会话」估算，并让代码量只做有上限的修正。
 *
 * 三个口径：
 * - 在场时长：当天第一条到最后一提交的跨度（封顶 12h），只能说明「这段时间在线」；
 * - 活跃时长：有提交的 30 分钟时段数 × 0.5h，反映实际在敲代码的密度；
 * - 预估有效工时：按提交会话估算，再按项目开发模式对代码量做小幅修正，
 *   结果是区间；只覆盖代码产出，不含会议等非编码工作。
 */

const BUCKET_MS = 30 * 60 * 1000
const MAX_HOURS = 12

/** 相邻提交间隔超过这个值，视为另一个工作会话 */
const SESSION_GAP_MS = 60 * 60 * 1000
/** 每个会话额外补的收尾时间（整理、提交、验证） */
const SESSION_TAIL_HOURS = 0.25
/** 单个会话最多计 4 小时：中间可能有长时间的思考或离开 */
const SESSION_CAP_HOURS = 4
/** 单条提交的会话按半小时计 */
const SINGLE_COMMIT_SESSION_HOURS = 0.5

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
}

export interface DayMetrics {
  commits: number
  additions: number
  deletions: number
  firstAt?: string
  lastAt?: string
  /** 首末提交跨度，封顶 12h */
  presenceHours: number
  /** 有提交的 30 分钟时段数 */
  activeBuckets: number
  /** 活跃时段折算工时（每段 0.5h） */
  activeHours: number
  /** 提交会话数（间隔超过 60 分钟算新会话） */
  sessions: number
  /** 有效工时估算使用的开发模式 */
  devMode: DevMode
  /** 预估有效工时区间 */
  effectiveLow: number
  effectiveHigh: number
  /** 区间中值，用于算饱和度 */
  effectiveMid: number
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

/** 把有序时间戳切成会话，返回会话数与总时长（小时） */
function sessionsOf(stamps: number[]): { count: number, hours: number } {
  if (!stamps.length)
    return { count: 0, hours: 0 }

  let count = 0
  let hours = 0
  let start = stamps[0]
  let prev = stamps[0]

  const flush = () => {
    const span = (prev - start) / 3_600_000
    const duration = Math.min(span + SESSION_TAIL_HOURS, SESSION_CAP_HOURS)
    hours += Math.max(duration, SINGLE_COMMIT_SESSION_HOURS)
    count++
  }

  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i] - prev > SESSION_GAP_MS) {
      flush()
      start = stamps[i]
    }
    prev = stamps[i]
  }
  flush()

  return { count, hours }
}

export function dayMetrics(commits: GitCommit[], opts: DayMetricsOptions = {}): DayMetrics {
  const mode = opts.devMode ?? 'manual'
  const params = MODE_PARAMS[mode]

  const stamps = commits
    .map(c => Date.parse(c.authoredDate))
    .filter(t => Number.isFinite(t))
    .sort((a, b) => a - b)

  const additions = commits.reduce((sum, c) => sum + (c.stats?.additions ?? 0), 0)
  const deletions = commits.reduce((sum, c) => sum + (c.stats?.deletions ?? 0), 0)
  const volume = additions + deletions

  if (!stamps.length) {
    return {
      commits: 0,
      additions: 0,
      deletions: 0,
      presenceHours: 0,
      activeBuckets: 0,
      activeHours: 0,
      sessions: 0,
      devMode: mode,
      effectiveLow: 0,
      effectiveHigh: 0,
      effectiveMid: 0,
      batchSuspect: false,
      basis: '当天没有提交',
    }
  }

  const first = stamps[0]
  const last = stamps[stamps.length - 1]
  const buckets = new Set(stamps.map(t => Math.floor(t / BUCKET_MS)))

  const presenceHours = round1(clamp((last - first) / 3_600_000, 0, MAX_HOURS))
  const activeHours = round1(clamp(buckets.size * 0.5, 0, MAX_HOURS))

  const sessions = sessionsOf(stamps)
  const base = Math.min(sessions.hours, MAX_HOURS)

  // 代码量只做有上限的修正，避免 AI 生成的大改动把工时推到天花板
  const factor = Math.min(params.cap, 1 + params.weight * Math.log10(1 + volume / params.baseline))
  const low = round1(clamp(base * 0.8, 0, 10))
  const high = round1(clamp(Math.max(low, base * factor), low, MAX_HOURS))

  const spanMinutes = (last - first) / 60_000
  const batchSuspect = volume >= 500 && ((stamps.length <= 2 && spanMinutes <= 30) || base < 1.5)

  const notes: string[] = []
  if (batchSuspect)
    notes.push('提交集中在很短的时间里，可能是一次补提交')

  return {
    commits: commits.length,
    additions,
    deletions,
    firstAt: new Date(first).toISOString(),
    lastAt: new Date(last).toISOString(),
    presenceHours,
    activeBuckets: buckets.size,
    activeHours,
    sessions: sessions.count,
    devMode: mode,
    effectiveLow: low,
    effectiveHigh: high,
    effectiveMid: round1((low + high) / 2),
    batchSuspect,
    basis: `按 ${sessions.count} 个提交会话估算（间隔超过 60 分钟算新会话），`
      + `代码量 +${additions}/-${deletions} 按「${params.label}」模式修正（最多放大到 ${params.cap} 倍）；`
      + `仅代码产出，不含会议、评审等非编码工作`
      + (notes.length ? `。${notes.join('；')}` : ''),
  }
}

/**
 * 一天涉及多个项目时的估算。
 *
 * 不同项目可能标注了不同的开发模式，所以先按项目分别估算再相加；
 * 会话、时段按项目累加，在场时长取最长的那一段（同一个人同一天不会同时在两处）。
 */
export function groupedDayMetrics(
  commits: GitCommit[],
  modeOf: (commit: GitCommit) => DevMode,
): DayMetrics {
  if (!commits.length)
    return dayMetrics([])

  const groups = new Map<string, GitCommit[]>()
  for (const commit of commits) {
    const key = commit.projectPath || String(commit.projectId)
    const list = groups.get(key) ?? []
    list.push(commit)
    groups.set(key, list)
  }

  const parts = [...groups.values()].map(list => dayMetrics(list, { devMode: modeOf(list[0]) }))

  const low = round1(clamp(parts.reduce((s, p) => s + p.effectiveLow, 0), 0, 12))
  const high = round1(clamp(parts.reduce((s, p) => s + p.effectiveHigh, 0), low, 12))
  const basisParts = [...new Set(parts.map(p => MODE_PARAMS[p.devMode].label))]

  return {
    commits: commits.length,
    additions: parts.reduce((s, p) => s + p.additions, 0),
    deletions: parts.reduce((s, p) => s + p.deletions, 0),
    firstAt: parts.map(p => p.firstAt).filter(Boolean).sort()[0],
    lastAt: parts.map(p => p.lastAt).filter(Boolean).sort().reverse()[0],
    presenceHours: Math.max(...parts.map(p => p.presenceHours)),
    activeBuckets: parts.reduce((s, p) => s + p.activeBuckets, 0),
    activeHours: round1(parts.reduce((s, p) => s + p.activeHours, 0)),
    sessions: parts.reduce((s, p) => s + p.sessions, 0),
    devMode: parts[0].devMode,
    effectiveLow: low,
    effectiveHigh: high,
    effectiveMid: round1((low + high) / 2),
    batchSuspect: parts.some(p => p.batchSuspect),
    basis: `按 ${parts.reduce((s, p) => s + p.sessions, 0)} 个提交会话估算，`
      + `代码量按项目开发模式修正（${basisParts.join('、')}）；仅代码产出，不含会议、评审等非编码工作`
      + (parts.some(p => p.batchSuspect) ? '。存在提交集中在短时间的日期，可能是一次补提交' : ''),
  }
}

/** 工作饱和度：预估有效工时中值 / 标准工时 */
export function saturationOf(metrics: { effectiveMid: number }, standardHours = 8) {
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

export function aggregateWorkload(days: DayMetrics[], workingDays: number, standardHours = 8): RangeWorkload {
  const activeDays = days.filter(d => d.commits > 0).length
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
