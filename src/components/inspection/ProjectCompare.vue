<script setup lang="ts">
import type { EntryInspection, GitCommit, VerdictLevel } from '@/core/domain/types'
import { computed, onMounted } from 'vue'
import { needsFollowUp, VERDICT_META, VERDICT_ORDER } from '@/core/domain/verdict'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useProjectStore } from '@/core/store/projects'

/**
 * 项目维度对比。
 *
 * 把「日报申报」和「实际提交」按项目并排放，一眼能看出两类偏差：
 * - 报了但没提交（可能确实在做别的，也可能是虚报）；
 * - 提交了但没有被日报条目引用（信息性，可能是漏报）。
 *
 * 一个业务项目可能关联多个仓库。未被条目引用的提交先尝试归回它所属的业务项目；
 * 只有归不回去的仓库才按路径单独列一行，避免把「项目里的另一个仓库」误显示成另一个项目。
 */
const props = defineProps<{
  entries: EntryInspection[]
  orphanCommits: GitCommit[]
  /** 仓库 id → 日报项目名，用于把提交归回业务项目 */
  repoProjectNames?: Record<number, string>
}>()

const projectStore = useProjectStore()
onMounted(() => projectStore.load())

/**
 * 旧检查结果没有 repoProjectNames，用项目实体再兜一层：
 * 直接关联的仓库能通过 repos / gitlabProjectId 找回来。
 * 分组关联的仓库只有检查时的解析结果知道归属，因此新结果优先用 meta 里的映射。
 */
const repoOwners = computed(() => {
  const map = new Map<number, string>()
  for (const project of projectStore.items) {
    if (project.gitlabProjectId != null)
      map.set(project.gitlabProjectId, project.name)
    for (const repo of project.repos ?? [])
      map.set(repo.id, project.name)
  }
  return map
})

function projectNameOf(commit: GitCommit) {
  return props.repoProjectNames?.[commit.projectId] ?? repoOwners.value.get(commit.projectId)
}

interface Row {
  key: string
  name: string
  entryCount: number
  hours: number
  commits: number
  /** 属于该项目、但没有被日报条目引用的提交数（信息性，不等于漏报） */
  uncited: number
  counts: Record<VerdictLevel, number>
  evidence: Record<'strong' | 'medium' | 'weak' | 'none', number>
  reason: string
  attention: boolean
  orphan: boolean
  /** 项目没映射到仓库：无法核对，也不计入得分 */
  unresolved: boolean
  /** 条目属于会议/评审等非编码工作，不要求提交 */
  nonCoding: boolean
}

const rows = computed<Row[]>(() => {
  const map = new Map<string, Row>()

  for (const entry of props.entries) {
    const name = entry.projectName || '未填写项目'
    let row = map.get(name)
    if (!row) {
      row = {
        key: name,
        name,
        entryCount: 0,
        hours: 0,
        commits: 0,
        uncited: 0,
        counts: { matched: 0, partial: 0, mismatched: 0, 'no-commit': 0, unverified: 0 },
        evidence: { strong: 0, medium: 0, weak: 0, none: 0 },
        reason: '',
        attention: false,
        orphan: false,
        unresolved: false,
        nonCoding: false,
      }
      map.set(name, row)
    }
    row.entryCount++
    row.hours += entry.hours
    row.counts[entry.verdict] = (row.counts[entry.verdict] ?? 0) + 1
    const strength = entry.evidenceStrength ?? 'none'
    row.evidence[strength]++
    if (entry.projectUnresolved)
      row.unresolved = true
    if (entry.nonCodingWork)
      row.nonCoding = true
    if (needsFollowUp(entry)) {
      row.attention = true
      if (!row.reason)
        row.reason = entry.reason
    }
    else if (!row.reason && entry.projectUnresolved) {
      row.reason = '项目未映射到 GitLab 仓库，无法核对（不计入得分）'
    }
    else if (!row.reason && entry.nonCodingWork) {
      row.reason = '非编码工作，不要求提交（不计入得分）'
    }
  }

  // 命中的提交按 commitId 去重后挂到项目上
  const commitsByProject = new Map<string, Set<string>>()
  for (const entry of props.entries) {
    const name = entry.projectName || '未填写项目'
    let set = commitsByProject.get(name)
    if (!set) {
      set = new Set()
      commitsByProject.set(name, set)
    }
    for (const ev of entry.evidence ?? [])
      set.add(ev.commitId)
  }
  for (const [name, set] of commitsByProject) {
    const row = map.get(name)
    if (row)
      row.commits = set.size
  }

  // 未被条目引用的提交：能归回已申报的项目就并进那一行，
  // 归不回去的（仓库没有对应的日报项目）才单独成行。
  const orphanGroups = new Map<string, { name: string, commits: GitCommit[], mapped: boolean }>()
  for (const commit of props.orphanCommits) {
    const owner = projectNameOf(commit)
    const existing = owner ? map.get(owner) : undefined
    if (existing) {
      existing.uncited++
      continue
    }

    const key = owner ?? commit.projectPath
    const group = orphanGroups.get(key) ?? { name: key, commits: [], mapped: Boolean(owner) }
    group.commits.push(commit)
    orphanGroups.set(key, group)
  }

  for (const [key, group] of orphanGroups) {
    const paths = [...new Set(group.commits.map(c => c.projectPath))]
    const example = group.commits[0]?.title ? `，例如：${group.commits[0].title}` : ''
    map.set(`orphan:${key}`, {
      key: `orphan:${key}`,
      name: group.name,
      entryCount: 0,
      hours: 0,
      commits: group.commits.length,
      uncited: 0,
      counts: { matched: 0, partial: 0, mismatched: 0, 'no-commit': 0, unverified: 0 },
      evidence: { strong: 0, medium: 0, weak: 0, none: 0 },
      reason: group.mapped
        ? `日报未提及该项目，提交来自 ${paths.join('、')}${example}`
        : `日报未提及该仓库${example}`,
      attention: true,
      orphan: true,
      unresolved: false,
      nonCoding: false,
    })
  }

  return [...map.values()]
    .map(row => ({ ...row, hours: Math.round(row.hours * 10) / 10 }))
    .sort((a, b) => Number(b.attention) - Number(a.attention) || b.hours - a.hours || a.name.localeCompare(b.name, 'zh-Hans-CN'))
})

function verdictChips(row: Row) {
  return VERDICT_ORDER
    .filter(v => row.counts[v] > 0)
    .map(v => ({ verdict: v, meta: VERDICT_META[v], count: row.counts[v] }))
}

function evidenceText(row: Row) {
  const parts: Array<{ label: string, count: number, cls: string }> = [
    { label: '充分', count: row.evidence.strong, cls: 'text-emerald-700 dark:text-emerald-400' },
    { label: '一般', count: row.evidence.medium, cls: 'text-amber-700 dark:text-amber-400' },
    { label: '薄弱', count: row.evidence.weak, cls: 'text-red-700 dark:text-red-400' },
    { label: '无', count: row.evidence.none, cls: 'text-muted-foreground' },
  ]
  return parts.filter(p => p.count > 0)
}
</script>

<template>
  <div v-if="rows.length" class="table-expand overflow-x-auto">
    <Table>
      <TableHeader>
        <TableRow class="hover:bg-transparent">
          <TableHead class="h-8 min-w-[8rem]">项目</TableHead>
          <TableHead class="h-8 w-20 text-right">申报工时</TableHead>
          <TableHead class="h-8 w-16 text-right">提交</TableHead>
          <TableHead class="h-8 min-w-[8rem]">判定</TableHead>
          <TableHead class="h-8 w-24">证据</TableHead>
          <TableHead class="h-8 min-w-[10rem]">需关注</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="row in rows" :key="row.key">
          <TableCell class="max-w-[16rem] py-2">
            <div class="flex items-center gap-1.5">
              <span
                v-if="row.attention"
                class="size-1.5 shrink-0 rounded-full"
                :style="{ backgroundColor: row.orphan ? 'var(--verdict-partial)' : 'var(--verdict-mismatched)' }"
              />
              <span class="truncate text-xs font-medium" :title="row.name">{{ row.name }}</span>
            </div>
            <div class="mt-0.5 text-[11px] text-muted-foreground">
              <template v-if="row.orphan">
                日报未提及
              </template>
              <template v-else>
                {{ row.entryCount }} 条日报
                <template v-if="row.unresolved"> · 项目未映射</template>
                <template v-else-if="row.nonCoding"> · 非编码工作</template>
              </template>
            </div>
          </TableCell>

          <TableCell class="text-right text-xs tabular-nums">
            {{ row.hours > 0 ? `${row.hours}h` : '—' }}
          </TableCell>

          <TableCell class="text-right text-xs tabular-nums">
            {{ row.commits }}
          </TableCell>

          <TableCell class="py-2">
            <div v-if="row.orphan" class="flex flex-wrap gap-1">
              <span
                class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
                :style="{
                  color: 'var(--verdict-partial)',
                  backgroundColor: 'color-mix(in oklab, var(--verdict-partial) 12%, transparent)',
                }"
              >
                未写进日报
              </span>
            </div>
            <div v-else class="flex flex-wrap gap-1">
              <span
                v-for="chip in verdictChips(row)"
                :key="chip.verdict"
                class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
                :style="{
                  color: chip.meta.color,
                  backgroundColor: `color-mix(in oklab, ${chip.meta.color} 12%, transparent)`,
                }"
                :title="chip.meta.description"
              >
                <span class="size-1.5 rounded-full" :style="{ backgroundColor: chip.meta.color }" />
                {{ chip.meta.label }} {{ chip.count }}
              </span>
            </div>
          </TableCell>

          <TableCell class="text-[11px]">
            <div class="flex flex-wrap gap-x-2">
              <span v-for="part in evidenceText(row)" :key="part.label" :class="part.cls">
                {{ part.label }} {{ part.count }}
              </span>
              <span v-if="!evidenceText(row).length" class="text-muted-foreground">—</span>
            </div>
          </TableCell>

          <TableCell class="max-w-[20rem] py-2 text-[11px] text-muted-foreground">
            <div v-if="row.reason" class="line-clamp-2" :title="row.reason">{{ row.reason }}</div>
            <div
              v-if="row.uncited"
              :class="row.reason ? 'mt-0.5' : ''"
              title="这些提交属于已申报的项目，只是没有被任何日报条目引用；不等于整个项目漏报"
            >
              另有 {{ row.uncited }} 个提交未被日报条目引用
            </div>
            <span v-if="!row.reason && !row.uncited">—</span>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
