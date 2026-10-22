<script setup lang="ts">
import type { MemberProfile } from '@/core/domain/types'
import { computed, ref } from 'vue'
import { CheckIcon, ChevronsUpDownIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * 可搜索的人员选择器。
 *
 * 人一多，普通下拉就翻不动了。搜索值把姓名、团队、工号、日报 ID 和
 * GitLab 账号拼在一起，输入其中任意一项都能命中。
 */
const props = withDefaults(defineProps<{
  members: MemberProfile[]
  modelValue: string
  placeholder?: string
  class?: string
}>(), {
  placeholder: '选择人员',
})

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const open = ref(false)

const selected = computed(() => props.members.find(m => m.id === props.modelValue) ?? null)

function searchText(member: MemberProfile) {
  return [
    member.name,
    member.team,
    member.employeeNo,
    member.reportMemberId,
    ...(member.gitlabUsernames ?? []),
    ...(member.emails ?? []),
  ].filter(Boolean).join(' ')
}

function subtitle(member: MemberProfile) {
  return [
    member.team,
    member.employeeNo ? `工号 ${member.employeeNo}` : '',
    member.reportMemberId ? `日报 ${member.reportMemberId}` : '',
    member.gitlabUsernames?.[0] ? `@${member.gitlabUsernames[0]}` : '',
  ].filter(Boolean).join(' · ') || '未配置日报 ID / GitLab 身份'
}

function pick(member: MemberProfile) {
  emit('update:modelValue', member.id)
  open.value = false
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        role="combobox"
        :class="cn('w-full justify-between font-normal', props.class)"
      >
        <span class="truncate">
          {{ selected?.name ?? placeholder }}
          <span v-if="selected && !selected.followed" class="ml-1 text-xs text-muted-foreground">
            未关注
          </span>
        </span>
        <ChevronsUpDownIcon :size="14" class="ml-2 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>

    <PopoverContent
      class="w-[22rem] p-0"
      align="start"
    >
      <Command>
        <CommandInput placeholder="搜索姓名、团队、工号或 GitLab 账号…" />
        <CommandList class="max-h-72">
          <CommandEmpty>没有匹配的人员</CommandEmpty>
          <CommandGroup>
            <CommandItem
              v-for="m in members"
              :key="m.id"
              :value="searchText(m)"
              @select="pick(m)"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-xs">{{ m.name }}</span>
                  <span v-if="!m.followed" class="shrink-0 text-[11px] text-muted-foreground">未关注</span>
                </div>
                <div class="truncate text-[11px] text-muted-foreground">
                  {{ subtitle(m) }}
                </div>
              </div>
              <CheckIcon v-if="m.id === modelValue" :size="12" class="ml-2 shrink-0" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
