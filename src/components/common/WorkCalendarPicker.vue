<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useWorkCalendar } from '@/core/calendar/useWorkCalendar'
import { formatDateKey, parseDateKey } from '@/core/calendar/workCalendar'

/**
 * 日期选择器里的紧凑版工作日历。
 *
 * 和设置页的月视图共用同一套判断（法定节假日、调休上班、周末），
 * 只是格子更小、去掉了覆盖编辑等操作，只负责选日期。
 */
const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  (e: 'select', value: string): void
}>()

const today = formatDateKey(new Date())
const initial = parseDateKey(props.modelValue) ?? new Date()
const viewYear = ref(initial.getFullYear())
const viewMonth = ref(initial.getMonth())
const hovered = ref(props.modelValue || today)

watch(() => props.modelValue, (value) => {
  const date = parseDateKey(value)
  if (!date)
    return
  viewYear.value = date.getFullYear()
  viewMonth.value = date.getMonth()
  hovered.value = value
})

const { dayInfo } = useWorkCalendar()

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

interface Cell {
  date: string
  day: number
  inMonth: boolean
  holiday: boolean
  adjusted: boolean
  weekend: boolean
  isToday: boolean
  isSelected: boolean
}

const cells = computed<Cell[]>(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1)
  const offset = (first.getDay() + 6) % 7
  const daysInMonth = new Date(viewYear.value, viewMonth.value + 1, 0).getDate()
  const weekCount = Math.ceil((offset + daysInMonth) / 7)
  const start = new Date(viewYear.value, viewMonth.value, 1 - offset)

  return Array.from({ length: weekCount * 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const date = formatDateKey(d)
    const info = dayInfo(date)
    const holiday = !info.workday && (info.source === 'ics' || info.source === 'manual')
    const weekend = d.getDay() === 0 || d.getDay() === 6
    const adjusted = info.workday
      && (info.source === 'ics' || info.source === 'manual')
      && weekend

    return {
      date,
      day: d.getDate(),
      inMonth: d.getMonth() === viewMonth.value && d.getFullYear() === viewYear.value,
      holiday,
      adjusted,
      weekend,
      isToday: date === today,
      isSelected: date === props.modelValue,
    }
  })
})

const hoveredInfo = computed(() => dayInfo(hovered.value))
const hoveredText = computed(() => {
  const info = hoveredInfo.value
  const base = info.workday ? '工作日' : '休息日'
  return `${hovered.value.slice(5)} · ${base}${info.name ? ` · ${info.name}` : ''}`
})

function shiftMonth(delta: number) {
  const d = new Date(viewYear.value, viewMonth.value + delta, 1)
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
}

function shiftYear(delta: number) {
  viewYear.value += delta
}

function goToday() {
  const d = new Date()
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
  hovered.value = today
  emit('select', today)
}

function pick(cell: Cell) {
  emit('select', cell.date)
}
</script>

<template>
  <div class="w-[18.5rem]">
    <div class="flex items-center gap-0.5">
      <Button variant="ghost" size="icon-sm" title="上一年" @click="shiftYear(-1)">
        <ChevronsLeftIcon :size="14" />
      </Button>
      <Button variant="ghost" size="icon-sm" title="上个月" @click="shiftMonth(-1)">
        <ChevronLeftIcon :size="14" />
      </Button>
      <span class="flex-1 text-center text-sm font-medium tabular-nums">
        {{ viewYear }}年{{ viewMonth + 1 }}月
      </span>
      <Button variant="ghost" size="icon-sm" title="下个月" @click="shiftMonth(1)">
        <ChevronRightIcon :size="14" />
      </Button>
      <Button variant="ghost" size="icon-sm" title="下一年" @click="shiftYear(1)">
        <ChevronsRightIcon :size="14" />
      </Button>
    </div>

    <div class="mt-1 grid grid-cols-7 gap-0.5">
      <span
        v-for="(day, i) in WEEKDAYS"
        :key="day"
        class="py-1 text-center text-[11px]"
        :class="i >= 5 ? 'text-red-500/80' : 'text-muted-foreground'"
      >
        {{ day }}
      </span>
    </div>

    <div class="grid grid-cols-7 gap-0.5">
      <button
        v-for="cell in cells"
        :key="cell.date"
        type="button"
        class="relative flex h-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors"
        :class="[
          !cell.inMonth && 'text-muted-foreground/40',
          cell.inMonth && cell.holiday && 'bg-red-500/10 text-red-600 dark:text-red-400',
          cell.inMonth && cell.adjusted && 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
          cell.inMonth && !cell.holiday && !cell.adjusted && cell.weekend && 'text-red-600 dark:text-red-400',
          cell.inMonth && cell.isToday && !cell.isSelected && 'ring-1 ring-inset ring-red-500/50',
          cell.isSelected && 'ring-2 ring-inset ring-primary font-semibold',
          !cell.isSelected && 'hover:bg-accent/60',
        ]"
        :title="`${cell.date}${dayInfo(cell.date).name ? ` · ${dayInfo(cell.date).name}` : ''}`"
        @mouseenter="hovered = cell.date"
        @click="pick(cell)"
      >
        {{ cell.day }}
        <span
          v-if="cell.inMonth && cell.adjusted"
          class="absolute right-1 top-0.5 text-[8px] leading-none text-sky-600 dark:text-sky-300"
        >班</span>
      </button>
    </div>

    <div class="mt-2 flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground">
      <span class="truncate">{{ hoveredText }}</span>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="goToday">
        今天
      </Button>
    </div>
  </div>
</template>
