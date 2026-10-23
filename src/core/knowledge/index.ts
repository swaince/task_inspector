import overview from './docs/overview.md?raw'
import inspection from './docs/inspection.md?raw'
import results from './docs/results.md?raw'
import projects from './docs/projects.md?raw'
import members from './docs/members.md?raw'
import activities from './docs/activities.md?raw'
import projectChat from './docs/project-chat.md?raw'
import settings from './docs/settings.md?raw'
import scoring from './docs/scoring.md?raw'
import privacy from './docs/privacy.md?raw'
import troubleshooting from './docs/troubleshooting.md?raw'
import assistantTools from './docs/assistant-tools.md?raw'

/**
 * 随应用下发的官方文档。
 *
 * 用 `?raw` 直接打进前端包：桌面端和浏览器预览都能用，不依赖文件系统、
 * Tauri bundle resources 或用户自己的 skill 文件。
 *
 * 文档是「给使用者看」的，不是开发 README。对话通过 docs.search 检索它，
 * 回答功能、设置、数据口径类问题时以这里为准。
 */

const DOC_FILES = {
  overview,
  inspection,
  results,
  projects,
  members,
  activities,
  'project-chat': projectChat,
  settings,
  scoring,
  privacy,
  troubleshooting,
  'assistant-tools': assistantTools,
} as const

export type DocId = keyof typeof DOC_FILES

export interface DocSection {
  heading: string
  text: string
}

export interface DocEntry {
  id: DocId
  title: string
  keywords: string[]
  routes: string[]
  body: string
  sections: DocSection[]
}

export interface DocSearchHit {
  docId: DocId
  title: string
  heading: string
  excerpt: string
  score: number
}

interface Frontmatter {
  meta: Record<string, string>
  body: string
}

function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match)
    return { meta: {}, body: raw.trim() }

  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0)
      continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (key)
      meta[key] = value
  }
  return { meta, body: raw.slice(match[0].length).trim() }
}

function splitList(value: string | undefined) {
  return (value ?? '')
    .split(/[,，]/)
    .map(item => item.trim())
    .filter(Boolean)
}

/** 按 `## ` 切章节；第一个 `# ` 标题之后的内容归入「概览」 */
function splitSections(body: string): DocSection[] {
  const withoutTitle = body.replace(/^#\s+.*\r?\n?/, '')
  const parts = withoutTitle.split(/^##\s+/m)
  const sections: DocSection[] = []
  const intro = parts.shift()?.trim()
  if (intro)
    sections.push({ heading: '概览', text: intro })

  for (const part of parts) {
    const newline = part.indexOf('\n')
    const heading = newline >= 0 ? part.slice(0, newline).trim() : part.trim()
    const text = newline >= 0 ? part.slice(newline + 1).trim() : ''
    if (heading)
      sections.push({ heading, text })
  }
  return sections
}

function buildDoc(id: DocId, raw: string): DocEntry {
  const { meta, body } = parseFrontmatter(raw)
  return {
    id,
    title: meta.title?.trim() || id,
    keywords: splitList(meta.keywords),
    routes: splitList(meta.routes),
    body,
    sections: splitSections(body),
  }
}

export const DOCS = Object.fromEntries(
  (Object.entries(DOC_FILES) as [DocId, string][]).map(([id, raw]) => [id, buildDoc(id, raw)]),
) as Record<DocId, DocEntry>

export function listDocs(): DocEntry[] {
  return Object.values(DOCS)
}

export function getDoc(id: string): DocEntry | null {
  return (DOCS as Record<string, DocEntry>)[id] ?? null
}

function tokenize(value: string): string[] {
  const lower = value.toLowerCase()
  const tokens = new Set<string>()

  for (const word of lower.match(/[a-z0-9][a-z0-9_.-]{1,}/g) ?? [])
    tokens.add(word)

  for (const chunk of lower.match(/[一-鿿]+/g) ?? []) {
    if (chunk.length === 1) {
      tokens.add(chunk)
      continue
    }
    for (let i = 0; i < chunk.length - 1; i++)
      tokens.add(chunk.slice(i, i + 2))
  }

  return [...tokens]
}

function countOccurrences(haystack: string, token: string) {
  if (!token)
    return 0
  let count = 0
  let from = 0
  while (count < 8) {
    const at = haystack.indexOf(token, from)
    if (at < 0)
      break
    count += 1
    from = at + token.length
  }
  return count
}

function excerptOf(text: string, tokens: string[]) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat)
    return ''
  let at = -1
  for (const token of tokens) {
    const index = flat.toLowerCase().indexOf(token)
    if (index >= 0 && (at < 0 || index < at))
      at = index
  }
  if (at < 0)
    return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
  const start = Math.max(0, at - 60)
  const end = Math.min(flat.length, at + 140)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/**
 * 简单检索：中文二元组 + ASCII 词，标题/关键词权重最高。
 * 语料只有十几篇，没必要上向量或 FTS。
 */
export function searchDocs(query: string, limit = 4): DocSearchHit[] {
  const tokens = tokenize(query)
  if (!tokens.length)
    return []

  const hits: DocSearchHit[] = []
  for (const doc of Object.values(DOCS)) {
    const title = doc.title.toLowerCase()
    const keywords = doc.keywords.join(' ').toLowerCase()

    for (const section of doc.sections) {
      const heading = section.heading.toLowerCase()
      const body = section.text.toLowerCase()
      let score = 0
      for (const token of tokens)
        score += countOccurrences(title, token) * 6
          + countOccurrences(keywords, token) * 5
          + countOccurrences(heading, token) * 3
          + countOccurrences(body, token)
      if (!score)
        continue
      hits.push({
        docId: doc.id,
        title: doc.title,
        heading: section.heading,
        excerpt: excerptOf(section.text, tokens),
        score,
      })
    }
  }

  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
