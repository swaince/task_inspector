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
 *
 * 读取、生成、进度和错误全部按 projectId 分开存。
 * 之前这些是全局单例：在 A 项目生成画像时切到 B，B 会继承 A 的
 * 「正在分析 xxx」状态，看起来像在分析另一个系统；生成完成时也会把
 * A 的进度写到 B 的页面上。按项目分开后，跨项目切换互不影响。
 */
export const useProfileStore = defineStore('profiles', () => {
  const byProject = ref<Record<string, ProjectProfile | null>>({})
  const loadingByProject = ref<Record<string, boolean>>({})
  const generatingByProject = ref<Record<string, boolean>>({})
  const progressByProject = ref<Record<string, string>>({})
  const errorByProject = ref<Record<string, string | null>>({})

  function setLoading(projectId: string, value: boolean) {
    loadingByProject.value = { ...loadingByProject.value, [projectId]: value }
  }

  function setGenerating(projectId: string, value: boolean) {
    generatingByProject.value = { ...generatingByProject.value, [projectId]: value }
  }

  function setProgress(projectId: string, value: string) {
    progressByProject.value = { ...progressByProject.value, [projectId]: value }
  }

  function setError(projectId: string, value: string | null) {
    errorByProject.value = { ...errorByProject.value, [projectId]: value }
  }

  async function load(projectId: string) {
    setLoading(projectId, true)
    setError(projectId, null)
    try {
      const rows = await transport().profilesGet(projectId)
      const row = rows.find(r => r.repoId === 0)
      byProject.value = {
        ...byProject.value,
        [projectId]: row ? JSON.parse(row.payload) as ProjectProfile : null,
      }
    }
    catch (err) {
      setError(projectId, `读取项目画像失败：${err instanceof Error ? err.message : String(err)}`)
    }
    finally {
      setLoading(projectId, false)
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
    setGenerating(projectId, false)
    setProgress(projectId, '')
    setError(projectId, null)
  }

  /** 开始生成：只影响目标项目，切到别的项目不会继承进度 */
  function beginGenerate(projectId: string) {
    setGenerating(projectId, true)
    setProgress(projectId, '正在读取 skill…')
    setError(projectId, null)
  }

  function finishGenerate(projectId: string, error?: string) {
    setGenerating(projectId, false)
    setProgress(projectId, '')
    setError(projectId, error ?? null)
  }

  return {
    byProject,
    loadingByProject,
    generatingByProject,
    progressByProject,
    errorByProject,
    load,
    save,
    clear,
    beginGenerate,
    setProgress,
    finishGenerate,
  }
})
