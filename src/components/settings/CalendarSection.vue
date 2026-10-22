<script setup lang="ts">
import { computed, ref } from 'vue'
import { CalendarDaysIcon, CloudDownloadIcon, Loader2Icon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import DatePicker from '@/components/common/DatePicker.vue'
import WorkCalendarGrid from '@/components/settings/WorkCalendarGrid.vue'
import { transport } from '@/core/bridge'
import { parseHolidayIcs } from '@/core/calendar/workCalendar'
import { useSettingsStore } from '@/core/store/settings'

const settingsStore = useSettingsStore()
const cfg = settingsStore.settings.workCalendar

const importing = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)

const manualDate = ref('')
const manualType = ref<'holiday' | 'workday'>('holiday')
const manualName = ref('')

const imported = computed(() =>
  [...cfg.imported].sort((a, b) => a.date.localeCompare(b.date)),
)
const manual = computed(() =>
  [...cfg.manual].sort((a, b) => a.date.localeCompare(b.date)),
)
const holidayCount = computed(() => cfg.imported.filter(d => d.type === 'holiday').length)
const workdayCount = computed(() => cfg.imported.filter(d => d.type === 'workday').length)
const importedAtText = computed(() =>
  cfg.importedAt ? new Date(cfg.importedAt).toLocaleString() : '尚未导入',
)

async function persist() {
  try {
    await settingsStore.save()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function importCalendar() {
  const url = cfg.url.trim()
  if (!url) {
    error.value = '先填一个 ICS 地址'
    return
  }
  importing.value = true
  message.value = null
  error.value = null
  try {
    const res = await transport().http({
      url,
      method: 'GET',
      headers: { accept: 'text/calendar' },
      timeoutMs: 30000,
      allowInsecureTls: false,
    })
    if (!res.ok)
      throw new Error(`日历地址返回 HTTP ${res.status}`)
    const days = parseHolidayIcs(res.body)
    if (!days.length)
      throw new Error('没有解析到任何节假日或调休安排，检查地址是否指向 ICS 文件')

    cfg.imported = days
    cfg.importedAt = new Date().toISOString()
    await persist()
    message.value = `已导入 ${days.length} 天：节假日 ${holidayCount.value} 天，调休上班 ${workdayCount.value} 天`
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    importing.value = false
  }
}

async function addManual() {
  const date = manualDate.value.trim()
  if (!date) {
    error.value = '先选一个日期'
    return
  }
  error.value = null
  message.value = null
  cfg.manual = [
    ...cfg.manual.filter(d => d.date !== date),
    {
      date,
      type: manualType.value,
      name: manualName.value.trim() || (manualType.value === 'holiday' ? '公司放假' : '公司上班'),
    },
  ]
  manualName.value = ''
  manualDate.value = ''
  await persist()
}

async function removeManual(date: string) {
  cfg.manual = cfg.manual.filter(d => d.date !== date)
  await persist()
}

async function onOverride(date: string, type: 'holiday' | 'workday') {
  cfg.manual = [
    ...cfg.manual.filter(d => d.date !== date),
    {
      date,
      type,
      name: type === 'holiday' ? '公司放假' : '公司上班',
    },
  ]
  await persist()
}

function clearImported() {
  cfg.imported = []
  cfg.importedAt = null
  void persist()
}
</script>

<template>
  <Card class="gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="flex items-center gap-2 text-sm">
        <CalendarDaysIcon :size="14" />
        工作日历
      </CardTitle>
      <CardDescription class="text-xs">
        检查、项目活动和人员活动都会参考这里：节假日不计入「无记录」，调休上班日按工作日计算。
        未覆盖的日期默认周一到周五上班、周六周日休息。
      </CardDescription>
    </CardHeader>

    <CardContent class="space-y-4 px-4">
      <Alert v-if="error" variant="destructive">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <Alert v-else-if="message">
        <AlertDescription>{{ message }}</AlertDescription>
      </Alert>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div class="space-y-1.5">
          <Label for="calendar-url" class="text-xs">ICS 地址</Label>
          <Input
            id="calendar-url"
            v-model="cfg.url"
            class="font-mono text-xs"
            placeholder="https://…/china-holidays-2026.ics"
            @blur="persist"
          />
          <p class="text-[11px] text-muted-foreground">
            只支持在线 ICS。导入会整份替换「导入的日期」，手动覆盖不受影响。
          </p>
        </div>

        <div class="flex items-end gap-2">
          <Button :disabled="importing" @click="importCalendar">
            <Loader2Icon v-if="importing" :size="13" class="mr-1.5 animate-spin" />
            <CloudDownloadIcon v-else :size="13" class="mr-1.5" />
            {{ importing ? '导入中…' : '导入 / 更新' }}
          </Button>
          <Button
            v-if="imported.length"
            variant="ghost"
            :disabled="importing"
            @click="clearImported"
          >
            清空导入
          </Button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>上次导入：<span class="text-foreground">{{ importedAtText }}</span></span>
        <span>节假日 <span class="tabular-nums text-foreground">{{ holidayCount }}</span> 天</span>
        <span>调休上班 <span class="tabular-nums text-foreground">{{ workdayCount }}</span> 天</span>
      </div>

      <WorkCalendarGrid
        :imported="cfg.imported"
        :manual="cfg.manual"
        @override="onOverride"
        @remove="removeManual"
      />

      <details v-if="imported.length" class="rounded-md border">
        <summary class="cursor-pointer px-3 py-2 text-[11px] text-muted-foreground">
          导入的日期明细（{{ imported.length }} 天）
        </summary>
        <div class="max-h-56 overflow-y-auto border-t">
          <div class="grid grid-cols-[7rem_5rem_minmax(0,1fr)] gap-x-3 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>日期</span>
            <span>类型</span>
            <span>名称</span>
          </div>
          <div
            v-for="day in imported"
            :key="`${day.date}-${day.type}`"
            class="grid grid-cols-[7rem_5rem_minmax(0,1fr)] items-center gap-x-3 border-b px-3 py-1.5 text-[11px] last:border-b-0"
          >
            <span class="font-mono tabular-nums">{{ day.date }}</span>
            <Badge v-if="day.type === 'holiday'" variant="outline" class="w-fit text-[10px]">放假</Badge>
            <Badge v-else variant="secondary" class="w-fit text-[10px]">上班</Badge>
            <span class="truncate text-muted-foreground" :title="day.name">{{ day.name }}</span>
          </div>
        </div>
      </details>
      <p v-else class="text-[11px] text-muted-foreground">
        还没有导入日历。未导入时按「周一到周五上班」的默认规则计算，仍然可以点日期手动覆盖。
      </p>
    </CardContent>
  </Card>

  <Card class="mt-4 gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="text-sm">手动覆盖</CardTitle>
      <CardDescription class="text-xs">
        公司自己的安排优先于在线日历。比如某天全公司放假、或某个周末临时上班，在这里加一条即可。
      </CardDescription>
    </CardHeader>

    <CardContent class="space-y-3 px-4">
      <div class="grid gap-3 sm:grid-cols-[10rem_8rem_minmax(0,1fr)_auto] sm:items-end">
        <div class="space-y-1.5">
          <Label class="text-xs">日期</Label>
          <DatePicker v-model="manualDate" class="w-full" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">类型</Label>
          <Select v-model="manualType">
            <SelectTrigger class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="holiday">放假</SelectItem>
              <SelectItem value="workday">上班</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">名称（可选）</Label>
          <Input v-model="manualName" placeholder="例如：公司年会" />
        </div>
        <Button variant="outline" @click="addManual">
          <PlusIcon :size="13" class="mr-1.5" />
          添加
        </Button>
      </div>

      <div v-if="manual.length" class="divide-y rounded-md border">
        <div
          v-for="day in manual"
          :key="day.date"
          class="flex items-center gap-3 px-3 py-2 text-xs"
        >
          <span class="w-24 shrink-0 font-mono tabular-nums">{{ day.date }}</span>
          <Badge v-if="day.type === 'holiday'" variant="outline" class="w-fit text-[10px]">放假</Badge>
          <Badge v-else variant="secondary" class="w-fit text-[10px]">上班</Badge>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ day.name }}</span>
          <Button variant="ghost" size="sm" class="px-1.5" title="删除这条覆盖" @click="removeManual(day.date)">
            <Trash2Icon :size="13" />
          </Button>
        </div>
      </div>
      <p v-else class="text-[11px] text-muted-foreground">没有手动覆盖。</p>
    </CardContent>
  </Card>
</template>
