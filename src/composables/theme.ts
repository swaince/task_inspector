import type { ThemeMode } from '@/core/config/settings'

/**
 * 主题应用。
 *
 * 默认跟随系统；用户可以在页头手动切到浅色或深色。
 * 主题类在挂载前先按系统挂一次（避免深色系统下闪浅色），
 * 设置加载完后再按保存的偏好覆盖。
 */

const MEDIA = '(prefers-color-scheme: dark)'

let media: MediaQueryList | null = null
let listener: ((event: MediaQueryListEvent) => void) | null = null

function sync(isDark: boolean) {
  document.documentElement.classList.toggle('dark', isDark)
}

export function applyTheme(mode: ThemeMode = 'auto') {
  if (typeof window === 'undefined' || !window.matchMedia)
    return

  if (!media)
    media = window.matchMedia(MEDIA)

  // 每次切换先摘掉上一次的监听，避免手动模式下还被系统变化改回去
  if (listener) {
    media.removeEventListener('change', listener)
    listener = null
  }

  if (mode === 'auto') {
    listener = event => sync(event.matches)
    media.addEventListener('change', listener)
    sync(media.matches)
    return
  }

  sync(mode === 'dark')
}

/** 挂载前的兜底：设置还没读出来时先跟随系统。 */
export function applyPreferredTheme() {
  applyTheme('auto')
}
