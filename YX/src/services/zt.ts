/**
 * 零信任：只负责驱动本机官方客户端的 SDK。
 *
 * 官方客户端（/Applications/TrustAgentLauncher.app）会在 127.0.0.1:35440-35443
 * 起一个 JSON-RPC 服务，提供 login / logout / status / get_config 四个方法；
 * YX 把当前云上越秀的 AccessToken 交给它完成登录，隧道与内网路由由官方客户端负责。
 */
import { invoke } from '@tauri-apps/api/core'

export interface ZtSdkStatus {
  port: number
  /** online / offline / unknown */
  state: string
}

export async function ztSdkStatus(): Promise<ZtSdkStatus> {
  return invoke<ZtSdkStatus>('zt_sdk_status')
}

/** 用云上越秀的 AccessToken 登录零信任（host/port 默认 zt.yuexiu.com:443）。 */
export async function ztSdkLogin(
  userToken: string,
  host?: string,
  port?: number,
): Promise<string> {
  return invoke<string>('zt_sdk_login', { userToken, host, port })
}

export async function ztSdkLogout(): Promise<string> {
  return invoke<string>('zt_sdk_logout')
}

/** 网关支持的认证方式（YX_TOKEN / AD / LOCAL_UP），离线时可能失败。 */
export async function ztSdkAuthTypes(
  host?: string,
  port?: number,
): Promise<string[]> {
  return invoke<string[]>('zt_sdk_auth_types', { host, port })
}
