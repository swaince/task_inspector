import type { BuiltinTool, BuiltinToolContext, PreparedAction } from '../types'
import type { ShellRunResult } from '@/core/bridge/types'
import { transport } from '@/core/bridge'
import { uid } from '@/lib/format'

/**
 * 项目对话的本机命令工具。
 *
 * 执行前必须经过用户确认；这里只负责把模型给的参数变成一条「可展示、可执行」的动作。
 * cwd 的最终校验在 Rust 侧再做一次，前端这一层只是先拦住明显错误的路径。
 */

export const SHELL_TOOL_ID = 'shell.run'
export const SHELL_SERVER_ID = 'builtin-shell'
export const SHELL_QUALIFIED_NAME = 'builtin_shell__run'
export const MAX_SHELL_COMMAND_CHARS = 8_000
export const MIN_SHELL_TIMEOUT_MS = 5_000
export const MAX_SHELL_TIMEOUT_MS = 300_000
export const DEFAULT_SHELL_TIMEOUT_MS = 60_000
const MAX_TRACE_CHARS = 6_000
const MAX_REASON_CHARS = 500

export interface ShellRisk {
  level: 'normal' | 'high'
  matches: string[]
}

export interface ParsedShellCall {
  command: string
  cwd: string
  reason: string
  timeoutMs: number
}

interface RiskPattern {
  label: string
  pattern: RegExp
}

const RISK_PATTERNS: RiskPattern[] = [
  { label: 'rm', pattern: /\brm\s+/i },
  { label: 'rm -rf', pattern: /\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-[a-z]*f[a-z]*r\b/i },
  { label: 'Remove-Item', pattern: /\bRemove-Item\b/i },
  { label: 'Remove-Item -Recurse -Force', pattern: /Remove-Item[^\n]*(-Recurse[^\n]*-Force|-Force[^\n]*-Recurse)/i },
  { label: 'Remove-Item -Recurse', pattern: /Remove-Item[^\n]*-Recurse/i },
  { label: 'del', pattern: /\bdel\s+/i },
  { label: 'del /s', pattern: /\bdel\s+\/[fsq]/i },
  { label: 'rmdir /s', pattern: /\b(rmdir|rd)\s+\/s/i },
  { label: 'format', pattern: /\bformat\s+[a-z]:/i },
  { label: '关机/重启', pattern: /\b(shutdown|reboot|halt|Restart-Computer|Stop-Computer)\b/i },
  { label: '磁盘写入', pattern: /\bmkfs\b|\bdd\s+if=|>\s*\/dev\//i },
  { label: 'git reset --hard', pattern: /\bgit\s+reset\s+--hard\b/i },
  { label: 'git clean -f', pattern: /\bgit\s+clean\s+-[a-z]*f/i },
  { label: 'git push --force', pattern: /\bgit\s+push\b[^\n]*(--force|-f)\b/i },
  { label: '发布包', pattern: /\b(npm|pnpm|yarn)\s+publish\b/i },
  { label: '全局安装', pattern: /\bnpm\s+install\s+-g\b/i },
  { label: 'pip 安装/卸载', pattern: /\bpip3?\s+(install|uninstall)\b/i },
  { label: '下载后直接执行', pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash)\b/i },
  { label: '动态执行', pattern: /\b(Invoke-Expression|iex)\b|Set-ExecutionPolicy/i },
  { label: '放开权限', pattern: /chmod\s+-R\s+777|chown\s+-R/i },
  { label: '容器/集群清理', pattern: /docker\s+(system\s+prune|rm\s+-f)|kubectl\s+delete|terraform\s+destroy/i },
  { label: '删表', pattern: /\b(DROP|TRUNCATE)\s+TABLE\b/i },
]

export function assessShellCommand(command: string): ShellRisk {
  const matches: string[] = []
  for (const item of RISK_PATTERNS) {
    if (item.pattern.test(command) && !matches.includes(item.label))
      matches.push(item.label)
  }
  return {
    level: matches.length ? 'high' : 'normal',
    matches: matches.slice(0, 6),
  }
}

const READ_ONLY_PREFIXES = [
  'git status',
  'git log',
  'git diff',
  'git show',
  'git rev-parse',
  'git ls-files',
  'ls',
  'dir',
  'get-childitem',
  'cat',
  'type',
  'get-content',
  'head',
  'tail',
  'rg',
  'grep',
  'findstr',
  'select-string',
  'pwd',
  'get-location',
  'test-path',
  'where',
  'which',
  'get-command',
  'node --version',
  'npm ls',
  'pnpm list',
  'go version',
  'java -version',
]

/** 只是提示，不能拿它跳过确认 */
export function looksReadOnly(command: string): boolean {
  const text = command.trim()
  if (!text || /[;&|<>`\n\r]/.test(text))
    return false

  const lower = text.toLowerCase()
  if (lower.startsWith('git branch')) {
    return !/\s(-d|-D|--delete|-m|-M|--move|--edit-description)\b/.test(text)
  }
  if (lower.startsWith('git remote')) {
    return /\s(-v|--verbose|show|get-url)\b/.test(text)
  }
  return READ_ONLY_PREFIXES.some(prefix =>
    lower === prefix || lower.startsWith(`${prefix} `) || lower.startsWith(`${prefix}\t`),
  )
}

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function parseShellCall(
  args: Record<string, unknown>,
  projectPaths: string[],
  defaultTimeoutMs: number,
): ParsedShellCall {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command)
    throw new Error('命令为空')
  if (command.length > MAX_SHELL_COMMAND_CHARS)
    throw new Error(`命令过长（上限 ${MAX_SHELL_COMMAND_CHARS} 字符）`)
  if (command.includes('\0'))
    throw new Error('命令包含非法字符')

  const requestedCwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
  let cwd = ''
  if (requestedCwd) {
    cwd = projectPaths.find(path => normalizePath(path) === normalizePath(requestedCwd)) ?? ''
    if (!cwd)
      throw new Error('命令的工作目录不在项目本地仓库列表中，已拒绝执行')
  }
  else {
    cwd = projectPaths[0] ?? ''
  }
  if (!cwd)
    throw new Error('当前项目没有可用的本地仓库目录')

  const reason = typeof args.reason === 'string' && args.reason.trim()
    ? clip(args.reason.trim(), MAX_REASON_CHARS)
    : '模型没有说明执行目的'

  const requestedSeconds = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
    ? args.timeoutSeconds
    : defaultTimeoutMs / 1000
  const timeoutMs = Math.min(
    MAX_SHELL_TIMEOUT_MS,
    Math.max(MIN_SHELL_TIMEOUT_MS, Math.round(requestedSeconds * 1000)),
  )

  return { command, cwd, reason, timeoutMs }
}

export function formatShellResult(result: ShellRunResult): string {
  const status = result.timedOut
    ? '状态：超时终止'
    : result.cancelled
      ? '状态：已取消'
      : `退出码：${result.exitCode ?? '无'}`
  const meta = [
    status,
    `用时：${(result.durationMs / 1000).toFixed(1)}s`,
    result.truncated ? '输出已截断（上限 100000 字符）' : '',
  ].filter(Boolean).join(' · ')
  const body = result.output.trim() || '（命令没有输出）'
  return clip(`${meta}\n${body}`, MAX_TRACE_CHARS)
}

export function createShellTool(
  projectPaths: string[],
  defaultTimeoutMs = DEFAULT_SHELL_TIMEOUT_MS,
): BuiltinTool {
  return {
    descriptor: {
      id: SHELL_TOOL_ID,
      source: 'builtin',
      serverId: SHELL_SERVER_ID,
      serverName: 'builtin_shell',
      name: 'run',
      qualifiedName: SHELL_QUALIFIED_NAME,
      description: '在项目本地仓库目录执行一条本机命令，需要用户逐条确认。优先只读命令；不要安装、发布、推送、部署或执行交互式命令，除非用户明确要求。一次只执行一条命令，并在 reason 里说明目的。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令，一行一条' },
          cwd: {
            type: 'string',
            description: '命令的工作目录，必须是项目本地仓库之一',
            enum: projectPaths,
          },
          reason: { type: 'string', description: '为什么要执行这条命令，用一句中文说明' },
          timeoutSeconds: {
            type: 'integer',
            minimum: MIN_SHELL_TIMEOUT_MS / 1000,
            maximum: MAX_SHELL_TIMEOUT_MS / 1000,
            description: '超时时间（秒），默认使用设置里的值',
          },
        },
        required: ['command', 'cwd', 'reason'],
      },
      readOnly: false,
    },

    async prepare(args, ctx: BuiltinToolContext) {
      const parsed = parseShellCall(args, ctx.projectPaths, defaultTimeoutMs)
      const risk = assessShellCommand(parsed.command)
      const readOnlyHint = looksReadOnly(parsed.command)

      const action: PreparedAction = {
        approval: {
          id: uid(),
          kind: 'shell',
          title: '模型请求执行本机命令',
          summary: [
            readOnlyHint
              ? '看起来是只读命令（仅为提示，仍会真实执行）'
              : '这是一条会真实执行的命令',
            risk.level === 'high' ? '命中高风险模式，请逐字检查后再决定' : '',
          ].filter(Boolean),
          details: [
            { label: '目的', value: parsed.reason },
            { label: '工作目录', value: parsed.cwd, mono: true },
            { label: '超时', value: `${Math.round(parsed.timeoutMs / 1000)} 秒` },
          ],
          command: {
            text: parsed.command,
            cwd: parsed.cwd,
            timeoutMs: parsed.timeoutMs,
          },
          risk,
          readOnlyHint,
        },
        apply: async () => {
          const signal = ctx.signal
          if (signal?.aborted)
            throw new Error('已取消')

          const runId = uid()
          const cancel = () => {
            void transport().shellCancel(runId)
          }
          signal?.addEventListener('abort', cancel, { once: true })

          try {
            const result = await transport().shellRun(
              {
                command: parsed.command,
                cwd: parsed.cwd,
                allowedCwds: ctx.projectPaths,
                timeoutMs: parsed.timeoutMs,
                runId,
              },
              () => {
                // 输出目前只进最终 trace；保留回调，后续可以接实时预览
              },
            )
            return {
              text: formatShellResult(result),
              meta: {
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                cancelled: result.cancelled,
                truncated: result.truncated,
              },
            }
          }
          finally {
            signal?.removeEventListener('abort', cancel)
          }
        },
      }

      return { kind: 'action', action }
    },
  }
}
