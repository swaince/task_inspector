/**
 * 应用内的格式化与日期小工具。
 *
 * 单独放一个文件，不和 `lib/utils.ts` 混在一起：后者是 shadcn-vue CLI 管的，
 * 每次 `init` 或 `add -o` 都会被重写成 `export { cn } from "cn"`，
 * 放在那里写的工具函数会被静默删掉。
 */

/** 把 0.825 显示成 82.5% */
export function percent(value: number, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`
}

/** ISO 时间转成本地可读的 MM-DD HH:mm */
export function formatDateTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()))
    return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatDuration(ms: number) {
  if (ms < 1000)
    return `${ms}ms`
  if (ms < 60_000)
    return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/** 缓存占用这类「大概多大」的数字，用 1024 进制并保留一位小数 */
export function formatBytes(bytes: number) {
  if (!bytes)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * 相对今天的日期键（YYYY-MM-DD），`days` 为 -1 就是昨天。
 *
 * 日报一般是当天晚上才填的，白天去看「今天」永远是没有。
 * 所以凡是按天取数、又没有一个明确的用户选择的地方，默认值基本都该是昨天。
 */
export function dateKeyOffset(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function todayKey() {
  return dateKeyOffset(0)
}

/** 简易 UUID。桌面端与浏览器端都有 crypto.randomUUID，这里只做兜底。 */
export function uid() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    return crypto.randomUUID()
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
