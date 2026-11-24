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
import { authService } from './auth'
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

/** 初始化 SDK（幂等：已初始化时 TMSDK 回调 -1011）。 */
export async function wemeetInit(
  account: WeMeetAccount,
  dataPath?: string,
): Promise<void> {
  return invoke('wemeet_init', {
    sdkId: account.sdkKey,
    sdkToken: account.sdkToken,
    dataPath: dataPath || null,
    appName: '网络会议',
    serverHost: null,
  })
}

export async function wemeetStatus(): Promise<boolean> {
  return invoke<boolean>('wemeet_status')
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

/** 当前登录态，供页面展示。 */
export function currentUserName(): string {
  return authService.getCurrentUserName?.() || ''
}
