import type { GitCommit } from '../domain/types'
import type { LlmClient } from '../llm/client'

/**
 * 工时占比估算。
 *
 * 和检查引擎的方向相反：检查是「拿日报去证代码」，这里是「从代码反推产出分布」。
 *
 * 两条设计纪律：
 *
 * 1. **估相对占比，不估绝对小时数。** 同样 100 行代码，新手要一天、熟手要一小时，
 *    估出来的是个人效率而不是工作量。而「这天 70% 的产出在 A 项目」是可比的，
 *    也正好能和日报里的工时占比直接对照。
 * 2. **估算过程看不到日报。** 一旦把申报的占比喂给模型，它就会顺着那个数字复述，
 *    对照出来的偏离全是假的。所以输入只有提交。
 */

export interface EstimateProjectInput {
  projectName: string
  projectPath: string
  commits: GitCommit[]
}

export interface ProjectShare {
  projectName: string
  /** 0-1，同一份结果里各项目之和为 1 */
  share: number
  reason: string
}

export interface ShareEstimate {
  shares: ProjectShare[]
  confidence: number
  note: string
  /** 样本不足时不做估算，只给这个标记和样本量 */
  insufficient: boolean
  sampleSize: number
}

/**
 * 低于这个提交数就不给估算。
 *
 * 三条提交以下，任何占比都是噪声：一条提交占 100% 不等于这个人整天都在那个项目上。
 * 与其给个看起来精确的数字，不如明说样本不够——这个数字可能被拿去和人对话，
 * 一个没有依据的 0.8 比没有数字伤害更大。
 */
export const MIN_SAMPLE_COMMITS = 3

export const ESTIMATE_SYSTEM = `你是研发效能分析师，负责根据代码提交估算一名研发当天在各项目上的工作量分布。

判断纪律：
1. 只依据给出的提交记录，不得臆测未提供的信息。
2. 估的是**相对占比**，各项目加起来等于 1.0，不是绝对小时数。
3. 判断依据按重要性排序：改动的核心逻辑占比 > 提交信息描述的问题复杂度 > 提交数量 > 增删行数。
4. 行数不可靠：生成代码、批量改名、格式化的行数很虚，权重应明显降低。
5. 测试、CI 配置、依赖升级这类提交，权重明显低于业务逻辑改动。
6. **改动行数不等于投入时间。** 排查一个线上问题、定位到一行配置改掉，可能耗掉两小时；
   而加一个常规页面可能只花一小时。所以要看提交在做什么，而不是改了多少行：
   - 提交信息里出现 排查 / 定位 / 调试 / 复现 / 分析 / 根因 / 线上问题 / 性能瓶颈 / 超时 这类字样时，
     按「这个问题本身有多难查」估，不要按改动量估；
   - 提交正文里描述的诊断过程越具体（现象、排除过的方向、定位到的原因），投入通常越大；
   - 纯新增、批量生成、改配置、升级依赖，行数再多投入也不高。
7. 只有单个项目时占比就是 1.0，但仍要说明依据。

只输出一个 JSON 对象，不要任何解释文字或 markdown 围栏：
{
  "shares": [{"project": "项目名，原样照抄输入里的名字", "share": 0.0 到 1.0, "reason": "一句话依据，要具体到改动或排查过程"}],
  "confidence": 0.0 到 1.0,
  "note": "一句话说明这次估算的局限，例如提交过少、只有配置改动"
}`

function compactCommit(commit: GitCommit): string {
  const stat = commit.stats ? ` +${commit.stats.additions}/-${commit.stats.deletions}` : ''
  const files = (commit.fileChanges ?? []).slice(0, 6).map(f => f.path).join(', ')
  // 提交正文经常就是排查过程的记录（「定位到…」「排除…之后发现…」），
  // 它对判断「这个问题查了多久」比行数有用得多
  const body = commit.message.split('\n').slice(1).join(' ').trim()
  const bodyPart = body ? `\n      ${body.slice(0, 240)}${body.length > 240 ? '…' : ''}` : ''
  return `  - ${commit.title}${stat}${files ? `（${files}）` : ''}${bodyPart}`
}

export function buildEstimatePrompt(
  memberName: string,
  date: string,
  projects: EstimateProjectInput[],
): string {
  const total = projects.reduce((s, p) => s + p.commits.length, 0)
  const lines: string[] = []
  lines.push(`员工：${memberName}`)
  lines.push(`日期：${date}`)
  lines.push(`当天共 ${total} 条提交，分布在 ${projects.length} 个项目。`)
  lines.push('')

  for (const project of projects) {
    const additions = project.commits.reduce((s, c) => s + (c.stats?.additions ?? 0), 0)
    const deletions = project.commits.reduce((s, c) => s + (c.stats?.deletions ?? 0), 0)
    lines.push(`项目：${project.projectName}（${project.projectPath}）`)
    lines.push(`  提交 ${project.commits.length} 条，+${additions}/-${deletions}`)
    for (const commit of project.commits.slice(0, 12))
      lines.push(compactCommit(commit))
    if (project.commits.length > 12)
      lines.push(`  …另 ${project.commits.length - 12} 条`)
    lines.push('')
  }

  lines.push('请按要求输出 JSON。')
  return lines.join('\n')
}

/** 从模型输出里抠 JSON 并归一化。归一化很关键——模型给的数常常加不到 1。 */
export function parseEstimate(raw: string, projectNames: string[]): ShareEstimate | null {
  const candidates: string[] = [raw.trim()]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1])
    candidates.push(fenced[1].trim())
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first)
    candidates.push(raw.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate)
      if (!obj || !Array.isArray(obj.shares))
        continue

      const byName = new Map(projectNames.map(n => [n, n]))
      const parsed: ProjectShare[] = []
      for (const item of obj.shares) {
        const name = typeof item?.project === 'string' ? item.project : ''
        // 模型可能改写项目名（加空格、去后缀），按原样匹配不上就跳过，
        // 不猜——猜错会把一个项目的占比算到另一个项目头上
        const canonical = byName.get(name)
        if (!canonical)
          continue
        const share = Number(item.share)
        if (!Number.isFinite(share) || share < 0)
          continue
        parsed.push({
          projectName: canonical,
          share,
          reason: typeof item.reason === 'string' ? item.reason : '',
        })
      }

      if (!parsed.length)
        continue

      const total = parsed.reduce((s, p) => s + p.share, 0)
      if (total <= 0)
        continue

      return {
        shares: parsed
          .map(p => ({ ...p, share: p.share / total }))
          .sort((a, b) => b.share - a.share),
        confidence: Math.min(1, Math.max(0, Number(obj.confidence) || 0.5)),
        note: typeof obj.note === 'string' ? obj.note : '',
        insufficient: false,
        sampleSize: 0,
      }
    }
    catch {
      continue
    }
  }
  return null
}

export async function estimateShares(
  memberName: string,
  date: string,
  projects: EstimateProjectInput[],
  llm: LlmClient,
  signal?: AbortSignal,
): Promise<ShareEstimate> {
  const sampleSize = projects.reduce((s, p) => s + p.commits.length, 0)

  if (sampleSize < MIN_SAMPLE_COMMITS)
    return { shares: [], confidence: 0, note: '', insufficient: true, sampleSize }

  if (!llm.configured)
    return {
      shares: [],
      confidence: 0,
      note: '未配置模型，无法估算工时占比',
      insufficient: false,
      sampleSize,
    }

  const completion = await llm.complete(
    [
      { role: 'system', content: ESTIMATE_SYSTEM },
      { role: 'user', content: buildEstimatePrompt(memberName, date, projects) },
    ],
    { signal },
  )

  const parsed = parseEstimate(completion.text, projects.map(p => p.projectName))
  if (!parsed) {
    return {
      shares: [],
      confidence: 0,
      note: '模型输出无法解析为结构化的占比结果',
      insufficient: false,
      sampleSize,
    }
  }

  return { ...parsed, sampleSize }
}
