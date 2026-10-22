<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  PlugZapIcon,
  StethoscopeIcon,
  WandSparklesIcon,
  XCircleIcon,
} from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import type { LdapProbeReport } from '@/core/bridge/types'
import { transport } from '@/core/bridge'
import { useMemberStore } from '@/core/store/members'
import { useSettingsStore } from '@/core/store/settings'
import { cn } from '@/lib/utils'

const settingsStore = useSettingsStore()
const memberStore = useMemberStore()
const cfg = computed(() => settingsStore.settings.ldap)

const testing = ref(false)
const result = ref<{ ok: boolean, message: string } | null>(null)

const probing = ref(false)
const probe = ref<LdapProbeReport | null>(null)
const probeError = ref<string | null>(null)

async function save() {
  await settingsStore.save()
}

/** 直接跑一次真实同步来验证配置——比「测试连接」更有信息量 */
async function test() {
  testing.value = true
  result.value = null
  try {
    const outcome = await transport().ldapSync(cfg.value)
    await memberStore.load()
    result.value = {
      ok: true,
      message: `连接成功。新增 ${outcome.added} 人，更新 ${outcome.updated} 人`
        + (outcome.skipped ? `，跳过 ${outcome.skipped} 条缺少关键属性的记录` : ''),
    }
  }
  catch (err) {
    result.value = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  finally {
    testing.value = false
  }
}

/**
 * 探测目录属性。
 * 不猜 AD 还是 OpenLDAP，直接问目录它有什么属性，再比对当前映射。
 */
async function diagnose() {
  probing.value = true
  probe.value = null
  probeError.value = null
  try {
    probe.value = await transport().ldapProbe(cfg.value)
  }
  catch (err) {
    probeError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    probing.value = false
  }
}

/** 采纳一条建议：把某个字段的属性名换成目录里确实存在的那个 */
function applySuggestion(field: string, attr: string) {
  cfg.value.attributeMap[field as keyof typeof cfg.value.attributeMap] = attr
  save()
  void diagnose()
}

/** 采纳全部建议 */
function applyAll() {
  for (const s of probe.value?.suggestions ?? [])
    cfg.value.attributeMap[s.field as keyof typeof cfg.value.attributeMap] = s.suggested
  save()
  void diagnose()
}

/**
 * 把不可见字符显式标出来。
 *
 * 从网页或聊天记录里复制时很容易带上零宽空格、方向标记这类东西，
 * 肉眼完全看不出来，但 LDAP 会直接回 invalid DN。
 * 把它们渲染成 <U+XXXX> 才能让人看见问题。
 */
function visualize(value: string) {
  return [...value]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0
      const invisible = cp !== 0x20 && (
        cp < 0x21
        || cp === 0xa0 || cp === 0x3000 || cp === 0xfeff
        || (cp >= 0x2000 && cp <= 0x200a)
        || (cp >= 0x200b && cp <= 0x200f)
        || (cp >= 0x2028 && cp <= 0x202e)
        || (cp >= 0x2060 && cp <= 0x2064)
        || (cp >= 0xfe00 && cp <= 0xfe0f)
      )
      return invisible ? `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>` : ch
    })
    .join('')
}

const coverageTone = (present: number) =>
  present === 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-500'

const attributeRows = [
  { key: 'username', label: '登录名', hint: 'AD: sAMAccountName / OpenLDAP: uid' },
  { key: 'name', label: '姓名', hint: 'AD: displayName / OpenLDAP: cn' },
  { key: 'email', label: '邮箱', hint: 'mail' },
  { key: 'employeeNo', label: '工号', hint: 'employeeNumber' },
  { key: 'department', label: '部门', hint: 'department' },
  { key: 'title', label: '岗位', hint: 'title' },
] as const

const fieldLabel: Record<string, string> = {
  username: '登录名',
  name: '姓名',
  email: '邮箱',
  employeeNo: '工号',
  department: '部门',
  title: '岗位',
}
</script>

<template>
  <Card class="gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="text-sm">LDAP / 域账号</CardTitle>
      <CardDescription class="text-xs">
        人员以目录服务为主数据源，这里同步一次即可批量建好人员。
        连接由本地进程发起，服务账号密码不会进入页面上下文。
      </CardDescription>
    </CardHeader>

    <CardContent class="space-y-4 px-4">
      <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
        <div>
          <div class="text-xs font-medium">启用 LDAP 同步</div>
          <div class="text-[11px] text-muted-foreground">
            关闭后「人员」面板的同步按钮会提示先来这里启用
          </div>
        </div>
        <Switch
          :model-value="cfg.enabled"
          @update:model-value="v => { cfg.enabled = !!v; save() }"
        />
      </div>

      <!--
        字段顺序按「先连上、再搜」来排：地址 → 账号 → 密码 → 搜索起点。
        把搜索起点放在凭据前面看着也合理，但和接线时的思路不一致，容易两组填串。
      -->
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label class="text-xs">服务地址</Label>
          <Input
            v-model="cfg.url"
            placeholder="ldaps://dc01.corp.local:636"
            class="font-mono text-xs"
            @blur="save"
          />
          <p class="text-[11px] text-muted-foreground">
            ldaps:// 走 TLS；用 ldap:// 时通常还要开 STARTTLS（本工具默认不开，需要的话告诉我）
          </p>
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">绑定账号</Label>
          <Input
            v-model="cfg.bindDn"
            placeholder="cn=svc-inspector,ou=service,dc=corp,dc=local"
            class="font-mono text-xs"
            @blur="save"
          />
          <p class="text-[11px] text-muted-foreground">
            能设密码的那个账号条目（<code class="font-mono">cn=</code> 或
            <code class="font-mono">uid=</code> 开头），需要只读权限
          </p>
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">绑定密码</Label>
          <Input
            v-model="cfg.bindPassword"
            type="password"
            @blur="save"
          />
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">搜索起点（Base DN）</Label>
          <Input
            v-model="cfg.baseDn"
            placeholder="ou=people,dc=corp,dc=local"
            class="font-mono text-xs"
            @blur="save"
          />
          <p class="text-[11px] text-muted-foreground">
            人员所在的那个容器（<code class="font-mono">ou=</code> 开头），不是账号本身
          </p>
        </div>
      </div>

      <div class="space-y-1.5">
        <Label class="text-xs">过滤器</Label>
        <Input
          v-model="cfg.userFilter"
          class="font-mono text-xs"
          @blur="save"
        />
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          默认过滤器会排除已停用的 AD 账号（<code class="font-mono">userAccountControl</code>
          的 ACCOUNTDISABLE 位）。OpenLDAP 没有这个属性，需要改成比如
          <code class="font-mono">(objectClass=inetOrgPerson)</code>。
        </p>
      </div>

      <div class="grid gap-4 sm:grid-cols-3">
        <div class="space-y-1.5">
          <Label class="text-xs">单页条数</Label>
          <Input
            :model-value="cfg.pageSize"
            type="number"
            min="1"
            @update:model-value="v => { cfg.pageSize = Math.max(1, Number(v) || 500); save() }"
          />
          <p class="text-[11px] text-muted-foreground">AD 默认上限 1000</p>
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs">超时（秒）</Label>
          <Input
            :model-value="cfg.timeoutSeconds"
            type="number"
            min="5"
            @update:model-value="v => { cfg.timeoutSeconds = Math.max(5, Number(v) || 30); save() }"
          />
        </div>

        <div class="flex items-end">
          <div class="flex w-full items-center justify-between rounded-md border px-3 py-2.5">
            <span class="text-xs">跳过证书校验</span>
            <Switch
              :model-value="cfg.allowInsecureTls"
              @update:model-value="v => { cfg.allowInsecureTls = !!v; save() }"
            />
          </div>
        </div>
      </div>

      <Separator />

      <div class="space-y-2">
        <div class="text-xs font-medium">属性映射</div>
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          AD 和 OpenLDAP 的属性名差别很大，这里按实际目录填写。
          「登录名」会写入人员的 GitLab 用户名以匹配提交作者。
        </p>
        <div class="grid gap-2 sm:grid-cols-2">
          <div v-for="row in attributeRows" :key="row.key" class="flex items-center gap-2">
            <span class="w-14 shrink-0 text-[11px] text-muted-foreground">{{ row.label }}</span>
            <Input
              :model-value="cfg.attributeMap[row.key]"
              :placeholder="row.hint"
              class="h-8 font-mono text-xs"
              @update:model-value="v => { cfg.attributeMap[row.key] = String(v) }"
              @blur="save"
            />
          </div>
        </div>
      </div>

      <!--
        把实际会发出去的参数摆出来。
        「输入框里显示的值」和「实际发送的值」不一致是最难查的一类问题
        （拼写错误、从网页复制带进的不可见字符、自动更正），
        与其让人对着输入框反复确认，不如直接把真实值显示出来。
      -->
      <div class="space-y-1 rounded-md border bg-muted/40 p-2.5 text-[11px]">
        <div class="text-muted-foreground">即将发送的连接参数（不可见字符会显示成 &lt;U+XXXX&gt;）</div>
        <div class="font-mono break-all">
          绑定账号 = {{ visualize(cfg.bindDn) }}
        </div>
        <div class="font-mono break-all">
          搜索起点 = {{ visualize(cfg.baseDn) }}
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" :disabled="testing || !cfg.enabled" @click="test">
          <Loader2Icon v-if="testing" :size="13" class="mr-1.5 animate-spin" />
          <PlugZapIcon v-else :size="13" class="mr-1.5" />
          {{ testing ? '同步中…' : '测试并同步一次' }}
        </Button>

        <Button variant="outline" size="sm" :disabled="probing" @click="diagnose">
          <Loader2Icon v-if="probing" :size="13" class="mr-1.5 animate-spin" />
          <StethoscopeIcon v-else :size="13" class="mr-1.5" />
          {{ probing ? '诊断中…' : '诊断属性映射' }}
        </Button>

        <span v-if="!cfg.enabled" class="text-[11px] text-muted-foreground">
          先启用 LDAP
        </span>
      </div>

      <!-- 诊断结果：直接列出当前映射在目录里的命中数，以及可替代的属性 -->
      <div v-if="probe" class="space-y-3 rounded-md border p-3">
        <div class="text-xs">
          过滤器 <code class="font-mono">{{ probe.filter }}</code>
          在 <code class="font-mono">{{ probe.baseDn }}</code> 下匹配到
          <span class="font-medium">{{ probe.total }}</span> 条，
          属性统计基于前 {{ probe.sampled }} 条。
        </div>

        <div class="space-y-1">
          <div class="text-xs font-medium">当前映射的命中情况</div>
          <div class="grid gap-1 sm:grid-cols-2">
            <div
              v-for="m in probe.mapped"
              :key="m.field"
              class="flex items-center gap-2 rounded border px-2 py-1 text-[11px]"
            >
              <span class="w-10 shrink-0 text-muted-foreground">{{ fieldLabel[m.field] ?? m.field }}</span>
              <span class="font-mono">{{ m.name || '（空）' }}</span>
              <span :class="cn('ml-auto tabular-nums', coverageTone(m.present))">
                {{ m.present }} 条
              </span>
            </div>
          </div>
        </div>

        <Alert v-if="probe.suggestions.length" class="border-amber-500/40 bg-amber-500/5">
          <WandSparklesIcon :size="14" class="text-amber-600 dark:text-amber-500" />
          <AlertTitle>{{ probe.suggestions.length }} 个字段的属性在目录里取不到值</AlertTitle>
          <AlertDescription class="space-y-1.5">
            <div
              v-for="s in probe.suggestions"
              :key="s.field"
              class="flex flex-wrap items-center gap-1.5 text-[11px]"
            >
              <span>{{ fieldLabel[s.field] ?? s.field }}</span>
              <code class="font-mono">{{ s.current }}</code>
              <span class="text-muted-foreground">→</span>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono hover:bg-accent"
                @click="applySuggestion(s.field, s.suggested)"
              >
                {{ s.suggested }}
                <span class="text-muted-foreground">{{ s.suggestedPresent }} 条</span>
              </button>
            </div>
            <Button variant="outline" size="sm" class="mt-1 text-xs" @click="applyAll">
              全部采纳
            </Button>
          </AlertDescription>
        </Alert>

        <div v-else class="rounded border border-emerald-500/40 bg-emerald-500/5 px-2.5 py-2 text-[11px] text-emerald-700 dark:text-emerald-400">
          当前映射的字段在目录里都能取到值。
        </div>

        <Alert v-if="probe.sensitiveAttributes.length" variant="destructive">
          <AlertTriangleIcon :size="14" />
          <AlertTitle>目录返回了敏感属性</AlertTitle>
          <AlertDescription class="text-[11px]">
            {{ probe.sensitiveAttributes.join('、') }} —— 值已隐藏。
            正常情况目录的 ACL 应该挡住这些，出现即说明目录侧配置可能过宽，建议找运维确认。
            本工具不需要它们，读数不受影响。
          </AlertDescription>
        </Alert>

        <details class="text-[11px]">
          <summary class="cursor-pointer text-muted-foreground">
            目录里实际存在的属性（前 {{ probe.available.length }} 个）
          </summary>
          <div class="mt-1.5 flex flex-wrap gap-1">
            <span
              v-for="a in probe.available"
              :key="a.name"
              class="rounded border px-1.5 py-0.5 font-mono"
              :title="a.sample ?? ''"
            >
              {{ a.name }} <span class="text-muted-foreground">{{ a.present }}</span>
            </span>
          </div>
        </details>

        <details class="text-[11px]">
          <summary class="cursor-pointer text-muted-foreground">
            抽样条目
          </summary>
          <div v-for="s in probe.samples" :key="s.dn" class="mt-1.5 rounded border p-2">
            <div class="font-mono break-all text-muted-foreground">{{ s.dn }}</div>
            <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              <span v-for="[k, v] in s.attributes" :key="k">
                <span class="font-mono text-muted-foreground">{{ k }}</span>= {{ v }}
              </span>
            </div>
          </div>
        </details>
      </div>

      <Alert v-if="probeError" variant="destructive">
        <XCircleIcon :size="14" />
        <AlertDescription>{{ probeError }}</AlertDescription>
      </Alert>

      <Alert v-if="result" :variant="result.ok ? 'default' : 'destructive'">
        <CheckCircle2Icon v-if="result.ok" :size="14" class="text-emerald-600" />
        <XCircleIcon v-else :size="14" />
        <AlertDescription>
          <div>{{ result.message }}</div>
          <div v-if="result.ok" class="mt-1 text-[11px] text-muted-foreground">
            同步按「工号 → 登录名 → 姓名」认人；已存在的人只补齐 LDAP 侧的信息，
            不会覆盖日报成员 ID 和你手工维护的邮箱。
          </div>
        </AlertDescription>
      </Alert>

      <Alert>
        <AlertTitle class="text-xs">同步不会删除人</AlertTitle>
        <AlertDescription class="text-[11px]">
          目录里没有的人不会被自动删掉——离职后账号被禁用是常态，
          但历史检查记录还要能看。需要停用请到「人员」面板手动改。
        </AlertDescription>
      </Alert>
    </CardContent>
  </Card>
</template>
