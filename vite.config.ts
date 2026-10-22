import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

// Tauri 在 dev 时会注入 TAURI_DEV_HOST 用于局域网真机调试
const host = process.env.TAURI_DEV_HOST

/* ------------------------------------------------------------------ *
 * 脚手架样式文件的构建期 shim
 * ------------------------------------------------------------------ */

/**
 * shadcn-vue CLI 生成的 `src/styles/tailwind.css` 里有一行在当前工程里不适用：
 * Google Fonts 的 `@import url('https://fonts.googleapis.com/...')`。内网桌面应用不该外联，
 * 生产环境的 CSP 也会把它拦掉，结果是字体静默回退，反而更难排查。
 * 字体已在 theme.css 里用系统栈重新定义。
 *
 * 这行本该删掉，但 tailwind.css 属于脚手架生成物、不允许手工改动，
 * 否则每次 `shadcn-vue init` 之后都要重新删一遍，很容易忘。
 * 所以在构建期内存里剥掉，磁盘上的文件保持 CLI 原样，重新生成后无需任何手工补救。
 *
 * 拦截点必须选在入口文件上：Tailwind v4 用自己的解析器处理 `@import`，
 * 被 import 的 CSS 文件不会触发 Vite 的 load/transform，没有别的时机能拦住那一行。
 * 因此这里把入口里的本地 @import 自行内联展开，顺序保持不变。
 *
 * 注意：只剥这一行。同文件里的 `@import "shadcn-vue/tailwind.css"` 是必需的——
 * 那个文件定义了生成组件依赖的全部自定义变体（data-open / data-checked /
 * data-horizontal / shimmer 等），一旦误删，Tabs、Checkbox、Dialog 的样式会成片失效。
 */
const INAPPLICABLE_IMPORTS = [
  /^\s*@import\s+url\(\s*['"]https?:\/\/fonts\.googleapis\.com[^)]*\)\s*;?\s*$/,
]

const STYLE_ENTRY = 'src/styles/index.css'
/** 只内联相对路径的 import，包名（tailwindcss 等）留给 Tailwind 自己解析 */
const LOCAL_IMPORT_RE = /@import\s+['"](\.[^'"]+)['"]\s*;?/g

function stripInapplicableImports(css: string) {
  return css
    .split('\n')
    .filter(line => !INAPPLICABLE_IMPORTS.some(re => re.test(line)))
    .join('\n')
}

function scaffoldCssShim(): Plugin {
  return {
    name: 'app:scaffold-css-shim',
    enforce: 'pre',
    load(id) {
      // id 可能带 query，去掉后再比对
      const path = id.split('?')[0]
      if (!path.replaceAll('\\', '/').endsWith(STYLE_ENTRY))
        return null

      const entry = readFileSync(path, 'utf8')
      const inlined = entry.replace(LOCAL_IMPORT_RE, (_match, specifier: string) => {
        const file = resolvePath(dirname(path), specifier)
        return stripInapplicableImports(readFileSync(file, 'utf8'))
      })

      return inlined
    },
  }
}

export default defineConfig({
  plugins: [scaffoldCssShim(), vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Tauri 需要固定端口，端口被占用时直接失败而不是静默换端口
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // Rust 侧由 cargo 自己监视，vite 不用看
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Windows 上 Tauri 用 WebView2，支持现代语法，不必降到 es2015
    target: 'chrome110',
    sourcemap: !!process.env.TAURI_DEBUG,
    // 调试构建保留可读性，正式构建走 Vite 8 默认的 oxc 压缩
    minify: !process.env.TAURI_DEBUG,
  },
})
