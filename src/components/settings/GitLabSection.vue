<script setup lang="ts">
import { computed, ref } from 'vue'
import { CheckCircle2Icon, Loader2Icon, PlugZapIcon, XCircleIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { GitLabClient } from '@/core/adapters/gitlab'
import { useSettingsStore } from '@/core/store/settings'
import { useRunnerStore } from '@/core/store/runner'

const settingsStore = useSettingsStore()
const runner = useRunnerStore()
const cfg = computed(() => settingsStore.settings.gitlab)

const testing = ref(false)
const testResult = ref<{ ok: boolean, message: string } | null>(null)

async function save() {
  await settingsStore.save()
}

async function test() {
  testing.value = true
  testResult.value = null
  try {
    const info = await new GitLabClient(cfg.value).ping()
    testResult.value = { ok: true, message: `连接成功：GitLab ${info.version}，当前账号 ${info.user}` }
    // 地址或 Token 变了，仓库目录必须重建
    await runner.ensureCatalog(true)
  }
  catch (err) {
    testResult.value = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  finally {
    testing.value = false
  }
}
</script>

<template>
  <Card class="gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="text-sm">GitLab</CardTitle>
      <CardDescription class="text-xs">
        需要一个具备 <code class="font-mono">read_api</code> 权限的 Personal Access Token。
        请求由本地进程直接发出，Token 不会经过浏览器上下文。
      </CardDescription>
    </CardHeader>

    <CardContent class="space-y-4 px-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label for="gl-url" class="text-xs">实例地址</Label>
          <Input
            id="gl-url"
            v-model="cfg.baseUrl"
            placeholder="https://gitlab.example.com"
            @blur="save"
          />
        </div>

        <div class="space-y-1.5">
          <Label for="gl-token" class="text-xs">Access Token</Label>
          <Input
            id="gl-token"
            v-model="cfg.token"
            type="password"
            placeholder="glpat-xxxxxxxxxxxx"
            @blur="save"
          />
        </div>
      </div>

      <Alert>
        <AlertDescription>
          仓库范围<strong class="font-medium">不在这里配</strong>：每个业务项目在「项目」面板上自己关联仓库或组
          （组会扫描子组），一个项目可以同时关联多个仓库和多个组。
          这里的目录只是给「日报里的项目名对不上任何项目」时的模糊匹配提供候选。
        </AlertDescription>
      </Alert>

      <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
        <div>
          <div class="text-xs font-medium">跳过 TLS 校验</div>
          <div class="text-[11px] text-muted-foreground">
            内网自签名证书时开启。仅在完全可信的内网环境下使用。
          </div>
        </div>
        <Switch
          :model-value="cfg.allowInsecureTls"
          @update:model-value="v => { cfg.allowInsecureTls = !!v; save() }"
        />
      </div>

      <div class="space-y-1.5">
        <Label for="gl-max" class="text-xs">仓库目录数量上限</Label>
        <Input
          id="gl-max"
          :model-value="cfg.maxProjects"
          type="number"
          min="1"
          class="w-40"
          @update:model-value="v => { cfg.maxProjects = Math.max(1, Number(v) || 2000); save() }"
        />
        <p class="text-[11px] text-muted-foreground">
          防止在大实例上无限翻页。这份目录只给「项目名对不上任何项目」时的模糊匹配用，
          主要检查路径走的是项目自己配置的仓库/组。
        </p>
      </div>

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="testing" @click="test">
          <Loader2Icon v-if="testing" :size="13" class="mr-1.5 animate-spin" />
          <PlugZapIcon v-else :size="13" class="mr-1.5" />
          测试连接
        </Button>
        <span v-if="runner.catalog" class="text-[11px] text-muted-foreground">
          仓库目录：{{ runner.catalog.projects.length }} 个 · {{ runner.catalog.scope }}
        </span>
      </div>

      <Alert v-if="testResult" :variant="testResult.ok ? 'default' : 'destructive'">
        <CheckCircle2Icon v-if="testResult.ok" :size="14" class="text-emerald-600" />
        <XCircleIcon v-else :size="14" />
        <AlertDescription>{{ testResult.message }}</AlertDescription>
      </Alert>
    </CardContent>
  </Card>
</template>
