import type { GitCommit, GitLabProjectRef, MemberProfile, WorkSignal } from '../domain/types'
import type { RuleSettings } from '../config/settings'
import type { GitLabClient } from '../adapters/gitlab'
import type { MemberIdentity } from './matching'
import type { BranchActivity } from './branchCommits'
import { commitBelongsTo, resolveMemberIdentity, signalBelongsTo } from './matching'
import { commitWindow } from './window'
import { collectBranchCommits } from './branchCommits'
import { collectWorkSignals } from './workSignals'

/**
 * 事实层：某段时间里，各个仓库实际发生了哪些提交。
 *
 * 和检查引擎是两回事——检查是「拿日报去证代码」，这一层是「先看代码」。
 * 「项目 × 时间段」和「人员 × 日 × 项目」两个视图都建在它上面，
 * 单独成层是为了让同一个数字只有一种算法：两处各写一套，早晚会算出不同的结果，
 * 而那时候用户不知道该信哪个。
 */

export interface ProjectBranchActivity extends BranchActivity {
  repoPath: string
}

export interface ProjectCommits {
  projectId: number
  projectPath: string
  projectName: string
  commits: GitCommit[]
  /** 区间内有提交的分支，供统计和报告注明分支工作 */
  branches?: ProjectBranchActivity[]
  /** 同一区间的 MR / 评审 / Issue 活动，补足没有提交的工作时段 */
  signals?: WorkSignal[]
}

export interface ActivityFailure {
  projectPath: string
  message: string
}

export interface ActivityProgress {
  done: number
  total: number
  message: string
}

/**
 * 区间对应的时间窗。
 *
 * 复用逐日检查那套窗口规则（含前后各几小时的偏移），
 * 否则同一个提交在「检查结果」里算 15 号、在这个视图里算 16 号，
 * 两个页面各说各话，没人能拿它做依据。
 */
export function rangeWindow(from: string, to: string, rules: RuleSettings) {
  return {
    since: commitWindow(from, rules).since,
    until: commitWindow(to, rules).until,
  }
}

export interface CollectOptions {
  gitlab: GitLabClient
  rules: RuleSettings
  perPage: number
  maxCommitsPerProject: number
  /** 同时读取 MR / 评审 / Issue 事件，默认关闭 */
  fetchSignals?: boolean
  maxSignalsPerProject?: number
  signal?: AbortSignal
  onProgress?: (progress: ActivityProgress) => void
}

/**
 * 逐个项目拉取区间内的提交。
 *
 * 串行而不是并发：GitLab 实例的承载能力未知，而这是用户主动触发的一次重操作，
 * 慢一点换稳定。单个仓库失败不中断整体——权限不足、仓库归档都会失败，
 * 但其余仓库的数据照样有价值；失败原因交给调用方展示，不能悄悄吞掉，
 * 否则用户会把「没扫到」误读成「没有提交」。
 *
 * `fetchFileChanges` 固定为 false：这一层只做统计，逐条拉 diff 会让请求数翻好几倍，
 * 而视图要的是「谁在哪个项目上提交了多少」，用不到文件明细。
 */
export async function collectProjectCommits(
  projects: GitLabProjectRef[],
  from: string,
  to: string,
  opts: CollectOptions,
): Promise<{ batches: ProjectCommits[], failures: ActivityFailure[] }> {
  const { since, until } = rangeWindow(from, to, opts.rules)
  const batches: ProjectCommits[] = []
  const failures: ActivityFailure[] = []

  let done = 0
  for (const project of projects) {
    if (opts.signal?.aborted)
      break

    let commits: GitCommit[] = []
    let branches: ProjectBranchActivity[] = []
    let signals: WorkSignal[] = []

    try {
      // 不只默认分支：区间内有提交的功能分支同样参与统计
      const result = await collectBranchCommits(
        opts.gitlab,
        project,
        {
          since,
          until,
          perPage: opts.perPage,
          maxCommits: opts.maxCommitsPerProject,
          fetchFileChanges: false,
          signal: opts.signal,
        },
        { maxBranches: 24 },
      )
      commits = result.commits
      branches = result.branches.map(branch => ({
        ...branch,
        repoPath: project.pathWithNamespace,
      }))
      for (const failure of result.failures)
        failures.push({ projectPath: project.pathWithNamespace, message: failure })
    }
    catch (err) {
      failures.push({
        projectPath: project.pathWithNamespace,
        message: err instanceof Error ? err.message : String(err),
      })
    }

    if (opts.fetchSignals) {
      const collected = await collectWorkSignals(opts.gitlab, [project], from, to, {
        perPage: 100,
        maxEventsPerProject: opts.maxSignalsPerProject ?? 800,
        signal: opts.signal,
      })
      signals = collected.signals
      for (const failure of collected.failures)
        failures.push({ projectPath: project.pathWithNamespace, message: `活动事件读取失败：${failure}` })
    }

    if (commits.length || signals.length) {
      batches.push({
        projectId: project.id,
        projectPath: project.pathWithNamespace,
        projectName: project.name,
        commits,
        branches,
        signals,
      })
    }

    done++
    opts.onProgress?.({ done, total: projects.length, message: `已扫描 ${done}/${projects.length} 个仓库` })
  }

  return { batches, failures }
}

/* ------------------------------------------------------------------ *
 * 提交 → 人员
 * ------------------------------------------------------------------ */

/**
 * 把每个人员实体转成匹配身份。
 *
 * 复用检查引擎的 `resolveMemberIdentity` + `commitBelongsTo`，不另写一套
 * 「邮箱/用户名怎么算匹配」的规则——那套规则已经在真机上被调过很多次了，
 * 这里再抄一份必然会分叉。
 */
export function buildIdentities(members: MemberProfile[]): Array<{ member: MemberProfile, identity: MemberIdentity }> {
  return members
    .filter(m => m.enabled)
    .map(member => ({
      member,
      identity: resolveMemberIdentity(
        {
          id: member.reportMemberId || member.id,
          name: member.name,
          gitlabUsernames: member.gitlabUsernames,
          emails: member.emails,
        },
        [],
      ),
    }))
}

/** 找一个提交的归属人；匹配不上返回 null（可能是外包、机器人、或还没建人员实体） */
export function commitOwner(
  commit: GitCommit,
  identities: Array<{ member: MemberProfile, identity: MemberIdentity }>,
): MemberProfile | null {
  const hit = identities.find(i => commitBelongsTo(commit, i.identity))
  return hit?.member ?? null
}

/** 找一条活动事件的归属人；规则同提交，但事件只有 GitLab 用户名 */
export function signalOwner(
  signal: WorkSignal,
  identities: Array<{ member: MemberProfile, identity: MemberIdentity }>,
): MemberProfile | null {
  const hit = identities.find(i => signalBelongsTo(signal, i.identity))
  return hit?.member ?? null
}

/**
 * 扫描范围的上限提示。
 *
 * 这个视图按仓库逐个扫，仓库数是用户自己的「关注」范围决定的。
 * 数量大到明显不现实时（比如没关注任何人、关注范围等于全量），
 * 与其让他等到超时，不如先说清楚再让他决定。
 */
export const SCAN_WARN_THRESHOLD = 60
