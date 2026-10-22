import type { Extensions, MarkdownProviderContext } from 'vue-stream-markdown'
import { code } from '@stream-markdown/code'
import { math } from '@stream-markdown/math'
import { useMarkdownProvider } from 'vue-stream-markdown'

/*
 * 不注册 mermaid 扩展。
 *
 * 应用的图表由自己的 ReportChart 渲染，报告提示词也禁止模型输出 mermaid；
 * 而这个扩展依赖运行时安装 mermaid 包或配置 CDN，两者都没有时会在渲染阶段报错。
 * 需要 mermaid 时请显式安装依赖并在这里加回来。
 */
export function useMarkdownExtensions(): {
  provider: MarkdownProviderContext | undefined
  extensions: Extensions | undefined
} {
  const provider = useMarkdownProvider()
  const extensions = provider
    ? undefined
    : {
        code: code(),
        math: math(),
      }

  return { provider, extensions }
}
