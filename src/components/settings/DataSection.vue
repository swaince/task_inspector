<script setup lang="ts">
import { computed, ref } from 'vue'
import { CheckIcon, ClipboardCopyIcon, DatabaseIcon, DownloadIcon, Trash2Icon, UploadIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { isDesktop, transport } from '@/core/bridge'
import { mergeSettings } from '@/core/config/merge'
import { useHistoryStore } from '@/core/store/history'
import { useReportStore } from '@/core/store/reports'
import { useSettingsStore } from '@/core/store/settings'

const settingsStore = useSettingsStore()
const historyStore = useHistoryStore()
const reportStore = useReportStore()

const copied = ref(false)
const importText = ref('')
const importError = ref<string | null>(null)

const storageHint = computed(() =>
  isDesktop()
    ? '数据保存在本机的应用数据目录下：配置为 config/settings.json，检查历史为 data/inspections/。不会上传到任何服务器。'
    : '当前是浏览器预览模式，数据存在 localStorage 里。打包成桌面应用后会改为本机文件存储。',
)

async function save() {
  await settingsStore.save()
}

/**
 * 配置导入导出。
 * 主要用于在一台机器上调好映射关系（项目名、人员、忽略规则）后，复制到同事机器上，
 * 避免每个人重新配一遍。Token 也包含在里面，分享前需要自行删除。
 */
async function copyConfig() {
  await navigator.clipboard.writeText(JSON.stringify(settingsStore.settings, null, 2))
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

async function applyImport() {
  importError.value = null
  try {
    const parsed = JSON.parse(importText.value)
    settingsStore.settings = mergeSettings(parsed)
    await settingsStore.save()
    importText.value = ''
  }
  catch (err) {
    importError.value = `解析失败：${err instanceof Error ? err.message : String(err)}`
  }
}

async function clearHistory() {
  await historyStore.clear()
}

async function clearReports() {
  await reportStore.clear()
}

/* ------------------------------------------------------------------ *
 * 重置数据
 * ------------------------------------------------------------------ */

const confirmOpen = ref(false)
const pendingMode = ref<'business' | 'all'>('business')
const resetting = ref(false)

function askReset(mode: 'business' | 'all') {
  pendingMode.value = mode
  confirmOpen.value = true
}

/**
 * 清空之后直接重载页面。
 *
 * 各个 store 都有 `loaded` 标志，清库之后它们不会自己去重读；
 * 与其给每个 store 加一个「强制重载」的口子（容易漏），不如让页面重新初始化一遍，
 * 那样内存状态和库一定是一致的。
 */
async function doReset() {
  resetting.value = true
  try {
    await transport().dataReset(pendingMode.value)
    location.reload()
  }
  catch (err) {
    importError.value = err instanceof Error ? err.message : String(err)
    confirmOpen.value = false
  }
  finally {
    resetting.value = false
  }
}
</script>

<template>
  <Card class="gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="text-sm">数据与存储</CardTitle>
      <CardDescription class="text-xs">{{ storageHint }}</CardDescription>
    </CardHeader>

    <CardContent class="space-y-4 px-4">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <Label for="d-keep" class="text-[11px] text-muted-foreground">
            检查历史保留天数（0 表示永久保留）
          </Label>
          <Input
            id="d-keep"
            :model-value="settingsStore.settings.retention.keepDays"
            type="number"
            min="0"
            @update:model-value="v => { settingsStore.settings.retention.keepDays = Math.max(0, Number(v) || 0); save() }"
          />
          <p class="text-[11px] text-muted-foreground">
            超期记录会在应用启动时自动清理
          </p>
        </div>

        <div class="flex items-end gap-2">
          <Button variant="outline" size="sm" :disabled="!historyStore.results.length" @click="clearHistory">
            <Trash2Icon :size="13" class="mr-1.5" />
            清空检查历史（{{ historyStore.results.length }}）
          </Button>
          <Button variant="outline" size="sm" :disabled="!reportStore.totalReports" @click="clearReports">
            <Trash2Icon :size="13" class="mr-1.5" />
            清空日报数据（{{ reportStore.totalReports }}）
          </Button>
        </div>
      </div>

      <Separator />

      <div class="space-y-2">
        <div class="flex items-center gap-2 text-xs font-medium">
          <DatabaseIcon :size="13" />
          配置导入导出
        </div>
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          在一台机器上调好项目映射、成员映射和忽略规则后，可以导出配置贴到其它机器上，
          省去重复配置。<strong class="font-medium">注意导出内容包含 Token</strong>，外发前请先删掉。
        </p>

        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="copyConfig">
            <CheckIcon v-if="copied" :size="13" class="mr-1.5" />
            <ClipboardCopyIcon v-else :size="13" class="mr-1.5" />
            {{ copied ? '已复制到剪贴板' : '复制当前配置' }}
          </Button>
        </div>

        <Textarea
          v-model="importText"
          rows="4"
          class="font-mono text-xs"
          placeholder="粘贴一份配置 JSON 后点「导入」，会与默认值合并"
        />

        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" :disabled="!importText.trim()" @click="applyImport">
            <UploadIcon :size="13" class="mr-1.5" />
            导入并覆盖
          </Button>
          <Button variant="ghost" size="sm" @click="settingsStore.resetAll()">
            <DownloadIcon :size="13" class="mr-1.5" />
            恢复默认配置
          </Button>
        </div>

        <Alert v-if="importError" variant="destructive">
          <AlertDescription>{{ importError }}</AlertDescription>
        </Alert>
      </div>

      <Separator />

      <div class="space-y-2">
        <div class="flex items-center gap-2 text-xs font-medium text-destructive">
          <Trash2Icon :size="13" />
          重置数据
        </div>
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          「只清业务数据」会清空日报、检查历史、提交缓存、项目和人员，配置保留；
          「全部重置」连 GitLab / 日报系统 / 模型 / LDAP 配置一起清，等于重新装一遍。
          清空后无法撤销，动手前建议先「复制当前配置」备一份。
        </p>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" :disabled="resetting" @click="askReset('business')">
            只清业务数据
          </Button>
          <Button variant="destructive" size="sm" :disabled="resetting" @click="askReset('all')">
            全部重置
          </Button>
        </div>
      </div>
    </CardContent>

    <Dialog v-model:open="confirmOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ pendingMode === 'all' ? '全部重置？' : '清空业务数据？' }}</DialogTitle>
        </DialogHeader>
        <p class="text-sm leading-relaxed text-muted-foreground">
          <template v-if="pendingMode === 'all'">
            日报、检查历史、提交缓存、项目、人员，以及 GitLab / 日报系统 / 模型 / LDAP 的全部配置都会被清空，
            应用回到刚安装的状态，需要重新配置。
          </template>
          <template v-else>
            日报、检查历史、提交缓存、项目、人员都会被清空；GitLab / 日报 / 模型 / LDAP 的配置保留。
          </template>
          <strong class="font-medium text-foreground">无法撤销。</strong>
        </p>
        <DialogFooter>
          <Button variant="outline" @click="confirmOpen = false">
            取消
          </Button>
          <Button variant="destructive" :disabled="resetting" @click="doReset">
            确认清空
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>
</template>
