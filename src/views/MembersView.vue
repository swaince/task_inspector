<script setup lang="ts">
import type { MemberProfile } from '@/core/domain/types'
import { computed, onMounted, ref, watch } from 'vue'
import {
  AlertTriangleIcon,
  FileTextIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
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
import MemberForm from '@/components/members/MemberForm.vue'
import StatCard from '@/components/common/StatCard.vue'
import type { LogSystemUser } from '@/core/adapters/dailyReport'
import { HttpDailyReportSource } from '@/core/adapters/dailyReport'
import { createMemberDraft, useMemberStore } from '@/core/store/members'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'
import { cn } from '@/lib/utils'

const memberStore = useMemberStore()
const settingsStore = useSettingsStore()
const reportStore = useReportStore()

const keyword = ref('')
const onlyProblems = ref(false)
/** 默认只显示关注的人员；取消关注的人仍然存在，只是默认从视野里收起 */
const onlyFollowed = ref(true)
const editing = ref<MemberProfile | null>(null)
const dialogOpen = ref(false)
const isNew = ref(false)
const message = ref<string | null>(null)

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return memberStore.items.filter((m) => {
    // 搜索时忽略关注过滤：按名字明确搜一个人却搜不到，比搜出多余结果更让人困惑
    if (onlyFollowed.value && !q && !m.followed)
      return false
    if (onlyProblems.value && m.gitlabUsernames.length && m.emails.length)
      return false
    if (!q)
      return true
    return [m.name, m.reportMemberId, m.employeeNo, m.team, ...m.gitlabUsernames, ...m.emails]
      .filter(Boolean)
      .some(v => String(v).toLowerCase().includes(q))
  })
})

/** 有日报、但人员表里还没有的人 */
const missingFromReports = computed(() => {
  const seen = new Map<string, string>()
  for (const reports of Object.values(reportStore.cache)) {
    for (const report of reports)
      seen.set(report.memberId, report.memberName)
  }
  return memberStore.missingFrom([...seen.entries()].map(([id, name]) => ({ id, name })))
})

/** 关注过滤挡掉的数量，用于提示「还有 N 个未显示」 */
const hiddenByFollow = computed(() =>
  onlyFollowed.value && !keyword.value.trim()
    ? memberStore.items.filter(m => !m.followed).length
    : 0,
)

async function toggleFollow(member: MemberProfile, followed: boolean) {
  await memberStore.save({ ...member, followed })
}

/* ------------------------------------------------------------------ *
 * 批量操作
 * ------------------------------------------------------------------ */

const selectedIds = ref<Set<string>>(new Set())
const batchBusy = ref(false)
const confirmDeleteOpen = ref(false)

/**
 * 分页：人员有几百个，全量渲染会让首屏变慢，翻起来也没有节奏。
 * 表头全选只作用于「当前页」，和用户眼前看到的一致；单个勾选保留在集合里，
 * 翻页或筛选条件变了不会把已经勾掉的悄悄取消。
 */
const PAGE_SIZE = 50
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const paged = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)

watch([keyword, onlyFollowed, onlyProblems], () => { page.value = 1 })
watch(pageCount, (count) => {
  if (page.value > count)
    page.value = count
})

const visibleIds = computed(() => paged.value.map(m => m.id))
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
    await memberStore.setFollowedMany(ids, followed)
    message.value = `已把 ${ids.length} 个人设为${followed ? '关注' : '取消关注'}`
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
    await memberStore.removeMany(ids)
    message.value = `已删除 ${ids.length} 个人`
    selectedIds.value = new Set()
    confirmDeleteOpen.value = false
  }
  finally {
    batchBusy.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 从日志中心同步人员
 * ------------------------------------------------------------------ */

const logOpen = ref(false)
const logLoading = ref(false)
const logApplying = ref(false)
const logError = ref<string | null>(null)
const logPreview = ref<LogSystemUser[]>([])
const logOutcome = ref<{
  created: number
  linked: number
  updated: number
  unchanged: number
  conflicts: string[]
} | null>(null)

/** 应用前先算清楚会发生什么，别让「新建 N 人」变成惊吓 */
const logMatch = computed(() => {
  const norm = (s?: string) => (s ?? '').trim().toLowerCase()
  let matched = 0
  let willLink = 0
  let missing = 0
  for (const user of logPreview.value) {
    const login = user.loginName?.trim()
    const sameName = memberStore.items.filter(m => norm(m.name) === norm(user.name))
    const hit = memberStore.items.find(m => m.reportMemberId === user.id)
      ?? (login ? memberStore.items.find(m => norm(m.employeeNo) === norm(login)) : undefined)
      ?? (sameName.length === 1 ? sameName[0] : undefined)
    if (!hit) {
      missing++
      continue
    }
    matched++
    if (!hit.reportMemberId)
      willLink++
  }
  return { matched, willLink, missing }
})

async function openLogSync() {
  const cfg = settingsStore.settings.dailyReport
  if (cfg.source !== 'http' || !cfg.baseUrl.trim()) {
    message.value = '用户清单来自日报系统接口。先到「设置 → 日报系统」把来源设为接口并填好地址'
    return
  }

  logOpen.value = true
  logLoading.value = true
  logError.value = null
  logPreview.value = []
  logOutcome.value = null

  try {
    logPreview.value = await new HttpDailyReportSource(cfg).fetchLogSystemUsers()
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
    logOutcome.value = await memberStore.syncFromLogUsers(logPreview.value)
    message.value = `日志中心同步：新建 ${logOutcome.value.created}，补上日报 ID ${logOutcome.value.linked}，`
      + `更新 ${logOutcome.value.updated}，未变 ${logOutcome.value.unchanged}`
  }
  catch (err) {
    logError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    logApplying.value = false
  }
}

function openNew(preset?: { id: string, name: string }) {
  const draft = createMemberDraft(preset?.name ?? '')
  if (preset)
    draft.reportMemberId = preset.id
  editing.value = draft
  isNew.value = true
  dialogOpen.value = true
}

function openEdit(member: MemberProfile) {
  editing.value = { ...member }
  isNew.value = false
  dialogOpen.value = true
}

async function save() {
  if (!editing.value)
    return
  if (!editing.value.name.trim()) {
    message.value = '姓名不能为空'
    return
  }
  await memberStore.save(editing.value)
  dialogOpen.value = false
  message.value = `已保存「${editing.value.name}」`
}

async function remove(member: MemberProfile) {
  await memberStore.remove(member.id)
  message.value = `已删除「${member.name}」`
}

/** 把日报里出现但还没配的人一次性建进来 */
async function importFromReports() {
  const drafts = missingFromReports.value.map((m) => {
    const draft = createMemberDraft(m.name)
    draft.reportMemberId = m.id
    return draft
  })
  await memberStore.importMany(drafts)
  message.value = `已从日报导入 ${drafts.length} 人`
}

onMounted(() => Promise.all([memberStore.load(), reportStore.load()]))
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <div class="grid gap-3 sm:grid-cols-4">
        <StatCard label="人员总数" :value="memberStore.items.length" :icon="UsersIcon" />
        <StatCard label="参与检查" :value="memberStore.enabled.length" />
        <StatCard
          label="缺 GitLab 身份"
          :value="memberStore.unbound.length"
          :tone="memberStore.unbound.length ? 'warn' : 'good'"
          hint="无法按作者过滤提交"
        />
        <StatCard
          label="邮箱冲突"
          :value="memberStore.emailConflicts.length"
          :tone="memberStore.emailConflicts.length ? 'bad' : 'good'"
          hint="同一邮箱被多人占用"
        />
      </div>

      <Card class="gap-0 py-3">
        <CardContent class="flex flex-wrap items-center gap-2 px-4">
          <div class="relative min-w-[12rem] flex-1">
            <SearchIcon :size="14" class="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="keyword" placeholder="按姓名、工号、团队、GitLab 账号搜索…" class="pl-8" />
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
            只看身份缺失
          </label>

          <Button variant="outline" :disabled="logLoading" @click="openLogSync">
            <FileTextIcon :size="14" class="mr-1.5" />
            从日志中心同步
          </Button>

          <Button variant="outline" @click="openNew()">
            <PlusIcon :size="14" class="mr-1.5" />
            新建
          </Button>
        </CardContent>
      </Card>

      <Alert v-if="message">
        <AlertDescription>{{ message }}</AlertDescription>
      </Alert>

      <Alert v-if="memberStore.emailConflicts.length" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertTitle>{{ memberStore.emailConflicts.length }} 个邮箱被多个成员占用</AlertTitle>
        <AlertDescription>
          <div class="space-y-0.5">
            <div v-for="c in memberStore.emailConflicts" :key="c.email">
              <span class="font-mono">{{ c.email }}</span>：{{ c.names.join('、') }}
            </div>
          </div>
          <div class="mt-1">同一个人被算成两个身份时，检查结论不可信，需要先裁决。</div>
        </AlertDescription>
      </Alert>

      <Alert v-if="missingFromReports.length">
        <UsersIcon :size="14" />
        <AlertTitle>有 {{ missingFromReports.length }} 人在日报里出现但还没建进来</AlertTitle>
        <AlertDescription class="flex flex-wrap items-center gap-2">
          <span class="text-xs">
            {{ missingFromReports.slice(0, 6).map(m => m.name).join('、') }}
            <template v-if="missingFromReports.length > 6">等</template>
          </span>
          <Button variant="outline" size="sm" class="text-xs" @click="importFromReports">
            一并导入
          </Button>
        </AlertDescription>
      </Alert>

      <Skeleton v-if="memberStore.loading && !memberStore.items.length" class="h-64 w-full" />

      <div v-else-if="!filtered.length" class="rounded-lg border border-dashed p-12 text-center">
        <p class="text-sm text-muted-foreground">
          {{ memberStore.items.length ? '没有匹配的人员' : '还没有人员。点「从日志中心同步」按用户清单批量建，或手动新建。' }}
        </p>
        <p v-if="hiddenByFollow" class="mt-1 text-xs text-muted-foreground">
          另有 {{ hiddenByFollow }} 个未关注的人员被过滤掉了
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
              <TableHead class="h-9 w-full max-w-0">姓名</TableHead>
              <TableHead class="h-9 w-[7rem]">日报 ID</TableHead>
              <TableHead class="h-9 w-[9rem]">团队</TableHead>
              <TableHead class="h-9">GitLab 身份</TableHead>
              <TableHead class="h-9 w-[8rem]">日报</TableHead>
              <TableHead class="h-9 w-[4.5rem]">关注</TableHead>
              <TableHead class="h-9 w-[4.5rem]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="m in paged"
              :key="m.id"
              :class="cn(!m.enabled && 'opacity-50')"
            >
              <TableCell>
                <Checkbox
                  :model-value="selectedIds.has(m.id)"
                  aria-label="选择该人员"
                  @update:model-value="() => toggleSelect(m.id)"
                />
              </TableCell>
              <TableCell class="w-full max-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate font-medium" :title="m.name">{{ m.name }}</span>
                  <span
                    v-if="!m.enabled"
                    class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    已停用
                  </span>
                </div>
                <div
                  v-if="m.employeeNo || m.role"
                  class="mt-0.5 truncate text-[11px] text-muted-foreground"
                >
                  {{ [m.employeeNo, m.role].filter(Boolean).join(' · ') }}
                </div>
              </TableCell>

              <TableCell class="font-mono text-xs text-muted-foreground">
                {{ m.reportMemberId || '—' }}
              </TableCell>

              <TableCell class="max-w-[9rem]">
                <div class="truncate text-xs text-muted-foreground" :title="m.team || undefined">
                  {{ m.team || '—' }}
                </div>
              </TableCell>

              <TableCell class="max-w-[14rem]">
                <div
                  v-if="m.gitlabUsernames.length || m.emails.length"
                  class="truncate text-xs"
                  :title="[...m.gitlabUsernames.map(u => `@${u}`), ...m.emails].join(' · ')"
                >
                  <span v-if="m.gitlabUsernames.length" class="font-mono">
                    {{ m.gitlabUsernames.slice(0, 2).map(u => `@${u}`).join(' ') }}
                    <span v-if="m.gitlabUsernames.length > 2" class="text-muted-foreground">
                      +{{ m.gitlabUsernames.length - 2 }}
                    </span>
                  </span>
                  <span
                    v-if="m.gitlabUsernames.length && m.emails.length"
                    class="text-muted-foreground"
                  > · </span>
                  <span v-if="m.emails.length" class="text-muted-foreground">{{ m.emails.join('、') }}</span>
                </div>
                <span v-else class="text-xs text-amber-600 dark:text-amber-500">未绑定</span>
              </TableCell>

              <TableCell class="text-xs text-muted-foreground">
                <template v-if="m.usageCount">
                  {{ m.usageCount }} 天
                  <div class="text-[11px]">最近 {{ m.lastReportDate }}</div>
                </template>
                <span v-else>无</span>
              </TableCell>

              <TableCell>
                <Switch
                  :model-value="m.followed"
                  :title="m.followed
                    ? '已关注：列表默认显示，检查页默认勾选'
                    : '未关注：列表默认隐藏，检查页也不默认勾选（仍可手动勾上）'"
                  @update:model-value="v => toggleFollow(m, !!v)"
                />
              </TableCell>

              <TableCell>
                <div class="flex items-center gap-0.5">
                  <Button variant="ghost" size="sm" class="px-1.5" @click="openEdit(m)">
                    <PencilIcon :size="13" />
                  </Button>
                  <Button variant="ghost" size="sm" class="px-1.5" @click="remove(m)">
                    <Trash2Icon :size="13" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <div class="flex h-11 items-center gap-3 border-t px-3 text-[11px] text-muted-foreground">
          <span>共 {{ filtered.length }} 人 · 第 {{ page }} / {{ pageCount }} 页</span>
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
        「关注」只影响这个列表默认显不显示，不参与检查逻辑——取消关注的人仍然照常检查。
      </p>
      <p v-if="hiddenByFollow" class="text-[11px] text-muted-foreground">
        另有 {{ hiddenByFollow }} 个未关注的人员已隐藏。
      </p>
    </div>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ isNew ? '新建人员' : '编辑人员' }}</DialogTitle>
        </DialogHeader>
        <MemberForm
          v-if="editing"
          v-model="editing"
          :others="memberStore.items"
        />
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
          <DialogTitle>删除 {{ selectedIds.size }} 个人？</DialogTitle>
        </DialogHeader>
        <p class="text-sm leading-relaxed text-muted-foreground">
          这些人的日报 ID、GitLab 身份和邮箱都会被删掉，
          <strong class="font-medium text-foreground">无法撤销</strong>。
          如果只是想暂时不检查他，用「取消关注」或「停用」——配置都还在。
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

    <!-- 从日志中心同步人员 -->
    <Dialog v-model:open="logOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从日志中心同步人员</DialogTitle>
        </DialogHeader>

        <div class="space-y-3">
          <div v-if="logLoading" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2Icon :size="13" class="animate-spin" />
            正在读取用户清单…
          </div>

          <Alert v-if="logError" variant="destructive">
            <AlertDescription>{{ logError }}</AlertDescription>
          </Alert>

          <template v-else-if="logOutcome">
            <p class="text-sm">同步完成。</p>
            <ul class="space-y-1 text-xs text-muted-foreground">
              <li>新建 <span class="tabular-nums text-foreground">{{ logOutcome.created }}</span> 人</li>
              <li>
                补上日报 ID
                <span class="tabular-nums text-foreground">{{ logOutcome.linked }}</span> 人
                <span class="block text-[11px]">这批原先和日报对不上，检查时会被拆成两条</span>
              </li>
              <li>补其它字段 <span class="tabular-nums text-foreground">{{ logOutcome.updated }}</span> 人</li>
              <li>无变化 <span class="tabular-nums text-foreground">{{ logOutcome.unchanged }}</span> 人</li>
            </ul>
            <Alert v-if="logOutcome.conflicts.length" variant="destructive">
              <AlertDescription>
                {{ logOutcome.conflicts.length }} 条需要人工裁决（重名或 ID 冲突，已跳过）：
                {{ logOutcome.conflicts.slice(0, 3).join('；') }}
              </AlertDescription>
            </Alert>
          </template>

          <template v-else-if="!logLoading">
            <p class="text-sm">
              日志中心返回 <span class="font-medium tabular-nums">{{ logPreview.length }}</span> 个用户。
            </p>
            <ul class="space-y-1 text-xs text-muted-foreground">
              <li>
                本地已有 <span class="tabular-nums text-foreground">{{ logMatch.matched }}</span> 人能对上，
                其中 {{ logMatch.willLink }} 人会补上日报 ID
              </li>
              <li>本地没有 <span class="tabular-nums text-foreground">{{ logMatch.missing }}</span> 人，将新建</li>
            </ul>
          </template>

          <p class="text-[11px] leading-relaxed text-muted-foreground">
            按「日报 ID → 工号（登录名）→ 姓名」匹配。姓名只在
            <strong class="font-medium">唯一命中</strong>时才用——
            重名会列出来让你裁决，猜错比不匹配更糟。
            已有字段不会被覆盖，只补空着的。
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
