import type { CalendarDay, WorkCalendarSettings } from '../config/settings'

/**
 * 工作日历。
 *
 * 两个来源叠加：
 * 1. ICS 导入的法定节假日与调休上班日；
 * 2. 手动覆盖（公司临时放假、临时上班），优先级最高。
 * 都没覆盖到的日期按自然周规则：周一到周五上班，周六周日休息。
 *
 * 「工作日」只用于解释节奏和计算缺报：节假日没有提交/日报是正常的，
 * 不该被算成漏报，也不该进分母。
 */

export type CalendarSource = 'manual' | 'ics' | 'weekday' | 'weekend'

export interface DayInfo {
  date: string
  workday: boolean
  source: CalendarSource
  name?: string
}

export interface ResolvedCalendar {
  dayInfo(date: string): DayInfo
  isWorkday(date: string): boolean
  workdaysInRange(from: string, to: string): string[]
  daysInRange(from: string, to: string): DayInfo[]
}

/* ------------------------------------------------------------------ *
 * 日期工具
 * ------------------------------------------------------------------ */

export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim())
  if (!m)
    return null
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDays(key: string, days: number): string | null {
  const date = parseDateKey(key)
  if (!date)
    return null
  date.setDate(date.getDate() + days)
  return formatDateKey(date)
}

/* ------------------------------------------------------------------ *
 * ICS 解析
 * ------------------------------------------------------------------ */

/**
 * 解析节假日 ICS。
 *
 * 这类日历通常只给「放假」区间，调休上班写在同一事件的 DESCRIPTION 里
 * （例如「……共 9 天，2月14日、2月28日上班」），所以两处都要读。
 * DTEND 是**排他**的（0101–0104 表示 1 月 1 日到 3 日）。
 */
export function parseHolidayIcs(text: string): CalendarDay[] {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
  const lines = unfolded.split('\n')

  const out = new Map<string, CalendarDay>()

  let inEvent = false
  let props: Record<string, string> = {}

  const flush = () => {
    const start = parseIcsDate(props.DTSTART ?? '')
    if (!start)
      return
    const end = parseIcsDate(props.DTEND ?? '') ?? addDays(start, 1)
    if (!end)
      return

    const summary = unescapeIcs(props.SUMMARY ?? '')
    const description = unescapeIcs(props.DESCRIPTION ?? '')
    const isWorkdayEvent = /^班|上班|调休上班/.test(summary.trim())

    if (isWorkdayEvent) {
      let cursor = start
      for (let guard = 0; cursor && cursor < end && guard < 90; guard++) {
        out.set(cursor, { date: cursor, type: 'workday', name: summary || '调休上班' })
        cursor = addDays(cursor, 1) ?? ''
      }
    }
    else {
      const name = summary.replace(/^休[｜|]\s*/, '').trim() || '节假日'
      let cursor = start
      for (let guard = 0; cursor && cursor < end && guard < 90; guard++) {
        out.set(cursor, { date: cursor, type: 'holiday', name })
        cursor = addDays(cursor, 1) ?? ''
      }
    }

    // 调休上班日：DESCRIPTION 里带「上班」的分句，日期都算工作日
    for (const day of workdaysFromDescription(description, start))
      out.set(day, { date: day, type: 'workday', name: '调休上班' })
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line === 'BEGIN:VEVENT') {
      inEvent = true
      props = {}
      continue
    }
    if (line === 'END:VEVENT') {
      if (inEvent)
        flush()
      inEvent = false
      continue
    }
    if (!inEvent || !line)
      continue

    const colon = line.indexOf(':')
    if (colon <= 0)
      continue
    const name = line.slice(0, colon).split(';')[0].toUpperCase()
    props[name] = line.slice(colon + 1)
  }

  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function parseIcsDate(value: string): string | null {
  const compact = /(\d{4})(\d{2})(\d{2})/.exec(value)
  if (compact)
    return `${compact[1]}-${compact[2]}-${compact[3]}`
  const dashed = /(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (dashed)
    return `${dashed[1]}-${dashed[2]}-${dashed[3]}`
  return null
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function workdaysFromDescription(description: string, eventStart: string): string[] {
  const start = parseDateKey(eventStart)
  if (!start)
    return []
  const startYear = start.getFullYear()
  const out = new Set<string>()

  for (const clause of description.split(/[，,。；;]/)) {
    if (!clause.includes('上班'))
      continue
    for (const match of clause.matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
      const month = Number(match[1])
      const day = Number(match[2])
      if (month < 1 || month > 12 || day < 1 || day > 31)
        continue
      let year = startYear
      const candidate = new Date(year, month - 1, day)
      // 跨年：元旦的「12月31日上班」属于上一年
      if (candidate.getTime() - start.getTime() > 180 * 86400_000)
        year -= 1
      else if (start.getTime() - candidate.getTime() > 180 * 86400_000)
        year += 1
      const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      out.add(key)
    }
  }

  return [...out]
}

/* ------------------------------------------------------------------ *
 * 生效日历
 * ------------------------------------------------------------------ */

export function createCalendar(settings?: WorkCalendarSettings): ResolvedCalendar {
  const manual = new Map<string, CalendarDay>()
  const icsWorkdays = new Map<string, CalendarDay>()
  const icsHolidays = new Map<string, CalendarDay>()

  for (const day of settings?.manual ?? [])
    manual.set(day.date, day)
  for (const day of settings?.imported ?? []) {
    if (day.type === 'workday')
      icsWorkdays.set(day.date, day)
    else
      icsHolidays.set(day.date, day)
  }

  function dayInfo(date: string): DayInfo {
    const manualDay = manual.get(date)
    if (manualDay)
      return { date, workday: manualDay.type === 'workday', source: 'manual', name: manualDay.name }

    const workday = icsWorkdays.get(date)
    if (workday)
      return { date, workday: true, source: 'ics', name: workday.name }

    const holiday = icsHolidays.get(date)
    if (holiday)
      return { date, workday: false, source: 'ics', name: holiday.name }

    const parsed = parseDateKey(date)
    if (!parsed)
      return { date, workday: false, source: 'weekend', name: '日期无效' }
    const weekday = parsed.getDay()
    const isWeekend = weekday === 0 || weekday === 6
    return {
      date,
      workday: !isWeekend,
      source: isWeekend ? 'weekend' : 'weekday',
      name: isWeekend ? '周末' : undefined,
    }
  }

  function isWorkday(date: string) {
    return dayInfo(date).workday
  }

  function daysInRange(from: string, to: string): DayInfo[] {
    const out: DayInfo[] = []
    let cursor = from
    for (let guard = 0; cursor && cursor <= to && guard < 800; guard++) {
      out.push(dayInfo(cursor))
      cursor = addDays(cursor, 1) ?? ''
    }
    return out
  }

  function workdaysInRange(from: string, to: string): string[] {
    return daysInRange(from, to).filter(d => d.workday).map(d => d.date)
  }

  return { dayInfo, isWorkday, daysInRange, workdaysInRange }
}
