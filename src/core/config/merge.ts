import type { AppSettings, DailyReportFieldMap, DailyReportLoginSettings, DailyReportSettings } from './settings'
import { createDefaultSettings, DEFAULT_FIELD_MAP, SETTINGS_VERSION } from './settings'

/**
 * 早先的默认拉取路径。
 *
 * 默认值改成分页接口（POST + 请求体）之后，老配置里存着的这份旧默认值会把新值盖回去，
 * 拼出「用 POST 去请求一个 GET 地址」。只在对方从没动过这个字段时才替换成新默认值——
 * 自己填过地址的一定保留。
 */
const LEGACY_DEFAULT_LIST_PATH = '/api/daily-reports?date={date}'

/**
 * 早先的默认请求体模板。
 *
 * 里面用的是纯日期 `{startDate}`，而这个系统的起止日期是 `LocalDateTime`，
 * 只给 `2026-10-16` 会在反序列化那步抛异常，服务端回一句「请求体读取异常」，
 * 完全看不出是日期格式的问题。对照前端真实请求确认后改成带时间的形态。
 *
 * 和上面一样：只有整份**逐字等于**这份旧默认才替换，自己改过的一定保留。
 */
const LEGACY_DEFAULT_BODY_TEMPLATE
  = '{"page":{page},"limit":{limit},"queryContent":"","projectId":"","startDate":"{startDate}","endDate":"{endDate}","createUserIds":[],"logSendUserRead":""}'

/**
 * 早先的默认字段映射。
 *
 * 合并是逐字段覆盖的，老配置里存着这套通用占位名（`data` / `items` / `hours`…），
 * 就会一直盖住新默认值。它们的症状是「接口通了、数据也回来了，但一条都解析不出来」——
 * 因为 `itemsPath: 'data'` 取到的是个对象不是数组。
 *
 * 这两套值都不是谁主动选的，是默认值。所以只在**整份完全一致**时才替换：
 * 动过其中任何一项就整份保留，不猜用户想保留哪部分。
 */
const LEGACY_DEFAULT_FIELD_MAP: DailyReportFieldMap = {
  itemsPath: 'data',
  datePath: 'date',
  memberIdPath: 'userId',
  memberNamePath: 'userName',
  entriesPath: 'items',
  entryProjectNamePath: 'projectName',
  entryProjectCodePath: 'projectCode',
  entryHoursPath: 'hours',
  entryContentPath: 'content',
  entryTaskRefsPath: 'taskRefs',
}

function isLegacyDefaultFieldMap(map: DailyReportFieldMap | undefined): boolean {
  if (!map)
    return false
  return (Object.keys(LEGACY_DEFAULT_FIELD_MAP) as Array<keyof DailyReportFieldMap>)
    .every(key => map[key] === LEGACY_DEFAULT_FIELD_MAP[key])
}

/**
 * 「我自己的日志」接口的路径特征。
 *
 * 核查的对象是**别人发给 / 抄送给我**的日报；查自己的日志既不是待核查对象，
 * 结果也会退化成只有本人一条记录。老配置里存着这个接口，默认值改成新接口也
 * 盖不回来（已保存的字段优先），所以按路径特征做一次性迁移。
 */
const SELF_LOG_PATH = 'page/self'

/**
 * 把「我的日志」配置迁到「发送/抄送给我的日志」。
 *
 * 两个接口的请求形状完全不同：旧的是 GET + 日期写在 query 里，新的是 POST +
 * JSON 请求体。只换路径会变成「用 POST 去打一个 GET 地址」，所以路径、方法、
 * 请求体必须一起换。其余配置（地址、字段映射、登录）保持不动。
 *
 * 只在版本低于 4 且路径仍指向 self 接口时执行；迁移后版本号会落盘，
 * 之后再手动改回 self 也不会被反复覆盖。
 */
function migrateSelfLogEndpoint(
  merged: DailyReportSettings,
  saved: Partial<DailyReportSettings> | undefined,
  savedVersion: number,
  base: DailyReportSettings,
): DailyReportSettings {
  if (savedVersion >= 4 || !saved?.listPathTemplate?.includes(SELF_LOG_PATH))
    return merged
  return {
    ...merged,
    listPathTemplate: base.listPathTemplate,
    method: base.method,
    bodyTemplate: base.bodyTemplate,
  }
}

/**
 * 撤回 v2 里误加的那次 `type` 改写。
 *
 * v2 把 `type` 从 0 强制改成了 1，依据是登录页打包代码里的 `type: 1`——
 * 但 1 是**需要图形验证码**的那条路径，自动补的随机码永远过不了，
 * 等于把一个本来就登不上的配置锁死。
 *
 * 这里只回退「被那次改写写成、且手上没有任何验证码可用」的配置：
 * 自己填了 key/code 的不动，version 3 起也再不会碰 `type`——
 * 这个字段从此完全按用户在设置页填的值发。
 *
 * 用户的配置大多已经存成 v2 了，所以标记必须推到 3，用 `< 2` 是够不着它们的。
 */
function revertForcedLoginType(
  login: DailyReportLoginSettings,
  savedVersion: number,
): DailyReportLoginSettings {
  const forcedByUs = savedVersion < 3
    && login.type === 1
    && !login.captchaKey.trim()
    && !login.captchaCode.trim()
  return forcedByUs ? { ...login, type: 0 } : login
}

function mergeDailyReport(
  base: DailyReportSettings,
  saved: Partial<DailyReportSettings> | undefined,
  savedVersion: number,
): DailyReportSettings {
  // 整份还是旧默认值就换成新的；动过任何一项就整份按已保存的来
  const fieldMap: DailyReportFieldMap = isLegacyDefaultFieldMap(saved?.fieldMap)
    ? { ...DEFAULT_FIELD_MAP }
    : { ...base.fieldMap, ...saved?.fieldMap }

  const merged: DailyReportSettings = {
    ...base,
    ...saved,
    fieldMap,
    projectList: { ...base.projectList, ...saved?.projectList },
    userList: { ...base.userList, ...saved?.userList },
    login: revertForcedLoginType({ ...base.login, ...saved?.login }, savedVersion),
  }

  // method 是 v2 才加的字段，缺它就说明这份配置是升级前的
  if (saved && saved.method === undefined && saved.listPathTemplate === LEGACY_DEFAULT_LIST_PATH)
    merged.listPathTemplate = base.listPathTemplate

  // 请求体模板还是旧默认那份（纯日期）就换成带时间的
  if (saved?.bodyTemplate === LEGACY_DEFAULT_BODY_TEMPLATE)
    merged.bodyTemplate = base.bodyTemplate

  return migrateSelfLogEndpoint(merged, saved, savedVersion, base)
}

/**
 * 合并已保存的配置和默认值。
 * 逐字段深合并，这样新增配置项在升级后能拿到默认值，不会因为老配置文件缺字段而崩。
 */
export function mergeSettings(saved: Partial<AppSettings> | null | undefined): AppSettings {
  const base = createDefaultSettings()
  if (!saved)
    return base

  // 先取出来：下面的 ...saved 会被 version: SETTINGS_VERSION 覆盖掉，
  // 迁移判断需要的是「存的时候是第几版」
  const savedVersion = typeof saved.version === 'number' ? saved.version : 1

  return {
    ...base,
    ...saved,
    version: SETTINGS_VERSION,
    gitlab: { ...base.gitlab, ...saved.gitlab },
    dailyReport: mergeDailyReport(base.dailyReport, saved.dailyReport, savedVersion),
    llm: { ...base.llm, ...saved.llm },
    ldap: {
      ...base.ldap,
      ...saved.ldap,
      attributeMap: { ...base.ldap.attributeMap, ...saved.ldap?.attributeMap },
    },
    rules: { ...base.rules, ...saved.rules },
    retention: { ...base.retention, ...saved.retention },
    analysis: { ...base.analysis, ...saved.analysis },
    workCalendar: { ...base.workCalendar, ...saved.workCalendar },
    projectMappings: saved.projectMappings ?? base.projectMappings,
    memberMappings: saved.memberMappings ?? base.memberMappings,
  }
}
