<script setup lang="ts">
import { computed, ref } from 'vue'
import { CheckCircle2Icon, Loader2Icon, SparklesIcon, XCircleIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createLlmClient } from '@/core/llm/client'
import { useSettingsStore } from '@/core/store/settings'
import { formatDuration } from '@/lib/format'

const settingsStore = useSettingsStore()
const cfg = computed(() => settingsStore.settings.llm)

const testing = ref(false)
const testResult = ref<{ ok: boolean, message: string, reply?: string } | null>(null)

async function save() {
  await settingsStore.save()
}

/**
 * 用一次最小请求验证地址、密钥、模型名是否都对得上。
 * 内网推理服务常见的坑是模型名写错、只支持非流式，所以这里直接把原文回显出来。
 */
async function test() {
  testing.value = true
  testResult.value = null
  try {
    const client = createLlmClient(cfg.value)
    const completion = await client.complete([
      { role: 'system', content: '你是一个测试探针。' },
      { role: 'user', content: '只回复两个字：正常' },
    ])
    const reply = completion.text.trim()
    testResult.value = {
      ok: Boolean(reply),
      message: reply
        ? `调用成功，耗时 ${formatDuration(completion.durationMs)}`
        : '模型返回了空内容，可能是模型名错误或该模型不支持流式输出',
      reply: reply.slice(0, 200),
    }
  }
  catch (err) {
    testResult.value = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  finally {
    testing.value = false
  }
}

const presets = [
  { label: 'Claude Sonnet 5.5', value: 'anthropic|claude-sonnet-5-5' },
  { label: 'Claude Opus 5.5', value: 'anthropic|claude-opus-5-5' },
  { label: 'Claude Haiku 5.5', value: 'anthropic|claude-haiku-5-5' },
]

function applyPreset(value: string) {
  const [provider, model] = value.split('|') as ['anthropic', string]
  cfg.value.provider = provider
  cfg.value.model = model
  cfg.value.baseUrl = ''
  save()
}
</script>

<template>
  <Card class="gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="text-sm">判定模型</CardTitle>
      <CardDescription class="text-xs">
        用于判断代码提交是否支撑日报描述，并生成当日结论。
        支持公有云接口，也支持内网自建的 OpenAI 兼容服务（vLLM / Ollama / 一体机）。
      </CardDescription>
    </CardHeader>

    <CardContent class="space-y-4 px-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label class="text-xs">接口协议</Label>
          <Select
            :model-value="cfg.provider"
            @update:model-value="v => { cfg.provider = v as typeof cfg.provider; save() }"
          >
            <SelectTrigger class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic Messages API</SelectItem>
              <SelectItem value="openai-compatible">OpenAI 兼容（chat/completions）</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="space-y-1.5">
          <Label for="llm-model" class="text-xs">模型名</Label>
          <Input
            id="llm-model"
            v-model="cfg.model"
            placeholder="claude-sonnet-5-5"
            @blur="save"
          />
        </div>
      </div>

      <div class="flex flex-wrap gap-1.5">
        <Button
          v-for="p in presets"
          :key="p.value"
          variant="outline"
          size="sm"
          class="text-xs"
          @click="applyPreset(p.value)"
        >
          <SparklesIcon :size="12" class="mr-1.5" />
          {{ p.label }}
        </Button>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label for="llm-base" class="text-xs">接口地址（留空用官方默认）</Label>
          <Input
            id="llm-base"
            v-model="cfg.baseUrl"
            placeholder="http://llm.internal:8000"
            @blur="save"
          />
        </div>

        <div class="space-y-1.5">
          <Label for="llm-key" class="text-xs">API Key</Label>
          <Input
            id="llm-key"
            v-model="cfg.apiKey"
            type="password"
            placeholder="sk-..."
            @blur="save"
          />
        </div>
      </div>

      <div class="grid gap-4 sm:grid-cols-4">
        <div class="space-y-1.5">
          <Label for="llm-temp" class="text-xs">温度</Label>
          <Input
            id="llm-temp"
            :model-value="cfg.temperature"
            type="number"
            step="0.1"
            min="0"
            max="2"
            @update:model-value="v => { cfg.temperature = Number(v) || 0; save() }"
          />
        </div>

        <div class="space-y-1.5">
          <Label for="llm-max" class="text-xs">最大输出 token</Label>
          <Input
            id="llm-max"
            :model-value="cfg.maxTokens"
            type="number"
            step="512"
            @update:model-value="v => { cfg.maxTokens = Number(v) || 2048; save() }"
          />
        </div>

        <div class="space-y-1.5">
          <Label for="llm-conc" class="text-xs">并发判定数</Label>
          <Input
            id="llm-conc"
            :model-value="cfg.concurrency"
            type="number"
            min="1"
            max="10"
            @update:model-value="v => { cfg.concurrency = Math.max(1, Number(v) || 1); save() }"
          />
          <p class="text-[11px] text-muted-foreground">内网模型建议 1–2</p>
        </div>

        <div class="space-y-1.5">
          <Label for="llm-timeout" class="text-xs">超时（秒）</Label>
          <Input
            id="llm-timeout"
            :model-value="Math.round(cfg.timeoutMs / 1000)"
            type="number"
            min="10"
            @update:model-value="v => { cfg.timeoutMs = Math.max(10, Number(v) || 120) * 1000; save() }"
          />
        </div>
      </div>

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="testing" @click="test">
          <Loader2Icon v-if="testing" :size="13" class="mr-1.5 animate-spin" />
          <SparklesIcon v-else :size="13" class="mr-1.5" />
          测试模型
        </Button>
        <span class="text-[11px] text-muted-foreground">
          未配置模型时仍可运行检查，但只按「有没有提交」做粗略判断，不核对内容
        </span>
      </div>

      <Alert v-if="testResult" :variant="testResult.ok ? 'default' : 'destructive'">
        <CheckCircle2Icon v-if="testResult.ok" :size="14" class="text-emerald-600" />
        <XCircleIcon v-else :size="14" />
        <AlertDescription>
          <div>{{ testResult.message }}</div>
          <div v-if="testResult.reply" class="mt-1 font-mono text-[11px] opacity-80">
            返回：{{ testResult.reply }}
          </div>
        </AlertDescription>
      </Alert>
    </CardContent>
  </Card>
</template>
