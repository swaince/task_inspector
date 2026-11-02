import { shiftDate } from './window'

/**
 * 日报核对的滑动窗口。
 *
 * 现实里功能没开发完、当天不提交很常见，第二天甚至几天后才提交；
 * 只看日报当天会把这类工作判成「没有提交」。这里以日报日期为中心，
 * 向前后各取最多 N 个**工作日**：
 *
 * - 周三、N=2 → 周一 ~ 周五（5 天）
 * - 周四、N=2 → 周二 ~ 下周一（5 天，跨周末）
 * - 周五、N=2 → 周三 ~ 下周二（5 天，跨周末）
 * - 月底最后一天受自然月边界限制，只有前两个工作日加当天（3 天）
 *
 * 报告日期本身始终包含在窗口内——周末加班写了日报，也要以日报为准。
 * 窗口会跨过周末和节假日继续取工作日；只在**自然月边界**停止，
 * 所以月底最后一天只有前面的工作日，正好是 3 天。
 */
export interface ReportCheckWindow {
  anchor: string
  from: string
  to: string
  dates: string[]
}

export function reportCheckWindow(
  anchor: string,
  offsetWorkdays: number,
  isWorkday: (date: string) => boolean,
  bounds?: { from: string, to: string },
): ReportCheckWindow {
  const raw = Number(offsetWorkdays)
  const offset = Number.isFinite(raw) ? Math.max(0, Math.min(14, Math.round(raw))) : 0
  if (!offset)
    return { anchor, from: anchor, to: anchor, dates: [anchor] }

  const dates = new Set<string>([anchor])
  const inBounds = (date: string) =>
    !bounds || (date >= bounds.from && date <= bounds.to)

  let cursor = anchor
  let taken = 0
  for (let guard = 0; taken < offset && guard < 60; guard++) {
    cursor = shiftDate(cursor, -1)
    if (!inBounds(cursor))
      break
    // 跨过周末/节假日继续找工作日，但不跨出自然月
    if (!isWorkday(cursor))
      continue
    dates.add(cursor)
    taken++
  }

  cursor = anchor
  taken = 0
  for (let guard = 0; taken < offset && guard < 60; guard++) {
    cursor = shiftDate(cursor, 1)
    if (!inBounds(cursor))
      break
    if (!isWorkday(cursor))
      continue
    dates.add(cursor)
    taken++
  }

  const sorted = [...dates].sort()
  return {
    anchor,
    from: sorted[0],
    to: sorted[sorted.length - 1],
    dates: sorted,
  }
}

/** 某个日期所在自然月的首尾；日报窗口不跨月 */
export function monthBounds(date: string) {
  const [year, month] = date.split('-').map(Number)
  const first = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    from: first,
    to: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  }
}

/** 为了拿到分析范围外、但属于同一自然月窗口的提交，扫描区间向外多取几天 */
export function expandRangeForWindow(from: string, to: string, offsetWorkdays: number) {
  const raw = Number(offsetWorkdays)
  const offset = Number.isFinite(raw) ? Math.max(0, Math.min(14, Math.round(raw))) : 0
  const pad = offset * 3 + 7
  return {
    from: shiftDate(from, -pad),
    to: shiftDate(to, pad),
  }
}
