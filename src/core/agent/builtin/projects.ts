import type { Project, ProjectLink } from '@/core/domain/types'
import type { BuiltinTool, BuiltinToolContext, ToolPreparation } from '../types'
import { AdapterError, GitLabClient } from '@/core/adapters/gitlab'
import { resolveProjectLinks } from '@/core/adapters/projectLinks'
import { createProjectDraft, useProjectStore } from '@/core/store/projects'

/**
 * 项目与 GitLab 关联的查询/维护。
 *
 * `projects.ensure` 只维护「本应用里的项目关联」，不会在 GitLab 侧创建组、仓库或用户。
 * GitLab 能查到就按真实路径写入；查不到就报错、不写库。
 */

const MAX_LIST = 50

function normalize(value: string | undefined) {
  return (value ?? '').trim().toLowerCase()
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalBool(value: unknown) {
  return typeof value === 'boolean' ? value : undefined
}

function uniqueStrings(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，;；]+/)
      : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string')
      continue
    const text = item.trim()
    if (text && !out.some(existing => normalize(existing) === normalize(text)))
      out.push(text)
  }
  return out
}

function isNotFound(error: unknown) {
  return error instanceof AdapterError && error.status === 404
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+$/, '')
}

function parseGitLabInput(raw: string, baseUrl: string) {
  let text = raw.trim()
  let kindHint: 'repo' | 'group' | undefined

  const ssh = text.match(/^[\w.-]+@[\w.-]+:(.+)$/)
  if (ssh) {
    text = ssh[1]
    kindHint = 'repo'
  }
  else if (/^https?:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    }
    catch {
      throw new Error(`无法解析 GitLab 地址：${raw}`)
    }
    if (baseUrl.trim()) {
      try {
        const base = new URL(baseUrl.trim())
        if (url.origin !== base.origin)
          throw new Error(`GitLab 地址和设置里的实例不一致：${url.origin}`)
        const basePath = base.pathname.replace(/\/+$/, '')
        if (basePath && basePath !== '/' && url.pathname.startsWith(basePath))
          text = url.pathname.slice(basePath.length)
        else
          text = url.pathname
      }
      catch (err) {
        if (err instanceof Error && err.message.startsWith('GitLab 地址'))
          throw err
        throw new Error(`设置里的 GitLab 地址无法解析：${baseUrl}`)
      }
    }
    else {
      text = url.pathname
    }
  }

  text = normalizePath(decodeURIComponent(text))
  if (text.toLowerCase().endsWith('.git')) {
    text = text.slice(0, -4)
    kindHint = 'repo'
  }
  if (!text)
    throw new Error('GitLab 路径为空')

  return { path: text, kindHint }
}

interface VerifiedLink {
  kind: 'repo' | 'group'
  path: string
  label: string
  verified: boolean
}

async function verifyLink(
  gitlab: GitLabClient | null,
  path: string,
  kind: 'repo' | 'group' | undefined,
  kindHint: 'repo' | 'group' | undefined,
): Promise<VerifiedLink> {
  const wanted = kind ?? kindHint

  if (!gitlab) {
    const fallback = wanted ?? 'group'
    return {
      kind: fallback,
      path,
      label: `${fallback === 'group' ? '组' : '仓库'} ${path}`,
      verified: false,
    }
  }

  if (wanted === 'repo') {
    try {
      const project = await gitlab.getProject(path)
      return {
        kind: 'repo',
        path: project.pathWithNamespace,
        label: `仓库 ${project.pathWithNamespace}`,
        verified: true,
      }
    }
    catch (err) {
      if (isNotFound(err))
        throw new Error(`GitLab 中未找到仓库「${path}」（可能是路径错误或没有访问权限）`)
      throw err
    }
  }
  if (wanted === 'group') {
    try {
      const group = await gitlab.getGroup(path)
      return {
        kind: 'group',
        path: group.fullPath,
        label: `组 ${group.fullPath}`,
        verified: true,
      }
    }
    catch (err) {
      if (isNotFound(err))
        throw new Error(`GitLab 中未找到组「${path}」（可能是路径错误或没有访问权限）`)
      throw err
    }
  }

  try {
    const project = await gitlab.getProject(path)
    return {
      kind: 'repo',
      path: project.pathWithNamespace,
      label: `仓库 ${project.pathWithNamespace}`,
      verified: true,
    }
  }
  catch (err) {
    if (!isNotFound(err))
      throw err
  }

  try {
    const group = await gitlab.getGroup(path)
    return {
      kind: 'group',
      path: group.fullPath,
      label: `组 ${group.fullPath}`,
      verified: true,
    }
  }
  catch (err) {
    if (isNotFound(err))
      throw new Error(`GitLab 中未找到「${path}」对应的仓库或组（可能是路径错误或没有访问权限）`)
    throw err
  }
}

function sameLink(a: ProjectLink, b: ProjectLink) {
  return a.kind === b.kind && normalize(a.path) === normalize(b.path)
}

function formatProject(project: Project) {
  const links = project.links.length
    ? project.links.map(link => `${link.kind === 'group' ? '组' : '仓库'} ${link.path}`).join('、')
    : '未关联'
  const parts = [
    project.name,
    project.code ? `编码 ${project.code}` : '',
    links,
    project.repos.length ? `${project.repos.length} 个仓库` : '',
    project.followed ? '关注' : '未关注',
    project.enabled ? '启用' : '停用',
    project.syncStatus === 'error' ? '解析有错误' : '',
  ].filter(Boolean)
  return `- ${parts.join('；')}`
}

export function createProjectsTool(): BuiltinTool[] {
  const listTool: BuiltinTool = {
    descriptor: {
      id: 'projects.list',
      source: 'builtin',
      serverId: 'builtin-projects',
      serverName: 'builtin_projects',
      name: 'list',
      qualifiedName: 'builtin_projects__list',
      description: '查询本应用的项目、别名、GitLab 关联、已解析仓库和关注/启用状态。回答项目或仓库关联问题前先用它确认现状。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '按项目名、编码、别名或 GitLab 路径过滤' },
          followed: { type: 'boolean' },
          enabled: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST },
        },
      },
      readOnly: true,
    },
    async run(args) {
      const store = useProjectStore()
      if (!store.loaded)
        await store.load()

      const keyword = normalize(optionalText(args.keyword))
      const followed = optionalBool(args.followed)
      const enabled = optionalBool(args.enabled)
      const limit = Math.min(MAX_LIST, Math.max(1, Number(args.limit) || 20))

      const list = store.items
        .filter((project) => {
          if (followed !== undefined && project.followed !== followed)
            return false
          if (enabled !== undefined && project.enabled !== enabled)
            return false
          if (!keyword)
            return true
          return normalize(project.name).includes(keyword)
            || normalize(project.code).includes(keyword)
            || normalize(project.logProjectId).includes(keyword)
            || project.aliases.some(alias => normalize(alias).includes(keyword))
            || project.links.some(link => normalize(link.path).includes(keyword))
            || project.repos.some(repo => normalize(repo.pathWithNamespace).includes(keyword))
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .slice(0, limit)

      if (!list.length)
        return '没有找到匹配的项目。'
      return `项目（${list.length} 条）：\n${list.map(formatProject).join('\n')}`
    },
  }

  const ensureTool: BuiltinTool = {
    descriptor: {
      id: 'projects.ensure',
      source: 'builtin',
      serverId: 'builtin-projects',
      serverName: 'builtin_projects',
      name: 'ensure',
      qualifiedName: 'builtin_projects__ensure',
      description: '新建项目，或给已有项目补充 GitLab 仓库/组关联。先按编码 → 名称 → 别名匹配；GitLab 关联会先校验存在性，已存在则忽略，查不到则不写库。执行前需要用户确认。不会在 GitLab 侧创建组/仓库，也不删除项目。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '项目名称；新建时必填' },
          code: { type: 'string', description: '日报系统里的项目编码' },
          gitlab: { type: 'string', description: '完整 GitLab URL、group/subgroup 或 group/repo' },
          kind: {
            type: 'string',
            enum: ['repo', 'group'],
            description: '关联类型；不给时先按仓库查、再按组查',
          },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: '项目别名，可传数组或逗号分隔字符串',
          },
          followed: { type: 'boolean' },
          enabled: { type: 'boolean' },
        },
      },
      readOnly: false,
    },

    async prepare(args, ctx: BuiltinToolContext): Promise<ToolPreparation> {
      const name = optionalText(args.name)
      const code = optionalText(args.code)
      const rawGitlab = optionalText(args.gitlab)
      const kind = args.kind === 'repo' || args.kind === 'group' ? args.kind : undefined
      const aliases = uniqueStrings(args.aliases)
      const followed = optionalBool(args.followed)
      const enabled = optionalBool(args.enabled)

      if (!name && !code && !rawGitlab)
        throw new Error('至少提供项目名称、编码或 GitLab 地址之一')

      const store = useProjectStore()
      if (!store.loaded)
        await store.load()

      let target: Project | undefined
      if (code) {
        const byCode = store.items.filter(project => normalize(project.code) === normalize(code))
        if (byCode.length > 1)
          throw new Error(`编码 ${code} 对应多个项目，无法自动匹配`)
        target = byCode[0]
      }
      if (!target && name) {
        const matches = store.items.filter(project =>
          normalize(project.name) === normalize(name)
          || project.aliases.some(alias => normalize(alias) === normalize(name)),
        )
        if (matches.length > 1)
          throw new Error(`存在 ${matches.length} 个同名/同别名的项目，请补充编码后再试`)
        target = matches[0]
      }
      if (!target && !name && !rawGitlab)
        throw new Error('没有找到现有项目，且没有提供新项目名称')

      // 编码和名称指向不同项目：不自动合并，避免把关联挂错
      if (target && code && name) {
        const other = store.items.find(project =>
          project.id !== target!.id
          && (normalize(project.name) === normalize(name)
            || project.aliases.some(alias => normalize(alias) === normalize(name))),
        )
        if (other) {
          throw new Error(
            `编码 ${code} 对应「${target.name}」，但名称「${name}」对应另一个项目；为避免挂错关联，未做修改`,
          )
        }
      }

      let parsedPath = ''
      let parsedHint: 'repo' | 'group' | undefined
      if (rawGitlab) {
        const parsed = parseGitLabInput(rawGitlab, ctx.settings.gitlab.baseUrl)
        parsedPath = parsed.path
        parsedHint = parsed.kindHint
      }

      let link: VerifiedLink | null = null
      if (parsedPath) {
        try {
          link = await verifyLink(ctx.gitlab, parsedPath, kind, parsedHint)
        }
        catch (err) {
          throw new Error(errorMessage(err))
        }
      }

      const summary: string[] = []
      const changes: string[] = []
      let next: Project

      if (!target) {
        const fallbackName = name
          ?? (parsedPath ? parsedPath.split('/').pop() : undefined)
          ?? code
          ?? '未命名项目'
        next = createProjectDraft(fallbackName)
        if (code)
          next.code = code
        if (aliases.length)
          next.aliases = aliases
        if (followed !== undefined)
          next.followed = followed
        if (enabled !== undefined)
          next.enabled = enabled
        summary.push(`将新建项目「${next.name}」`)
        if (code)
          summary.push(`编码 ${code}`)
        if (aliases.length)
          summary.push(`别名 ${aliases.join('、')}`)
      }
      else {
        next = {
          ...target,
          links: [...target.links],
          repos: [...target.repos],
          aliases: [...target.aliases],
        }
        if (code && !target.code) {
          next.code = code
          changes.push(`补充编码 ${code}`)
        }
        if (code && target.code && normalize(target.code) !== normalize(code))
          throw new Error(`项目「${target.name}」已有不同的编码（${target.code}），未做修改`)
        for (const alias of aliases) {
          if (!next.aliases.some(item => normalize(item) === normalize(alias))) {
            next.aliases.push(alias)
            changes.push(`新增别名 ${alias}`)
          }
        }
        if (followed !== undefined && followed !== target.followed) {
          next.followed = followed
          changes.push(followed ? '设为关注' : '取消关注')
        }
        if (enabled !== undefined && enabled !== target.enabled) {
          next.enabled = enabled
          changes.push(enabled ? '设为启用' : '设为停用')
        }
      }

      if (link) {
        const linkValue: ProjectLink = { kind: link.kind, path: link.path }
        if (next.links.some(existing => sameLink(existing, linkValue))) {
          summary.push(`关联已存在，忽略：${link.label}`)
        }
        else {
          next.links.push(linkValue)
          changes.push(`新增关联：${link.label}`)

          if (ctx.gitlab) {
            const resolved = await resolveProjectLinks(ctx.gitlab, next.links, {
              perPage: ctx.settings.gitlab.perPage,
              maxProjects: ctx.settings.gitlab.maxProjects,
            })
            next.repos = resolved.repos
            next.syncedAt = new Date().toISOString()
            if (resolved.failures.length) {
              next.syncStatus = 'error'
              next.syncError = resolved.failures[0]
              changes.push(`解析到 ${resolved.repos.length} 个仓库，有 ${resolved.failures.length} 条失败`)
            }
            else {
              next.syncStatus = 'synced'
              next.syncError = undefined
              changes.push(`解析到 ${resolved.repos.length} 个仓库`)
            }
          }
          else {
            next.syncStatus = 'unsynced'
            next.syncError = undefined
            changes.push('GitLab 未配置，关联未校验、未解析仓库')
          }
        }
      }

      if (!changes.length) {
        const label = target ? `项目「${target.name}」` : '项目'
        const ignored = summary.length ? `；${summary.join('；')}` : ''
        return {
          kind: 'result',
          result: `${label}没有需要修改的内容${ignored}。`,
        }
      }

      const details = [
        { label: '项目', value: next.name },
        ...(next.code ? [{ label: '编码', value: next.code, mono: true }] : []),
        ...(next.links.length ? [{ label: '关联', value: next.links.map(item => item.path).join(' / '), mono: true }] : []),
        ...(next.repos.length ? [{ label: '仓库数', value: String(next.repos.length) }] : []),
        { label: '关注/启用', value: `${next.followed ? '关注' : '未关注'} / ${next.enabled ? '启用' : '停用'}` },
      ]

      return {
        kind: 'action',
        action: {
          approval: {
            id: crypto.randomUUID(),
            kind: 'project',
            title: target ? '模型请求更新项目关联' : '模型请求新建项目',
            summary: [...summary, ...changes],
            details,
            risk: { level: 'normal', matches: [] },
          },
          apply: async () => {
            await store.save(next)
            return { text: `已保存项目「${next.name}」：${changes.join('；')}。` }
          },
        },
      }
    },
  }

  return [listTool, ensureTool]
}
