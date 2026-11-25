/**
 * 腾讯会议（TMSDK）P0 验证接口。
 *
 * 账号配置来自配置中心的 `rtcUri`：
 *   GET {rtcUri}v1/tencent/meeting/config → { sdkKey, sdkToken, ssoUrlPrefix, idToken }
 * 官方客户端的流程是 InitWemeetSDK(sdkId, sdkToken, ...) → Login(ssoUrlPrefix + idToken)。
 *
 * 原生调用全部在 Rust 主线程执行（TMSDK 的窗口依赖 AppKit run loop），事件通过
 * `wemeet-event` 回传。
 */
import { invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { listen } from '@tauri-apps/api/event'
import { getServerPaths } from './config'
import { httpJson } from './http'

export interface WeMeetAccount {
  sdkKey: string
  sdkToken: string
  ssoUrlPrefix: string
  idToken: string
}

export interface WeMeetEvent {
  func: string
  code: string
  msg: string
  service?: string
  param?: string
}

/**
 * 会议组件（TMSDK.framework）状态。
 * - `ready`：已装好并加载成功；
 * - `absent`：本机有该平台能力但组件缺失，需要安装；
 * - `unsupported`：本平台没有可用的会议组件（如 Windows）。
 */
export interface WeMeetComponentStatus {
  state: 'ready' | 'absent' | 'unsupported'
  version: string | null
  path: string | null
  error: string | null
}

/** 查询组件是否已安装；`absent` 时前端提示安装。 */
export async function wemeetComponentStatus(): Promise<WeMeetComponentStatus> {
  return invoke<WeMeetComponentStatus>('wemeet_component_status')
}

/** 拉取腾讯会议账号配置。`rtcUri` 缺省时用配置中心下发的值。 */
export async function fetchWeMeetAccount(rtcUri?: string): Promise<WeMeetAccount> {
  const base = (rtcUri || getServerPaths().rtcUri || '').trim()
  if (!base) {
    throw new Error(
      '配置中心未下发 rtcUri，请在页面上手动填写会议服务地址后重试',
    )
  }
  const json = await httpJson<any>(
    base.replace(/\/+$/, '') + '/v1/tencent/meeting/config',
  )
  // 服务端统一包了 { code, data, msg }
  const data = json && typeof json === 'object' && json.data ? json.data : json
  if (!data || !data.sdkKey || !data.sdkToken) {
    throw new Error(
      `会议配置不可用：${JSON.stringify(json).slice(0, 300)}`,
    )
  }
  return {
    sdkKey: String(data.sdkKey || ''),
    sdkToken: String(data.sdkToken || ''),
    ssoUrlPrefix: String(data.ssoUrlPrefix || ''),
    idToken: String(data.idToken || ''),
  }
}

/** 初始化 SDK（幂等：已初始化时 TMSDK 回调 -1011）。缓存目录由 Rust 按 userId 隔离。 */
export async function wemeetInit(
  account: WeMeetAccount,
  userId?: string,
): Promise<void> {
  return invoke('wemeet_init', {
    sdkId: account.sdkKey,
    sdkToken: account.sdkToken,
    userId: userId || null,
    appName: '网络会议',
    serverHost: null,
  })
}

export async function wemeetStatus(): Promise<boolean> {
  return invoke<boolean>('wemeet_status')
}

/** SDK 是否已经登录（进程内状态，不发起网络请求）。 */
export async function wemeetIsLoggedIn(): Promise<boolean> {
  return invoke<boolean>('wemeet_is_logged_in')
}

export async function wemeetRefreshToken(sdkToken: string): Promise<void> {
  return invoke('wemeet_refresh_token', { sdkToken })
}

export async function wemeetLogin(ssoUrl: string): Promise<void> {
  return invoke('wemeet_login', { ssoUrl })
}

export async function wemeetShowHome(): Promise<void> {
  return invoke('wemeet_show_home')
}

export async function wemeetQuick(windowTitle?: string): Promise<void> {
  return invoke('wemeet_quick', { windowTitle: windowTitle || null })
}

export async function wemeetJoin(
  meetingCode: string,
  displayName: string,
): Promise<void> {
  return invoke('wemeet_join', {
    meetingCode,
    displayName,
    password: '',
    micOn: false,
    cameraOn: false,
    faceBeautyOn: false,
  })
}

export async function wemeetBringTop(): Promise<void> {
  return invoke('wemeet_bring_top')
}

/** 让 SDK 自绘响铃接听窗口（`OnRingInvitationEvent` 仍会回传事件）。 */
export async function wemeetEnableRing(enabled: boolean): Promise<void> {
  return invoke('wemeet_enable_ring', { enabled })
}

/** 退出登录后清理该账号在 `{app_cache}/{uid}/wemeet_cache` 下的会议缓存。 */
export async function wemeetPurgeCache(userId: string): Promise<void> {
  return invoke('wemeet_purge_cache', { userId })
}

export async function wemeetLogout(): Promise<void> {
  return invoke('wemeet_logout')
}

export async function wemeetRelease(): Promise<void> {
  return invoke('wemeet_release')
}

/** 订阅原生事件；回调里收到的是 JSON 字符串。 */
export async function listenWeMeetEvent(
  handler: (event: WeMeetEvent) => void,
): Promise<UnlistenFn> {
  return listen<string>('wemeet-event', (e) => {
    try {
      handler(JSON.parse(e.payload))
    } catch {
      handler({ func: 'Raw', code: '', msg: String(e.payload) })
    }
  })
}
