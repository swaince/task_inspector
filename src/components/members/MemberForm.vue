<script setup lang="ts">
import type { MemberProfile } from '@/core/domain/types'
import { computed, ref, watch } from 'vue'
import { AlertTriangleIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

/**
 * 人员编辑表单。
 *
 * 上半部分是「日报侧」的标识，下半部分是「GitLab 侧」的身份。
 * 两侧都填上，检查时才能准确地把提交归到人头上。
 */
const props = defineProps<{
  modelValue: MemberProfile
  /** 同名的其它成员，用于提示邮箱冲突 */
  others: MemberProfile[]
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: MemberProfile): void }>()

const draft = ref<MemberProfile>({ ...props.modelValue })

/**
 * 父组件回显的正是我们刚上报的那份对象时不要重建草稿。
 *
 * 否则「props 变 → 重建 draft → 深度 watch 再上报」会互相触发，
 * Vue 会抛 Maximum recursive updates exceeded，弹框里的输入和按钮全部失灵。
 */
let lastEmitted: MemberProfile | null = null
watch(() => props.modelValue, (v) => {
  if (v === lastEmitted)
    return
  draft.value = { ...v }
})
watch(draft, (v) => {
  lastEmitted = v
  emit('update:modelValue', v)
}, { deep: true })

const emailText = computed({
  get: () => draft.value.emails.join('\n'),
  set: (v: string) => {
    draft.value = {
      ...draft.value,
      emails: v.split('\n').map(s => s.trim()).filter(Boolean),
    }
  },
})

/**
 * Git 用户名列表，每行一个。
 *
 * 一个人经常用多个身份提交：换过账号、本机 git config 没配、用中文名。
 * 只填一个会漏提交，而漏提交会被判成「日报写了但代码没有」。
 */
const usernameText = computed({
  get: () => (draft.value.gitlabUsernames ?? []).join('\n'),
  set: (v: string) => {
    draft.value = {
      ...draft.value,
      gitlabUsernames: v.split('\n').map(s => s.trim()).filter(Boolean),
    }
  },
})

/**
 * 邮箱被别人占用。
 *
 * 两个人声明同一个邮箱时，「这条提交是谁的」就判断不了，双方都会把它算成自己的，
 * 结论直接失真。所以这里在编辑时就要拦住。
 */
const conflicts = computed(() => {
  const mine = new Set((draft.value.emails ?? []).map(e => e.trim().toLowerCase()))
  const myNames = new Set((draft.value.gitlabUsernames ?? []).map(u => u.trim().toLowerCase()))
  const hit: string[] = []
  for (const other of props.others) {
    if (other.id === draft.value.id || !other.enabled)
      continue
    for (const email of other.emails) {
      if (mine.has(email.trim().toLowerCase()))
        hit.push(`邮箱 ${email}（已被 ${other.name} 使用）`)
    }
    for (const username of other.gitlabUsernames ?? []) {
      if (myNames.has(username.trim().toLowerCase()))
        hit.push(`用户名 ${username}（已被 ${other.name} 使用）`)
    }
  }
  return [...new Set(hit)]
})

function patch(part: Partial<MemberProfile>) {
  draft.value = { ...draft.value, ...part }
}
</script>

<template>
  <div class="space-y-5">
    <section class="space-y-3">
      <div>
        <h4 class="text-sm font-medium">基本信息</h4>
        <p class="text-[11px] text-muted-foreground">
          「日报成员 ID」是与日报对上的关键；只用姓名匹配的话，重名就会认错人。
        </p>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label class="text-xs">姓名 <span class="text-destructive">*</span></Label>
          <Input
            :model-value="draft.name"
            placeholder="张伟"
            @update:model-value="v => patch({ name: String(v) })"
          />
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">日报成员 ID</Label>
          <Input
            :model-value="draft.reportMemberId ?? ''"
            placeholder="u1001"
            class="font-mono"
            @update:model-value="v => patch({ reportMemberId: String(v) || undefined })"
          />
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">工号</Label>
          <Input
            :model-value="draft.employeeNo ?? ''"
            class="font-mono"
            @update:model-value="v => patch({ employeeNo: String(v) || undefined })"
          />
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">岗位</Label>
          <Input
            :model-value="draft.role ?? ''"
            placeholder="后端工程师"
            @update:model-value="v => patch({ role: String(v) || undefined })"
          />
        </div>

        <div class="space-y-1.5 sm:col-span-2">
          <Label class="text-xs">团队 / 部门</Label>
          <Input
            :model-value="draft.team ?? ''"
            placeholder="支付研发组 / 研发中心-平台部"
            @update:model-value="v => patch({ team: String(v) || undefined })"
          />
        </div>
      </div>
    </section>

    <section class="space-y-3 border-t pt-4">
      <div>
        <h4 class="text-sm font-medium">GitLab 身份</h4>
        <p class="text-[11px] text-muted-foreground">
          用于把提交过滤到本人。邮箱是最可靠的依据（用户名可能和 GitLab 上的不一致）。
        </p>
      </div>

      <div class="space-y-1.5">
        <Label class="text-xs">Git 用户名（每行一个，用于匹配提交作者）</Label>
        <Textarea
          v-model="usernameText"
          rows="3"
          class="font-mono text-xs"
          placeholder="zhangwei"
        />
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          换过账号、本机 git config 没配、用中文名提交——这些在 Git 眼里都是别人，
          但对同一个人来说是同一件事，全部填进来才不会漏提交。
        </p>
      </div>

      <div class="space-y-1.5 sm:w-52">
        <Label class="text-xs">GitLab 用户 ID</Label>
        <Input
          :model-value="draft.gitlabUserId ?? ''"
          type="number"
          class="font-mono"
          @update:model-value="v => patch({ gitlabUserId: v === '' ? undefined : Number(v) })"
        />
      </div>

      <div class="space-y-1.5">
        <Label class="text-xs">邮箱（每行一个，用于匹配提交作者）</Label>
        <Textarea v-model="emailText" rows="3" class="font-mono text-xs" placeholder="zhangwei@corp.com" />
      </div>

      <Alert v-if="conflicts.length" variant="destructive">
        <AlertTriangleIcon :size="14" />
        <AlertDescription>
          <div>以下邮箱已被其他成员占用：</div>
          <ul class="mt-1 space-y-0.5">
            <li v-for="c in conflicts" :key="c">{{ c }}</li>
          </ul>
          <div class="mt-1">
            同一个人被算成两个身份时，检查结论不可信，请先改掉。
          </div>
        </AlertDescription>
      </Alert>

      <Alert v-else-if="!draft.gitlabUsernames?.length && !draft.emails.length">
        <AlertDescription>
          还没填任何 Git 身份。这种情况下无法按作者过滤提交，
          会把同名或同前缀的提交也算进来，建议至少填一个邮箱。
        </AlertDescription>
      </Alert>
    </section>

    <section class="space-y-3 border-t pt-4">
      <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
        <div>
          <div class="text-xs font-medium">参与批量检查</div>
          <div class="text-[11px] text-muted-foreground">
            离职或长期外派的人可以停用，配置会保留
          </div>
        </div>
        <Switch
          :model-value="draft.enabled"
          @update:model-value="v => patch({ enabled: !!v })"
        />
      </div>

      <p v-if="draft.createdAt" class="text-[11px] text-muted-foreground">
        最后更新 {{ draft.updatedAt?.slice(0, 16).replace('T', ' ') }}
      </p>
    </section>
  </div>
</template>
