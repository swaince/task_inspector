import type { Transport } from './types'
import { createTauriTransport } from './tauri'
import { createWebTransport } from './web'

function detectTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let instance: Transport | null = null

/** 单例传输层：桌面端用 Rust，浏览器里降级成 fetch + localStorage。 */
export function transport(): Transport {
  if (!instance)
    instance = detectTauri() ? createTauriTransport() : createWebTransport()
  return instance
}

export function isDesktop() {
  return detectTauri()
}

/**
 * 用系统默认浏览器打开外链。
 *
 * Tauri 的 webview 里直接 window.open 会被拦，必须交给系统处理。
 * 走官方 opener 插件而不是自己拼 shell 命令，避免 URL 里的特殊字符被当成命令解析。
 */
export async function openExternal(url: string) {
  if (!url)
    return
  if (!detectTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

export * from './types'
