<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeftIcon, RotateCwIcon, Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import InspectionReport from '@/components/inspection/InspectionReport.vue'
import { useHistoryStore } from '@/core/store/history'
import { useReportStore } from '@/core/store/reports'
import { useRunnerStore } from '@/core/store/runner'
import { useSettingsStore } from '@/core/store/settings'

const route = useRoute()
const router = useRouter()
const history = useHistoryStore()
const reportStore = useReportStore()
const runner = useRunnerStore()
const settingsStore = useSettingsStore()

const rerunning = ref(false)
const missing = ref(false)

const date = computed(() => String(route.params.date))
const memberId = computed(() => String(route.params.memberId))

const result = computed(() => history.findByKey(date.value, memberId.value))

onMounted(async () => {
  await history.load()
  missing.value = !result.value
})

const report = computed(() =>
  reportStore.findMember(date.value, memberId.value),
)

/** 用同样的参数重跑一次，覆盖这条历史。 */
async function rerun() {
  if (!result.value)
    return
  rerunning.value = true
  try {
    await runner.ensureCatalog()
    const mapping = settingsStore.settings.memberMappings
      .find(m => m.reportMemberId === result.value!.memberId)
    const target = {
      id: result.value.memberId,
      name: result.value.memberName,
      gitlabUsernames: mapping?.gitlabUsername ? [mapping.gitlabUsername] : [],
      emails: mapping?.emails ?? [],
    }
    await runner.run(date.value, [{ member: target, report: report.value }])
  }
  finally {
    rerunning.value = false
  }
}

async function remove() {
  await history.remove(date.value, memberId.value)
  await router.push({ name: 'history' })
}
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <div class="flex items-center gap-3">
        <Button variant="ghost" size="sm" @click="router.back()">
          <ArrowLeftIcon :size="14" class="mr-1.5" />
          返回
        </Button>

        <template v-if="result">
          <div class="text-sm">
            <span class="font-medium">{{ result.memberName }}</span>
            <span class="ml-2 text-muted-foreground">{{ result.date }}</span>
          </div>

          <div class="ml-auto flex gap-1.5">
            <Button variant="outline" size="sm" :disabled="rerunning || runner.running" @click="rerun">
              <RotateCwIcon :size="13" class="mr-1.5" :class="rerunning && 'animate-spin'" />
              重新检查
            </Button>
            <Button variant="ghost" size="sm" @click="remove">
              <Trash2Icon :size="13" class="mr-1.5" />
              删除
            </Button>
          </div>
        </template>
      </div>

      <div v-if="!result && missing" class="rounded-lg border border-dashed p-12 text-center">
        <p class="text-sm text-muted-foreground">找不到这条检查记录，可能已被删除。</p>
      </div>

      <Skeleton v-else-if="!result" class="h-64 w-full" />

      <InspectionReport v-else :result="result" />
    </div>
  </div>
</template>
