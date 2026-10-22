<script setup lang="ts">
import type { Project, ProjectLink } from '@/core/domain/types'
import { computed, ref, watch } from 'vue'
import { AlertTriangleIcon, Loader2Icon, Trash2Icon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { GitLabClient } from '@/core/adapters/gitlab'
import { resolveProjectLinks } from '@/core/adapters/projectLinks'
import { useSettingsStore } from '@/core/store/settings'

/**
 * 项目编辑表单。
 *
 * 名称/编码/别名是「匹配键」——日报里出现这些值就会被认作这个项目；
 * 下面是「GitLab 侧」——同步时会自动写入，也可以手填（还没同步时）。
 */
const props = defineProps<{
  modelValue: Project
  /** 只读展示时用，比如从列表点进来查看 */
  readonly?: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: Project): void }>()

const draft = ref<Project>({ ...props.modelValue })

/**
 * 父组件通过 v-model 回显的正是我们刚上报的那份对象时，不要拿它重建草稿。
 *
 * 否则「props 变 → 重建 draft → 深度 watch 再上报」会互相触发，Vue 会抛
 * Maximum recursive updates exceeded，表单里的交互（比如下拉框选中）全部失效。
 * 只有上层换了一个项目才需要重置草稿。
 */
let lastEmitted: Project | null = null
watch(() => props.modelValue, (v) => {
  if (v === lastEmitted)
    return
  draft.value = { ...v }
})

/** 别名在输入框里按行编辑，空行忽略 */
const aliasText = computed({
  get: () => draft.value.aliases.join('\n'),
  set: (v: string) => {
    draft.value.aliases = v.split('\n').map(s => s.trim()).filter(Boolean)
  },
})

const emailText = ref('')

function patch(part: Partial<Project>) {
  draft.value = { ...draft.value, ...part }
}

// 任何字段改动都往上抛，父组件负责持久化；单一路径上报，避免和上面的回显互相触发
watch(draft, (v) => {
  lastEmitted = v
  emit('update:modelValue', v)
}, { deep: true })
void emailText

/* ------------------------------------------------------------------ *
 * GitLab 关联
 * ------------------------------------------------------------------ */

const settingsStore = useSettingsStore()
const resolving = ref(false)
const failures = ref<string[]>([])

const syncLabel = computed(() => ({
  synced: '已解析',
  missing: 'GitLab 上已找不到',
  error: '解析失败',
  unsynced: '未解析',
}[draft.value.syncStatus]))

const originLabel = computed(() => ({
  log: '来自日志中心',
  synced: '早期从 GitLab 同步生成',
  manual: '手工创建',
}[draft.value.origin] ?? '手工创建'))

function addLink() {
  patch({ links: [...draft.value.links, { kind: 'repo', path: '' }] })
}

function removeLink(index: number) {
  patch({ links: draft.value.links.filter((_, i) => i !== index) })
}

function updateLink(index: number, part: Partial<ProjectLink>) {
  patch({ links: draft.value.links.map((link, i) => (i === index ? { ...link, ...part } : link)) })
}

/**
 * 解析关联链接 → 具体仓库。
 *
 * 组会扫描子组，所以一次可能展开出很多仓库。结果存进 draft.repos，
 * 保存后检查时直接用，不必每次再展开。
 */
async function resolve() {
  const settings = settingsStore.settings
  if (!settings.gitlab.baseUrl || !settings.gitlab.token) {
    failures.value = ['请先在「设置 → GitLab」里填好实例地址与 Token']
    return
  }

  resolving.value = true
  failures.value = []
  try {
    const result = await resolveProjectLinks(
      new GitLabClient(settings.gitlab),
      draft.value.links,
      { perPage: settings.gitlab.perPage, maxProjects: settings.gitlab.maxProjects },
    )
    failures.value = result.failures
    patch({
      repos: result.repos,
      syncStatus: result.failures.length ? 'error' : 'synced',
      syncError: result.failures.length ? result.failures[0] : undefined,
      syncedAt: new Date().toISOString(),
    })
  }
  finally {
    resolving.value = false
  }
}
</script>

<template>
  <div class="space-y-5">
    <section class="space-y-3">
      <div>
        <h4 class="text-sm font-medium">匹配键</h4>
        <p class="text-[11px] text-muted-foreground">
          日报里出现下面任意一个值，就会被认作这个项目。这是检查能否对上的关键。
        </p>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label class="text-xs">项目名称 <span class="text-destructive">*</span></Label>
          <Input
            :model-value="draft.name"
            placeholder="统一支付平台"
            @update:model-value="v => patch({ name: String(v) })"
          />
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">项目编码</Label>
          <Input
            :model-value="draft.code ?? ''"
            placeholder="PAY-001"
            class="font-mono"
            @update:model-value="v => patch({ code: String(v) || undefined })"
          />
          <p class="text-[11px] text-muted-foreground">
            填了的话优先按编码匹配，比名称精确
          </p>
        </div>
      </div>

      <div class="space-y-1.5">
        <Label class="text-xs">别名（每行一个）</Label>
        <Textarea
          v-model="aliasText"
          rows="2"
          placeholder="支付平台&#10;payment"
          @update:model-value="patch({ aliases: draft.aliases })"
        />
        <p class="text-[11px] text-muted-foreground">
          日报里同一个项目的不同叫法，避免每换一种写法就要新建一个项目
        </p>
      </div>

      <div class="space-y-1.5">
        <Label class="text-xs">匹配方式</Label>
        <Select
          :model-value="draft.matchMode"
          @update:model-value="v => patch({ matchMode: v as Project['matchMode'] })"
        >
          <SelectTrigger class="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="exact">完全相同</SelectItem>
            <SelectItem value="contains">包含</SelectItem>
            <SelectItem value="regex">正则</SelectItem>
          </SelectContent>
        </Select>
        <p class="text-[11px] text-muted-foreground">
          「包含」会双向匹配，适合日报里项目名前后带额外文字的情况；正则可以写复杂规则，
          写错时不会让检查失败，只是这个项目匹配不上
        </p>
      </div>

      <div class="space-y-1.5">
        <Label class="text-xs">开发模式</Label>
        <Select
          :model-value="draft.devMode ?? 'manual'"
          @update:model-value="v => patch({ devMode: v as Project['devMode'] })"
        >
          <SelectTrigger class="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">人工开发</SelectItem>
            <SelectItem value="ai-assisted">AI 辅助</SelectItem>
            <SelectItem value="ai-driven">AI 开发为主</SelectItem>
          </SelectContent>
        </Select>
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          只用于「有效工时」的估算：AI 开发的项目一天几千行是常态，代码量只做很小的修正。
          提交数、改动量、覆盖率这些事实指标不受影响。
        </p>
      </div>

      <div class="space-y-1.5">
        <Label class="text-xs">简介</Label>
        <Textarea
          :model-value="draft.description ?? ''"
          rows="2"
          placeholder="支付网关，对接各银行通道"
          @update:model-value="v => patch({ description: String(v) || undefined })"
        />
      </div>

      <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
        <div>
          <div class="text-xs font-medium">参与检查</div>
          <div class="text-[11px] text-muted-foreground">
            停用后不会参与匹配，但保留配置便于以后再启用
          </div>
        </div>
        <Switch
          :model-value="draft.enabled"
          @update:model-value="v => patch({ enabled: !!v })"
        />
      </div>
    </section>

    <section class="space-y-3 border-t pt-4">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="text-sm font-medium">GitLab 关联</h4>
        <span
          class="rounded border px-1.5 py-0.5 text-[10px]"
          :class="{
            'border-emerald-500/40 text-emerald-700 dark:text-emerald-400': draft.syncStatus === 'synced',
            'border-destructive/40 text-destructive': draft.syncStatus === 'missing' || draft.syncStatus === 'error',
            'text-muted-foreground': draft.syncStatus === 'unsynced',
          }"
        >
          {{ syncLabel }}
        </span>
        <Button
          variant="outline"
          size="sm"
          class="ml-auto text-xs"
          :disabled="resolving || !draft.links.length"
          @click="resolve"
        >
          <Loader2Icon v-if="resolving" :size="12" class="mr-1 animate-spin" />
          解析关联仓库
        </Button>
      </div>

      <p class="text-[11px] leading-relaxed text-muted-foreground">
        一个业务项目可能落在一个仓库里，也可能散在多个仓库、甚至一整组仓库里。
        组会扫描该组下的全部子组。解析结果会缓存下来，检查时直接用。
      </p>

      <div v-for="(link, i) in draft.links" :key="i" class="flex items-center gap-1.5">
        <Select
          :model-value="link.kind"
          @update:model-value="v => updateLink(i, { kind: v as ProjectLink['kind'] })"
        >
          <SelectTrigger class="w-24 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="repo">仓库</SelectItem>
            <SelectItem value="group">组</SelectItem>
          </SelectContent>
        </Select>
        <Input
          :model-value="link.path"
          :placeholder="link.kind === 'group' ? 'rd-platform' : 'rd-platform/payment-gateway'"
          class="font-mono text-xs"
          @update:model-value="v => updateLink(i, { path: String(v) })"
        />
        <Button variant="ghost" size="sm" class="shrink-0" @click="removeLink(i)">
          <Trash2Icon :size="13" />
        </Button>
      </div>

      <Button variant="outline" size="sm" class="text-xs" @click="addLink">
        + 添加仓库或组
      </Button>

      <Alert v-if="failures.length" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          <div>{{ failures.length }} 条没能解析，检查时这部分提交会被漏掉：</div>
          <ul class="mt-1 space-y-0.5">
            <li v-for="f in failures" :key="f">{{ f }}</li>
          </ul>
        </AlertDescription>
      </Alert>

      <div v-if="draft.repos.length" class="rounded-md border">
        <div class="border-b bg-muted/30 px-2.5 py-1.5 text-[11px]">
          已解析出 {{ draft.repos.length }} 个仓库
        </div>
        <div class="max-h-44 overflow-y-auto p-2">
          <div
            v-for="repo in draft.repos"
            :key="repo.id"
            class="flex items-center gap-2 py-0.5 text-[11px]"
          >
            <span class="truncate font-mono">{{ repo.pathWithNamespace }}</span>
            <span class="ml-auto shrink-0 text-muted-foreground">
              {{ repo.linkKind === 'group' ? `组 ${repo.linkPath}` : '直接关联' }}
            </span>
          </div>
        </div>
      </div>
      <p v-else class="text-[11px] text-amber-600 dark:text-amber-500">
        还没有解析出任何仓库。检查时这个项目会被判成「无法核对」——
        加上关联后点「解析关联仓库」。
      </p>

      <p class="text-[11px] text-muted-foreground">
        {{ originLabel }}
        <template v-if="draft.syncedAt">，最后解析 {{ draft.syncedAt.slice(0, 16).replace('T', ' ') }}</template>
      </p>
    </section>
  </div>
</template>
