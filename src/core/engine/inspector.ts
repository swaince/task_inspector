import type { AppSettings } from '../config/settings'
import type {
  DailyReport,
  DailyReportEntry,
  DevMode,
  EntryInspection,
  EvidenceStrength,
  GitCommit,
  GitLabProjectRef,
  InspectionProgress,
  InspectionResult,
  InspectionSummary,
  MemberIdentityInput,
  MemberProfile,
  Project,
  VerdictLevel,
} from '../domain/types'
import type { CommitQuery, GitLabClient } from '../adapters/gitlab'
import type { DailyReportSource } from '../adapters/dailyReport'
import type { LlmClient } from '../llm/client'
import { AdapterError } from '../adapters/gitlab'
import {
  commitBelongsTo,
  resolveMemberIdentity,
  resolveProject,
} from './matching'
import {
  buildJudgePrompt,
  buildSummaryPrompt,
  detectNonCoding,
  JUDGE_SYSTEM,
  parseJudgement,
  SUMMARY_SYSTEM,
  truncate,
} from './prompt'
import { commitWindow, isCoreWindow } from './window'
import type { DayMetrics } from './metrics'
import { dayMetrics, groupedDayMetrics, saturationOf } from './metrics'

/**
 * 检查引擎。
 *
 * 一次检查的流程：
 *   取日报 → 映射项目与人 → 拉提交 → 逐条判定 → 汇总
 * 每一步都通过 onProgress 上报，UI 上能看到卡在哪一环。
 *
 * 引擎本身不关心数据从哪来（HTTP / CSV / 演示数据）也不关心用哪个模型，
 * 这些都是注入进来的依赖，方便替换和测试。
 */

export interface InspectorDeps {
  settings: AppSettings
  gitlab: GitLabClient
  reportSource: DailyReportSource
  llm: LlmClient
  /** 已发现的 GitLab 项目全集，模糊匹配的候选来自这里 */
  knownProjects: GitLabProjectRef[]
  /** 项目实体，日报里的项目名/编码按它们的匹配键解析 */
  projects: Project[]
  /** 人员实体，用于把日报里的人对应到 GitLab 账号 */
  members: MemberProfile[]
  /**
   * 拉取提交列表的入口。
   *
   * 执行器会按「日期 + 仓库」缓存原始提交：同一天的多个成员共享一次列表请求，
   * 不再每个人各拉一遍；文件变更由下面按成员筛选后再补。
   */
  fetchCommits?: (project: GitLabProjectRef, query: CommitQuery) => Promise<GitCommit[]>
  onProgress?: (progress: InspectionProgress) => void
  /** LLM 判定的增量输出，用于界面上的实时推理展示 */
  onThinking?: (delta: string, entryId: string) => void
  /**
   * 抓到提交后的回调，用于写入本地库。
   * 记的是**过滤后实际参与判定**的那批提交：过滤掉的合并/格式化提交不该进检索语料，
   * 否则搜出来的都是噪音。
   */
  onCommitsFetched?: (commits: GitCommit[]) => void | Promise<void>
  signal?: AbortSignal
}

export interface RunInspectionInput {
  date: string
  member: MemberIdentityInput
  /** 已取到的日报，跳过重复拉取 */
  report?: DailyReport
}

/* ------------------------------------------------------------------ *
 * 忽略规则
 * ------------------------------------------------------------------ */

function buildMatchers(rules: AppSettings['rules']) {
  const messageRes: RegExp[] = []
  for (const pattern of rules.ignoreCommitMessagePatterns) {
    try {
      messageRes.push(new RegExp(pattern, 'i'))
    }
    catch {
      // 用户写错的正则不应该让检查失败，跳过并继续
    }
  }

  const pathRes: RegExp[] = rules.ignorePaths.map(globToRegExp)

  return {
    shouldIgnoreCommit(commit: GitCommit): boolean {
      if (rules.ignoreMergeCommits && commit.message.startsWith('Merge '))
        return true
      return messageRes.some(re => re.test(commit.title) || re.test(commit.message))
    },
    shouldIgnoreFiles(commit: GitCommit): boolean {
      if (!commit.fileChanges?.length || !pathRes.length)
        return false
      // 只有全部变更文件都命中忽略规则时，才认为这个提交不构成实质工作
      return commit.fileChanges.every(f => pathRes.some(re => re.test(f.path)))
    },
  }
}

/** 把 ** / * 通配的 glob 转成正则，够用即可，不引入依赖。 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 结果里不保留 diff 正文，只留路径和行数统计 */
function leanCommit(commit: GitCommit): GitCommit {
  if (!commit.fileChanges?.length)
    return commit
  return {
    ...commit,
    fileChanges: commit.fileChanges.map(({ patch: _patch, ...rest }) => rest),
  }
}

export async function runInspection(
  input: RunInspectionInput,
  deps: InspectorDeps,
): Promise<InspectionResult> {
  const { settings, signal } = deps
  const startedAt = performance.now()
  const report = deps.onProgress ?? (() => {})

  const identity = resolveMemberIdentity(
    {
      id: input.member.id,
      name: input.member.name,
      gitlabUsernames: input.member.gitlabUsernames,
      emails: input.member.emails,
    },
    deps.members,
  )

  /* --- 1. 取日报 --- */
  report({ stage: 'collecting-report', message: '正在获取日报…', percent: 5 })
  let dailyReport = input.report
  if (!dailyReport) {
    const all = await deps.reportSource.fetchByDate(input.date)
    dailyReport = all.find(r => r.memberId === input.member.id)
      ?? all.find(r => r.memberName === input.member.name)
  }

  const entries = dailyReport?.entries ?? []

  /* --- 2. 项目匹配 --- */
  report({ stage: 'matching', message: '正在匹配日报项目与代码仓库…', percent: 15 })
  const resolutions = entries.map(entry => resolveProject(
    { projectName: entry.projectName, projectCode: entry.projectCode },
    deps.projects,
    deps.knownProjects,
  ))

  /*
   * 要拉提交的仓库，直接用解析出来的引用本身，而不是回到仓库目录里筛。
   *
   * 一个业务项目可能关联多个仓库/组；而这些仓库不一定都在「仓库发现范围」里
   * （目录可能被 group 收窄过）。回到目录里筛会把它们丢掉，
   * 表现出来就是「这个人当天没提交」——一个完全不指向真实原因的假象。
   */
  const targetMap = new Map<number, GitLabProjectRef>()
  for (const resolution of resolutions) {
    for (const ref of resolution.projects)
      targetMap.set(ref.id, ref)
  }
  const targets = [...targetMap.values()]

  /* --- 3. 拉取提交 --- */
  const window = commitWindow(input.date, settings.rules)
  const matchers = buildMatchers(settings.rules)
  let commits: GitCommit[] = []

  if (targets.length) {
    report({
      stage: 'collecting-commits',
      message: `正在拉取 ${targets.length} 个仓库在 ${window.label} 的提交…`,
      percent: 30,
    })

    let done = 0
    for (const project of targets) {
      if (signal?.aborted)
        break
      try {
        const query: CommitQuery = {
          since: window.since,
          until: window.until,
          // 只看仓库的默认分支，避免把未合入的分支提交算成当天的工作
          refName: project.defaultBranch,
          /*
           * 不传 `author` 过滤。
           *
           * 一个人可能有多个 Git 身份（换过账号、用中文名提交、用私人邮箱），
           * 而 author 参数只接受一个值——传了就会漏掉其它身份提交的代码，
           * 而漏提交会被判成「日报写了但代码没有」，方向正好反了。
           * 这里拉回整个时间窗的提交，再用 commitBelongsTo 在客户端筛。
           *
           * 代价是单仓库的提交量上限（maxCommitsPerProject）现在约束的是
           * 所有人的提交而不是某个人的；这个值在判定规则里可调。
           */
          perPage: settings.gitlab.perPage,
          maxCommits: settings.rules.maxCommitsPerProject,
          fetchFileChanges: false,
          signal,
        }

        // 列表按日期 + 仓库缓存；同一仓库同一天被多个成员检查时只请求一次。
        const raw = deps.fetchCommits
          ? await deps.fetchCommits(project, query)
          : await deps.gitlab.listCommits(project, query)

        /*
         * 先筛出本人的提交，再只给这些提交补 diff。
         *
         * 之前是 listCommits 直接把项目当天所有人的 diff 都拉回来，
         * 2 人 × 12 天 × 4 个项目会变成近万次 diff 请求；真正参与判定的
         * 往往只有其中一小部分。克隆一份再挂 fileChanges，避免同一个缓存对象
         * 被两个成员互相改写。
         */
        const mine = raw
          .filter(c => commitBelongsTo(c, identity))
          .map(c => ({ ...c, fileChanges: undefined }))
        if (settings.rules.fetchFileChanges && mine.length)
          await deps.gitlab.attachFileChanges(project.id, mine, signal)

        commits.push(...mine)
      }
      catch (err) {
        // 单个仓库拉取失败（权限、项目被归档）不应该中断整次检查，
        // 但要让用户知道这次结果是残缺的。
        const reason = err instanceof AdapterError ? err.message : String(err)
        report({
          stage: 'collecting-commits',
          message: `仓库 ${project.pathWithNamespace} 拉取失败：${reason}`,
          percent: 30 + Math.round(((done + 1) / targets.length) * 20),
        })
      }
      done++
      report({
        stage: 'collecting-commits',
        message: `已拉取 ${done}/${targets.length} 个仓库，累计 ${commits.length} 条提交`,
        percent: 30 + Math.round((done / targets.length) * 20),
      })
    }
  }

  const usableCommits = commits.filter(c => !matchers.shouldIgnoreCommit(c) && !matchers.shouldIgnoreFiles(c))

  // 落库失败不应该让整次检查失败：检查结果本身是完整的，
  // 丢的只是检索语料，下次检查还会再写一遍
  if (usableCommits.length && deps.onCommitsFetched) {
    try {
      await deps.onCommitsFetched(usableCommits)
    }
    catch {
      // 静默忽略
    }
  }

  /* --- 4. 逐条判定 --- */
  const totalHours = entries.reduce((s, e) => s + e.hours, 0)
  const otherProjects = dedupe(entries.map(e => e.projectName))
  const entryInspections: EntryInspection[] = []
  const usedCommitIds = new Set<string>()

  const judgeOne = async (entry: DailyReportEntry, index: number): Promise<EntryInspection> => {
    const resolution = resolutions[index]
    const ratio = totalHours > 0 ? entry.hours / totalHours : 0
    const candidateCommits = resolution.projects.length
      ? usableCommits.filter(c => resolution.projects.some(p => p.id === c.projectId))
      : []

    const base: EntryInspection = {
      entryId: entry.id,
      projectName: entry.projectName,
      content: entry.content,
      hours: entry.hours,
      ratio,
      verdict: 'unverified',
      confidence: 0,
      evidenceStrength: 'none',
      reason: '',
      evidence: [],
      matchedCommitIds: [],
      nonCodingWork: false,
      projectUnresolved: resolution.projects.length === 0,
    }

    if (!resolution.projects.length) {
      // 解析器会给出具体原因（项目已删除 / 未关联仓库 / 没有对应项目记录），
      // 直接用它，不要在这里编一句笼统的话盖掉
      base.reason = resolution.note
        ?? `日报项目「${entry.projectName}」未能对应到 GitLab 仓库，无法核对。可到「项目」面板补充配置。`
      const fallback = detectNonCoding(entry.content)
      base.nonCodingWork = fallback.nonCoding
      return base
    }

    const hint = detectNonCoding(entry.content)

    // LLM 不可用时退化到规则判定，至少给出「有没有提交」这个事实
    if (!deps.llm.configured) {
      base.nonCodingWork = hint.nonCoding
      base.confidence = 0.3
      if (!candidateCommits.length) {
        base.verdict = 'no-commit'
        base.reason = hint.nonCoding
          ? `未配置 LLM，按规则判定：该项目当天没有提交。描述属于「${hint.label}」，无提交属正常。`
          : '未配置 LLM，按规则判定：该项目当天没有提交。'
      }
      else {
        base.verdict = 'matched'
        base.matchedCommitIds = candidateCommits.map(c => c.id)
        base.evidence = candidateCommits.slice(0, 5).map(c => toEvidence(c, entry, ''))
        base.reason = `未配置 LLM，仅按「该项目当天有 ${candidateCommits.length} 条提交」判定为符合，未核对内容是否一致。`
      }
      return base
    }

    const prompt = buildJudgePrompt(entry, {
      memberName: input.member.name,
      date: input.date,
      projectName: entry.projectName,
      gitlabProjects: resolution.projects.map(p => p.pathWithNamespace),
      commits: candidateCommits,
      rules: settings.rules,
      otherProjects: otherProjects.filter(p => p !== entry.projectName),
    })

    try {
      const completion = await deps.llm.complete(
        [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: prompt },
        ],
        {
          jsonMode: settings.llm.provider === 'openai-compatible',
          signal,
          onDelta: delta => deps.onThinking?.(delta, entry.id),
        },
      )

      const parsed = parseJudgement(completion.text)
      if (!parsed) {
        base.verdict = candidateCommits.length ? 'unverified' : 'no-commit'
        base.reason = `模型输出无法解析为结构化结果，原始输出片段：${truncate(completion.text, 200)}`
        return base
      }

      base.verdict = parsed.verdict
      base.confidence = parsed.confidence
      base.reason = parsed.reason || '模型未给出理由'
      base.nonCodingWork = parsed.nonCodingWork || (hint.nonCoding && parsed.verdict === 'no-commit')
      base.suggestions = parsed.suggestions

      const byId = new Map(candidateCommits.map(c => [c.id, c]))
      base.evidence = parsed.evidence
        .map(e => {
          // 模型可能返回短 SHA，做一次前缀匹配兜底
          const commit = byId.get(e.commitId)
            ?? candidateCommits.find(c => c.id.startsWith(e.commitId) || c.shortId === e.commitId)
          return commit ? toEvidence(commit, entry, e.relevance) : null
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)

      base.matchedCommitIds = base.evidence.map(e => e.commitId)

      /*
       * 模型判「一致」/「部分一致」但没给出可用的 evidence 时，无法逐条定位到提交。
       * 这时把该项目当天的候选提交整体视为已覆盖：
       * 漏报判定的可靠性依赖于「哪些提交已被日报覆盖」这个信息，
       * 一旦缺失就退化成「该项目所有提交都是漏报」，会让漏报列表变成噪音。
       * 宁可少报漏报，也不要制造一片误报。
       */
      if (!base.matchedCommitIds.length && (base.verdict === 'matched' || base.verdict === 'partial'))
        base.matchedCommitIds = candidateCommits.map(c => c.id)

      return base
    }
    catch (err) {
      if (signal?.aborted)
        throw err
      base.verdict = candidateCommits.length ? 'unverified' : 'no-commit'
      base.reason = `模型调用失败：${err instanceof Error ? err.message : String(err)}`
      return base
    }
  }

  /* --- 并发执行判定，受 rules.maxConcurrency 限制 --- */
  const concurrency = Math.max(1, Math.min(settings.llm.concurrency, entries.length || 1))
  let cursor = 0
  let finished = 0
  const worker = async () => {
    while (cursor < entries.length) {
      const index = cursor++
      const entry = entries[index]
      const result = await judgeOne(entry, index)
      for (const id of result.matchedCommitIds)
        usedCommitIds.add(id)
      entryInspections[index] = result
      finished++
      report({
        stage: 'judging',
        message: `已判定 ${finished}/${entries.length} 条日报内容`,
        percent: 55 + Math.round((finished / (entries.length || 1)) * 30),
      })
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  const orderedInspections = entryInspections.filter(Boolean)

  // 证据强度由代码统计和关键词命中得出，不依赖模型自评——自评高的未必真有证据
  const commitById = new Map(usableCommits.map(c => [c.id, c]))
  for (const entry of orderedInspections)
    entry.evidenceStrength = evidenceStrengthOf(entry, commitById)

  /* --- 5. 漏报提交 --- */
  /*
   * 结果里只需要文件路径和统计；diff 正文可能每个文件 20k，
   * 几条漏报就能让历史 JSON 和页面响应体膨胀到几十兆。
   * 判定阶段已经用过正文，这里剥掉再返回。
   */
  const orphanCommits = usableCommits
    .filter(c => !usedCommitIds.has(c.id))
    .map(leanCommit)

  /*
   * 仓库 → 日报项目名。一个业务项目可能关联多个仓库（或整个分组），
   * 未被条目引用的提交要能回到这个项目名下，而不是按仓库路径另起一个「项目」。
   */
  const repoProjectNames: Record<number, string> = {}
  for (const resolution of resolutions) {
    for (const ref of resolution.projects ?? [])
      repoProjectNames[ref.id] = resolution.reportProjectName
  }

  /* --- 6. 汇总 --- */
  // 不同项目可能标注了不同的开发模式，按项目分别估算再合并
  const modeByRepoId = new Map<number, DevMode>()
  for (const project of deps.projects) {
    const mode = project.devMode ?? 'manual'
    if (project.gitlabProjectId != null)
      modeByRepoId.set(project.gitlabProjectId, mode)
    for (const repo of project.repos ?? [])
      modeByRepoId.set(repo.id, mode)
  }
  const workload = groupedDayMetrics(usableCommits, c => modeByRepoId.get(c.projectId) ?? 'manual')

  const summary = buildSummary(orderedInspections, orphanCommits, totalHours, settings, workload)

  /* --- 7. 生成结论 --- */
  report({ stage: 'summarizing', message: '正在生成当日结论…', percent: 90 })
  let narrative = ''
  if (deps.llm.configured && orderedInspections.length) {
    try {
      const completion = await deps.llm.complete(
        [
          { role: 'system', content: SUMMARY_SYSTEM },
          {
            role: 'user',
            content: buildSummaryPrompt(
              input.member.name,
              input.date,
              orderedInspections.map(e => ({
                projectName: e.projectName,
                content: e.content,
                hours: e.hours,
                verdict: e.verdict,
                reason: e.reason,
              })),
              orphanCommits.map(c => ({
                projectPath: c.projectPath,
                title: c.title,
                authoredDate: c.authoredDate,
              })),
              {
                score: summary.score,
                totalHours,
                effectiveLow: summary.effectiveLow,
                effectiveHigh: summary.effectiveHigh,
                saturation: summary.saturation,
                batchSuspect: summary.batchSuspect,
              },
            ),
          },
        ],
        { signal, onDelta: delta => deps.onThinking?.(delta, '__summary__') },
      )
      narrative = completion.text.trim()
    }
    catch {
      narrative = fallbackNarrative(orderedInspections, orphanCommits, summary)
    }
  }
  else {
    narrative = fallbackNarrative(orderedInspections, orphanCommits, summary)
  }

  report({ stage: 'done', message: '检查完成', percent: 100 })

  return {
    id: `${input.member.id}@${input.date}`,
    date: input.date,
    memberId: input.member.id,
    memberName: input.member.name,
    entries: orderedInspections,
    orphanCommits,
    summary,
    narrative,
    meta: {
      model: deps.llm.configured ? deps.llm.label : '未启用（规则判定）',
      durationMs: Math.round(performance.now() - startedAt),
      scopedProjects: dedupe(usableCommits.map(c => c.projectPath)),
      repoProjectNames,
      createdAt: new Date().toISOString(),
    },
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

function toEvidence(commit: GitCommit, entry: DailyReportEntry, relevance: string) {
  return {
    commitId: commit.id,
    shortId: commit.shortId,
    projectPath: commit.projectPath,
    title: commit.title,
    authoredDate: commit.authoredDate,
    webUrl: commit.webUrl,
    files: (commit.fileChanges ?? []).slice(0, 12).map(f => f.path),
    relevance: relevance || `该提交位于日报所述项目「${entry.projectName}」中，可能是描述对应的改动`,
  }
}

/** 各判定档位在分数里的权重：符合满分，部分符合一半，其余不计分。 */
const VERDICT_WEIGHT: Record<VerdictLevel, number> = {
  'matched': 1,
  'partial': 0.5,
  'mismatched': 0,
  'no-commit': 0,
  'unverified': 0,
}

export function buildSummary(
  entries: EntryInspection[],
  orphanCommits: GitCommit[],
  totalHours: number,
  _settings: AppSettings,
  workload: DayMetrics = dayMetrics([]),
): InspectionSummary {
  /*
   * 每个条目只能落进一个工时桶。
   *
   * 一个条目可能同时是「非编码工作」和「项目未映射」（比如「参加需求评审」配上没配映射的项目名），
   * 早先按条件各自求和会让同一份工时被算进两个桶，工时构成条的总长超过实际总工时。
   * 所以这里显式定优先级，保证各桶之和恒等于 totalHours。
   *
   * 未映射优先于非编码：映射没配是能立刻修的问题，先暴露它更有行动价值。
   */
  const bucketOf = (e: EntryInspection): keyof Pick<
    InspectionSummary,
    'matchedHours' | 'partialHours' | 'mismatchedHours' | 'noCommitHours' | 'nonCodingHours' | 'unresolvedHours'
  > => {
    if (e.projectUnresolved)
      return 'unresolvedHours'
    if (e.nonCodingWork)
      return 'nonCodingHours'
    switch (e.verdict) {
      case 'matched': return 'matchedHours'
      case 'partial': return 'partialHours'
      case 'mismatched': return 'mismatchedHours'
      default: return 'noCommitHours'
    }
  }

  const buckets = {
    matchedHours: 0,
    partialHours: 0,
    mismatchedHours: 0,
    noCommitHours: 0,
    nonCodingHours: 0,
    unresolvedHours: 0,
  }
  for (const entry of entries)
    buckets[bucketOf(entry)] += entry.hours

  // 可核对工时 = 落进判定桶的部分，也就是分数的分母。
  // 「开了一天会」和「项目没配映射」都不该判成 0 分，否则结论失真。
  const checkedHours = round2(
    buckets.matchedHours + buckets.partialHours + buckets.mismatchedHours + buckets.noCommitHours,
  )
  const earned = entries
    .filter(e => bucketOf(e) === 'matchedHours' || bucketOf(e) === 'partialHours')
    .reduce((s, e) => s + e.hours * VERDICT_WEIGHT[e.verdict], 0)

  const saturation = saturationOf(workload)

  return {
    score: checkedHours > 0 ? Math.round((earned / checkedHours) * 1000) / 10 : 0,
    checkedHours,
    totalHours: round2(totalHours),
    matchedHours: round2(buckets.matchedHours),
    partialHours: round2(buckets.partialHours),
    mismatchedHours: round2(buckets.mismatchedHours),
    noCommitHours: round2(buckets.noCommitHours),
    nonCodingHours: round2(buckets.nonCodingHours),
    unresolvedHours: round2(buckets.unresolvedHours),
    orphanCommitCount: orphanCommits.length,
    sessions: workload.sessions,
    activeBuckets: workload.activeBuckets,
    presenceHours: workload.presenceHours,
    activeHours: workload.activeHours,
    effectiveLow: workload.effectiveLow,
    effectiveHigh: workload.effectiveHigh,
    saturation: saturation === null ? 0 : Math.round(saturation * 100) / 100,
    batchSuspect: workload.batchSuspect,
    workloadBasis: workload.basis,
  }
}

/** 常见的泛词，命中它们不能算「日报和提交对上了」 */
const GENERIC_TERMS = new Set([
  '工作', '完成', '开发', '处理', '进行', '相关', '支持', '问题', '功能', '优化',
  '调整', '修复', '需求', '项目', '任务', '今天', '以及', '部分', '内容',
  'the', 'and', 'for', 'with', 'fix', 'update',
])

function keywordsOf(content: string): string[] {
  return content
    .split(/[^\p{L}\p{N}]+/u)
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length >= 2 && !GENERIC_TERMS.has(term))
}

/** 日报里的关键词能否在提交标题/正文/文件路径里找到 */
function keywordHit(content: string, commit: GitCommit): boolean {
  const terms = keywordsOf(content)
  if (!terms.length)
    return false
  const hay = [commit.title, commit.message, ...(commit.fileChanges ?? []).map(f => f.path)]
    .join(' ')
    .toLowerCase()
  return terms.some(term => hay.includes(term))
}

/**
 * 证据强度。
 *
 * 「有提交」和「提交能证明日报」是两件事：前者只需数量，后者要求能落到具体改动。
 * 这里用代码统计判断，不让模型自己给自己打分。
 */
function evidenceStrengthOf(
  entry: EntryInspection,
  commitById: Map<string, GitCommit>,
): EvidenceStrength {
  if (entry.verdict === 'no-commit')
    return 'none'

  const commits = entry.matchedCommitIds
    .map(id => commitById.get(id))
    .filter((c): c is GitCommit => Boolean(c))

  if (!commits.length)
    return entry.nonCodingWork ? 'weak' : 'none'

  // 具体证据：有改动正文，或日报关键词能在提交里找到
  const concrete = commits.some(c =>
    (c.fileChanges ?? []).some(f => Boolean(f.patch)) || keywordHit(entry.content, c),
  )
  if (!concrete)
    return 'weak'

  if ((entry.verdict === 'matched' || entry.verdict === 'partial') && entry.confidence >= 0.6)
    return 'strong'
  return 'medium'
}

function fallbackNarrative(
  entries: EntryInspection[],
  orphanCommits: GitCommit[],
  summary: InspectionSummary,
): string {
  if (!entries.length)
    return '当日没有查到该成员的日报记录。如确有工作提交，属于漏报日报。'

  const parts: string[] = []
  parts.push(
    summary.checkedHours > 0
      ? `当日可核对工时 ${summary.checkedHours} 小时，加权符合度 ${summary.score} 分。`
      : '当日没有可用于核对的工作内容（全部为非编码工作或项目未映射）。',
  )

  const problems = entries.filter(e => e.verdict === 'mismatched' || (e.verdict === 'no-commit' && !e.nonCodingWork))
  if (problems.length) {
    const names = problems.map(e => `${e.projectName}（${e.hours}h）`).join('、')
    parts.push(`需要跟进：${names} 的日报内容未能被提交支撑。`)
  }

  const unresolved = entries.filter(e => e.projectUnresolved)
  if (unresolved.length) {
    parts.push(`另有 ${unresolved.length} 条内容因项目未映射到仓库而无法核对，建议先在设置里补齐映射。`)
  }

  if (orphanCommits.length) {
    const projects = [...new Set(orphanCommits.map(c => c.projectPath))].join('、')
    parts.push(`有 ${orphanCommits.length} 个提交未被任何一条日报内容引用（可能属于已申报项目的辅助工作，也可能是漏报），涉及 ${projects}。`)
  }

  return parts.join('')
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

export { isCoreWindow }
