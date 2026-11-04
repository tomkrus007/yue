/**
 * 认证服务 —— OAuth2 password 模式 + RSA 加密密码
 * 逆向自 web/config.json + web/html/static/js/login.*.js + ssoService.js
 */
import JSEncrypt from 'jsencrypt'
import { fetch } from '@tauri-apps/plugin-http'
import { DEFAULT_CONFIG, STORAGE_KEYS, type AppConfig } from './config'

export interface LoginResult {
  mode: 'ok' | 'fail'
  access_token: string
  refresh_token: string
  expires_in: number
  uid: string
  identity?: string
  cipher_token?: string
  error?: string
}

export interface UserInfo {
  id: string
  name: string
  eCode?: string
  mobile?: string
  orgName?: string
  deptName?: string
}

const PLATFORM = (() => {
  if (typeof navigator === 'undefined') return 'Mac'
  const ua = navigator.userAgent.toLowerCase()
  if (/macintosh|mac os x/.test(ua)) return 'Mac'
  if (/windows/.test(ua)) return 'Windows'
  return 'Linux'
})()

function genDeviceId(): string {
  // 简单 UUID（原版用 serial-number 模块取设备序列号，这里用随机 UUID）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export class AuthService {
  config: AppConfig

  constructor(config: AppConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  /** 用 RSA 公钥加密密码 */
  encryptPassword(password: string): string {
    const encrypt = new JSEncrypt()
    encrypt.setPublicKey(this.config.rsaPublicKey)
    const enc = encrypt.encrypt(password)
    if (!enc) throw new Error('RSA 加密失败，请检查公钥配置')
    return enc
  }

  /** 构造登录用户名（自动补后缀） */
  buildUsername(username: string): string {
    if (username.includes('@')) return username
    return username + this.config.loginNameSuffix
  }

  /**
   * OAuth2 登录（两步流程，逆向自 applicationInfo.js loginByPassword + getV3AccessTokenByV2）
   *
   * 第一步：POST /oauth2/token  grant_type=password
   *   → v2 响应：{ "ex.oauth_access_token": "...", "ex.uid": "...", identity: {...} }
   * 第二步：POST /oauth2/token  grant_type=token_client_credentials&access_token=<v2 token>
   *   → v3 响应：{ access_token, refresh_token, expires_in, cipher_token }
   */
  async login(username: string, password: string): Promise<LoginResult> {
    const basicAuth = 'Basic ' + btoa(this.config.clientId + ':' + this.config.clientSecret)
    const commonHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuth,
      'X-Requested-With': 'XMLHttpRequest',
      'ClientType': 'pc',
      'LoginMode': 'manual',
    }
    const url = this.config.ssoUrl + '/oauth2/token'

    // ---- 第一步：password grant ----
    const encPwd = this.encryptPassword(password)
    const body1 = new URLSearchParams({
      grant_type: 'password',
      username: this.buildUsername(username),
      password: encPwd,
      encrypt_type: 'rsa',
      randomCode: '',
      pageKey: '',
    })
    const resp1 = await fetch(url, { method: 'POST', headers: commonHeaders, body: body1.toString() })
    const text1 = await resp1.text()
    console.log('[登录] 第一步 HTTP', resp1.status, '响应:', text1)
    let j1: any
    try { j1 = JSON.parse(text1) } catch {
      throw new Error(`登录第一步响应解析失败 (HTTP ${resp1.status}): ${text1.slice(0, 300)}`)
    }

    // 兼容：若服务端直接返回 v3 access_token，跳过第二步
    if (j1.access_token) {
      return this.finalizeLogin(j1)
    }

    // v2 响应：取 ex.oauth_access_token
    const v2Token = j1['ex.oauth_access_token'] || (j1.ex && j1.ex.oauth_access_token)
    if (!v2Token) {
      return {
        mode: 'fail', access_token: '', refresh_token: '', expires_in: 0, uid: '',
        error: j1.error_description || j1.error || j1.message || `HTTP ${resp1.status}`,
      }
    }

    // ---- 第二步：token_client_credentials 换 v3 ----
    const body2 = new URLSearchParams({
      grant_type: 'token_client_credentials',
      access_token: v2Token,
    })
    const resp2 = await fetch(url, { method: 'POST', headers: commonHeaders, body: body2.toString() })
    const text2 = await resp2.text()
    console.log('[登录] 第二步 HTTP', resp2.status, '响应:', text2)
    let j2: any
    try { j2 = JSON.parse(text2) } catch {
      throw new Error(`登录第二步响应解析失败 (HTTP ${resp2.status}): ${text2.slice(0, 300)}`)
    }

    if (!j2.access_token) {
      return {
        mode: 'fail', access_token: '', refresh_token: '', expires_in: 0, uid: '',
        error: j2.error_description || j2.error || `第二步 HTTP ${resp2.status}`,
      }
    }

    // 补 uid/identity（来自第一步）
    j2.uid = j2.uid || j1['ex.uid'] || (j1.ex && j1.ex.uid) || ''
    j2.identity = j2.identity || j1.identity
    return this.finalizeLogin(j2)
  }

  /** 组装最终 LoginResult 并持久化 */
  private finalizeLogin(json: any): LoginResult {
    const result: LoginResult = {
      mode: 'ok',
      access_token: json.access_token,
      refresh_token: json.refresh_token || '',
      expires_in: Number(json.expires_in) || 0,
      uid: String(json.uid || json['ex.uid'] || ''),
      identity: json.identity,
      cipher_token: json.cipher_token,
    }
    this.persistTokens(result)
    return result
  }

  /** 持久化 token */
  persistTokens(r: LoginResult): void {
    const deviceId = localStorage.getItem(STORAGE_KEYS.deviceId) || genDeviceId()
    localStorage.setItem(STORAGE_KEYS.deviceId, deviceId)
    localStorage.setItem(STORAGE_KEYS.accessToken, r.access_token)
    localStorage.setItem(STORAGE_KEYS.authAccessToken, r.access_token)
    localStorage.setItem(STORAGE_KEYS.refreshToken, r.refresh_token)
    localStorage.setItem(STORAGE_KEYS.currentUserId, r.uid)
    localStorage.setItem(
      STORAGE_KEYS.expiresAt,
      String(Date.now() + r.expires_in * 1000),
    )
  }

  /** 刷新 token */
  async refreshToken(): Promise<string | null> {
    const refreshToken = localStorage.getItem(STORAGE_KEYS.refreshToken)
    if (!refreshToken) return null

    const basicAuth = 'Basic ' + btoa(this.config.clientId + ':' + this.config.clientSecret)
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })

    try {
      const resp = await fetch(this.config.ssoUrl + '/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': basicAuth,
          'X-Requested-With': 'XMLHttpRequest',
          'ClientType': 'pc',
          'LoginMode': 'manual',
        },
        body: body.toString(),
      })
      const json = await resp.json()
      if (json.access_token) {
        localStorage.setItem(STORAGE_KEYS.accessToken, json.access_token)
        localStorage.setItem(STORAGE_KEYS.authAccessToken, json.access_token)
        if (json.refresh_token)
          localStorage.setItem(STORAGE_KEYS.refreshToken, json.refresh_token)
        localStorage.setItem(
          STORAGE_KEYS.expiresAt,
          String(Date.now() + (json.expires_in || 0) * 1000),
        )
        return json.access_token
      }
    } catch (e) {
      console.error('刷新 token 失败', e)
    }
    return null
  }

  getAccessToken(): string {
    return localStorage.getItem(STORAGE_KEYS.accessToken) || ''
  }

  getCurrentUserId(): string {
    return localStorage.getItem(STORAGE_KEYS.currentUserId) || ''
  }

  /** 当前用户名（用于消息 from_name，绝不返回空） */
  getCurrentUserName(): string {
    return (
      localStorage.getItem(STORAGE_KEYS.currentUserName) ||
      localStorage.getItem('CurrentEName') ||
      localStorage.getItem('CurrentECode') ||
      this.getCurrentUserId()
    )
  }

  /** 写入用户名（登录成功/回退时调用） */
  setCurrentUserName(name: string): void {
    if (name) localStorage.setItem(STORAGE_KEYS.currentUserName, name)
  }

  getDeviceId(): string {
    return localStorage.getItem(STORAGE_KEYS.deviceId) || ''
  }

  getPlatform(): string {
    return PLATFORM
  }

  isLoggedIn(): boolean {
    const token = this.getAccessToken()
    if (!token) return false
    const expiresAt = Number(localStorage.getItem(STORAGE_KEYS.expiresAt) || 0)
    // expiresAt=0 表示未拿到过期时间（如服务端未返回 expires_in），只要有 token 即视为登录
    if (!expiresAt) return true
    return Date.now() < expiresAt
  }

  logout(): void {
    localStorage.removeItem(STORAGE_KEYS.accessToken)
    localStorage.removeItem(STORAGE_KEYS.authAccessToken)
    localStorage.removeItem(STORAGE_KEYS.refreshToken)
    localStorage.removeItem(STORAGE_KEYS.currentUserId)
    localStorage.removeItem(STORAGE_KEYS.currentUserName)
    localStorage.removeItem(STORAGE_KEYS.expiresAt)
  }

  /**
   * 获取当前用户信息
   * GET {uamApiUrl}/users/me 或类似端点
   */
  async getCurrentUser(): Promise<UserInfo> {
    const uid = this.getCurrentUserId()
    const base = (
      localStorage.getItem('uamApiUri') || this.config.uamApiUrl
    ).replace(/\/+$/, '')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    let resp: Response
    try {
      resp = await fetch(`${base}/v2/users/${uid}/details`, {
        headers: this.authHeaders(),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!resp.ok) throw new Error(`获取用户信息失败: HTTP ${resp.status}`)
    const json = await resp.json()
    const data = json && json.code === 200 ? json.data || json : json
    const user: UserInfo = {
      id: String(data.userId || data.id || uid),
      name: data.name || data.userName || data.displayName || uid,
      eCode: data.eCode,
      mobile: data.mobile,
      orgName: data.orgName,
      deptName: data.deptName,
    }
    localStorage.setItem(STORAGE_KEYS.currentUserName, user.name)
    if (user.eCode) localStorage.setItem('CurrentECode', user.eCode)
    const orgId = data.orgId || data.org_id
    if (orgId) localStorage.setItem('CurrentUserOrgId', String(orgId))
    const orgName = data.orgName || data.org_name
    if (orgName) localStorage.setItem('CurrentUserOrgName', String(orgName))
    return user
  }

  /** 网盘/IM 通用请求头 */
  authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: 'Bearer ' + this.getAccessToken(),
      ClientType: 'pc',
      LoginMode: 'manual',
      ...extra,
    }
  }
}

export const authService = new AuthService()
