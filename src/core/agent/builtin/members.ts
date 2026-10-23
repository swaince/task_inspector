import type { MemberProfile, Project } from '@/core/domain/types'
import type { BuiltinTool, BuiltinToolContext, ToolPreparation } from '../types'
import { createMemberDraft, useMemberStore } from '@/core/store/members'
import { useProjectStore } from '@/core/store/projects'

/**
 * 人员查询与维护。
 *
 * `members.ensure` 采用幂等语义：按日报 ID → 工号 → 唯一姓名匹配，
 * 只补空字段、不覆盖已有值、不删除、不合并。真正的写入发生在用户确认之后。
 */

const MAX_LIST = 50

function normalize(value: string | undefined) {
  return (value ?? '').trim().toLowerCase()
}

function uniqueList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，;；\s]+/)
      : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string')
      continue
    const text = item.trim()
    if (text && !out.some(existing => existing.toLowerCase() === text.toLowerCase()))
      out.push(text)
  }
  return out
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalBool(value: unknown) {
  return typeof value === 'boolean' ? value : undefined
}

function memberOwnsEmail(member: MemberProfile, email: string) {
  return member.emails.some(item => item.trim().toLowerCase() === email.toLowerCase())
}

function memberOwnsUsername(member: MemberProfile, username: string) {
  return member.gitlabUsernames.some(item => item.trim().toLowerCase() === username.toLowerCase())
}

interface EnsureInput {
  name: string
  emails: string[]
  usernames: string[]
  reportMemberId?: string
  employeeNo?: string
  team?: string
  role?: string
  followed?: boolean
  enabled?: boolean
}

function parseEnsureInput(args: Record<string, unknown>): EnsureInput {
  const name = optionalText(args.name)
  if (!name)
    throw new Error('缺少成员姓名')
  return {
    name,
    emails: uniqueList(args.emails),
    usernames: uniqueList(args.gitlabUsernames),
    reportMemberId: optionalText(args.reportMemberId),
    employeeNo: optionalText(args.employeeNo),
    team: optionalText(args.team),
    role: optionalText(args.role),
    followed: optionalBool(args.followed),
    enabled: optionalBool(args.enabled),
  }
}

function formatMember(member: MemberProfile) {
  const parts = [
    member.name,
    member.reportMemberId ? `日报ID ${member.reportMemberId}` : '',
    member.emails.length ? `邮箱 ${member.emails.join(' / ')}` : '',
    member.gitlabUsernames.length ? `GitLab ${member.gitlabUsernames.join(' / ')}` : '',
    member.followed ? '关注' : '未关注',
    member.enabled ? '启用' : '停用',
  ].filter(Boolean)
  return `- ${parts.join('；')}`
}

async function findProjectForTool(ctx: BuiltinToolContext, hint: unknown) {
  const store = useProjectStore()
  if (!store.loaded)
    await store.load()

  const keyword = optionalText(hint) ?? (ctx.projectId !== '__app__' ? ctx.projectId : undefined)
  if (!keyword)
    throw new Error('需要指定项目：在项目对话里提问，或给出项目名称/编码')

  const found = store.items.find(project =>
    project.id === keyword
    || normalize(project.code) === normalize(keyword)
    || normalize(project.name) === normalize(keyword)
    || project.aliases.some(alias => normalize(alias) === normalize(keyword)),
  )
  if (!found) {
    const fuzzy = store.items.filter(project =>
      normalize(project.name).includes(normalize(keyword))
      || project.aliases.some(alias => normalize(alias).includes(normalize(keyword))),
    )
    if (fuzzy.length === 1)
      return fuzzy[0]
    throw new Error(`找不到项目「${keyword}」；请给出更完整的项目名称或编码`)
  }
  return found
}

interface AuthorRow {
  email: string
  hasEmail: boolean
  names: Set<string>
  repos: Set<string>
  commits: number
  member?: MemberProfile
  conflict?: string
}

function matchMemberByAuthor(
  members: MemberProfile[],
  email: string,
  names: string[],
): { member?: MemberProfile, conflict?: string } {
  const byEmail = members.find(member =>
    member.emails.some(item => normalize(item) === normalize(email)),
  )
  if (byEmail)
    return { member: byEmail }

  const normalizedNames = names.map(normalize).filter(Boolean)
  const matches = members.filter(member =>
    normalizedNames.includes(normalize(member.name))
    || member.gitlabUsernames.some(username => normalizedNames.includes(normalize(username))),
  )
  if (matches.length > 1)
    return { conflict: `提交者姓名匹配到多个成员：${matches.map(item => item.name).join('、')}` }
  return { member: matches[0] }
}

interface AuthorScan {
  project: Project
  repos: number
  commits: number
  days: number
  rows: AuthorRow[]
  failures: string[]
}

/** 扫描一个项目全部已解析仓库的提交作者，并按邮箱/姓名匹配现有人员 */
async function scanAuthorsForProject(
  ctx: BuiltinToolContext,
  projectHint: unknown,
  daysInput: unknown,
): Promise<AuthorScan> {
  if (!ctx.gitlab)
    throw new Error('GitLab 未配置，无法读取提交作者；请先在「设置 → GitLab」填写地址和 Token')

  const project = await findProjectForTool(ctx, projectHint)
  const repos = [...new Map(
    project.repos
      .filter(repo => repo.id > 0 && repo.pathWithNamespace)
      .map(repo => [repo.id, repo]),
  ).values()]
  if (!repos.length)
    throw new Error(`项目「${project.name}」还没有解析出 GitLab 仓库；先关联仓库/组并点「解析关联仓库」`)

  const days = Math.min(365, Math.max(7, Math.round(Number(daysInput) || 90)))
  const until = new Date()
  const since = new Date(until.getTime() - days * 86_400_000)
  const authors = new Map<string, AuthorRow>()
  const failures: string[] = []
  let commits = 0

  for (const repo of repos) {
    try {
      const list = await ctx.gitlab.listCommits(
        {
          id: repo.id,
          pathWithNamespace: repo.pathWithNamespace,
          name: repo.name,
          webUrl: repo.webUrl,
          defaultBranch: repo.defaultBranch,
        },
        {
          since: since.toISOString(),
          until: until.toISOString(),
          perPage: 100,
          maxCommits: 300,
          fetchFileChanges: false,
          refName: repo.defaultBranch,
          signal: ctx.signal,
        },
      )
      commits += list.length
      for (const commit of list) {
        const email = commit.authorEmail.trim()
        const name = commit.authorName.trim()
        const key = normalize(email) || `name:${normalize(name)}`
        if (!key)
          continue
        let row = authors.get(key)
        if (!row) {
          row = { email: email || '—', hasEmail: Boolean(email), names: new Set(), repos: new Set(), commits: 0 }
          authors.set(key, row)
        }
        if (email)
          row.hasEmail = true
        if (name)
          row.names.add(name)
        row.repos.add(repo.pathWithNamespace)
        row.commits += 1
      }
    }
    catch (err) {
      failures.push(`${repo.pathWithNamespace}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const memberStore = useMemberStore()
  if (!memberStore.loaded)
    await memberStore.load()
  for (const row of authors.values()) {
    if (!row.hasEmail)
      continue
    const match = matchMemberByAuthor(memberStore.items, row.email, [...row.names])
    row.member = match.member
    row.conflict = match.conflict
  }

  return {
    project,
    repos: repos.length,
    commits,
    days,
    rows: [...authors.values()].sort((a, b) => b.commits - a.commits),
    failures,
  }
}

export function createMembersTool(): BuiltinTool[] {
  const listTool: BuiltinTool = {
    descriptor: {
      id: 'members.list',
      source: 'builtin',
      serverId: 'builtin-members',
      serverName: 'builtin_members',
      name: 'list',
      qualifiedName: 'builtin_members__list',
      description: '查询本应用的人员及其日报 ID、邮箱、GitLab 用户名、关注/启用状态。回答人员相关问题时先用它确认现状。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '按姓名、日报 ID、邮箱或 GitLab 用户名过滤' },
          followed: { type: 'boolean', description: '只看关注/未关注' },
          enabled: { type: 'boolean', description: '只看启用/停用' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST },
        },
      },
      readOnly: true,
    },
    async run(args) {
      const store = useMemberStore()
      if (!store.loaded)
        await store.load()

      const keyword = normalize(optionalText(args.keyword))
      const followed = optionalBool(args.followed)
      const enabled = optionalBool(args.enabled)
      const limit = Math.min(MAX_LIST, Math.max(1, Number(args.limit) || 20))

      const list = store.items
        .filter((member) => {
          if (followed !== undefined && member.followed !== followed)
            return false
          if (enabled !== undefined && member.enabled !== enabled)
            return false
          if (!keyword)
            return true
          return normalize(member.name).includes(keyword)
            || normalize(member.reportMemberId).includes(keyword)
            || normalize(member.employeeNo).includes(keyword)
            || member.emails.some(email => normalize(email).includes(keyword))
            || member.gitlabUsernames.some(name => normalize(name).includes(keyword))
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .slice(0, limit)

      if (!list.length)
        return '没有找到匹配的人员。'
      return `人员（${list.length} 条）：\n${list.map(formatMember).join('\n')}`
    },
  }

  const scanAuthorsTool: BuiltinTool = {
    descriptor: {
      id: 'members.scanProjectAuthors',
      source: 'builtin',
      serverId: 'builtin-members',
      serverName: 'builtin_members',
      name: 'scanProjectAuthors',
      qualifiedName: 'builtin_members__scan_project_authors',
      description: '汇总一个项目所有 GitLab 仓库的提交作者和邮箱，并和现有人员匹配，给出绑定建议。回答「这个项目有几个开发、账号邮箱是什么、把邮箱绑到人」之前先用它；它会查全部关联仓库，不要只查一个仓库。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名称、编码或 id；在项目对话里可以省略' },
          days: { type: 'integer', minimum: 7, maximum: 365, description: '回看天数，默认 90' },
        },
      },
      readOnly: true,
    },
    async run(args, ctx) {
      const scan = await scanAuthorsForProject(ctx, args.project, args.days)
      const list = scan.rows.slice(0, 80)

      const lines = [
        `项目：${scan.project.name}${scan.project.code ? `（${scan.project.code}）` : ''}`,
        `范围：最近 ${scan.days} 天 · ${scan.repos} 个仓库 · ${scan.commits} 条提交 · 只统计默认分支`,
        '',
        '| 邮箱 | 提交者 | 提交数 | 仓库数 | 现有成员 | 状态 |',
        '| --- | --- | --- | --- | --- | --- |',
      ]
      for (const row of list) {
        const status = !row.hasEmail
          ? (row.names.size ? '提交没有邮箱，无法自动绑定' : '缺少作者信息')
          : row.conflict
            ? row.conflict
            : row.member
              ? row.member.emails.some(email => normalize(email) === normalize(row.email))
                ? '已绑定'
                : `建议绑定 → ${row.member.name}`
              : '未匹配到成员'
        lines.push(`| ${row.email} | ${[...row.names].join(' / ') || '—'} | ${row.commits} | ${row.repos.size} | ${row.member?.name ?? '—'} | ${status} |`)
      }
      if (scan.rows.length > list.length)
        lines.push('', `还有 ${scan.rows.length - list.length} 个提交身份未列出，请缩小时间范围。`)
      if (scan.failures.length)
        lines.push('', `未读取成功的仓库：\n${scan.failures.map(item => `- ${item}`).join('\n')}`)
      lines.push('', '说明：同一邮箱下的多个姓名视为同一提交身份；仅凭姓名匹配的绑定建议需要用户确认。')

      return lines.join('\n')
    },
  }

  const ensureTool: BuiltinTool = {
    descriptor: {
      id: 'members.ensure',
      source: 'builtin',
      serverId: 'builtin-members',
      serverName: 'builtin_members',
      name: 'ensure',
      qualifiedName: 'builtin_members__ensure',
      description: '新建成员，或给已有成员补齐邮箱/GitLab 用户名等字段。按日报 ID → 工号 → 唯一姓名匹配，只补空字段，已存在且完整时不做修改。执行前需要用户确认。不删除成员、不合并账号。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '成员姓名' },
          emails: {
            type: 'array',
            items: { type: 'string' },
            description: '要关联的邮箱；可以传数组或逗号分隔的字符串',
          },
          gitlabUsernames: {
            type: 'array',
            items: { type: 'string' },
            description: 'GitLab 用户名；可以传数组或逗号分隔的字符串',
          },
          reportMemberId: { type: 'string', description: '日报系统成员 ID' },
          employeeNo: { type: 'string', description: '工号' },
          team: { type: 'string' },
          role: { type: 'string' },
          followed: { type: 'boolean', description: '是否关注' },
          enabled: { type: 'boolean', description: '是否启用' },
        },
        required: ['name'],
      },
      readOnly: false,
    },

    async prepare(args): Promise<ToolPreparation> {
      const input = parseEnsureInput(args)
      const store = useMemberStore()
      if (!store.loaded)
        await store.load()

      let target: MemberProfile | undefined
      if (input.reportMemberId) {
        target = store.items.find(member => member.reportMemberId === input.reportMemberId)
      }
      if (!target && input.employeeNo) {
        const byEmployee = store.items.filter(member => normalize(member.employeeNo) === normalize(input.employeeNo))
        if (byEmployee.length > 1)
          throw new Error(`工号 ${input.employeeNo} 对应多个成员，无法自动匹配`)
        target = byEmployee[0]
      }
      if (!target) {
        const sameName = store.items.filter(member => normalize(member.name) === normalize(input.name))
        if (sameName.length > 1)
          throw new Error(`存在 ${sameName.length} 个同名成员「${input.name}」，请补充日报 ID 或工号后再试`)
        target = sameName[0]
      }

      // 日报 ID/工号指向 A，但姓名指向 B：不自动合并，交给用户确认
      if (target && (input.reportMemberId || input.employeeNo)) {
        const otherWithName = store.items.find(member =>
          member.id !== target!.id && normalize(member.name) === normalize(input.name),
        )
        if (otherWithName) {
          throw new Error(
            `日报 ID/工号对应「${target.name}」，但姓名「${input.name}」对应另一个成员；为避免把账号挂错人，未做修改`,
          )
        }
      }

      // 同一邮箱/用户名不能属于两个成员：这里只报告冲突，不自动迁移
      for (const email of input.emails) {
        const owner = store.items.find(member => memberOwnsEmail(member, email) && member.id !== target?.id)
        if (owner)
          throw new Error(`邮箱 ${email} 已属于成员「${owner.name}」，未做修改`)
      }
      for (const username of input.usernames) {
        const owner = store.items.find(member => memberOwnsUsername(member, username) && member.id !== target?.id)
        if (owner)
          throw new Error(`GitLab 用户名 ${username} 已属于成员「${owner.name}」，未做修改`)
      }

      if (!target) {
        const draft = createMemberDraft(input.name)
        const next: MemberProfile = {
          ...draft,
          emails: input.emails,
          gitlabUsernames: input.usernames,
          reportMemberId: input.reportMemberId,
          employeeNo: input.employeeNo,
          team: input.team,
          role: input.role,
          followed: input.followed ?? true,
          enabled: input.enabled ?? true,
        }

        const summary = ['将新建成员', ...input.emails.map(email => `关联邮箱 ${email}`), ...input.usernames.map(name => `关联 GitLab 用户名 ${name}`)]
        return {
          kind: 'action',
          action: {
            approval: {
              id: crypto.randomUUID(),
              kind: 'member',
              title: '模型请求新建成员',
              summary,
              details: [
                { label: '姓名', value: next.name },
                ...(input.reportMemberId ? [{ label: '日报 ID', value: input.reportMemberId, mono: true }] : []),
                ...(input.team ? [{ label: '团队', value: input.team }] : []),
                { label: '关注/启用', value: `${next.followed ? '关注' : '未关注'} / ${next.enabled ? '启用' : '停用'}` },
              ],
              risk: { level: 'normal', matches: [] },
            },
            apply: async () => {
              await store.save(next)
              return {
                text: `已新建成员「${next.name}」${input.emails.length ? `，邮箱 ${input.emails.join(' / ')}` : ''}${input.usernames.length ? `，GitLab ${input.usernames.join(' / ')}` : ''}。`,
              }
            },
          },
        }
      }

      const changes: string[] = []
      const next: MemberProfile = {
        ...target,
        emails: [...target.emails],
        gitlabUsernames: [...target.gitlabUsernames],
      }

      if (input.reportMemberId && target.reportMemberId && target.reportMemberId !== input.reportMemberId)
        throw new Error(`成员「${target.name}」已有不同的日报 ID（${target.reportMemberId}），未做修改`)
      if (input.reportMemberId && !target.reportMemberId) {
        next.reportMemberId = input.reportMemberId
        changes.push(`补充日报 ID ${input.reportMemberId}`)
      }
      if (input.employeeNo && !target.employeeNo) {
        next.employeeNo = input.employeeNo
        changes.push(`补充工号 ${input.employeeNo}`)
      }
      if (input.team && !target.team) {
        next.team = input.team
        changes.push(`补充团队 ${input.team}`)
      }
      if (input.role && !target.role) {
        next.role = input.role
        changes.push(`补充角色 ${input.role}`)
      }
      for (const email of input.emails) {
        if (!memberOwnsEmail(next, email)) {
          next.emails.push(email)
          changes.push(`新增邮箱 ${email}`)
        }
      }
      for (const username of input.usernames) {
        if (!memberOwnsUsername(next, username)) {
          next.gitlabUsernames.push(username)
          changes.push(`新增 GitLab 用户名 ${username}`)
        }
      }
      if (input.followed !== undefined && input.followed !== target.followed) {
        next.followed = input.followed
        changes.push(input.followed ? '设为关注' : '取消关注')
      }
      if (input.enabled !== undefined && input.enabled !== target.enabled) {
        next.enabled = input.enabled
        changes.push(input.enabled ? '设为启用' : '设为停用')
      }

      if (!changes.length) {
        return {
          kind: 'result',
          result: `成员「${target.name}」已存在，且提供的字段都已配置，无需修改。`,
        }
      }

      return {
        kind: 'action',
        action: {
          approval: {
            id: crypto.randomUUID(),
            kind: 'member',
            title: '模型请求更新成员',
            summary: changes,
            details: [
              { label: '成员', value: target.name },
              { label: '当前邮箱', value: target.emails.join(' / ') || '（无）', mono: true },
              { label: '当前 GitLab', value: target.gitlabUsernames.join(' / ') || '（无）', mono: true },
            ],
            risk: { level: 'normal', matches: [] },
          },
          apply: async () => {
            await store.save(next)
            return { text: `已更新成员「${next.name}」：${changes.join('；')}。` }
          },
        },
      }
    },
  }

  const ensureManyTool: BuiltinTool = {
    descriptor: {
      id: 'members.ensureMany',
      source: 'builtin',
      serverId: 'builtin-members',
      serverName: 'builtin_members',
      name: 'ensureMany',
      qualifiedName: 'builtin_members__ensure_many',
      description: '一次为多个成员补齐邮箱/GitLab 用户名。每一项按 ensure 规则匹配，只补空字段；任何一项冲突则整批不写。执行前只弹一次确认卡片。适合「把已确认的邮箱绑定到相关人员」这类批量配置。',
      inputSchema: {
        type: 'object',
        properties: {
          members: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '成员姓名' },
                emails: { type: 'array', items: { type: 'string' } },
                gitlabUsernames: { type: 'array', items: { type: 'string' } },
                reportMemberId: { type: 'string' },
                employeeNo: { type: 'string' },
                team: { type: 'string' },
                role: { type: 'string' },
                followed: { type: 'boolean' },
                enabled: { type: 'boolean' },
              },
              required: ['name'],
            },
          },
        },
        required: ['members'],
      },
      readOnly: false,
    },

    async prepare(args, ctx): Promise<ToolPreparation> {
      const raw = Array.isArray(args.members) ? args.members : []
      if (!raw.length)
        throw new Error('members 不能为空')
      if (raw.length > 20)
        throw new Error('一次最多处理 20 个成员')

      const actions: { name: string, action: Extract<ToolPreparation, { kind: 'action' }>['action'] }[] = []
      const results: string[] = []

      for (const item of raw) {
        const record = item && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown>
          : {}
        const name = optionalText(record.name) || '未命名成员'
        const preparation = await ensureTool.prepare!(record, ctx)
        if (preparation.kind === 'action')
          actions.push({ name, action: preparation.action })
        else
          results.push(preparation.result)
      }

      if (!actions.length) {
        return {
          kind: 'result',
          result: results.join('\n') || '没有需要修改的成员。',
        }
      }

      const summary = actions.flatMap(({ name, action }) =>
        action.approval.summary.map(line => `${name}：${line}`),
      )
      const details = actions.flatMap(({ name, action }) =>
        action.approval.details?.length
          ? action.approval.details
          : [{ label: '成员', value: name }],
      )

      return {
        kind: 'action',
        action: {
          approval: {
            id: crypto.randomUUID(),
            kind: 'member',
            title: '模型请求批量更新成员',
            summary,
            details,
            risk: { level: 'normal', matches: [] },
          },
          apply: async () => {
            const texts: string[] = []
            for (const { action } of actions)
              texts.push((await action.apply()).text)
            texts.push(...results)
            return { text: texts.join('\n') }
          },
        },
      }
    },
  }

  const bindAuthorsTool: BuiltinTool = {
    descriptor: {
      id: 'members.bindProjectAuthors',
      source: 'builtin',
      serverId: 'builtin-members',
      serverName: 'builtin_members',
      name: 'bindProjectAuthors',
      qualifiedName: 'builtin_members__bind_project_authors',
      description: '扫描项目全部 GitLab 仓库的提交作者，按姓名/邮箱匹配现有成员，并为匹配上的成员补齐邮箱。扫描和绑定准备一次完成，执行前只弹一张确认卡片。用户确认「采纳/绑定吧/继续」时直接用它，不要只查询后声称等待确认。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名称、编码或 id；在项目对话里可以省略' },
          days: { type: 'integer', minimum: 7, maximum: 365, description: '回看天数，默认 90' },
        },
      },
      readOnly: false,
    },

    async prepare(args, ctx): Promise<ToolPreparation> {
      const scan = await scanAuthorsForProject(ctx, args.project, args.days)
      const byMember = new Map<string, { member: MemberProfile, emails: Set<string> }>()

      for (const row of scan.rows) {
        if (!row.hasEmail || !row.member)
          continue
        if (row.member.emails.some(email => normalize(email) === normalize(row.email)))
          continue
        const entry = byMember.get(row.member.id) ?? { member: row.member, emails: new Set<string>() }
        entry.emails.add(row.email)
        byMember.set(row.member.id, entry)
      }

      if (!byMember.size) {
        const bound = scan.rows.filter(row => row.member && row.hasEmail
          && row.member.emails.some(email => normalize(email) === normalize(row.email))).length
        const unmatched = scan.rows.filter(row => row.hasEmail && !row.member).length
        return {
          kind: 'result',
          result: `扫描了 ${scan.repos} 个仓库、${scan.commits} 条提交；已有 ${bound} 个邮箱绑定到成员，${unmatched} 个提交身份未匹配到成员，没有需要补绑的邮箱。`,
        }
      }

      const actions: { name: string, action: Extract<ToolPreparation, { kind: 'action' }>['action'] }[] = []
      const noops: string[] = []
      for (const { member, emails } of byMember.values()) {
        const preparation = await ensureTool.prepare!(
          { name: member.name, emails: [...emails] },
          ctx,
        )
        if (preparation.kind === 'action')
          actions.push({ name: member.name, action: preparation.action })
        else
          noops.push(preparation.result)
      }

      if (!actions.length) {
        return {
          kind: 'result',
          result: noops.join('\n') || '匹配到的邮箱都已经在成员档案里，无需修改。',
        }
      }

      const summary = actions.flatMap(({ name, action }) =>
        action.approval.summary.map(line => `${name}：${line}`),
      )
      const details = actions.flatMap(({ name, action }) =>
        action.approval.details?.length
          ? action.approval.details
          : [{ label: '成员', value: name }],
      )

      return {
        kind: 'action',
        action: {
          approval: {
            id: crypto.randomUUID(),
            kind: 'member',
            title: '模型请求绑定项目提交邮箱',
            summary,
            details,
            risk: { level: 'normal', matches: [] },
          },
          apply: async () => {
            const texts: string[] = []
            for (const { action } of actions)
              texts.push((await action.apply()).text)
            texts.push(...noops)
            texts.push(`扫描范围：最近 ${scan.days} 天 · ${scan.repos} 个仓库 · ${scan.commits} 条提交。`)
            return { text: texts.join('\n') }
          },
        },
      }
    },
  }

  return [listTool, scanAuthorsTool, ensureTool, ensureManyTool, bindAuthorsTool]
}
