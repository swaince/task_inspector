/**
 * 应用配置模型。
 *
 * 所有外部依赖（GitLab / 日报系统 / LLM）都是配置驱动的，换一套内部系统
 * 只需要改设置页里的字段，不用改代码。
 */

export type LlmProvider = 'anthropic' | 'openai-compatible'
export type DailyReportSource = 'http' | 'csv' | 'mock'

export interface GitLabSettings {
  /** GitLab 实例地址，如 https://gitlab.example.com */
  baseUrl: string
  /** Personal / Project Access Token，需要 read_api 权限 */
  token: string
  /** 内部自签名证书时开启，会跳过 TLS 校验 */
  allowInsecureTls: boolean
  /** 单页拉取条数，GitLab 上限 100 */
  perPage: number
  /**
   * 仓库目录的数量上限，防止在大实例上无限翻页。
   *
   * 目录只用于「日报里的项目名对不上任何项目」时的模糊候选，主要检查路径
   * （项目 → 关联的仓库/组）不依赖它。达到上限会截断并在界面上提示。
   */
  maxProjects: number
}

export interface DailyReportFieldMap {
  /** 响应里日报数组的位置，点号路径，如 data.list */
  itemsPath: string
  datePath: string
  memberIdPath: string
  memberNamePath: string
  /** 单份日报里条目数组的位置，相对 itemsPath 的每一条 */
  entriesPath: string
  entryProjectNamePath: string
  entryProjectCodePath: string
  entryHoursPath: string
  entryContentPath: string
  entryTaskRefsPath: string
}

/**
 * 日报系统登录。
 *
 * 内部系统用的是「用户名 + 验证码 key + 密码」整体 Base64 后作为 loginInfo 提交，
 * 走 x-www-form-urlencoded，type=0 表示用户名密码登录。
 * 登录成功后拿到 accessToken，后续请求带在 X-Token 头里。
 *
 * 每个字段都可配：内部系统换个版本、或者以后换成别的鉴权方式，不用改代码。
 */
export interface DailyReportLoginSettings {
  enabled: boolean
  /**
   * 登录接口路径，**从根地址起算、含接口前缀**，例如 /api/login。
   * 不要在这里重复写根地址。
   */
  path: string
  username: string
  password: string
  /**
   * 登录方式。**配什么就发什么，这里不做任何推断或替换。**
   *
   * 内部系统：`0` = 用户名密码，不校验图形验证码；`1` = 需要图形验证码。
   * 自动化场景只能用 0——1 那条路径要的是人在页面上看出来的那四个字符，
   * 补个随机值只会被判验证码错误。
   */
  type: number
  /**
   * 验证码 key。**留空时每次登录自动生成一个 UUID。**
   *
   * 不能用空值传出去：服务端即使不做校验也会读这个字段，缺了会直接报参数错。
   * 用户名密码登录本来就不需要真验证码，所以补一个唯一值即可。
   */
  captchaKey: string
  /** 验证码内容。同样留空时自动补一个随机串，理由同上——字段不能缺 */
  captchaCode: string
  /** 响应里 accessToken 的位置，点号路径 */
  tokenPath: string
  /** 后续请求携带 token 的头名 */
  tokenHeader: string
  /** 请求体编码方式 */
  bodyFormat: 'form' | 'json'

  /* --- 会话保持 --- */

  /**
   * token 的空闲失效时间（分钟）。
   *
   * 服务端通常是「多少分钟没有任何请求就把 token 作废」，这个值需要从日报系统那边查。
   * 填了之后就能在失效**之前**主动重登，而不是等请求被打回 401 才发现。
   * 0 表示不主动续期，只靠 401 之后重登。
   */
  idleTimeoutMinutes: number

  /**
   * 探活接口路径（从根地址起算，含接口前缀）。
   *
   * 服务端的空闲计时是「有没有请求」，所以要保住会话就得真的发请求。
   * 留空则退化成「按空闲时间主动重登」。
   */
  keepAlivePath: string

  /** 探活频率（分钟）。0 表示自动取空闲时间的 2/3 */
  keepAliveIntervalMinutes: number
}

export interface DailyReportSettings {
  source: DailyReportSource
  /**
   * 接口根地址，只填协议 + 主机 + 端口，**不要带接口前缀**。
   * 例如 https://192.168.2.21:51443，而不是 https://192.168.2.21:51443/api。
   * 前缀属于路径的一部分，写在下面两个路径字段里。
   */
  baseUrl: string
  token: string
  /**
   * 内网自签证书时打开，跳过 TLS 校验。
   *
   * **只在桌面端有效。** 浏览器里跑的版本用的是 fetch，证书校验由浏览器自己做，
   * 页面没有任何办法绕过——那个模式下要么先在浏览器里直接打开这个地址并信任证书，
   * 要么改用桌面端。
   */
  allowInsecureTls: boolean
  /**
   * 按日期批量拉取日报的路径，**从根地址起算**，所以要带接口前缀，
   * 例如 /api/work/work-log/v2/page/send/me。
   * 支持 {date} {startDate} {endDate} {page} {limit} 占位。
   */
  listPathTemplate: string
  /** 请求方法。内部系统的分页查询是 POST，老式导出接口多是 GET */
  method: 'GET' | 'POST'
  /**
   * POST 的请求体模板（JSON），支持 {date} {startDate} {endDate} {page} {limit} 占位。
   * 各家的字段名不统一，所以整份 body 都可配，而不是写死一套参数名。
   */
  bodyTemplate: string
  /**
   * 分页每页条数，填进 `{limit}` 占位并同时作为 query 参数。最少 1。
   * 翻页时会一路翻到空页为止，所以值不用猜得很准；只查一页就把「最多翻页数」设成 1。
   */
  pageSize: number
  /** 最多翻多少页，兜底防止接口始终返回满页时无限拉取 */
  maxPages: number
  /** 单次请求的额外 query，形如 a=1&b=2 */
  extraQuery: string
  /** 认证头名称，默认 Authorization，值为 `Bearer <token>` */
  authHeader: string
  /**
   * 工时列如果是百分比（内部系统的 `workDayPercent`，100 = 一整天），
   * 这里填「100% 折算成多少小时」；填 8 就是按八小时工作制换算。
   * **0 表示不折算**，字段值原样当小时数用——别的系统直接给小时，不该被动它。
   */
  entryHoursPercentBase: number
  fieldMap: DailyReportFieldMap
  /**
   * 日志系统的项目清单。
   *
   * 项目在日志系统里是独立的业务实体、自带项目编号；而本地项目大多是从 GitLab
   * 按仓库名生成的，两者对不上。这条接口用来把编号补齐——手工一个个填几百个不现实。
   */
  projectList: LogSystemProjectSettings
  /** 日志中心的用户清单 —— 人员的名单来源 */
  userList: LogSystemUserSettings
  login: DailyReportLoginSettings
}

export interface LogSystemUserSettings {
  /** 从根地址起算，含接口前缀和固定查询参数 */
  path: string
  itemsPath: string
  /** 日志中心的用户 ID，对应日报里的 createUser */
  idPath: string
  namePath: string
  /** 登录名，通常就是工号，用来做跨系统的稳定匹配键 */
  loginNamePath: string
  deptPath: string
  mailPath: string
}

export interface LogSystemProjectSettings {
  /** 从根地址起算，含接口前缀 */
  path: string
  /** 响应里项目数组的位置（点号路径） */
  itemsPath: string
  /** 日志中心的项目 ID —— 项目的稳定身份 */
  idPath: string
  namePath: string
  numberPath: string
}

export interface LlmSettings {
  provider: LlmProvider
  /** 留空则用官方默认地址 */
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  /** 条目判定的并发数，内网模型建议 1-2 */
  concurrency: number
  /** 单次请求超时（毫秒） */
  timeoutMs: number
}

export type ProjectMatchMode = 'exact' | 'contains' | 'regex'

export interface ProjectMapping {
  id: string
  /** 日报里填写的项目名 */
  reportProjectName: string
  matchMode: ProjectMatchMode
  /** 对应的 GitLab 项目 pathWithNamespace 列表 */
  gitlabProjectPaths: string[]
  /** 工时占比低于该值（0-1）时不做严格判定 */
  minRatioForStrictCheck: number
}

export interface MemberMapping {
  reportMemberId: string
  reportMemberName: string
  /** GitLab username */
  gitlabUsername: string
  /** 用于匹配提交 author_email 的邮箱列表 */
  emails: string[]
  team: string
  /** 关闭后不参与批量检查，如离职或长期外派人员 */
  enabled: boolean
}

export interface RuleSettings {
  /**
   * 归集提交的时间窗，相对日报日期的小时数。
   * 默认 -4 / 8 表示「前一日 20:00 到当日次日 08:00」都在当日日报的覆盖范围内，
   * 用来容忍晚上加班提交、以及次日凌晨补提交。
   */
  windowStartHour: number
  windowEndHour: number
  /** 时区偏移（分钟），如北京时间 +480 */
  timezoneOffsetMinutes: number
  ignoreMergeCommits: boolean
  /** 命中即忽略的提交信息正则 */
  ignoreCommitMessagePatterns: string[]
  /** 命中即忽略的文件路径 glob */
  ignorePaths: string[]
  /** 单项目单日最多抓取的提交数，避免大仓爆炸 */
  maxCommitsPerProject: number
  /** 是否抓取每个提交的文件变更明细 */
  fetchFileChanges: boolean
  /** 单次检查覆盖的最大成员数 */
  maxMembersPerRun: number
}

export interface RetentionSettings {
  /** 检查历史保留天数，0 表示永久保留 */
  keepDays: number
}

/* ------------------------------------------------------------------ *
 * LDAP
 * ------------------------------------------------------------------ */

/** LDAP 属性 → 本工具字段的映射。AD 和 OpenLDAP 的属性名差别很大，所以做成可配。 */
export interface LdapAttributeMap {
  /** 登录名：AD 是 sAMAccountName，OpenLDAP 通常是 uid */
  username: string
  /** 姓名：AD 是 displayName，OpenLDAP 通常是 cn */
  name: string
  email: string
  employeeNo: string
  department: string
  title: string
}

export interface LdapSettings {
  enabled: boolean
  /** ldap:// 或 ldaps:// */
  url: string
  /** 绑定用的服务账号，DN 或 UPN */
  bindDn: string
  bindPassword: string
  /** 搜索起点 */
  baseDn: string
  /** 过滤器。默认排除已停用的 AD 账号 */
  userFilter: string
  /** 单页条数，AD 默认上限 1000 */
  pageSize: number
  /** 连接/搜索超时（秒） */
  timeoutSeconds: number
  /** 内网自签证书时开启 */
  allowInsecureTls: boolean
  attributeMap: LdapAttributeMap
}

export interface AppSettings {
  version: number
  gitlab: GitLabSettings
  dailyReport: DailyReportSettings
  llm: LlmSettings
  projectMappings: ProjectMapping[]
  memberMappings: MemberMapping[]
  ldap: LdapSettings
  rules: RuleSettings
  retention: RetentionSettings
  analysis: AnalysisSettings
  /** 界面主题：跟随系统 / 强制浅色 / 强制深色 */
  appearance: AppearanceSettings
  /** 工作日历：法定节假日 + 调休上班 + 公司自己的临时安排 */
  workCalendar: WorkCalendarSettings
}

export type ThemeMode = 'auto' | 'light' | 'dark'

export interface AppearanceSettings {
  theme: ThemeMode
}

/* ------------------------------------------------------------------ *
 * 工作日历
 * ------------------------------------------------------------------ */

export interface CalendarDay {
  /** YYYY-MM-DD */
  date: string
  type: 'holiday' | 'workday'
  /** 名称，例如「国庆节」「调休上班」 */
  name?: string
}

export interface WorkCalendarSettings {
  /** ICS 在线地址；留空表示不做在线导入，只用手动条目 + 周末规则 */
  url: string
  /** 上次成功导入的时间（ISO） */
  importedAt: string | null
  /** 从 ICS 展开后的日期（节假日 + 调休上班） */
  imported: CalendarDay[]
  /** 手动覆盖，优先级最高。公司某天集体放假、或临时调休时在这里加 */
  manual: CalendarDay[]
}

/**
 * 代码分析（项目画像）相关配置。
 *
 * 这里把两件事分得很开：
 *
 * - `codeRoot` 是**用户自己的代码**，应用只读不删；
 * - `cacheDir` 是**应用生成的东西**（克隆的副本、索引、分析产物），可以整目录清空。
 *
 * 混成一个目录的后果是把用户的 checkout 当缓存删掉，不可恢复。
 */
export interface AnalysisSettings {
  /** 本地代码根目录：按 `<namespace>/<repo>` 找已有 checkout，找不到才考虑克隆 */
  codeRoot: string
  /** 应用缓存目录，留空用默认值（应用数据目录下的 analysis/） */
  cacheDir: string
  /** codegraph 可执行文件，留空 = 自动从 PATH 里找 */
  codegraphPath: string
  /** graphify 可执行文件，留空 = 自动从 PATH 里找 */
  graphifyPath: string
  /** 生成画像时自动建/更新索引；关掉就只能用已有索引做轻量分析 */
  autoIndex: boolean
  /** 本地没有代码时自动浅克隆到代码目录 */
  autoClone: boolean
  /** 浅克隆深度（提交数）；0 表示完整克隆。深度越大，热点统计越准、克隆越慢 */
  cloneDepth: number
  /**
   * 分析用的 skill：一段 markdown 指令，生成画像时拼进系统提示。
   * 和 Claude Code 的 skill 同一思路——项目类型不同（Java/Spring、Vue、数据管道），
   * 「该看什么」差别很大，硬编码进提示词只会让所有项目都用同一套泛泛的视角。
   */
  skills: AnalysisSkill[]
  /** MCP 服务器配置。运行时会在分析流程里建立会话，工具列表用于代码分析 */
  mcpServers: AnalysisMcpServer[]
}

export interface AnalysisSkill {
  id: string
  name: string
  /** 本地 markdown 文件路径 */
  path: string
  enabled: boolean
}

export interface AnalysisMcpServer {
  id: string
  name: string
  /** 目前只支持 stdio：由应用拉起本地进程 */
  transport: 'stdio'
  /** 启动命令，例如 npx */
  command: string
  /** 参数，按空格分隔 */
  args: string
  /** 环境变量，每行 KEY=VALUE */
  env: string
  enabled: boolean
}

/**
 * 配置结构版本。升级时把旧配置的迁移逻辑（见 merge.ts）按版本号条件执行，
 * 迁移过的配置会带着新版本号落盘，之后不再重复改写用户的选择。
 *
 * v4：日报接口从「我的日志」（page/self）切到「发送/抄送给我的日志」
 *     （v2/page/send/me，POST 分页）。
 */
export const SETTINGS_VERSION = 4

export const DEFAULT_FIELD_MAP: DailyReportFieldMap = {
  // 内部系统：单条日志挂在 data.data 下，日期和内容在日志级，
  // 项目列表是日志里的 projects[]，每个项目只有一个工时占比
  itemsPath: 'data.data',
  datePath: 'workDate',
  memberIdPath: 'createUser',
  memberNamePath: 'createUserName',
  entriesPath: 'projects',
  entryProjectNamePath: 'projectName',
  entryProjectCodePath: 'projectNumber',
  entryHoursPath: 'workDayPercent',
  entryContentPath: 'workContent',
  entryTaskRefsPath: 'taskRefs',
}

export function createDefaultSettings(): AppSettings {
  return {
    version: SETTINGS_VERSION,
    gitlab: {
      baseUrl: '',
      token: '',
      allowInsecureTls: false,
      perPage: 100,
      maxProjects: 2000,
    },
    dailyReport: {
      source: 'mock',
      baseUrl: '',
      token: '',
      allowInsecureTls: false,
      // 默认值对着内部系统当前的分页接口填，换系统时改这几项即可
      listPathTemplate: '/api/work/work-log/v2/page/send/me',
      method: 'POST',
      // 日期必须是 `yyyy-MM-dd HH:mm:ss`：这个系统的起止日期是日期时间类型，
      // 只给 `2026-10-16` 会在反序列化那步直接抛异常，报出来是「请求体读取异常」。
      // 起止取 00:00:00 / 23:59:59，正好是「整天」。
      bodyTemplate: '{"page":{page},"limit":{limit},"queryContent":"","projectId":"","startDate":"{startDateTime}","endDate":"{endDateTime}","createUserIds":[],"logSendUserRead":""}',
      pageSize: 100,
      maxPages: 20,
      extraQuery: '',
      authHeader: 'Authorization',
      // 这个系统填的是工时占比，按八小时工作制折算成小时
      entryHoursPercentBase: 8,
      fieldMap: { ...DEFAULT_FIELD_MAP },
      projectList: {
        path: '/api/work/work-project/list/simple',
        itemsPath: 'data',
        idPath: 'projectId',
        namePath: 'projectName',
        numberPath: 'projectNumber',
      },
      userList: {
        // 内部系统的用户清单。注意这个接口会连带返回 loginPwd 字段——
        // 那是接口本身的问题，我们只读下面这几项，密码既不映射也不落库。
        path: '/api/system/user/queryList?deptId=&permission=0&userType=1',
        itemsPath: 'data',
        idPath: 'id',
        namePath: 'name',
        loginNamePath: 'loginName',
        deptPath: 'deptNames',
        mailPath: 'mail',
      },
      login: {
        enabled: false,
        path: '/api/login',
        username: '',
        password: '',
        type: 0,
        captchaKey: '',
        captchaCode: '',
        tokenPath: 'data.accessToken',
        tokenHeader: 'X-Token',
        bodyFormat: 'form',
        // 默认不主动续期：不知道对方的空闲策略时，猜一个值反而会在错误的时机重登
        idleTimeoutMinutes: 0,
        keepAlivePath: '',
        keepAliveIntervalMinutes: 0,
      },
    },
    llm: {
      provider: 'anthropic',
      baseUrl: '',
      apiKey: '',
      model: 'claude-sonnet-5-5',
      temperature: 0.2,
      maxTokens: 4096,
      concurrency: 3,
      timeoutMs: 120000,
    },
    projectMappings: [],
    memberMappings: [],
    rules: {
      windowStartHour: -4,
      windowEndHour: 8,
      timezoneOffsetMinutes: 480,
      ignoreMergeCommits: true,
      ignoreCommitMessagePatterns: [
        '^Merge (branch|remote-tracking branch|pull request)',
        '^chore(release)?:',
        '^Revert "',
      ],
      ignorePaths: [
        '**/*.lock',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/yarn.lock',
        '**/dist/**',
        '**/*.min.js',
      ],
      maxCommitsPerProject: 200,
      fetchFileChanges: true,
      maxMembersPerRun: 50,
    },
    ldap: {
      enabled: false,
      url: '',
      bindDn: '',
      bindPassword: '',
      baseDn: '',
      // 默认排除已停用的 AD 账号（userAccountControl 的 ACCOUNTDISABLE 位）
      userFilter: '(&(objectClass=person)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))',
      pageSize: 500,
      timeoutSeconds: 30,
      allowInsecureTls: false,
      attributeMap: {
        username: 'sAMAccountName',
        name: 'displayName',
        email: 'mail',
        employeeNo: 'employeeNumber',
        department: 'department',
        title: 'title',
      },
    },
    retention: {
      keepDays: 180,
    },
    analysis: {
      codeRoot: '',
      cacheDir: '',
      codegraphPath: '',
      graphifyPath: '',
      autoIndex: true,
      autoClone: true,
      cloneDepth: 200,
      skills: [],
      mcpServers: [],
    },
    workCalendar: {
      // 默认给 2026 年的中国法定节假日；换年份时在设置页改成对应地址
      url: 'https://chinacalendar.app/ics/china-holidays-2026.ics',
      importedAt: null,
      imported: [],
      manual: [],
    },
    appearance: {
      theme: 'auto',
    },
  }
}
