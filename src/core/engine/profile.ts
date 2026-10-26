import type { Hotspot, LlmChatMessage, RepoScan } from '../bridge/types'
import type { LlmSettings, GitLabSettings } from '../config/settings'
import type { Project, ProjectRepo } from '../domain/types'
import type { BranchActivity } from './branchCommits'
import { GitLabClient } from '../adapters/gitlab'
import { isDesktop, transport } from '../bridge'
import { createLlmClient } from '../llm/client'
import { collectBranchCommits } from './branchCommits'

/**
 * 项目代码画像。
 *
 * 目标不是「统计有多少文件」，而是回答：这个项目由哪些模块组成、每个模块在做什么、
 * 最近在动哪里。统计部分完全来自本地代码与 git 历史，职责描述由模型根据
 * 模块结构和入口文件写——两者分开，模型写错了也不会污染事实数字。
 *
 * 这一层不碰数据库：生成的画像由调用方落库（见 store/profile.ts）。
 */

export interface ProfileModule {
  name: string
  /** 模块对应的目录（文件里最长的公共目录前缀） */
  path: string
  files: number
  bytes: number
  /** 主代码 / 测试代码文件数 */
  mainFiles: number
  testFiles: number
  languages: Record<string, number>
  /** 入口文件（controller / main / vue view…），按重要性排序 */
  entries: string[]
  /** 结构标记及出现次数 */
  flags: Record<string, number>
  /** 近期改动较多的文件 */
  hotFiles: Hotspot[]
  /** 被多少其它模块依赖 / 依赖了多少其它模块 */
  fanIn: number
  fanOut: number
  /** 模型写的职责说明；调用失败时为空串 */
  summary: string
}

export interface ModuleNode {
  id: string
  files: number
  bytes: number
  layer: 'backend' | 'frontend' | 'mixed' | 'other'
  fanIn: number
  fanOut: number
}

export interface ModuleEdge {
  from: string
  to: string
  weight: number
}

export interface RepoGraph {
  nodes: ModuleNode[]
  edges: ModuleEdge[]
}

/** 客观问题：全部由代码统计得出，不经过模型 */
export interface Finding {
  id: string
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  modules: string[]
}

export interface RepoProfile {
  repoId: number
  repoPath: string
  /** 实际扫描的本地目录 */
  localPath: string
  /** 生成画像时工作区所在分支 */
  currentBranch?: string
  /** GitLab / origin 认定的默认分支 */
  defaultBranch?: string
  /** 最近提交时间最晚的分支 */
  latestBranch?: string
  /** 最新分支的最近提交时间 */
  latestCommitAt?: string
  /** 实际用于分析的引用；和 currentBranch 不同说明用了临时工作树 */
  analyzedBranch?: string
  /** 本地和远程分支引用名，供报告和对话引用 */
  branches?: string[]
  /**
   * 近期每个分支各自做了什么：提交数、最近时间和几条标题。
   * 画像的代码结构仍取最新提交分支，但分支工作必须全量列出，避免把别的分支的活写没了。
   */
  branchWork?: BranchActivity[]
  /** 分支工作统计的时间窗（天） */
  branchWorkDays?: number
  /** 分支工作拉取失败的原因；为空表示成功或未启用 */
  branchWorkError?: string
  files: number
  truncated: boolean
  modules: ProfileModule[]
  /** 模块依赖图（由 import 推导） */
  graph: RepoGraph
  /** 由统计得出、不依赖模型的问题清单 */
  findings: Finding[]
  hotFiles: Hotspot[]
  /** 仓库级的一段话，基于模块小结 */
  narrative: string
  error?: string
}

export interface ProjectProfile {
  projectId: string
  generatedAt: string
  headCommit?: string
  repos: RepoProfile[]
  /** 直接扫描的本地目录；下次生成时用来回填 */
  localPaths?: string[]
  narrative: string
  /** 模型基于统计写出的 markdown 报告（含架构、核心模块、风险） */
  report: string
}

export interface ProfileOptions {
  /** 本地代码根目录 */
  codeRoot: string
  /** 不走 GitLab 关联、直接扫描的本地目录 */
  localPaths?: string[]
  /** 已加载的 skill 文本，拼进系统提示 */
  skills: string[]
  llm: LlmSettings
  /** GitLab 连接信息：本地缺代码时用来克隆。不传就只认本地已有代码 */
  gitlab?: GitLabSettings
  /** 缺少本地代码时自动浅克隆 */
  autoClone?: boolean
  /** 生成画像前确保 codegraph 索引存在（本地仓库） */
  autoIndex?: boolean
  /** codegraph 可执行文件；留空自动探测 */
  codegraphPath?: string
  /** 浅克隆深度（提交数），0 = 完整克隆 */
  cloneDepth?: number
  /** 最多让模型写多少个模块，其余只统计不描述 */
  maxModules?: number
  hotDays?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

/** 单次生成最多描述多少个模块——再多就是十几分钟的等待 */
const DEFAULT_MAX_MODULES = 12
const DEFAULT_HOT_DAYS = 90

/** 入口标记的权重：越靠前越能说明「这个模块对外提供什么」 */
const FLAG_WEIGHT: Record<string, number> = {
  'http-api': 5,
  'entrypoint': 5,
  'message-consumer': 4,
  'scheduled-job': 4,
  'service': 3,
  'rpc-client': 3,
  'router': 3,
  'repository': 2,
  'state-store': 2,
  'vue-view': 2,
}

const SYSTEM = `你在为研发管理者编写项目代码画像。
只依据给出的目录、文件、入口和热点判断，不要臆测具体业务细节；不确定时用「可能」「看起来」。
用中文写，2-4 句话，不要复述数字，不要罗列全部文件名，不要评价代码质量。
输出纯文本，不要 markdown 标题。`

function withSkills(system: string, skills: string[]) {
  const active = skills.map(s => s.trim()).filter(Boolean)
  if (!active.length)
    return system
  return `${system}\n\n团队提供的分析指引（请遵循）：\n${active.map(s => `---\n${s}`).join('\n')}`
}

/** 在代码根目录下按 `<命名空间>/<仓库>` 找本地 checkout，找不到再试仓库名 */
async function locate(codeRoot: string, repo: ProjectRepo): Promise<{ path: string, scan: RepoScan } | null> {
  const root = codeRoot.trim().replace(/[\\/]+$/, '')
  if (!root)
    return null

  const candidates = [repo.pathWithNamespace, repo.name].filter(Boolean)
  for (const rel of candidates) {
    const path = `${root}/${rel}`
    try {
      const scan = await transport().scanRepo(path)
      // 空目录不算「找到」：上一轮可能只建了目录还没放代码，
      // 直接当成命中会让画像以 0 个文件「成功」，克隆也就永远不触发
      if (!scan.files.length)
        continue
      return { path, scan }
    }
    catch {
      // 换下一个候选路径
    }
  }
  return null
}

/** 最多向下探到第几层包。再深基本就是把一个模块按子目录切碎了 */
const MAX_JAVA_LEVEL = 6

/**
 * 一个 Java 文件在第 `level` 层属于哪个模块。
 *
 * `pkg` 是 `src/main|test/java/` 之后的段，最后一段是文件名。
 * 包深度不够时退回它自己最深的包名——启动类这种落在根包上的类，
 * 归到根包本身，而不是硬造一个 `com` 模块。
 */
function moduleName(pkg: string[], level: number): string {
  if (pkg.length - 1 >= level)
    return pkg[level - 1]
  return pkg.length >= 2 ? pkg[pkg.length - 2] : '(根)'
}

/**
 * 选一个「有意义」的包层级作为模块。
 *
 * 固定取第 N 段在这里行不通：每个项目的包深度都不一样（`com.dfec.soft.phoenix.模块…`、
 * `io.phoenix.controlplane.模块…`），写死取第 3 段会把整个项目归成一个模块。
 *
 * 做法是把每一层都试一遍，挑第一个「分得出组、且没有哪个组占绝对多数」的层级；
 * 都不满足时退回分组最多的那层（单模块项目就是这个情况）。
 */
function chooseJavaLevel(packages: string[][]): number {
  if (!packages.length)
    return 1

  let bestLevel = 1
  let bestGroups = 0

  for (let level = 1; level <= MAX_JAVA_LEVEL; level++) {
    const counts = new Map<string, number>()
    for (const pkg of packages) {
      const name = moduleName(pkg, level)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }

    const groups = counts.size
    const largest = Math.max(...counts.values())
    // 分得出组，且最大的一组不超过 40%：避免把「一个模块占九成文件」的层级当成模块
    if (groups >= 2 && largest / packages.length <= 0.4)
      return level

    // 组数相同时取更深的一层，让单模块项目落到真正的包名上而不是 `com`
    if (groups >= bestGroups) {
      bestGroups = groups
      bestLevel = level
    }
  }

  return bestLevel
}
function commonDir(paths: string[]): string {
  if (!paths.length)
    return ''
  const dirs = paths.map(p => p.split('/').slice(0, -1))
  const first = dirs[0]
  let len = first.length
  for (const dir of dirs.slice(1)) {
    let i = 0
    while (i < len && i < dir.length && dir[i] === first[i])
      i++
    len = i
  }
  return first.slice(0, len).join('/')
}

/**
 * 模块划分。
 *
 * Java 按包名：先求所有 java 文件在 `src/main/java/` 之后的公共包前缀（通常是
 * `io/公司/产品`），再往下一段就是模块名。前端按 `src/` 之后的第一个目录。
 * 都不匹配时退回顶层目录——宁可粒度粗一点，也不要造出没有意义的模块。
 */
interface ModuleResolver {
  javaLevel: number
  moduleOf: (path: string) => string
}

/**
 * 建立「路径 → 模块名」的解析器。
 *
 * 模块划分和依赖图必须用同一个解析器，否则边会指向不存在的模块。
 */
function createResolver(scan: RepoScan): ModuleResolver {
  // 主代码与测试代码都按同一套包结构切模块：测试并进所属模块，
  // 而不是单独堆成一个「test」模块——否则模块卡里看不出这些测试是给谁的
  const javaPackages = scan.files
    .map(f => f.path.split('/'))
    .map((segs) => {
      const javaIdx = segs.indexOf('java')
      const inSrc = javaIdx >= 2
        && (segs[javaIdx - 1] === 'main' || segs[javaIdx - 1] === 'test')
        && segs[javaIdx - 2] === 'src'
      return inSrc ? segs.slice(javaIdx + 1) : null
    })
    .filter((segs): segs is string[] => segs !== null && segs.length > 0)

  const javaLevel = chooseJavaLevel(javaPackages)

  const moduleOf = (path: string): string => {
    const segs = path.split('/')
    const javaIdx = segs.indexOf('java')
    const inJava = javaIdx >= 2
      && (segs[javaIdx - 1] === 'main' || segs[javaIdx - 1] === 'test')
      && segs[javaIdx - 2] === 'src'
    if (inJava) {
      const pkg = segs.slice(javaIdx + 1)
      return moduleName(pkg, javaLevel)
    }
    const srcIdx = segs.indexOf('src')
    if (srcIdx >= 0 && segs.length > srcIdx + 1)
      return segs[srcIdx + 1]
    // 顶层散文件（README、pom）归到「根」，不要拿文件名当模块名
    return segs.length > 1 ? segs[0] : '(根)'
  }

  return { javaLevel, moduleOf }
}

function buildModules(scan: RepoScan, hot: Hotspot[], resolver: ModuleResolver): ProfileModule[] {
  const { moduleOf } = resolver

  const groups = new Map<string, { files: RepoScan['files'] }>()
  for (const file of scan.files) {
    const name = moduleOf(file.path)
    const group = groups.get(name) ?? { files: [] }
    group.files.push(file)
    groups.set(name, group)
  }

  const hotByModule = new Map<string, Hotspot[]>()
  for (const spot of hot) {
    const name = moduleOf(spot.path)
    const list = hotByModule.get(name) ?? []
    list.push(spot)
    hotByModule.set(name, list)
  }

  const modules: ProfileModule[] = []
  for (const [name, group] of groups) {
    const languages: Record<string, number> = {}
    const flags: Record<string, number> = {}
    let bytes = 0
    let mainFiles = 0
    let testFiles = 0
    for (const file of group.files) {
      languages[file.language] = (languages[file.language] ?? 0) + 1
      bytes += file.bytes
      if (file.path.includes('/src/test/'))
        testFiles++
      else
        mainFiles++
      for (const flag of file.flags) {
        flags[flag] = (flags[flag] ?? 0) + 1
      }
    }

    const entries = group.files
      .filter(f => f.flags.length)
      .sort((a, b) => {
        const score = (f: typeof a) => Math.max(...f.flags.map(fl => FLAG_WEIGHT[fl] ?? 0), 0)
        return score(b) - score(a) || a.path.length - b.path.length
      })
      .slice(0, 8)
      .map(f => f.path)

    modules.push({
      name,
      path: commonDir(group.files.map(f => f.path)) || name,
      files: group.files.length,
      bytes,
      mainFiles,
      testFiles,
      languages,
      entries,
      flags,
      hotFiles: (hotByModule.get(name) ?? []).slice(0, 5),
      fanIn: 0,
      fanOut: 0,
      summary: '',
    })
  }

  // 先按体量排序：预算有限时优先描述「有内容的模块」，小目录归到其它里
  return modules.sort((a, b) => b.bytes - a.bytes)
}

/* ------------------------------------------------------------------ *
 * 依赖图与客观问题
 * ------------------------------------------------------------------ */

function layerOf(module: ProfileModule): ModuleNode['layer'] {
  const langs = Object.keys(module.languages)
  const backend = langs.some(l => ['java', 'kotlin', 'go', 'rust', 'python', 'csharp'].includes(l))
  const frontend = langs.some(l => ['vue', 'typescript', 'javascript'].includes(l))
  if (backend && frontend)
    return 'mixed'
  return backend ? 'backend' : frontend ? 'frontend' : 'other'
}

/** Java import 全名 → 模块名；包深度不够时退回它最深的包 */
function moduleFromJavaImport(fqn: string, level: number): string | null {
  const segs = fqn.split('.').filter(s => s && s !== '*')
  if (segs.length < 2)
    return null
  const pkgLen = segs.length - 1
  if (pkgLen >= level)
    return segs[level - 1]
  return segs[pkgLen - 1] ?? null
}

/** 前端 import 说明符 → 仓库内路径；第三方包返回 null */
function resolveSpecifier(importer: string, spec: string): string | null {
  if (spec.startsWith('@/')) {
    const idx = importer.lastIndexOf('/src/')
    const root = idx >= 0 ? importer.slice(0, idx + 5) : (importer.startsWith('src/') ? 'src/' : '')
    return root ? root + spec.slice(2) : null
  }
  if (spec.startsWith('.')) {
    const parts = importer.split('/').slice(0, -1).filter(Boolean)
    for (const seg of spec.split('/')) {
      if (seg === '' || seg === '.')
        continue
      if (seg === '..')
        parts.pop()
      else
        parts.push(seg)
    }
    return parts.join('/')
  }
  // 裸说明符（vue、lodash、node:fs…）是外部依赖，不进图
  return null
}

function buildGraph(scan: RepoScan, modules: ProfileModule[], resolver: ModuleResolver): RepoGraph {
  const { javaLevel, moduleOf } = resolver
  const byName = new Map(modules.map(m => [m.name, m]))
  const edges = new Map<string, number>()

  const add = (from: string, to: string) => {
    if (!from || !to || from === to)
      return
    if (!byName.has(from) || !byName.has(to))
      return
    const key = `${from}\u0000${to}`
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }

  for (const file of scan.files) {
    if (!file.imports?.length)
      continue
    const from = moduleOf(file.path)
    const isJava = file.language === 'java' || file.language === 'kotlin'
    for (const spec of file.imports) {
      if (isJava) {
        const target = moduleFromJavaImport(spec, javaLevel)
        if (target)
          add(from, target)
      }
      else {
        const resolved = resolveSpecifier(file.path, spec)
        if (resolved)
          add(from, moduleOf(resolved))
      }
    }
  }

  const edgeList: ModuleEdge[] = [...edges.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split('\u0000')
      return { from, to, weight }
    })
    .sort((a, b) => b.weight - a.weight)

  for (const edge of edgeList) {
    const from = byName.get(edge.from)
    const to = byName.get(edge.to)
    if (from)
      from.fanOut++
    if (to)
      to.fanIn++
  }

  return {
    nodes: modules.map(m => ({
      id: m.name,
      files: m.files,
      bytes: m.bytes,
      layer: layerOf(m),
      fanIn: m.fanIn,
      fanOut: m.fanOut,
    })),
    edges: edgeList,
  }
}

/** Tarjan 强连通分量：大小 > 1 的一组就是循环依赖 */
function findCycles(nodes: ModuleNode[], edges: ModuleEdge[]): string[][] {
  const adj = new Map<string, string[]>()
  for (const node of nodes)
    adj.set(node.id, [])
  for (const edge of edges)
    adj.get(edge.from)?.push(edge.to)

  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []

  const strong = (v: string) => {
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)

    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      }
      else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }

    if (low.get(v) === index.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      if (comp.length > 1)
        cycles.push(comp)
    }
  }

  for (const node of nodes) {
    if (!index.has(node.id))
      strong(node.id)
  }

  return cycles
}

/**
 * 客观问题清单。
 *
 * 全部由统计得出，不经过模型——报告里「风险」一节的依据必须是可复核的数字，
 * 而不是模型觉得哪里有问题。
 */
function buildFindings(scan: RepoScan, modules: ProfileModule[], graph: RepoGraph, hot: Hotspot[]): Finding[] {
  const findings: Finding[] = []

  const cycles = findCycles(graph.nodes, graph.edges)
  if (cycles.length) {
    findings.push({
      id: 'cycles',
      severity: 'high',
      title: `检测到 ${cycles.length} 组循环依赖`,
      detail: cycles.slice(0, 5).map(c => c.join(' ↔ ')).join('；'),
      modules: cycles.flat().slice(0, 12),
    })
  }

  const totalChanges = hot.reduce((sum, h) => sum + h.changes, 0)
  if (totalChanges >= 20) {
    const top = hot.slice(0, 10)
    const share = top.reduce((sum, h) => sum + h.changes, 0) / totalChanges
    if (share >= 0.5) {
      findings.push({
        id: 'hotspot',
        severity: 'medium',
        title: `改动集中在少数文件：前 10 个文件占 ${Math.round(share * 100)}% 的改动`,
        detail: top.slice(0, 5).map(h => `${h.path}（${h.changes} 次）`).join('、'),
        modules: [],
      })
    }
  }

  const noTest = modules.filter(m =>
    m.mainFiles > 0
    && m.testFiles === 0
    && Object.keys(m.languages).some(l => l === 'java' || l === 'kotlin'),
  )
  if (noTest.length) {
    findings.push({
      id: 'no-test',
      severity: 'low',
      title: `${noTest.length} 个后端模块没有对应测试`,
      detail: noTest.slice(0, 8).map(m => m.name).join('、') + (noTest.length > 8 ? ' 等' : ''),
      modules: noTest.map(m => m.name),
    })
  }

  const huge = modules.filter(m => m.files >= 100)
  if (huge.length) {
    findings.push({
      id: 'huge-module',
      severity: 'low',
      title: `${huge.length} 个模块文件数超过 100`,
      detail: huge.slice(0, 5).map(m => `${m.name}（${m.files} 个文件）`).join('、'),
      modules: huge.map(m => m.name),
    })
  }

  const isolated = modules.filter(m => m.fanIn === 0 && m.fanOut === 0 && m.files >= 3)
  if (isolated.length) {
    findings.push({
      id: 'isolated',
      severity: 'low',
      title: `${isolated.length} 个模块既不依赖别人也不被依赖`,
      detail: isolated.slice(0, 8).map(m => m.name).join('、'),
      modules: isolated.map(m => m.name),
    })
  }

  const bigFiles = scan.files.filter(f => f.bytes > 200 * 1024)
  if (bigFiles.length) {
    findings.push({
      id: 'big-file',
      severity: 'low',
      title: `${bigFiles.length} 个文件超过 200 KB`,
      detail: bigFiles.slice(0, 5).map(f => f.path).join('、'),
      modules: [],
    })
  }

  return findings
}

function describeModule(project: Project, repo: ProjectRepo, module: ProfileModule): string {
  const langs = Object.entries(module.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang} ${count}`)
    .join('、')
  const flags = Object.entries(module.flags)
    .filter(([flag]) => FLAG_WEIGHT[flag])
    .map(([flag, count]) => `${flag} ${count}`)
    .join('、')

  const lines = [
    `项目：${project.name}${project.code ? `（${project.code}）` : ''}`,
    `仓库：${repo.pathWithNamespace}`,
    `模块：${module.name}（目录 ${module.path || module.name}）`,
    `规模：${module.files} 个文件，约 ${Math.round(module.bytes / 1024)} KB；语言：${langs || '未知'}`,
  ]
  if (flags)
    lines.push(`结构标记：${flags}`)
  if (module.entries.length)
    lines.push(`入口文件：${module.entries.slice(0, 6).join('、')}`)
  if (module.hotFiles.length)
    lines.push(`近期改动较多的文件：${module.hotFiles.map(h => `${h.path}（${h.changes} 次）`).join('、')}`)
  lines.push('', '请说明这个模块负责什么、关键实现是什么、近期是否活跃。')
  return lines.join('\n')
}

async function summarizeModule(
  client: ReturnType<typeof createLlmClient>,
  system: string,
  project: Project,
  repo: ProjectRepo,
  module: ProfileModule,
  signal?: AbortSignal,
): Promise<string> {
  const messages: LlmChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: describeModule(project, repo, module) },
  ]
  try {
    const completion = await client.complete(messages, { signal })
    return completion.text.trim()
  }
  catch {
    return ''
  }
}

async function summarizeRepo(
  client: ReturnType<typeof createLlmClient>,
  system: string,
  repo: ProjectRepo,
  modules: ProfileModule[],
  signal?: AbortSignal,
): Promise<string> {
  if (!modules.length)
    return ''
  const body = modules
    .filter(m => m.summary)
    .map(m => `- ${m.name}（${m.files} 个文件）：${m.summary}`)
    .join('\n')
  if (!body)
    return ''

  const messages: LlmChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `仓库 ${repo.pathWithNamespace} 的模块小结：\n${body}\n\n请用 2-3 句话概括这个仓库整体在做什么、由哪几块组成。`,
    },
  ]
  try {
    return (await client.complete(messages, { signal })).text.trim()
  }
  catch {
    return ''
  }
}

/**
 * 带凭据的克隆地址。
 *
 * GitLab 的 smart HTTP 用 Basic 认证，用户名固定 `oauth2`、密码是 PAT。
 * 这个地址会出现在 git 的参数和报错里，Rust 侧在回传输出前会抹掉 `://***@`。
 */
function cloneUrl(gitlab: { baseUrl: string, token: string }, repo: ProjectRepo): string {
  const base = new URL(gitlab.baseUrl.trim())
  const prefix = base.pathname.replace(/\/+$/, '')
  return `${base.protocol}//oauth2:${encodeURIComponent(gitlab.token)}@${base.host}${prefix}/${repo.pathWithNamespace}.git`
}

export async function buildRepoProfile(
  client: ReturnType<typeof createLlmClient>,
  system: string,
  project: Project,
  repo: ProjectRepo,
  opts: ProfileOptions,
): Promise<RepoProfile> {
  const base: RepoProfile = {
    repoId: repo.id,
    repoPath: repo.pathWithNamespace,
    localPath: '',
    files: 0,
    truncated: false,
    modules: [],
    graph: { nodes: [], edges: [] },
    findings: [],
    hotFiles: [],
    narrative: '',
  }

  let found: { path: string, scan: Awaited<ReturnType<ReturnType<typeof transport>['scanRepo']>> } | null = null
  const explicitLocal = repo.localPath?.trim().replace(/[\\/]+$/, '') ?? ''

  if (explicitLocal) {
    // 用户直接指定了本地目录：不要求项目关联 GitLab，也不自动克隆
    try {
      const scan = await transport().scanRepo(explicitLocal)
      if (!scan.files.length)
        return { ...base, error: `本地目录 ${explicitLocal} 里没有可分析的文件。` }
      found = { path: explicitLocal, scan }
    }
    catch (err) {
      return {
        ...base,
        error: `无法扫描本地目录 ${explicitLocal}：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  else {
    if (!opts.codeRoot.trim())
      return { ...base, error: '还没有设置「代码目录」。到「设置 → 代码分析」填上本地代码根目录，或在这个页面直接添加本地目录。' }

    found = await locate(opts.codeRoot, repo)
    const root = opts.codeRoot.trim().replace(/[\\/]+$/, '')
    const expected = `${root}/${repo.pathWithNamespace}`

    // 本地没有就自动克隆，用户不用自己去搬代码
    if (!found && opts.autoClone && opts.gitlab?.token.trim() && opts.gitlab.baseUrl.trim()) {
      opts.onProgress?.(`正在克隆 ${repo.pathWithNamespace}…`)
      try {
        await transport().gitClone(
          cloneUrl(opts.gitlab, repo),
          expected,
          repo.defaultBranch,
          opts.cloneDepth ?? 200,
        )
        found = await locate(opts.codeRoot, repo)
      }
      catch (err) {
        try {
          await transport().ensureDirs(root, [repo.pathWithNamespace])
        }
        catch {
          // 目录也建不出来时，错误信息里已经带了克隆失败原因，够了
        }
        return {
          ...base,
          error: `自动克隆失败：${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    if (!found) {
      // 没开自动克隆、或者没有 Token 时，把「应该放在哪」的目录结构建出来，
      // 用户把代码放进去再重跑即可
      let created: string[] = []
      try {
        created = await transport().ensureDirs(root, [repo.pathWithNamespace])
      }
      catch {
        // 创建失败（权限、磁盘）就退回普通的「没找到」提示
      }

      return {
        ...base,
        error: created.length
          ? `本地没有这份代码，已按仓库路径创建目录 ${expected}。开启「自动克隆」或把仓库放进去后重新生成。`
          : `在 ${root} 下没找到 ${repo.pathWithNamespace}，目录也没能创建。检查代码目录是否存在、是否有写权限。`,
      }
    }
  }

  if (!found)
    return { ...base, error: '没有可扫描的本地代码目录。' }

  // localPath 始终保留用户 checkout；分析默认分支时用的是临时 worktree
  base.localPath = found.path

  /*
   * codegraph 的 MCP 工具只有在仓库有 `.codegraph/` 索引时才返回内容。
   * 画像生成前先确保索引：已有则增量 sync，没有则 init。失败不阻断画像，
   * 但会提示，因为后续「申报对照」会拿不到代码符号。
   */
  if (opts.autoIndex && isDesktop()) {
    opts.onProgress?.(`正在确保 ${repo.pathWithNamespace} 的 codegraph 索引…`)
    try {
      const indexed = await transport().analysisIndex(found.path, opts.codegraphPath)
      opts.onProgress?.(`codegraph 索引已${indexed.action === 'sync' ? '更新' : '建立'}：${repo.pathWithNamespace}`)
    }
    catch (err) {
      opts.onProgress?.(
        `codegraph 索引未建立（${err instanceof Error ? err.message : String(err)}），代码结构仍可扫描，但申报对照拿不到符号级证据`,
      )
    }
  }

  let scan = found.scan
  let scanPath = found.path
  let cleanupWorktree: (() => Promise<void>) | null = null

  try {
    const branches = await transport().gitBranches(found.path)
    base.currentBranch = branches.current ?? undefined
    base.defaultBranch = repo.defaultBranch || branches.defaultBranch || undefined
    base.latestBranch = branches.latestBranch ?? undefined
    base.latestCommitAt = branches.latestBranch
      ? branches.branches.find(branch => branch.latest)?.committedAt
      : undefined
    base.branches = [...new Set(branches.branches.map(branch => branch.name))]

    // 优先分析最近提交的分支；没有最新信息时退回默认分支
    const targetBranch = branches.latestBranch || base.defaultBranch
    const targetRef = branches.latestBranch
      ? (branches.latestRef || branches.latestBranch)
      : (base.defaultBranch ? `origin/${base.defaultBranch}` : undefined)

    if (targetBranch && branches.current !== targetBranch && targetRef) {
      opts.onProgress?.(
        `当前目录在 ${branches.current || 'detached HEAD'}，改用最近提交的分支 ${targetBranch} 的临时工作树分析…`,
      )
      try {
        const worktree = await transport().gitWorktreeAdd(found.path, targetRef)
        const rescan = await transport().scanRepo(worktree)
        if (!rescan.files.length)
          throw new Error('目标分支工作树里没有可分析的文件')
        scan = rescan
        scanPath = worktree
        base.analyzedBranch = targetBranch
        cleanupWorktree = async () => transport().gitWorktreeRemove(found.path, worktree)
      }
      catch (err) {
        return {
          ...base,
          error: `当前目录在分支 ${branches.current || '(detached)'}，目标是最近提交的分支 ${targetBranch}；`
            + `创建临时工作树失败：${err instanceof Error ? err.message : String(err)}。`
            + '请确认该分支引用存在，或把工作区切到目标分支。',
        }
      }
    }
    else {
      base.analyzedBranch = branches.current ?? targetBranch
    }
  }
  catch {
    // 不是 git 仓库、或 git 不可用时，按普通目录扫描；没有分支信息
    base.analyzedBranch = undefined
  }

  /*
   * 分支工作靠 GitLab 接口统计：本地仓库可能只 checkout 了一个分支，
   * 用本地 ref 会漏掉别人在功能分支上的提交。拉不到也不影响画像主体，
   * 失败原因挂在 repo 上，报告会注明「分支信息不完整」。
   */
  const branchDays = opts.hotDays ?? DEFAULT_HOT_DAYS
  base.branchWorkDays = branchDays
  if (opts.gitlab?.baseUrl.trim() && opts.gitlab.token.trim() && repo.id > 0) {
    opts.onProgress?.(`正在统计 ${repo.pathWithNamespace} 各分支的提交…`)
    try {
      const result = await collectBranchCommits(
        new GitLabClient(opts.gitlab),
        {
          id: repo.id,
          pathWithNamespace: repo.pathWithNamespace,
          name: repo.name,
          webUrl: repo.webUrl,
          defaultBranch: repo.defaultBranch,
        },
        {
          since: new Date(Date.now() - branchDays * 86_400_000).toISOString(),
          until: new Date().toISOString(),
          perPage: opts.gitlab.perPage,
          maxCommits: 200,
          fetchFileChanges: false,
          signal: opts.signal,
        },
        { maxBranches: 20 },
      )
      base.branchWork = result.branches
      if (result.failures.length)
        base.branchWorkError = result.failures.slice(0, 3).join('；')
    }
    catch (err) {
      base.branchWorkError = err instanceof Error ? err.message : String(err)
    }
  }

  base.files = scan.files.length
  base.truncated = scan.truncated

  let hot: Hotspot[] = []
  try {
    hot = await transport().gitHotspots(scanPath, opts.hotDays ?? DEFAULT_HOT_DAYS)
  }
  catch {
    // 没有 .git 或 git 不可用时只是少了热点，不影响结构分析
  }
  finally {
    if (cleanupWorktree)
      await cleanupWorktree()
  }
  base.hotFiles = hot.slice(0, 20)

  const resolver = createResolver(scan)
  const modules = buildModules(scan, hot, resolver)
  const graph = buildGraph(scan, modules, resolver)
  const findings = buildFindings(scan, modules, graph, hot)

  const budget = opts.maxModules ?? DEFAULT_MAX_MODULES
  const described = modules.slice(0, budget)

  for (const [index, module] of described.entries()) {
    opts.onProgress?.(`正在分析 ${repo.pathWithNamespace} · ${module.name}（${index + 1}/${described.length}）`)
    module.summary = await summarizeModule(client, system, project, repo, module, opts.signal)
  }

  base.modules = modules
  base.graph = graph
  base.findings = findings
  base.narrative = await summarizeRepo(client, system, repo, modules, opts.signal)
  return base
}

/**
 * 生成 markdown 报告。
 *
 * 给模型的是**已经统计好的事实**：模块清单、依赖边、问题清单。
 * 它负责组织叙述和给建议，不负责发现数字——数字由 buildFindings 定，
 * 报告里的结论才可复核。
 */
async function buildReport(
  client: ReturnType<typeof createLlmClient>,
  system: string,
  project: Project,
  repos: RepoProfile[],
  signal?: AbortSignal,
): Promise<string> {
  const sections: string[] = []

  for (const repo of repos) {
    if (repo.error) {
      sections.push(`仓库 ${repo.repoPath}：未能分析（${repo.error}）`)
      continue
    }
    const modules = repo.modules.slice(0, 30).map(m =>
      `- ${m.name}：${m.files} 个文件（主 ${m.mainFiles} / 测 ${m.testFiles}），被依赖 ${m.fanIn}、依赖 ${m.fanOut}，`
      + `标记 ${Object.keys(m.flags).join('/') || '无'}；${m.summary || '（无描述）'}`,
    )
    const edges = repo.graph.edges.slice(0, 25).map(e => `${e.from} → ${e.to}（${e.weight}）`)
    const branchText = [
      repo.defaultBranch ? `默认分支 ${repo.defaultBranch}` : '',
      repo.latestBranch ? `最近提交分支 ${repo.latestBranch}${repo.latestCommitAt ? `（${repo.latestCommitAt}）` : ''}` : '',
      repo.currentBranch ? `本地当前 ${repo.currentBranch}` : '',
      repo.analyzedBranch ? `画像分析 ${repo.analyzedBranch}` : '',
      repo.branches?.length ? `分支引用 ${repo.branches.length} 个` : '',
    ].filter(Boolean).join('；')
    /*
     * 每个分支单独列一段，并带上最近提交标题：只说「有多少分支」
     * 等于什么都没说，报告要能写出「A 分支在做 X，B 分支在做 Y」。
     */
    const branchWork = (repo.branchWork ?? []).length
      ? `\n近 ${repo.branchWorkDays ?? DEFAULT_HOT_DAYS} 天分支工作：\n`
        + repo.branchWork!.map(b => `- ${b.name}${b.default ? '（默认）' : ''}${b.merged ? '（已合并）' : ''}：`
          + `${b.commits} 条提交，最近 ${b.latestCommitAt ?? '未知'}；`
          + `近期内容：${b.titles.join('；') || '（无标题）'}`).join('\n')
        + (repo.branchWorkError ? `\n（部分分支拉取失败：${repo.branchWorkError}）` : '')
      : ''
    sections.push(
      `仓库：${repo.repoPath}\n文件数：${repo.files}，模块数：${repo.modules.length}\n`
      + (branchText ? `分支：${branchText}\n` : '')
      + branchWork
      + `模块：\n${modules.join('\n')}\n\n主要依赖边：\n${edges.join('\n') || '（无）'}`,
    )
  }

  const findings = repos.flatMap(r => r.findings)
  const findingsText = findings.length
    ? findings.map(f => `- [${f.severity}] ${f.title}：${f.detail}`).join('\n')
    : '（统计层面没有发现明显问题）'

  const messages: LlmChatMessage[] = [
    {
      role: 'system',
      content: `${system}\n\n你还要为研发管理者写一份项目代码分析报告。要求：客观、具体、不吹捧；`
        + `所有数字必须来自给出的数据；数据不足时明确写「数据不足」。只输出 markdown 报告正文。`,
    },
    {
      role: 'user',
      content: `项目：${project.name}${project.code ? `（${project.code}）` : ''}\n\n`
        + `${sections.join('\n\n')}\n\n统计层面的问题清单：\n${findingsText}\n\n`
        + `请输出包含以下二级标题的报告：## 项目概览 / ## 分支工作 / ## 架构与依赖 / ## 核心模块 / ## 风险与问题 / ## 建议。`
        + `「分支工作」一节必须逐个列出近段时间有提交的分支，写清每个分支各自在做什么；`
        + `没有分支数据时写「数据不足」，不要只分析默认分支。`
        + `总长度 800~1500 字，不要使用一级标题。`,
    },
  ]

  try {
    return (await client.complete(messages, { signal })).text.trim()
  }
  catch {
    return ''
  }
}

export async function buildProjectProfile(
  project: Project,
  opts: ProfileOptions,
): Promise<ProjectProfile> {
  const client = createLlmClient(opts.llm)
  const system = withSkills(SYSTEM, opts.skills)

  const localPaths = [...new Set(
    (opts.localPaths ?? [])
      .map(path => path.trim().replace(/[\\/]+$/, ''))
      .filter(Boolean),
  )]

  const syntheticRepos: ProjectRepo[] = localPaths
    .filter(path => !(project.repos ?? []).some(repo => repo.localPath === path))
    .map((path, index) => {
      const name = path.split(/[\\/]/).pop() || `local-${index + 1}`
      return {
        id: -(index + 1),
        pathWithNamespace: name,
        name,
        webUrl: '',
        linkKind: 'repo',
        linkPath: path,
        localPath: path,
      }
    })

  const reposToScan = [...(project.repos ?? []), ...syntheticRepos]
  const repos: RepoProfile[] = []
  for (const repo of reposToScan) {
    opts.onProgress?.(`正在扫描 ${repo.pathWithNamespace}`)
    repos.push(await buildRepoProfile(client, system, project, repo, opts))
  }

  const narrativeParts = repos.filter(r => r.narrative).map(r => `- ${r.repoPath}：${r.narrative}`)
  let narrative = ''
  if (narrativeParts.length) {
    try {
      const completion = await client.complete([
        { role: 'system', content: system },
        {
          role: 'user',
          content: `项目「${project.name}」包含以下仓库：\n${narrativeParts.join('\n')}\n\n请用 3-5 句话概括这个项目整体由哪些部分组成、各自负责什么。`,
        },
      ], { signal: opts.signal })
      narrative = completion.text.trim()
    }
    catch {
      narrative = ''
    }
  }

  let headCommit: string | undefined
  const first = repos.find(r => r.localPath)
  if (first) {
    try {
      const head = await transport().gitHead(first.localPath)
      headCommit = head || undefined
    }
    catch {
      // 拿不到 HEAD 不影响画像本身
    }
  }

  opts.onProgress?.('正在撰写分析报告…')
  const report = await buildReport(client, system, project, repos, opts.signal)

  return {
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    headCommit,
    repos,
    localPaths: localPaths.length ? localPaths : undefined,
    narrative,
    report,
  }
}
