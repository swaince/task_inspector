import type { ProjectLink, ProjectRepo } from '../domain/types'
import type { GitLabClient } from './gitlab'

/**
 * 把一个项目的关联链接展开成具体仓库。
 *
 * - `repo`：按 pathWithNamespace 精确取一个仓库
 * - `group`：扫描该组及其**全部子组**（include_subgroups）
 *
 * 结果是缓存下来给检查用的，所以解析失败必须如实报出来——少一个仓库不会报错，
 * 只会让那部分提交「凭空消失」，最后表现成「这个人当天没提交」，
 * 而那是最难查的一种情况。
 */
export async function resolveProjectLinks(
  gitlab: GitLabClient,
  links: ProjectLink[],
  opts: { perPage: number, maxProjects: number },
): Promise<{ repos: ProjectRepo[], failures: string[] }> {
  const repos: ProjectRepo[] = []
  const failures: string[] = []
  const seen = new Set<number>()

  const push = (ref: { id: number, pathWithNamespace: string, name: string, webUrl: string, defaultBranch?: string }, link: ProjectLink) => {
    // 一个仓库可能同时落在「直接关联」和某个组里，按 id 去重，
    // 否则同一批提交会被算两遍
    if (seen.has(ref.id))
      return
    seen.add(ref.id)
    repos.push({
      id: ref.id,
      pathWithNamespace: ref.pathWithNamespace,
      name: ref.name,
      webUrl: ref.webUrl,
      defaultBranch: ref.defaultBranch,
      linkKind: link.kind,
      linkPath: link.path,
    })
  }

  for (const link of links) {
    const path = link.path.trim().replace(/^\/+|\/+$/g, '')
    if (!path)
      continue

    try {
      if (link.kind === 'repo') {
        push(await gitlab.getProject(path), link)
        continue
      }

      const found = await gitlab.listGroupProjects(path, {
        perPage: opts.perPage,
        maxProjects: opts.maxProjects,
      })
      if (found.truncated)
        failures.push(`组 ${path} 的仓库数超过上限（${opts.maxProjects}），结果被截断`)
      for (const ref of found.projects)
        push(ref, link)
    }
    catch (err) {
      failures.push(
        `${link.kind === 'group' ? '组' : '仓库'} ${path}：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { repos, failures }
}
