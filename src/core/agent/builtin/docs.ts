import type { BuiltinTool } from '../types'
import { DOCS, getDoc, listDocs, searchDocs } from '@/core/knowledge'

/**
 * 官方文档检索工具。只读，不需要确认。
 *
 * 语料随应用下发，检索在本地完成；返回章节片段而不是整篇，
 * 避免把全部文档塞进上下文。
 */

const MAX_DOC_CHARS = 8_000
const MAX_RESULT_CHARS = 7_000

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function catalog() {
  return listDocs()
    .map(doc => `- ${doc.id}：${doc.title}（${doc.keywords.slice(0, 5).join('、')}）`)
    .join('\n')
}

export function createDocsTool(): BuiltinTool {
  return {
    descriptor: {
      id: 'docs.search',
      source: 'builtin',
      serverId: 'builtin-docs',
      serverName: 'builtin_docs',
      name: 'search',
      qualifiedName: 'builtin_docs__search',
      description: '检索随应用下发的官方文档。回答「这个功能怎么用、在哪配置、这个数字怎么算、为什么报错」之前先用它。query 为空时返回文档目录；给 docId 时返回整篇。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言问题或关键词' },
          docId: {
            type: 'string',
            description: '直接读取某篇文档，例如 members、settings、scoring',
            enum: Object.keys(DOCS),
          },
        },
      },
      readOnly: true,
    },

    async run(args) {
      const docId = typeof args.docId === 'string' ? args.docId.trim() : ''
      if (docId) {
        const doc = getDoc(docId)
        if (!doc)
          throw new Error(`没有这篇官方文档：${docId}`)
        return clip(
          `# ${doc.title}（docId: ${doc.id}）\n\n${doc.body.replace(/^#\s+.*\r?\n?/, '')}`,
          MAX_DOC_CHARS,
        )
      }

      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query)
        return `官方文档目录：\n${catalog()}\n\n请给出 query 或 docId 继续查询。`

      const hits = searchDocs(query, 4)
      if (!hits.length) {
        return [
          `官方文档里没有找到和「${query}」直接匹配的内容。`,
          '不要编造功能；可以换一个关键词，或告诉用户当前文档没有覆盖这项说明。',
          '',
          `文档目录：\n${catalog()}`,
        ].join('\n')
      }

      const text = hits.map((hit, index) => {
        return [
          `${index + 1}. ${hit.title} · ${hit.heading}（docId: ${hit.docId}）`,
          hit.excerpt || '（该章节没有摘要）',
        ].join('\n')
      }).join('\n\n')

      return clip(`官方文档检索结果（query: ${query}）：\n\n${text}`, MAX_RESULT_CHARS)
    },
  }
}
