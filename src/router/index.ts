import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 桌面端用 hash 路由：Tauri 打包后是 file:// 协议加载资源，
 * history 模式下刷新或深链会拿不到文件。
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { title: '概览', description: '最近一次检查的结论、需要跟进的人和异常提交' },
    },
    {
      path: '/inspect',
      name: 'inspect',
      component: () => import('@/views/InspectView.vue'),
      meta: {
        title: '执行检查',
        description: '选一段时间，核查关注成员的日报能否被当天的代码提交证明；默认最近 7 天，按工作日历跳过节假日',
      },
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@/views/HistoryView.vue'),
      meta: { title: '检查历史', description: '按日期回看已经保存的检查结论' },
    },
    {
      path: '/assistant',
      name: 'assistant',
      component: () => import('@/views/AssistantView.vue'),
      meta: {
        title: '应用助手',
        description: '查官方文档、问功能与数据口径，或在确认后维护人员与项目关联',
      },
    },
    {
      path: '/result/:date/:memberId',
      name: 'result',
      component: () => import('@/views/ResultView.vue'),
      meta: { title: '检查详情', description: '某个成员某一天的逐条核对结果与证据' },
    },
    {
      path: '/activity',
      name: 'project-activity',
      component: () => import('@/views/ProjectActivityView.vue'),
      meta: {
        title: '项目活动',
        description: '选一个项目，看区间内的提交节奏、人员投入和日报覆盖；不判个人对错',
      },
    },
    {
      path: '/activity/:projectId/:date/:memberKey',
      name: 'activity-detail',
      component: () => import('@/views/ActivityDetailView.vue'),
      meta: {
        title: '活动详情',
        activeName: 'project-activity',
        description: '某天某人的提交明细与当天的日报对照',
      },
    },
    {
      path: '/member-activity',
      name: 'member-activity',
      component: () => import('@/views/MemberActivityView.vue'),
      meta: {
        title: '人员活动',
        description: '选一个人，看区间内的时间分配、申报与代码估算的差异；不判单日日报真假',
      },
    },
    {
      path: '/projects',
      name: 'projects',
      component: () => import('@/views/ProjectsView.vue'),
      meta: { title: '项目', description: '维护项目与 GitLab 仓库/分组的关联，以及检查的关注范围' },
    },
    {
      path: '/projects/:id/profile',
      name: 'project-profile',
      component: () => import('@/views/ProjectProfileView.vue'),
      meta: {
        title: '项目画像',
        activeName: 'projects',
        description: '分析项目代码结构、模块依赖和测试缺口',
      },
    },
    {
      path: '/projects/:id/chat',
      name: 'project-chat',
      component: () => import('@/views/ProjectChatView.vue'),
      meta: {
        title: '项目对话',
        activeName: 'projects',
        description: '围绕单个项目自由提问：架构、模块、核心功能、最近开发情况',
      },
    },
    {
      path: '/members',
      name: 'members',
      component: () => import('@/views/MembersView.vue'),
      meta: { title: '人员', description: '维护人员及其 GitLab 身份，决定提交能归到谁' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: '设置', description: '配置 GitLab、日报系统、模型和代码分析环境' },
    },
    // 旧的深链（比如已经下线的 #/reports）落到首页，而不是留一片空白
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
