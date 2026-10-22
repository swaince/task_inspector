<script setup lang="ts">
import { ref, watch } from 'vue'
import { SaveIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import DataSection from '@/components/settings/DataSection.vue'
import AnalysisSection from '@/components/settings/AnalysisSection.vue'
import CalendarSection from '@/components/settings/CalendarSection.vue'
import GitLabSection from '@/components/settings/GitLabSection.vue'
import LlmSection from '@/components/settings/LlmSection.vue'
import ReportSourceSection from '@/components/settings/ReportSourceSection.vue'
import RulesSection from '@/components/settings/RulesSection.vue'
import { useSettingsStore } from '@/core/store/settings'
import { useRunnerStore } from '@/core/store/runner'

const settingsStore = useSettingsStore()
const runner = useRunnerStore()

const tab = ref('gitlab')
const savedFlash = ref(false)

/**
 * 各分区都是失焦即存，这里只是给一个显式的「保存」出口，
 * 免得用户改完不确定有没有落盘。
 */
async function saveAll() {
  await settingsStore.save()
  savedFlash.value = true
  setTimeout(() => (savedFlash.value = false), 1600)
}

// 改动成员映射后，已建好的仓库目录不需要重建；但改了项目映射需要
watch(
  () => settingsStore.settings.projectMappings.map(m => m.gitlabProjectPaths.join(',')).join('|'),
  () => {
    runner.catalog = null
  },
)
</script>

<template>
  <div class="scrollbar-thin h-full overflow-y-auto">
    <div class="space-y-4 p-5">
      <Tabs v-model="tab">
        <div class="flex items-center gap-3">
          <TabsList>
            <TabsTrigger value="gitlab">GitLab</TabsTrigger>
            <TabsTrigger value="report">日报系统</TabsTrigger>
            <TabsTrigger value="calendar">工作日历</TabsTrigger>
            <TabsTrigger value="llm">模型</TabsTrigger>
            <TabsTrigger value="rules">判定规则</TabsTrigger>
            <TabsTrigger value="analysis">代码分析</TabsTrigger>
            <TabsTrigger value="data">数据</TabsTrigger>
          </TabsList>

          <Button
            variant="outline"
            size="sm"
            class="ml-auto"
            :disabled="settingsStore.saving"
            @click="saveAll"
          >
            <SaveIcon :size="13" class="mr-1.5" />
            {{ savedFlash ? '已保存' : '保存' }}
          </Button>
        </div>

        <TabsContent value="gitlab" class="mt-4">
          <GitLabSection />
        </TabsContent>

        <TabsContent value="report" class="mt-4">
          <ReportSourceSection />
        </TabsContent>

        <TabsContent value="calendar" class="mt-4">
          <CalendarSection />
        </TabsContent>

        <TabsContent value="llm" class="mt-4">
          <LlmSection />
        </TabsContent>

        <TabsContent value="rules" class="mt-4">
          <RulesSection />
        </TabsContent>

        <TabsContent value="analysis" class="mt-4">
          <AnalysisSection />
        </TabsContent>

        <TabsContent value="data" class="mt-4">
          <DataSection />
        </TabsContent>
      </Tabs>
    </div>
  </div>
</template>
