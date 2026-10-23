<script setup lang="ts">
import type { ProjectProfile, RepoProfile } from '@/core/engine/profile'
import type { Project } from '@/core/domain/types'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  FileCode2Icon,
  FileTextIcon,
  FlameIcon,
  FolderGit2Icon,
  Loader2Icon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import StructuredReport from '@/components/activity/StructuredReport.vue'
import ModuleGraph from '@/components/projects/ModuleGraph.vue'
import { buildProjectProfile } from '@/core/engine/profile'
import { GitLabClient } from '@/core/adapters/gitlab'
import { resolveProjectLinks } from '@/core/adapters/projectLinks'
import { transport } from '@/core/bridge'
import { useProfileStore } from '@/core/store/profile'
import { useProjectStore } from '@/core/store/projects'
import { useSettingsStore } from '@/core/store/settings'
import { formatBytes, formatDateTime } from '@/lib/format'

/**
 * 项目代码画像。
 *
 * 事实部分（文件数、模块划分、热点）来自本地代码与 git；
 * 职责描述由模型基于这些事实写。两者分开呈现，模型写得虚也不会污染数字。
 */

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const profileStore = useProfileStore()

const projectId = computed(() => String(route.params.id))
const project = computed(() => projectStore.items.find(p => p.id === projectId.value) ?? null)
const profile = computed<ProjectProfile | null>(() => profileStore.byProject[projectId.value] ?? null)

const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const skillWarnings = ref<string[]>([])
const confirmRemoveOpen = ref(false)
/** 没有 git 时克隆与热点都用不了，提前告诉用户，而不是等报错 */
const gitMissing = ref(false)

// 生成状态按项目取：A 项目在后台分析时切到 B，B 不继承 A 的进度和错误
const loading = computed(() => profileStore.loadingByProject[projectId.value] ?? false)
const generating = computed(() => profileStore.generatingByProject[projectId.value] ?? false)
const progressMessage = computed(() => profileStore.progressByProject[projectId.value] ?? '')
const storeError = computed(() => profileStore.errorByProject[projectId.value] ?? null)
const displayError = computed(() => error.value ?? storeError.value)

/** 实际生效的代码目录：配置留空时用应用数据目录下的默认值 */
const codeRoot = computed(() => settingsStore.resolvedCodeRoot)
const repoCount = computed(() => project.value?.repos?.length ?? 0)
const linkCount = computed(() => project.value?.links?.length ?? 0)

/**
 * 不走 GitLab 关联、直接扫描的本地目录。
 * 画像和项目对话的代码工具都能用；检查提交仍然需要 GitLab 仓库。
 */
const localPaths = ref<string[]>([])
const localPathInput = ref('')
const addingLocal = ref(false)

watch(profile, (value) => {
  localPaths.value = value?.localPaths ?? []
}, { immediate: true })

/** 有已解析仓库、有未解析的 GitLab 关联、或手动加了本地目录，都可以尝试生成 */
const canGenerate = computed(() =>
  repoCount.value > 0 || linkCount.value > 0 || localPaths.value.length > 0,
)

/**
 * 生成前补齐仓库：用户可能只加了 GitLab 组/仓库但没点「解析关联仓库」。
 * 这时先解析再生成，避免画像按钮看起来不可用。
 */
async function resolveLinksIfNeeded(p: Project): Promise<Project> {
  if (p.repos?.length || !p.links?.length)
    return p

  const settings = settingsStore.settings
  if (!settings.gitlab.baseUrl.trim() || !settings.gitlab.token.trim()) {
    if (localPaths.value.length)
      return p
    throw new Error('项目已添加 GitLab 关联但还没解析；请先在「设置 → GitLab」填写地址和 Token，或在下面添加本地代码目录。')
  }

  profileStore.setProgress(p.id, '正在解析 GitLab 关联…')
  const result = await resolveProjectLinks(
    new GitLabClient(settings.gitlab),
    p.links,
    { perPage: settings.gitlab.perPage, maxProjects: settings.gitlab.maxProjects },
  )

  if (!result.repos.length) {
    const detail = result.failures.length ? result.failures.join('；') : '关联没有解析出任何仓库'
    if (localPaths.value.length) {
      notice.value = `GitLab 关联解析失败，已改用本地代码目录：${detail}`
      return p
    }
    throw new Error(`GitLab 关联解析失败：${detail}`)
  }

  const updated: Project = {
    ...p,
    repos: result.repos,
    syncStatus: result.failures.length ? 'error' : 'synced',
    syncError: result.failures.length ? result.failures[0] : undefined,
    syncedAt: new Date().toISOString(),
  }
  await projectStore.save(updated)
  if (result.failures.length)
    notice.value = `部分关联解析失败：${result.failures.join('；')}`
  return updated
}

onMounted(async () => {
  await projectStore.load()
  await settingsStore.load()
  await profileStore.load(projectId.value)

  try {
    const git = await transport().toolStatus('git')
    gitMissing.value = !git.found
  }
  catch {
    // 浏览器预览模式拿不到探测结果，按「未知」处理，不误报
    gitMissing.value = false
  }
})

// 路由参数变化时组件会被复用；必须重新读取目标项目的画像，
// 否则会停留在上一个项目的「正在分析」状态或旧画像。
watch(projectId, async (id) => {
  error.value = null
  notice.value = null
  skillWarnings.value = []
  confirmRemoveOpen.value = false
  await profileStore.load(id)
})

async function loadSkills(): Promise<{ texts: string[], warnings: string[] }> {
  const texts: string[] = []
  const warnings: string[] = []
  for (const skill of settingsStore.settings.analysis.skills ?? []) {
    if (!skill.enabled || !skill.path.trim())
      continue
    try {
      texts.push(await transport().readTextFile(skill.path.trim()))
    }
    catch (err) {
      warnings.push(`${skill.name || skill.path}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { texts, warnings }
}

async function addLocalPath() {
  const path = localPathInput.value.trim().replace(/[\\/]+$/, '')
  if (!path)
    return
  if (localPaths.value.some(item => item.toLowerCase() === path.toLowerCase())) {
    localPathInput.value = ''
    return
  }

  error.value = null
  addingLocal.value = true
  try {
    const scan = await transport().scanRepo(path)
    if (!scan.files.length) {
      error.value = `目录里没有可分析的文件：${path}`
      return
    }
    localPaths.value = [...localPaths.value, path]
    localPathInput.value = ''
  }
  catch (err) {
    error.value = `无法扫描本地目录：${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    addingLocal.value = false
  }
}

function removeLocalPath(index: number) {
  localPaths.value = localPaths.value.filter((_, i) => i !== index)
}

async function generate() {
  const p = project.value
  if (!p)
    return
  if (!canGenerate.value) {
    error.value = '这个项目还没有 GitLab 关联，也没有添加本地代码目录。先加一个仓库/组，或在下面直接添加本地目录。'
    return
  }

  const id = p.id
  error.value = null
  notice.value = null
  profileStore.beginGenerate(id)

  try {
    const target = await resolveLinksIfNeeded(p)
    if (projectId.value !== id) {
      profileStore.finishGenerate(id)
      return
    }

    const { texts, warnings } = await loadSkills()
    if (projectId.value === id)
      skillWarnings.value = warnings

    profileStore.setProgress(id, '正在扫描代码…')
    const result = await buildProjectProfile(target, {
      codeRoot: codeRoot.value,
      localPaths: localPaths.value,
      skills: texts,
      llm: settingsStore.settings.llm,
      gitlab: settingsStore.settings.gitlab,
      autoClone: settingsStore.settings.analysis.autoClone,
      cloneDepth: settingsStore.settings.analysis.cloneDepth,
      onProgress: (message) => { profileStore.setProgress(id, message) },
    })
    await profileStore.save(result)
    profileStore.finishGenerate(id)
    localPaths.value = result.localPaths ?? []
  }
  catch (err) {
    profileStore.finishGenerate(id, `生成失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function remove() {
  await profileStore.clear(projectId.value)
  confirmRemoveOpen.value = false
}

function langText(repo: RepoProfile) {
  const seen = new Set<string>()
  for (const m of repo.modules) {
    for (const lang of Object.keys(m.languages))
      seen.add(lang)
  }
  return [...seen].join(' · ')
}

function moduleFlags(module: RepoProfile['modules'][number]) {
  return Object.entries(module.flags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
}

function severityLabel(severity: 'high' | 'medium' | 'low') {
  return { high: '高', medium: '中', low: '低' }[severity]
}
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="mx-auto max-w-6xl space-y-4 p-5">
      <div class="flex items-start gap-2">
        <Button variant="ghost" size="sm" class="-ml-2 shrink-0" @click="router.push({ name: 'projects' })">
          <ArrowLeftIcon :size="14" class="mr-1.5" />
          返回项目
        </Button>

        <div class="min-w-0">
          <h1 class="truncate text-base leading-6 font-medium">
            {{ project?.name ?? '项目画像' }}
          </h1>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span v-if="loading">读取中…</span>
            <span v-else-if="profile">生成于 {{ formatDateTime(profile.generatedAt) }}</span>
            <span v-else>尚未生成</span>
            <template v-if="profile?.headCommit">
              <span>·</span>
              <span class="font-mono">{{ profile.headCommit.slice(0, 8) }}</span>
            </template>
            <template v-if="repoCount">
              <span>·</span>
              <span>{{ repoCount }} 个仓库</span>
            </template>
            <template v-else-if="linkCount">
              <span>·</span>
              <span>{{ linkCount }} 条关联（未解析）</span>
            </template>
            <template v-if="localPaths.length">
              <span>·</span>
              <span>{{ localPaths.length }} 个本地目录</span>
            </template>
          </div>
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            title="围绕这个项目自由提问"
            @click="router.push({ name: 'project-chat', params: { id: projectId } })"
          >
            <MessageSquareIcon :size="13" class="mr-1.5" />
            项目对话
          </Button>
          <Button
            v-if="profile"
            variant="ghost"
            size="sm"
            :disabled="generating"
            @click="confirmRemoveOpen = true"
          >
            <Trash2Icon :size="13" class="mr-1.5" />
            删除画像
          </Button>
          <Button size="sm" :disabled="generating || !canGenerate" @click="generate">
            <Loader2Icon v-if="generating" :size="13" class="mr-1.5 animate-spin" />
            <RefreshCwIcon v-else :size="13" class="mr-1.5" />
            {{ profile ? '重新生成' : '生成画像' }}
          </Button>
        </div>
      </div>

      <Alert v-if="displayError" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>{{ displayError }}</AlertDescription>
      </Alert>

      <Alert v-if="notice" class="border-amber-500/40 bg-amber-500/5">
        <AlertTriangleIcon :size="14" class="text-amber-600 dark:text-amber-500" />
        <AlertDescription>{{ notice }}</AlertDescription>
      </Alert>

      <Alert v-if="gitMissing">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          本机没有检测到 git：自动克隆和改动热点都用不了（目录结构分析照常）。
          装好 Git 后重启应用，再到「设置 → 代码分析」点「重新检测」。
        </AlertDescription>
      </Alert>

      <Alert v-if="skillWarnings.length">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          以下 skill 没能读取，本次生成没有使用它们：
          {{ skillWarnings.join('；') }}
        </AlertDescription>
      </Alert>

      <Card v-if="generating" class="py-4">
        <CardContent class="flex items-center gap-2 px-4 text-xs text-muted-foreground">
          <Loader2Icon :size="14" class="animate-spin" />
          {{ progressMessage || '正在生成…' }}
        </CardContent>
      </Card>

      <Card v-if="loading && !profile && !generating" class="py-4">
        <CardContent class="flex items-center gap-2 px-4 text-xs text-muted-foreground">
          <Loader2Icon :size="14" class="animate-spin" />
          正在读取项目画像…
        </CardContent>
      </Card>

      <Card v-if="!codeRoot && !localPaths.length && !profile && !loading && !generating" class="py-4">
        <CardContent class="px-4 text-xs text-muted-foreground">
          还没有可用的「代码目录」。到「设置 → 代码分析」看一下路径，或在下面直接添加本地代码目录。
        </CardContent>
      </Card>

      <Card class="gap-0 py-4">
        <CardHeader class="px-4 pb-3">
          <CardTitle class="flex items-center gap-1.5 text-sm">
            <FolderGit2Icon :size="14" class="text-muted-foreground" />
            扫描范围
          </CardTitle>
          <p class="text-xs text-muted-foreground">
            可以扫描项目关联的 GitLab 仓库，也可以直接添加本地代码目录。
            <strong class="font-medium text-foreground">不关联 GitLab 也能生成画像</strong>；
            但「执行检查」仍需 GitLab 提交记录。
          </p>
        </CardHeader>
        <CardContent class="space-y-3 px-4">
          <p v-if="repoCount" class="text-[11px] text-muted-foreground">
            已关联 {{ repoCount }} 个 GitLab 仓库，会按「代码目录 / 自动克隆」的规则扫描。
          </p>
          <p v-else-if="linkCount" class="text-[11px] text-amber-600 dark:text-amber-500">
            已添加 {{ linkCount }} 条 GitLab 组/仓库关联，还没点「解析关联仓库」。
            直接点「生成画像」会先自动解析，再开始扫描。
          </p>

          <div v-if="localPaths.length" class="space-y-1">
            <div
              v-for="(path, index) in localPaths"
              :key="path"
              class="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
            >
              <FolderGit2Icon :size="13" class="shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ path }}</span>
              <Button variant="ghost" size="sm" class="shrink-0 px-1.5" @click="removeLocalPath(index)">
                <Trash2Icon :size="12" />
              </Button>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Input
              v-model="localPathInput"
              class="min-w-64 flex-1 font-mono text-xs"
              placeholder="本地代码目录，例如 E:\\CodeCache\\group\\repo"
              @keydown.enter.prevent="addLocalPath"
            />
            <Button
              variant="outline"
              size="sm"
              class="text-xs"
              :disabled="addingLocal || !localPathInput.trim()"
              @click="addLocalPath"
            >
              <Loader2Icon v-if="addingLocal" :size="12" class="mr-1 animate-spin" />
              <PlusIcon v-else :size="12" class="mr-1" />
              添加目录
            </Button>
          </div>
          <p class="text-[11px] text-muted-foreground">
            目录必须是本机真实存在、并且有代码文件的路径。添加后会先扫描一次，空目录不会加入。
          </p>
        </CardContent>
      </Card>

      <template v-if="profile">
        <Card v-if="profile.narrative" class="gap-0 py-4">
          <CardHeader class="px-4 pb-2">
            <CardTitle class="flex items-center gap-1.5 text-sm">
              <SparklesIcon :size="14" class="text-muted-foreground" />
              项目概览
            </CardTitle>
          </CardHeader>
          <CardContent class="px-4">
            <p class="max-w-prose text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {{ profile.narrative }}
            </p>
          </CardContent>
        </Card>

        <Card v-if="profile.report" class="gap-0 py-4">
          <CardHeader class="px-4 pb-2">
            <CardTitle class="flex items-center gap-1.5 text-sm">
              <FileTextIcon :size="14" class="text-muted-foreground" />
              分析报告
            </CardTitle>
          </CardHeader>
          <CardContent class="px-4">
            <div class="prose-measure">
              <StructuredReport :content="profile.report" />
            </div>
          </CardContent>
        </Card>

        <div v-for="repo in profile.repos" :key="repo.repoId" class="space-y-3">
          <Card class="gap-0 py-0">
            <CardHeader class="border-b px-4 py-3">
              <CardTitle class="flex flex-wrap items-center gap-2 text-sm">
                <span class="font-mono">{{ repo.repoPath }}</span>
                <Badge v-if="repo.files" variant="secondary" class="text-[10px] tabular-nums">
                  {{ repo.files }} 个文件
                </Badge>
                <Badge v-if="repo.modules.length" variant="outline" class="text-[10px]">
                  {{ repo.modules.length }} 个模块
                </Badge>
                <Badge v-if="repo.defaultBranch" variant="outline" class="text-[10px]">
                  默认 {{ repo.defaultBranch }}
                </Badge>
                <Badge
                  v-if="repo.latestBranch"
                  variant="secondary"
                  class="text-[10px] tabular-nums"
                  :title="repo.latestCommitAt ? `最近提交 ${formatDateTime(repo.latestCommitAt)}` : '最近提交的分支'"
                >
                  最新 {{ repo.latestBranch }}<template v-if="repo.latestCommitAt"> · {{ formatDateTime(repo.latestCommitAt) }}</template>
                </Badge>
                <Badge
                  v-if="repo.analyzedBranch"
                  variant="outline"
                  class="text-[10px]"
                  :class="repo.defaultBranch && repo.analyzedBranch !== repo.defaultBranch
                    ? 'border-amber-500/40 text-amber-600 dark:text-amber-500'
                    : ''"
                >
                  分析 {{ repo.analyzedBranch }}
                </Badge>
                <Badge
                  v-if="repo.currentBranch && repo.currentBranch !== repo.analyzedBranch"
                  variant="outline"
                  class="text-[10px] text-muted-foreground"
                >
                  本地在 {{ repo.currentBranch }}
                </Badge>
                <Badge v-if="repo.branches?.length" variant="ghost" class="text-[10px]">
                  {{ repo.branches.length }} 个分支引用
                </Badge>
                <Badge v-if="repo.truncated" variant="outline" class="text-[10px] text-amber-600 dark:text-amber-500">
                  文件过多，已截断
                </Badge>
                <span v-if="langText(repo)" class="text-[10px] text-muted-foreground">{{ langText(repo) }}</span>
              </CardTitle>
            </CardHeader>

            <CardContent class="space-y-3 p-4">
              <Alert v-if="repo.error" variant="destructive">
                <AlertTriangleIcon :size="14" />
                <AlertDescription>{{ repo.error }}</AlertDescription>
              </Alert>

              <p v-if="repo.narrative" class="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {{ repo.narrative }}
              </p>

              <p v-else-if="!repo.error && !repo.modules.length" class="text-xs text-muted-foreground">
                这个仓库里没有可分析的源码文件（目录为空，或只包含被忽略的依赖/构建产物）。
              </p>

              <div v-if="repo.branchWork?.length" class="space-y-1.5">
                <div class="flex flex-wrap items-baseline gap-2">
                  <span class="text-[11px] font-medium">分支工作</span>
                  <span class="text-[10px] text-muted-foreground">
                    近 {{ repo.branchWorkDays ?? 90 }} 天，{{ repo.branchWork.length }} 个分支有提交
                  </span>
                </div>
                <div
                  v-for="branch in repo.branchWork"
                  :key="branch.name"
                  class="rounded-md border px-2.5 py-2"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" class="font-mono text-[10px]">
                      {{ branch.name }}
                    </Badge>
                    <Badge v-if="branch.default" variant="secondary" class="text-[10px]">默认</Badge>
                    <Badge v-if="branch.merged" variant="ghost" class="text-[10px]">已合并</Badge>
                    <span class="text-[11px] tabular-nums text-muted-foreground">
                      {{ branch.commits }} 条提交
                    </span>
                    <span v-if="branch.latestCommitAt" class="ml-auto text-[10px] tabular-nums text-muted-foreground">
                      最近 {{ formatDateTime(branch.latestCommitAt) }}
                    </span>
                  </div>
                  <ul v-if="branch.titles.length" class="mt-1 space-y-0.5">
                    <li
                      v-for="(title, i) in branch.titles.slice(0, 3)"
                      :key="i"
                      class="truncate text-[11px] text-muted-foreground"
                      :title="title"
                    >
                      {{ title }}
                    </li>
                  </ul>
                </div>
              </div>
              <p v-if="repo.branchWorkError" class="text-[11px] text-amber-600 dark:text-amber-500">
                部分分支的提交没有拉全：{{ repo.branchWorkError }}
              </p>

              <div v-if="repo.findings?.length" class="space-y-1.5">
                <div
                  v-for="finding in repo.findings ?? []"
                  :key="finding.id"
                  class="rounded-md border px-2.5 py-2"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge
                      :variant="finding.severity === 'high' ? 'destructive' : 'outline'"
                      class="text-[10px]"
                    >
                      {{ severityLabel(finding.severity) }}
                    </Badge>
                    <span class="text-xs font-medium">{{ finding.title }}</span>
                  </div>
                  <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {{ finding.detail }}
                  </p>
                </div>
              </div>

              <div class="grid gap-3 lg:grid-cols-2">
                <div
                  v-for="module in repo.modules"
                  :key="module.name"
                  class="rounded-md border p-3"
                >
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-sm font-medium">{{ module.name }}</span>
                    <Badge variant="secondary" class="text-[10px] tabular-nums">
                      {{ module.files }} 个文件 · {{ formatBytes(module.bytes) }}
                    </Badge>
                    <Badge
                      v-for="[flag, count] in moduleFlags(module)"
                      :key="flag"
                      variant="outline"
                      class="text-[10px] font-normal"
                    >
                      {{ flag }} {{ count }}
                    </Badge>
                  </div>

                  <p class="mt-1 truncate font-mono text-[10px] text-muted-foreground" :title="module.path">
                    {{ module.path }}
                  </p>

                  <p v-if="module.summary" class="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {{ module.summary }}
                  </p>
                  <p v-else class="mt-1.5 text-xs text-muted-foreground">（没有模块说明）</p>

                  <div v-if="module.entries.length" class="mt-1.5 flex items-start gap-1 text-[10px] text-muted-foreground">
                    <FileCode2Icon :size="10" class="mt-0.5 shrink-0" />
                    <span class="break-all">{{ module.entries.slice(0, 4).join('、') }}</span>
                  </div>

                  <div v-if="module.hotFiles.length" class="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground">
                    <FlameIcon :size="10" class="mt-0.5 shrink-0" />
                    <span class="break-all">
                      {{ module.hotFiles.map(h => `${h.path}（${h.changes}）`).join('、') }}
                    </span>
                  </div>
                </div>
              </div>

              <div v-if="repo.graph?.nodes?.length" class="space-y-2 border-t pt-3">
                <div class="text-[11px] font-medium">模块依赖</div>
                <ModuleGraph :graph="repo.graph" />
              </div>
            </CardContent>
          </Card>
        </div>
      </template>

      <Card v-else-if="!generating && !loading" class="py-12">
        <CardContent class="text-center text-sm text-muted-foreground">
          还没有生成过画像。点右上角「生成画像」，会扫描本地代码、按模块归纳，并让模型写出每个模块在做什么。
        </CardContent>
      </Card>
    </div>

    <Dialog v-model:open="confirmRemoveOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除这个项目的画像？</DialogTitle>
        </DialogHeader>
        <p class="text-sm leading-relaxed text-muted-foreground">
          已生成的模块结构、热点文件和问题清单都会被删除，
          <strong class="font-medium text-foreground">需要重新扫描才能恢复</strong>。
          项目本身和 GitLab 关联不受影响。
        </p>
        <DialogFooter>
          <Button variant="outline" @click="confirmRemoveOpen = false">
            取消
          </Button>
          <Button variant="destructive" @click="remove">
            删除画像
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
