<script setup lang="ts">
import type { ProjectProfile, RepoProfile } from '@/core/engine/profile'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  FileCode2Icon,
  FileTextIcon,
  FlameIcon,
  Loader2Icon,
  MessageSquareIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import MessageResponse from '@/components/ai-elements/message/MessageResponse.vue'
import ModuleGraph from '@/components/projects/ModuleGraph.vue'
import { buildProjectProfile } from '@/core/engine/profile'
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
const skillWarnings = ref<string[]>([])
/** 没有 git 时克隆与热点都用不了，提前告诉用户，而不是等报错 */
const gitMissing = ref(false)

/** 实际生效的代码目录：配置留空时用应用数据目录下的默认值 */
const codeRoot = computed(() => settingsStore.resolvedCodeRoot)
const repoCount = computed(() => project.value?.repos?.length ?? 0)

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

async function loadSkills(): Promise<string[]> {
  const texts: string[] = []
  skillWarnings.value = []
  for (const skill of settingsStore.settings.analysis.skills ?? []) {
    if (!skill.enabled || !skill.path.trim())
      continue
    try {
      texts.push(await transport().readTextFile(skill.path.trim()))
    }
    catch (err) {
      skillWarnings.value.push(`${skill.name || skill.path}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return texts
}

async function generate() {
  const p = project.value
  if (!p)
    return
  if (!(p.repos?.length)) {
    error.value = '这个项目还没有关联仓库。先到「项目」面板加上仓库或组，再生成画像。'
    return
  }

  error.value = null
  profileStore.generating = true
  profileStore.progress = '正在读取 skill…'

  try {
    const skills = await loadSkills()
    profileStore.progress = '正在扫描代码…'
    const result = await buildProjectProfile(p, {
      codeRoot: codeRoot.value,
      skills,
      llm: settingsStore.settings.llm,
      gitlab: {
        baseUrl: settingsStore.settings.gitlab.baseUrl,
        token: settingsStore.settings.gitlab.token,
      },
      autoClone: settingsStore.settings.analysis.autoClone,
      cloneDepth: settingsStore.settings.analysis.cloneDepth,
      onProgress: (message) => { profileStore.progress = message },
    })
    await profileStore.save(result)
    profileStore.progress = ''
  }
  catch (err) {
    error.value = `生成失败：${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    profileStore.generating = false
  }
}

async function remove() {
  await profileStore.clear(projectId.value)
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
            <span v-if="profile">生成于 {{ formatDateTime(profile.generatedAt) }}</span>
            <span v-else>尚未生成</span>
            <template v-if="profile?.headCommit">
              <span>·</span>
              <span class="font-mono">{{ profile.headCommit.slice(0, 8) }}</span>
            </template>
            <template v-if="repoCount">
              <span>·</span>
              <span>{{ repoCount }} 个仓库</span>
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
          <Button v-if="profile" variant="ghost" size="sm" :disabled="profileStore.generating" @click="remove">
            <Trash2Icon :size="13" class="mr-1.5" />
            删除画像
          </Button>
          <Button size="sm" :disabled="profileStore.generating || !repoCount" @click="generate">
            <Loader2Icon v-if="profileStore.generating" :size="13" class="mr-1.5 animate-spin" />
            <RefreshCwIcon v-else :size="13" class="mr-1.5" />
            {{ profile ? '重新生成' : '生成画像' }}
          </Button>
        </div>
      </div>

      <Alert v-if="error" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>{{ error }}</AlertDescription>
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

      <Card v-if="profileStore.generating" class="py-4">
        <CardContent class="flex items-center gap-2 px-4 text-xs text-muted-foreground">
          <Loader2Icon :size="14" class="animate-spin" />
          {{ profileStore.progress || '正在生成…' }}
        </CardContent>
      </Card>

      <Card v-if="!codeRoot && !profile" class="py-4">
        <CardContent class="px-4 text-xs text-muted-foreground">
          还没有可用的「代码目录」。到「设置 → 代码分析」看一下路径（留空会使用应用数据目录下的默认位置）。
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
            <p class="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
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
            <MessageResponse :content="profile.report" />
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

      <Card v-else-if="!profileStore.generating" class="py-12">
        <CardContent class="text-center text-sm text-muted-foreground">
          还没有生成过画像。点右上角「生成画像」，会扫描本地代码、按模块归纳，并让模型写出每个模块在做什么。
        </CardContent>
      </Card>
    </div>
  </div>
</template>
