/**
 * 主题跟随系统。
 *
 * styles/tailwind.css 和 theme.css 里都写了 `.dark` 下的一整套变量，
 * 但应用里原本没有任何地方会加上这个类，整套深色样式其实是不可达的。
 * 桌面应用跟随系统外观是标准做法，这里把它接上。
 *
 * 需要「手动切换 / 记住用户选择」时，把这里的 auto 逻辑改成读配置即可——
 * 加个 settings.theme = 'auto' | 'light' | 'dark'，dark 时无条件加类，
 * light 时无条件去掉，auto 时走下面这套。
 */

const MEDIA = '(prefers-color-scheme: dark)'

function sync(isDark: boolean) {
  document.documentElement.classList.toggle('dark', isDark)
}

/** 挂载前调用一次，之后再持续跟随系统切换。 */
export function applyPreferredTheme() {
  if (typeof window === 'undefined' || !window.matchMedia)
    return

  const media = window.matchMedia(MEDIA)
  sync(media.matches)
  media.addEventListener('change', e => sync(e.matches))
}
