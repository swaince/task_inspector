<script setup lang="ts">
import type { DirUsage, ToolStatus } from '@/core/bridge/types'
import { computed, onMounted, reactive, ref } from 'vue'
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { transport } from '@/core/bridge'
import { useSettingsStore } from '@/core/store/settings'
import { formatBytes, uid } from '@/lib/format'

/**
 * 代码分析配置：代码在哪、缓存放哪、分析工具装没装。
 *
 * 这里把两件事分得很开：
 * - 「代码目录」是用户自己的 checkout，应用只读，**不会**删除；
 * - 「缓存目录」是应用自己生成的东西（克隆副本、索引、分析产物），可以整目录清空。
 *
 * 混成一个目录的后果是把用户的代码当缓存删掉，不可恢复，所以界面上也分开写。
 */

const settingsStore = useSettingsStore()
const cfg = computed(() => settingsStore.settings.analysis)

/** 默认路径由 settings store 统一解析，留空即用默认值 */
const defaultCodeRoot = computed(() => settingsStore.analysisDefaults?.defaultCodeRoot ?? '')

const usage = ref<DirUsage | null>(null)
const usageLoading = ref(false)
const clearOpen = ref(false)
const clearing = ref(false)
const notice = ref<string | null>(null)
const error = ref<string | null>(null)

type ToolKind = 'codegraph' | 'graphify'
/** 环境依赖也走同一套探测，但不在安装列表里 */
type DetectKind = ToolKind | 'git'

const TOOLS: Array<{ kind: ToolKind, label: string, hint: string }> = [
  {
    kind: 'codegraph',
    label: 'codegraph',
    hint: '需要 Node：npm i -g @colbymchenry/codegraph',
  },
  {
    kind: 'graphify',
    label: 'graphify',
    hint: '需要 Python 3.10+：pipx install graphifyy（包名是两个 y）',
  },
]

const tools = reactive<Record<DetectKind, { status: ToolStatus | null, loading: boolean }>>({
  codegraph: { status: null, loading: false },
  graphify: { status: null, loading: false },
  git: { status: null, loading: false },
})

/** 正在安装/刚装完的过程输出。只在本次会话里保留，重启后不需要 */
const installs = reactive<Record<ToolKind, { running: boolean, log: string[], error: string | null }>>({
  codegraph: { running: false, log: [], error: null },
  graphify: { running: false, log: [], error: null },
})

/** 待确认安装的工具；非 null 时弹确认框 */
const pendingInstall = ref<ToolKind | null>(null)

const INSTALL_COMMANDS: Record<ToolKind, string[]> = {
  codegraph: ['npm install --prefix <应用数据目录>/tools/codegraph @colbymchenry/codegraph'],
  graphify: [
    'python -m venv <应用数据目录>/tools/graphify-venv',
    '<venv>/pip install graphifyy',
  ],
}

/** 缓存目录：留空时用应用数据目录下的默认位置（由 store 解析） */
const cachePath = computed(() => settingsStore.resolvedCacheDir)

function configuredPath(kind: DetectKind) {
  if (kind === 'codegraph')
    return cfg.value.codegraphPath
  if (kind === 'graphify')
    return cfg.value.graphifyPath
  // git 用系统安装的那份，不给自定义路径
  return ''
}

async function save() {
  error.value = null
  try {
    await settingsStore.save()
  }
  catch (err) {
    error.value = `保存失败：${err instanceof Error ? err.message : String(err)}`
  }
}

async function detect(kind: DetectKind) {
  tools[kind].loading = true
  try {
    tools[kind].status = await transport().toolStatus(kind, configuredPath(kind).trim() || undefined)
  }
  catch (err) {
    tools[kind].status = { found: false, error: err instanceof Error ? err.message : String(err) }
  }
  finally {
    tools[kind].loading = false
  }
}

async function onToolPathChange(kind: ToolKind) {
  await save()
  await detect(kind)
}

/** 确认后开始安装。安装过程通过 Channel 流式回传，结束时再探测一次版本 */
async function startInstall(kind: ToolKind) {
  pendingInstall.value = null
  const state = installs[kind]
  state.running = true
  state.log = []
  state.error = null
  notice.value = null

  try {
    await transport().installTool(kind, async (event) => {
      if (event.line) {
        state.log.push(event.line)
        // 输出可能很长（npm 的进度条尤其碎），只留最近 800 行
        if (state.log.length > 800)
          state.log.splice(0, state.log.length - 800)
      }

      if (!event.done)
        return

      state.running = false
      if (event.ok) {
        // 装到应用自己管理的目录里，直接把路径写进配置，比依赖 PATH 更确定
        if (event.path) {
          if (kind === 'codegraph')
            cfg.value.codegraphPath = event.path
          else
            cfg.value.graphifyPath = event.path
          await save()
        }
        notice.value = `${kind} 安装完成`
        await detect(kind)
      }
      else {
        state.error = event.message ?? '安装失败'
      }
    })
  }
  catch (err) {
    state.running = false
    state.error = err instanceof Error ? err.message : String(err)
  }
}

async function cancelInstall(kind: ToolKind) {
  try {
    await transport().cancelInstall(kind)
  }
  catch {
    // 进程可能已经自己结束了，取消失败不影响界面状态
  }
  installs[kind].running = false
  installs[kind].error = '已取消'
}

function confirmInstall() {
  if (pendingInstall.value)
    void startInstall(pendingInstall.value)
}

function installCommands(kind: ToolKind | null) {
  return kind ? INSTALL_COMMANDS[kind] : []
}

/* ------------------------------------------------------------------ *
 * Skills / MCP
 * ------------------------------------------------------------------ */

function addSkill() {
  cfg.value.skills = [
    ...(cfg.value.skills ?? []),
    { id: uid(), name: '', path: '', enabled: true },
  ]
  void save()
}

function removeSkill(id: string) {
  cfg.value.skills = (cfg.value.skills ?? []).filter(s => s.id !== id)
  void save()
}

function addMcpServer() {
  cfg.value.mcpServers = [
    ...(cfg.value.mcpServers ?? []),
    { id: uid(), name: '', transport: 'stdio', command: '', args: '', env: '', enabled: true },
  ]
  void save()
}

function removeMcpServer(id: string) {
  cfg.value.mcpServers = (cfg.value.mcpServers ?? []).filter(s => s.id !== id)
  void save()
}

async function refreshUsage() {
  if (!cachePath.value)
    return
  usageLoading.value = true
  try {
    usage.value = await transport().dirUsage(cachePath.value)
  }
  catch (err) {
    error.value = `读取缓存占用失败：${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    usageLoading.value = false
  }
}

async function onCacheDirChange() {
  await save()
  await refreshUsage()
}

async function clearCache() {
  clearing.value = true
  error.value = null
  notice.value = null
  try {
    const result = await transport().clearCache(cachePath.value, cfg.value.codeRoot.trim() || undefined)
    notice.value = `已清理 ${result.removedEntries} 项，释放 ${formatBytes(result.removedBytes)}`
    clearOpen.value = false
    await refreshUsage()
  }
  catch (err) {
    error.value = `清理失败：${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    clearing.value = false
  }
}

onMounted(async () => {
  await Promise.all([detect('codegraph'), detect('graphify'), detect('git'), refreshUsage()])
})
</script>

<template>
  <div class="space-y-4">
    <Alert v-if="error" variant="destructive">
      <AlertTriangleIcon :size="14" />
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>
    <Alert v-else-if="notice">
      <CheckCircle2Icon :size="14" />
      <AlertDescription>{{ notice }}</AlertDescription>
    </Alert>

    <Card class="gap-0 py-4">
      <CardHeader class="px-4 pb-3">
        <CardTitle class="text-sm">代码目录</CardTitle>
        <CardDescription class="text-xs">
          本机已有的代码检出目录。应用只按仓库路径在这里查找，不会修改或删除任何文件。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-2 px-4">
        <Label class="text-xs">本地代码根目录</Label>
        <Input
          v-model="cfg.codeRoot"
          :placeholder="defaultCodeRoot || '例如 E:/CodeRepo'"
          class="font-mono text-xs"
          @change="save"
        />
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          留空使用默认目录
          <code class="font-mono">{{ defaultCodeRoot || '（应用数据目录/code）' }}</code>。
          生成画像时按 <code class="font-mono">&lt;命名空间&gt;/&lt;仓库名&gt;</code> 查找，
          目录不存在会自动逐级创建出来，把代码放进去再重新生成即可。
        </p>
      </CardContent>
    </Card>

    <Card class="gap-0 py-4">
      <CardHeader class="px-4 pb-3">
        <CardTitle class="text-sm">分析缓存</CardTitle>
        <CardDescription class="text-xs">
          应用生成的克隆副本、索引和分析产物。这个目录可以随时清空，不影响已保存的检查结果。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 px-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" :title="cachePath">
            {{ cachePath || '—' }}
          </span>
          <Badge variant="secondary" class="shrink-0 tabular-nums">
            {{ usageLoading ? '计算中…' : formatBytes(usage?.bytes ?? 0) }}
          </Badge>
          <Badge v-if="usage && usage.files" variant="outline" class="shrink-0 tabular-nums">
            {{ usage.files }} 个文件
          </Badge>
        </div>

        <div class="flex items-center gap-2">
          <Input
            v-model="cfg.cacheDir"
            placeholder="留空使用默认目录"
            class="font-mono text-xs"
            @change="onCacheDirChange"
          />
          <Button variant="outline" size="sm" :disabled="usageLoading" @click="refreshUsage">
            <Loader2Icon v-if="usageLoading" :size="13" class="mr-1.5 animate-spin" />
            <RefreshCwIcon v-else :size="13" class="mr-1.5" />
            刷新
          </Button>
          <Button
            variant="destructive"
            size="sm"
            :disabled="!cachePath || clearing"
            @click="clearOpen = true"
          >
            <Trash2Icon :size="13" class="mr-1.5" />
            清理
          </Button>
        </div>
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          清理只删这个目录下的内容，且会拒绝清空磁盘根目录、用户主目录，以及带
          <code class="font-mono">.git</code> 的工作区。
        </p>
      </CardContent>
    </Card>

    <Card class="gap-0 py-4">
      <CardHeader class="px-4 pb-3">
        <CardTitle class="text-sm">运行环境</CardTitle>
        <CardDescription class="text-xs">
          克隆仓库、统计改动热点都依赖 Git。没有它，「自动克隆」和「热点」两项不可用。
        </CardDescription>
      </CardHeader>
      <CardContent class="px-4">
        <div class="rounded-md border p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-sm font-medium">git</span>

            <Badge v-if="tools.git.loading" variant="outline">
              <Loader2Icon :size="10" class="mr-1 animate-spin" />
              检测中
            </Badge>
            <Badge v-else-if="tools.git.status?.found" variant="secondary">
              已安装 {{ tools.git.status?.version || '' }}
            </Badge>
            <Badge v-else variant="outline" class="text-amber-600 dark:text-amber-500">
              未检测到
            </Badge>

            <Button
              variant="ghost"
              size="sm"
              class="ml-auto text-xs"
              :disabled="tools.git.loading"
              @click="detect('git')"
            >
              重新检测
            </Button>
          </div>

          <p
            v-if="tools.git.status?.path"
            class="mt-1 truncate font-mono text-[11px] text-muted-foreground"
            :title="tools.git.status?.path"
          >
            {{ tools.git.status?.path }}
          </p>
          <p v-else class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            安装 Git 后点「重新检测」；装好需要重启应用才能继承新的 PATH。
            Windows 可从 git-scm.com 下载，Linux/macOS 用系统包管理器安装。
          </p>
        </div>
      </CardContent>
    </Card>

    <Card class="gap-0 py-4">
      <CardHeader class="px-4 pb-3">
        <CardTitle class="text-sm">分析工具</CardTitle>
        <CardDescription class="text-xs">
          用于代码结构分析。没装也能用轻量模式（目录结构 + 提交热点），装上后才有调用关系和影响面。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 px-4">
        <div v-for="tool in TOOLS" :key="tool.kind" class="rounded-md border p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-sm font-medium">{{ tool.label }}</span>

            <Badge v-if="tools[tool.kind].loading" variant="outline">
              <Loader2Icon :size="10" class="mr-1 animate-spin" />
              检测中
            </Badge>
            <Badge v-else-if="tools[tool.kind].status?.found" variant="secondary">
              已安装 {{ tools[tool.kind].status?.version || '' }}
            </Badge>
            <Badge v-else variant="outline" class="text-amber-600 dark:text-amber-500">
              未检测到
            </Badge>

            <span
              v-if="tools[tool.kind].status?.source"
              class="text-[11px] text-muted-foreground"
            >
              来源：{{ tools[tool.kind].status?.source === 'path' ? 'PATH' : '手动指定' }}
            </span>

            <div class="ml-auto flex items-center gap-1.5">
              <Button
                v-if="!tools[tool.kind].status?.found && !installs[tool.kind].running"
                variant="outline"
                size="sm"
                class="text-xs"
                @click="pendingInstall = tool.kind"
              >
                应用内安装
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="text-xs"
                :disabled="tools[tool.kind].loading"
                @click="detect(tool.kind)"
              >
                重新检测
              </Button>
            </div>
          </div>

          <p
            v-if="tools[tool.kind].status?.path"
            class="mt-1 truncate font-mono text-[11px] text-muted-foreground"
            :title="tools[tool.kind].status?.path"
          >
            {{ tools[tool.kind].status?.path }}
          </p>
          <p
            v-else-if="tools[tool.kind].status?.error"
            class="mt-1 text-[11px] text-muted-foreground"
          >
            {{ tools[tool.kind].status?.error }}
          </p>

          <div class="mt-2 flex items-center gap-2">
            <Input
              :model-value="tool.kind === 'codegraph' ? cfg.codegraphPath : cfg.graphifyPath"
              placeholder="可执行文件路径，留空自动从 PATH 查找"
              class="h-8 font-mono text-xs"
              @update:model-value="v => {
                if (tool.kind === 'codegraph') cfg.codegraphPath = String(v)
                else cfg.graphifyPath = String(v)
              }"
              @change="onToolPathChange(tool.kind)"
            />
          </div>

          <p class="mt-1 text-[11px] text-muted-foreground">{{ tool.hint }}</p>

          <div
            v-if="installs[tool.kind].running || installs[tool.kind].log.length || installs[tool.kind].error"
            class="mt-2 space-y-1.5"
          >
            <div class="flex items-center gap-2 text-[11px]">
              <Loader2Icon v-if="installs[tool.kind].running" :size="11" class="animate-spin" />
              <span :class="installs[tool.kind].error ? 'text-destructive' : 'text-muted-foreground'">
                {{ installs[tool.kind].running ? '正在安装…' : (installs[tool.kind].error || '安装完成') }}
              </span>
              <Button
                v-if="installs[tool.kind].running"
                variant="ghost"
                size="xs"
                class="ml-auto text-[11px]"
                @click="cancelInstall(tool.kind)"
              >
                取消
              </Button>
            </div>
            <pre
              v-if="installs[tool.kind].log.length"
              class="max-h-40 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
            >{{ installs[tool.kind].log.slice(-200).join('\n') }}</pre>
          </div>
        </div>

        <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
          <div>
            <div class="text-xs font-medium">生成画像时自动建索引</div>
            <div class="text-[11px] text-muted-foreground">
              关闭后只用已有索引做轻量分析，不会因为首次索引耗时太长而卡住
            </div>
          </div>
          <Switch
            :model-value="cfg.autoIndex"
            @update:model-value="v => { cfg.autoIndex = !!v; save() }"
          />
        </div>

        <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
          <div>
            <div class="text-xs font-medium">缺少本地代码时自动克隆</div>
            <div class="text-[11px] text-muted-foreground">
              用 GitLab Token 浅克隆到代码目录；目录里已有内容时不会覆盖
            </div>
          </div>
          <Switch
            :model-value="cfg.autoClone"
            @update:model-value="v => { cfg.autoClone = !!v; save() }"
          />
        </div>

        <div class="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
          <div>
            <div class="text-xs font-medium">浅克隆深度</div>
            <div class="text-[11px] text-muted-foreground">
              按提交数计，0 表示完整克隆。深度越大热点统计越准，克隆越慢
            </div>
          </div>
          <Input
            :model-value="String(cfg.cloneDepth ?? 200)"
            type="number"
            min="0"
            class="h-8 w-24 text-xs"
            @update:model-value="v => { cfg.cloneDepth = Math.max(0, Number(v) || 0) }"
            @change="save"
          />
        </div>
      </CardContent>
    </Card>

    <Card class="gap-0 py-4">
      <CardHeader class="px-4 pb-3">
        <CardTitle class="text-sm">Skills</CardTitle>
        <CardDescription class="text-xs">
          用 markdown 写成的分析指令，生成项目画像时拼进系统提示。不同技术栈「该看什么」差别很大，用它区分。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 px-4">
        <div v-for="s in cfg.skills" :key="s.id" class="space-y-1.5 rounded-md border p-2.5">
          <div class="flex items-center gap-2">
            <Input
              v-model="s.name"
              placeholder="名称，如 Java/Spring 项目画像"
              class="text-xs"
              @change="save"
            />
            <Switch
              :model-value="s.enabled"
              @update:model-value="v => { s.enabled = !!v; save() }"
            />
            <Button variant="ghost" size="sm" class="shrink-0 px-1.5" @click="removeSkill(s.id)">
              <Trash2Icon :size="13" />
            </Button>
          </div>
          <Input
            v-model="s.path"
            placeholder="markdown 文件路径，例如 E:/skills/java-profile.md"
            class="font-mono text-xs"
            @change="save"
          />
        </div>

        <Button variant="outline" size="sm" class="text-xs" @click="addSkill">
          + 添加 skill
        </Button>

        <p class="text-[11px] leading-relaxed text-muted-foreground">
          文件在当前机器上，应用只读不改。生成画像时如果文件不存在会明确提示，不会静默跳过。
        </p>
      </CardContent>
    </Card>

    <Card class="gap-0 py-4">
      <CardHeader class="px-4 pb-3">
        <CardTitle class="text-sm">MCP 服务器</CardTitle>
        <CardDescription class="text-xs">
          codegraph、graphify 都提供 MCP 接口。这里登记本地 stdio 服务，分析流程会复用它们提供的工具。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 px-4">
        <div v-for="s in cfg.mcpServers" :key="s.id" class="space-y-1.5 rounded-md border p-2.5">
          <div class="flex items-center gap-2">
            <Input
              v-model="s.name"
              placeholder="名称，如 codegraph"
              class="text-xs"
              @change="save"
            />
            <Switch
              :model-value="s.enabled"
              @update:model-value="v => { s.enabled = !!v; save() }"
            />
            <Button variant="ghost" size="sm" class="shrink-0 px-1.5" @click="removeMcpServer(s.id)">
              <Trash2Icon :size="13" />
            </Button>
          </div>
          <div class="grid gap-1.5 sm:grid-cols-2">
            <Input
              v-model="s.command"
              placeholder="启动命令，如 npx"
              class="font-mono text-xs"
              @change="save"
            />
            <Input
              v-model="s.args"
              placeholder="参数，如 -y @colbymchenry/codegraph mcp"
              class="font-mono text-xs"
              @change="save"
            />
          </div>
          <Input
            v-model="s.env"
            placeholder="环境变量，每行 KEY=VALUE（可选）"
            class="font-mono text-xs"
            @change="save"
          />
        </div>

        <Button variant="outline" size="sm" class="text-xs" @click="addMcpServer">
          + 添加 MCP 服务器
        </Button>

        <p class="text-[11px] leading-relaxed text-muted-foreground">
          当前版本先保存配置；建立会话、列出和调用工具会在分析流程接入后生效。
          内置的 codegraph / graphify 即使不配 MCP，也会直接用命令行调用。
        </p>
      </CardContent>
    </Card>

    <Dialog
      :open="pendingInstall !== null"
      @update:open="v => { if (!v) pendingInstall = null }"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>安装 {{ pendingInstall }}？</DialogTitle>
        </DialogHeader>
        <div class="space-y-2">
          <p class="text-sm text-muted-foreground">
            安装到应用数据目录，不改动系统环境。将执行：
          </p>
          <pre class="overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{{ installCommands(pendingInstall).join('\n') }}</pre>
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            安装过程会实时显示在工具卡片里，可随时取消。需要本机有对应的运行时：
            codegraph 需要 Node/npm，graphify 需要 Python 3.10+。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="pendingInstall = null">
            取消
          </Button>
          <Button @click="confirmInstall">
            开始安装
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="clearOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>清空分析缓存？</DialogTitle>
        </DialogHeader>
        <p class="text-sm leading-relaxed text-muted-foreground">
          将删除 <code class="font-mono text-xs">{{ cachePath }}</code> 下的全部内容，
          当前占用 {{ formatBytes(usage?.bytes ?? 0) }}。检查结果和日报数据不受影响，
          但下次分析需要重新克隆/建索引。
        </p>
        <DialogFooter>
          <Button variant="outline" @click="clearOpen = false">
            取消
          </Button>
          <Button variant="destructive" :disabled="clearing" @click="clearCache">
            <Loader2Icon v-if="clearing" :size="13" class="mr-1.5 animate-spin" />
            确认清理
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
