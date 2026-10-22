import type { DailyReportEntry, GitCommit, InspectionResult } from '../domain/types'
import type { RuleSettings } from '../config/settings'
import { isCoreWindow } from './window'

/**
 * 提示词构造。
 *
 * 判定环节的输出必须是结构化 JSON，所以系统提示里把判定标准和输出格式都写死，
 * 并在解析侧做容错（模型偶尔会包 ```json 围栏或加一句解释）。
 */

export const JUDGE_SYSTEM = `你是研发工作内容稽核助手，负责核对员工的日报描述与当天在 GitLab 上的实际代码提交是否一致。

判定标准：
- matched：提交内容明确支撑日报描述。描述里的功能点、模块、问题都能在提交里找到对应。
- partial：方向一致但明显不完整。例如描述写了「重构 + 补测试」，实际只有重构；或描述了三个改动点只做了一个。
- mismatched：有该项目的提交，但内容与描述对不上。例如描述写「优化对账报表」，提交全是「调整 CI 配置」。
- no-commit：该项目当天没有提交。可能是未能产出代码的工作（会议、评审、调研、答疑、文档、环境问题排查），也可能确实没干活，需要在 reason 里说明是哪种。
- unverified：提供的材料不足以判断。

判定纪律：
1. 只依据给出的提交记录判断，不得臆测未提供的信息。
2. 合并分支、格式化、升级依赖、改 CI 配置这类提交不构成实质性工作支撑。
3. 日报描述偏笼统时（如「日常开发」「推进项目」），只要有该项目的实质提交，倾向判 matched；不要因为描述不精确就判 mismatched。
4. 提交量少不等于没干活。小而精准的修复（几行改动）如果正好对应描述里的问题，仍然是 matched。
5. 判定要落到「能不能用提交自证日报」这个目的上，而不是评价代码质量。
6. **提交标题和正文可能不规范甚至无意义**（例如「update」「fix」「修改」「提交」）。
   判断时以「改动文件」和「代码要点」为准，标题只作参考；不要因为标题没提到描述里的词就判 mismatched，
   也不要因为标题写了关键词而忽略代码里其实没做这件事。

只输出一个 JSON 对象，不要任何解释文字或 markdown 围栏：
{
  "verdict": "matched | partial | mismatched | no-commit | unverified",
  "confidence": 0.0 到 1.0 之间的小数,
  "reason": "一到三句话说清判定依据，要具体到提交或文件",
  "nonCodingWork": true/false，该描述是否属于本就不产出代码的工作,
  "evidence": [{"commitId": "完整 commit id", "relevance": "该提交与描述的关联点，一句话"}],
  "suggestions": ["可选，若日报描述与实际不符，给出更贴合的写法"]
}`

export const SUMMARY_SYSTEM = `你是研发效能分析师。根据逐条核对结果，写一段给研发管理者看的当日结论。

要求：
- 3 到 6 句话，直接说结论，不要复述数据表格。
- 先给整体判断（当日日报是否能被提交自证），再点出需要关注的具体问题。
- 如果存在「有提交但日报没写」的情况，必须指出。
- 不要给出人事评价或绩效结论，只陈述事实与需要跟进的点。
- 如果数据里给了「预估有效工时 / 工作饱和度」，可以引用，但要注明它只统计代码产出，不能当作考勤或绩效结论。
- 输出纯文本，不要 markdown 标题和列表。`

/* ------------------------------------------------------------------ *
 * 非编码工作的关键词兜底
 * ------------------------------------------------------------------ */

const NON_CODING_PATTERNS: Array<{ re: RegExp, label: string }> = [
  { re: /会议|评审|例会|晨会|沟通|讨论|对齐|汇报|访谈/, label: '会议类' },
  { re: /培训|学习|调研|预研|技术分享|看文档|阅读/, label: '学习调研类' },
  { re: /答疑|支持|协助|答疑|解答|排障咨询|oncall|值班/i, label: '支持类' },
  { re: /文档|方案|设计稿|ppt|汇报材料|需求文档/i, label: '文档类' },
  { re: /休假|请假|调休|年假|病假/, label: '休假' },
  { re: /环境|部署|发布|上线部署|运维|配置环境/, label: '环境部署类' },
]

/**
 * 关键词兜底判断，用于两处：
 * 1. 给 LLM 一个先验提示；
 * 2. LLM 不可用时（未配置或调用失败）退化成纯规则判定。
 */
export function detectNonCoding(content: string): { nonCoding: boolean, label?: string } {
  for (const { re, label } of NON_CODING_PATTERNS) {
    if (re.test(content))
      return { nonCoding: true, label }
  }
  return { nonCoding: false }
}

/* ------------------------------------------------------------------ *
 * 条目判定提示
 * ------------------------------------------------------------------ */

export interface JudgeContext {
  memberName: string
  date: string
  projectName: string
  gitlabProjects: string[]
  commits: GitCommit[]
  rules: RuleSettings
  /** 该成员当天所有项目，用于提示可能存在跨项目描述错填 */
  otherProjects: string[]
}

/** 单条提交最多展示几个文件的代码要点 */
const EXCERPT_FILES = 3
/** 每个文件最多几行 */
const EXCERPT_LINES_PER_FILE = 22
/** 每条提交的代码要点总字符上限 */
const EXCERPT_BUDGET = 900

/**
 * 从 diff 里挑出「能说明做了什么」的行。
 *
 * 不做智能解析，只做三件事：去掉空行、注释、import 这类噪声；只留增删行；
 * 截断超长的行。目的是让模型看到真实的类名/方法名/接口/SQL，
 * 而不是把整个 diff 塞进上下文——一个生成文件的 diff 就能把预算吃光。
 */
function codeExcerpt(commit: GitCommit): string | null {
  const files = (commit.fileChanges ?? []).filter(f => f.patch && f.patch.trim())
  if (!files.length)
    return null

  const blocks: string[] = []
  let used = 0

  for (const file of files.slice(0, EXCERPT_FILES)) {
    const picked: string[] = []
    for (const raw of file.patch!.split('\n')) {
      if (picked.length >= EXCERPT_LINES_PER_FILE)
        break
      if (!raw.startsWith('+') && !raw.startsWith('-'))
        continue
      // 文件头不是改动内容
      if (raw.startsWith('+++') || raw.startsWith('---'))
        continue

      const line = raw.slice(1).trim()
      if (!line)
        continue
      // 注释、包声明、import 提供不了「做了什么」的信息
      if (/^(\/\/|#|\*|\/\*|<!--)/.test(line))
        continue
      if (/^(package|import|using|from)\s/.test(line))
        continue

      picked.push(`${raw[0]} ${line.length > 120 ? `${line.slice(0, 120)}…` : line}`)
    }

    if (!picked.length)
      continue

    const block = `    ${file.path}\n${picked.map(l => `      ${l}`).join('\n')}`
    if (used + block.length > EXCERPT_BUDGET)
      break
    used += block.length
    blocks.push(block)
  }

  return blocks.length ? blocks.join('\n') : null
}

function formatCommit(commit: GitCommit, index: number, ctx: JudgeContext): string {
  const lines: string[] = []
  const time = commit.authoredDate.replace('T', ' ').slice(0, 16)
  const stat = commit.stats ? ` +${commit.stats.additions}/-${commit.stats.deletions}` : ''
  const outside = isCoreWindow(commit.authoredDate, ctx.date, ctx.rules) ? '' : ' [当日核心时段之外]'
  lines.push(`[${index + 1}] ${commit.id}  ${time}${stat}${outside}`)
  lines.push(`    标题: ${commit.title}`)
  const body = commit.message.split('\n').slice(1).join('\n').trim()
  if (body)
    lines.push(`    正文: ${truncate(body, 400)}`)

  const files = commit.fileChanges ?? []
  if (files.length) {
    const shown = files.slice(0, 20).map(f => {
      const mark = f.isNew ? '新增' : f.isDeleted ? '删除' : f.isRenamed ? '重命名' : '修改'
      return `${f.path}(${mark})`
    })
    lines.push(`    文件(${files.length}): ${shown.join(', ')}${files.length > 20 ? ` …另 ${files.length - 20} 个` : ''}`)
  }

  const excerpt = codeExcerpt(commit)
  if (excerpt) {
    lines.push('    代码要点:')
    lines.push(excerpt)
  }

  lines.push('')
  return lines.join('\n')
}

export function buildJudgePrompt(entry: DailyReportEntry, ctx: JudgeContext): string {
  const hint = detectNonCoding(entry.content)
  const parts: string[] = []

  parts.push(`员工：${ctx.memberName}`)
  parts.push(`日报日期：${ctx.date}`)
  parts.push('')
  parts.push('待核对的日报条目：')
  parts.push(`  项目：${entry.projectName}`)
  parts.push(`  工时：${entry.hours} 小时`)
  parts.push(`  工作内容：${entry.content}`)
  if (entry.taskRefs?.length)
    parts.push(`  关联任务号：${entry.taskRefs.join(', ')}`)
  parts.push('')

  if (ctx.gitlabProjects.length)
    parts.push(`该项目对应的代码仓库：${ctx.gitlabProjects.join(', ')}`)
  else
    parts.push('该项目未能对应到任何代码仓库，如果下面没有提交，应判定为 unverified 并说明原因。')
  parts.push('')

  if (ctx.commits.length) {
    parts.push(`当天在${ctx.gitlabProjects.length ? '该项目' : '已关联仓库'}的提交记录（共 ${ctx.commits.length} 条）：`)
    parts.push('')
    parts.push(ctx.commits.map((c, i) => formatCommit(c, i, ctx)).join(''))
  }
  else {
    parts.push('当天该项目没有任何提交记录。')
    parts.push('')
  }

  if (hint.nonCoding)
    parts.push(`注意：该条描述看起来属于「${hint.label}」的工作，这类工作本就不产生提交，判定时请据此考虑。`)

  if (ctx.otherProjects.length && !ctx.commits.length) {
    parts.push(
      `补充信息：该员工当天在其它项目（${ctx.otherProjects.join('、')}）有活动。`
      + '如果描述内容明显属于别的项目，请在 reason 里指出可能填错了项目。',
    )
  }

  parts.push('')
  parts.push('请按要求输出 JSON 判定结果。')
  return parts.join('\n')
}

/* ------------------------------------------------------------------ *
 * 汇总提示
 * ------------------------------------------------------------------ */

export function buildSummaryPrompt(
  memberName: string,
  date: string,
  entries: Array<{ projectName: string, content: string, hours: number, verdict: string, reason: string }>,
  orphans: Array<{ projectPath: string, title: string, authoredDate: string }>,
  summary: {
    score: number
    totalHours: number
    effectiveLow?: number
    effectiveHigh?: number
    saturation?: number
    batchSuspect?: boolean
  },
): string {
  const lines: string[] = []
  lines.push(`员工：${memberName}`)
  lines.push(`日期：${date}`)
  lines.push(`加权符合度：${summary.score.toFixed(1)} / 100（日报工时合计 ${summary.totalHours} 小时）`)
  if (summary.effectiveHigh) {
    lines.push(
      `代码产出折算：预估有效工时 ${summary.effectiveLow}–${summary.effectiveHigh}h（仅代码产出，不含会议/评审），`
      + `工作饱和度约 ${Math.round((summary.saturation ?? 0) * 100)}%`,
    )
  }
  if (summary.batchSuspect)
    lines.push('注意：提交集中在很短的时间内且改动量较大，可能是一次补提交（多天工作合并提交），自证工时可能被低估。')
  lines.push('')
  lines.push('逐条核对结果：')
  for (const e of entries) {
    lines.push(`- [${e.verdict}] ${e.projectName}（${e.hours}h）：${truncate(e.content, 120)}`)
    lines.push(`  判定理由：${truncate(e.reason, 200)}`)
  }

  lines.push('')
  if (orphans.length) {
    lines.push('有提交但没有任何日报条目引用：')
    for (const o of orphans)
      lines.push(`- ${o.projectPath} @ ${o.authoredDate.slice(0, 16).replace('T', ' ')}：${truncate(o.title, 100)}`)
  }
  else {
    lines.push('不存在未被任何日报条目引用的提交。')
  }

  lines.push('')
  lines.push('请写出当日结论。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 输出解析
 * ------------------------------------------------------------------ */

export interface ParsedJudgement {
  verdict: InspectionResult['entries'][number]['verdict']
  confidence: number
  reason: string
  nonCodingWork: boolean
  evidence: Array<{ commitId: string, relevance: string }>
  suggestions: string[]
}

const VERDICTS = new Set(['matched', 'partial', 'mismatched', 'no-commit', 'unverified'])

/**
 * 从模型输出里抠出 JSON。
 * 模型常见的两种偏差是包 ```json 围栏、或在 JSON 前后带一句说明，
 * 所以先尝试直接解析，失败再截取首个花括号块。
 */
export function parseJudgement(raw: string): ParsedJudgement | null {
  const candidates: string[] = []
  const trimmed = raw.trim()
  if (trimmed)
    candidates.push(trimmed)

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1])
    candidates.push(fenced[1].trim())

  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first)
    candidates.push(raw.slice(first, last + 1))

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c)
      if (obj && typeof obj === 'object' && typeof obj.verdict === 'string') {
        const verdict = VERDICTS.has(obj.verdict) ? obj.verdict : 'unverified'
        return {
          verdict: verdict as ParsedJudgement['verdict'],
          confidence: clamp01(Number(obj.confidence)),
          reason: typeof obj.reason === 'string' ? obj.reason : '',
          nonCodingWork: Boolean(obj.nonCodingWork),
          evidence: Array.isArray(obj.evidence)
            ? obj.evidence
                .filter((e: any) => e && typeof e.commitId === 'string')
                .map((e: any) => ({ commitId: e.commitId, relevance: String(e.relevance ?? '') }))
            : [],
          suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.map(String).filter(Boolean) : [],
        }
      }
    }
    catch {
      continue
    }
  }
  return null
}

function clamp01(n: number) {
  if (!Number.isFinite(n))
    return 0.5
  return Math.min(1, Math.max(0, n))
}

export function truncate(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
