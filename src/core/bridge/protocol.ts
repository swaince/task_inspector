import type { LlmChatRequest, LlmStreamEvent, LlmUsage } from '../bridge/types'

/**
 * LLM 协议编解码。
 *
 * 同时支持 Anthropic Messages API 和 OpenAI 兼容的 chat/completions，
 * 覆盖内网自建推理服务（vLLM / Ollama / 一体机）和公有云两类部署。
 * Rust 侧按同样的规则实现，改协议时两边要一起改。
 */

export const ANTHROPIC_VERSION = '2023-06-01'

export interface BuiltLlmRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, '')}${path}`
}

export function buildLlmRequest(req: LlmChatRequest, browser = false): BuiltLlmRequest {
  const system = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const turns = req.messages.filter(m => m.role !== 'system')

  if (req.provider === 'anthropic') {
    const base = req.baseUrl || 'https://api.anthropic.com'
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    }
    if (browser)
      headers['anthropic-dangerous-direct-browser-access'] = 'true'

    return {
      url: joinUrl(base, '/v1/messages'),
      headers,
      body: {
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
        ...(system ? { system } : {}),
        messages: turns.map(m => ({ role: m.role, content: m.content })),
      },
    }
  }

  const base = req.baseUrl || 'https://api.openai.com'
  return {
    url: joinUrl(base, '/v1/chat/completions'),
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${req.apiKey}`,
    },
    body: {
      model: req.model,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: req.messages.map(m => ({ role: m.role, content: m.content })),
      ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    },
  }
}

/**
 * 解析 SSE 流并逐段回调，返回累计用量。
 * 两种协议的增量都藏在 `delta` 里，只有字段名不同。
 */
export async function parseLlmStream(
  body: ReadableStream<Uint8Array>,
  provider: 'anthropic' | 'openai-compatible',
  onEvent: (event: LlmStreamEvent) => void,
): Promise<LlmUsage | undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const usage: LlmUsage = {}

  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    buffer += decoder.decode(value, { stream: true })

    // SSE 以空行分隔事件，\r\n 与 \n 都要认。
    let sep = findSeparator(buffer)
    while (sep) {
      const raw = buffer.slice(0, sep.index)
      buffer = buffer.slice(sep.index + sep.length)
      handleSseBlock(raw, provider, onEvent, usage)
      sep = findSeparator(buffer)
    }
  }
  if (buffer.trim())
    handleSseBlock(buffer, provider, onEvent, usage)

  return usage.inputTokens == null && usage.outputTokens == null ? undefined : usage
}

function findSeparator(buffer: string): { index: number, length: number } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf))
    return { index: crlf, length: 4 }
  if (lf !== -1)
    return { index: lf, length: 2 }
  return null
}

function handleSseBlock(
  block: string,
  provider: 'anthropic' | 'openai-compatible',
  onEvent: (event: LlmStreamEvent) => void,
  usage: LlmUsage,
) {
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('data:'))
      continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]')
      continue

    let json: any
    try {
      json = JSON.parse(payload)
    }
    catch {
      continue
    }

    if (provider === 'anthropic') {
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
        onEvent({ type: 'delta', text: json.delta.text })
      }
      else if (json.type === 'message_start' && json.message?.usage) {
        usage.inputTokens = json.message.usage.input_tokens ?? usage.inputTokens
      }
      else if (json.type === 'message_delta' && json.usage) {
        usage.outputTokens = json.usage.output_tokens ?? usage.outputTokens
      }
      else if (json.type === 'error') {
        onEvent({ type: 'error', message: json.error?.message ?? 'LLM 返回错误' })
      }
      continue
    }

    const delta = json.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta)
      onEvent({ type: 'delta', text: delta })
    if (json.usage) {
      usage.inputTokens = json.usage.prompt_tokens ?? usage.inputTokens
      usage.outputTokens = json.usage.completion_tokens ?? usage.outputTokens
    }
    if (json.error)
      onEvent({ type: 'error', message: json.error.message ?? 'LLM 返回错误' })
  }
}
