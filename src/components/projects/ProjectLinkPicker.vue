<script setup lang="ts">
import type { ProjectLink } from '@/core/domain/types'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  AlertTriangleIcon,
  BoxesIcon,
  FolderGit2Icon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { GitLabClient } from '@/core/adapters/gitlab'
import { useSettingsStore } from '@/core/store/settings'

/**
 * GitLab 仓库/组选择器。
 *
 * 项目关联不应该靠人记 `group/subgroup/repo` 这种路径——拼错一个字符，
 * 检查时整组提交就会静默消失。这里直接搜索 token 能看到的仓库和组，
 * 默认用项目编码作为关键词，选中即加入关联；找不到时保留手动填写作为兜底。
 */
const open = defineModel<boolean>('open', { required: true })

const props = withDefaults(defineProps<{
  /** 打开时默认搜索的关键词，通常是项目编码 */
  defaultQuery?: string
  /** 默认关键词没结果时可以一键改用的名称 */
  fallbackQuery?: string
  /** 搜索提示，例如「按项目编码 PAY-001 搜索」 */
  hint?: string
  /** 已经关联的条目，用于标记「已添加」 */
  existing?: ProjectLink[]
}>(), {
  defaultQuery: '',
  fallbackQuery: '',
  hint: '',
  existing: () => [],
})

const emit = defineEmits<{ (e: 'select', link: ProjectLink): void }>()

const settingsStore = useSettingsStore()

interface PickerItem {
  kind: ProjectLink['kind']
  path: string
  name: string
  webUrl?: string
}

const query = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
/** 一侧接口不可用时的提示；另一侧的结果仍然展示 */
const warning = ref<string | null>(null)
const results = ref<PickerItem[]>([])
const searched = ref('')
const manualKind = ref<ProjectLink['kind']>('repo')
const manualPath = ref('')

let timer: ReturnType<typeof setTimeout> | null = null
let requestSeq = 0

const canSearch = computed(() => Boolean(
  settingsStore.settings.gitlab.baseUrl.trim()
  && settingsStore.settings.gitlab.token.trim(),
))

const fallbackAvailable = computed(() =>
  props.fallbackQuery.trim()
  && props.fallbackQuery.trim() !== searched.value.trim(),
)

function exists(item: PickerItem) {
  const normalized = item.path.trim().replace(/^\/+|\/+$/g, '').toLowerCase()
  return props.existing.some((link) => {
    const path = link.path.trim().replace(/^\/+|\/+$/g, '').toLowerCase()
    return link.kind === item.kind && path === normalized
  })
}

function relevance(item: PickerItem, term: string) {
  const q = term.toLowerCase()
  const path = item.path.toLowerCase()
  const name = item.name.toLowerCase()
  const tokens = q.split(/[\s/_.-]+/).filter(Boolean)

  if (path === q)
    return 0
  if (path.endsWith(`/${q}`))
    return 1
  if (name === q)
    return 2
  if (path.startsWith(q))
    return 3
  if (name.startsWith(q))
    return 4
  if (name.includes(q))
    return 5
  // 多词查询按词命中：仓库名和组名都能参与模糊匹配
  const hits = tokens.filter(token => name.includes(token) || path.includes(token)).length
  if (hits === tokens.length)
    return 6
  if (hits > 0)
    return 7
  return 8
}

async function search() {
  const term = query.value.trim()
  searched.value = term
  if (!term) {
    results.value = []
    error.value = null
    warning.value = null
    return
  }
  if (!canSearch.value) {
    results.value = []
    error.value = '请先在「设置 → GitLab」里填好实例地址与 Token，再搜索仓库或组。'
    warning.value = null
    return
  }

  const seq = ++requestSeq
  loading.value = true
  error.value = null
  warning.value = null
  try {
    const client = new GitLabClient(settingsStore.settings.gitlab)
    // 一个输入同时搜仓库和组：某个接口不可用（老版本/权限不足）时，
    // 另一边的结果仍然保留，不要整次搜索都失败。
    const [projectResult, groupResult] = await Promise.allSettled([
      client.searchProjects(term, 30),
      client.searchGroups(term, 30),
    ])
    if (seq !== requestSeq)
      return

    const projects = projectResult.status === 'fulfilled' ? projectResult.value : []
    const groups = groupResult.status === 'fulfilled' ? groupResult.value : []
    const failures: string[] = []
    if (projectResult.status === 'rejected')
      failures.push(`仓库搜索：${projectResult.reason instanceof Error ? projectResult.reason.message : String(projectResult.reason)}`)
    if (groupResult.status === 'rejected')
      failures.push(`组搜索：${groupResult.reason instanceof Error ? groupResult.reason.message : String(groupResult.reason)}`)

    if (projectResult.status === 'rejected' && groupResult.status === 'rejected') {
      results.value = []
      error.value = failures.join('；')
      return
    }
    warning.value = failures.length ? `${failures.join('；')}（其余结果仍可添加）` : null

    const merged: PickerItem[] = [
      ...projects.map(item => ({
        kind: 'repo' as const,
        path: item.pathWithNamespace,
        name: item.name,
        webUrl: item.webUrl,
      })),
      ...groups.map(item => ({
        kind: 'group' as const,
        path: item.fullPath,
        name: item.name,
        webUrl: item.webUrl,
      })),
    ]

    const seen = new Set<string>()
    results.value = merged
      .filter((item) => {
        const key = `${item.kind}:${item.path.toLowerCase()}`
        if (seen.has(key))
          return false
        seen.add(key)
        return true
      })
      .sort((a, b) => {
        const diff = relevance(a, term) - relevance(b, term)
        return diff || a.path.localeCompare(b.path)
      })
  }
  catch (err) {
    if (seq !== requestSeq)
      return
    results.value = []
    error.value = `搜索失败：${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    if (seq === requestSeq)
      loading.value = false
  }
}

function scheduleSearch() {
  if (timer)
    clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void search()
  }, 300)
}

function add(item: PickerItem) {
  if (exists(item))
    return
  emit('select', { kind: item.kind, path: item.path })
}

function addManual() {
  const path = manualPath.value.trim().replace(/^\/+|\/+$/g, '')
  if (!path)
    return
  emit('select', { kind: manualKind.value, path })
  manualPath.value = ''
}

function useFallback() {
  if (!fallbackAvailable.value)
    return
  query.value = props.fallbackQuery.trim()
  void search()
}

watch(open, (value) => {
  if (!value)
    return
  const initial = props.defaultQuery.trim()
  if (query.value !== initial) {
    query.value = initial
    if (!initial)
      results.value = []
    else
      scheduleSearch()
  }
  else {
    void search()
  }
})

watch(query, () => {
  if (open.value)
    scheduleSearch()
})

onBeforeUnmount(() => {
  if (timer)
    clearTimeout(timer)
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>选择 GitLab 仓库或组</DialogTitle>
        <DialogDescription>
          {{ hint || '一个输入同时匹配仓库名、组名和路径；默认按项目编码搜索。' }}
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="flex gap-2">
          <div class="relative min-w-0 flex-1">
            <SearchIcon :size="14" class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              v-model="query"
              class="pl-8 font-mono text-xs"
              placeholder="仓库名、组名、项目编码或 GitLab 路径"
            />
          </div>
          <Button
            v-if="query"
            variant="ghost"
            size="sm"
            class="shrink-0 text-xs"
            @click="query = ''"
          >
            <XIcon :size="12" class="mr-1" />
            清空
          </Button>
        </div>

        <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>一个输入同时匹配仓库名、组名、项目编码和完整路径</span>
          <span class="ml-auto">
            {{ loading ? '搜索中…' : results.length ? `${results.length} 个结果` : '' }}
          </span>
        </div>

        <Alert v-if="error" variant="destructive">
          <AlertTriangleIcon :size="14" />
          <AlertDescription class="text-[11px]">{{ error }}</AlertDescription>
        </Alert>

        <p v-if="warning" class="text-[11px] leading-relaxed text-amber-600 dark:text-amber-500">
          {{ warning }}
        </p>

        <div v-if="loading" class="flex items-center justify-center gap-2 rounded-md border border-dashed py-8 text-[11px] text-muted-foreground">
          <Loader2Icon :size="13" class="animate-spin" />
          正在搜索 GitLab…
        </div>

        <div v-else-if="results.length" class="max-h-72 divide-y overflow-y-auto rounded-md border">
          <button
            v-for="item in results"
            :key="`${item.kind}:${item.path}`"
            type="button"
            class="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-accent/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
            :disabled="exists(item)"
            @click="add(item)"
          >
            <FolderGit2Icon v-if="item.kind === 'repo'" :size="14" class="shrink-0 text-muted-foreground" />
            <BoxesIcon v-else :size="14" class="shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium">{{ item.name }}</span>
              <span class="block truncate font-mono text-[11px] text-muted-foreground">{{ item.path }}</span>
            </span>
            <Badge variant="outline" class="shrink-0 text-[10px]">
              {{ item.kind === 'group' ? '组' : '仓库' }}
            </Badge>
            <span class="w-12 shrink-0 text-right text-[11px]" :class="exists(item) ? 'text-muted-foreground' : 'text-foreground'">
              {{ exists(item) ? '已添加' : '添加' }}
            </span>
          </button>
        </div>

        <div v-else-if="searched && !error" class="rounded-md border border-dashed px-3 py-6 text-center text-[11px] text-muted-foreground">
          <p>没有找到和「{{ searched }}」匹配的仓库或组。</p>
          <Button
            v-if="fallbackAvailable"
            variant="link"
            size="sm"
            class="mt-1 h-auto p-0 text-[11px]"
            @click="useFallback"
          >
            改用项目名称「{{ fallbackQuery }}」再搜一次
          </Button>
        </div>

        <div v-else class="rounded-md border border-dashed px-3 py-6 text-center text-[11px] text-muted-foreground">
          输入仓库名、组名、项目编码或路径开始筛选。
        </div>

        <details class="rounded-md border px-3 py-2">
          <summary class="cursor-pointer text-[11px] text-muted-foreground">
            找不到？手动填写路径
          </summary>
          <div class="mt-2 flex flex-wrap items-end gap-2">
            <div class="space-y-1">
              <Label class="text-[11px]">类型</Label>
              <Select
                :model-value="manualKind"
                @update:model-value="v => manualKind = v as ProjectLink['kind']"
              >
                <SelectTrigger class="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="repo">仓库</SelectItem>
                  <SelectItem value="group">组</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="min-w-0 flex-1 space-y-1">
              <Label class="text-[11px]">路径</Label>
              <Input
                v-model="manualPath"
                class="font-mono text-xs"
                :placeholder="manualKind === 'group' ? 'rd-platform' : 'rd-platform/payment-gateway'"
                @keydown.enter.prevent="addManual"
              />
            </div>
            <Button variant="outline" size="sm" class="text-xs" :disabled="!manualPath.trim()" @click="addManual">
              <PlusIcon :size="12" class="mr-1" />
              添加
            </Button>
          </div>
        </details>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">
          关闭
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
