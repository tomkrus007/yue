/**
 * 应用桌面（desk）：原版「应用」页的真实数据源。
 *
 * 原版不是把 `es/authorized` 平铺成网格，而是读取用户自己维护的桌面：
 *   GET {appApiUri}/v2/desk/list            → 桌面列表（含 layout）
 *   GET {appApiUri}/v2/desk/{deskId}/details → 桌面上的文件夹与应用
 * 应用条目的 `href` 往往为空，真实地址在 `deployTemplateDescription` 里，
 * 需要按 `getFormatHref` 解析；「全部应用」抽屉用 `escategory` 系列接口。
 *
 * 打开方式只保留两种：内嵌窗口（默认）与系统浏览器。内嵌窗口先用
 * `oauth2/authorize?response_type=create_session` 取应用会话 Cookie，交给 Rust
 * 写进 WebView（`src-tauri/src/app_window.rs`）再加载应用；系统浏览器设置不了
 * Cookie，退回官方 `getWebLinkUrl` 的 login_token 桥。
 *
 * E-HR、主数据这类走集团 CAS（`sso1.yuexiu.com`）的应用不认 linksso 的 Cookie，
 * 还需要一份 `CASTGC`（见 `casTgt`），否则会停在 CAS 登录页。
 */
import { invoke } from '@tauri-apps/api/core'
import { fetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'
import { authService } from './auth'
import { getServerPaths } from './config'
import { httpJson } from './http'

/** 桌面 / 分类里的应用条目（字段与官方接口一致，只列用到的）。 */
export interface DeskApp {
  id: string
  name: string
  /** 已去掉 `||原始文件名` 的图标 key。 */
  icon: string
  href: string
  code: string
  openMode: number
  authType: number
  renderType: number
  winStatus: number
  deployTemplateDescription: string
}

export interface DeskFolder {
  id: string
  name: string
  position: string
  apps: DeskApp[]
}

export interface Desk {
  deskId: string
  deskCode: string
  deskName: string
  layout: string
}

export interface AppCategory {
  id: string
  name: string
}

/** 'embedded' = 新窗口内嵌打开（默认）；'browser' = 系统浏览器。 */
export type AppOpenTarget = 'embedded' | 'browser'

/** 写入 WebView 的会话 Cookie，字段与 SSO `create_session` 返回的 `tokens[]` 对应。 */
export interface SessionCookie {
  name: string
  value: string
  domain: string
  path: string
}

const DEFAULT_FOLDER = 'default_dissociate_folder'

function appBase(): string {
  return String(getServerPaths().appApiUri || '').replace(/\/+$/, '')
}

function uamBase(): string {
  return String(getServerPaths().uamUri || '').replace(/\/+$/, '')
}

function normalizeApp(raw: any): DeskApp {
  return {
    id: String(raw?.id || raw?.appId || ''),
    name: String(raw?.name || ''),
    icon: String(raw?.icon || '').split('||')[0],
    href: String(raw?.href || ''),
    code: String(raw?.code || ''),
    openMode: Number(raw?.openMode) || 0,
    authType: Number(raw?.authType) || 0,
    renderType: Number(raw?.renderType) || 1,
    winStatus: Number(raw?.winStatus) || 0,
    deployTemplateDescription:
      typeof raw?.deployTemplateDescription === 'string'
        ? raw.deployTemplateDescription
        : '',
  }
}

function normalizeApps(list: unknown): DeskApp[] {
  return (Array.isArray(list) ? list : [])
    .map(normalizeApp)
    .filter((app) => app.id && app.name)
}

function dataOf<T>(json: any): T | null {
  if (!json || typeof json !== 'object') return null
  if (typeof json.code === 'number' && json.code !== 200) {
    throw new Error(String(json.message || `接口返回 ${json.code}`))
  }
  return (json.data ?? null) as T | null
}

/** 桌面列表；接口不可用时抛错，由页面回退到全量授权应用。 */
export async function loadDesks(): Promise<Desk[]> {
  const base = appBase()
  if (!base) return []
  const data = dataOf<any[]>(await httpJson<any>(base + '/v2/desk/list'))
  return (Array.isArray(data) ? data : [])
    .filter((item) => item && item.deskId)
    .map((item) => ({
      deskId: String(item.deskId),
      deskCode: String(item.deskCode || ''),
      deskName: String(item.deskName || '桌面'),
      layout: String(item.layout ?? '0'),
    }))
}

/** 某个桌面的文件夹与应有；`position` 是原版的栏位布局，这里只保留顺序。 */
export async function loadDeskDetails(deskId: string): Promise<DeskFolder[]> {
  const base = appBase()
  if (!base || !deskId) return []
  const data = dataOf<any[]>(
    await httpJson<any>(base + '/v2/desk/' + encodeURIComponent(deskId) + '/details'),
  )
  return (Array.isArray(data) ? data : [])
    .filter((folder) => folder && folder.id)
    .map((folder) => ({
      id: String(folder.id),
      name: String(folder.name || ''),
      position: String(folder.position ?? ''),
      apps: normalizeApps(folder.apps),
    }))
}

/** 每个桌面的“全部应用”分类。 */
export async function loadCategories(): Promise<AppCategory[]> {
  const base = appBase()
  if (!base) return []
  const data = dataOf<any[]>(await httpJson<any>(base + '/escategory/get'))
  return (Array.isArray(data) ? data : [])
    .filter((item) => item && item.id && item.name)
    .map((item) => ({ id: String(item.id), name: String(item.name) }))
}

/** 分类下的应用；`deskId` 用于服务端判断哪些已添加。 */
export async function loadCategoryApps(
  categoryId: string,
  deskId?: string,
): Promise<DeskApp[]> {
  const base = appBase()
  if (!base || !categoryId) return []
  const url =
    base +
    '/escategory/' +
    encodeURIComponent(categoryId) +
    '/appItem' +
    (deskId ? '?deskId=' + encodeURIComponent(deskId) : '')
  return normalizeApps(dataOf<any[]>(await httpJson<any>(url)))
}

/** 全量搜索：路径段就是关键字（与官方一致）。 */
export async function searchApps(keyword: string): Promise<DeskApp[]> {
  const base = appBase()
  const text = keyword.trim()
  if (!base || !text) return []
  const url = base + '/escategory/' + encodeURIComponent(text) + '/search'
  return normalizeApps(dataOf<any[]>(await httpJson<any>(url)))
}

async function mutateDeskApp(body: Record<string, unknown>): Promise<void> {
  const base = appBase()
  if (!base) throw new Error('缺少应用服务地址')
  dataOf<unknown>(await httpJson<any>(base + '/v2/desk/app', { method: 'POST', body }))
}

export async function addDeskApp(
  deskId: string,
  appId: string,
  folderId?: string,
): Promise<void> {
  const body: Record<string, unknown> = { deskId, apps: [{ appId }] }
  if (folderId) body.folderId = folderId
  await mutateDeskApp(body)
}

export async function removeDeskApp(
  deskId: string,
  appId: string,
  folderId?: string,
): Promise<void> {
  await mutateDeskApp({
    deskId,
    apps: [{ appId }],
    folderId: folderId || '',
    isDeleted: true,
  })
}

/**
 * 占位符取值：服务地址表里既可能叫 `webUri`，也可能直接叫 `web`。
 * 原版在服务端下发的基址后统一补了 `/`，这里反过来去掉尾部 `/`，
 * 避免 `{web}/x` 拼成 `//x`。
 */
function placeholderValue(key: string): string {
  const paths = getServerPaths() as Record<string, unknown>
  const raw =
    key === 'analysisstatic'
      ? paths.analysisstaticUrl || localStorage.getItem('analysisstaticUrl')
      : paths[key] ?? paths[key + 'Uri']
  return typeof raw === 'string' ? raw.replace(/\/+$/, '') : ''
}

/**
 * 原版 `getFormatHref`：
 * - 优先 `deployTemplateDescription.urlParams` / `otherParams`，模板表单用 `renderType=3`；
 * - `http(s)://host/uam/` 前缀替换成本企业的 uam 地址；
 * - `{web}`、`{analysisstatic}` 等占位符用服务地址表替换；
 * - 非 http 的相对地址补 `http://`。
 *
 * 与官方的一处差异：官方只替换开头一个占位符，`http://{web}/xxx` 会原样留下
 * 非法地址；这里先去掉占位符前面的 `http://` 再整体替换，日程这类应用才能打开。
 */
export function formatAppHref(app: DeskApp): string {
  let href = app.href || ''
  if (app.deployTemplateDescription) {
    try {
      const desc = JSON.parse(app.deployTemplateDescription)
      if (desc?.urlParams) href = String(desc.urlParams)
      else if (desc?.otherParams) href = String(desc.otherParams)
      else if (app.renderType === 3 && desc?.selectedWorkflowId) {
        href =
          uamBase() +
          '/modules/workflow/workbench_form?_masterpage=common/webos&menu=' +
          encodeURIComponent(String(desc.selectedWorkflowId))
      }
    } catch {
      /* 配置不是 JSON 时按原 href 处理 */
    }
  }
  if (!href) return ''

  const uam = uamBase()
  if (uam) {
    href = href.replace(/^https?:\/\/[^/]+\/uam\//i, uam + '/')
  }
  // `http://{web}/...` 里的 scheme 是占位符写法的一部分，先去掉才能拼出合法地址
  if (/^https?:\/\/(?=\{)/i.test(href)) href = href.replace(/^https?:\/\//i, '')
  href = href.replace(/\{([^}]*)\}/g, (whole, key: string) => {
    const value = placeholderValue(key)
    return value || whole
  })
  if (
    !/^https?:\/\//i.test(href) &&
    !/^(word|excel|powerpoint)$/i.test(href) &&
    !href.startsWith('[')
  ) {
    href = 'http://' + href
  }
  return href
}

/** 复刻官方 `$.UrlAddParam`：有 `?` 就接 `&`，否则接 `?`（哈希路由同样追加在末尾）。 */
function addParam(url: string, key: string, value: string | number): string {
  const pattern = new RegExp('([?&])' + key + '=.*?(&|$)', 'i')
  const pair = key + '=' + encodeURIComponent(String(value))
  if (pattern.test(url)) return url.replace(pattern, '$1' + pair + '$2')
  return url + (url.includes('?') ? '&' : '?') + pair
}

/**
 * 单点登录桥用的 login_token（官方 `getLoginTicket`）。
 * 拿不到就返回空串，调用方退回直接打开目标地址。
 */
async function loginTicket(): Promise<string> {
  const sso = String(getServerPaths().ssoUri || '').replace(/\/+$/, '')
  if (!sso) return ''
  const basic =
    'Basic ' +
    btoa(authService.config.clientId + ':' + authService.config.clientSecret)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = authService.getAccessToken()
    if (!token) return ''
    try {
      const resp = await fetch(
        sso + '/oauth2/logintoken?access_token=' + encodeURIComponent(token),
        {
          headers: {
            Authorization: basic,
            'X-Requested-With': 'XMLHttpRequest',
            ClientType: 'pc',
          },
        },
      )
      if (resp.status === 401 && attempt === 0) {
        if (!(await authService.refreshToken())) return ''
        continue
      }
      if (!resp.ok) return ''
      const json: any = await resp.json().catch(() => null)
      return String(json?.login_token || '')
    } catch {
      return ''
    }
  }
  return ''
}

/** 官方 `getWebLinkUrl`：用 login_token 换一次已登录跳转。 */
function bridgeUrl(target: string, ticket: string): string {
  const sso = String(getServerPaths().ssoUri || '').replace(/\/+$/, '')
  if (!sso || !ticket) return target
  return (
    sso +
    '/oauth2/authorize?redirect_uri=' +
    encodeURIComponent(target) +
    '&response_type=code&client_id=' +
    encodeURIComponent(authService.config.clientId) +
    '&v2_compatible=true&login_token=' +
    encodeURIComponent(ticket)
  )
}

/** 原版 `winStatus`：1 = 大窗，4 = 全屏态，其余默认。 */
function windowSize(app: DeskApp): { width: number; height: number } {
  if (app.winStatus === 4) return { width: 1440, height: 900 }
  if (app.winStatus === 1) return { width: 1280, height: 820 }
  return { width: 1100, height: 760 }
}

/**
 * 应用的会话 Cookie（官方 `setAppCookieToLocal`，`response_type=create_session`）。
 *
 * 原版客户端在打开应用前把这份 Cookie 写进 WebView，应用再向
 * `oauth2.serverUrl`（如 `linksso.yuexiu.com`）校验时就是已登录状态。
 * 只跳 `oauth2/authorize` 拿 `code` 不行：应用不认那个码，会直接跳登录页。
 */
async function appSessionCookies(): Promise<SessionCookie[]> {
  const sso = String(getServerPaths().ssoUri || '').replace(/\/+$/, '')
  if (!sso) return []
  const basic = btoa(
    authService.config.clientId + ':' + authService.config.clientSecret,
  )
  const baseUrl = sso + '/oauth2/authorize'
  const query = (token: string) =>
    baseUrl +
    '?client_id=' +
    encodeURIComponent(authService.config.clientId) +
    '&response_type=create_session&redirect_uri=' +
    encodeURIComponent(sso) +
    '&logout_uri=&responseJson=true&access_token=' +
    encodeURIComponent(token)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = authService.getAccessToken()
    if (!token) return []
    try {
      const resp = await fetch(query(token), {
        headers: {
          Authorization: 'Basic ' + basic,
          'X-Requested-With': 'XMLHttpRequest',
          ClientType: 'pc',
        },
      })
      if (resp.status === 401 && attempt === 0) {
        if (!(await authService.refreshToken())) return []
        continue
      }
      if (!resp.ok) return []
      const json: any = await resp.json().catch(() => null)
      const tokens = Array.isArray(json?.tokens) ? json.tokens : []
      return tokens
        .filter((item: any) => item && item.name && item.domain)
        .map((item: any) => ({
          name: String(item.name),
          value: String(item.value ?? ''),
          domain: String(item.domain),
          path: String(item.path || '/'),
        }))
    } catch {
      return []
    }
  }
  return []
}

/**
 * `LoginAuthorize` 返回的是单引号 JS 对象字面量（不是 JSON），只取值即可。
 */
function pickField(text: string, field: string): string {
  const matched = new RegExp(
    "['\"]" + field + "['\"]\\s*:\\s*['\"]([^'\"]*)['\"]",
  ).exec(text)
  return matched ? matched[1] : ''
}

/** TGT 缓存：CAS 默认有效期以小时计，这里保守按半小时复用。 */
const CAS_TGT_TTL = 30 * 60 * 1000
/** 失败后 5 分钟内不再重试，避免每次开应用都等一串超时。 */
const CAS_TGT_RETRY = 5 * 60 * 1000
let casCache: { tgt: string; at: number } | null = null

/** 退出登录时清掉缓存的 CAS 票据，避免下一个账号复用上一个账号的会话。 */
export function clearAppLoginCache(): void {
  casCache = null
}

/**
 * 集团 CAS 的登录票据（`CASTGC` 的值）。
 *
 * linksso 与 CAS 已经打通，桌面端可以替用户把 CAS 的「扫码登录」静默走完：
 *
 *   1. `casSessionManager/qrcode/GetQRCodeUUID` 取一个二维码 key（linksso 与 CAS 共用这套 key）；
 *   2. `linksso /qrcode/create`（key + 桌面端 loginTicket）登记扫码人，
 *      `/qrcode/confirm`（key + nonce）确认；
 *   3. CAS `qrcode/Await` 拿回 CAS 的 loginTicket，`qrcode/LoginAuthorize`
 *      换成 `idToken`（带 `username`）；
 *   4. `POST {cas}/cas/v1/tickets`（`password=#QRCODE#<idToken>`）返回 `Location`
 *      里的 TGT。
 *
 * 把 TGT 作为 `CASTGC` Cookie 写进应用窗口后，应用跳 CAS 时 CAS 认得这个会话，
 * 直接回发 service ticket，E-HR、主数据就不再停在登录页。
 *
 * 任何一步失败都返回空串：应用最多回到 CAS 登录页，不影响打开。
 */
async function casTgt(): Promise<string> {
  const now = Date.now()
  if (casCache) {
    const ttl = casCache.tgt ? CAS_TGT_TTL : CAS_TGT_RETRY
    if (now - casCache.at < ttl) return casCache.tgt
  }
  try {
    const tgt = await requestCasTgt()
    casCache = { tgt, at: Date.now() }
    return tgt
  } catch {
    casCache = { tgt: '', at: Date.now() }
    return ''
  }
}

async function requestCasTgt(): Promise<string> {
  const ticket = await loginTicket()
  if (!ticket) return ''

  const keyResp = await fetch(
    'https://ssoser.yuexiu.com/casSessionManager/qrcode/GetQRCodeUUID?t=' +
      Date.now(),
  )
  if (!keyResp.ok) return ''
  const key = (await keyResp.text()).trim()
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return ''

  const form = { 'Content-Type': 'application/x-www-form-urlencoded' }
  const createResp = await fetch('https://linksso.yuexiu.com/qrcode/create', {
    method: 'POST',
    headers: form,
    body: new URLSearchParams({ key, loginTicket: ticket }).toString(),
  })
  if (!createResp.ok) return ''
  const created: any = await createResp.json().catch(() => null)
  const nonce = String(created?.nonce || '')
  if (!nonce) return ''

  await fetch(
    'https://linksso.yuexiu.com/qrcode/confirm?key=' +
      encodeURIComponent(key) +
      '&nonce=' +
      encodeURIComponent(nonce),
    { method: 'POST' },
  )

  const awaitResp = await fetch(
    'https://ssoser.yuexiu.com/casSessionManager/qrcode/Await?key=' +
      encodeURIComponent(key) +
      '&t=' +
      Date.now(),
  )
  const awaited: any = await awaitResp.json().catch(() => null)
  let casTicket = String(awaited?.loginTicket || '')
  // CAS 侧确认是异步落库的，偶尔要等一两拍才拿得到 loginTicket
  for (let retry = 0; !casTicket && retry < 3; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const again = await fetch(
      'https://ssoser.yuexiu.com/casSessionManager/qrcode/Await?key=' +
        encodeURIComponent(key) +
        '&t=' +
        Date.now(),
    )
    const json: any = await again.json().catch(() => null)
    casTicket = String(json?.loginTicket || '')
  }
  if (!casTicket) return ''

  const authResp = await fetch(
    'https://ssoser.yuexiu.com/casSessionManager/qrcode/LoginAuthorize?redirect_uri=' +
      encodeURIComponent('https://sso1.yuexiu.com/cas/login') +
      '&response_type=id_token&login_token=' +
      encodeURIComponent(casTicket) +
      '&t=' +
      Date.now(),
  )
  const text = await authResp.text()
  const idToken = pickField(text, 'idToken')
  const username = pickField(text, 'username')
  if (!idToken || !username) return ''

  const tgtResp = await fetch('https://sso1.yuexiu.com/cas/v1/tickets', {
    method: 'POST',
    headers: form,
    body: new URLSearchParams({
      username,
      password: '#QRCODE#' + idToken,
    }).toString(),
  })
  // 正常是 201 + `Location: .../cas/v1/tickets/TGT-xxx`，正文里也带同一个地址
  const located = /\/cas\/v1\/tickets\/(TGT-[^/?#"'\s]+)/.exec(
    tgtResp.headers.get('location') || '',
  )
  if (located) return located[1]
  const body = await tgtResp.text().catch(() => '')
  const inlined = /\/cas\/v1\/tickets\/(TGT-[^/?#"'\s]+)/.exec(body)
  return inlined ? inlined[1] : ''
}

async function openEmbedded(
  url: string,
  app: DeskApp,
  cookies: SessionCookie[],
): Promise<void> {
  // 窗口标签只用 ASCII：Tauri 的 label 不接受中文和空格
  const label = 'app-' + app.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  const size = windowSize(app)
  await invoke('app_open_window', {
    label,
    title: app.name,
    url,
    width: size.width,
    height: size.height,
    cookies,
  })
}

/**
 * 打开桌面应用。
 *
 * 原版对 `openMode=1` 的应用强制走系统浏览器，其余在客户端里开窗口；这里保持一致，
 * 用户的「用系统浏览器打开」开关只影响原版本来就在客户端内打开的那批应用。
 *
 * - 客户端内：先取会话 Cookie，交给 Rust 写进 WebView 再加载应用（免登录）；
 * - 系统浏览器：设置不了浏览器 Cookie，退回官方 `getWebLinkUrl` 的 login_token 桥。
 *
 * 原版还有一个 `OpenUrlAppendAccessToken` 配置，开启后才会把 AccessToken 拼进
 * 应用地址；默认关闭，这里也不拼，避免把令牌泄漏给第三方域名。
 */
export async function openDeskApp(
  app: DeskApp,
  target: AppOpenTarget,
): Promise<void> {
  let url = formatAppHref(app)
  if (!url) throw new Error('该应用没有配置可打开的地址')
  if (/^(word|excel|powerpoint)$/i.test(url)) {
    throw new Error('该应用需要在「云盘」中打开，暂不支持从应用桌面直接打开')
  }
  if (url.startsWith('[')) {
    throw new Error('该应用是客户端专属动作，暂不支持直接打开')
  }

  const useBrowser = target === 'browser' || app.openMode === 1
  if (useBrowser) {
    if (app.authType === 1) {
      const ticket = await loginTicket()
      if (ticket) url = bridgeUrl(url, ticket)
    }
    await openUrl(url)
    return
  }

  // 与原版一致：客户端内窗口带上来源标记（pcCloseCode 供原版回关窗口，这里只透传）
  url = addParam(url, 'fromAppDesktop', 1)
  url = addParam(url, 'pcCloseCode', 'app,' + app.id)
  url = addParam(url, 't', Date.now())
  // linksso 会话与 CAS 会话互不影响，两份都写：link.yuexiu.com 系认前者，
  // E-HR、主数据这类集团 CAS 应用认后者。
  const [sessionCookies, tgt] = await Promise.all([
    app.authType === 1 ? appSessionCookies() : Promise.resolve([]),
    casTgt(),
  ])
  const cookies: SessionCookie[] = [...sessionCookies]
  if (tgt) {
    cookies.push({
      name: 'CASTGC',
      value: tgt,
      domain: 'sso1.yuexiu.com',
      path: '/cas/',
    })
  }
  await openEmbedded(url, app, cookies)
}

export { DEFAULT_FOLDER }
