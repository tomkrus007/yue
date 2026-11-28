/** 全局界面状态：目前只有设置弹层，由左侧导航「更多 → 设置」打开。 */
import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useUiStore = defineStore('ui', () => {
  const settingsOpen = ref(false)

  function openSettings() {
    settingsOpen.value = true
  }

  function closeSettings() {
    settingsOpen.value = false
  }

  return { settingsOpen, openSettings, closeSettings }
})
