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

export async function settingsGetAll(): Promise<SettingView[]> {
  return invoke<SettingView[]>('settings_get_all')
}

export async function settingsSet(key: string, value: string | null): Promise<void> {
  return invoke('settings_set', { key, value })
}
