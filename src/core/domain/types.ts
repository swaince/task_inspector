/**
 * 领域模型：日报、GitLab 提交、检查结论。
 *
 * 这里的类型是整个应用的契约层，适配器（adapters）负责把外部系统
 * 的原始数据转换成本文件里的形状，引擎（engine）只依赖这里的类型。
 */

/* ------------------------------------------------------------------ *
 * 人
 * ------------------------------------------------------------------ */

/**
 * 成员实体。
 *
 * 日报系统的人 → GitLab 账号的对应关系就落在这个实体上，
 * 不再单独维护一份「成员映射」——那是同一件事的第二份真相。
 */
export interface MemberProfile {
  id: string
  /** 日报系统里的用户 ID，与日报对上全靠它 */
  reportMemberId?: string
  name: string
  employeeNo?: string
  team?: string
  role?: string
  gitlabUserId?: number
  /**
   * 这个人在 Git 里用过的用户名。**可以有多个**。
   *
   * 同一个人经常用不同身份提交：本机 git config 没配、换过账号、用中文名提交。
   * 只认一个名字会漏提交，而漏提交会被判成「日报写了但代码没有」，方向正好反了。
   */
  gitlabUsernames: string[]
  /** 用于匹配提交 author_email。同样可以有多个（私人邮箱、旧邮箱） */
  emails: string[]
  /** 停用后不参与批量检查（如离职、长期外派） */
  enabled: boolean
  /** 关注标记：列表默认只显示关注的，检查时默认也只勾选关注的 */
  followed: boolean
  createdAt: string
  updatedAt: string

  /* --- 以下为派生字段，由查询时聚合得出，不落库 --- */
  /** 在日报里出现过的次数 */
  usageCount?: number
  /** 最近一次日报的日期 */
  lastReportDate?: string
}

/**
 * 判定链路需要的最小身份信息。
 *
 * 单独抽出来而不是直接用 MemberProfile：引擎只关心「谁、GitLab 用户名、邮箱」，
 * 让它可以接受实体、也接受临时拼出来的对象（比如演示数据），
 * 不必为了跑一次检查去构造一个完整的实体。
 */
export interface MemberIdentityInput {
  id: string
  name: string
  gitlabUsernames?: string[]
  emails: string[]
}

/* ------------------------------------------------------------------ *
 * 日报
 * ------------------------------------------------------------------ */

export interface DailyReportEntry {
  id: string
  /** 日报里填写的项目名，需要经映射才能对应到 GitLab 项目 */
  projectName: string
  /** 若日报系统本身带项目编码则保留，可用于精确映射 */
  projectCode?: string
  /** 当日投入工时 */
  hours: number
  /** 工作内容描述，LLM 判定的主要依据 */
  content: string
  /** 日报系统里的任务/需求编号，如 JIRA-123 */
  taskRefs?: string[]
}

export interface DailyReport {
  id: string
  /** YYYY-MM-DD，按日报归属日期而非提交时间 */
  date: string
  memberId: string
  memberName: string
  entries: DailyReportEntry[]
  /** 工时合计，便于校验日报是否填满工作日 */
  totalHours: number
  submittedAt?: string
}

/* ------------------------------------------------------------------ *
 * GitLab
 * ------------------------------------------------------------------ */

export interface GitLabProjectRef {
  /** GitLab 项目数字 ID */
  id: number
  /** 形如 group/subgroup/repo */
  pathWithNamespace: string
  name: string
  webUrl: string
  /**
   * 仓库的默认分支。
   *
   * 拉提交时显式按它取，而不是依赖 GitLab「不传就是默认分支」的隐含行为：
   * 这个实例里不少仓库的默认分支本身就是 feature/*，不写清楚的话，
   * 界面上没人知道统计的是哪条线，也判断不了漏没漏。
   */
  defaultBranch?: string
}

/* ------------------------------------------------------------------ *
 * 项目实体
 * ------------------------------------------------------------------ */

/**
 * 同步状态。
 *
 * `missing` 是刻意单独一档的：项目在 GitLab 上被删除或改名后，
 * 检查时会拉不到提交，如果不区分出来，表现出来就是「这个人当天没提交」，
 * 而实际原因是项目本身没了——两者对管理者的含义完全不同。
 */
export type ProjectSyncStatus = 'unsynced' | 'synced' | 'missing' | 'error'

/**
 * manual = 手工建的
 * log = 从日志中心同步进来的（当前的主要来源）
 * synced = 早期从 GitLab 按仓库生成的（旧模型，项目改成以日志中心为准之前的历史数据）
 */
export type ProjectOrigin = 'manual' | 'log' | 'synced'

/**
 * 项目实体。
 *
 * 「日报里写的项目名/编码/别名」就是它自身的匹配键，
 * 「GitLab id / 路径 / 地址」是它的同步结果——映射关系不再单独维护。
 */
/** 项目与 GitLab 的关联方式 */
export interface ProjectLink {
  /**
   * repo = 具体仓库（pathWithNamespace，如 rd-platform/payment-gateway）
   * group = 组名，会扫描该组下的全部子组
   */
  kind: 'repo' | 'group'
  path: string
}

/** 关联链接展开后的具体仓库 */
export interface ProjectRepo {
  id: number
  pathWithNamespace: string
  name: string
  webUrl: string
  /** 仓库默认分支，统计提交时按它取 */
  defaultBranch?: string
  /** 来自哪条链接，同步失败时能定位到具体来源 */
  linkKind: 'repo' | 'group'
  linkPath: string
}

export interface Project {
  id: string
  /**
   * 日志中心的项目 ID。项目以日志中心为准，这个字段就是它的身份。
   * 手工建的项目没有它。
   */
  logProjectId?: string
  /** 显示名。默认与日报里写的项目名一致 */
  name: string
  /** 项目编码，对应日报的 projectCode */
  code?: string
  description?: string
  /**
   * 关联的 GitLab 仓库/组。
   *
   * 一个业务项目可能落在一个仓库里，也可能散在多个仓库、甚至一整组仓库里。
   * 检查时把这些仓库的提交合并算作这个项目的产出。
   */
  links: ProjectLink[]
  /**
   * links 展开后的具体仓库（落库缓存）。
   *
   * 展开要调 GitLab，所以解析一次就存下来，检查时直接用。
   * 组里新增仓库需要重新解析才会出现在这里。
   */
  repos: ProjectRepo[]
  /**
   * 旧模型的单仓库字段。
   *
   * 项目改成「以日志中心为准」之前，一个项目就是一个 GitLab 仓库，这些字段是它的身份。
   * 现在只作为迁移回退：links 为空时用它拼出一个仓库。
   */
  gitlabProjectId?: number
  pathWithNamespace?: string
  /** 仓库页地址，也就是界面上说的「git 地址」 */
  webUrl?: string
  cloneUrl?: string
  defaultBranch?: string
  visibility?: string
  namespace?: string
  /** 归档仓库默认不参与检查，但仍列出，避免看起来「凭空少了几条」 */
  archived: boolean
  /** 日报里可能用别的叫法写这个项目 */
  aliases: string[]
  matchMode: ProjectMatchMode
  /** 开发模式，决定有效工时里代码量的修正权重。老数据没有这个字段时按 manual 处理 */
  devMode: DevMode
  /** 是否参与检查 */
  enabled: boolean
  /**
   * 关注标记。这是用户圈定「我关心哪些」的方式，具体作用分两处：
   *
   * - 列表默认只显示关注的（人和项目面板都是）
   * - 检查时默认只勾选关注的人；未关注的项目**不参与匹配**，
   *   相关的日报条目算「无法核对」，不进符合度的分母
   *
   * 和 enabled 是两回事：enabled 是「要不要用这个配置」，
   * 关注是「我眼下关不关心它」。可以关注一个暂停检查的项目，
   * 也可以让已交接出去的项目从视野里淡出。
   */
  followed: boolean
  origin: ProjectOrigin
  syncStatus: ProjectSyncStatus
  syncError?: string
  syncedAt?: string
  createdAt: string
  updatedAt: string
}

/** 与 projectMatchModes 保持一致，见 core/config/settings.ts */
export type ProjectMatchMode = 'exact' | 'contains' | 'regex'

/**
 * 项目开发模式。
 *
 * 只用于「有效工时」估算里代码量的修正权重：AI 开发的项目一天几千行是常态，
 * 按行数线性折算会把人推到十几小时。事实指标（提交数、改动量、覆盖率）不受影响。
 */
export type DevMode = 'manual' | 'ai-assisted' | 'ai-driven'

export interface CommitFileChange {
  path: string
  oldPath?: string
  isNew: boolean
  isDeleted: boolean
  isRenamed: boolean
  additions: number
  deletions: number
  /**
   * 改动正文。
   *
   * 只在判定时用：不少项目的提交信息写得随意（`update`、`fix`），
   * 光看标题判断不了做的是什么，必须看真正改了哪些代码。
   * 不落库——`files` 列只存路径，这里带上全文会让数据库迅速膨胀。
   */
  patch?: string
}

export interface GitCommit {
  id: string
  shortId: string
  projectId: number
  projectPath: string
  title: string
  message: string
  authorName: string
  authorEmail: string
  authoredDate: string
  committedDate: string
  webUrl: string
  /** 这条提交是从哪条分支拉到的。没有它，界面上没法回答「算的是哪条线」 */
  refName?: string
  /** 提交规模，用于判断是否为实质性工作（区分格式化/合并提交） */
  stats?: { additions: number, deletions: number, total: number }
  fileChanges?: CommitFileChange[]
}

/* ------------------------------------------------------------------ *
 * 检查结论
 * ------------------------------------------------------------------ */

/**
 * 单条日报条目的判定结果。
 * - matched    提交内容与日报描述一致
 * - partial    部分一致（方向对但范围/深度不符，或仅部分描述有对应提交）
 * - mismatched 有对应项目的提交，但内容与描述明显不符
 * - no-commit  完全没有对应项目的提交（可能是未提交的工作，如会议/调研）
 * - unverified 数据不足或依赖不可用，无法判定
 */
export type VerdictLevel
  = | 'matched'
    | 'partial'
    | 'mismatched'
    | 'no-commit'
    | 'unverified'

/**
 * 证据强度。
 *
 * strong：命中的提交里有具体内容（文件/改动正文），或日报里的关键词能在提交里找到；
 * medium：有提交、判定也一致，但没有可落到具体改动的证据；
 * weak：判定为不符或无法判定；
 * none：当天没有提交。
 */
export type EvidenceStrength = 'strong' | 'medium' | 'weak' | 'none'

export interface InspectionEvidence {
  commitId: string
  shortId: string
  projectPath: string
  title: string
  authoredDate: string
  webUrl: string
  /** 命中的文件，供人工快速核对 */
  files: string[]
  /** 该提交与日报描述的关联点，一句话 */
  relevance: string
}

export interface EntryInspection {
  entryId: string
  projectName: string
  content: string
  hours: number
  /** 归一化后的工时占比，0-1 */
  ratio: number
  verdict: VerdictLevel
  /** 0-1，LLM 自评置信度 */
  confidence: number
  /** 证据强度：由代码统计与关键词命中得出，不依赖模型自评 */
  evidenceStrength: EvidenceStrength
  reason: string
  evidence: InspectionEvidence[]
  /** 命中的提交 ID，供反向统计「未被日报覆盖的提交」 */
  matchedCommitIds: string[]
  /**
   * 该条描述属于不产出代码的工作（会议、评审、文档、答疑等）。
   * 这类条目没有提交是正常的，汇总时不计入扣分。
   */
  nonCodingWork: boolean
  /** 项目未能映射到 GitLab 仓库时为 true，判定结论不可靠 */
  projectUnresolved: boolean
  suggestions?: string[]
}

export interface InspectionSummary {
  /**
   * 0-100 的加权符合度。
   * 只统计「可核对工时」：排除非编码条目（会议/评审）和项目未映射的条目，
   * 分母是 checkedHours，这样分数反映的是「日报里能自证的部分做得怎么样」。
   * 漏报的提交不计入分数，单独用 orphanCommitCount 呈现。
   */
  score: number
  /** score 的分母 */
  checkedHours: number
  totalHours: number
  matchedHours: number
  partialHours: number
  mismatchedHours: number
  noCommitHours: number
  /** 未产出代码的工时（会议/评审等），不计入分数 */
  nonCodingHours: number
  /** 项目未能映射到仓库的工时，无法核对，不计入分数 */
  unresolvedHours: number
  /** 日报未覆盖但确有提交的项目，说明存在漏报 */
  orphanCommitCount: number

  /* --- 工作量口径：全部由提交记录统计得出，不含会议等非编码工作 --- */
  /** 提交会话数（间隔超过 60 分钟算新会话） */
  sessions: number
  /** 有提交的 30 分钟时段数 */
  activeBuckets: number
  /** 首末提交跨度（小时，封顶 12） */
  presenceHours: number
  /** 活跃时段折算工时 */
  activeHours: number
  /** 预估有效工时区间 */
  effectiveLow: number
  effectiveHigh: number
  /** 有效工时中值 / 8 小时 */
  saturation: number
  /** 提交集中在短时间、改动量大：可能是数天的补提交 */
  batchSuspect: boolean
  /** 口径说明，界面上原样展示 */
  workloadBasis: string
}

export interface InspectionResult {
  id: string
  date: string
  memberId: string
  memberName: string
  entries: EntryInspection[]
  /** 当日该成员有提交、但日报里没有提及的项目 */
  orphanCommits: GitCommit[]
  /** 抓到但未被任何条目引用的提交，供 LLM 复核漏报 */
  summary: InspectionSummary
  /** 面向管理者的整体结论，markdown */
  narrative: string
  meta: {
    model: string
    durationMs: number
    inputTokens?: number
    outputTokens?: number
    /** 本次检查覆盖的 GitLab 项目 */
    scopedProjects: string[]
    /**
     * 仓库 id → 日报里的项目名。
     * 用来把「有提交但没被条目引用」的仓库归回业务项目，而不是按仓库路径另起一行。
     */
    repoProjectNames?: Record<number, string>
    /** 一次执行（单日或区间）的标识；同一次检查的所有人日结果共享它 */
    runId?: string
    /** 这次执行的日期范围 */
    runFrom?: string
    runTo?: string
    /** 区间内实际检查的工作日数（跳过节假日/周末后的天数） */
    checkedWorkdays?: number
    /** 区间内被工作日历跳过的天数 */
    skippedDays?: number
    /** 检查生成的时刻 */
    createdAt: string
  }
}

/* ------------------------------------------------------------------ *
 * 检查任务（一次运行的输入）
 * ------------------------------------------------------------------ */

export type InspectionStage
  = | 'idle'
    | 'collecting-report'
    | 'collecting-commits'
    | 'matching'
    | 'judging'
    | 'summarizing'
    | 'done'
    | 'failed'

export interface InspectionProgress {
  stage: InspectionStage
  message: string
  /** 0-1 */
  percent: number
}

export interface InspectionRun {
  id: string
  date: string
  memberId: string
  memberName: string
  status: 'draft' | 'running' | 'succeeded' | 'failed'
  progress: InspectionProgress
  report?: DailyReport
  commits: GitCommit[]
  result?: InspectionResult
  error?: string
  startedAt?: string
  finishedAt?: string
}
