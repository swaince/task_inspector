import type { CommitQuery, GitLabBranchRef, GitLabClient } from '../adapters/gitlab'
import type { GitCommit, GitLabProjectRef } from '../domain/types'

/**
 * 多分支提交收集。
 *
 * 只看默认分支会漏掉功能分支上的真实工作，也会让「这个人当天有没有提交」
 * 变成片面结论。这里先列出分支，再只拉**时间范围内仍有提交**的分支
 * （默认分支始终保留），按提交 id 去重，同时记录每条提交出现在哪些分支。
 *
 * 不传 `all=true`：GitLab 的 all=true 会混入没有明确分支归属的合并提交；
 * 逐分支拉取虽然请求更多，但每条提交的来源分支是确定的。
 */

export interface BranchActivity {
  name: string
  default: boolean
  merged: boolean
  commits: number
  latestCommitAt?: string
  /** 最近几条提交标题，供报告注明这个分支在做什么 */
  titles: string[]
}

export interface BranchCommitResult {
  commits: GitCommit[]
  /** 有提交的分支活动；按提交数倒序 */
  branches: BranchActivity[]
  failures: string[]
  /** 因分支数量上限没有扫描的分支数 */
  skippedBranches: number
}

export interface BranchCommitOptions {
  /** 最多扫描多少个有提交的分支；默认 30 */
  maxBranches?: number
}

const DEFAULT_MAX_BRANCHES = 30
const MAX_COMMITS_PER_BRANCH = 200
const MAX_TITLES = 6

export async function collectBranchCommits(
  gitlab: GitLabClient,
  project: GitLabProjectRef,
  query: CommitQuery,
  opts: BranchCommitOptions = {},
): Promise<BranchCommitResult> {
  const maxBranches = opts.maxBranches ?? DEFAULT_MAX_BRANCHES
  const failures: string[] = []

  let refs: GitLabBranchRef[] = []
  try {
    refs = await gitlab.listBranches(project, { maxBranches: maxBranches * 4, signal: query.signal })
  }
  catch (err) {
    failures.push(`读取分支列表失败，回退到默认分支：${err instanceof Error ? err.message : String(err)}`)
  }

  if (!refs.length) {
    const fallback = project.defaultBranch
    if (fallback)
      refs = [{ name: fallback, default: true, merged: false, protected: false }]
  }

  const sinceMs = Date.parse(query.since)
  const candidates = refs
    .filter(ref => ref.default || !ref.committedDate || Date.parse(ref.committedDate) >= sinceMs)
    .sort((a, b) => {
      if (a.default !== b.default)
        return a.default ? -1 : 1
      return (b.committedDate ?? '').localeCompare(a.committedDate ?? '')
    })

  const active = candidates.slice(0, maxBranches)
  const skippedBranches = Math.max(0, candidates.length - active.length)

  const byId = new Map<string, GitCommit>()
  const activity = new Map<string, BranchActivity>()

  for (const branch of active) {
    if (query.signal?.aborted)
      break
    try {
      const commits = await gitlab.listCommits(project, {
        ...query,
        refName: branch.name,
        maxCommits: Math.min(query.maxCommits, MAX_COMMITS_PER_BRANCH),
      })
      let branchCommits = 0
      for (const commit of commits) {
        const existing = byId.get(commit.id)
        if (existing) {
          existing.branches = [...new Set([...(existing.branches ?? []), branch.name])]
        }
        else {
          const next: GitCommit = {
            ...commit,
            refName: branch.name,
            branches: [branch.name],
          }
          byId.set(commit.id, next)
        }
        branchCommits++
      }

      if (branchCommits) {
        activity.set(branch.name, {
          name: branch.name,
          default: branch.default,
          merged: branch.merged,
          commits: branchCommits,
          latestCommitAt: branch.committedDate,
          titles: commits.slice(0, MAX_TITLES).map(commit => commit.title),
        })
      }
    }
    catch (err) {
      failures.push(`${branch.name}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const commits = [...byId.values()]
    .sort((a, b) => b.committedDate.localeCompare(a.committedDate))
    .slice(0, query.maxCommits)

  return {
    commits,
    branches: [...activity.values()].sort((a, b) => b.commits - a.commits),
    failures,
    skippedBranches,
  }
}
