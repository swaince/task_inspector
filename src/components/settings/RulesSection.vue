<script setup lang="ts">
import { computed } from 'vue'
import { CalendarClockIcon, FilterIcon } from '@lucide/vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { commitWindow } from '@/core/engine/window'
import { useSettingsStore } from '@/core/store/settings'
import { todayKey } from '@/lib/format'

const settingsStore = useSettingsStore()
const rules = computed(() => settingsStore.settings.rules)

async function save() {
  await settingsStore.save()
}

const lines = (v: unknown) => String(v).split('\n').map(s => s.trim()).filter(Boolean)

/**
 * 把当前时间窗设置换算成具体时刻展示。
 * 「-4 到 +8」这种数字看久了会晕，直接显示成 10-15 20:00 ~ 10-16 08:00 最不容易配错。
 */
const windowPreview = computed(() => {
  try {
    return commitWindow(todayKey(), rules.value)
  }
  catch {
    return null
  }
})

const tzLabel = computed(() => {
  const m = rules.value.timezoneOffsetMinutes
  const sign = m >= 0 ? '+' : '-'
  const abs = Math.abs(m)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
})
</script>

<template>
  <Card class="gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="text-sm">采集规则</CardTitle>
      <CardDescription class="text-xs">
        决定「哪些提交、在哪个时间窗里算作某人某天的工作」。影响项目活动、人员活动和分析历史的统计口径。
      </CardDescription>
    </CardHeader>

    <CardContent class="space-y-4 px-4">
      <div class="space-y-2">
        <Label class="text-xs">提交归集时间窗</Label>
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="space-y-1">
            <Label for="r-start" class="text-[11px] text-muted-foreground">
              起始（相对当天 0 点的小时，可为负）
            </Label>
            <Input
              id="r-start"
              :model-value="rules.windowStartHour"
              type="number"
              min="-24"
              max="24"
              @update:model-value="v => { rules.windowStartHour = Number(v) || 0; save() }"
            />
          </div>
          <div class="space-y-1">
            <Label for="r-end" class="text-[11px] text-muted-foreground">
              结束（相对次日 0 点的小时）
            </Label>
            <Input
              id="r-end"
              :model-value="rules.windowEndHour"
              type="number"
              min="0"
              max="24"
              @update:model-value="v => { rules.windowEndHour = Number(v) || 0; save() }"
            />
          </div>
          <div class="space-y-1">
            <Label for="r-tz" class="text-[11px] text-muted-foreground">
              时区偏移（分钟）
            </Label>
            <Input
              id="r-tz"
              :model-value="rules.timezoneOffsetMinutes"
              type="number"
              step="30"
              @update:model-value="v => { rules.timezoneOffsetMinutes = Number(v) || 0; save() }"
            />
          </div>
        </div>

        <div
          v-if="windowPreview"
          class="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs"
        >
          <CalendarClockIcon :size="13" class="shrink-0 text-muted-foreground" />
          <span>以「{{ todayKey() }}」为例，归集范围是</span>
          <span class="font-medium tabular-nums">{{ windowPreview.label }}</span>
          <span class="text-muted-foreground">（{{ tzLabel }}）</span>
        </div>

        <p class="text-[11px] leading-relaxed text-muted-foreground">
          相邻两天的窗口会重叠。批量检查时同一个提交只会归给最早命中的那一天，
          所以「加班到凌晨」的提交算在开始那天，符合日报里「今天加班到几点」的写法。
        </p>
      </div>

      <Separator />

      <div class="space-y-3">
        <div class="flex items-center gap-2 text-xs font-medium">
          <FilterIcon :size="13" />
          忽略规则
        </div>

        <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
          <div>
            <div class="text-xs font-medium">忽略合并提交</div>
            <div class="text-[11px] text-muted-foreground">
              Merge 提交不代表实质工作，计入会把符合度拉高
            </div>
          </div>
          <Switch
            :model-value="rules.ignoreMergeCommits"
            @update:model-value="v => { rules.ignoreMergeCommits = !!v; save() }"
          />
        </div>

        <div class="space-y-1.5">
          <Label class="text-[11px] text-muted-foreground">
            提交信息正则（每行一条，命中即忽略）
          </Label>
          <Textarea
            :model-value="rules.ignoreCommitMessagePatterns.join('\n')"
            rows="3"
            class="font-mono text-xs"
            @update:model-value="v => { rules.ignoreCommitMessagePatterns = lines(v) }"
            @blur="save"
          />
        </div>

        <div class="space-y-1.5">
          <Label class="text-[11px] text-muted-foreground">
            文件路径 glob（所有变更文件都命中时忽略该提交）
          </Label>
          <Textarea
            :model-value="rules.ignorePaths.join('\n')"
            rows="3"
            class="font-mono text-xs"
            @update:model-value="v => { rules.ignorePaths = lines(v) }"
            @blur="save"
          />
        </div>
      </div>

      <Separator />

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <Label for="r-max-commits" class="text-[11px] text-muted-foreground">
            单仓库单日最多抓取的提交数
          </Label>
          <Input
            id="r-max-commits"
            :model-value="rules.maxCommitsPerProject"
            type="number"
            min="10"
            max="2000"
            @update:model-value="v => { rules.maxCommitsPerProject = Math.max(10, Number(v) || 200); save() }"
          />
        </div>

        <div class="space-y-1">
          <Label for="r-max-members" class="text-[11px] text-muted-foreground">
            单次检查最多覆盖的成员数
          </Label>
          <Input
            id="r-max-members"
            :model-value="rules.maxMembersPerRun"
            type="number"
            min="1"
            max="500"
            @update:model-value="v => { rules.maxMembersPerRun = Math.max(1, Number(v) || 50); save() }"
          />
        </div>
      </div>

      <div class="space-y-1 rounded-md border px-3 py-2.5">
        <Label for="r-report-window" class="text-xs">
          日报核对窗口前后偏移（工作日）
        </Label>
        <div class="flex items-center gap-2">
          <Input
            id="r-report-window"
            :model-value="rules.reportWindowOffsetWorkdays ?? 2"
            type="number"
            min="0"
            max="7"
            class="h-8 w-20 text-xs"
            @update:model-value="v => { rules.reportWindowOffsetWorkdays = Math.min(7, Math.max(0, Number(v) || 0)); save() }"
          />
          <span class="text-[11px] text-muted-foreground">天</span>
        </div>
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          0 表示只看日报当天；2 表示以日报日期为中心向前后各取最多 2 个工作日。
          窗口会跨过周末和节假日继续取工作日，例如周五会包含下周一、周二；
          但不会跨出日报所在的自然月，所以月底最后一天只有前一天、前两天和当天，共 3 天。
        </p>
      </div>

      <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
        <div>
          <div class="text-xs font-medium">抓取每个提交的文件变更</div>
          <div class="text-[11px] text-muted-foreground">
            判定准确度明显更高，代价是每个提交多一次 GitLab 请求。仓库活跃度高时可以关掉。
          </div>
        </div>
        <Switch
          :model-value="rules.fetchFileChanges"
          @update:model-value="v => { rules.fetchFileChanges = !!v; save() }"
        />
      </div>
    </CardContent>
  </Card>
</template>
