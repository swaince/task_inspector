import type { AppSettings } from '../config/settings'
import type { MemberProfile, Project } from '../domain/types'
import { transport } from '../bridge'
import { createProjectDraft, useProjectStore } from './projects'
import { createMemberDraft, useMemberStore } from './members'
import { useSettingsStore } from './settings'

/**
 * 把旧版 settings 里的「项目映射 / 成员映射」迁移成实体。
 *
 * 迁移前：项目只是映射规则（日报里的名字 → GitLab 路径），自身没有实体；
 * 成员同理。迁移后这些关系就是实体自己的字段。
 *
 * 不需要额外的迁移标记：以「实体表为空 且 配置里还有映射」作为触发条件，
 * 迁移完成后清空配置里的映射数组，天然幂等。中途失败则数组还在，下次启动会重试。
 */
export async function migrateMappingsToEntities() {
  const settingsStore = useSettingsStore()
  const projectStore = useProjectStore()
  const memberStore = useMemberStore()

  await Promise.all([projectStore.load(), memberStore.load()])

  const settings = settingsStore.settings
  const hasLegacyProjects = settings.projectMappings.length > 0
  const hasLegacyMembers = settings.memberMappings.length > 0
  if (!hasLegacyProjects && !hasLegacyMembers)
    return

  if (hasLegacyProjects && projectStore.items.length === 0)
    await seedProjects(settings, projectStore)

  if (hasLegacyMembers && memberStore.items.length === 0)
    await seedMembers(settings, memberStore)

  // 迁移完成后清掉旧字段，避免出现「两处都记着同一件事」
  settings.projectMappings = []
  settings.memberMappings = []
  await settingsStore.save()
}

async function seedProjects(settings: AppSettings, store: ReturnType<typeof useProjectStore>) {
  for (const mapping of settings.projectMappings) {
    const draft = createProjectDraft(mapping.reportProjectName)
    const project: Project = {
      ...draft,
      // 旧模型里一条映射可以指向多个仓库，新模型下一个项目对应一个仓库。
      // 多出来的路径放进别名是不对的（别名是「日报里的其它叫法」），
      // 所以只取第一个，其余在界面上以提示形式让人确认。
      pathWithNamespace: mapping.gitlabProjectPaths[0],
      matchMode: mapping.matchMode,
      enabled: true,
    }
    await transport().projectsUpsert(project)
  }
  await store.load()
}

async function seedMembers(settings: AppSettings, store: ReturnType<typeof useMemberStore>) {
  for (const mapping of settings.memberMappings) {
    const draft = createMemberDraft(mapping.reportMemberName || mapping.reportMemberId)
    const member: MemberProfile = {
      ...draft,
      reportMemberId: mapping.reportMemberId || undefined,
      gitlabUsernames: mapping.gitlabUsername ? [mapping.gitlabUsername] : [],
      emails: mapping.emails,
      team: mapping.team || undefined,
      enabled: mapping.enabled,
    }
    await transport().membersUpsert(member)
  }
  await store.load()
}
