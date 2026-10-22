<script setup lang="ts">
import type { Project } from '@/core/domain/types'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderGit2Icon,
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import ProjectForm from '@/components/projects/ProjectForm.vue'
import StatCard from '@/components/common/StatCard.vue'
import type { LogSystemProject } from '@/core/adapters/dailyReport'
import { HttpDailyReportSource } from '@/core/adapters/dailyReport'
import { openExternal } from '@/core/bridge'
import { createProjectDraft, useProjectStore } from '@/core/store/projects'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'
import { cn } from '@/lib/utils'

const projectStore = useProjectStore()
const reportStore = useReportStore()
const settingsStore = useSettingsStore()
const router = useRouter()

const keyword = ref('')
const onlyProblems = ref(false)
/** 默认只显示关注的项目；取消关注的项目仍然存在，只是默认从视野里收起 */
const onlyFollowed = ref(true)
const editing = ref<Project | null>(null)
const dialogOpen = ref(false)
const isNew = ref(false)
const message = ref<string | null>(null)

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return projectStore.items.filter((p) => {
    // 搜索时忽略关注过滤：搜一个明确的名字却因为没关注而搜不到，比搜出多余结果更让人困惑
    if (onlyFollowed.value && !q && !p.followed)
      return false
    if (onlyProblems.value && p.syncStatus !== 'missing' && p.syncStatus !== 'error')
      return false
    if (!q)
      return true
    return [
      p.name,
      p.code,
      p.pathWithNamespace,
      ...p.aliases,
      ...(p.links ?? []).map(l => l.path),
      ...(p.repos ?? []).map(r => r.pathWithNamespace),
    ]
      .filter(Boolean)
      .some(v => String(v).toLowerCase().includes(q))
  })
})

/**
 * 分页。
 *
 * 项目有几百个（从日志中心同步一次就是 748 个），全量渲染会让首屏明显变慢，
 * 而且翻看起来没有节奏。前端分页就够了——数据本来就在内存里。
 */
const PAGE_SIZE = 50
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const paged = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)

// 筛选条件一变就回到第一页，否则会停在一个空页上
watch([keyword, onlyFollowed, onlyProblems], () => { page.value = 1 })
watch(pageCount, (count) => {
  if (page.value > count)
    page.value = count
})

/** 同步异常但同时未被关注的数量：警告里提到它们时得给个入口，
    否则「看得到问题却找不到是哪个」 */
const hiddenProblemCount = computed(() =>
  onlyFollowed.value && !keyword.value.trim()
    ? projectStore.problematic.filter(p => !p.followed).length
    : 0,
)

/** 被关注过滤挡掉的数量，用于提示「还有 N 个未显示」 */
const hiddenByFollow = computed(() =>
  onlyFollowed.value && !keyword.value.trim()
    ? projectStore.items.filter(p => !p.followed).length
    : 0,
)

async function toggleFollow(project: Project, followed: boolean) {
  await projectStore.save({ ...project, followed })
}

/* ------------------------------------------------------------------ *
 * 批量操作
 * ------------------------------------------------------------------ */

const selectedIds = ref<Set<string>>(new Set())
const batchBusy = ref(false)
const confirmDeleteOpen = ref(false)

/**
 * 批量操作只认「当前这一页的行」。
 *
 * 表头的全选作用于当前页，这样它和用户眼前看到的一致；
 * 单个勾选则保留在集合里——翻页或筛选条件变了不会把已经勾掉的悄悄取消掉。
 */
const visibleIds = computed(() => paged.value.map(p => p.id))
const selectedVisibleCount = computed(() => visibleIds.value.filter(id => selectedIds.value.has(id)).length)
const allVisibleSelected = computed(() =>
  visibleIds.value.length > 0 && selectedVisibleCount.value === visibleIds.value.length,
)

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id))
    next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function toggleSelectAll() {
  if (allVisibleSelected.value) {
    // 只取消可见的部分，别把筛选之外的勾选一起清掉
    const next = new Set(selectedIds.value)
    for (const id of visibleIds.value)
      next.delete(id)
    selectedIds.value = next
    return
  }
  selectedIds.value = new Set([...selectedIds.value, ...visibleIds.value])
}

async function batchFollow(followed: boolean) {
  const ids = [...selectedIds.value]
  if (!ids.length)
    return
  batchBusy.value = true
  try {
    await projectStore.setFollowedMany(ids, followed)
    message.value = `已把 ${ids.length} 个项目设为${followed ? '关注' : '取消关注'}`
    selectedIds.value = new Set()
  }
  finally {
    batchBusy.value = false
  }
}

async function batchDelete() {
  const ids = [...selectedIds.value]
  if (!ids.length)
    return
  batchBusy.value = true
  try {
    await projectStore.removeMany(ids)
    message.value = `已删除 ${ids.length} 个项目`
    selectedIds.value = new Set()
    confirmDeleteOpen.value = false
  }
  finally {
    batchBusy.value = false
  }
}

const statusMeta: Record<Project['syncStatus'], { label: string, class: string }> = {
  synced: { label: '正常', class: 'text-emerald-600 dark:text-emerald-500' },
  missing: { label: 'GitLab 上已找不到', class: 'text-destructive' },
  error: { label: '同步失败', class: 'text-destructive' },
  unsynced: { label: '未同步', class: 'text-muted-foreground' },
}

function openNew() {
  editing.value = createProjectDraft()
  isNew.value = true
  dialogOpen.value = true
}

function openEdit(project: Project) {
  editing.value = { ...project }
  isNew.value = false
  dialogOpen.value = true
}

async function save() {
  if (!editing.value)
    return
  if (!editing.value.name.trim()) {
    message.value = '项目名称不能为空'
    return
  }
  await projectStore.save(editing.value)
  dialogOpen.value = false
  message.value = `已保存「${editing.value.name}」`
}

async function remove(project: Project) {
  await projectStore.remove(project.id)
  message.value = `已删除「${project.name}」`
}

/*
 * 项目现在以日志中心为准，「从 GitLab 同步」不再生成项目——GitLab 只提供仓库清单，
 * 项目通过「关联仓库/组」指过去。旧的按仓库生成项目的逻辑还留在 store 里
 * （syncFrom / reconcile），但不从界面暴露：两套来源同时建项目会互相打架。
 */

/* ------------------------------------------------------------------ *
 * 从日志系统同步项目编号
 * ------------------------------------------------------------------ */

const logOpen = ref(false)
const logLoading = ref(false)
const logApplying = ref(false)
const logError = ref<string | null>(null)
const logPreview = ref<LogSystemProject[]>([])
const logCreateMissing = ref(true)
const logOutcome = ref<{
  created: number
  filled: number
  unchanged: number
  skipped: number
  conflicts: string[]
} | null>(null)

/** 应用前先算清楚会发生什么，免得一键建出几十个空项目 */
const logMatch = computed(() => {
  const norm = (s: string) => s.trim().toLowerCase()
  let matched = 0
  let fillable = 0
  let missing = 0
  for (const r of logPreview.value) {
    const number = r.number?.trim()
    const byCode = number
      ? projectStore.items.find(p => p.code && norm(p.code) === norm(number))
      : undefined
    const hit = byCode ?? projectStore.items.find(p => norm(p.name) === norm(r.name))
    if (!hit) {
      missing++
      continue
    }
    matched++
    if (!hit.code && number)
      fillable++
  }
  return { matched, fillable, missing }
})

async function openLogSync() {
  const cfg = settingsStore.settings.dailyReport
  if (cfg.source !== 'http' || !cfg.baseUrl.trim()) {
    message.value = '项目清单来自日报系统接口。先到「设置 → 日报系统」把来源设为接口并填好地址'
    return
  }

  logOpen.value = true
  logLoading.value = true
  logError.value = null
  logPreview.value = []
  logOutcome.value = null
  logCreateMissing.value = true

  try {
    logPreview.value = await new HttpDailyReportSource(cfg).fetchProjectList()
  }
  catch (err) {
    logError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    logLoading.value = false
  }
}

async function applyLogSync() {
  logApplying.value = true
  logError.value = null
  try {
    logOutcome.value = await projectStore.syncFromLogSystem(logPreview.value, {
      createMissing: logCreateMissing.value,
    })
    message.value = `日志系统同步：新增 ${logOutcome.value.created}，补齐编码 ${logOutcome.value.filled}，`
      + `未变 ${logOutcome.value.unchanged}`
  }
  catch (err) {
    logError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    logApplying.value = false
  }
}

// 引用次数是按日报算的，日报没载入的话所有项目都会显示「未引用」，
// 反而比不显示这个数字更容易误导
onMounted(() => {
  projectStore.load()
  reportStore.load()
})
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <div class="grid gap-3 sm:grid-cols-4">
        <StatCard label="项目总数" :value="projectStore.items.length" :icon="FolderGit2Icon" />
        <StatCard label="参与检查" :value="projectStore.enabled.length" hint="停用的不参与匹配" />
        <StatCard
          label="同步异常"
          :value="projectStore.problematic.length"
          :tone="projectStore.problematic.length ? 'bad' : 'good'"
          hint="GitLab 上已删除或同步失败"
        />
        <StatCard
          label="从未被日报引用"
          :value="projectStore.unused.length"
          :tone="projectStore.unused.length ? 'warn' : 'default'"
          hint="多半是匹配键写错了"
        />
      </div>

      <Card class="gap-0 py-3">
        <CardContent class="flex flex-wrap items-center gap-2 px-4">
          <div class="relative min-w-[12rem] flex-1">
            <SearchIcon :size="14" class="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="keyword" placeholder="按名称、编码、仓库路径、别名搜索…" class="pl-8" />
          </div>

          <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              :model-value="onlyFollowed"
              class="scale-75"
              @update:model-value="v => (onlyFollowed = !!v)"
            />
            只看关注
          </label>

          <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              :model-value="onlyProblems"
              class="pointer-events-none"
              @click="onlyProblems = !onlyProblems"
            />
            只看同步异常
          </label>

          <Button variant="outline" :disabled="logLoading" @click="openLogSync">
            <FileTextIcon :size="14" class="mr-1.5" />
            从日志系统同步
          </Button>

          <Button @click="openNew">
            <PlusIcon :size="14" class="mr-1.5" />
            新建项目
          </Button>
        </CardContent>
      </Card>

      <Alert v-if="message">
        <AlertDescription>{{ message }}</AlertDescription>
      </Alert>

      <Alert v-if="projectStore.problematic.length" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertTitle>{{ projectStore.problematic.length }} 个项目的仓库在 GitLab 上已找不到</AlertTitle>
        <AlertDescription>
          <div>
            这类项目检查时会拉不到提交。如果不处理，表现就是「这个人当天没提交」，
            而真实原因是项目被删除或改名了——两者含义完全不同。
          </div>
          <Button
            v-if="hiddenProblemCount"
            variant="link"
            class="h-auto p-0 text-xs"
            @click="onlyFollowed = false"
          >
            其中 {{ hiddenProblemCount }} 个未关注、当前被隐藏，点此显示全部
          </Button>
        </AlertDescription>
      </Alert>

      <Skeleton v-if="projectStore.loading && !projectStore.items.length" class="h-64 w-full" />

      <div v-else-if="!filtered.length" class="rounded-lg border border-dashed p-12 text-center">
        <p class="text-sm text-muted-foreground">
          {{ projectStore.items.length ? '没有匹配的项目' : '还没有项目。点「从日志系统同步」按日志中心的项目清单批量建，或手动新建。' }}
        </p>
        <p v-if="hiddenByFollow" class="mt-1 text-xs text-muted-foreground">
          另有 {{ hiddenByFollow }} 个未关注的项目被过滤掉了
        </p>
      </div>

      <div v-else class="overflow-hidden rounded-lg border">
        <!--
          批量操作条常驻表格上方，高度固定。没有勾选时按钮置灰而不是隐藏，
          这样勾选、取消勾选只改变按钮状态，表格不会上下跳动。
        -->
        <div class="flex h-11 items-center gap-2 border-b px-3 text-[11px] text-muted-foreground">
          <span v-if="selectedIds.size" class="font-medium text-foreground">
            已选 {{ selectedIds.size }} 项
          </span>
          <span v-else>勾选行后可批量操作</span>

          <div class="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" class="px-2 text-xs" :disabled="!selectedIds.size || batchBusy" @click="batchFollow(true)">
              关注
            </Button>
            <Button variant="ghost" size="sm" class="px-2 text-xs" :disabled="!selectedIds.size || batchBusy" @click="batchFollow(false)">
              取消关注
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="px-2 text-xs text-destructive hover:text-destructive"
              :disabled="!selectedIds.size || batchBusy"
              @click="confirmDeleteOpen = true"
            >
              删除
            </Button>
            <Button variant="ghost" size="sm" class="px-2 text-xs" :disabled="!selectedIds.size" @click="selectedIds = new Set()">
              清除选择
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead class="h-9 w-9">
                <Checkbox
                  :model-value="allVisibleSelected"
                  aria-label="全选当前列表"
                  @update:model-value="toggleSelectAll"
                />
              </TableHead>
              <TableHead class="h-9 w-full max-w-0">项目</TableHead>
              <TableHead class="h-9 w-[11rem]">编码</TableHead>
              <TableHead class="h-9">GitLab 仓库</TableHead>
              <TableHead class="h-9 w-[8.5rem]">状态</TableHead>
              <TableHead class="h-9 w-[4.5rem]">引用</TableHead>
              <TableHead class="h-9 w-[4.5rem]">关注</TableHead>
              <TableHead class="h-9 w-[6.5rem]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="p in paged" :key="p.id" :class="cn(!p.enabled && 'opacity-50')">
              <TableCell>
                <Checkbox
                  :model-value="selectedIds.has(p.id)"
                  aria-label="选择该项目"
                  @update:model-value="() => toggleSelect(p.id)"
                />
              </TableCell>
              <TableCell class="w-full max-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate font-medium" :title="p.name">{{ p.name }}</span>
                  <span
                    v-if="!p.enabled"
                    class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    已停用
                  </span>
                </div>
                <div
                  v-if="p.aliases.length"
                  class="mt-0.5 truncate text-[11px] text-muted-foreground"
                  :title="p.aliases.join('、')"
                >
                  别名：{{ p.aliases.join('、') }}
                </div>
              </TableCell>

              <TableCell class="font-mono text-xs text-muted-foreground">
                {{ p.code || '—' }}
              </TableCell>

              <TableCell class="max-w-[16rem]">
                <div v-if="p.repos.length" class="space-y-0.5">
                  <div class="flex items-center gap-1.5">
                    <span class="min-w-0 truncate font-mono text-xs" :title="p.repos[0].pathWithNamespace">
                      {{ p.repos[0].pathWithNamespace }}
                    </span>
                    <ExternalLinkIcon
                      v-if="p.repos[0].webUrl"
                      :size="11"
                      class="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                      @click="openExternal(p.repos[0].webUrl)"
                    />
                  </div>
                  <div class="text-[11px] text-muted-foreground">
                    共 {{ p.repos.length }} 个仓库 · {{ p.links.length }} 条关联
                  </div>
                </div>
                <div
                  v-else-if="p.links.length"
                  class="text-xs text-amber-600 dark:text-amber-500"
                >
                  关联了 {{ p.links.length }} 条，还没解析出仓库
                </div>
                <span v-else class="text-xs text-muted-foreground">未关联仓库</span>
              </TableCell>

              <TableCell>
                <span :class="cn('text-xs', statusMeta[p.syncStatus].class)">
                  {{ statusMeta[p.syncStatus].label }}
                </span>
              </TableCell>

              <TableCell class="text-xs tabular-nums">
                <span v-if="projectStore.usageOf(p.id) > 0">{{ projectStore.usageOf(p.id) }} 次</span>
                <span v-else-if="p.enabled" class="text-amber-600 dark:text-amber-500">未引用</span>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>

              <TableCell>
                <Switch
                  :model-value="p.followed"
                  :title="p.followed
                    ? '已关注：列表默认显示，检查时参与匹配'
                    : '未关注：列表默认隐藏，检查时不参与匹配（它的日报条目算「无法核对」，不计入符合度）'"
                  @update:model-value="v => toggleFollow(p, !!v)"
                />
              </TableCell>

              <TableCell>
                <div class="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    class="px-1.5"
                    title="代码画像"
                    @click="router.push({ name: 'project-profile', params: { id: p.id } })"
                  >
                    <NetworkIcon :size="13" />
                  </Button>
                  <Button variant="ghost" size="sm" class="px-1.5" @click="openEdit(p)">
                    <PencilIcon :size="13" />
                  </Button>
                  <Button variant="ghost" size="sm" class="px-1.5" @click="remove(p)">
                    <Trash2Icon :size="13" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <div class="flex h-11 items-center gap-3 border-t px-3 text-[11px] text-muted-foreground">
          <span>共 {{ filtered.length }} 个 · 第 {{ page }} / {{ pageCount }} 页</span>
          <span v-if="selectedIds.size">已选 {{ selectedIds.size }} 项</span>

          <div class="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" class="px-2 text-xs" :disabled="page <= 1" @click="page--">
              上一页
            </Button>
            <Button variant="outline" size="sm" class="px-2 text-xs" :disabled="page >= pageCount" @click="page++">
              下一页
            </Button>
          </div>
        </div>
      </div>

      <p class="text-[11px] text-muted-foreground">
        「引用」指该项目在已载入的日报里被提到过多少次。显示「未引用」说明匹配键
        （名称 / 编码 / 别名）和日报里的写法对不上。
        「关注」既决定这个列表默认显不显示，也决定检查时参不参与匹配——
        未关注项目的日报条目会被判成「无法核对」，不计入符合度。
      </p>
      <p v-if="hiddenByFollow" class="text-[11px] text-muted-foreground">
        另有 {{ hiddenByFollow }} 个未关注的项目已隐藏。
      </p>
    </div>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ isNew ? '新建项目' : '编辑项目' }}</DialogTitle>
        </DialogHeader>

        <ProjectForm v-if="editing" v-model="editing" />

        <DialogFooter>
          <Button variant="outline" @click="dialogOpen = false">
            取消
          </Button>
          <Button @click="save">
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 批量删除：不可撤销，必须确认 -->
    <Dialog v-model:open="confirmDeleteOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除 {{ selectedIds.size }} 个项目？</DialogTitle>
        </DialogHeader>
        <p class="text-sm leading-relaxed text-muted-foreground">
          这些项目的名称、编码、别名和 GitLab 关联都会被删掉，
          <strong class="font-medium text-foreground">无法撤销</strong>。
          如果只是想暂时不看它，用「取消关注」——关注只影响显示和检查范围，配置还在。
        </p>
        <DialogFooter>
          <Button variant="outline" @click="confirmDeleteOpen = false">
            取消
          </Button>
          <Button variant="destructive" :disabled="batchBusy" @click="batchDelete">
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 从日志系统同步项目编号 -->
    <Dialog v-model:open="logOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从日志系统同步项目编号</DialogTitle>
        </DialogHeader>

        <div class="space-y-3">
          <div v-if="logLoading" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2Icon :size="13" class="animate-spin" />
            正在读取项目清单…
          </div>

          <Alert v-if="logError" variant="destructive">
            <AlertDescription>{{ logError }}</AlertDescription>
          </Alert>

          <template v-else-if="logOutcome">
            <p class="text-sm">同步完成。</p>
            <ul class="space-y-1 text-xs text-muted-foreground">
              <li>新建 <span class="tabular-nums text-foreground">{{ logOutcome.created }}</span> 个</li>
              <li>更新名称/编码 <span class="tabular-nums text-foreground">{{ logOutcome.filled }}</span> 个</li>
              <li>编码已一致 <span class="tabular-nums text-foreground">{{ logOutcome.unchanged }}</span> 个</li>
              <li v-if="logOutcome.skipped">
                本地没有、未新建 <span class="tabular-nums text-foreground">{{ logOutcome.skipped }}</span> 个
              </li>
            </ul>
            <Alert v-if="logOutcome.conflicts.length" variant="destructive">
              <AlertDescription>
                {{ logOutcome.conflicts.length }} 条需要人工裁决：
                {{ logOutcome.conflicts.slice(0, 3).join('；') }}
              </AlertDescription>
            </Alert>
          </template>

          <template v-else-if="!logLoading">
            <p class="text-sm">
              日志系统返回 <span class="font-medium tabular-nums">{{ logPreview.length }}</span> 个项目。
            </p>
            <ul class="space-y-1 text-xs text-muted-foreground">
              <li>
                本地已有 <span class="tabular-nums text-foreground">{{ logMatch.matched }}</span> 个能对上，
                其中 {{ logMatch.fillable }} 个会补上编码；来自日志中心的项目名称会跟着日志中心更新
              </li>
              <li>本地没有 <span class="tabular-nums text-foreground">{{ logMatch.missing }}</span> 个</li>
            </ul>

            <label class="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2.5">
              <Checkbox
                :model-value="logCreateMissing"
                class="mt-0.5"
                @update:model-value="v => (logCreateMissing = Boolean(v))"
              />
              <span class="text-xs">
                本地没有的同时新建
                <span class="mt-0.5 block text-[11px] text-muted-foreground">
                  这些项目还没关联 GitLab 仓库，建出来暂时无法检查。不开的话只补齐已有项目的编码。
                </span>
              </span>
            </label>
          </template>

          <p class="text-[11px] leading-relaxed text-muted-foreground">
            按「项目编号 → 项目名称」匹配，两边都去空白、忽略大小写。
            已有编码不会被覆盖——只补空着的那部分。
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="logOpen = false">
            {{ logOutcome ? '关闭' : '取消' }}
          </Button>
          <Button
            v-if="!logOutcome"
            :disabled="logLoading || logApplying || !logPreview.length"
            @click="applyLogSync"
          >
            <Loader2Icon v-if="logApplying" :size="13" class="mr-1.5 animate-spin" />
            应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
