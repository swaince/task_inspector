<script setup lang="ts">
import type { Update } from '@tauri-apps/plugin-updater'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  DownloadIcon,
  Loader2Icon,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { openExternal, isDesktop } from '@/core/bridge'
import { formatDateTime } from '@/lib/format'

/**
 * 应用内更新。
 *
 * 只认带签名的 latest.json：更新包由 CI 用本机私钥签名，
 * 应用里内置公钥，签名对不上就不会安装。没有签名密钥时构建会失败，
 * 这是故意的——不能悄悄退化成不校验来源的自动更新。
 */

const desktop = isDesktop()
const dev = import.meta.env.DEV

const currentVersion = ref(__APP_VERSION__)
const installKind = ref<'unknown' | 'installed' | 'portable'>('unknown')
const update = shallowRef<Update | null>(null)
const dialogOpen = ref(false)
const mode = ref<'update' | 'latest' | 'dev' | 'error'>('update')
const checking = ref(false)
const downloading = ref(false)
const progress = ref(0)
const error = ref('')
const phase = ref<'idle' | 'downloading' | 'installing' | 'done'>('idle')

const hasUpdate = computed(() => Boolean(update.value))
const isPortable = computed(() => installKind.value === 'portable')

const title = computed(() => {
  if (mode.value === 'latest')
    return '已是最新版本'
  if (mode.value === 'dev')
    return '开发模式不检查更新'
  if (mode.value === 'error')
    return '检查更新失败'
  return `发现新版本 ${update.value?.version ?? ''}`
})

const description = computed(() => {
  if (mode.value === 'latest')
    return `当前版本 ${currentVersion.value}`
  if (mode.value === 'dev')
    return '请在安装版中测试自动更新；开发模式不会请求更新源。'
  if (mode.value === 'error')
    return `当前版本 ${currentVersion.value}`
  if (isPortable.value)
    return `当前版本 ${currentVersion.value}；没有检测到 NSIS 安装器，需要手动更新。`
  return `当前版本 ${currentVersion.value}，可以从这里下载并安装新版本。`
})

const phaseText = computed(() => ({
  idle: '',
  downloading: '正在下载更新…',
  installing: '下载完成，正在安装…',
  done: '安装完成，请手动重启应用',
}[phase.value]))

onMounted(async () => {
  if (!desktop)
    return

  try {
    currentVersion.value = await getVersion()
  }
  catch {
    // 浏览器或非 Tauri 环境取不到，用构建期版本兜底
  }

  try {
    const kind = await invoke<string>('install_kind')
    if (kind === 'installed' || kind === 'portable')
      installKind.value = kind
  }
  catch {
    // 旧版本后端没有这个命令时按未知处理：保留安装按钮，同时给出免安装说明
  }

  if (!dev)
    timer = window.setTimeout(() => void doCheck(false), 4000)
})

let timer: ReturnType<typeof setTimeout> | null = null

onBeforeUnmount(() => {
  if (timer)
    clearTimeout(timer)
  // 没安装的检查结果要在后端释放，否则会一直占着下载资源
  if (update.value)
    void update.value.close().catch(() => {})
})

async function doCheck(manual: boolean) {
  if (!desktop) {
    return
  }
  if (dev) {
    if (manual) {
      mode.value = 'dev'
      dialogOpen.value = true
    }
    return
  }
  if (checking.value)
    return
  if (update.value) {
    if (manual)
      dialogOpen.value = true
    return
  }

  checking.value = true
  error.value = ''
  try {
    const found = await check({ timeout: 20_000 })
    if (found) {
      update.value = found
      mode.value = 'update'
      if (manual)
        dialogOpen.value = true
    }
    else if (manual) {
      mode.value = 'latest'
      dialogOpen.value = true
    }
  }
  catch (err) {
    if (manual) {
      mode.value = 'error'
      error.value = err instanceof Error ? err.message : String(err)
      dialogOpen.value = true
    }
  }
  finally {
    checking.value = false
  }
}

function manualCheck() {
  void doCheck(true)
}

function openPortableDownload() {
  void openExternal('https://github.com/swaince/task_inspector/releases/latest')
}

async function install() {
  const current = update.value
  if (!current || downloading.value)
    return

  downloading.value = true
  error.value = ''
  progress.value = 0
  phase.value = 'downloading'
  let total = 0
  let received = 0

  try {
    await current.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0
      }
      else if (event.event === 'Progress') {
        received += event.data.chunkLength
        progress.value = total > 0
          ? Math.min(100, Math.round((received / total) * 100))
          : 0
      }
      else if (event.event === 'Finished') {
        progress.value = 100
        phase.value = 'installing'
      }
    })
  }
  catch (err) {
    error.value = `安装失败：${err instanceof Error ? err.message : String(err)}`
    phase.value = 'idle'
    downloading.value = false
    return
  }

  phase.value = 'installing'
  try {
    // Windows 安装器通常会直接结束应用；macOS 需要显式重启
    await relaunch()
  }
  catch {
    phase.value = 'done'
  }
  finally {
    downloading.value = false
  }
}

function onOpenChange(open: boolean) {
  if (!open && downloading.value)
    return

  dialogOpen.value = open
  if (!open && update.value) {
    void update.value.close().catch(() => {})
    update.value = null
  }
}
</script>

<template>
  <template v-if="desktop">
    <Button
      variant="ghost"
      size="sm"
      class="no-drag relative px-2"
      :disabled="checking"
      :title="hasUpdate ? `发现新版本 ${update?.version}` : '检查更新'"
      :aria-label="hasUpdate ? '发现新版本' : '检查更新'"
      @click="manualCheck"
    >
      <Loader2Icon v-if="checking" :size="14" class="animate-spin" />
      <DownloadIcon v-else :size="14" />
      <span
        v-if="hasUpdate"
        class="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-500"
      />
    </Button>

    <Dialog :open="dialogOpen" @update:open="onOpenChange">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ title }}</DialogTitle>
          <DialogDescription>{{ description }}</DialogDescription>
        </DialogHeader>

        <template v-if="mode === 'update' && update">
          <div class="space-y-3">
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="font-mono text-muted-foreground">{{ currentVersion }}</span>
              <ArrowRightIcon :size="13" class="text-muted-foreground" />
              <span class="font-mono font-medium">{{ update.version }}</span>
              <span
                v-if="update.date"
                class="text-[11px] text-muted-foreground"
              >
                {{ formatDateTime(update.date) }}
              </span>
            </div>

            <div
              v-if="update.body"
              class="max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
            >
              {{ update.body }}
            </div>

            <div v-if="downloading || phase !== 'idle'" class="space-y-1.5">
              <Progress :model-value="progress" />
              <div class="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span>{{ phaseText }}</span>
                <span class="tabular-nums">{{ progress }}%</span>
              </div>
            </div>

            <div
              v-if="isPortable"
              class="rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground"
            >
              <p>
                当前没有检测到 NSIS 安装器，不能应用内替换：
              </p>
              <p class="mt-1">
                免安装版：关闭应用后，用最新 zip 里的 exe 覆盖旧文件；
                MSI 安装版：下载并安装新的 MSI。项目和检查历史存在 AppData 里，不受影响。
              </p>
              <button
                type="button"
                class="mt-1.5 inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:no-underline"
                @click="openPortableDownload"
              >
                <DownloadIcon :size="12" />
                打开最新 Release 下载免安装包
              </button>
            </div>

            <div
              v-else-if="installKind === 'unknown'"
              class="rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground"
            >
              <p>
                安装版可以直接「下载并安装」。如果这是 Windows 免安装版，请关闭应用后
                用最新 zip 里的 exe 覆盖旧文件；项目和检查历史存在 AppData 里，不受影响。
              </p>
              <button
                type="button"
                class="mt-1.5 inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:no-underline"
                @click="openPortableDownload"
              >
                <DownloadIcon :size="12" />
                打开最新 Release 下载免安装包
              </button>
            </div>

            <Alert v-if="error" variant="destructive">
              <AlertTriangleIcon :size="14" />
              <AlertDescription>{{ error }}</AlertDescription>
            </Alert>
          </div>
        </template>

        <div v-else-if="mode === 'latest'" class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          当前已经是最新版本。之后有新版本时会在这里提示。
        </div>

        <div v-else-if="mode === 'dev'" class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          开发模式（<code class="font-mono text-[11px]">tauri dev</code>）不会请求更新源，也不会安装更新包。
        </div>

        <Alert v-else variant="destructive">
          <AlertTriangleIcon :size="14" />
          <AlertDescription>
            {{ error || '无法连接到更新服务，请稍后重试。' }}
          </AlertDescription>
        </Alert>

        <DialogFooter>
          <Button variant="outline" :disabled="downloading" @click="onOpenChange(false)">
            {{ mode === 'update' ? '稍后' : '关闭' }}
          </Button>
          <Button
            v-if="mode === 'update' && update && isPortable"
            @click="openPortableDownload"
          >
            <DownloadIcon :size="13" class="mr-1.5" />
            打开下载页
          </Button>
          <Button
            v-else-if="mode === 'update' && update"
            :disabled="downloading || phase === 'done'"
            @click="install"
          >
            <Loader2Icon v-if="downloading" :size="13" class="mr-1.5 animate-spin" />
            <DownloadIcon v-else :size="13" class="mr-1.5" />
            {{ downloading ? '正在安装…' : '下载并安装（安装版）' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </template>
</template>
