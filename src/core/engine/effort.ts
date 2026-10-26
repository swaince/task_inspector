import type { WorkloadSettings } from '../config/settings'
import type { GitCommit, WorkSignal } from '../domain/types'
import type { LlmClient } from '../llm/client'
import { formatDateCN } from '@/lib/format'

/**
 * 模型按任务估算工作量。
 *
 * 确定性的「提交会话 + 活动事件」只能看到有痕迹的工作；写方案、查资料、开会讨论
 * 这些不产生提交，也不一定有 MR。日报正文是唯一能说明这些工作的材料，但它同时是
 * 被核对的对象——直接拿它当输入，估出来的数字只会复述申报。
 *
 * 所以这里把日报正文当作**待核实的声明**：可以用它识别工作类型，但不允许直接把
 * 申报小时数抄成估算结果。输出是每天一个区间，作为确定性证据的上限参考。
 */

export interface EffortDayInput {
  date: string
  commits: GitCommit[]
  signals: WorkSignal[]
  reportedHours?: number
  reportText?: string
}

export interface EffortDayEstimate {
  date: string
  low: number
  high: number
  reason: string
}

export interface EffortBatchResult {
  days: Map<string, EffortDayEstimate>
  confidence: number
  note: string
}

const MAX_DAYS = 31
const MAX_COMMITS_PER_DAY = 10
const MAX_COMMIT_CHARS = 160
const MAX_REPORT_CHARS = 300
const MAX_DAYS_TEXT = 31

const cache = new Map<string, { at: number, result: EffortBatchResult }>()
const CACHE_LIMIT = 60

export const EFFORT_SYSTEM = `你是研发工作量评估助手。根据一个人每天的代码提交、GitLab 活动（MR / 评审 / Issue）和日报申报，估算这一天**实际投入的工作时间**区间（单位：小时）。

判断纪律：
1. 代码提交和 GitLab 活动是事实；日报是申报，不是事实。
2. 日报可以用来识别没有代码痕迹的工作（会议、评审、调研、答疑、线上排查），但不能把申报的小时数直接抄成结果。
3. 以「可观测证据 + 合理的工作类型推断」给出区间：下限只算有证据支撑的部分，上限允许包含申报里能解释但无法核实的部分。
4. 工作量锚点：改配置/小修补 0.5–1.5h；小功能/小 bug 2–4h；中等功能/复杂排查 4–6h；大功能/疑难问题 6–8h。一天上限 10h。
5. 改动行数不等于投入：生成代码、批量改名、格式化、依赖升级的行数要降权；排查一行配置可能花几小时。
6. 如果申报的小时数明显高于证据能解释的上限，不要抬到申报值，在 reason 里写清楚差距。
7. 只有代码提交但没有任何其他活动时，也不要机械地按提交时刻算几十分钟；开发者可能在提交前已经工作了一段时间，给一个保守但合理的下限。
8. 没有提交也没有活动、但有日报时，区间上限参考日报，但 confidence 要低，并在 reason 说明「无系统证据」。
9. 输出必须覆盖输入的每一天，日期原样照抄。

只输出一个 JSON 对象，不要解释文字或 markdown 围栏：
{
  "days": [
    {"date": "2026-10-21", "low": 2, "high": 5, "reason": "一句话说明依据，包括申报与证据的差距"}
  ],
  "confidence": 0.0 到 1.0,
  "note": "一句话说明整体局限"
}`

function compactCommit(commit: GitCommit): string {
  const stat = commit.stats ? ` +${commit.stats.additions}/-${commit.stats.deletions}` : ''
  const body = commit.message.split('\n').slice(1).join(' ').trim()
  const detail = body ? ` ｜ ${body.slice(0, 100)}` : ''
  return `- ${commit.title}${stat}${detail}`.slice(0, MAX_COMMIT_CHARS)
}

function compactSignal(signal: WorkSignal): string {
  return `- ${signal.kind}：${signal.title}`.slice(0, MAX_COMMIT_CHARS)
}

export function buildEffortPrompt(memberName: string, days: EffortDayInput[]): string {
  const lines = [`员工：${memberName}`, `共 ${days.length} 天。`, '']
  for (const day of days.slice(0, MAX_DAYS_TEXT)) {
    lines.push(`日期：${day.date}（${formatDateCN(day.date)}）`)
    if (day.reportedHours)
      lines.push(`日报申报：${day.reportedHours}h${day.reportText ? ` — ${day.reportText.slice(0, MAX_REPORT_CHARS)}` : '（未填写内容）'}`)
    else
      lines.push('日报申报：无')
    if (day.commits.length) {
      lines.push(`提交 ${day.commits.length} 条：`)
      for (const commit of day.commits.slice(0, MAX_COMMITS_PER_DAY))
        lines.push(compactCommit(commit))
      if (day.commits.length > MAX_COMMITS_PER_DAY)
        lines.push(`…另 ${day.commits.length - MAX_COMMITS_PER_DAY} 条`)
    }
    else {
      lines.push('提交：无')
    }
    if (day.signals.length) {
      lines.push(`活动 ${day.signals.length} 条：`)
      for (const signal of day.signals.slice(0, 10))
        lines.push(compactSignal(signal))
    }
    lines.push('')
  }
  lines.push('请按要求输出 JSON，必须覆盖上面每一天。')
  return lines.join('\n')
}

function extractJson(raw: string): any | null {
  const candidates = [raw.trim()]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1])
    candidates.push(fenced[1].trim())
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first)
    candidates.push(raw.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    }
    catch {
      continue
    }
  }
  return null
}

/** 模型偶尔把日期写成中文；统一成 YYYY-MM-DD 再和输入对齐 */
function normalizeDate(raw: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw))
    return raw
  const match = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/)
  if (!match)
    return raw
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
}

export function parseEffort(
  raw: string,
  days: EffortDayInput[],
  workload: WorkloadSettings,
): EffortBatchResult | null {
  const obj = extractJson(raw)
  if (!obj || !Array.isArray(obj.days))
    return null

  const wanted = new Set(days.map(d => d.date))
  const result = new Map<string, EffortDayEstimate>()
  for (const item of obj.days) {
    const date = typeof item?.date === 'string' ? normalizeDate(item.date) : ''
    if (!wanted.has(date))
      continue
    const low = Number.parseFloat(String(item.low))
    const high = Number.parseFloat(String(item.high))
    if (!Number.isFinite(low) || !Number.isFinite(high))
      continue
    const lo = Math.min(workload.maxHours, Math.max(0, Math.round(low * 10) / 10))
    const hi = Math.min(workload.maxHours, Math.max(lo, Math.round(high * 10) / 10))
    result.set(date, {
      date,
      low: lo,
      high: hi,
      reason: typeof item.reason === 'string' ? item.reason : '',
    })
  }

  if (!result.size)
    return null

  return {
    days: result,
    confidence: Math.min(1, Math.max(0, Number(obj.confidence) || 0.5)),
    note: typeof obj.note === 'string' ? obj.note : '',
  }
}

function cacheKey(memberName: string, days: EffortDayInput[]) {
  return [
    memberName,
    ...days.map(day => [
      day.date,
      day.reportedHours ?? 0,
      (day.reportText ?? '').slice(0, 80),
      day.commits.map(c => c.id).sort().join(','),
      day.signals.map(s => s.id).sort().join(','),
    ].join(':')),
  ].join('|')
}

/**
 * 一次为一个人估算整段区间。
 *
 * 逐天调用会把模型费用乘上几十倍，而区间内的任务上下文本来就有连续性；
 * 一次调用还能让模型看到「前一天做到哪」，避免每天从零开始估。
 */
export async function estimateEffortBatch(
  memberName: string,
  days: EffortDayInput[],
  llm: LlmClient,
  workload: WorkloadSettings,
  signal?: AbortSignal,
): Promise<EffortBatchResult | null> {
  const usable = days.filter(day => day.commits.length || day.signals.length || day.reportedHours)
  if (!usable.length || !llm.configured)
    return null

  const capped = usable.slice(0, MAX_DAYS)
  const truncated = usable.length > capped.length
  const key = cacheKey(memberName, capped)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 30 * 60_000)
    return hit.result

  try {
    const completion = await llm.complete(
      [
        { role: 'system', content: EFFORT_SYSTEM },
        { role: 'user', content: buildEffortPrompt(memberName, capped) },
      ],
      { signal },
    )
    const parsed = parseEffort(completion.text, capped, workload)
    if (!parsed)
      return null

    if (truncated) {
      parsed.note = `只估算了前 ${capped.length} 天；${parsed.note}`.trim()
    }
    if (cache.size >= CACHE_LIMIT) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest)
        cache.delete(oldest[0])
    }
    cache.set(key, { at: Date.now(), result: parsed })
    return parsed
  }
  catch {
    // 模型估算失败不影响确定性证据；调用方继续用原区间
    return null
  }
}
