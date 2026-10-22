import type { AppSettings } from '../config/settings'
import type { GitLabProjectRef } from '../domain/types'
import type { GitLabClient, ProjectDiscoveryOptions } from '../adapters/gitlab'
import { AdapterError } from '../adapters/gitlab'

/**
 * 项目目录：把发现范围解析成真实的 GitLab 项目清单。
 *
 * 模糊匹配需要一份「候选项目全集」，所以启动检查前必须先建目录。来源有两处：
 *
 * 1. 同步 token 有权限的全部仓库（含通过 group 继承的成员身份）。
 *    **仓库范围不在这里配**：哪个业务项目对应哪些仓库/组，是在「项目」面板上按项目配的
 *    （见 `adapters/projectLinks.ts`），目录只用来给模糊匹配提供候选。
 * 2. 显式配置的项目映射路径：不在上面的范围内时单独解析，
 *    顺便验证路径是否有效，无效的在界面上报出来。
 *
 * 结果缓存在内存里，键是配置的指纹，改配置就会失效。
 */

export interface ProjectCatalog {
  projects: GitLabProjectRef[]
  /** 解析失败的路径，通常是没有权限或路径写错 */
  failures: Array<{ path: string, reason: string }>
  /** 仓库数量触达上限被截断，此时应改用 group 收窄范围 */
  truncated: boolean
  /** 本次的发现范围，供界面展示 */
  scope: string
  builtAt: number
}

export interface CatalogDeps {
  settings: AppSettings
  gitlab: GitLabClient
  onProgress?: (message: string) => void
}

export async function buildProjectCatalog(deps: CatalogDeps): Promise<ProjectCatalog> {
  const { settings, gitlab } = deps
  const failures: ProjectCatalog['failures'] = []
  const byId = new Map<number, GitLabProjectRef>()

  const discovery: ProjectDiscoveryOptions = {
    perPage: settings.gitlab.perPage,
    maxProjects: settings.gitlab.maxProjects,
    onProgress: (fetched, page) => {
      deps.onProgress?.(`正在同步仓库…已发现 ${fetched} 个（第 ${page} 页）`)
    },
  }

  deps.onProgress?.('正在同步有权限的仓库…')
  let truncated = false
  try {
    const result = await gitlab.listAccessibleProjects(discovery)
    for (const p of result.projects)
      byId.set(p.id, p)
    truncated = result.truncated
  }
  catch (err) {
    failures.push({ path: '（有权限的仓库）', reason: describe(err) })
  }

  // 显式配置的映射路径：若不在上面的发现范围内（例如指向别的 group、
  // 或跨出了 group 收窄的范围），单独解析一次；失败即说明路径有问题，要报出来。
  const explicit = [...new Set(
    settings.projectMappings.flatMap(m => m.gitlabProjectPaths).map(p => p.trim()).filter(Boolean),
  )]
  const knownPaths = new Set([...byId.values()].map(p => p.pathWithNamespace))

  for (const path of explicit) {
    if (knownPaths.has(path))
      continue
    try {
      const project = await gitlab.getProject(path)
      byId.set(project.id, project)
      knownPaths.add(path)
    }
    catch (err) {
      failures.push({ path, reason: describe(err) })
    }
  }

  const scope = '全部有权限的仓库'

  if (!byId.size && !failures.length) {
    deps.onProgress?.('没有发现任何仓库，请确认 token 至少是某些项目的成员')
  }

  return {
    projects: [...byId.values()].sort((a, b) => a.pathWithNamespace.localeCompare(b.pathWithNamespace)),
    failures,
    truncated,
    scope,
    builtAt: Date.now(),
  }
}

function describe(err: unknown) {
  return err instanceof AdapterError ? err.message : String(err)
}

/** 配置指纹：影响目录内容的字段变了就应该重建。 */
export function catalogFingerprint(settings: AppSettings): string {
  return JSON.stringify({
    baseUrl: settings.gitlab.baseUrl,
    maxProjects: settings.gitlab.maxProjects,
    paths: settings.projectMappings.flatMap(m => m.gitlabProjectPaths).sort(),
  })
}
