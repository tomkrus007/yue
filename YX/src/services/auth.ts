/**
 * 认证服务 —— OAuth2 password 模式 + RSA 加密密码
 * 逆向自 web/config.json + web/html/static/js/login.*.js + ssoService.js
 */
import JSEncrypt from 'jsencrypt'
import { fetch } from '@tauri-apps/plugin-http'
import { decodeSavedPassword, loadCreds } from './credentials'
import {
  DEFAULT_CONFIG,
  STORAGE_KEYS,
  getServerPaths,
  saveServerPaths,
  type AppConfig,
  type ServerPaths,
} from './config'

/**
 * 从配置中心拉服务地址表。
 * 配置中心的凭据写在 URL userinfo 或 microServiceAuth 里（Basic）。
 * 失败不阻断登录，调用方回落到内置地址。
 */
export async function fetchServerPaths(): Promise<ServerPaths> {
  const raw =
    localStorage.getItem('microServiceUrl') || DEFAULT_CONFIG.microServiceUrl
  let url = raw
  let basic = ''
  try {
    const u = new URL(raw)
    if (u.username) {
      basic = btoa(
        decodeURIComponent(u.username) +
          ':' +
          decodeURIComponent(u.password || ''),
      )
      u.username = ''
      u.password = ''
      url = u.toString()
    }
  } catch {
    /* 保留原值 */
  }
  if (!basic) {
    basic = btoa(DEFAULT_CONFIG.microServiceAuth)
  }
  const resp = await fetch(url, {
    headers: { Authorization: 'Basic ' + basic },
  })
  if (!resp.ok) throw new Error(`配置中心返回 HTTP ${resp.status}`)
  const json = await resp.json()
  const data =
    json && typeof json === 'object' && json.data && typeof json.data === 'object'
      ? json.data
      : json
  saveServerPaths(data || {})
  return (data || {}) as ServerPaths
}

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

export interface RefreshResult {
  token: string | null
  /** true = 服务端明确拒绝了凭证（需要重新登录）；网络错误等可重试情况为 false */
  invalid: boolean
}

export class AuthService {
  private refreshing: { key: string; promise: Promise<RefreshResult> } | null = null
  private relogining: Promise<string | null> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private autoRefreshBound = false
  private sessionListeners = new Set<() => void>()
  config: AppConfig

  constructor(config: AppConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  /** 登录态变化（登录 / 续期 / 重登 / 登出）时回调，供 store 同步 token 与过期时间 */
  onSessionChange(fn: () => void): () => void {
    this.sessionListeners.add(fn)
    return () => this.sessionListeners.delete(fn)
  }

  private notifySession(): void {
    for (const fn of this.sessionListeners) {
      try {
        fn()
      } catch (e) {
        console.error('同步登录态失败', e)
      }
    }
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
  async login(
    username: string,
    password: string,
    mode: 'manual' | 'auto' = 'manual',
  ): Promise<LoginResult> {
    // 先拿真实服务地址；失败时用内置默认，不阻断登录
    try {
      await fetchServerPaths()
    } catch (e) {
      console.warn('[登录] 配置中心不可用，使用内置地址', e)
    }
    const paths = getServerPaths()
    const basicAuth = 'Basic ' + btoa(this.config.clientId + ':' + this.config.clientSecret)
    const commonHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuth,
      'X-Requested-With': 'XMLHttpRequest',
      'ClientType': 'pc',
      'LoginMode': mode,
    }
    const url = paths.ssoUri.replace(/\/+$/, '') + '/oauth2/token'

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
    // 没拿到 expires_in 时写 0（表示未知），不能写成 Date.now()，否则会被当成已过期
    localStorage.setItem(
      STORAGE_KEYS.expiresAt,
      r.expires_in > 0 ? String(Date.now() + r.expires_in * 1000) : '0',
    )
    this.notifySession()
    this.bindAutoRefresh()
  }

  /**
   * 原版 `autoRefreshTokenWhenExpires`：在过期前 60 秒主动续期。
   * 这里存的是绝对过期时间；剩余不足 60 秒时按 60 秒后再试，避免反复刷新。
   * 续期失败不阻断使用：HTTP 401 与 IM 99 仍会各自触发一次刷新。
   */
  scheduleAutoRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    const expiresAt = Number(localStorage.getItem(STORAGE_KEYS.expiresAt) || 0)
    if (!expiresAt || !this.getAccessToken()) return
    let delay = expiresAt - Date.now() - 60_000
    if (delay < 1000) delay = 60_000
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refreshTokenResult().then((result) => {
        // 凭证被明确拒绝时不再空转：等 UI 重新登录
        if (!result.invalid && this.getAccessToken()) this.scheduleAutoRefresh()
      })
    }, delay)
    // Node 回归脚本里不让续期定时器挂住进程；浏览器定时器没有 unref
    ;(this.refreshTimer as unknown as { unref?: () => void }).unref?.()
  }

  /** 启动时恢复自动续期，并在休眠/后台恢复前台时补一次检查（定时器可能被系统暂停） */
  bindAutoRefresh(): void {
    this.scheduleAutoRefresh()
    if (this.autoRefreshBound || typeof document === 'undefined') return
    this.autoRefreshBound = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.getAccessToken()) return
      const expiresAt = Number(localStorage.getItem(STORAGE_KEYS.expiresAt) || 0)
      if (expiresAt && expiresAt - Date.now() <= 120_000) {
        void this.refreshTokenResult().then((result) => {
          if (!result.invalid && this.getAccessToken()) this.scheduleAutoRefresh()
        })
      } else {
        this.scheduleAutoRefresh()
      }
    })
  }

  /** 写入服务端返回的新 token（refresh_token 轮换时一并更新） */
  private applyRefreshedToken(json: any): void {
    localStorage.setItem(STORAGE_KEYS.accessToken, json.access_token)
    localStorage.setItem(STORAGE_KEYS.authAccessToken, json.access_token)
    if (json.refresh_token) {
      localStorage.setItem(STORAGE_KEYS.refreshToken, json.refresh_token)
    }
    // 缺 expires_in 时写 0（未知），不能保留旧值：旧值可能已过期，会把新 token 误判为已过期
    localStorage.setItem(
      STORAGE_KEYS.expiresAt,
      json.expires_in ? String(Date.now() + Number(json.expires_in) * 1000) : '0',
    )
    this.notifySession()
    this.scheduleAutoRefresh()
  }

  /**
   * 刷新 token，并区分「网络失败（可重试）」与「凭证被拒（需要重登）」。
   * 原版 `reAuth` 在刷新被 401 拒绝时用记住的密码静默重登，这里保持一致；
   * 只有静默重登也失败才返回 invalid，让 UI 要求重新登录。
   */
  async refreshTokenResult(): Promise<RefreshResult> {
    const refreshToken = localStorage.getItem(STORAGE_KEYS.refreshToken)
    const accountId = this.getCurrentUserId()
    if (!accountId) return { token: null, invalid: true }

    const scope = JSON.stringify([accountId, refreshToken, getServerPaths().ssoUri])
    if (this.refreshing?.key === scope) return this.refreshing.promise
    const promise = (async (): Promise<RefreshResult> => {
      if (refreshToken) {
        const result = await this.requestRefreshToken(refreshToken, accountId)
        if (result.token) return result
        if (!result.invalid) return result
      }
      // 没有 refresh_token，或刷新被服务端明确拒绝：尝试静默重登
      const relogged = await this.silentRelogin()
      if (relogged) return { token: relogged, invalid: false }
      return { token: null, invalid: true }
    })()
    this.refreshing = { key: scope, promise }
    try {
      return await promise
    } finally {
      if (this.refreshing?.promise === promise) this.refreshing = null
    }
  }

  private async requestRefreshToken(
    refreshToken: string,
    accountId: string,
  ): Promise<RefreshResult> {
    const basicAuth = 'Basic ' + btoa(this.config.clientId + ':' + this.config.clientSecret)
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    const ssoUrl = getServerPaths().ssoUri.replace(/\/+$/, '')

    try {
      const resp = await fetch(ssoUrl + '/oauth2/token', {
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
      let json: any = null
      try {
        json = await resp.json()
      } catch {
        json = null
      }
      if (
        accountId !== this.getCurrentUserId() ||
        refreshToken !== localStorage.getItem(STORAGE_KEYS.refreshToken)
      ) {
        // 期间已切换账号/已被别的请求轮换：本次结果作废，但不算凭证失效
        return { token: null, invalid: false }
      }
      if (resp.ok && json?.access_token) {
        this.applyRefreshedToken(json)
        return { token: json.access_token, invalid: false }
      }
      // 0 = 网络不可达；5xx / 429 可稍后重试；其余 4xx 视为刷新令牌失效
      const retryable =
        resp.status === 0 || resp.status === 429 || resp.status >= 500
      return { token: null, invalid: !retryable }
    } catch (e) {
      console.error('刷新 token 失败', e)
      // Tauri fetch 抛错多为网络问题，不能据此判定登录失效
      return { token: null, invalid: false }
    }
  }

  /** 用「记住密码」里的账号口令静默重登（原版 loginByPassword + loginMode=auto） */
  private async silentRelogin(): Promise<string | null> {
    if (this.relogining) return this.relogining
    const creds = loadCreds()
    if (!creds || !creds.remember) return null
    const password = decodeSavedPassword(creds.password)
    if (!creds.username || !password) return null
    if (!this.getCurrentUserId()) return null
    this.relogining = (async () => {
      try {
        const result = await this.login(creds.username, password, 'auto')
        return result.mode === 'ok' && result.access_token ? result.access_token : null
      } catch (e) {
        console.error('静默重新登录失败', e)
        return null
      }
    })()
    try {
      return await this.relogining
    } finally {
      this.relogining = null
    }
  }

  /** 刷新 token；兼容旧调用方，失败返回 null（不区分原因） */
  async refreshToken(): Promise<string | null> {
    return (await this.refreshTokenResult()).token
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
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    localStorage.removeItem(STORAGE_KEYS.accessToken)
    localStorage.removeItem(STORAGE_KEYS.authAccessToken)
    localStorage.removeItem(STORAGE_KEYS.refreshToken)
    localStorage.removeItem(STORAGE_KEYS.currentUserId)
    localStorage.removeItem(STORAGE_KEYS.currentUserName)
    localStorage.removeItem(STORAGE_KEYS.expiresAt)
    this.notifySession()
  }

  /**
   * 获取当前用户信息
   * GET {uamApiUrl}/users/me 或类似端点
   */
  async getCurrentUser(): Promise<UserInfo> {
    const uid = this.getCurrentUserId()
    const base = (
      localStorage.getItem('uamApiUri') || getServerPaths().uamApiUri
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
    if (json && typeof json.code === 'number' && json.code !== 200) {
      throw new Error(json.message || `获取用户信息失败: code=${json.code}`)
    }
    const payload = json?.data || json
    const data = payload?.user || payload || {}
    const user: UserInfo = {
      id: String(data.userId || data.id || uid),
      name: data.name || data.userName || data.displayName || this.getCurrentUserName() || uid,
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
