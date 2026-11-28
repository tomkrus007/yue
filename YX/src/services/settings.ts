/**
 * 本地配置（SQLite）。
 *
 * 平台默认值由 Rust 按当前系统计算，库里只存用户覆盖值：
 * `effective = value ?? default`。写入 `null` / 空串表示恢复默认。
 */
import { invoke } from '@tauri-apps/api/core'

export interface SettingView {
  key: string
  value: string | null
  default: string | null
  effective: string | null
}

/** 前端用到的配置项 key，必须与 Rust `db.rs` 的 KNOWN_KEYS 保持一致。 */
export const SETTING_KEYS = {
  mentionCenter: 'ui.mention_center',
  messageSound: 'ui.message_sound',
  downloadDir: 'paths.download_dir',
  /** '1' = 应用用系统浏览器打开；缺省 = 内嵌窗口。 */
  appOpenInBrowser: 'ui.app_open_in_browser',
} as const

export async function settingsGetAll(): Promise<SettingView[]> {
  return invoke<SettingView[]>('settings_get_all')
}

export async function settingsSet(key: string, value: string | null): Promise<void> {
  return invoke('settings_set', { key, value })
}
