/**
 * 图片 / 文件消息：上传、下载地址与响应解析。
 *
 * 上传请求来自官方 Go 客户端实测抓包：
 *   POST {storeUri}store/putFile?module=message&security=0
 *   Authorization: Bearer <token>
 *   multipart: file / fileName / size
 *
 * 上传不能在前端拼 FormData 直传：
 * - `@tauri-apps/plugin-http` 的 fetch 会把整个 body 变成 JS 数字数组走 IPC，
 *   600MB 文件直接把 WebView 进程顶到 100% CPU；
 * - WebView 的 XHR 受存储服务 CORS 限制，拿不到进度。
 * 现在改为分片写入 Rust 侧临时文件，再由 Rust 流式上传（见 src-tauri/src/store_upload.rs）。
 *
 * 下载：{storeUri}v2/{download_url}/download?access_token=
 * 存储服务回 application/octet-stream + nosniff，图片必须取字节后转 blob URL。
 *
 * 下载地址不止 storeUri 一个候选：本机 DNS 把 store 域名解析到内网入口时，
 * 该入口只持有 *.yuexiu.com 证书，TLS 主机名校验会失败（表现为文件时好时坏）。
 * 网关（uamApiUri 同源 + /store 路径）实测可达且证书正常，作为兜底候选。
 */
import { Channel, invoke } from '@tauri-apps/api/core'
import { authService } from '../auth'
import { getServerPaths } from '../config'
import { httpArrayBuffer, httpJson, postForm } from '../http'
import type { ImageMeta } from './content'
import { createPreviewMappingCache, mapPreviewUrl } from './preview-mapping'

/** 官方只把这 5 种后缀当图片，其余（含 webp/heic）都按文件发送。 */
export const IMAGE_MSG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp'])

/** 发送给服务端的原始字段名（下划线），由 content.ts 归一成 ImageMeta。 */
export interface MediaContent {
  size: number
  download_url: string
  extension: string
  file_name: string
  show_name: string
  file_type: 'F' | 'D'
}

export function buildMediaContent(
  fileName: string,
  size: number,
  downloadUrl: string,
): { msgType: 2 | 3; content: MediaContent } {
  const name = String(fileName || '')
  const dot = name.lastIndexOf('.')
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return {
    msgType: IMAGE_MSG_EXTS.has(extension) ? 2 : 3,
    content: {
      size: Number(size) || 0,
      download_url: String(downloadUrl || ''),
      extension,
      file_name: name,
      show_name: name,
      file_type: 'F',
    },
  }
}

/** 从 store/putFile 的响应里取文件 id（兼容 id / r.fileId / data.id 等形状）。 */
export function pickUploadedId(data: any): string {
  if (typeof data === 'string') {
    const s = data.trim()
    if (!s) return ''
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        return pickUploadedId(JSON.parse(s))
      } catch {
        return ''
      }
    }
    return s
  }
  if (typeof data === 'number') return String(data)
  if (!data || typeof data !== 'object') return ''
  for (const box of [data, data.data, data.r, data.result, data.file]) {
    if (!box) continue
    if (typeof box === 'string') {
      const id = pickUploadedId(box)
      if (id) return id
      continue
    }
    if (typeof box !== 'object') continue
    for (const key of ['id', 'fileId', 'file_id', 'download_url', 'key']) {
      const v = box[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (typeof v === 'number') return String(v)
    }
  }
  return ''
}

/** 上传地址；store 主机遇证书问题时回退到网关同路径。 */
export function storeUploadCandidates(): string[] {
  const paths = getServerPaths()
  const urls: string[] = []
  const add = (base?: string) => {
    if (!base) return
    const u =
      String(base).replace(/\/+$/, '') +
      '/store/putFile?module=message&security=0'
    if (!urls.includes(u)) urls.push(u)
  }
  add(paths.storeUri)
  try {
    const uam = paths.uamApiUri ? new URL(paths.uamApiUri) : null
    const store = paths.storeUri ? new URL(paths.storeUri) : null
    if (uam) add(uam.origin + (store ? store.pathname : '/store'))
  } catch {
    /* 忽略 */
  }
  return urls
}

/** 单次写入临时文件的分片大小：决定内存峰值，与文件大小无关。 */
const SPOOL_CHUNK = 8 * 1024 * 1024
/** 写临时文件占进度条的比重，其余留给真正的网络上传。 */
const SPOOL_WEIGHT = 5

interface UploadResponse {
  status: number
  text: string
}

function newUploadId(): string {
  return `u${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function scaleProgress(
  onProgress: ((pct: number) => void) | undefined,
  base: number,
  span: number,
): ((pct: number) => void) | undefined {
  if (!onProgress) return undefined
  return (pct) => onProgress(Math.round(base + (Math.min(100, pct) * span) / 100))
}

/**
 * 分片读文件写进 Rust 侧临时文件。
 * 全程只持有一个分片的字节，600MB 文件也不会把 WebView 撑爆。
 */
async function spoolFile(
  id: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  for (let offset = 0; offset < file.size; offset += SPOOL_CHUNK) {
    const end = Math.min(offset + SPOOL_CHUNK, file.size)
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer())
    // 原始字节通道：不要改成普通对象参数，否则会退化成 JSON 数字数组。
    await invoke('store_upload_chunk', bytes, {
      headers: { 'x-upload-id': id },
    })
    onProgress?.(Math.round((end / file.size) * 100))
  }
}

/** 由 Rust 流式读临时文件上传，进度经 Channel 回传。 */
async function commitUpload(
  id: string,
  url: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadResponse> {
  const channel = new Channel<{ sent: number; total: number }>()
  channel.onmessage = (p) => {
    if (p.total > 0) onProgress?.(Math.floor((p.sent / p.total) * 100))
  }
  return invoke<UploadResponse>('store_upload_commit', {
    id,
    url,
    token: authService.getAccessToken(),
    fileName: file.name,
    onProgress: channel,
  })
}

function parseUploadResult(text: string): string {
  let data: any = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* 保留原文 */
  }
  if (data && typeof data === 'object') {
    const code = data.code ?? data.statusCode
    if (code !== undefined && ![0, 200].includes(Number(code))) {
      throw new Error(
        data.message ||
          data.msg ||
          data.error_description ||
          `上传失败（code ${code}）`,
      )
    }
  }
  const id = pickUploadedId(data)
  if (!id) throw new Error('上传响应里没有文件 id')
  return id
}

/** 上传文件，返回服务端文件 id。 */
export async function uploadToStore(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<string> {
  if (!file || !file.size) throw new Error('不能发送空文件')
  const urls = storeUploadCandidates()
  if (!urls.length) throw new Error('缺少 storeUri（配置中心没下发存储地址）')

  const id = newUploadId()
  await invoke('store_upload_begin', { id })
  try {
    await spoolFile(
      id,
      file,
      scaleProgress(onProgress, 0, SPOOL_WEIGHT),
    )
    const uploadProgress = scaleProgress(onProgress, SPOOL_WEIGHT, 100 - SPOOL_WEIGHT)
    let lastErr: Error | null = null
    for (const url of urls) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const res = await commitUpload(id, url, file, uploadProgress)
          if (res.status === 401) {
            if (attempt === 0 && (await authService.refreshToken())) continue
            lastErr = new Error('登录已过期，请重新登录')
            break
          }
          if (res.status === 0 || res.status === 302) {
            throw new Error('被重定向到登录页')
          }
          if (res.status < 200 || res.status >= 300) {
            throw new Error('HTTP ' + res.status)
          }
          return parseUploadResult(res.text)
        } catch (err: any) {
          lastErr = err
          break
        }
      }
    }
    throw lastErr || new Error('上传失败')
  } finally {
    // 成功或失败都清掉临时文件；失败后重试会重新分片写入。
    void invoke('store_upload_cancel', { id }).catch(() => {})
  }
}

/** 文件/图片下载候选地址：storeUri 优先，网关同路径兜底。 */
export function downloadCandidates(seg: ImageMeta): string[] {
  const key = seg.downloadUrl
  if (!key) return []
  if (/^https?:/i.test(key)) return [key]
  const token = encodeURIComponent(authService.getAccessToken())
  const out: string[] = []
  const push = (origin?: string, pathname?: string) => {
    if (!origin) return
    const path = String(pathname || '/store').replace(/\/+$/, '')
    const url = origin.replace(/\/+$/, '') + path + '/v2/' + key + '/download?access_token=' + token
    if (!out.includes(url)) out.push(url)
  }
  const paths = getServerPaths()
  try {
    const store = paths.storeUri ? new URL(paths.storeUri) : null
    if (store) push(store.origin, store.pathname)
  } catch {
    /* 忽略 */
  }
  try {
    const uam = paths.uamApiUri ? new URL(paths.uamApiUri) : null
    if (uam) push(uam.origin, '/store')
  } catch {
    /* 忽略 */
  }
  return out
}

/** 图片候选地址：复用 downloadCandidates，只是多带缩放参数。 */
export function imageCandidates(seg: ImageMeta, size = '0x1080'): string[] {
  return downloadCandidates(seg).map(url => {
    try {
      const u = new URL(url)
      u.searchParams.set('size', size)
      return u.href
    } catch {
      return url
    }
  })
}

const getPreviewMapping = createPreviewMappingCache()

/** 聊天附件走存储预览服务，不使用云盘文件的预览接口。 */
export function canPreviewFile(seg: ImageMeta): boolean {
  const ext = (seg.extension || seg.fileName.split('.').pop() || '').replace(/^\./, '').toLowerCase()
  return !!seg.downloadUrl && !/^https?:/i.test(seg.downloadUrl) &&
    ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'].includes(ext)
}

export async function filePreviewUrl(seg: ImageMeta): Promise<string> {
  if (!canPreviewFile(seg)) throw new Error('该附件不支持在线预览')
  const base = String(getServerPaths().storeUri || '').replace(/\/+$/, '')
  if (!base) throw new Error('缺少存储服务地址')
  const result = await httpJson<{ s: number; r?: string; m?: string }>(
    base + '/store/getPreviewUrl?fileId=' + encodeURIComponent(seg.downloadUrl),
    { tokenInQuery: true },
  )
  if (Number(result?.s) !== 1 || typeof result.r !== 'string' || !result.r.trim()) {
    throw new Error(result?.m || '服务端暂不支持预览此文件，请下载后查看')
  }
  const url = new URL(result.r)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('预览地址无效')
  const eCode = localStorage.getItem('CurrentECode') || ''
  const uam = getServerPaths().uamApiUri.replace(/\/+$/, '')
  if (!eCode || !uam) return url.href
  const key = JSON.stringify([authService.getCurrentUserId(), eCode, uam])
  const mapping = await getPreviewMapping(key, async () => {
    const enterprise = await httpJson<any>(uam + '/v1/enterprises/info?eCode=' + encodeURIComponent(eCode))
    if (!enterprise?.data?.details) throw new Error('企业配置未返回')
    return enterprise.data.details.indiviConfig
  })
  return mapPreviewUrl(url.href, mapping)
}

export function appIconUrl(key: string): string {
  if (!key) return ''
  const paths = getServerPaths()
  const base = String(paths.storeUri || '').replace(/\/+$/, '')
  if (!base) return ''
  return (
    base +
    '/store/getFile?fileId=' +
    encodeURIComponent(key) +
    '&access_token=' +
    encodeURIComponent(authService.getAccessToken())
  )
}

/**
 * 用户/群等主体头像：官方客户端走 {storeUri}v2/avatar?id=&type=&size=0x180&access_token=。
 * type：1 用户、2 群、4 组织、5 服务号、7 机器人。
 *
 * 候选地址与 downloadCandidates 同理：某些网络下 store 主机的证书会被中间设备
 * 替换（TLS 主机名校验失败），只有网关主机（uamApiUri 同源 + /store）可用。
 * 头像此前只拼 storeUri，所以附件能显示、头像整片空着。
 */
export function avatarCandidates(id: string, type = 1): string[] {
  if (!id) return []
  const query = new URLSearchParams({
    id,
    type: String(type),
    size: '0x180',
    access_token: authService.getAccessToken(),
  }).toString()
  const out: string[] = []
  const push = (origin?: string, pathname?: string) => {
    if (!origin) return
    const path = String(pathname || '/store').replace(/\/+$/, '')
    const url = origin.replace(/\/+$/, '') + path + '/v2/avatar?' + query
    if (!out.includes(url)) out.push(url)
  }
  const paths = getServerPaths()
  try {
    const store = paths.storeUri ? new URL(paths.storeUri) : null
    if (store) push(store.origin, store.pathname)
  } catch {
    /* 忽略 */
  }
  try {
    const uam = paths.uamApiUri ? new URL(paths.uamApiUri) : null
    if (uam) push(uam.origin, '/store')
  } catch {
    /* 忽略 */
  }
  return out
}

/** 头像地址（首选候选，storeUri 优先）；保留给调试与其他调用方。 */
export function avatarUrl(id: string, type = 1): string {
  return avatarCandidates(id, type)[0] || ''
}

export function mimeFromExt(ext?: string): string {
  const e = String(ext || '')
    .toLowerCase()
    .replace(/^\./, '')
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  }
  return map[e] || ''
}

export function sniffImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
    return 'image/webp'
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return 'image/png'
}

const imgCache = new Map<string, string>()
const imgPending = new Map<string, Promise<string>>()
let preferredHost = ''

/** 取图片字节并转 blob URL；同一张图只取一次。 */
export async function getImageUrl(seg: ImageMeta): Promise<string> {
  const key = seg.downloadUrl || ''
  if (seg.storeV1) return getAppIconUrl(key)
  if (!key) throw new Error('缺少图片地址')
  if (/^blob:/i.test(key)) return key
  const cached = imgCache.get(key)
  if (cached) return cached
  const pending = imgPending.get(key)
  if (pending) return pending

  const task = (async () => {
    const candidates = imageCandidates(seg)
    if (!candidates.length) throw new Error('缺少图片地址')
    if (preferredHost) {
      candidates.sort((a, b) => {
        const pa = a.startsWith(preferredHost) ? 1 : 0
        const pb = b.startsWith(preferredHost) ? 1 : 0
        return pb - pa
      })
    }
    let lastErr: Error | null = null
    for (const url of candidates) {
      for (const withHeader of [false, true]) {
        if (withHeader && /^https?:/i.test(key)) {
          const origin = new URL(key).origin
          const paths = getServerPaths()
          if (![paths.storeUri, paths.uamApiUri].some(base => base && new URL(base).origin === origin)) continue
        }
        try {
          const buf = await httpArrayBuffer(url, {
            token: withHeader ? authService.getAccessToken() : undefined,
          })
          const bytes = new Uint8Array(buf)
          const type = mimeFromExt(seg.extension) || sniffImageType(bytes)
          const blobUrl = URL.createObjectURL(new Blob([buf], { type }))
          imgCache.set(key, blobUrl)
          try {
            preferredHost = new URL(url).origin
          } catch {
            /* 忽略 */
          }
          return blobUrl
        } catch (err: any) {
          lastErr = err
        }
      }
    }
    throw lastErr || new Error('图片加载失败')
  })().finally(() => imgPending.delete(key))

  imgPending.set(key, task)
  return task
}

/** 应用图标：v1 的 store/getFile（v2 不认带路径的 key）。 */
const iconCache = new Map<string, string>()
export async function getAppIconUrl(key: string): Promise<string> {
  if (!key) return ''
  const cached = iconCache.get(key)
  if (cached) return cached
  const url = appIconUrl(key)
  if (!url) return ''
  const buf = await httpArrayBuffer(url)
  const blobUrl = URL.createObjectURL(
    new Blob([buf], { type: sniffImageType(new Uint8Array(buf)) }),
  )
  iconCache.set(key, blobUrl)
  return blobUrl
}

/** 头像缓存：同一主体只取一次；无头像时服务端返回 404，由调用方回落。 */
const avatarCache = new Map<string, string>()
const avatarPending = new Map<string, Promise<string>>()
/** 404 的主体不再重复请求（列表页重进时会重新挂载组件）。 */
const avatarMissing = new Set<string>()
/** 上次成功的主机，下次优先用它，避免每次都先撞不可用地址。 */
let avatarPreferredHost = ''

/** 存储服务在 token 失效时会 302 到登录页，正文是 HTML，不能当图片缓存。 */
function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return true
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return true
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return true
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return true
  return false
}

/**
 * 依次尝试头像候选地址；token 失效（302 / 401）时刷新一次 token 后重来。
 * 404 代表服务端确实没有这张图，直接抛给调用方记入 avatarMissing。
 */
async function fetchAvatarBytes(
  id: string,
  type: number,
  refreshed = false,
): Promise<{ buf: ArrayBuffer; host: string }> {
  let urls = avatarCandidates(id, type)
  if (!urls.length) throw new Error('缺少存储服务地址')
  if (avatarPreferredHost) {
    urls = urls
      .slice()
      .sort(
        (a, b) =>
          Number(b.startsWith(avatarPreferredHost)) -
          Number(a.startsWith(avatarPreferredHost)),
      )
  }
  let lastErr: Error | null = null
  for (const url of urls) {
    try {
      const buf = await httpArrayBuffer(url, { maxRedirections: 0 })
      if (!looksLikeImage(new Uint8Array(buf))) throw new Error('HTTP 302')
      return { buf, host: new URL(url).origin }
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      const message = lastErr.message
      if (message.includes('404')) break
      // 401 / 30x 是凭证问题，换主机没用，刷新 token 后重放一次。
      if (!refreshed && /401|30[1278]/.test(message)) {
        if (await authService.refreshToken()) return fetchAvatarBytes(id, type, true)
        break
      }
    }
  }
  throw lastErr || new Error('头像加载失败')
}

/** 列表页一次会挂载很多头像，限制并发，避免瞬间打满连接。 */
let avatarActive = 0
const avatarQueue: Array<() => void> = []
function acquireAvatarSlot(): Promise<void> {
  if (avatarActive < 4) {
    avatarActive += 1
    return Promise.resolve()
  }
  return new Promise(resolve => {
    avatarQueue.push(() => {
      avatarActive += 1
      resolve()
    })
  })
}
function releaseAvatarSlot() {
  avatarActive -= 1
  avatarQueue.shift()?.()
}

export async function getAvatarUrl(id: string, type = 1): Promise<string> {
  const key = `${type}:${id}`
  if (avatarMissing.has(key)) throw new Error('无头像')
  const cached = avatarCache.get(key)
  if (cached) return cached
  const pending = avatarPending.get(key)
  if (pending) return pending
  const task = (async () => {
    await acquireAvatarSlot()
    try {
      const { buf, host } = await fetchAvatarBytes(id, type)
      const blobUrl = URL.createObjectURL(
        new Blob([buf], { type: sniffImageType(new Uint8Array(buf)) }),
      )
      avatarCache.set(key, blobUrl)
      avatarPreferredHost = host
      return blobUrl
    } catch (e: any) {
      // 只有服务端明确回 404 才记住「没头像」；证书/token/网络问题不能让头像永久空白。
      if (String(e?.message || '').includes('404')) avatarMissing.add(key)
      throw e
    } finally {
      releaseAvatarSlot()
    }
  })().finally(() => avatarPending.delete(key))
  avatarPending.set(key, task)
  return task
}

/**
 * 剪贴板截图常常没有正确后缀，而 msg_type 按后缀判定。
 * 没有图片后缀的统一改名为「截图 时间.扩展名」。
 */
export function normalizeClipboardImage(file: File, mime: string): File {
  const name = String(file?.name || '')
  const tail = name.includes('.')
    ? (name.split('.').pop() || '').toLowerCase()
    : ''
  if (/^(jpg|jpeg|png|gif|bmp|webp|heic|heif)$/.test(tail)) return file
  const sub = String(mime || '').split('/')[1] || 'png'
  const ext = sub === 'jpeg' ? 'jpg' : /^[a-z0-9]{1,7}$/.test(sub) ? sub : 'png'
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('') +
    '-' +
    [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join('')
  try {
    return new File([file], `截图 ${stamp}.${ext}`, {
      type: mime || file.type,
    })
  } catch {
    return file
  }
}

/** 官方合并转发先上传明细，再在消息中携带详情 ID。 */
export async function uploadForwardDetails(messages: unknown[]): Promise<string> {
  if (JSON.stringify(messages).length > 20000) throw new Error('合并转发内容过长，请减少消息数量')
  const base = getServerPaths().embHttpUri.replace(/\/+$/, '')
  const result = await postForm<any>(base + '/emb/upload/forwardMsgDetail', {
    forwardMsgDetail: JSON.stringify(messages),
  })
  if ((result?.success === false) || (result?.s !== undefined && Number(result.s) !== 1)) {
    throw new Error(result?.m || result?.message || '上传合并转发详情失败')
  }
  const id = result?.data
  if (typeof id !== 'string' || !id.trim()) throw new Error('服务端未返回合并转发详情 ID')
  return id
}
