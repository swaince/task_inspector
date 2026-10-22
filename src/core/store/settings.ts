import type { AnalysisDefaults } from '../bridge/types'
import type { AppSettings } from '../config/settings'
import { createDefaultSettings, SETTINGS_VERSION } from '../config/settings'
import { mergeSettings } from '../config/merge'
import { transport } from '../bridge'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'


/**
 * 配置 store。
 *
 * 落盘走传输层：桌面端存在本地 SQLite 的 settings 表（整体一行 JSON），
 * 浏览器开发态降级到 localStorage。
 * 加载时用 mergeSettings 补齐新增字段，避免升级后老配置缺键导致运行时崩。
 */
export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(createDefaultSettings())
  const loaded = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  /** 应用数据目录下的默认路径；浏览器模式拿不到就保持 null */
  const analysisDefaults = ref<AnalysisDefaults | null>(null)

  /**
   * 代码目录与缓存目录的**实际生效值**。
   *
   * 配置里留空表示「用默认位置」，而不是「没有」——默认值依赖运行时才知道的
   * 应用数据目录，写死在代码里既不跨平台也不利于迁移。
   */
  const resolvedCodeRoot = computed(() =>
    settings.value.analysis.codeRoot.trim() || analysisDefaults.value?.defaultCodeRoot || '',
  )
  const resolvedCacheDir = computed(() =>
    settings.value.analysis.cacheDir.trim() || analysisDefaults.value?.defaultCacheDir || '',
  )

  const configured = computed(() =>
    Boolean(settings.value.gitlab.baseUrl && settings.value.gitlab.token),
  )

  const llmConfigured = computed(() =>
    Boolean(settings.value.llm.model)
    && (settings.value.llm.provider === 'openai-compatible' || Boolean(settings.value.llm.apiKey)),
  )

  const ready = computed(() => configured.value)

  async function load() {
    if (loaded.value)
      return
    try {
      const raw = await transport().settingsGet()
      if (raw) {
        const saved = JSON.parse(raw) as Partial<AppSettings>
        const savedVersion = typeof saved.version === 'number' ? saved.version : 1

        settings.value = mergeSettings(saved)

        /*
         * 迁移过的配置要落盘。否则每次启动都在内存里重做一遍：
         * 设置页看到的是新接口，库里存的还是旧的，下次启动又得再迁一次，
         * 而且版本号永远停在旧值，用户后来手动改回去也会被再次覆盖。
         */
        if (savedVersion < SETTINGS_VERSION) {
          try {
            await save()
          }
          catch {
            // 落盘失败不阻塞启动，本次仍按迁移后的配置运行
          }
        }
      }
    }
    catch (err) {
      // 配置文件损坏时退回默认值继续启动，而不是白屏
      error.value = `配置读取失败，已使用默认配置：${err instanceof Error ? err.message : String(err)}`
      settings.value = createDefaultSettings()
    }
    finally {
      loaded.value = true
    }

    // 默认路径是运行时才知道的（应用数据目录），失败不影响主流程
    try {
      analysisDefaults.value = await transport().analysisDefaults()
    }
    catch {
      analysisDefaults.value = null
    }
  }

  async function save() {
    saving.value = true
    error.value = null
    try {
      await transport().settingsSet(JSON.stringify(settings.value, null, 2))
    }
    catch (err) {
      error.value = `配置保存失败：${err instanceof Error ? err.message : String(err)}`
      throw err
    }
    finally {
      saving.value = false
    }
  }

  /** 局部更新并立即落盘，设置页的每个控件都走这个。 */
  async function patch(updater: (draft: AppSettings) => void) {
    updater(settings.value)
    await save()
  }

  async function resetAll() {
    settings.value = createDefaultSettings()
    await save()
  }

  return {
    settings,
    loaded,
    saving,
    error,
    analysisDefaults,
    resolvedCodeRoot,
    resolvedCacheDir,
    configured,
    llmConfigured,
    ready,
    load,
    save,
    patch,
    resetAll,
  }
})
