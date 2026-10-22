<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { CheckCircle2Icon, CloudDownloadIcon, CopyIcon, Loader2Icon, LogInIcon, XCircleIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import DatePicker from '@/components/common/DatePicker.vue'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createDailyReportSource } from '@/core/adapters/dailyReport'
import { getDailyReportSession } from '@/core/adapters/dailyReportAuth'
import type { DailyReportSession, LoginAttempt, SessionStatus } from '@/core/adapters/dailyReportAuth'
import { useSettingsStore } from '@/core/store/settings'
import { dateKeyOffset } from '@/lib/format'

const settingsStore = useSettingsStore()
const cfg = computed(() => settingsStore.settings.dailyReport)

const login = computed(() => cfg.value.login)

const testing = ref(false)
const loggingIn = ref(false)
const loginResult = ref<{ ok: boolean, message: string, attempt?: LoginAttempt | null } | null>(null)

/*
 * 会话状态要定时刷新才看得见变化——空闲剩余时间是一直在走的。
 * 5 秒一次足够，这是设置页上的展示，没必要更密。
 */
const sessionStatus = ref<SessionStatus | null>(null)
let statusTimer: ReturnType<typeof setInterval> | null = null

function refreshStatus() {
  try {
    sessionStatus.value = getDailyReportSession(cfg.value).status()
  }
  catch {
    sessionStatus.value = null
  }
}

onMounted(() => {
  refreshStatus()
  statusTimer = setInterval(refreshStatus, 5000)
})

onUnmounted(() => {
  if (statusTimer)
    clearInterval(statusTimer)
})

/** 只走登录这一步，不拉数据——用来单独确认账号密码和接口地址对不对 */
async function testLogin() {
  loggingIn.value = true
  loginResult.value = null
  // 会话的创建也放进 try：放在外面的话，这一步万一抛了，
  // finally 不会执行、按钮卡在 loading，界面上还一个字都没有
  let session: DailyReportSession | null = null
  try {
    // 用单例会话，登录成功后探活定时器就挂上了，和实际检查时是同一个会话
    session = getDailyReportSession(cfg.value)
    const result = await session.login()
    // 自动补的验证码字段要说出来，否则「没配也能登上去」看不出是补上了还是恰好没校验
    const generated = [
      result.captcha.keyGenerated && 'key',
      result.captcha.codeGenerated && 'code',
    ].filter(Boolean)
    loginResult.value = {
      ok: true,
      message: `登录成功，已取到 token（${result.token.slice(0, 8)}…）`
        + (result.userId ? `，userId=${result.userId}` : '')
        + (generated.length ? `；${generated.join(' / ')} 为自动生成（key=${result.captcha.key.slice(0, 8)}…）` : ''),
    }
  }
  catch (err) {
    loginResult.value = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      // 失败时把实际发出去的请求摊开：服务端多半只会回一句「用户名或密码错误」，
      // 到底是地址错了还是 loginInfo 拼错了，只能靠对比真实前端的请求来判断
      attempt: session?.attempt ?? null,
    }
  }
  finally {
    loggingIn.value = false
    refreshStatus()
  }
}
const testResult = ref<{ ok: boolean, message: string, preview?: string } | null>(null)

/**
 * 试拉的日期，默认昨天。
 *
 * 日报是当天晚上才上报的，所以白天去看「今天」永远是空的——拿这个当作
 * 「接口是不是通的」的判据会一直得出错误结论。
 */
const testDate = ref(dateKeyOffset(-1))

/** 预览里把工作内容压到一行；内部系统的内容是多行文本，原样塞进去会撑爆告警框 */
function excerpt(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine)
    return '（工作内容为空，检查该字段的映射）'
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** 把失败的请求内容整段复制走，方便直接发给后端核对（密码已打码） */
async function copyAttempt() {
  const a = loginResult.value?.attempt
  if (!a)
    return
  const lines = [
    `POST ${a.url}`,
    `content-type: ${a.contentType}`,
    ...Object.entries(a.fields).map(([k, v]) => `${k} = ${v}`),
    `loginInfo 解码后 = ${a.loginInfoPlain}`,
    a.status !== null ? `← HTTP ${a.status}` : '',
    a.error ? `请求没发出去：${a.error}` : '',
    a.responseBody ? `响应正文：${a.responseBody}` : '',
  ].filter(Boolean)
  try {
    await navigator.clipboard.writeText(lines.join('\n'))
  }
  catch {
    // 剪贴板不可用就作罢，内容本来就在屏幕上，手选也行
  }
}

async function save() {
  await settingsStore.save()
}

/**
 * 字段映射是最容易出错的地方：内部系统的响应结构各不相同，
 * 所以「测试」直接把解析出来的第一条原样打印，方便对照着改路径。
 */
async function test() {
  testing.value = true
  testResult.value = null
  const date = testDate.value || dateKeyOffset(-1)
  try {
    const source = createDailyReportSource(cfg.value)
    const reports = await source.fetchByDate(date)
    if (!reports.length) {
      testResult.value = { ok: true, message: `接口调用成功，但 ${date} 没有返回任何日报` }
      return
    }
    const first = reports[0]
    testResult.value = {
      ok: true,
      message: `调用成功，${date} 解析出 ${reports.length} 份日报`,
      // 项目名、工时、内容三样都摆出来：字段映射配错时，看这一行就知道错在哪一项
      preview: `${first.memberName}（${first.memberId}）：`
        + (first.entries.length
          ? first.entries
              .map(e => `${e.projectName} ${e.hours}h · ${excerpt(e.content)}`)
              .join('；')
          : '（没有解析出条目，检查「条目数组」等字段映射）'),
    }
  }
  catch (err) {
    testResult.value = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  finally {
    testing.value = false
  }
}

const fm = computed(() => cfg.value.fieldMap)

const fieldRows: Array<{ key: keyof typeof fm.value, label: string, hint: string }> = [
  { key: 'itemsPath', label: '日报数组', hint: '如 data.data' },
  { key: 'datePath', label: '日期', hint: '如 workDate' },
  { key: 'memberIdPath', label: '成员 ID', hint: '如 createUser' },
  { key: 'memberNamePath', label: '成员姓名', hint: '如 createUserName' },
  { key: 'entriesPath', label: '条目数组', hint: '如 projects' },
  { key: 'entryProjectNamePath', label: '项目名', hint: '如 projectName' },
  { key: 'entryProjectCodePath', label: '项目编码', hint: '如 projectNumber' },
  { key: 'entryHoursPath', label: '工时', hint: '如 workDayPercent' },
  { key: 'entryContentPath', label: '工作内容', hint: '如 workContent' },
  { key: 'entryTaskRefsPath', label: '任务号', hint: '可留空' },
]
</script>

<template>
  <Card class="gap-0 py-4">
    <CardHeader class="px-4 pb-3">
      <CardTitle class="text-sm">日报系统</CardTitle>
      <CardDescription class="text-xs">
        三种来源任选：直连内部日报系统接口、导入导出的 CSV、或使用内置演示数据先把流程跑通。
      </CardDescription>
    </CardHeader>

    <CardContent class="space-y-4 px-4">
      <div class="space-y-1.5">
        <Label class="text-xs">数据来源</Label>
        <Select
          :model-value="cfg.source"
          @update:model-value="v => { cfg.source = v as typeof cfg.source; save() }"
        >
          <SelectTrigger class="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="http">日报系统接口</SelectItem>
            <SelectItem value="mock">演示数据（不连接任何系统）</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <template v-if="cfg.source === 'http'">
        <Separator />

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label for="dr-url" class="text-xs">接口根地址</Label>
            <Input
              id="dr-url"
              v-model="cfg.baseUrl"
              placeholder="https://192.168.2.21:51443"
              class="font-mono text-xs"
              @blur="save"
            />
            <p class="text-[11px] text-muted-foreground">
              只填协议 + 主机 + 端口，<strong class="font-medium">不要带 /api 这类接口前缀</strong>，
              前缀写在下面的路径里
            </p>
          </div>

          <div class="space-y-1.5">
            <Label for="dr-token" class="text-xs">Token</Label>
            <Input
              id="dr-token"
              v-model="cfg.token"
              type="password"
              @blur="save"
            />
          </div>
        </div>

        <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
          <div>
            <div class="text-xs font-medium">跳过 TLS 证书校验</div>
            <div class="text-[11px] text-muted-foreground">
              内网自签证书时打开。<strong class="font-medium">只在桌面端有效</strong>——
              浏览器模式用的是页面的 fetch，证书校验由浏览器自己做，绕不过去
            </div>
          </div>
          <Switch
            :model-value="cfg.allowInsecureTls"
            @update:model-value="v => { cfg.allowInsecureTls = !!v; save() }"
          />
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-1.5 sm:col-span-2">
            <Label for="dr-path" class="text-xs">拉取路径（从根地址起算，含接口前缀）</Label>
            <Input
              id="dr-path"
              v-model="cfg.listPathTemplate"
              placeholder="/api/work/work-log/v2/page/send/me"
              class="font-mono text-xs"
              @blur="save"
            />
            <p class="text-[11px] text-muted-foreground">
              核查的是<strong class="font-medium">别人发给或抄送给你</strong>的日报，
              不要填 <code class="font-mono">page/self</code>（那是自己的日志，查不到待核查的人）。
              和登录路径一样从根地址起算。<code class="font-mono">{date}</code> 会被替换成
              YYYY-MM-DD，<code class="font-mono">{startDate}</code> /
              <code class="font-mono">{endDate}</code> 是同一个值（一次只查一天）；
              开了分页还会有 <code class="font-mono">{page}</code> /
              <code class="font-mono">{limit}</code>
            </p>
          </div>

          <div class="space-y-1.5">
            <Label for="dr-method" class="text-xs">请求方法</Label>
            <Select
              :model-value="cfg.method"
              @update:model-value="v => { cfg.method = v as 'GET' | 'POST'; save() }"
            >
              <SelectTrigger id="dr-method" class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="POST">POST</SelectItem>
                <SelectItem value="GET">GET</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-[11px] text-muted-foreground">
              分页查询一般是 POST，老式导出接口多是 GET
            </p>
          </div>
        </div>

        <template v-if="cfg.method === 'POST'">
          <div class="space-y-1.5">
            <Label for="dr-body" class="text-xs">请求体模板（JSON）</Label>
            <Textarea
              id="dr-body"
              :model-value="cfg.bodyTemplate"
              rows="3"
              placeholder='{"page":{page},"limit":{limit},"startDate":"{startDate}","endDate":"{endDate}"}'
              class="font-mono text-xs"
              @update:model-value="v => { cfg.bodyTemplate = String(v); save() }"
            />
            <p class="text-[11px] leading-relaxed text-muted-foreground">
              占位写法：<code class="font-mono">"{page}"</code>（整体带引号）会替换成数字，
              <code class="font-mono">"{startDate}"</code> 替换成带引号的日期字符串。
              日期有两套：<code class="font-mono">{'{startDate}'}</code> 是
              <code class="font-mono">2026-10-16</code>，
              <code class="font-mono">{'{startDateTime}'}</code> 是
              <code class="font-mono">2026-10-16 00:00:00</code>
              （结束时间的那套取当天 23:59:59）。服务端把日期声明成日期时间却收到纯日期时，
              会在反序列化那步直接抛异常，报出来往往是「请求体读取异常」这类看不出原因的话，
              这时换成带时间的那套。
            </p>
          </div>
        </template>

        <div class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-1.5">
            <Label for="dr-page-size" class="text-xs">每页条数</Label>
            <Input
              id="dr-page-size"
              :model-value="cfg.pageSize"
              type="number"
              min="1"
              @update:model-value="v => { cfg.pageSize = Math.max(1, Number(v) || 1); save() }"
            />
            <p class="text-[11px] text-muted-foreground">
              一路翻到空页为止，值不用猜准；只查一页就把下面设成 1
            </p>
          </div>

          <div class="space-y-1.5">
            <Label for="dr-max-pages" class="text-xs">最多翻页数</Label>
            <Input
              id="dr-max-pages"
              :model-value="cfg.maxPages"
              type="number"
              min="1"
              @update:model-value="v => { cfg.maxPages = Math.max(1, Number(v) || 1); save() }"
            />
            <p class="text-[11px] text-muted-foreground">
              上限兜底，防止接口始终返回满页
            </p>
          </div>

          <div class="space-y-1.5">
            <Label for="dr-auth" class="text-xs">认证头</Label>
            <Input
              id="dr-auth"
              v-model="cfg.authHeader"
              placeholder="Authorization"
              class="font-mono text-xs"
              @blur="save"
            />
          </div>
        </div>

        <p class="text-[11px] leading-relaxed text-muted-foreground">
          查询是串行的，同一批里两次请求之间至少隔 300ms，一次检查正常只发一两个请求。
        </p>

        <div class="space-y-1.5">
          <Label for="dr-query" class="text-xs">附加查询参数</Label>
          <Input
            id="dr-query"
            v-model="cfg.extraQuery"
            placeholder="tenantId=1&status=submitted"
            class="font-mono text-xs"
            @blur="save"
          />
        </div>

        <Separator />

        <div class="space-y-2">
          <div class="text-xs font-medium">响应字段映射</div>
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            用点号路径指向响应 JSON 里的字段，分三层：
            「日报数组」相对响应根；
            日期、成员 ID、成员姓名、条目数组相对
            <code class="font-mono">{{ fm.itemsPath }}</code> 里的每一条；
            条目相关的五项相对
            <code class="font-mono">{{ fm.entriesPath }}</code> 里的每一条。
            「工作内容」在条目里取不到时会退回日志级取一次——有的系统一整天只写一份内容，
            项目列表里只带工时占比。
          </p>

          <div class="grid gap-2 sm:grid-cols-2">
            <div v-for="row in fieldRows" :key="row.key" class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-[11px] text-muted-foreground">{{ row.label }}</span>
              <Input
                :model-value="fm[row.key]"
                :placeholder="row.hint"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { fm[row.key] = v as string }"
                @blur="save"
              />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 pt-1">
            <span class="text-[11px] text-muted-foreground">工时列若填的是百分比（100 = 一整天），100% 折算为</span>
            <Input
              id="dr-hours-base"
              :model-value="cfg.entryHoursPercentBase"
              type="number"
              min="0"
              class="h-8 w-20 font-mono text-xs"
              @update:model-value="v => { cfg.entryHoursPercentBase = Math.max(0, Number(v) || 0); save() }"
            />
            <span class="text-[11px] text-muted-foreground">
              小时；<strong class="font-medium">0 = 不折算</strong>，字段值直接当小时数
            </span>
          </div>
        </div>

        <Separator />

        <div class="space-y-2">
          <div class="text-xs font-medium">项目清单</div>
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            日志系统里「项目」是独立实体、自带项目编号。这条接口用来把编号同步到「项目」面板，
            免得一个个手填。路径同样从根地址起算、含接口前缀。
          </p>
          <div class="grid gap-2 sm:grid-cols-2">
            <div class="space-y-1 sm:col-span-2">
              <span class="text-[11px] text-muted-foreground">接口路径</span>
              <Input
                :model-value="cfg.projectList.path"
                placeholder="/api/work/work-project/list/simple"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.projectList.path = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">项目数组</span>
              <Input
                :model-value="cfg.projectList.itemsPath"
                placeholder="data"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.projectList.itemsPath = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">项目名称</span>
              <Input
                :model-value="cfg.projectList.namePath"
                placeholder="projectName"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.projectList.namePath = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">项目编号</span>
              <Input
                :model-value="cfg.projectList.numberPath"
                placeholder="projectNumber"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.projectList.numberPath = String(v); save() }"
                @blur="save"
              />
            </div>
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-xs font-medium">用户清单</div>
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            人员的名单来源。「人员」面板的「从日志中心同步」按这个接口建人，
            并把日报里的用户 ID 对上——这一步不做，同一个人会在检查页被拆成两条。
            <strong class="font-medium">这个接口会连带返回密码字段；我们只按下面的映射读取，绝不保存密码。</strong>
          </p>
          <div class="grid gap-2 sm:grid-cols-2">
            <div class="space-y-1 sm:col-span-2">
              <span class="text-[11px] text-muted-foreground">接口路径（含固定查询参数）</span>
              <Input
                :model-value="cfg.userList.path"
                placeholder="/api/system/user/queryList?deptId=&permission=0&userType=1"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.userList.path = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">用户数组</span>
              <Input
                :model-value="cfg.userList.itemsPath"
                placeholder="data"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.userList.itemsPath = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">用户 ID</span>
              <Input
                :model-value="cfg.userList.idPath"
                placeholder="id"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.userList.idPath = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">姓名</span>
              <Input
                :model-value="cfg.userList.namePath"
                placeholder="name"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.userList.namePath = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">登录名（工号）</span>
              <Input
                :model-value="cfg.userList.loginNamePath"
                placeholder="loginName"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.userList.loginNamePath = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">部门</span>
              <Input
                :model-value="cfg.userList.deptPath"
                placeholder="deptNames"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.userList.deptPath = String(v); save() }"
                @blur="save"
              />
            </div>
            <div class="space-y-1">
              <span class="text-[11px] text-muted-foreground">邮箱</span>
              <Input
                :model-value="cfg.userList.mailPath"
                placeholder="mail"
                class="h-8 font-mono text-xs"
                @update:model-value="v => { cfg.userList.mailPath = String(v); save() }"
                @blur="save"
              />
            </div>
          </div>
        </div>

        <Separator />

        <!-- 登录 -->
        <div class="space-y-3">
          <div class="flex items-center justify-between rounded-md border px-3 py-2.5">
            <div>
              <div class="text-xs font-medium">启用接口登录</div>
              <div class="text-[11px] text-muted-foreground">
                开启后先登录拿 token，再用 token 调日报接口；关闭则用上面的静态 Token
              </div>
            </div>
            <Switch
              :model-value="login.enabled"
              @update:model-value="v => { login.enabled = !!v; save() }"
            />
          </div>

          <template v-if="login.enabled">
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="space-y-1.5 sm:col-span-2">
                <Label class="text-xs">登录接口路径（从根地址起算，含接口前缀）</Label>
                <Input
                  v-model="login.path"
                  placeholder="/api/login"
                  class="font-mono text-xs"
                  @blur="save"
                />
                <p class="text-[11px] text-muted-foreground">
                  最终地址 = 根地址 + 这个路径。不要再写一遍根地址
                </p>
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs">登录方式 type</Label>
                <Input
                  :model-value="login.type"
                  type="number"
                  @update:model-value="v => { login.type = Number(v) || 0; save() }"
                />
                <p class="text-[11px] text-muted-foreground">
                  <strong class="font-medium">0</strong> = 用户名密码，不校验图形验证码；
                  <strong class="font-medium">1</strong> = 需要图形验证码。配什么就发什么
                </p>
                <p
                  v-if="login.type === 1"
                  class="text-[11px] leading-relaxed text-amber-600 dark:text-amber-500"
                >
                  type=1 要的是人在页面上看出来的那四个字符，自动补的随机值一定过不了。
                  自动化登录只能用 0
                </p>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-1.5">
                <Label class="text-xs">用户名</Label>
                <Input v-model="login.username" @blur="save" />
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs">密码</Label>
                <Input v-model="login.password" type="password" @blur="save" />
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-1.5">
                <Label class="text-xs">验证码 key</Label>
                <Input v-model="login.captchaKey" class="font-mono text-xs" @blur="save" />
                <p class="text-[11px] text-muted-foreground">
                  留空 = 每次登录自动生成一个 UUID。这个字段不能是空的，服务端会读它
                </p>
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs">验证码</Label>
                <Input v-model="login.captchaCode" class="font-mono text-xs" @blur="save" />
                <p class="text-[11px] text-muted-foreground">留空 = 自动补一个随机串，同理</p>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-3">
              <div class="space-y-1.5">
                <Label class="text-xs">token 字段路径</Label>
                <Input
                  v-model="login.tokenPath"
                  placeholder="data.accessToken"
                  class="font-mono text-xs"
                  @blur="save"
                />
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs">token 请求头</Label>
                <Input
                  v-model="login.tokenHeader"
                  placeholder="X-Token"
                  class="font-mono text-xs"
                  @blur="save"
                />
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs">请求体编码</Label>
                <Select
                  :model-value="login.bodyFormat"
                  @update:model-value="v => { login.bodyFormat = v as 'form' | 'json'; save() }"
                >
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="form">x-www-form-urlencoded</SelectItem>
                    <SelectItem value="json">application/json</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <!-- 会话保持 -->
            <div class="space-y-3 rounded-md border bg-muted/30 p-3">
              <div class="text-xs font-medium">会话保持</div>
              <p class="text-[11px] leading-relaxed text-muted-foreground">
                服务端的空闲计时看的是「有没有请求」，所以想在失效前保住会话就得真的发请求。
                三种情况按顺序生效：配了探活接口就按频率打；没配探活但知道空闲时间就在失效前重登；
                两者都没有则等请求被打回 401 再重登。
              </p>

              <div class="grid gap-3 sm:grid-cols-3">
                <div class="space-y-1.5">
                  <Label class="text-xs">空闲失效时间（分钟）</Label>
                  <Input
                    :model-value="login.idleTimeoutMinutes"
                    type="number"
                    min="0"
                    @update:model-value="v => { login.idleTimeoutMinutes = Math.max(0, Number(v) || 0); save() }"
                  />
                  <p class="text-[11px] text-muted-foreground">
                    0 = 不主动续期。这个值从日报系统那边查
                  </p>
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">探活接口路径</Label>
                  <Input
                    v-model="login.keepAlivePath"
                    placeholder="/api/user/info"
                    class="font-mono text-xs"
                    @blur="save"
                  />
                  <p class="text-[11px] text-muted-foreground">留空则退化为「失效前重登」</p>
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">探活频率（分钟）</Label>
                  <Input
                    :model-value="login.keepAliveIntervalMinutes"
                    type="number"
                    min="0"
                    @update:model-value="v => { login.keepAliveIntervalMinutes = Math.max(0, Number(v) || 0); save() }"
                  />
                  <p class="text-[11px] text-muted-foreground">0 = 自动取空闲时间的 2/3</p>
                </div>
              </div>
            </div>

            <p class="text-[11px] leading-relaxed text-muted-foreground">
              提交内容为 <code class="font-mono">loginInfo = Base64(用户名 + 验证码key + 密码)</code>，
              连同 <code class="font-mono">key / code / type</code> 一起提交。
              登录成功后 token 会缓存在会话里跨多次检查复用，接口返回 401/403 时自动重新登录一次。
            </p>

            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" :disabled="loggingIn" @click="testLogin">
                <Loader2Icon v-if="loggingIn" :size="13" class="mr-1.5 animate-spin" />
                <LogInIcon v-else :size="13" class="mr-1.5" />
                测试登录
              </Button>
            </div>

            <Alert v-if="loginResult" :variant="loginResult.ok ? 'default' : 'destructive'">
              <CheckCircle2Icon v-if="loginResult.ok" :size="14" class="text-emerald-600" />
              <XCircleIcon v-else :size="14" />
              <AlertDescription>
                <div>{{ loginResult.message }}</div>

                <!--
                  失败时把实际发出去的请求原样摊开。密码已打码，可以直接复制出去找后端对。
                -->
                <div
                  v-if="!loginResult.ok && loginResult.attempt"
                  class="mt-2 space-y-1 rounded-md border bg-background/60 p-2.5"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-[11px] font-medium">实际发出的请求</span>
                    <Button variant="ghost" size="xs" class="text-[11px]" @click="copyAttempt">
                      <CopyIcon :size="11" class="mr-1" />
                      复制
                    </Button>
                  </div>
                  <div class="space-y-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    <div>POST {{ loginResult.attempt.url }}</div>
                    <div>content-type: {{ loginResult.attempt.contentType }}</div>
                    <div
                      v-for="(value, key) in loginResult.attempt.fields"
                      :key="key"
                    >
                      {{ key }} = {{ value }}
                    </div>
                    <div>loginInfo 解码后 = {{ loginResult.attempt.loginInfoPlain }}</div>
                    <!--
                      只报「请求有没有回来」这一件事：具体原因上面那句标题已经说了，
                      这里再重复一遍纯属噪音
                    -->
                    <div v-if="loginResult.attempt.status !== null">
                      ← HTTP {{ loginResult.attempt.status }}
                    </div>
                    <div v-else class="text-destructive">未收到任何响应——请求没发出去</div>
                    <div v-if="loginResult.attempt.responseBody" class="break-all">
                      响应正文：{{ loginResult.attempt.responseBody }}
                    </div>
                  </div>
                  <p
                    v-if="loginResult.attempt.status !== null"
                    class="text-[11px] leading-relaxed text-muted-foreground"
                  >
                    拿这个和真实登录页在浏览器 DevTools 的 Network 里发出的那条请求对一下：
                    地址、字段名、以及 <code class="font-mono">loginInfo</code> 解出来的内容
                    是否一致，不一致的地方就是要改的地方。
                  </p>
                </div>
              </AlertDescription>
            </Alert>

            <!-- 会话状态：空闲剩余时间是一直在走的，所以这里定时刷新 -->
            <div
              v-if="sessionStatus?.loggedIn"
              class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-2.5 py-2 text-[11px] text-muted-foreground"
            >
              <span class="inline-flex items-center gap-1.5">
                <span class="size-1.5 rounded-full bg-emerald-500" />
                已登录
              </span>
              <span v-if="sessionStatus.idleRemainingMinutes !== null">
                空闲剩余
                <span
                  class="tabular-nums"
                  :class="sessionStatus.idleRemainingMinutes < 2 && 'text-amber-600 dark:text-amber-500'"
                >
                  {{ sessionStatus.idleRemainingMinutes.toFixed(1) }} 分钟
                </span>
              </span>
              <span>探活{{ sessionStatus.keepAliveActive ? '运行中' : '未启用' }}</span>
              <span v-if="sessionStatus.lastError" class="text-destructive">
                最近失败：{{ sessionStatus.lastError }}
              </span>
            </div>
          </template>
        </div>

        <Separator />

        <div class="space-y-1.5">
          <div class="flex flex-wrap items-center gap-2">
            <DatePicker
              id="dr-test-date"
              v-model="testDate"
              class="h-8 w-40 text-xs"
            />
            <Button variant="outline" size="sm" :disabled="testing" @click="test">
              <Loader2Icon v-if="testing" :size="13" class="mr-1.5 animate-spin" />
              <CloudDownloadIcon v-else :size="13" class="mr-1.5" />
              拉取这一天的日报试试
            </Button>
          </div>
          <p class="text-[11px] text-muted-foreground">
            默认查<strong class="font-medium">昨天</strong>——日报是当天晚上才上报的，
            白天看今天永远是空的，拿它当「接口通不通」的判据会一直得出错误结论
          </p>
        </div>

        <Alert v-if="testResult" :variant="testResult.ok ? 'default' : 'destructive'">
          <CheckCircle2Icon v-if="testResult.ok" :size="14" class="text-emerald-600" />
          <XCircleIcon v-else :size="14" />
          <AlertDescription>
            <div>{{ testResult.message }}</div>
            <div v-if="testResult.preview" class="mt-1 text-[11px] opacity-80">
              首条解析结果：{{ testResult.preview }}
            </div>
          </AlertDescription>
        </Alert>
      </template>

      <Alert v-else-if="cfg.source === 'csv'">
        <AlertDescription>
          当前配置的数据来源是「本地 CSV」，但导入入口已经移除。请改选「日报系统接口」或「演示数据」——
          日报现在都是检查时直接从源系统拉取的，不再需要先导入。
        </AlertDescription>
      </Alert>

      <Alert v-else>
        <AlertDescription>
          当前使用内置演示数据（三位虚构成员的日报）。可以完整跑通检查流程，
          用来确认 GitLab 和模型配置是否正确。
        </AlertDescription>
      </Alert>
    </CardContent>
  </Card>
</template>
