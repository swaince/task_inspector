/**
 * 清理模型输出里泄漏的「工具调用语法」。
 *
 * 一些模型（典型是 DeepSeek 系列）在没有原生工具接口时，会把内部的
 * `<||DSML||invoke ...>` / `<function_calls>` 语法直接写进正文。
 * 我们用的是 JSON 规划器，这些标记不属于回答，必须拦在界面之外。
 */

const BLOCK_PATTERNS: RegExp[] = [
  /<function_calls>[\s\S]*?<\/function_calls>/gi,
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  /<\|[^|>\n]*tool[^|>\n]*begin[^|>\n]*\|>[\s\S]*?<\|[^|>\n]*tool[^|>\n]*end[^|>\n]*\|>/gi,
]

function looksLikeMarkerLine(line: string) {
  if (/\bDSML\b/i.test(line))
    return true
  if (/^\s*<\|/.test(line) || /^\s*<\/?\|/.test(line))
    return true
  // 去掉 DSML 标记后可能只剩这些行
  if (/^\s*\|?\s*(invoke|parameter|calls)\b/i.test(line))
    return true
  if (/^\s*<\/?\s*(invoke|parameter|calls)\s*>/i.test(line))
    return true
  return false
}

export function stripToolCallSyntax(text: string): string {
  let output = text.replace(/\r\n?/g, '\n')

  for (const pattern of BLOCK_PATTERNS)
    output = output.replace(pattern, '')

  const lines = output.split('\n')
  const kept: string[] = []
  let insideDsml = false

  for (const line of lines) {
    if (/\bDSML\b/i.test(line)) {
      const closesCalls = /(<\s*\/[^>]*calls\s*>)|(\|\|\s*\/\s*calls\s*>)/i.test(line)
      const opensCalls = /(<\s*\|?[^>]*calls\s*>)|(\|\|\s*calls\s*>)/i.test(line)
      if (closesCalls)
        insideDsml = false
      else if (opensCalls && !insideDsml)
        insideDsml = true
      continue
    }

    if (insideDsml) {
      // DSML 容器里可能夹着参数值（例如人名），整段丢弃
      if (/(<\s*\/[^>]*calls\s*>)|(\|\|\s*\/\s*calls\s*>)/i.test(line))
        insideDsml = false
      continue
    }

    if (looksLikeMarkerLine(line))
      continue

    kept.push(line)
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 判断文本里是否出现了工具调用语法；用于区分「模型没回答」和「回答被拦截」 */
export function looksLikeToolCallSyntax(text: string): boolean {
  return /\bDSML\b|<function_calls>|<tool_call>|<\|[^|>\n]*tool[^|>\n]*(begin|end)[^|>\n]*\|>/i.test(text)
}
