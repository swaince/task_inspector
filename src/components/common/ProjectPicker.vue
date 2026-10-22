<script setup lang="ts">
import type { Project } from '@/core/domain/types'
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
 * 可搜索的项目选择器。
 *
 * 项目多起来之后（几百个）下拉列表就没法用了，必须能搜。
 * 搜索匹配的是条目上渲染出来的整段文字——名称、编码、第一个仓库路径都在里面，
 * 所以搜「PAY-001」或「payment-gateway」也能命中。
 */
const props = withDefaults(defineProps<{
  projects: Project[]
  modelValue: string
  placeholder?: string
  class?: string
}>(), {
  placeholder: '选择项目',
})

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const open = ref(false)

const selected = computed(() => props.projects.find(p => p.id === props.modelValue) ?? null)

function pick(project: Project) {
  emit('update:modelValue', project.id)
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
        <span class="truncate">{{ selected?.name ?? placeholder }}</span>
        <ChevronsUpDownIcon :size="14" class="ml-2 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>

    <PopoverContent
      class="w-[min(28rem,var(--reka-popover-trigger-width,20rem))] p-0"
      align="start"
    >
      <Command>
        <CommandInput placeholder="搜索项目名称、编码或仓库路径…" />
        <CommandList class="max-h-72">
          <CommandEmpty>没有匹配的项目</CommandEmpty>
          <CommandGroup>
            <CommandItem
              v-for="p in projects"
              :key="p.id"
              :value="p.id"
              @select="pick(p)"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs">{{ p.name }}</div>
                <div class="truncate text-[11px] text-muted-foreground">
                  {{ [p.code, p.repos?.[0]?.pathWithNamespace].filter(Boolean).join(' · ') || '未关联仓库' }}
                </div>
              </div>
              <CheckIcon v-if="p.id === modelValue" :size="12" class="ml-2 shrink-0" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
