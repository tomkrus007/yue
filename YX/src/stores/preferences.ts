/**
 * 应用级本地配置（SQLite，不按账号隔离）。
 *
 * 提醒中心开关在接收 IM 消息时就要同步判断，所以启动时先加载一次并缓存在这里；
 * 页面只读这里的计算值，不要各自再查库。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { SETTING_KEYS, settingsGetAll, settingsSet, type SettingView } from '../services/settings'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const usePreferencesStore = defineStore('preferences', () => {
  const items = ref<Record<string, SettingView>>({})
  const loaded = ref(false)
  const error = ref('')
  let loading: Promise<void> | null = null

  function apply(rows: SettingView[]) {
    const next: Record<string, SettingView> = {}
    for (const row of rows) next[row.key] = row
    items.value = next
  }

  function effective(key: string): string | null {
    return items.value[key]?.effective ?? null
  }

  /** 加载一次；失败后允许下次重试。 */
  function load(): Promise<void> {
    if (loaded.value) return Promise.resolve()
    loading ??= settingsGetAll()
      .then((rows) => {
        apply(rows)
        loaded.value = true
        error.value = ''
      })
      .catch((reason) => {
        error.value = errorText(reason)
      })
      .finally(() => {
        loading = null
      })
    return loading
  }

  /** 写入后同步缓存，避免重新查库；传 null 表示恢复默认。 */
  async function update(key: string, value: string | null): Promise<void> {
    await settingsSet(key, value)
    const previous = items.value[key]
    items.value = {
      ...items.value,
      [key]: {
        key,
        value,
        default: previous?.default ?? null,
        effective: value ?? previous?.default ?? null,
      },
    }
  }

  const mentionCenter = computed(() => effective(SETTING_KEYS.mentionCenter) !== '0')
  const messageSound = computed(() => effective(SETTING_KEYS.messageSound) !== '0')
  const downloadDir = computed(() => effective(SETTING_KEYS.downloadDir) || '')
  const downloadDirDefault = computed(() => items.value[SETTING_KEYS.downloadDir]?.default || '')
  const downloadDirCustomized = computed(() => Boolean(items.value[SETTING_KEYS.downloadDir]?.value))
  const appOpenInBrowser = computed(() => effective(SETTING_KEYS.appOpenInBrowser) === '1')

  function setMentionCenter(enabled: boolean): Promise<void> {
    return update(SETTING_KEYS.mentionCenter, enabled ? '1' : '0')
  }

  function setMessageSound(enabled: boolean): Promise<void> {
    return update(SETTING_KEYS.messageSound, enabled ? '1' : '0')
  }

  function setDownloadDir(directory: string | null): Promise<void> {
    return update(SETTING_KEYS.downloadDir, directory?.trim() || null)
  }

  function setAppOpenInBrowser(enabled: boolean): Promise<void> {
    return update(SETTING_KEYS.appOpenInBrowser, enabled ? '1' : '0')
  }

  return {
    items,
    loaded,
    error,
    load,
    mentionCenter,
    messageSound,
    downloadDir,
    downloadDirDefault,
    downloadDirCustomized,
    appOpenInBrowser,
    setMentionCenter,
    setMessageSound,
    setDownloadDir,
    setAppOpenInBrowser,
  }
})
