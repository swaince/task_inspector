import type { EntryInspection, VerdictLevel } from './types'

/**
 * 判定档位的展示元数据。
 *
 * 集中在一处，避免徽标、图表、图例各写一套颜色和文案对不上。
 * color 对应 src/styles/theme.css 里的 --verdict-* 变量。
 */
export interface VerdictMeta {
  label: string
  /** 一句话解释这个档位意味着什么 */
  description: string
  color: string
  /** 是否属于需要关注的异常 */
  needsAttention: boolean
}

export const VERDICT_META: Record<VerdictLevel, VerdictMeta> = {
  matched: {
    label: '一致',
    description: '提交内容明确支撑日报描述',
    color: 'var(--verdict-matched)',
    needsAttention: false,
  },
  partial: {
    label: '部分一致',
    description: '方向一致但范围或深度不足，日报描述比实际改动多',
    color: 'var(--verdict-partial)',
    needsAttention: true,
  },
  mismatched: {
    label: '不一致',
    description: '有该项目的提交，但改动内容与描述对不上',
    color: 'var(--verdict-mismatched)',
    needsAttention: true,
  },
  'no-commit': {
    label: '无提交',
    description: '该项目当天没有提交。可能是会议/评审类工作，也可能确实没有产出',
    color: 'var(--verdict-nocommit)',
    needsAttention: true,
  },
  unverified: {
    label: '无法核对',
    description: '项目未映射到仓库或材料不足，结论不可靠',
    color: 'var(--verdict-unverified)',
    needsAttention: false,
  },
}

export const VERDICT_ORDER: VerdictLevel[] = [
  'matched',
  'partial',
  'mismatched',
  'no-commit',
  'unverified',
]

export function verdictMeta(verdict: VerdictLevel): VerdictMeta {
  return VERDICT_META[verdict] ?? VERDICT_META.unverified
}

/**
 * 该条目是否需要跟进。
 *
 * 三个地方（检查结果页、执行页的结果列表、概览页的待关注列表）都要判断这件事，
 * 抽出来避免各写一份后慢慢跑偏。两条排除是刻意的：
 * - 非编码工作（会议/评审/文档）本就不产生提交，不是问题
 * - 项目未映射是配置问题，属于「先修映射」而不是「找员工核对」
 */
export function needsFollowUp(entry: Pick<EntryInspection, 'verdict' | 'nonCodingWork' | 'projectUnresolved'>): boolean {
  if (entry.nonCodingWork || entry.projectUnresolved)
    return false
  return entry.verdict === 'mismatched' || entry.verdict === 'partial' || entry.verdict === 'no-commit'
}

/** 需要跟进的条目，保持原有顺序。 */
export function followUpEntries<T extends EntryInspection>(entries: T[]): T[] {
  return entries.filter(needsFollowUp)
}

/** 按严重程度列出这组条目里需要跟进的档位，供列表里的徽标使用。 */
export function followUpVerdicts(entries: EntryInspection[]): VerdictLevel[] {
  const present = new Set(followUpEntries(entries).map(e => e.verdict))
  return (['mismatched', 'partial', 'no-commit'] as const).filter(v => present.has(v))
}

/**
 * 排序权重：越大越需要优先看。
 *
 * 分数只在「有可核对内容」时才参与——否则全员项目未映射会把每个人推到榜首，
 * 「需要关注」列表就退化成「当天检查过的所有人」，失去筛选意义。
 */
export function attentionWeight(result: {
  summary: { score: number, checkedHours: number }
  entries: EntryInspection[]
  orphanCommits: unknown[]
}): number {
  const scorePart = result.summary.checkedHours > 0 ? (100 - result.summary.score) / 100 : 0
  const followUpPart = result.entries.filter(needsFollowUp).length * 0.5
  const orphanPart = result.orphanCommits.length * 0.15
  return scorePart + followUpPart + orphanPart
}

/** 分数对应的关注级别，用于概览页的配色。 */
export function scoreTone(score: number): 'good' | 'warn' | 'bad' {
  if (score >= 85)
    return 'good'
  if (score >= 60)
    return 'warn'
  return 'bad'
}
