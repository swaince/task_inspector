import type { GitLabClient } from '../adapters/gitlab'
import type { RuleSettings } from '../config/settings'
import type { DailyReport, GitCommit, Project, WorkSignal } from '../domain/types'
import type { ProjectProfile, RepoProfile } from './profile'
import { formatDateCN, formatDateTime, todayKey } from '@/lib/format'
import { collectProjectCommits } from './activity'
import { projectMatches, toProjectRefs } from './matching'
import { shiftDate } from './window'

/**
 * 项目对话的资料包。
 *
 * 和「项目画像」的分工：画像回答「代码长什么样」，这里回答「关于这个项目，
 * 模型现在知道什么」。资料由三块拼成，各自带来源标签：
 * - 代码画像（静态，可能过时，带生成时间）；
 * - 最近提交（实时从 GitLab 拉，事实）；
 * - 相关日报条目（成员自述，未必准确）。
 *
 * 拼装是确定性的，不经过模型：让模型再总结一遍资料，既慢又会丢细节，
 * 还会把「资料里没有」写成看起来很像真的答案。
 */

export interface ProjectContextStats {
  days: number
  repos: number
  /** 是否带上项目画像；没有画像时架构类问题只能基于提交回答 */
  profile: boolean
  modules: number
  /** 实际写进资料的提交/日报条数（可能少于抓取量） */
  commits: number
  /** 写进资料的 MR / 评审 / Issue 活动条数 */
  signals: number
  reportEntries: number
  failures: string[]
  builtAt: string
}

export interface ProjectContext {
  text: string
  stats: ProjectContextStats
}

export interface ProjectContextInput {
  project: Project
  profile: ProjectProfile | null
  /** 已载入的日报；内部按日期过滤，不需要调用方先裁剪 */
  reports: DailyReport[]
  rules: RuleSettings
  gitlab?: GitLabClient
  /** 回看天数，包含今天。默认 30 天 */
  days?: number
  /** 是否读取 MR / 评审 / Issue 活动；默认读取 */
  useSignals?: boolean
  /** 日报刷新失败之类需要让模型知道的限制 */
  notes?: string[]
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

const DEFAULT_DAYS = 30
const MAX_COMMITS = 120
const MAX_REPORT_ENTRIES = 80
const MAX_PROFILE_REPORT_CHARS = 8000
const MAX_MODULES = 24
const MAX_EDGES = 40
const MAX_FINDINGS = 12
const MAX_HOT_FILES = 5
const MAX_ENTRY_CHARS = 320
/**
 * 资料总长上限。
 *
 * 一次对话会把整包资料作为 system prompt 发出去。多仓库项目的模块表能到几万字，
 * 小上下文的内网模型会直接报超长。超出时截断并明确说明，比让请求失败好。
 */
const MAX_CONTEXT_CHARS = 36_000

/** 表格单元格里的 | 和换行会把 markdown 表格拆坏 */
function cell(value: string | number | undefined) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim() || '—'
}

function clip(text: string, max: number) {
  const value = text.trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function round1(n: number) {
  return Math.round(n * 10) / 10
}

function devModeLabel(mode: Project['devMode']) {
  return {
    manual: '人工开发',
    'ai-assisted': 'AI 辅助开发',
    'ai-driven': 'AI 开发',
  }[mode] ?? mode
}

function isIgnoredCommit(title: string, rules: RuleSettings) {
  if (rules.ignoreMergeCommits && /^Merge (branch|remote-tracking branch|pull request)/i.test(title))
    return true
  return (rules.ignoreCommitMessagePatterns ?? []).some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(title)
    }
    catch {
      return false
    }
  })
}

function describeProject(project: Project) {
  const lines: string[] = [
    `- 名称：${project.name}`,
    `- 编码：${project.code || '—'}`,
    `- 别名：${project.aliases?.length ? project.aliases.join('、') : '—'}`,
    `- 开发模式：${devModeLabel(project.devMode)}`,
    `- 状态：${project.enabled ? '启用' : '停用'} / ${project.followed ? '关注' : '未关注'}${project.archived ? ' / 已归档' : ''}`,
  ]
  if (project.description?.trim())
    lines.push(`- 描述：${project.description.trim()}`)

  const repos = project.repos ?? []
  if (repos.length) {
    lines.push(`- 关联仓库（${repos.length} 个）：`)
    for (const repo of repos)
      lines.push(`  - ${repo.pathWithNamespace}${repo.defaultBranch ? `（默认分支 ${repo.defaultBranch}）` : ''}`)
  }
  else if (project.pathWithNamespace) {
    lines.push(`- 关联仓库：${project.pathWithNamespace}`)
  }
  else {
    lines.push('- 关联仓库：未关联，无法读取提交')
  }
  return lines.join('\n')
}

function describeModules(repo: RepoProfile) {
  if (!repo.modules.length)
    return ''

  const rows = repo.modules.slice(0, MAX_MODULES).map((module) => {
    const entries = module.entries?.slice(0, 2).join('、')
    return [
      cell(module.name),
      cell(module.path),
      cell(module.files),
      cell(`${module.mainFiles}/${module.testFiles}`),
      cell(module.fanOut),
      cell(module.fanIn),
      cell(entries || '—'),
      cell(clip(module.summary || '—', 200)),
    ].join(' | ')
  })

  const more = repo.modules.length > MAX_MODULES
    ? `\n（模块过多，仅列出前 ${MAX_MODULES} 个，共 ${repo.modules.length} 个）`
    : ''

  return [
    '| 模块 | 目录 | 文件 | 主/测试 | 依赖 | 被依赖 | 入口 | 职责 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row} |`),
  ].join('\n') + more
}

function describeRepo(repo: RepoProfile) {
  const pieces: string[] = []
  pieces.push(`### 仓库 ${repo.repoPath}`)
  pieces.push(`扫描文件 ${repo.files} 个${repo.truncated ? '（超出上限，仅扫描了部分）' : ''}${repo.error ? `；扫描错误：${repo.error}` : ''}`)
  const branchParts: string[] = []
  if (repo.defaultBranch)
    branchParts.push(`默认 ${repo.defaultBranch}`)
  if (repo.latestBranch)
    branchParts.push(`最近提交 ${repo.latestBranch}`)
  if (repo.currentBranch)
    branchParts.push(`本地当前 ${repo.currentBranch}`)
  if (repo.analyzedBranch)
    branchParts.push(`画像基于 ${repo.analyzedBranch}`)
  if (repo.branches?.length)
    branchParts.push(`共 ${repo.branches.length} 个分支引用`)
  if (branchParts.length)
    pieces.push(`分支：${branchParts.join(' · ')}`)
  if (repo.branchWork?.length) {
    const list = repo.branchWork.slice(0, 12).map(b =>
      `- ${b.name}${b.default ? '（默认）' : ''}：${b.commits} 条提交，最近 ${b.latestCommitAt ?? '未知'}；`
      + `近期：${b.titles.slice(0, 3).join('；') || '（无标题）'}`,
    )
    pieces.push(`近 ${repo.branchWorkDays ?? 90} 天各分支在做什么：\n${list.join('\n')}`)
  }
  if (repo.branchWorkError)
    pieces.push(`分支提交可能不全：${repo.branchWorkError}`)
  if (repo.narrative)
    pieces.push(repo.narrative)

  const modules = describeModules(repo)
  if (modules)
    pieces.push(modules)
  else
    pieces.push('没有识别出模块结构。')

  const edges = repo.graph?.edges ?? []
  if (edges.length) {
    const list = edges
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_EDGES)
      .map(e => `${e.from} → ${e.to}（${e.weight}）`)
    pieces.push(`模块依赖：${list.join('；')}${edges.length > MAX_EDGES ? ' …' : ''}`)
  }

  const hot = (repo.hotFiles ?? []).slice(0, MAX_HOT_FILES)
  if (hot.length)
    pieces.push(`近期改动最多的文件：${hot.map(f => `${f.path}（${f.changes} 次）`).join('、')}`)

  return pieces.join('\n\n')
}

function describeProfile(profile: ProjectProfile) {
  const pieces: string[] = [
    `生成时间：${formatDateTime(profile.generatedAt)}`,
  ]
  if (profile.narrative)
    pieces.push(profile.narrative)
  if (profile.report?.trim()) {
    pieces.push('#### 代码分析报告')
    pieces.push(clip(profile.report, MAX_PROFILE_REPORT_CHARS))
  }

  for (const repo of profile.repos)
    pieces.push(describeRepo(repo))

  const findings = profile.repos
    .flatMap(repo => repo.findings ?? [])
    .slice(0, MAX_FINDINGS)
  if (findings.length) {
    pieces.push('#### 自动发现的问题（由代码统计得出，不经过模型）')
    pieces.push(findings.map((f) => {
      const severity = { high: '高', medium: '中', low: '低' }[f.severity]
      const modules = f.modules?.length ? `（涉及模块：${f.modules.join('、')}）` : ''
      return `- [${severity}] ${f.title}：${f.detail}${modules}`
    }).join('\n'))
  }

  return pieces.join('\n\n')
}

function describeCommits(commits: GitCommit[]) {
  return commits.map((commit) => {
    const stats = commit.stats ? `，+${commit.stats.additions}/-${commit.stats.deletions}` : ''
    const date = formatDateTime(commit.committedDate)
    const branches = commit.branches?.length
      ? ` [分支 ${commit.branches.join('、')}]`
      : commit.refName ? ` [分支 ${commit.refName}]` : ''
    // 提交正文常写「为什么改」，比标题更有信息量；标题已经有了，只补正文
    const body = commit.message.split(/\r?\n/).slice(1).join(' ').trim()
    const detail = body ? ` —— ${clip(body, 140)}` : ''
    return `- ${date} ${commit.authorName}${branches}：${commit.title}${detail}（${commit.projectPath}${stats}）`
  }).join('\n')
}

interface ReportEntryLine {
  date: string
  memberName: string
  content: string
  hours: number
}

function describeReportEntries(entries: ReportEntryLine[]) {
  return entries.map((entry) => {
    return `- ${formatDateCN(entry.date)} ${entry.memberName}（${round1(entry.hours)}h）：${clip(entry.content, MAX_ENTRY_CHARS)}`
  }).join('\n')
}

const SIGNAL_LABEL: Record<WorkSignal['kind'], string> = {
  merge_request: 'MR',
  review: '评审',
  issue: 'Issue',
  pipeline: '流水线',
}

function describeSignals(signals: WorkSignal[]) {
  return signals.map((signal) => {
    const who = signal.authorName || signal.username || '未知作者'
    return `- ${formatDateTime(signal.at)} ${who} [${SIGNAL_LABEL[signal.kind]}]：${clip(signal.title, 120)}（${signal.projectPath}）`
  }).join('\n')
}

/**
 * 拉取最近提交并拼出资料包。
 *
 * 日报由调用方传进来，是因为它可能来自本地快照，也可能是刚刷新的实时数据；
 * 这一层不替调用方决定用哪一份。
 */
export async function loadProjectContext(input: ProjectContextInput): Promise<ProjectContext> {
  const days = Math.max(1, input.days ?? DEFAULT_DAYS)
  const to = todayKey()
  const from = shiftDate(to, -(days - 1))
  const notes = [...(input.notes ?? [])]
  const failures: string[] = []

  let commits: GitCommit[] = []
  let signals: WorkSignal[] = []
  const refs = toProjectRefs(input.project)
  if (refs.length && input.gitlab) {
    input.onProgress?.(`正在读取 ${refs.length} 个仓库最近 ${days} 天的提交…`)
    const collected = await collectProjectCommits(refs, from, to, {
      gitlab: input.gitlab,
      rules: input.rules,
      perPage: 100,
      maxCommitsPerProject: MAX_COMMITS,
      fetchSignals: input.useSignals !== false,
      signal: input.signal,
      onProgress: p => input.onProgress?.(p.message),
    })
    commits = collected.batches.flatMap(batch => batch.commits)
    signals = collected.batches.flatMap(batch => batch.signals ?? [])
    failures.push(...collected.failures.map(f => `${f.projectPath}：${f.message}`))
  }
  else if (!refs.length) {
    notes.push('项目没有关联 GitLab 仓库，无法读取提交记录。')
  }
  else {
    notes.push('GitLab 未配置，无法读取提交记录。')
  }

  commits = commits
    .filter(commit => !isIgnoredCommit(commit.title, input.rules))
    .sort((a, b) => b.committedDate.localeCompare(a.committedDate))
  const listedCommits = commits.slice(0, MAX_COMMITS)

  signals = signals
    .filter((signal) => {
      const date = signal.at.slice(0, 10)
      return date >= from && date <= to
    })
    .sort((a, b) => b.at.localeCompare(a.at))
  const listedSignals = signals.slice(0, 60)

  input.onProgress?.('正在整理相关日报…')
  const reportEntries: ReportEntryLine[] = []
  for (const report of input.reports) {
    if (!report.date || report.date < from || report.date > to)
      continue
    for (const entry of report.entries) {
      if (!projectMatches(input.project, entry))
        continue
      reportEntries.push({
        date: report.date,
        memberName: report.memberName,
        content: entry.content,
        hours: entry.hours,
      })
    }
  }
  reportEntries.sort((a, b) => b.date.localeCompare(a.date))
  const listedEntries = reportEntries.slice(0, MAX_REPORT_ENTRIES)

  if (reportEntries.length > listedEntries.length)
    notes.push(`日报条目较多，资料中只列出最近 ${listedEntries.length} 条（共 ${reportEntries.length} 条）。`)
  if (commits.length > listedCommits.length)
    notes.push(`提交较多，资料中只列出最近 ${listedCommits.length} 条（共 ${commits.length} 条）。`)

  const profile = input.profile
  const modules = profile?.repos.reduce((sum, repo) => sum + repo.modules.length, 0) ?? 0

  const sections: string[] = []
  sections.push(`# 项目资料\n时间范围：最近 ${days} 天（${formatDateCN(from)} ~ ${formatDateCN(to)}）\n\n## 项目基本信息\n${describeProject(input.project)}`)

  if (profile)
    sections.push(`## 项目代码画像\n${describeProfile(profile)}`)
  else
    sections.push('## 项目代码画像\n尚未生成。涉及架构、模块、核心功能的问题只能依据仓库信息和提交记录回答；要得到模块结构，需要先在「项目画像」页生成画像。')

  if (listedCommits.length) {
    sections.push(`## 最近提交（${listedCommits.length} 条，按提交时间倒序）\n${describeCommits(listedCommits)}`)
  }
  else {
    sections.push(`## 最近提交\n最近 ${days} 天没有读到提交记录${failures.length ? '（部分仓库拉取失败，见资料说明）' : ''}。`)
  }

  if (input.useSignals !== false) {
    if (listedSignals.length) {
      sections.push(
        `## 最近 MR / 评审 / Issue 活动（${listedSignals.length} 条）\n`
        + '这些活动代表评审、需求跟进和问题排查，同样占用工作时间；提交少时不能据此判断没工作。\n\n'
        + describeSignals(listedSignals),
      )
    }
    else {
      sections.push('## 最近 MR / 评审 / Issue 活动\n最近一段时间没有读到这类活动（也可能模板/权限没有开放事件接口）。')
    }
  }

  if (listedEntries.length) {
    sections.push(
      `## 相关日报条目（${reportEntries.length} 条匹配，列出最近 ${listedEntries.length} 条）\n`
      + '这些是成员在日报里的自述，未必与提交完全一致。\n\n'
      + describeReportEntries(listedEntries),
    )
  }
  else {
    sections.push(`## 相关日报条目\n最近 ${days} 天没有与本项目匹配的日报条目。`)
  }

  if (notes.length || failures.length) {
    sections.push([
      '## 资料说明',
      ...notes.map(n => `- ${n}`),
      ...failures.map(f => `- 仓库拉取失败：${f}`),
    ].join('\n'))
  }

  const full = sections.join('\n\n')
  const text = full.length > MAX_CONTEXT_CHARS
    ? `${full.slice(0, MAX_CONTEXT_CHARS)}\n\n## 资料说明\n- 资料超过 ${MAX_CONTEXT_CHARS} 字符，末尾已截断；需要更完整的内容时请缩小时间范围或减少关联仓库。`
    : full
  if (full.length > MAX_CONTEXT_CHARS)
    notes.push(`资料超过 ${MAX_CONTEXT_CHARS} 字符，发送给模型时已截断。`)

  return {
    text,
    stats: {
      days,
      repos: refs.length,
      profile: Boolean(profile),
      modules,
      commits: listedCommits.length,
      signals: listedSignals.length,
      reportEntries: reportEntries.length,
      failures: [...notes, ...failures],
      builtAt: new Date().toISOString(),
    },
  }
}

/** 当前日期向前推 n 天，供调用方展示「资料范围」 */
export function contextRange(days: number) {
  const to = todayKey()
  return { from: shiftDate(to, -(days - 1)), to }
}
