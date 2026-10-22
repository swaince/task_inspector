import type { ProjectProfile } from '../engine/profile'
import { transport } from '../bridge'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 项目画像的存取。
 *
 * 一个项目一条记录（repoId = 0 存整份画像 JSON）：画像本来就是整体生成的，
 * 按仓库拆开存只会让「项目级叙述」无处安放，读取时还要再拼回去。
 * 表结构保留 repo_id 是为了以后真要按仓库增量更新时不用再迁移。
 */
export const useProfileStore = defineStore('profiles', () => {
  const byProject = ref<Record<string, ProjectProfile | null>>({})
  const loading = ref(false)
  const generating = ref(false)
  const error = ref<string | null>(null)
  const progress = ref('')

  async function load(projectId: string) {
    loading.value = true
    error.value = null
    try {
      const rows = await transport().profilesGet(projectId)
      const row = rows.find(r => r.repoId === 0)
      byProject.value = {
        ...byProject.value,
        [projectId]: row ? JSON.parse(row.payload) as ProjectProfile : null,
      }
    }
    catch (err) {
      error.value = `读取项目画像失败：${err instanceof Error ? err.message : String(err)}`
    }
    finally {
      loading.value = false
    }
  }

  async function save(profile: ProjectProfile) {
    await transport().profileUpsert({
      projectId: profile.projectId,
      repoId: 0,
      headCommit: profile.headCommit,
      generatedAt: profile.generatedAt,
      payload: JSON.stringify(profile),
    })
    byProject.value = { ...byProject.value, [profile.projectId]: profile }
  }

  async function clear(projectId: string) {
    await transport().profilesDelete(projectId)
    byProject.value = { ...byProject.value, [projectId]: null }
  }

  return {
    byProject,
    loading,
    generating,
    error,
    progress,
    load,
    save,
    clear,
  }
})
