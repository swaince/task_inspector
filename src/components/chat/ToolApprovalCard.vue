<script setup lang="ts">
import type { ApprovalRequest } from '@/core/agent/types'
import { computed } from 'vue'
import {
  AlertTriangleIcon,
  FolderGit2Icon,
  ShieldAlertIcon,
  TerminalIcon,
  UserPlusIcon,
} from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * 对话内的工具确认卡片。
 *
 * 写操作（命令、成员、项目）都走这里。默认动作是拒绝：按钮顺序把「拒绝」放前面，
 * 不自动聚焦「允许」，回车不会执行。高风险只做标红提示，不替用户做决定。
 */
const props = defineProps<{
  approval: ApprovalRequest
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'approve'): void
  (e: 'deny'): void
}>()

const high = computed(() => props.approval.risk.level === 'high')

const icon = computed(() => {
  if (props.approval.kind === 'shell')
    return TerminalIcon
  if (props.approval.kind === 'member')
    return UserPlusIcon
  return FolderGit2Icon
})

const warning = computed(() => {
  if (props.approval.kind === 'shell') {
    return '命令以当前用户权限在本机执行，没有沙箱。工作目录只决定起始目录，命令仍可 cd 或访问绝对路径。'
  }
  return '允许后会直接写入本应用的本地数据库。这里只做字段补齐，不删除数据，也不会在 GitLab 侧创建组、仓库或用户。'
})

const approveLabel = computed(() => props.approval.kind === 'shell' ? '允许执行' : '允许修改')
</script>

<template>
  <div
    class="rounded-lg border p-3"
    :class="high
      ? 'border-red-500/50 bg-red-500/5'
      : 'border-amber-500/40 bg-amber-500/5'"
  >
    <div class="flex flex-wrap items-center gap-2">
      <component :is="icon" :size="14" :class="high ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-500'" />
      <span class="text-xs font-medium">{{ approval.title }}</span>
      <Badge v-if="high" variant="destructive" class="text-[10px]">
        <ShieldAlertIcon :size="10" class="mr-0.5" />
        高风险
      </Badge>
      <Badge v-else variant="outline" class="text-[10px]">需要确认</Badge>
      <Badge v-if="approval.readOnlyHint" variant="secondary" class="text-[10px]">
        看起来是只读命令
      </Badge>
    </div>

    <ul v-if="approval.summary.length" class="mt-2 space-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
      <li v-for="(line, index) in approval.summary" :key="index">
        {{ line }}
      </li>
    </ul>

    <pre
      v-if="approval.command"
      class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed"
    >{{ approval.command.text }}</pre>

    <dl v-if="approval.details?.length" class="mt-2 space-y-1 text-[11px]">
      <div v-for="item in approval.details" :key="item.label" class="flex gap-2">
        <dt class="w-16 shrink-0 text-muted-foreground">{{ item.label }}</dt>
        <dd
          class="min-w-0 break-words"
          :class="item.mono && 'font-mono break-all'"
        >
          {{ item.value }}
        </dd>
      </div>
    </dl>

    <div v-if="high && approval.risk.matches.length" class="mt-2 flex items-start gap-1.5 text-[11px] text-red-700 dark:text-red-400">
      <AlertTriangleIcon :size="12" class="mt-0.5 shrink-0" />
      <span>
        命中高风险模式：{{ approval.risk.matches.join('、') }}。这只是提示，不会自动拦截，请确认你理解命令的影响。
      </span>
    </div>

    <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">
      {{ warning }}
    </p>

    <div class="mt-3 flex items-center justify-end gap-2">
      <span class="mr-auto text-[10px] text-muted-foreground">
        也可以点输入框右侧的停止按钮取消整个回答
      </span>
      <Button variant="outline" size="sm" :disabled="busy" @click="emit('deny')">
        拒绝
      </Button>
      <Button
        :variant="high ? 'destructive' : 'default'"
        size="sm"
        :disabled="busy"
        @click="emit('approve')"
      >
        {{ approveLabel }}
      </Button>
    </div>
  </div>
</template>
