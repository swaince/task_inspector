import type { MemberProfile } from '../domain/types'
import type { LogSystemUser } from '../adapters/dailyReport'
import { transport } from '../bridge'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { uid } from '@/lib/format'

export function createMemberDraft(name = ''): MemberProfile {
  const now = new Date().toISOString()
  return {
    id: uid(),
    reportMemberId: undefined,
    name,
    employeeNo: undefined,
    team: undefined,
    role: undefined,
    gitlabUserId: undefined,
    gitlabUsernames: [],
    emails: [],
    enabled: true,
    followed: true,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 人员实体。
 *
 * 替代了原先 settings 里的「成员映射」：日报系统的人 → GitLab 账号的对应关系
 * 就是这个实体的字段，不再单独维护一份映射。
 */
export const useMemberStore = defineStore('members', () => {
  const items = ref<MemberProfile[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const enabled = computed(() => items.value.filter(m => m.enabled))

  /** 没绑定 GitLab 身份的人，判定时无法按邮箱过滤提交，结果会混进别人的提交 */
  const unbound = computed(() =>
    items.value.filter(m => m.enabled && !m.gitlabUsernames?.length && m.emails.length === 0),
  )

  /**
   * 多个成员声明了同一个邮箱。
   *
   * 这会让「这条提交是谁的」无法判断——两边都会把它算成自己的，
   * 检查结论就不可信了。属于必须让人工裁决的配置冲突，所以单独暴露出来。
   */
  const emailConflicts = computed(() => {
    const seen = new Map<string, string[]>()
    for (const member of items.value) {
      if (!member.enabled)
        continue
      for (const email of member.emails) {
        const key = email.trim().toLowerCase()
        if (!key)
          continue
        seen.set(key, [...(seen.get(key) ?? []), member.name])
      }
    }
    return [...seen.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([email, names]) => ({ email, names }))
  })

  /** 有日报但还没配进来的人（从日报数据里反查） */
  function missingFrom(reportMemberIds: Array<{ id: string, name: string }>) {
    const known = new Set(
      items.value.flatMap(m => [m.reportMemberId, m.name].filter(Boolean) as string[]),
    )
    return reportMemberIds.filter(m => !known.has(m.id) && !known.has(m.name))
  }

  async function load() {
    if (loading.value)
      return
    loading.value = true
    try {
      items.value = await transport().membersList()
      loaded.value = true
    }
    catch (err) {
      error.value = `读取人员失败：${err instanceof Error ? err.message : String(err)}`
    }
    finally {
      loading.value = false
    }
  }

  async function save(member: MemberProfile) {
    const next = { ...member, updatedAt: new Date().toISOString() }
    await transport().membersUpsert(next)
    const index = items.value.findIndex(m => m.id === next.id)
    if (index === -1)
      items.value = [...items.value, next].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    else
      items.value = items.value.map(m => (m.id === next.id ? next : m))
  }

  async function remove(id: string) {
    await transport().membersDelete(id)
    items.value = items.value.filter(m => m.id !== id)
  }

  /**
   * 批量改关注。
   *
   * 走 `membersImport`——传输层本来就有一条批量 upsert 的通道（导入日报里的人用），
   * 复用它就不用为每个选中项各跑一次往返。Rust 侧是 upsert，语义正确。
   */
  async function setFollowedMany(ids: string[], followed: boolean) {
    const wanted = new Set(ids)
    if (!wanted.size)
      return
    const now = new Date().toISOString()
    const changed = items.value
      .filter(m => wanted.has(m.id))
      .map(m => ({ ...m, followed, updatedAt: now }))
    if (!changed.length)
      return
    await transport().membersImport(changed)
    const byId = new Map(changed.map(m => [m.id, m]))
    items.value = items.value.map(m => byId.get(m.id) ?? m)
  }

  /** 批量删除。列表最后一次性过滤，避免每删一个就重建一遍数组 */
  async function removeMany(ids: string[]) {
    const wanted = new Set(ids)
    if (!wanted.size)
      return
    for (const id of wanted)
      await transport().membersDelete(id)
    items.value = items.value.filter(m => !wanted.has(m.id))
  }

  async function importMany(members: MemberProfile[]) {
    const n = await transport().membersImport(members)
    await load()
    return n
  }

  /* ------------------------------------------------------------------ *
   * 从日志中心同步人员
   * ------------------------------------------------------------------ */

  interface LogUserSyncOutcome {
    remote: number
    created: number
    /** 这次补上了日报 ID 的人 —— 正是原先「和日报对不上」的那批 */
    linked: number
    /** 只补了部门/邮箱/用户名等其它字段 */
    updated: number
    unchanged: number
    /** 需要人工裁决的：重名、ID 冲突 */
    conflicts: string[]
  }

  /**
   * 以日志中心的用户清单为准建人，并把日报 ID 补上。
   *
   * 匹配顺序：日报 ID → 工号（登录名）→ 姓名。姓名只在**唯一命中**时才用，
   * 重名一律列出来让人裁决——猜错会把两个人的结论算到一起，比不匹配更糟。
   *
   * 这是解决「同一个人被拆成两条」的关键：LDAP 建的人 `reportMemberId` 是空的，
   * 而日报用的是日志中心的用户 ID，补上它两边才对得上。
   */
  async function syncFromLogUsers(users: LogSystemUser[]): Promise<LogUserSyncOutcome> {
    const outcome: LogUserSyncOutcome = {
      remote: users.length,
      created: 0,
      linked: 0,
      updated: 0,
      unchanged: 0,
      conflicts: [],
    }

    const norm = (s?: string) => (s ?? '').trim().toLowerCase()
    const next = [...items.value]
    const now = new Date().toISOString()

    for (const user of users) {
      const name = user.name.trim()
      if (!user.id || !name)
        continue
      const login = user.loginName?.trim()

      const byReportId = next.find(m => m.reportMemberId === user.id)
      const byEmployeeNo = login ? next.find(m => norm(m.employeeNo) === norm(login)) : undefined

      if (byReportId && byEmployeeNo && byReportId.id !== byEmployeeNo.id) {
        outcome.conflicts.push(
          `「${name}」的日报 ID 和工号分别命中「${byReportId.name}」与「${byEmployeeNo.name}」`,
        )
        continue
      }

      let hit = byReportId ?? byEmployeeNo
      if (!hit) {
        const byName = next.filter(m => norm(m.name) === norm(name))
        if (byName.length > 1) {
          outcome.conflicts.push(`「${name}」对应 ${byName.length} 个本地同名人员，需要人工确认`)
          continue
        }
        hit = byName[0]
      }

      if (hit) {
        // 已有日报 ID 却和日志中心不一致：这是两个人，不能合并
        if (hit.reportMemberId && hit.reportMemberId !== user.id) {
          outcome.conflicts.push(
            `「${name}」本地日报 ID 是 ${hit.reportMemberId}，日志中心是 ${user.id}`,
          )
          continue
        }

        const patch: Partial<MemberProfile> = {}
        if (!hit.reportMemberId)
          patch.reportMemberId = user.id
        if (!hit.employeeNo && login)
          patch.employeeNo = login
        if (!hit.team && user.dept)
          patch.team = user.dept
        if (!hit.emails.length && user.mail)
          patch.emails = [user.mail]
        // 还没配任何 Git 身份时用登录名起个头——多数情况下 GitLab 用户名就是登录名。
        // 不对的话在人员面板里改掉即可，空着反而一条提交都匹配不上。
        if (!hit.gitlabUsernames.length && login)
          patch.gitlabUsernames = [login]

        if (!Object.keys(patch).length) {
          outcome.unchanged++
          continue
        }

        const updated = { ...hit, ...patch, updatedAt: now }
        await transport().membersUpsert(updated)
        next[next.indexOf(hit)] = updated
        if (patch.reportMemberId)
          outcome.linked++
        else
          outcome.updated++
        continue
      }

      const draft: MemberProfile = {
        ...createMemberDraft(name),
        reportMemberId: user.id,
        employeeNo: login,
        team: user.dept,
        emails: user.mail ? [user.mail] : [],
        gitlabUsernames: login ? [login] : [],
        updatedAt: now,
      }
      await transport().membersUpsert(draft)
      next.push(draft)
      outcome.created++
    }

    items.value = next.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return outcome
  }

  return {
    items,
    loaded,
    loading,
    error,
    enabled,
    unbound,
    emailConflicts,
    missingFrom,
    load,
    save,
    remove,
    setFollowedMany,
    removeMany,
    syncFromLogUsers,
    importMany,
  }
})
