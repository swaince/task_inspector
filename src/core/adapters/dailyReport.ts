import type { DailyReportSettings } from '../config/settings'
import type { DailyReport, DailyReportEntry } from '../domain/types'
import type { Transport } from '../bridge/types'
import { transport } from '../bridge'
import { AdapterError } from './gitlab'
import { getDailyReportSession, joinApiUrl } from './dailyReportAuth'
import type { DailyReportSession } from './dailyReportAuth'

/**
 * 日报数据源适配器。
 *
 * 内部日报系统的接口形状各家不同，所以响应结构靠 settings.dailyReport.fieldMap
 * 里的点号路径来映射，而不是写死字段名。另外提供 CSV 导入和演示数据两条
 * 不依赖外部系统的路径，方便先跑通检查流程再对接真实接口。
 */

export interface DailyReportSource {
  fetchByDate(date: string): Promise<DailyReport[]>
  /**
   * 一次拉一段日期。
   *
   * 日志系统可以补写（提交后还能改），所以「按天查」本身没问题；
   * 但项目活动要扫一段区间，逐天各发一次请求既慢又容易被打断，
   * 能一次窗口拉回来的就一次拉。不支持区间查询的实现可以不提供。
   */
  fetchRange?(from: string, to: string): Promise<DailyReport[]>
  describe(): string
}

/** 日志系统里的项目：业务实体，自带项目编号 */
export interface LogSystemProject {
  /** 日志中心的项目 ID —— 项目的稳定身份，本地存成 logProjectId */
  id?: string
  name: string
  /** 业务项目编号，如 DF-XM2021-405。对应本地项目的「编码」 */
  number?: string
}

/**
 * 日志中心里的用户。
 *
 * **这里刻意没有密码字段。** 那个接口会把 `loginPwd` 一起返回（这是个接口设计问题），
 * 但密码一旦进入我们的数据结构，就会顺着序列化落进数据库、日志、导出文件。
 * 所以只挑需要的字段，其余一律不碰。
 */
export interface LogSystemUser {
  /** 日志中心用户 ID，等于日报里的 createUser */
  id: string
  name: string
  /** 登录名，通常就是工号；用来做跨系统的稳定匹配键 */
  loginName?: string
  dept?: string
  mail?: string
}

/* ------------------------------------------------------------------ *
 * 点号路径取值
 * ------------------------------------------------------------------ */

export function pick(obj: unknown, path: string): unknown {
  if (!path)
    return obj
  let cur: any = obj
  for (const seg of path.split('.')) {
    if (cur == null)
      return undefined
    // 支持 items[0] 这种下标写法
    const m = seg.match(/^([^[\]]*)\[(\d+)\]$/)
    if (m) {
      cur = cur[m[1] || seg]
      cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined
    }
    else {
      cur = cur[seg]
    }
  }
  return cur
}

function asString(v: unknown): string {
  if (v == null)
    return ''
  if (typeof v === 'string')
    return v
  if (typeof v === 'number' || typeof v === 'boolean')
    return String(v)
  return ''
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v))
    return v
  const n = Number.parseFloat(asString(v))
  return Number.isFinite(n) ? n : 0
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v))
    return v.map(asString).filter(Boolean)
  const s = asString(v)
  return s ? s.split(/[,，;；\s]+/).filter(Boolean) : []
}

/**
 * 填充模板里的占位。
 *
 * 分两种情况，因为 JSON body 里数字和字符串必须区分开：
 * 整体被引号包住的占位（`"{page}"`）替换成对应类型的 JSON 字面量（`1`），
 * 其余占位在字符串内部直接拼接（`"...{date}..."` → `"...2026-10-16..."`）。
 *
 * 先处理带引号的，否则 `"{page}"` 会先被第二遍替换成 `"1"`，变成字符串。
 */
export function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl
    .replace(/"\{(\w+)\}"/g, (m, key) => (key in vars ? JSON.stringify(vars[key]) : m))
    .replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m))
}

/** 分页响应里数组所在的常见字段名，取不到 itemsPath 时用来自动提示该填什么 */
const LIKELY_ARRAY_KEYS = ['records', 'rows', 'list', 'items', 'data', 'content', 'result']

/**
 * 同一实例上两次查询之间的最小间隔。
 *
 * 内部系统的查询接口通常不带限流头，一串连着的请求全打到库上，
 * 别人同时在用就会被拖慢。批量载入日期范围内时，每天都可能翻几页，
 * 是最容易打出连发的地方，所以在**每个**请求前统一留间隔，
 * 而不是只在翻页时等——一次检查正常只发一两个请求，这点等待看不出来。
 */
const REQUEST_INTERVAL_MS = 300

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 在响应里找一层就可能藏数据的数组字段，拼成 itemsPath 供用户直接采纳 */
function suggestItemsPaths(json: unknown, prefix = '', depth = 0): string[] {
  if (depth > 3 || json == null || typeof json !== 'object')
    return []
  const out: string[] = []
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(value)) {
      if (LIKELY_ARRAY_KEYS.includes(key))
        out.push(path)
    }
    else if (value && typeof value === 'object') {
      out.push(...suggestItemsPaths(value, path, depth + 1))
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * HTTP 数据源
 * ------------------------------------------------------------------ */

export class HttpDailyReportSource implements DailyReportSource {
  private readonly cfg: DailyReportSettings
  private readonly tp: Transport
  /** 上次发出查询的时刻，用于把连着的请求拉开间隔 */
  private lastRequestAt = 0

  constructor(cfg: DailyReportSettings, tp?: Transport) {
    this.cfg = cfg
    this.tp = tp ?? transport()
  }

  /**
   * 登录会话。取自单例——token 和探活定时器要跨多次检查复用，
   * 每次检查新建一个会话的话探活就白做了。
   *
   * 每次现取而不是在构造时缓存：单例会因为配置变更被重建，
   * 缓存下来的那份可能已经是个被 dispose 过的死对象（token 早清了）。
   */
  private get session(): DailyReportSession {
    return getDailyReportSession(this.cfg, this.tp)
  }

  describe() {
    return this.cfg.baseUrl ? `日报系统接口 ${this.cfg.baseUrl}` : '日报系统接口（未配置地址）'
  }

  /**
   * 拉取指定日期的日报。
   *
   * 日期同时提供给三个占位：`{date}`、`{startDate}`、`{endDate}`。
   * 一次检查只针对一天，所以起止日期是同一个值——内部系统的区间查询接口
   * 通常要求起止都给，只给开始会退化成「从那天到现在」。
   */
  async fetchByDate(date: string): Promise<DailyReport[]> {
    return this.fetchWindow(date, date)
  }

  /**
   * 一次拉一段日期。
   *
   * 日志系统支持补写：一条日报提交以后还能被修改，所以本地存的永远是快照。
   * 要「最新」就得按区间直接问源系统一次，而不是逐天翻缓存。
   */
  async fetchRange(from: string, to: string): Promise<DailyReport[]> {
    return this.fetchWindow(from, to)
  }

  private async fetchWindow(from: string, to: string): Promise<DailyReport[]> {
    if (!this.cfg.baseUrl.trim())
      throw new AdapterError('未配置日报系统地址，请到「设置 → 日报系统」填写，或改用 CSV 导入')

    // 每页条数最少 1：不再单独设「不分页」模式，只查一页用「最多翻页数 = 1」表达，
    // 少一个状态就少一种「填了 0 结果什么都没返回」的坑
    const pageSize = Math.max(1, Math.floor(this.cfg.pageSize) || 1)
    const maxPages = Math.max(1, Math.floor(this.cfg.maxPages) || 1)

    const reports: DailyReport[] = []
    // 两份日报的 id 相同说明是同一份，接口没按 page 翻页时靠它兜底去重
    const seen = new Set<string>()

    for (let page = 1; page <= maxPages; page++) {
      const raw = await this.fetchPage(from, to, page, pageSize)
      if (!raw.length)
        break

      let added = 0
      for (const [i, item] of raw.entries()) {
        // 单日查询时，条目不写日期也能按这一天算；区间查询不行——
        // 把没写日期的条目硬塞给区间起点，等于凭空造出一条日报
        const report = this.mapReport(item, from === to ? from : '', (page - 1) * pageSize + i)
        // 区间查询时服务端应当按 workDate 过滤，但万一没过滤，这里按窗口再筛一遍，
        // 免得把区间之外的日报也当成这一天的数据
        if (!report.date || report.date < from || report.date > to)
          continue
        if (seen.has(report.id))
          continue
        seen.add(report.id)
        reports.push(report)
        added++
      }

      // 整页都是已见过的：接口忽略了 page 参数，再翻下去也是同一页
      if (added === 0)
        break
    }

    return reports.filter(r => r.entries.length > 0)
  }

  /** 把同一实例上连着的查询拉开最小间隔，避免批量载入时打出连发 */
  private async throttle() {
    const wait = this.lastRequestAt + REQUEST_INTERVAL_MS - Date.now()
    if (wait > 0)
      await sleep(wait)
    this.lastRequestAt = Date.now()
  }

  /** 取一页原始条目。分页参数同时放进 query 和 body，因为各家读的位置不一样 */
  private async fetchPage(from: string, to: string, page: number, pageSize: number): Promise<unknown[]> {
    await this.throttle()

    const vars: Record<string, string | number> = {
      date: from,
      startDate: from,
      endDate: to,
      /*
       * 日期时间形态。
       *
       * 有的系统把起止日期声明成 LocalDateTime/Date 并按 `yyyy-MM-dd HH:mm:ss` 解析，
       * 这时候只给 `2026-10-16` 会在反序列化时直接抛异常。而它的前端页面从来不填日期
       * （一直发空串），所以这个坑平时碰不到。起止分别取当天 00:00:00 和 23:59:59，
       * 正好是「整天」的语义。
       */
      startDateTime: `${from} 00:00:00`,
      endDateTime: `${to} 23:59:59`,
      page,
      limit: pageSize,
    }

    const url = new URL(joinApiUrl(this.cfg.baseUrl, fillTemplate(this.cfg.listPathTemplate, vars)))
    url.searchParams.set('page', String(page))
    url.searchParams.set('limit', String(pageSize))
    for (const pair of this.cfg.extraQuery.split('&')) {
      const [k, v] = pair.split('=')
      if (k?.trim())
        url.searchParams.set(k.trim(), (v ?? '').trim())
    }

    const isPost = this.cfg.method === 'POST'
    const res = await this.requestWithAuth({
      url: url.toString(),
      method: isPost ? 'POST' : 'GET',
      body: isPost ? fillTemplate(this.cfg.bodyTemplate.trim() || '{}', vars) : undefined,
    })

    if (!res.ok) {
      throw new AdapterError(
        describeReportHttpError(res.status),
        res.status,
        res.body.slice(0, 300),
      )
    }

    let json: unknown
    try {
      json = JSON.parse(res.body)
    }
    catch {
      throw new AdapterError('日报系统返回的不是合法 JSON', res.status, res.body.slice(0, 300))
    }

    const items = pick(json, this.cfg.fieldMap.itemsPath)

    /*
     * null / undefined 表示**这一页没有数据**，是正常的「翻到底了」。
     *
     * 分页接口的最后一页经常就长这样：`{"page":2,...,"count":"2","data":null}`。
     * 把它当成配置错误直接抛，会在「第一页有数据、第二页到底」这种最常见的情况下失败——
     * 而且报的还是字段映射的问题，方向完全错。
     *
     * 真正的配置错误长的是另一种样子：路径指到了一个**对象**上（比如把 `data.data`
     * 写成了 `data`），这时候取到的是个非null的非数组，那才该报错。
     */
    if (items === null || items === undefined)
      return []

    if (!Array.isArray(items)) {
      // 数组藏在哪一层各家不同，猜错时直接告诉用户该填什么，比让他自己翻响应快。
      // 末尾附上服务端原文：报错说不清楚时，这一小段就是唯一的线索
      const guesses = suggestItemsPaths(json)
      throw new AdapterError(
        `字段映射 itemsPath="${this.cfg.fieldMap.itemsPath}" 取到的不是数组`
        + (guesses.length ? `。响应里这些位置是数组，试一下：${guesses.join(' 或 ')}` : '，请检查设置')
        + `。服务端返回：${JSON.stringify(json).slice(0, 300)}`,
      )
    }
    return items
  }

  /**
   * 从日志系统取项目清单。
   *
   * 走同一套鉴权和「跳过证书校验」配置——它和拉日报是同一个系统，
   * 不该为它再配一遍地址和凭据。
   */
  async fetchProjectList(): Promise<LogSystemProject[]> {
    if (!this.cfg.baseUrl.trim())
      throw new AdapterError('未配置日报系统地址，先到「设置 → 日报系统」填上')

    const settings = this.cfg.projectList
    const url = joinApiUrl(this.cfg.baseUrl, settings.path)
    const res = await this.requestWithAuth({ url, method: 'GET' })

    if (!res.ok) {
      throw new AdapterError(
        describeReportHttpError(res.status),
        res.status,
        res.body.slice(0, 300),
      )
    }

    let json: unknown
    try {
      json = JSON.parse(res.body)
    }
    catch {
      throw new AdapterError('项目列表返回的不是合法 JSON', res.status, res.body.slice(0, 300))
    }

    const items = pick(json, settings.itemsPath)
    if (items === null || items === undefined)
      return []
    if (!Array.isArray(items)) {
      const guesses = suggestItemsPaths(json)
      throw new AdapterError(
        `项目清单的数组路径「${settings.itemsPath}」取到的不是数组`
        + (guesses.length ? `。响应里这些位置是数组，试一下：${guesses.join(' 或 ')}` : '')
        + `。服务端返回：${JSON.stringify(json).slice(0, 300)}`,
      )
    }

    return items
      .map((item) => {
        return {
          id: asString(pick(item, settings.idPath)).trim() || undefined,
          name: asString(pick(item, settings.namePath)).trim(),
          number: asString(pick(item, settings.numberPath)).trim() || undefined,
        }
      })
      .filter(p => p.name)
  }

  /**
   * 从日志中心取用户清单。
   *
   * 这个接口会连带返回 `loginPwd`（密码），这是接口本身的问题。
   * 这里只挑 id / 姓名 / 登录名 / 部门 / 邮箱五个字段，
   * **密码不会进入任何数据结构**——不映射、不落库、不进日志。
   */
  async fetchLogSystemUsers(): Promise<LogSystemUser[]> {
    if (!this.cfg.baseUrl.trim())
      throw new AdapterError('未配置日报系统地址，先到「设置 → 日报系统」填上')

    const settings = this.cfg.userList
    const url = joinApiUrl(this.cfg.baseUrl, settings.path)
    const res = await this.requestWithAuth({ url, method: 'GET' })

    if (!res.ok) {
      throw new AdapterError(
        describeReportHttpError(res.status),
        res.status,
        res.body.slice(0, 300),
      )
    }

    let json: unknown
    try {
      json = JSON.parse(res.body)
    }
    catch {
      throw new AdapterError('用户清单返回的不是合法 JSON', res.status, res.body.slice(0, 300))
    }

    const items = pick(json, settings.itemsPath)
    if (items === null || items === undefined)
      return []
    if (!Array.isArray(items)) {
      const guesses = suggestItemsPaths(json)
      throw new AdapterError(
        `用户清单的数组路径「${settings.itemsPath}」取到的不是数组`
        + (guesses.length ? `。响应里这些位置是数组，试一下：${guesses.join(' 或 ')}` : '')
        + `。服务端返回：${JSON.stringify(json).slice(0, 300)}`,
      )
    }

    return items
      .map((item) => {
        return {
          id: asString(pick(item, settings.idPath)).trim(),
          name: asString(pick(item, settings.namePath)).trim(),
          loginName: asString(pick(item, settings.loginNamePath)).trim() || undefined,
          dept: asString(pick(item, settings.deptPath)).trim() || undefined,
          mail: asString(pick(item, settings.mailPath)).trim() || undefined,
        }
      })
      .filter(u => u.id && u.name)
  }

  /**
   * 带鉴权的请求。
   *
   * 启用登录时用登录拿到的 token（默认放 X-Token 头）；否则用配置里那个静态 Token。
   * 401/403 时清掉 token 重登一次再试——token 过期是最常见的中断原因，
   * 不重试的话每次过期都要人工去设置页点一次。
   */
  private async requestWithAuth(init: { url: string, method: 'GET' | 'POST', body?: string }) {
    const build = async (): Promise<Record<string, string>> => {
      const headers: Record<string, string> = { 'accept': 'application/json' }
      // 只写 `application/json`，不带 charset。
      //
      // JSON 按 RFC 8259 就是 UTF-8，charset 参数是多余的；而这个系统里除了登录
      // （表单）以外全是 JSON，服务端很可能按 `application/json` 精确匹配来判定
      // 「这个请求的体能不能读」——多一个参数就匹配不上。前端用的 axios 1.x
      // 也是只发 `application/json`。
      if (init.body !== undefined)
        headers['content-type'] = 'application/json'

      if (this.session.enabled) {
        const token = await this.session.ensureToken()
        const header = this.cfg.login.tokenHeader.trim() || 'X-Token'
        if (token)
          headers[header] = token
      }
      else if (this.cfg.token.trim()) {
        const header = this.cfg.authHeader.trim() || 'Authorization'
        headers[header] = header.toLowerCase() === 'authorization'
          ? `Bearer ${this.cfg.token.trim()}`
          : this.cfg.token.trim()
      }
      return headers
    }

    const send = async () => this.tp.http({
      url: init.url,
      method: init.method,
      body: init.body,
      headers: await build(),
      timeoutMs: 30000,
      allowInsecureTls: this.cfg.allowInsecureTls,
    })

    const res = await send()

    if ((res.status === 401 || res.status === 403) && this.session.enabled) {
      this.session.invalidate()
      return send()
    }

    // 成功的请求要记一笔：会话的空闲计时靠它，
    // 不记的话下一次请求会误判成「很久没活动」而白重登一次
    if (res.ok)
      this.session.noteActivity()

    return res
  }

  private mapReport(item: unknown, fallbackDate: string, index: number): DailyReport {
    const f = this.cfg.fieldMap
    const rawEntries = pick(item, f.entriesPath)
    const entries: DailyReportEntry[] = (Array.isArray(rawEntries) ? rawEntries : []).map((e, i) => ({
      id: `${asString(pick(item, f.memberIdPath)) || 'unknown'}-${fallbackDate}-${i}`,
      projectName: asString(pick(e, f.entryProjectNamePath)) || '未填写项目',
      projectCode: asString(pick(e, f.entryProjectCodePath)) || undefined,
      hours: this.hoursOf(pick(e, f.entryHoursPath)),
      /*
       * 工作内容多数系统写在条目上；也有像内部系统这样的，整条日志只写一份内容，
       * 项目列表里只带占比。条目里取不到就退回日志级取——退不回去才是真的没有，
       * 而「没有内容」会让这条判定直接失去依据。
       */
      content: asString(pick(e, f.entryContentPath)) || asString(pick(item, f.entryContentPath)),
      taskRefs: asStringArray(pick(e, f.entryTaskRefsPath)),
    }))

    const memberId = asString(pick(item, f.memberIdPath)) || `row-${index}`
    const memberName = asString(pick(item, f.memberNamePath)) || memberId

    return {
      id: `${memberId}@${asString(pick(item, f.datePath)) || fallbackDate}`,
      date: normalizeDate(asString(pick(item, f.datePath))) || fallbackDate,
      memberId,
      memberName,
      entries,
      totalHours: round2(entries.reduce((s, e) => s + e.hours, 0)),
    }
  }

  /**
   * 把工时列换算成小时。
   *
   * 内部系统填的是「占当天工时的百分比」（100 = 一整天），不是小时数。
   * 权重本身按比例算，直接当小时用不影响打分，但界面上会显示成「100 小时」。
   * 配了基数就按八小时制折算，比例一分不差。
   */
  private hoursOf(raw: unknown): number {
    const value = asNumber(raw)
    const base = this.cfg.entryHoursPercentBase
    return base > 0 ? round2((value * base) / 100) : value
  }
}

/* ------------------------------------------------------------------ *
 * CSV 数据源
 * ------------------------------------------------------------------ */

/**
 * CSV 列名固定，方便人事/PM 直接从系统导出后另存：
 * date,memberId,memberName,projectName,projectCode,hours,content,taskRefs
 * taskRefs 用逗号或分号分隔，需整体加引号。
 */
export function parseDailyReportCsv(text: string): DailyReport[] {
  const rows = parseCsv(text)
  if (!rows.length)
    return []

  const header = rows[0].map(h => h.trim())
  const idx = (name: string) => header.findIndex(h => h.toLowerCase() === name.toLowerCase())
  const col = {
    date: idx('date'),
    memberId: idx('memberId'),
    memberName: idx('memberName'),
    projectName: idx('projectName'),
    projectCode: idx('projectCode'),
    hours: idx('hours'),
    content: idx('content'),
    taskRefs: idx('taskRefs'),
  }

  if (col.date === -1 || col.memberName === -1 || col.content === -1) {
    throw new AdapterError(
      'CSV 表头缺少必需列。需要至少包含 date、memberName、content，'
      + '完整列为 date,memberId,memberName,projectName,projectCode,hours,content,taskRefs',
    )
  }

  // 同一人同一天可能拆成多行，按 (日期, 成员) 聚合成一份日报
  const grouped = new Map<string, DailyReport>()

  for (const row of rows.slice(1)) {
    if (!row.some(c => c.trim()))
      continue
    const date = normalizeDate(row[col.date] ?? '')
    const memberName = (row[col.memberName] ?? '').trim()
    if (!date || !memberName)
      continue

    const memberId = (col.memberId !== -1 ? row[col.memberId]?.trim() : '') || memberName
    const key = `${memberId}@${date}`
    let report = grouped.get(key)
    if (!report) {
      report = {
        id: key,
        date,
        memberId,
        memberName,
        entries: [],
        totalHours: 0,
      }
      grouped.set(key, report)
    }

    report.entries.push({
      id: `${key}-${report.entries.length}`,
      projectName: (col.projectName !== -1 ? row[col.projectName]?.trim() : '') || '未填写项目',
      projectCode: (col.projectCode !== -1 ? row[col.projectCode]?.trim() : '') || undefined,
      hours: asNumber(col.hours !== -1 ? row[col.hours] : 0),
      content: (row[col.content] ?? '').trim(),
      taskRefs: asStringArray(col.taskRefs !== -1 ? row[col.taskRefs] : ''),
    })
  }

  for (const report of grouped.values())
    report.totalHours = round2(report.entries.reduce((s, e) => s + e.hours, 0))

  return [...grouped.values()]
}

/** 支持引号包裹、双引号转义、\r\n 换行的最小 CSV 解析。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // 去掉 UTF-8 BOM，否则第一列表头会带不可见字符导致匹配失败
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        }
        else {
          inQuotes = false
        }
      }
      else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    }
    else if (ch === ',') {
      row.push(field)
      field = ''
    }
    else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    }
    else if (ch === '\r') {
      // 交给后面的 \n 处理，单独的 \r 视为换行
      if (src[i + 1] !== '\n') {
        row.push(field)
        rows.push(row)
        row = []
        field = ''
      }
    }
    else {
      field += ch
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(r => r.some(c => c.trim()))
}

export class CsvDailyReportSource implements DailyReportSource {
  private readonly rows: DailyReport[]

  constructor(rows: DailyReport[]) {
    this.rows = rows
  }

  describe() {
    return `本地导入的日报（${this.rows.length} 条）`
  }

  async fetchByDate(date: string): Promise<DailyReport[]> {
    return this.rows.filter(r => r.date === date)
  }
}

/* ------------------------------------------------------------------ *
 * 演示数据源
 * ------------------------------------------------------------------ */

/** 未接入真实系统时的兜底数据，让检查流程可以完整跑通。 */
export class MockDailyReportSource implements DailyReportSource {
  describe() {
    return '演示数据（未接入真实日报系统）'
  }

  async fetchByDate(date: string): Promise<DailyReport[]> {
    const members = [
      {
        id: 'u1001',
        name: '张伟',
        entries: [
          { projectName: '统一支付平台', hours: 5, content: '重构支付回调重试逻辑，修复超时导致的重复扣款问题；补充单元测试' },
          { projectName: '内部管理后台', hours: 3, content: '管理后台新增对账报表页面，联调导出接口' },
        ],
      },
      {
        id: 'u1002',
        name: '李娜',
        entries: [
          { projectName: '统一支付平台', hours: 8, content: '参加需求评审会议，梳理下一期迭代范围' },
        ],
      },
      {
        id: 'u1003',
        name: '王强',
        entries: [
          { projectName: '风控引擎', hours: 4, content: '优化规则匹配性能，将单笔决策耗时从 80ms 降到 20ms' },
          { projectName: '统一支付平台', hours: 4, content: '排查线上支付成功率下降问题，定位到第三方通道超时配置' },
        ],
      },
    ]

    return members.map(m => ({
      id: `${m.id}@${date}`,
      date,
      memberId: m.id,
      memberName: m.name,
      entries: m.entries.map((e, i) => ({
        id: `${m.id}-${date}-${i}`,
        projectName: e.projectName,
        hours: e.hours,
        content: e.content,
      })),
      totalHours: round2(m.entries.reduce((s, e) => s + e.hours, 0)),
    }))
  }
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

export function createDailyReportSource(
  cfg: DailyReportSettings,
  csvRows?: DailyReport[],
): DailyReportSource {
  if (cfg.source === 'http')
    return new HttpDailyReportSource(cfg)
  if (cfg.source === 'csv' && csvRows?.length)
    return new CsvDailyReportSource(csvRows)
  return new MockDailyReportSource()
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 把 2026/10/16、2026-10-16T00:00:00+08:00 之类统一成 YYYY-MM-DD。 */
export function normalizeDate(input: string): string {
  const s = input.trim()
  if (!s)
    return ''
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (iso)
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  const parsed = new Date(s)
  if (Number.isNaN(parsed.getTime()))
    return ''
  return toDateKey(parsed)
}

export function toDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/** 把日报接口的 HTTP 错误码翻译成能直接照做的提示 */
function describeReportHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return `日报系统返回 HTTP ${status}：鉴权失败。`
      + '启用了登录的话检查用户名密码；否则检查静态 Token 与认证头设置'
  }
  if (status === 404)
    return '日报系统返回 HTTP 404：接口路径不对，检查「拉取路径模板」'
  return `日报系统返回 HTTP ${status}`
}
