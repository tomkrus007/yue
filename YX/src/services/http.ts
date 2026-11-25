/**
 * 统一 HTTP 客户端。
 *
 * 必须使用 @tauri-apps/plugin-http 的 fetch：WebView 里受 CORS 限制，
 * 而 emb / embquery / taskapi 等服务的 CORS 不完整。
 *
 * 两个实测坑：
 * - 不要加 `Accept: application/json`，embquery 会直接 500。
 * - 401 时用 refresh_token 换新 token 并重试一次。
 */
import { fetch } from '@tauri-apps/plugin-http'
import { authService } from './auth'

export interface HttpOptions {
  method?: string
  token?: string
  basic?: string
  body?: unknown
  extraHeaders?: Record<string, string>
  retried?: boolean
  /** 待办等接口还需 query 凭证；重试时使用刷新后的 token 重建 URL。 */
  tokenInQuery?: boolean
  signal?: AbortSignal
}

export async function httpJson<T = any>(
  url: string,
  options: HttpOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    token = authService.getAccessToken(),
    basic,
    body,
    extraHeaders = {},
    retried = false,
  } = options

  const headers: Record<string, string> = { ...extraHeaders }
  if (token) headers.Authorization = 'Bearer ' + token
  if (basic) headers.Authorization = 'Basic ' + basic
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let requestUrl = url
  if (options.tokenInQuery && token) {
    const target = new URL(url)
    target.searchParams.set('access_token', token)
    requestUrl = target.href
  }
  const resp = await fetch(requestUrl, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: options.signal,
  })
  const text = await resp.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  if (!resp.ok) {
    if (resp.status === 401 && token && !retried) {
      const fresh = await authService.refreshToken()
      if (fresh) {
        return httpJson<T>(url, {
          ...options,
          token: fresh,
          retried: true,
        })
      }
    }
    const detail =
      (data &&
        (data.err ||
          data.error_description ||
          data.message ||
          data.error)) ||
      String(text || '').slice(0, 120)
    throw new Error(`HTTP ${resp.status} ${detail}`)
  }
  return data as T
}

/** 部分接口只收表单参数（发 JSON 会报「参数缺失」）。 */
export async function postForm<T = any>(
  url: string,
  params: Record<string, string | number | boolean>,
  options: { token?: string; retried?: boolean } = {},
): Promise<T> {
  const token = options.token ?? authService.getAccessToken()
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
    ).toString(),
  })
  const text = await resp.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!resp.ok || (data && data.code && data.code !== 200)) {
    if (resp.status === 401 && !options.retried) {
      const fresh = await authService.refreshToken()
      if (fresh) return postForm<T>(url, params, { token: fresh, retried: true })
    }
    throw new Error(
      (data && (data.message || data.msg)) || 'HTTP ' + resp.status,
    )
  }
  return data as T
}

/** 有些服务（品高云盘 / 任务）只认 query 里的 access_token。 */
export async function tokenGet<T = any>(
  url: string,
  token = authService.getAccessToken(),
  retried = false,
): Promise<T> {
  const join = url.includes('?') ? '&' : '?'
  const resp = await fetch(
    url + join + 'access_token=' + encodeURIComponent(token),
  )
  const text = await resp.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  // 与 httpJson 一致：token 过期时换新 token 重放一次。pan / taskapi 只认
  // query 凭证，此前没有这条重试，过期后要等别的请求刷新 token 才能恢复。
  if (resp.status === 401 && token && !retried) {
    const fresh = await authService.refreshToken()
    if (fresh) return tokenGet<T>(url, fresh, true)
  }
  if (
    !resp.ok ||
    (data && typeof data === 'object' && data.code && data.code !== 200)
  ) {
    throw new Error(
      (data &&
        (data.message ||
          data.msg ||
          data.error_description ||
          data.error)) ||
        'HTTP ' + resp.status,
    )
  }
  // 200 但正文不是 JSON（例如被 SSO 登录页顶替）不能返回 null：调用方会把
  // 它当成「没有数据」，界面就显示成「文件夹是空的」而不是报错。
  if (data === null) {
    throw new Error('响应不是有效 JSON: ' + String(text || '').slice(0, 80))
  }
  return data as T
}

/** 直接取二进制（图片 / 图标），走 Tauri HTTP 绕过 CORS。 */
export async function httpArrayBuffer(
  url: string,
  options: {
    token?: string
    headers?: Record<string, string>
    /** 0 = 不跟随重定向；用于把「302 到登录页」当成失败而不是拿到一页 HTML。 */
    maxRedirections?: number
  } = {},
): Promise<ArrayBuffer> {
  const headers: Record<string, string> = { ...(options.headers || {}) }
  if (options.token) headers.Authorization = 'Bearer ' + options.token
  const resp = await fetch(url, {
    headers,
    maxRedirections: options.maxRedirections,
  })
  if (!resp.ok) throw new Error('HTTP ' + resp.status)
  return resp.arrayBuffer()
}
