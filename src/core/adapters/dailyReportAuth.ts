import type { DailyReportLoginSettings, DailyReportSettings } from '../config/settings'
import type { Transport } from '../bridge/types'
import { transport } from '../bridge'
import { AdapterError } from './gitlab'
import { pick } from './dailyReport'

/**
 * 日报系统的登录会话。
 *
 * 内部系统的鉴权方式：把「用户名 + 验证码 key + 密码」整体 Base64 后作为 loginInfo，
 * 连同 key / code / type 以 x-www-form-urlencoded 提交到 /login，
 * 成功后拿到 accessToken，后续请求带在 X-Token 头里。
 *
 * 这里没有复刻它的 AES——那段 AES-ECB 只用于「记住密码」写 localStorage，
 * 登录请求本身用的就是 Base64，不是加密。
 *
 * ## 会话保持
 *
 * 服务端的空闲计时看的是「有没有请求」，所以想在失效前保住会话就得真的发请求。
 * 分三层处理，按可靠性从高到低：
 *
 *   1. **探活**：配了探活接口就按频率打一下，会话不会断
 *   2. **主动重登**：知道空闲时间但没配探活接口时，在失效前重新登录
 *   3. **被动重登**：以上都没有时，等请求被 401 打回再重登
 *
 * 配了空闲时间的话，第 2 层还能避免一次注定失败的请求——
 * 不然每次过期都要先浪费一个 401 往返。
 */

/** 标准 Base64（UTF-8 输入，带填充），与前端 `Ve()` 的行为一致 */
export function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * 生成验证码 key。
 *
 * 服务端会**读**这个字段（即使 type=0 的用户名密码登录不做校验），
 * 字段缺失或为空串时它照样会报错，所以拿不到真实验证码时也要补一个。
 * 走用户名密码登录本来就不需要真的对验证码，给个唯一值即可。
 */
export function randomCaptchaKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()
  // 老 webview 没有 randomUUID 时的退路，这里只要唯一，不强求密码学强度
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** 验证码内容。同一个道理：不给真的也要给个非空值，否则服务端可能直接判参数不合法 */
export function randomCaptchaCode(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase()
}

/**
 * 拼接口地址。
 *
 * 根地址和路径是两个独立字段，很容易把接口前缀同时写进两边
 * （根地址填 `.../api`，路径又填 `/api/login`），拼出来是 `/api/api/login`。
 * 服务端只会回 404，从报错里完全看不出是拼接的问题，所以这里直接拦下来。
 */
export function joinApiUrl(root: string, path: string): string {
  const base = root.trim().replace(/\/+$/, '')
  if (!base)
    throw new AdapterError('未配置接口根地址')

  const trimmed = path.trim()
  const suffix = trimmed.startsWith('/') ? trimmed : `/${trimmed}`

  // 比对根地址的最后一段和路径的第一段：相同说明前缀被写了两遍
  const rootSeg = base.split('/').pop() ?? ''
  const pathSeg = suffix.split('/')[1] ?? ''
  if (rootSeg && pathSeg && rootSeg === pathSeg) {
    throw new AdapterError(
      `接口地址拼出来是「${base}${suffix}」，「${rootSeg}」重复了。`
      + '根地址只填协议 + 主机 + 端口（如 https://192.168.2.21:51443），'
      + '接口前缀属于路径的一部分（如 /api/login）。',
    )
  }

  return base + suffix
}

export interface LoginResult {
  token: string
  userId?: string
  /** 本次登录实际发出去的验证码字段，便于确认「没配也能登上去」是真的补上了 */
  captcha: CaptchaUsed
  /** 服务端返回的原始 data 段，便于排查 */
  raw: unknown
}

export interface CaptchaUsed {
  key: string
  code: string
  keyGenerated: boolean
  codeGenerated: boolean
}

/**
 * 最近一次登录「到底发了什么、回了什么」。
 *
 * 登录失败时服务端通常只回一句「用户名或密码错误」，看不出是地址错了、
 * 字段名不对、还是 `loginInfo` 的拼接顺序不对。把这些原样摊开，
 * 对比一下真实前端发出的请求就能定位。
 *
 * 密码和 `loginInfo` 都做过打码，可以安全显示在界面上。
 */
export interface LoginAttempt {
  url: string
  contentType: string
  /** 实际发出去的表单字段 */
  fields: Record<string, string>
  /** `loginInfo` 解出来的明文（密码打码），用来核对拼接顺序 */
  loginInfoPlain: string
  /** 没发出去就失败时为 null，例如地址不合法 */
  status: number | null
  responseBody: string | null
  error: string | null
}

const MASK = '••••••'

/** 把明文里的密码换成占位符，避免诊断信息里带出凭据 */
function maskSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join(MASK) : text
}

export interface SessionStatus {
  loggedIn: boolean
  /** 上次拿到 token 的时刻 */
  loginAt: number | null
  /** 上次成功发起请求的时刻，用于算空闲时长 */
  lastActivityAt: number | null
  /** 距离空闲失效还有多少分钟；null 表示没配空闲时间 */
  idleRemainingMinutes: number | null
  keepAliveActive: boolean
  /** 最近一次探活/重登失败的原因，成功后清空 */
  lastError: string | null
}

export class DailyReportSession {
  private token: string | null = null
  private userId: string | undefined
  /** 正在进行中的登录，避免并发请求同时触发多次登录 */
  private pending: Promise<LoginResult> | null = null
  private loginAt: number | null = null
  private lastActivityAt: number | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private lastError: string | null = null
  /** 最近一次登录用的验证码字段，供界面上确认自动补值生效 */
  private lastCaptcha: CaptchaUsed = { key: '', code: '', keyGenerated: false, codeGenerated: false }
  /** 最近一次登录的请求/响应全貌，登录失败时靠它定位 */
  private lastAttempt: LoginAttempt | null = null

  private readonly tp: Transport
  private readonly settings: DailyReportLoginSettings
  private readonly baseUrl: string
  /** 会话也受「跳过证书校验」影响，所以它算配置指纹的一部分 */
  private readonly allowInsecureTls: boolean
  /** 配置变了就重建会话，所以这里存一份快照用于比对 */
  private readonly configKey: string

  constructor(
    settings: DailyReportLoginSettings,
    baseUrl: string,
    allowInsecureTls = false,
    tp?: Transport,
  ) {
    this.settings = settings
    this.baseUrl = baseUrl
    this.allowInsecureTls = allowInsecureTls
    this.tp = tp ?? transport()
    /*
     * 地址必须进指纹。
     *
     * 会话是单例，而这个 store 在配置从库里读回来之前就已经挂载了——
     * 设置页一打开，那个 5 秒刷新的状态栏就会拿「地址还是空」的配置建出会话。
     * 指纹里不带地址的话，用户随后填好地址也不会重建，登录永远用着空地址，
     * 报的是「未配置接口根地址」——而用户明明配了。
     *
     * 顺带也防住更糟的一种：换了服务端却继续拿旧服务端的 token 去请求。
     */
    this.configKey = JSON.stringify([settings, baseUrl, allowInsecureTls])
  }

  get enabled() {
    return this.settings.enabled
  }

  get hasToken() {
    return Boolean(this.token)
  }

  /** 最近一次登录发了什么、回了什么 */
  get attempt(): LoginAttempt | null {
    return this.lastAttempt
  }

  /** 配置是否和建会话时一致；不一致说明该换一个会话了 */
  matches(settings: DailyReportLoginSettings, baseUrl: string, allowInsecureTls: boolean) {
    return this.configKey === JSON.stringify([settings, baseUrl, allowInsecureTls])
  }

  status(): SessionStatus {
    const idle = this.settings.idleTimeoutMinutes
    const remaining = idle > 0 && this.lastActivityAt
      ? Math.max(0, idle - (Date.now() - this.lastActivityAt) / 60_000)
      : null

    return {
      loggedIn: Boolean(this.token),
      loginAt: this.loginAt,
      lastActivityAt: this.lastActivityAt,
      idleRemainingMinutes: remaining,
      keepAliveActive: this.keepAliveTimer !== null,
      lastError: this.lastError,
    }
  }

  /** 清除 token 与探活定时器，下次请求会重新登录 */
  invalidate() {
    this.token = null
    this.userId = undefined
    this.stopKeepAlive()
  }

  /** 彻底停掉这个会话（配置变更或应用退出时） */
  dispose() {
    this.invalidate()
    this.pending = null
  }

  /** 记一次成功的请求，用于算空闲时长 */
  noteActivity() {
    this.lastActivityAt = Date.now()
  }

  /** 拿一个可用的 token；已登录过就直接复用 */
  async ensureToken(): Promise<string | null> {
    if (!this.settings.enabled)
      return null

    // 空闲时间已知、且已经用掉九成时，主动重登而不是等请求被 401 打回。
    // 留一成余量是为了覆盖请求在途的那点时间。
    if (this.token && this.isNearIdleExpiry()) {
      this.invalidate()
    }

    if (this.token)
      return this.token

    const result = await this.login()
    return result.token
  }

  private isNearIdleExpiry(): boolean {
    const idle = this.settings.idleTimeoutMinutes
    if (idle <= 0 || !this.lastActivityAt)
      return false
    const usedMinutes = (Date.now() - this.lastActivityAt) / 60_000
    return usedMinutes >= idle * 0.9
  }

  async login(): Promise<LoginResult> {
    if (this.pending)
      return this.pending

    this.pending = this.doLogin()
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }

  private async doLogin(): Promise<LoginResult> {
    const s = this.settings
    if (!s.username.trim())
      throw new AdapterError('未配置日报系统的登录用户名')
    if (!s.path.trim())
      throw new AdapterError('未配置登录接口路径')

    const url = joinApiUrl(this.baseUrl, s.path)

    /*
     * key / code 必须有值。
     *
     * 服务端即使不做校验也会读这两个字段，缺了会直接报参数错——「服务器没用到」
     * 和「服务器可以没有」是两回事。用户名密码登录本来就不需要真验证码，
     * 所以没配就现场补一个，每次登录换一组。
     */
    const captchaKey = s.captchaKey.trim() || randomCaptchaKey()
    const captchaCode = s.captchaCode.trim() || randomCaptchaCode()
    this.lastCaptcha = {
      key: captchaKey,
      code: captchaCode,
      keyGenerated: !s.captchaKey.trim(),
      codeGenerated: !s.captchaCode.trim(),
    }

    // 拼接顺序与原前端一致：用户名 + 验证码 key + 密码，整体 Base64。
    // 这里用的是上面那个**实际发出去**的 key——两处不一致的话，
    // 服务端按 key 字段去切 loginInfo 就会切错位置
    const loginInfo = base64Utf8(s.username + captchaKey + s.password)

    const fields: Record<string, string> = {
      loginInfo,
      key: captchaKey,
      code: captchaCode,
      type: String(s.type),
    }

    const isForm = s.bodyFormat !== 'json'
    const contentType = isForm
      ? 'application/x-www-form-urlencoded'
      : 'application/json;charset=utf-8'
    const body = isForm ? new URLSearchParams(fields).toString() : JSON.stringify(fields)

    // 在发请求之前就把「发了什么」记下来：请求本身也可能抛（地址不合法、连不上），
    // 那时候更需要知道发的是什么。loginInfo 是 Base64，只报长度并单独给解码后的明文
    this.lastAttempt = {
      url,
      contentType,
      fields: { ...fields, loginInfo: `（Base64，${loginInfo.length} 字符）` },
      loginInfoPlain: maskSecret(s.username + captchaKey + s.password, s.password),
      status: null,
      responseBody: null,
      error: null,
    }

    let res
    try {
      res = await this.tp.http({
        url,
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': contentType },
        body,
        timeoutMs: 30000,
        allowInsecureTls: this.allowInsecureTls,
      })
    }
    catch (err) {
      // 连不上/超时/证书被拒这类失败没有 HTTP 状态码，得单独记下来，
      // 否则界面上只剩一句「fetch failed」，看不出是网络问题
      this.lastAttempt.error = err instanceof Error ? err.message : String(err)
      throw err
    }

    this.lastAttempt.status = res.status
    this.lastAttempt.responseBody = res.body.slice(0, 600)

    if (!res.ok) {
      throw new AdapterError(
        describeLoginHttpError(res.status),
        res.status,
        res.body.slice(0, 300),
      )
    }

    let json: any
    try {
      json = JSON.parse(res.body)
    }
    catch {
      throw new AdapterError(
        bodyLooksLikeHtml(res.body)
          ? '登录接口返回的是 HTML 而不是 JSON，多半是路径不对（打到了前端页面或网关的错误页），'
            + '检查「登录接口路径」和「接口根地址」拼出来的地址'
          : '登录接口返回的不是合法 JSON',
        res.status,
        res.body.slice(0, 300),
      )
    }

    // 业务码不是 200 时，把服务端的话原样带出来——「用户名或密码错误」这类信息只有它有。
    //
    // 注意 code 是字符串（实测返回 "401"），不能直接和数字 200 比：
    // `"200" !== 200` 为真，那样连登录成功都会被当成失败。
    const code = json?.code
    if (code !== undefined && String(code) !== '200')
      throw new AdapterError(describeLoginFailure(json), res.status)

    const token = pick(json, s.tokenPath)
    if (typeof token !== 'string' || !token) {
      throw new AdapterError(
        `登录成功但没在「${s.tokenPath}」取到 token，请检查该字段的路径是否正确。`
        + `服务端返回：${JSON.stringify(json).slice(0, 300)}`,
      )
    }

    this.token = token
    this.loginAt = Date.now()
    this.noteActivity()
    this.lastError = null

    const userId = pick(json, 'data.userId')
    this.userId = typeof userId === 'string' ? userId : undefined

    this.startKeepAlive()

    return { token, userId: this.userId, captcha: this.lastCaptcha, raw: json?.data ?? json }
  }

  /* ------------------------------------------------------------------ *
   * 会话保持
   * ------------------------------------------------------------------ */

  /**
   * 登录成功后启动会话保持。
   *
   * 频率的取法，按可靠性从高到低：
   *   1. 显式配了频率就用配的
   *   2. 知道空闲时间 → 取它的 2/3，留出的余量要能覆盖一次请求往返
   *   3. 只配了探活接口、不知道空闲时间 → 用 5 分钟的保守默认值。
   *      这里不能留 0：配了探活接口却因为推不出频率而不跑，是最难查的一种「配了没生效」
   */
  private startKeepAlive() {
    this.stopKeepAlive()

    const idle = this.settings.idleTimeoutMinutes
    const explicit = this.settings.keepAliveIntervalMinutes
    const hasPath = Boolean(this.settings.keepAlivePath.trim())

    if (!hasPath && idle <= 0)
      return

    const intervalMinutes = explicit > 0
      ? explicit
      : (idle > 0 ? Math.max(1, Math.floor((idle * 2) / 3)) : 5)

    this.keepAliveTimer = setInterval(
      () => void this.keepAliveTick(),
      intervalMinutes * 60_000,
    )
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private async keepAliveTick() {
    if (!this.token)
      return

    const path = this.settings.keepAlivePath.trim()

    try {
      if (path) {
        // 探活是真的发一个请求：服务端的空闲计时看的就是「有没有请求」
        const res = await this.tp.http({
          url: joinApiUrl(this.baseUrl, path),
          method: 'GET',
          headers: {
            'accept': 'application/json',
            [this.settings.tokenHeader.trim() || 'X-Token']: this.token,
          },
          timeoutMs: 20000,
          allowInsecureTls: this.allowInsecureTls,
        })

        if (res.status === 401 || res.status === 403) {
          // 探活被打回说明会话已经没了，重登一次
          this.invalidate()
          await this.login()
          return
        }
        this.noteActivity()
        this.lastError = null
        return
      }

      // 没配探活接口，又知道空闲时间：只能靠重新登录把会话续上
      if (this.isNearIdleExpiry()) {
        this.invalidate()
        await this.login()
      }
    }
    catch (err) {
      // 探活失败不能影响正常使用，记下来等下次真实请求时兜底
      this.lastError = err instanceof Error ? err.message : String(err)
    }
  }
}

/** 响应正文看起来是 HTML 页面（打到前端或网关错误页了），而不是接口返回 */
function bodyLooksLikeHtml(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<head>')
}

/** 登录请求的 HTTP 层错误。这里没有业务信息，只能给可照做的方向 */
function describeLoginHttpError(status: number): string {
  if (status === 404)
    return '登录接口返回 HTTP 404：地址不对，检查「接口根地址 + 登录接口路径」拼出来的 URL'
  if (status === 405)
    return '登录接口返回 HTTP 405：方法不对，登录应当是 POST'
  if (status === 415)
    return '登录接口返回 HTTP 415：请求体编码不对，试试把「请求体编码」换成另一种'
  if (status >= 500)
    return `登录接口返回 HTTP ${status}：服务端自己出错了，不是配置问题，可以拿下面的请求内容找后端确认`
  return `登录接口返回 HTTP ${status}`
}

/** 把登录失败的响应翻译成能直接展示的提示 */
function describeLoginFailure(json: any): string {
  // 这个系统把给人看的错误放在 data 里，且是字符串（不是 data.message）
  if (typeof json?.data === 'string' && json.data)
    return `登录失败：${json.data}`

  const message = json?.message ?? json?.msg ?? json?.data?.message
  if (typeof message === 'string' && message)
    return `登录失败：${message}`

  return `登录失败：服务端返回 code=${json?.code}`
}

/* ------------------------------------------------------------------ *
 * 会话单例
 * ------------------------------------------------------------------ */

let cached: DailyReportSession | null = null

/**
 * 取当前配置对应的会话。
 *
 * 做成单例有两个理由：token 和探活定时器要跨多次检查复用（每次检查新建一个会话，
 * 探活就白做了）；配置一改就重建，避免拿着旧账号的 token 去请求。
 */
export function getDailyReportSession(cfg: DailyReportSettings, tp?: Transport): DailyReportSession {
  if (cached && !cached.matches(cfg.login, cfg.baseUrl, cfg.allowInsecureTls)) {
    cached.dispose()
    // 必须真的置空：dispose() 只是清 token 和定时器，引用还在，
    // 漏掉这一行的话下面 `if (!cached)` 不成立，重建分支永远进不去，
    // 拿到的还是那个已经作废、配置是旧的会话
    cached = null
  }

  if (!cached)
    cached = new DailyReportSession(cfg.login, cfg.baseUrl, cfg.allowInsecureTls, tp)

  return cached
}

/** 供测试与「退出登录」使用 */
export function resetDailyReportSession() {
  cached?.dispose()
  cached = null
}
