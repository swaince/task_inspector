import type { AppSettings } from '@/core/config/settings'
import type { BuiltinTool } from '../types'
import { isDesktop } from '@/core/bridge'
import { APP_FEATURES, TOOL_DOCS } from '@/core/knowledge/capabilities'
import { DOCS } from '@/core/knowledge'
import { createDocsTool } from './docs'
import { createMembersTool } from './members'
import { createProjectsTool } from './projects'
import { createShellTool, DEFAULT_SHELL_TIMEOUT_MS } from './shell'

let docsChecked = false

/** 开发态自检：工具/页面都应该有官方文档，避免能力清单和文档慢慢脱节 */
function checkDocs(tools: BuiltinTool[]) {
  if (docsChecked || !import.meta.env.DEV)
    return
  docsChecked = true
  for (const tool of tools) {
    const docId = TOOL_DOCS[tool.descriptor.id]
    if (!docId)
      console.warn(`[knowledge] 工具 ${tool.descriptor.id} 没有登记官方文档`)
    else if (!DOCS[docId])
      console.warn(`[knowledge] 工具 ${tool.descriptor.id} 指向不存在的文档 ${docId}`)
  }
  for (const feature of APP_FEATURES) {
    if (!DOCS[feature.docId])
      console.warn(`[knowledge] 页面 ${feature.route} 指向不存在的文档 ${feature.docId}`)
  }
}

export interface BuiltinToolOptions {
  settings: AppSettings
  projectPaths: string[]
  projectId: string
}

/**
 * 应用内置工具集合。
 *
 * 文档、人员、项目始终可用；命令执行只有在桌面端、设置打开、
 * 且当前项目有本地仓库目录时才注入——没有 cwd 就不应该出现 shell 工具。
 */
export function createBuiltinTools(opts: BuiltinToolOptions): BuiltinTool[] {
  const tools: BuiltinTool[] = [
    createDocsTool(),
    ...createMembersTool(),
    ...createProjectsTool(),
  ]

  const shellEnabled = isDesktop()
    && opts.settings.analysis.allowShellCommands
    && opts.projectPaths.length > 0

  if (shellEnabled) {
    const seconds = opts.settings.analysis.shellTimeoutSeconds
    const timeoutMs = Number.isFinite(seconds)
      ? Math.min(300_000, Math.max(5_000, Math.round(seconds * 1000)))
      : DEFAULT_SHELL_TIMEOUT_MS
    tools.push(createShellTool(opts.projectPaths, timeoutMs))
  }

  checkDocs(tools)
  return tools
}
