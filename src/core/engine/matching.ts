import type { GitCommit, GitLabProjectRef, MemberIdentityInput, MemberProfile, Project } from '../domain/types'

/**
 * 把日报里的项目名/人名对应到 GitLab 上的项目和身份。
 *
 * 匹配优先级从高到低：
 *   1. 项目实体（名 / 编码 / 别名，按各自配置的 matchMode）——这是主路径
 *   2. 项目路径精确匹配（日报直接写了 group/repo 时）
 *   3. 相似度模糊匹配（给出候选，低于阈值就报「未匹配」交给人工确认）
 *
 * 模糊匹配故意保守：宁可报「需要人工确认」，也不要把 A 项目的提交算到 B 项目头上，
 * 否则检查结论会失真。
 */

export interface ProjectCandidate {
  project: GitLabProjectRef
  score: number
}

export interface ProjectResolution {
  reportProjectName: string
  projects: GitLabProjectRef[]
  /**
   * project = 命中项目实体
   * missing = 命中了实体，但它在 GitLab 上已找不到
   * unfollowed = 命中了实体，但它没被关注，本次不检查
   * path-exact / fuzzy = 没配实体时按仓库路径猜的
   * none = 没匹配上
   */
  strategy: 'project' | 'missing' | 'unfollowed' | 'path-exact' | 'fuzzy' | 'none'
  /** 模糊匹配时的最高分，用于 UI 排序和阈值提示 */
  score: number
  /** 供人工确认的候选列表 */
  candidates: ProjectCandidate[]
  /** 给用户看的原因说明，未匹配/已删除/未关联仓库时会填 */
  note?: string
}

export const FUZZY_THRESHOLD = 0.62

/** 归一化：去空白、去全角空格、统一小写，便于比较。 */
function normalize(s: string) {
  return s
    .replace(/\s+/g, '')
    .replace(/[　]/g, '')
    .replace(/[（）()]/g, '')
    .toLowerCase()
}

/**
 * 字符二元组 Dice 相似度。
 * 对中文同样有效——中文没有词边界，按词切分的方案在项目名上表现很差。
 */
export function similarity(a: string, b: string): number {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y)
    return 0
  if (x === y)
    return 1
  if (x.includes(y) || y.includes(x)) {
    const [short, long] = x.length < y.length ? [x, y] : [y, x]
    // 完全包含时按长度比例给分：短名是长名的一部分，越接近越可信
    return 0.6 + 0.4 * (short.length / long.length)
  }

  const grams = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++)
      set.add(s.slice(i, i + 2))
    if (s.length === 1)
      set.add(s)
    return set
  }
  const gx = grams(x)
  const gy = grams(y)
  let inter = 0
  for (const g of gx) {
    if (gy.has(g))
      inter++
  }
  return (2 * inter) / (gx.size + gy.size)
}

/** 项目路径里最后一段有时比全名更像日报里写的名字，两个都比一遍取高者。 */
function projectScore(reportName: string, project: GitLabProjectRef): number {
  const leaf = project.pathWithNamespace.split('/').pop() ?? project.pathWithNamespace
  return Math.max(
    similarity(reportName, project.pathWithNamespace),
    similarity(reportName, leaf),
    similarity(reportName, project.name),
  )
}

/**
 * 项目的匹配键与日报里写的名字/编码比较。
 *
 * 除了检查本身，项目面板的「引用次数」也走这里——那个数字的用途是暴露
 * 「配了匹配键却从没命中过」的项目，如果它自己另算一套（比如只做名称全等），
 * 配成「包含」的项目会一律显示未引用，等于把正确配置报成错误配置。
 */
export function projectMatches(project: Project, entry: { projectName: string, projectCode?: string }): boolean {
  // 编码优先：日报填了编码时它比名称精确得多，也最不容易撞车
  if (entry.projectCode && project.code) {
    if (normalize(entry.projectCode) === normalize(project.code))
      return true
  }

  const keywords = [project.name, ...project.aliases].filter(Boolean)
  const target = normalize(entry.projectName)

  for (const keyword of keywords) {
    const pattern = normalize(keyword)
    switch (project.matchMode) {
      case 'exact':
        if (target === pattern)
          return true
        break
      case 'contains':
        if (target.includes(pattern) || pattern.includes(target))
          return true
        break
      case 'regex':
        try {
          if (new RegExp(keyword, 'i').test(entry.projectName))
            return true
        }
        catch {
          // 正则写错时不能让整次检查挂掉，退化成不匹配，让它在界面上暴露出来
        }
        break
    }
  }
  return false
}

/**
 * 把项目实体转成它覆盖的 GitLab 仓库列表。
 *
 * 项目以日志中心为准，一个业务项目可能散在多个仓库里，也可能整组关联
 * （组在「解析关联仓库」时已经展开）。所以这里返回的是**列表**——
 * 检查时这些仓库的提交合并算作这个项目的产出。
 *
 * 优先用解析好的 `repos`；没有时退回旧模型的单仓库字段，保证升级不失效。
 */
export function toProjectRefs(project: Project): GitLabProjectRef[] {
  if (project.repos?.length) {
    return project.repos.map(r => ({
      id: r.id,
      pathWithNamespace: r.pathWithNamespace,
      name: r.name,
      webUrl: r.webUrl,
      // 老数据里没存过默认分支，回退到项目级的同名字段；都没有就不传，
      // 由 GitLab 按它自己的默认分支返回。
      // 用 || 而不是 ??：Rust 的 Option 字段序列化出来是 null，?? 拦不住 null
      defaultBranch: r.defaultBranch || project.defaultBranch || undefined,
    }))
  }

  if (project.gitlabProjectId != null || project.pathWithNamespace) {
    return [{
      id: project.gitlabProjectId ?? -1,
      pathWithNamespace: project.pathWithNamespace ?? project.name,
      name: project.name,
      webUrl: project.webUrl ?? '',
      defaultBranch: project.defaultBranch,
    }]
  }

  return []
}

export function resolveProject(
  entry: { projectName: string, projectCode?: string },
  projects: Project[],
  catalog: GitLabProjectRef[],
): ProjectResolution {
  const reportProjectName = entry.projectName

  /*
   * 只有「启用」且「关注」的项目参与匹配。
   *
   * 关注是用户圈定考核范围的方式：他明确表示不关心的项目，不该出现在结论里，
   * 否则分数会被一堆无关项目摊平，看不出真正在意的那几个项目做得怎么样。
   */
  const active = projects.filter(p => p.enabled && p.followed)

  for (const project of active) {
    if (!projectMatches(project, entry))
      continue

    // 项目在 GitLab 上已被删除/改名：这不是「人没提交代码」，必须说清区别
    if (project.syncStatus === 'missing') {
      return {
        reportProjectName,
        projects: [],
        strategy: 'missing',
        score: 1,
        candidates: [],
        note: `项目「${project.name}」在 GitLab 上已找不到（可能被删除或改名），本次无法核对。`
          + '到「项目」面板重新同步，或修改它关联的仓库。',
      }
    }

    const refs = toProjectRefs(project)
    if (refs.length) {
      return {
        reportProjectName,
        projects: refs,
        strategy: 'project',
        score: 1,
        candidates: refs.map(ref => ({ project: ref, score: 1 })),
      }
    }

    return {
      reportProjectName,
      projects: [],
      strategy: 'none',
      score: 0,
      candidates: [],
      note: `项目「${project.name}」还没有关联到任何仓库。到「项目」面板加上仓库或组，然后点「解析关联仓库」。`,
    }
  }

  /*
   * 命中了项目记录、但它没被关注。
   *
   * 要在这里拦下来并说清楚，而不是让它落到下面那句「没有对应的项目记录」——
   * 「我不检查它」和「我配错了」是两回事：前者用户自己知道原因，后者要他去补配置。
   * 也不能放它进模糊匹配，那样等于绕开关注把项目又查了一遍。
   */
  const ignored = projects.find(p => p.enabled && !p.followed && projectMatches(p, entry))
  if (ignored) {
    return {
      reportProjectName,
      projects: [],
      strategy: 'unfollowed',
      score: 0,
      candidates: [],
      note: `项目「${ignored.name}」没有关注，本次不检查它，这条工时也不计入符合度。`
        + '要纳入检查，到「项目」面板把它设为关注。',
    }
  }

  if (projects.length) {
    return {
      reportProjectName,
      projects: [],
      strategy: 'none',
      score: 0,
      candidates: [],
      note: `日报里的「${reportProjectName}」没有对应的项目记录。`
        + '到「项目」面板新建一个，或把它加进某个项目的别名里。',
    }
  }

  // 一个项目都没配时，退回按仓库路径的猜测，至少让流程能跑
  const exact = catalog.find(k => normalize(k.pathWithNamespace) === normalize(reportProjectName))
  if (exact) {
    return {
      reportProjectName,
      projects: [exact],
      strategy: 'path-exact',
      score: 1,
      candidates: [{ project: exact, score: 1 }],
    }
  }

  const scored: ProjectCandidate[] = catalog
    .map(project => ({ project, score: projectScore(reportProjectName, project) }))
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (best && best.score >= FUZZY_THRESHOLD) {
    return {
      reportProjectName,
      projects: [best.project],
      strategy: 'fuzzy',
      score: best.score,
      candidates: scored.slice(0, 5),
    }
  }

  return {
    reportProjectName,
    projects: [],
    strategy: 'none',
    score: best?.score ?? 0,
    candidates: scored.slice(0, 5).filter(c => c.score > 0.25),
  }
}

/* ------------------------------------------------------------------ *
 * 人员匹配
 * ------------------------------------------------------------------ */

export interface MemberIdentity {
  memberId: string
  memberName: string
  /**
   * 这个人在 Git 里用过的用户名，可能有多个。
   *
   * 多身份时**不能**把它当成 GitLab 的 author 过滤参数（那个只接受一个值），
   * 只能拉回时间窗内的提交再在客户端筛——见 commitBelongsTo。
   */
  gitlabUsernames: string[]
  /** 用于在客户端二次过滤 author_email */
  emails: string[]
  source: 'profile' | 'report' | 'none'
}

/**
 * 解析成员身份。
 *
 * 优先按日报系统 ID 认人（改名也不影响），其次按姓名兜底。
 * 命中的实体上如果没填邮箱，会与日报里带的邮箱合并——两边各有一半信息是常见情况。
 */
export function resolveMemberIdentity(
  member: MemberIdentityInput,
  profiles: MemberProfile[],
): MemberIdentity {
  const profile = profiles.find(p => p.reportMemberId && p.reportMemberId === member.id)
    ?? profiles.find(p => p.name === member.name)

  if (profile) {
    return {
      memberId: member.id,
      memberName: member.name,
      gitlabUsernames: dedupeUsernames([
        ...profile.gitlabUsernames,
        ...(member.gitlabUsernames ?? []),
      ]),
      emails: dedupe(
        [...profile.emails, ...(member.emails ?? [])].map(e => e.trim().toLowerCase()).filter(Boolean),
      ),
      source: 'profile',
    }
  }

  return {
    memberId: member.id,
    memberName: member.name,
    gitlabUsernames: dedupeUsernames(member.gitlabUsernames ?? []),
    emails: dedupe((member.emails ?? []).map(e => e.trim().toLowerCase()).filter(Boolean)),
    source: member.gitlabUsernames?.length || member.emails?.length ? 'report' : 'none',
  }
}

/**
 * 二次确认提交确实属于该成员。
 *
 * 这里必须遍历所有身份：一个人换过账号、用中文名提交都很常见，
 * 只认第一个用户名会漏提交——而漏提交会被判成「日报写了但代码没有」。
 */
export function commitBelongsTo(commit: GitCommit, identity: MemberIdentity): boolean {
  if (!identity.gitlabUsernames.length && !identity.emails.length)
    return true // 无身份信息时不做过滤，交给人工判断

  const email = commit.authorEmail.trim().toLowerCase()
  if (identity.emails.includes(email))
    return true

  const authorName = commit.authorName.trim().toLowerCase()
  for (const username of identity.gitlabUsernames) {
    const u = username.toLowerCase()
    if (email.startsWith(`${u}@`))
      return true
    if (authorName === u)
      return true
  }
  return false
}

/** 用户名去重（忽略大小写），保留第一次出现的写法 */
function dedupeUsernames(list: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const name = raw.trim()
    if (!name)
      continue
    const key = name.toLowerCase()
    if (seen.has(key))
      continue
    seen.add(key)
    out.push(name)
  }
  return out
}

function dedupe(arr: string[]) {
  return [...new Set(arr)]
}
