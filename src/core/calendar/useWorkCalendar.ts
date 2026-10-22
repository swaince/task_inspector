import { computed } from 'vue'
import { useSettingsStore } from '../store/settings'
import { createCalendar } from './workCalendar'

/**
 * 读取当前生效的工作日历。
 *
 * 日历来自配置，配置一变就重新解析；页面只需要问「这天是不是工作日」。
 */
export function useWorkCalendar() {
  const settingsStore = useSettingsStore()
  const calendar = computed(() => createCalendar(settingsStore.settings.workCalendar))

  return {
    calendar,
    isWorkday: (date: string) => calendar.value.isWorkday(date),
    dayInfo: (date: string) => calendar.value.dayInfo(date),
    workdaysInRange: (from: string, to: string) => calendar.value.workdaysInRange(from, to),
  }
}
