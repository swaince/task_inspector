#!/usr/bin/env node
/**
 * 本地假 GitLab + 假模型服务，用于在没有真实实例时跑通整条链路。
 *
 * 存在的理由：仓库发现的分页、`membership=true` 的语义、提交时间窗和作者过滤、
 * 漏报判定，这些都只有在真拉一次数据时才能验证；而内部 GitLab 往往拿不到凭据。
 *
 * 只覆盖本工具实际用到的只读接口，数据是写死的，用于演示和自测，不要当成 GitLab 的行为规范。
 *
 *   node tools/mock-gitlab.mjs [--port 9939]
 *
 * 然后在「设置 → GitLab」里把实例地址填成 http://localhost:9939，
 * Token 随便填一个非空值（假服务不校验）。
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 9939

/* ------------------------------------------------------------------ *
 * 假数据
 * ------------------------------------------------------------------ */

const PROJECTS = [
  // default_branch 是真实接口里会返回的字段，统计提交要按它取分支，所以假数据也带上
  { id: 101, path_with_namespace: 'rd-platform/payment-gateway', name: 'payment-gateway', default_branch: 'main' },
  { id: 102, path_with_namespace: 'rd-platform/admin-console', name: 'admin-console', default_branch: 'main' },
  { id: 103, path_with_namespace: 'rd-platform/risk-engine', name: 'risk-engine', default_branch: 'develop' },
  { id: 104, path_with_namespace: 'infra/deploy-tools', name: 'deploy-tools', default_branch: 'main' },
  { id: 105, path_with_namespace: 'legacy/billing-old', name: 'billing-old', default_branch: 'master' },
]

/** 日期固定为 2026-10-16，落在默认时间窗（10-15 20:00 ~ 10-17 08:00）内 */
const COMMITS = {
  101: [
    {
      id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      author: '张伟',
      email: 'zhangwei@corp.com',
      date: '2026-10-16T10:23:00+08:00',
      title: '修复支付回调超时导致的重复扣款',
      body: '第三方回调超时后会重试，原逻辑没有幂等保护，导致同一笔订单被扣两次。\n引入回调去重表并补充重试退避。',
      files: ['src/pay/callback.ts', 'src/pay/retry.ts', 'src/pay/idempotent.ts'],
      stats: [128, 34],
    },
    {
      id: 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1',
      author: '张伟',
      email: 'zhangwei@corp.com',
      date: '2026-10-16T14:05:00+08:00',
      title: '补充支付回调重试的单元测试',
      body: '',
      files: ['test/pay/callback.spec.ts'],
      stats: [86, 3],
    },
    {
      id: 'c3d4e5f60718293a4b5c6d7e8f9012345678a1b2',
      author: '王强',
      email: 'wangqiang@corp.com',
      date: '2026-10-16T16:40:00+08:00',
      title: '调整第三方通道超时配置',
      body: '排查线上支付成功率下降，定位到通道超时阈值过短。',
      files: ['config/channel.yaml'],
      stats: [6, 4],
    },
    {
      // 张伟没在日报里提过的提交 → 应被判为漏报
      id: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8091234567890',
      author: '张伟',
      email: 'zhangwei@corp.com',
      date: '2026-10-16T19:30:00+08:00',
      title: '更新 CI 流水线缓存策略',
      body: '',
      files: ['.gitlab-ci.yml'],
      stats: [12, 8],
    },
  ],
  102: [
    {
      id: 'f6a7b8c9d0e1f2a3b4c5d6e7f809123456789012',
      author: '张伟',
      email: 'zhangwei@corp.com',
      date: '2026-10-16T15:20:00+08:00',
      title: '管理后台新增对账报表页面',
      body: '',
      files: ['src/views/reconcile/index.vue', 'src/views/reconcile/filters.vue'],
      stats: [240, 12],
    },
    {
      id: 'a7b8c9d0e1f2a3b4c5d6e7f80912345678901234',
      author: '张伟',
      email: 'zhangwei@corp.com',
      date: '2026-10-16T17:00:00+08:00',
      title: '联调对账导出接口',
      body: '',
      files: ['src/api/reconcile.ts'],
      stats: [64, 9],
    },
  ],
  103: [
    {
      id: 'b8c9d0e1f2a3b4c5d6e7f8091234567890123456',
      author: '王强',
      email: 'wangqiang@corp.com',
      date: '2026-10-16T09:40:00+08:00',
      title: '优化规则匹配性能，引入规则索引缓存',
      body: '单笔决策耗时从 80ms 降到 20ms。',
      files: ['src/engine/matcher.ts', 'src/engine/index-cache.ts'],
      stats: [156, 48],
    },
    {
      id: 'c9d0e1f2a3b4c5d6e7f809123456789012345678',
      author: '王强',
      email: 'wangqiang@corp.com',
      date: '2026-10-16T10:55:00+08:00',
      title: '补充规则匹配性能基准测试',
      body: '',
      files: ['bench/matcher.bench.ts'],
      stats: [48, 0],
    },
  ],
  104: [],
  105: [],
}

const USERS = [
  { id: 1, username: 'zhangwei', name: '张伟', email: 'zhangwei@corp.com' },
  { id: 2, username: 'lina', name: '李娜', email: 'lina@corp.com' },
  { id: 3, username: 'wangqiang', name: '王强', email: 'wangqiang@corp.com' },
]

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function projectRef(p) {
  return { ...p, web_url: `http://localhost:${PORT}/${p.path_with_namespace}` }
}

function commitBody(projectId, c) {
  const [additions, deletions] = c.stats
  return {
    id: c.id,
    short_id: c.id.slice(0, 8),
    title: c.title,
    message: c.body ? `${c.title}\n\n${c.body}` : c.title,
    author_name: c.author,
    author_email: c.email,
    authored_date: c.date,
    committed_date: c.date,
    created_at: c.date,
    web_url: `http://localhost:${PORT}/c/${c.id.slice(0, 8)}`,
    stats: { additions, deletions, total: additions + deletions },
  }
}

/**
 * 演示用的补丁内容。
 *
 * 故意留一条很长的 `+` 行：diff 的显示（按行上色、自动换行、超长行横向滚动）
 * 只有拿真实形状的数据才验证得了，早先那句「无真实 diff」什么都测不出来。
 */
const DEMO_PATCH = [
  '@@ -18,7 +18,11 @@ export class PaymentCallbackHandler {',
  '   async handle(callback: CallbackPayload): Promise<void> {',
  '-    await this.gateway.charge(callback.orderId, callback.amount)',
  '+    // 第三方回调超时后会重试，必须幂等：同一笔订单只允许扣一次，重复请求直接返回成功，不能再向银行发起扣款',
  '+    if (await this.dedupe.seen(callback.orderId, callback.requestId)) {',
  '+      this.logger.warn(`duplicate callback ignored: order=${callback.orderId} request=${callback.requestId}`)',
  '+      return',
  '+    }',
  '+    await this.gateway.charge(callback.orderId, callback.amount)',
  '   }',
  '',
  '   private async persist(record: ChargeRecord): Promise<void> {',
  '@@ -42,3 +46,4 @@ export class PaymentCallbackHandler {',
  '   private async retry(task: Task): Promise<void> {',
  '+    await sleep(this.backoff.next(task.attempt))',
  '   }',
].join('\n')

function diffBody(c) {
  return c.files.map((path) => ({
    old_path: path,
    new_path: path,
    a_mode: '100644',
    b_mode: '100644',
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: DEMO_PATCH,
  }))
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

function handleGitLab(pathname, query, res) {
  if (pathname === '/api/v4/version')
    return send(res, 200, { version: '17.4.0-mock', revision: 'mock' })

  if (pathname === '/api/v4/user') {
    return send(res, 200, { id: 1, username: 'inspector-bot', name: '核查机器人' })
  }

  if (pathname === '/api/v4/users') {
    const search = (query.get('search') || '').toLowerCase()
    return send(res, 200, USERS.filter(u => u.email.toLowerCase().includes(search) || u.username.includes(search)))
  }

  if (pathname === '/api/v4/projects') {
    // 真实 GitLab 里 membership=true 才等价于「我有权限的仓库」，这里照此实现：
    // 104/105 视为不属于当前用户，用来验证即便同步全部也不会越权拿到无关仓库。
    const scoped = query.get('membership') === 'true'
      ? PROJECTS.filter(p => p.id <= 103)
      : PROJECTS
    const search = query.get('search')
    const filtered = search
      ? scoped.filter(p => p.path_with_namespace.includes(search))
      : scoped

    const page = Number(query.get('page') || 1)
    const perPage = Number(query.get('per_page') || 20)
    const start = (page - 1) * perPage
    return send(res, 200, filtered.slice(start, start + perPage).map(projectRef))
  }

  const groupMatch = pathname.match(/^\/api\/v4\/groups\/(.+)\/projects$/)
  if (groupMatch) {
    const group = decodeURIComponent(groupMatch[1])
    const page = Number(query.get('page') || 1)
    const perPage = Number(query.get('per_page') || 20)
    const filtered = PROJECTS.filter(p => p.path_with_namespace === group || p.path_with_namespace.startsWith(`${group}/`))
    const start = (page - 1) * perPage
    return send(res, 200, filtered.slice(start, start + perPage).map(projectRef))
  }

  const projectMatch = pathname.match(/^\/api\/v4\/projects\/([^/]+)$/)
  if (projectMatch) {
    const key = decodeURIComponent(projectMatch[1])
    const project = PROJECTS.find(p => String(p.id) === key || p.path_with_namespace === key)
    if (!project)
      return send(res, 404, { message: '404 Project Not Found' })
    return send(res, 200, projectRef(project))
  }

  const diffMatch = pathname.match(/^\/api\/v4\/projects\/(\d+)\/repository\/commits\/([^/]+)\/diff$/)
  if (diffMatch) {
    const commits = COMMITS[Number(diffMatch[1])] || []
    const commit = commits.find(c => c.id === diffMatch[2])
    return send(res, 200, commit ? diffBody(commit) : [])
  }

  const commitsMatch = pathname.match(/^\/api\/v4\/projects\/(\d+)\/repository\/commits$/)
  if (commitsMatch) {
    const id = Number(commitsMatch[1])
    const since = query.get('since') ? new Date(query.get('since')) : null
    const until = query.get('until') ? new Date(query.get('until')) : null
    const author = query.get('author')

    let list = (COMMITS[id] || []).filter((c) => {
      const t = new Date(c.date)
      if (since && t < since) return false
      if (until && t >= until) return false
      // GitLab 的 author 参数接受 username 或 email
      if (author && c.email !== author && !c.email.startsWith(`${author}@`)) return false
      return true
    })

    const page = Number(query.get('page') || 1)
    const perPage = Number(query.get('per_page') || 20)
    const start = (page - 1) * perPage
    list = list.slice(start, start + perPage)

    return send(res, 200, list.map(c => commitBody(id, c)))
  }

  return send(res, 404, { message: `404 Not Found: ${pathname}` })
}

/* ------------------------------------------------------------------ *
 * 假模型：OpenAI 兼容的流式接口，返回一段写死的判定 JSON
 * ------------------------------------------------------------------ */

const JUDGEMENTS = [
  { match: /重构支付回调|重复扣款/, verdict: 'matched', confidence: 0.94, evidence: 2, reason: '提交 a1b2c3d4 修复了回调超时导致的重复扣款并补充了重试逻辑，b2c3d4e5 补充了对应单元测试，与描述完全对应。' },
  { match: /对账报表/, verdict: 'matched', confidence: 0.9, evidence: 2, reason: '提交 f6a7b8c9 新增了对账报表页面，a7b8c9d0 联调了导出接口，描述中的两个改动点都能找到对应。' },
  { match: /需求评审|会议/, verdict: 'no-commit', confidence: 0.85, evidence: 0, nonCoding: true, reason: '描述属于会议类工作，本就不产生代码提交；该项目当天确有其它人的提交，但与该描述无关。' },
  { match: /规则匹配性能|耗时/, verdict: 'matched', confidence: 0.92, evidence: 2, reason: '提交 b8c9d0e1 引入规则索引缓存，正对应「耗时从 80ms 降到 20ms」的性能优化，c9d0e1f2 补充了基准测试。' },
  { match: /支付成功率|通道超时/, verdict: 'matched', confidence: 0.88, evidence: 1, reason: '提交 c3d4e5f6 调整了第三方通道超时配置，与描述中定位到的问题一致。' },
]

function judge(content) {
  // 提示词里的提交形如 "[1] <完整 sha>  2026-10-16 10:23 ..."，据此还原 evidence
  const commitIds = [...content.matchAll(/\[\d+\]\s+([0-9a-f]{40})/g)].map(m => m[1])

  for (const j of JUDGEMENTS) {
    if (j.match.test(content)) {
      return {
        verdict: j.verdict,
        confidence: j.confidence,
        reason: j.reason,
        nonCodingWork: Boolean(j.nonCoding),
        evidence: commitIds.slice(0, j.evidence).map(id => ({
          commitId: id,
          relevance: '该提交的改动与描述中的改动点对应',
        })),
        suggestions: [],
      }
    }
  }
  return {
    verdict: 'unverified',
    confidence: 0.4,
    reason: '假模型没有为该描述准备判定，返回「无法核对」。',
    nonCodingWork: false,
    evidence: [],
    suggestions: [],
  }
}

function handleLlm(body, res) {
  const messages = body.messages || []
  const user = messages.filter(m => m.role === 'user').pop()?.content || ''
  const isSummary = user.includes('请写出当日结论')

  const text = isSummary
    ? '当日日报基本能被提交自证：支付回调、对账报表、风控性能优化三处描述都能找到对应提交。需要跟进的是「参加需求评审会议」一条属于会议类工作，无提交属正常，不必计入异常。另外发现 1 个提交没有被任何日报内容覆盖（更新 CI 流水线缓存策略），属于漏报，建议补充。'
    : JSON.stringify(judge(user))

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })

  // 分片发送，模拟真实流式，让前端和 Rust 侧的 SSE 解析都被走到
  const chunks = text.match(/[\s\S]{1,24}/g) || []
  let i = 0
  const timer = setInterval(() => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
      return
    }
    clearInterval(timer)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 800, completion_tokens: 120 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }, 15)

  res.on('close', () => clearInterval(timer))
}

/* ------------------------------------------------------------------ *
 * 服务器
 * ------------------------------------------------------------------ */

const server = createServer((req, res) => {
  // 浏览器预览模式下前端是 fetch 直连，需要放行跨域；桌面端走 Rust 不受影响
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname.startsWith('/api/v4/')) {
    console.log(`[gitlab] ${req.method} ${url.pathname}${url.search}`)
    return handleGitLab(url.pathname, url.searchParams, res)
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let raw = ''
    req.on('data', d => (raw += d))
    req.on('end', () => {
      console.log('[llm] POST /v1/chat/completions')
      let body = {}
      try {
        body = JSON.parse(raw)
      }
      catch { /* 传了非 JSON 就当空处理 */ }
      handleLlm(body, res)
    })
    return
  }

  send(res, 404, { message: `404 Not Found: ${url.pathname}` })
})

server.listen(PORT, () => {
  console.log(`假 GitLab + 假模型已启动：http://localhost:${PORT}`)
  console.log(`  仓库：${PROJECTS.length} 个（membership=true 时返回 3 个）`)
  console.log(`  GitLab 实例地址填 http://localhost:${PORT}，Token 填任意非空值`)
  console.log(`  模型：OpenAI 兼容，接口地址填 http://localhost:${PORT}，模型名填 mock-judge`)
})
