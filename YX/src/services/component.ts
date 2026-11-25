/**
 * 会议组件（`TMSDK.framework`）的安装状态与安装入口。
 *
 * 组件包是一份 `TMSDK-<ver>-macos-arm64.tar.zst`，本地文件与网络下载走同一套
 * 解压/校验/落位/重签流程（见 `doc/TMSDK组件化与跨平台设计.md`）。
 */
import { invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { listen } from '@tauri-apps/api/event'

export interface ComponentStatus {
  /** ready：可用；absent：缺失可安装；unsupported：本平台没有；installing：安装中 */
  state: 'ready' | 'absent' | 'unsupported' | 'installing'
  version: string | null
  path: string | null
  error: string | null
  installed_bytes: number
  cached_archive: string | null
  cached_bytes: number
}

export type ComponentPhase =
  | 'download'
  | 'extract'
  | 'verify'
  | 'install'
  | 'sign'
  | 'cache'
  | 'load'
  | 'done'

export interface ComponentProgress {
  phase: ComponentPhase
  received: number | null
  total: number | null
  message: string | null
}

export async function componentStatus(): Promise<ComponentStatus> {
  return invoke<ComponentStatus>('component_status')
}

/** 安装本地组件包（用户在文件选择器里选出的真实路径）。 */
export async function componentInstallLocal(path: string): Promise<ComponentStatus> {
  return invoke<ComponentStatus>('component_install_local', { path })
}

/** 从 URL 下载并安装；不传则用配置库里的默认地址。 */
export async function componentInstallUrl(url?: string): Promise<ComponentStatus> {
  return invoke<ComponentStatus>('component_install_url', { url: url || null })
}

export async function componentCancel(): Promise<void> {
  return invoke('component_cancel')
}

/** 清掉组件包缓存，返回释放的字节数（已安装的框架不动）。 */
export async function componentClearCache(): Promise<number> {
  return invoke<number>('component_clear_cache')
}

export async function componentReload(): Promise<ComponentStatus> {
  return invoke<ComponentStatus>('component_reload')
}

export async function listenComponentProgress(
  handler: (progress: ComponentProgress) => void,
): Promise<UnlistenFn> {
  return listen<ComponentProgress>('component-progress', (event) => handler(event.payload))
}
