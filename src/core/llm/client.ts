import type { LlmSettings } from '../config/settings'
import type { LlmChatMessage, LlmStreamEvent, LlmUsage, Transport } from '../bridge/types'
import { transport } from '../bridge'
import { AdapterError } from '../adapters/gitlab'

/**
 * LLM 客户端。
 *
 * 统一走流式接口：判定环节最终需要完整文本，但把中间增量回调出去，
 * UI 上就能实时看到模型在推理，长耗时不会让人以为卡死。
 */

export interface LlmCompletion {
  text: string
  usage?: LlmUsage
  durationMs: number
  /** 走到这里是否因为被取消或出错而中断 */
  errored?: string
}

export interface LlmCallOptions {
  jsonMode?: boolean
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

export class LlmClient {
  private readonly cfg: LlmSettings
  private readonly tp: Transport

  constructor(cfg: LlmSettings, tp?: Transport) {
    this.cfg = cfg
    this.tp = tp ?? transport()
  }

  get configured() {
    return Boolean(this.cfg.model?.trim())
      && (this.cfg.provider === 'openai-compatible' || this.cfg.apiKey.trim() !== '')
  }

  get label() {
    const vendor = this.cfg.provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'
    return `${vendor} · ${this.cfg.model || '未设置模型'}`
  }

  async complete(messages: LlmChatMessage[], opts: LlmCallOptions = {}): Promise<LlmCompletion> {
    this.assertConfigured()

    const started = performance.now()
    let text = ''
    let usage: LlmUsage | undefined
    let error: string | undefined

    const handle = await this.tp.llmStream(
      {
        provider: this.cfg.provider,
        baseUrl: this.cfg.baseUrl.trim(),
        apiKey: this.cfg.apiKey.trim(),
        model: this.cfg.model.trim(),
        messages,
        temperature: this.cfg.temperature,
        maxTokens: this.cfg.maxTokens,
        timeoutMs: this.cfg.timeoutMs,
        jsonMode: opts.jsonMode,
      },
      (event: LlmStreamEvent) => {
        if (event.type === 'delta') {
          text += event.text
          opts.onDelta?.(event.text)
        }
        else if (event.type === 'done') {
          usage = event.usage
        }
        else if (event.type === 'error') {
          error = event.message
        }
      },
    )

    // 外部取消信号透传到传输层，取消后 done 仍会 resolve，不会把 Promise 悬住
    if (opts.signal) {
      if (opts.signal.aborted)
        handle.cancel()
      else
        opts.signal.addEventListener('abort', () => handle.cancel(), { once: true })
    }

    await handle.done

    if (error && !text)
      throw new AdapterError(`模型调用失败：${error}`)

    return {
      text,
      usage,
      durationMs: Math.round(performance.now() - started),
      errored: error,
    }
  }

  private assertConfigured() {
    if (!this.cfg.model?.trim())
      throw new AdapterError('未配置 LLM 模型，请到「设置 → 模型」填写')
    if (this.cfg.provider === 'anthropic' && !this.cfg.apiKey.trim())
      throw new AdapterError('未配置 LLM API Key，请到「设置 → 模型」填写')
  }
}

export function createLlmClient(settings: LlmSettings, tp?: Transport) {
  return new LlmClient(settings, tp)
}
