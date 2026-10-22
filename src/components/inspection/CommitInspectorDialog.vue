<script setup lang="ts">
import type { CommitPatch } from '@/core/adapters/gitlab'
import type { GitCommit } from '@/core/domain/types'
import { computed, ref, watch } from 'vue'
import { ExternalLinkIcon, GitBranchIcon, Loader2Icon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GitLabClient } from '@/core/adapters/gitlab'
import { openExternal } from '@/core/bridge'
import { useSettingsStore } from '@/core/store/settings'

/**
 * 提交详情。
 *
 * 活动视图里只显示标题——那点信息够用来扫一眼，但回答不了「这条提交到底改了什么」。
 * diff 逐条拉一次请求，所以做成点开才拉，不在扫描时预先取。
 */

const props = defineProps<{ commit: GitCommit | null }>()
const open = defineModel<boolean>('open', { default: false })

const settingsStore = useSettingsStore()

const loading = ref(false)
const error = ref<string | null>(null)
const patches = ref<CommitPatch[]>([])

/** 提交信息第一行是标题，正文从第二行开始 */
const body = computed(() => (props.commit?.message ?? '').split('\n').slice(1).join('\n').trim())

watch([open, () => props.commit?.id], async ([isOpen]) => {
  if (!isOpen || !props.commit)
    return

  loading.value = true
  error.value = null
  patches.value = []
  try {
    const client = new GitLabClient(settingsStore.settings.gitlab)
    patches.value = await client.getCommitPatch(props.commit.projectId, props.commit.id)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
})

function changeLabel(p: CommitPatch) {
  if (p.isNew)
    return '新增'
  if (p.isDeleted)
    return '删除'
  if (p.isRenamed)
    return '重命名'
  return '修改'
}

/** 单文件 diff 只展示前 6000 字：完整 patch 可能是几万行，滚起来就没法看了 */
const PATCH_LIMIT = 6000

function shownPatch(p: CommitPatch) {
  if (!p.patch)
    return ''
  return p.patch.length > PATCH_LIMIT ? `${p.patch.slice(0, PATCH_LIMIT)}\n…（已截断，完整内容到 GitLab 上看）` : p.patch
}

/**
 * diff 逐行渲染。
 *
 * 整段塞进一个 <pre> 也能看，但长行会一直往右延伸，想读完整句就得左右拖；
 * 拆成行之后既能按行上色，也能在「自动换行」模式下让长行折回来。
 * 按行渲染的行数最多几千，对桌面端不算负担。
 */
function patchLines(p: CommitPatch) {
  return shownPatch(p).split('\n')
}

/**
 * 行样式：+ / - 上底色，@@ 头用弱色，其余保持正文。
 * `+++` `---` 是文件头不是增删行，单独排除，否则整行会被染成绿色/红色。
 */
function lineClass(line: string) {
  if (line.startsWith('@@'))
    return 'bg-muted/50 text-muted-foreground'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index '))
    return 'text-muted-foreground'
  if (line.startsWith('+'))
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (line.startsWith('-'))
    return 'bg-red-500/10 text-red-700 dark:text-red-300'
  return ''
}

/** 长行是否折回来显示。默认折行——在弹框里横向拖来拖去读 diff 太难受 */
const wrap = ref(true)

function fmtTime(iso: string) {
  return iso.replace('T', ' ').slice(0, 16)
}
</script>

<template>
  <Dialog v-model:open="open">
    <!-- 默认的 sm:max-w-sm 会压过不带前缀的 max-w-*，所以必须写成 sm: 变体才生效 -->
    <DialogContent class="sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle class="pr-6 text-sm leading-snug">
          {{ commit?.title ?? '提交详情' }}
        </DialogTitle>
      </DialogHeader>

      <div v-if="commit" class="space-y-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span class="font-mono">{{ commit.shortId }}</span>
          <span>{{ fmtTime(commit.authoredDate) }}</span>
          <span>{{ commit.authorName }}</span>
          <span class="font-mono">{{ commit.projectPath }}</span>
          <span v-if="commit.refName" class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]">
            <GitBranchIcon :size="10" />
            {{ commit.refName }}
          </span>
          <span v-if="commit.stats" class="tabular-nums">
            +{{ commit.stats.additions }} / -{{ commit.stats.deletions }}
          </span>
          <Button
            v-if="commit.webUrl"
            variant="link"
            class="ml-auto h-auto p-0 text-[11px]"
            @click="openExternal(commit.webUrl)"
          >
            GitLab
            <ExternalLinkIcon :size="10" class="ml-1" />
          </Button>
        </div>

        <div v-if="body" class="rounded-md border bg-muted/30 p-2.5">
          <div class="mb-1 text-[11px] font-medium">提交信息</div>
          <pre class="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{{ body }}</pre>
        </div>

        <Alert v-if="error" variant="destructive">
          <AlertDescription>拉取改动内容失败：{{ error }}</AlertDescription>
        </Alert>

        <div v-if="loading" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2Icon :size="13" class="animate-spin" />
          正在拉取改动内容…
        </div>

        <div v-else-if="patches.length" class="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          <div class="flex items-center gap-2 text-[11px] font-medium">
            改动文件 {{ patches.length }} 个
            <button
              type="button"
              class="ml-auto rounded border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground"
              :class="wrap ? 'bg-muted/50' : ''"
              @click="wrap = !wrap"
            >
              {{ wrap ? '自动换行：开' : '自动换行：关' }}
            </button>
          </div>
          <div v-for="p in patches" :key="p.path" class="overflow-hidden rounded-md border">
            <div class="flex items-center gap-2 border-b bg-muted/30 px-2.5 py-1.5">
              <Badge variant="outline" class="shrink-0 text-[11px]">{{ changeLabel(p) }}</Badge>
              <span class="truncate font-mono text-[11px]">{{ p.path }}</span>
              <span v-if="p.oldPath" class="shrink-0 text-[11px] text-muted-foreground">
                ← {{ p.oldPath }}
              </span>
            </div>
            <div
              v-if="shownPatch(p)"
              class="max-h-80 overflow-auto py-1 font-mono text-[11px] leading-relaxed"
            >
              <div
                v-for="(line, i) in patchLines(p)"
                :key="i"
                class="px-2.5"
                :class="[lineClass(line), wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre']"
              >{{ line === '' ? ' ' : line }}</div>
            </div>
            <p v-else class="px-2.5 py-2 text-[11px] text-muted-foreground">
              二进制文件，没有可展示的文本改动。
            </p>
          </div>
        </div>

        <p v-else-if="!error" class="py-2 text-xs text-muted-foreground">
          这条提交没有文件改动记录。
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>
