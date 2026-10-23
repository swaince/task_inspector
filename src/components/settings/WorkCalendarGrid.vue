<script setup lang="ts">
import type { CalendarDay } from '@/core/config/settings'
import { computed, ref } from 'vue'
import { ChevronLeftIcon, ChevronRightIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createCalendar, formatDateKey } from '@/core/calendar/workCalendar'
import { formatDateCN } from '@/lib/format'

/**
 * 工作日历的月视图。
 *
 * 只画和工作安排有关的信息：哪天放假、哪天调休上班、今天和选中的日期。
 * 农历/节气不在数据源里，不编造；日期下方只显示导入或手动填写的节假日名称。
 */
const props = defineProps<{
  imported: CalendarDay[]
  manual: CalendarDay[]
}>()

const emit = defineEmits<{
  (e: 'override', date: string, type: 'holiday' | 'workday'): void
  (e: 'remove', date: string): void
}>()

const today = formatDateKey(new Date())
const now = new Date()
const viewYear = ref(now.getFullYear())
const viewMonth = ref(now.getMonth())
const selected = ref<string>(today)
const holidayPick = ref('')

const calendar = computed(() => createCalendar({
  url: '',
  importedAt: null,
  imported: props.imported,
  manual: props.manual,
}))

const manualDates = computed(() => new Set(props.manual.map(d => d.date)))

interface Cell {
  date: string
  day: number
  inMonth: boolean
  isToday: boolean
  isSelected: boolean
  workday: boolean
  source: string
  name?: string
  holiday: boolean
  adjustedWorkday: boolean
  weekend: boolean
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const cells = computed<Cell[]>(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1)
  // 周一作为一周第一天：getDay() 周日是 0，这里转成 0=周一
  const offset = (first.getDay() + 6) % 7
  const start = new Date(viewYear.value, viewMonth.value, 1 - offset)
  // 只画这个月需要的周数：固定 6 行时，末尾会多出一整行全是下个月的日期
  const daysInMonth = new Date(viewYear.value, viewMonth.value + 1, 0).getDate()
  const weekCount = Math.ceil((offset + daysInMonth) / 7)

  return Array.from({ length: weekCount * 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const date = formatDateKey(d)
    const info = calendar.value.dayInfo(date)
    const holiday = !info.workday && (info.source === 'ics' || info.source === 'manual')
    const adjustedWorkday = info.workday
      && (info.source === 'ics' || info.source === 'manual')
      && (d.getDay() === 0 || d.getDay() === 6)

    return {
      date,
      day: d.getDate(),
      inMonth: d.getMonth() === viewMonth.value && d.getFullYear() === viewYear.value,
      isToday: date === today,
      isSelected: date === selected.value,
      workday: info.workday,
      source: info.source,
      name: info.name,
      holiday,
      adjustedWorkday,
      weekend: d.getDay() === 0 || d.getDay() === 6,
    }
  })
})

const selectedInfo = computed(() => calendar.value.dayInfo(selected.value))
const selectedIsManual = computed(() => manualDates.value.has(selected.value))

const holidayOptions = computed(() => {
  const groups: Array<{ label: string, value: string }> = []
  let current: { name: string, start: string, end: string } | null = null

  // 手动覆盖的放假也进「放假安排」，公司自己的假期同样能一键跳过去
  const byDate = new Map<string, CalendarDay>()
  for (const day of [...props.imported, ...props.manual]) {
    if (day.type === 'holiday')
      byDate.set(day.date, day)
  }

  for (const day of [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const name = day.name || '节假日'
    if (current && current.name === name) {
      current.end = day.date
      continue
    }
    if (current) {
      groups.push({
        label: `${current.name} ${formatDateCN(current.start)}~${formatDateCN(current.end)}`,
        value: current.start,
      })
    }
    current = { name, start: day.date, end: day.date }
  }
  if (current) {
    groups.push({
      label: `${current.name} ${formatDateCN(current.start)}~${formatDateCN(current.end)}`,
      value: current.start,
    })
  }
  return groups
})

function shiftMonth(delta: number) {
  const d = new Date(viewYear.value, viewMonth.value + delta, 1)
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
}

function jumpTo(date: string) {
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime()))
    return
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
  selected.value = date
}

/** 用「放假安排」跳转后清空选择，避免下拉框长期显示上一次的假期 */
function jumpFromHoliday(value: unknown) {
  const date = String(value ?? '')
  if (date)
    jumpTo(date)
  holidayPick.value = ''
}

function backToToday() {
  const d = new Date()
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
  selected.value = today
}

function pick(cell: Cell) {
  selected.value = cell.date
  if (!cell.inMonth)
    jumpTo(cell.date)
}
</script>

<template>
  <div class="overflow-hidden rounded-xl border bg-card shadow-sm">
    <!-- 头部：年月切换 / 放假安排 / 返回今天 -->
    <div class="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2.5">
      <div class="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" title="上一年" @click="viewYear--">
          <ChevronLeftIcon :size="14" />
        </Button>
        <span class="w-14 text-center text-sm font-semibold tabular-nums">{{ viewYear }}年</span>
        <Button variant="ghost" size="icon-sm" title="下一年" @click="viewYear++">
          <ChevronRightIcon :size="14" />
        </Button>
      </div>

      <span class="h-4 w-px bg-border" />

      <div class="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" title="上个月" @click="shiftMonth(-1)">
          <ChevronLeftIcon :size="14" />
        </Button>
        <span class="w-12 text-center text-sm font-semibold tabular-nums">{{ viewMonth + 1 }}月</span>
        <Button variant="ghost" size="icon-sm" title="下个月" @click="shiftMonth(1)">
          <ChevronRightIcon :size="14" />
        </Button>
      </div>

      <Select v-if="holidayOptions.length" :model-value="holidayPick" @update:model-value="jumpFromHoliday">
        <SelectTrigger class="h-8 w-40 text-xs">
          <SelectValue placeholder="放假安排" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="item in holidayOptions" :key="item.value" :value="item.value">
            {{ item.label }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Button variant="outline" class="ml-auto h-8" @click="backToToday">
        返回今天
      </Button>
    </div>

    <!-- 星期 -->
    <div class="grid grid-cols-7 gap-1 px-2 pt-2">
      <div
        v-for="(day, i) in WEEKDAYS"
        :key="day"
        class="py-1.5 text-center text-[11px] font-medium"
        :class="i >= 5 ? 'text-red-500/80' : 'text-muted-foreground'"
      >
        {{ day }}
      </div>
    </div>

    <!-- 42 个日期格 -->
    <div class="grid grid-cols-7 gap-1 px-2 pb-2">
      <button
        v-for="cell in cells"
        :key="cell.date"
        type="button"
        class="relative flex min-h-[5.4rem] flex-col items-center rounded-lg px-1 pt-2.5 pb-1.5 text-center transition-colors hover:bg-accent/50"
        :class="[
          !cell.inMonth && 'bg-muted-foreground/15',
          cell.inMonth && cell.holiday && 'bg-red-500/[0.07]',
          cell.inMonth && !cell.holiday && !cell.adjustedWorkday && cell.weekend && 'bg-muted-foreground/8',
          cell.inMonth && cell.adjustedWorkday && 'bg-sky-500/[0.07]',
          cell.inMonth && cell.isToday && 'ring-2 ring-inset ring-red-500/55',
          cell.inMonth && cell.isSelected && !cell.isToday && 'ring-2 ring-inset ring-primary/45',
        ]"
        :title="`${cell.date}${cell.name ? ` · ${cell.name}` : ''}`"
        @click="pick(cell)"
      >
        <span
          v-if="cell.inMonth && cell.holiday"
          class="absolute top-1.5 right-1.5 rounded bg-red-500/10 px-1 text-[10px] leading-4 font-medium text-red-600/90 dark:bg-red-500/15 dark:text-red-300"
        >休</span>
        <span
          v-else-if="cell.inMonth && cell.adjustedWorkday"
          class="absolute top-1.5 right-1.5 rounded bg-sky-500/15 px-1 text-[10px] leading-4 font-medium text-sky-700 dark:text-sky-300"
        >班</span>

        <span
          class="flex size-9 items-center justify-center rounded-full text-[1.35rem] leading-none font-medium tabular-nums"
          :class="[
            !cell.inMonth && 'text-muted-foreground/50',            cell.inMonth && cell.isToday && 'font-semibold text-red-600 dark:text-red-400',
            cell.inMonth && !cell.isToday && cell.adjustedWorkday && 'text-sky-700 dark:text-sky-300',
            cell.inMonth && !cell.isToday && !cell.adjustedWorkday && (cell.holiday || cell.weekend) && 'text-red-600 dark:text-red-400',
          ]"
        >
          {{ cell.day }}
        </span>

        <span
          v-if="cell.inMonth && cell.holiday && cell.name"
          class="mt-1 w-full truncate text-[10px] leading-tight text-red-500/80 dark:text-red-300/70"
        >
          {{ cell.name }}
        </span>
      </button>
    </div>

    <!-- 选中日期 -->
    <div class="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-3 py-2.5 text-xs">
      <span class="rounded-md bg-background px-1.5 py-0.5 font-mono tabular-nums ring-1 ring-border">
        {{ selected }}
      </span>
      <span class="inline-flex items-center gap-1.5 text-muted-foreground">
        <span
          class="size-1.5 rounded-full"
          :style="{ backgroundColor: selectedInfo.workday ? 'var(--verdict-matched)' : 'var(--verdict-partial)' }"
        />
        {{ selectedInfo.workday ? '工作日' : '休息日' }}
        <template v-if="selectedInfo.name"> · {{ selectedInfo.name }}</template>
        <template v-if="selectedInfo.source === 'manual'">（手动覆盖）</template>
      </span>

      <div class="ml-auto flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          :disabled="selectedInfo.source === 'manual' && !selectedInfo.workday"
          @click="emit('override', selected, 'holiday')"
        >
          设为放假
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="selectedInfo.source === 'manual' && selectedInfo.workday"
          @click="emit('override', selected, 'workday')"
        >
          设为上班
        </Button>
        <Button
          v-if="selectedIsManual"
          variant="ghost"
          size="sm"
          @click="emit('remove', selected)"
        >
          删除覆盖
        </Button>
      </div>
    </div>
  </div>
</template>
