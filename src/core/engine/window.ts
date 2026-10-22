import type { RuleSettings } from '../config/settings'

/**
 * 提交归属时间窗。
 *
 * 现实中「某天的代码」并不等于「当天 00:00-24:00 的提交」：晚上加班到凌晨、
 * 以及第二天早上补提交昨天的代码都很常见。所以窗口取
 *   [D + windowStartHour, D + 24 + windowEndHour)
 * 默认 -4 / 8，即前一晚 20:00 到次日早上 08:00 都算 D 的工作。
 *
 * 相邻两天的窗口会重叠，批量检查时用 assignCommitDate 做一次划分：
 * 同一个提交归属到「最早的那个命中窗口」，因此深夜连续工作会被算进开始那天，
 * 符合日报里「今天加班到几点」的写法。
 *
 * 时区用配置里的固定偏移而不是本机时区，保证换一台机器跑结果一致。
 */

export interface CommitWindow {
  since: string
  until: string
  /** 供 UI 展示，形如 10-15 20:00 ~ 10-16 08:00 */
  label: string
}

function offsetMs(rules: RuleSettings) {
  return rules.timezoneOffsetMinutes * 60_000
}

function parseDateKey(dateKey: string) {
  const m = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m)
    throw new Error(`日期格式应为 YYYY-MM-DD，收到 ${dateKey}`)
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/** 把「D 日的第 hour 小时（按配置时区）」换成 UTC 时刻。hour 可以是负数或 >24。 */
function atHour(dateKey: string, hour: number, rules: RuleSettings): Date {
  const { y, m, d } = parseDateKey(dateKey)
  return new Date(Date.UTC(y, m - 1, d, hour) - offsetMs(rules))
}

function formatLocal(utc: Date, rules: RuleSettings) {
  const shifted = new Date(utc.getTime() + offsetMs(rules))
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

export function commitWindow(dateKey: string, rules: RuleSettings): CommitWindow {
  const since = atHour(dateKey, rules.windowStartHour, rules)
  const until = atHour(dateKey, 24 + rules.windowEndHour, rules)
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    label: `${formatLocal(since, rules)} ~ ${formatLocal(until, rules)}`,
  }
}

/**
 * 判断某个提交时刻归属哪一天。
 * 返回 null 表示不落在任何一天的窗口内（理论上只有超出 24+end-start 小时跨度才会发生）。
 */
export function assignCommitDate(
  committedDate: string,
  candidateDates: string[],
  rules: RuleSettings,
): string | null {
  const t = new Date(committedDate).getTime()
  if (Number.isNaN(t))
    return null

  // 按日期升序，最先命中的窗口胜出，保证同一天内不重复归属
  const sorted = [...candidateDates].sort()
  for (const date of sorted) {
    const { since, until } = commitWindow(date, rules)
    if (t >= new Date(since).getTime() && t < new Date(until).getTime())
      return date
  }
  return null
}

/** 生成 from~to 之间的所有日期（含端点）。 */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end)
    return out
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

/** 前一天 / 后一天。 */
export function shiftDate(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * 提交是否落在窗口的「核心时段」内（当天 00:00 到 24:00）。
 * 核心时段外的提交仍参与判定，但会标记出来，避免把昨晚的工作算成今天的漏报。
 */
export function isCoreWindow(committedDate: string, dateKey: string, rules: RuleSettings): boolean {
  const t = new Date(committedDate).getTime()
  const start = atHour(dateKey, 0, rules).getTime()
  const end = atHour(dateKey, 24, rules).getTime()
  return t >= start && t < end
}
