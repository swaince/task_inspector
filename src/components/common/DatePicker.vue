<script setup lang="ts">
import { ref } from 'vue'
import { CalendarIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import WorkCalendarPicker from '@/components/common/WorkCalendarPicker.vue'
import { formatDateCN } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * 日期选择器。
 *
 * 项目约定：应用层不使用原生表单项（`input type="date"` 也一样）——
 * 原生日期控件的样式和交互跟着浏览器走，和产品其余部分的视觉、键盘行为都不一致。
 *
 * 弹层用工作日历的紧凑视图：选日期时能看到法定节假日、调休上班和周末，
 * 避免把检查日期选在明显不需要检查的日子里。
 */
const props = withDefaults(defineProps<{
  /** YYYY-MM-DD */
  modelValue: string
  placeholder?: string
  id?: string
  class?: string
}>(), {
  placeholder: '选择日期',
})

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const open = ref(false)

function onSelect(next: string) {
  if (!next)
    return
  emit('update:modelValue', next)
  open.value = false
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        :id="props.id"
        variant="outline"
        :class="cn(
          'w-full justify-start text-left text-xs font-normal',
          !modelValue && 'text-muted-foreground',
          props.class,
        )"
      >
        <CalendarIcon :size="14" class="mr-2 shrink-0 opacity-70" />
        <span class="tabular-nums">{{ modelValue ? formatDateCN(modelValue) : placeholder }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-auto p-2" align="start">
      <WorkCalendarPicker :model-value="modelValue" @select="onSelect" />
    </PopoverContent>
  </Popover>
</template>
