<script setup lang="ts">
import type { GitCommit } from '@/core/domain/types'
import { computed } from 'vue'
import { ExternalLinkIcon, GitCommitHorizontalIcon } from '@lucide/vue'
import { openExternal } from '@/core/bridge'
import { formatDateTime } from '@/lib/format'

const props = defineProps<{
  commits: GitCommit[]
  /** 仓库 id → 日报项目名；有映射时按业务项目分组，而不是按仓库路径 */
  repoProjectNames?: Record<number, string>
}>()

/** 按业务项目分组；没有映射的仓库才退回按路径分组。 */
const grouped = computed(() => {
  const map = new Map<string, { name: string, paths: Set<string>, commits: GitCommit[], mapped: boolean }>()
  for (const c of props.commits) {
    const owner = props.repoProjectNames?.[c.projectId]
    const name = owner ?? c.projectPath
    const group = map.get(name) ?? { name, paths: new Set<string>(), commits: [], mapped: Boolean(owner) }
    group.paths.add(c.projectPath)
    group.commits.push(c)
    map.set(name, group)
  }
  return [...map.values()]
    .map(group => ({
      ...group,
      commits: group.commits.sort((a, b) => a.authoredDate.localeCompare(b.authoredDate)),
    }))
    .sort((a, b) => b.commits.length - a.commits.length)
})
</script>

<template>
  <div class="space-y-3">
    <p class="text-xs leading-relaxed text-muted-foreground">
      以下提交发生在这个时间窗内，但没有被任何一条日报内容引用。
      它们可能属于已申报项目的辅助工作（只是没被引用为证据），也可能是真正的漏报；
      项目整体是否未申报，以「项目对比」表为准。
    </p>

    <div v-for="group in grouped" :key="group.name" class="space-y-1.5">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <GitCommitHorizontalIcon :size="13" class="text-muted-foreground" />
        <span class="font-medium" :class="!group.mapped && 'font-mono'">
          {{ group.name }}
        </span>
        <span class="text-muted-foreground">{{ group.commits.length }} 个提交</span>
        <span
          v-if="group.mapped"
          class="truncate font-mono text-[11px] text-muted-foreground"
          :title="[...group.paths].join('、')"
        >
          {{ [...group.paths].join('、') }}
        </span>
      </div>

      <div class="ml-5 space-y-1">
        <button
          v-for="commit in group.commits"
          :key="commit.id"
          type="button"
          class="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left transition-colors hover:bg-accent"
          @click="openExternal(commit.webUrl)"
        >
          <span class="shrink-0 font-mono text-[11px] text-muted-foreground">{{ commit.shortId }}</span>
          <span class="min-w-0 flex-1 truncate text-xs">{{ commit.title }}</span>
          <span
            v-if="commit.branches?.length"
            class="shrink-0 font-mono text-[10px] text-muted-foreground"
            :title="`该提交所在分支：${commit.branches.join('、')}`"
          >
            {{ commit.branches.slice(0, 2).join(' / ') }}
          </span>
          <span class="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {{ formatDateTime(commit.authoredDate) }}
          </span>
          <ExternalLinkIcon :size="11" class="shrink-0 text-muted-foreground" />
        </button>
      </div>
    </div>
  </div>
</template>
