import type { GitLabClient, GitLabEventRef } from '../adapters/gitlab'
import type { GitLabProjectRef, WorkSignal, WorkSignalKind } from '../domain/types'
import { shiftDate } from './window'

/**
 * 代码之外的工作证据。
 *
 * 只看提交会把「评审了一整天 MR」「排查线上问题、只改了一行配置」算成 1 小时以内。
 * GitLab 的项目事件流里有 MR 开启/合并、Issue 流转、评论等时间点，和提交一起
 * 拼成当天的工作片段，能把这些没有提交的工作补回来。
 *
 * 事件只是佐证，不做逐条判定：一条评论不能证明「写了一小时」，
 * 但能把「完全空白的一天」变成「有活动的一天」，这是当前模型最缺的信号。
 */

const DEFAULT_MAX_EVENTS = 800

export interface CollectSignalsOptions {
  perPage?: number
  maxEventsPerProject?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export interface CollectSignalsResult {
  signals: WorkSignal[]
  failures: string[]
  /** 达到事件上限、结果可能不完整的仓库 */
  truncated: string[]
}

function kindOf(event: GitLabEventRef): WorkSignalKind | null {
  // 评论事件优先看被评论对象的类型：评论一次 MR 就是评审活动
  if (event.noteType === 'MergeRequest')
    return 'review'
  if (event.noteType === 'Issue')
    return 'issue'
  if (event.noteType === 'Commit')
    return 'review'

  switch (event.targetType) {
    case 'MergeRequest':
      return event.action.includes('comment') ? 'review' : 'merge_request'
    case 'Issue':
      return 'issue'
    case 'Pipeline':
      return 'pipeline'
    default:
      // push 事件由提交接口覆盖，重复计入只会把同一段时间算两遍
      return null
  }
}

function titleOf(event: GitLabEventRef, kind: WorkSignalKind) {
  if (event.noteBody?.trim())
    return event.noteBody.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (event.targetTitle?.trim())
    return event.targetTitle.trim()
  return {
    merge_request: '合并请求活动',
    review: '代码评审',
    issue: 'Issue 活动',
    pipeline: '流水线活动',
  }[kind]
}

function toSignal(
  project: GitLabProjectRef,
  event: GitLabEventRef,
): WorkSignal | null {
  const kind = kindOf(event)
  if (!kind)
    return null
  // 系统评论（「added 1 commit」「changed milestone」之类）是自动生成的，不代表人工活动
  if (event.isSystemNote)
    return null

  return {
    id: `${project.id}:${event.id}`,
    kind,
    at: event.createdAt,
    title: titleOf(event, kind),
    projectId: project.id,
    projectPath: project.pathWithNamespace,
    username: event.authorUsername,
    authorName: event.authorName,
  }
}

/**
 * 逐个项目拉事件。串行是刻意的：GitLab 实例的承载能力未知，
 * 而这是一次用户主动触发、可以等一会儿的操作。
 */
export async function collectWorkSignals(
  gitlab: GitLabClient,
  projects: GitLabProjectRef[],
  from: string,
  to: string,
  opts: CollectSignalsOptions = {},
): Promise<CollectSignalsResult> {
  const signals: WorkSignal[] = []
  const failures: string[] = []
  const truncated: string[] = []
  const maxEvents = opts.maxEventsPerProject ?? DEFAULT_MAX_EVENTS
  const perPage = opts.perPage ?? 100
  /*
   * 事件接口的 after/before 只接受日期，边界是否包含当天并不明确。
   * 前后各放宽一天，多出来的事件由调用方按自己的时间窗丢弃，
   * 比漏掉首尾两天安全。
   */
  const after = shiftDate(from, -1)
  const before = shiftDate(to, 1)

  let done = 0
  for (const project of projects) {
    if (opts.signal?.aborted)
      break
    try {
      const events = await gitlab.listProjectEvents(project, {
        after,
        before,
        perPage,
        maxEvents,
        signal: opts.signal,
      })
      if (events.length >= maxEvents)
        truncated.push(project.pathWithNamespace)
      for (const event of events) {
        const signal = toSignal(project, event)
        if (signal)
          signals.push(signal)
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 事件接口在部分实例/权限下不可用，不能因此让整个活动分析失败
      failures.push(`${project.pathWithNamespace}：${message}`)
    }
    done++
    opts.onProgress?.(`已读取 ${done}/${projects.length} 个仓库的活动事件`)
  }

  // 同一条事件可能在多个分支/页面重复返回，按 id 去重
  const byId = new Map<string, WorkSignal>()
  for (const signal of signals)
    byId.set(signal.id, signal)

  return {
    signals: [...byId.values()].sort((a, b) => a.at.localeCompare(b.at)),
    failures,
    truncated,
  }
}
