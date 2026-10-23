import type { DocId } from './index'

/**
 * 应用能力清单。
 *
 * 页面和工具的说明都指向官方文档 id；内置技能由这份清单和工具注册表拼装，
 * 新增页面/工具时只改这里，不需要用户维护 skill 文件。
 */
export interface AppFeature {
  route: string
  title: string
  docId: DocId
}

export const APP_FEATURES: AppFeature[] = [
  { route: 'dashboard', title: '概览', docId: 'overview' },
  { route: 'inspect', title: '执行检查', docId: 'inspection' },
  { route: 'history', title: '检查历史', docId: 'results' },
  { route: 'result', title: '单条检查结果', docId: 'results' },
  { route: 'assistant', title: '应用助手', docId: 'assistant-tools' },
  { route: 'project-activity', title: '项目活动', docId: 'activities' },
  { route: 'activity-detail', title: '项目活动详情', docId: 'activities' },
  { route: 'member-activity', title: '人员活动', docId: 'activities' },
  { route: 'projects', title: '项目', docId: 'projects' },
  { route: 'project-profile', title: '项目画像', docId: 'projects' },
  { route: 'project-chat', title: '项目对话', docId: 'project-chat' },
  { route: 'members', title: '人员', docId: 'members' },
  { route: 'settings', title: '设置', docId: 'settings' },
]

/** 工具 id → 官方文档 id，用于保证每个工具都有说明 */
export const TOOL_DOCS: Record<string, DocId> = {
  'docs.search': 'assistant-tools',
  'members.list': 'members',
  'members.scanProjectAuthors': 'members',
  'members.ensure': 'members',
  'members.ensureMany': 'members',
  'members.bindProjectAuthors': 'members',
  'projects.list': 'projects',
  'projects.ensure': 'projects',
  'shell.run': 'assistant-tools',
}
