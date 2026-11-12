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
 */
import { Channel, invoke } from '@tauri-apps/api/core'
import { authService } from '../auth'
import { getServerPaths } from '../config'
import { httpArrayBuffer, httpJson } from '../http'
import type { ImageMeta } from './content'

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

/** 图片候选地址：配置里的 storeUri，以及网关同路径。 */
export function imageCandidates(seg: ImageMeta, size = '0x1080'): string[] {
  const key = seg.downloadUrl
  if (!key) return []
  if (/^https?:/i.test(key)) return [key]
  const token = encodeURIComponent(authService.getAccessToken())
  const q = `size=${size}&access_token=${token}`
  const out: string[] = []
  const push = (origin?: string, pathname?: string) => {
    if (!origin) return
    const path = String(pathname || '/store').replace(/\/+$/, '')
    const url = origin.replace(/\/+$/, '') + path + '/v2/' + key + '/download?' + q
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

export function fileUrl(seg: ImageMeta): string {
  const key = seg.downloadUrl
  if (!key) return ''
  if (/^https?:/i.test(key)) return key
  const paths = getServerPaths()
  const base = String(paths.storeUri || '').replace(/\/+$/, '')
  if (!base) return ''
  return (
    base +
    '/v2/' +
    key +
    '/download?access_token=' +
    encodeURIComponent(authService.getAccessToken())
  )
}

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
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('预览地址无效')
  return url.href
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
  if (!key) throw new Error('缺少图片地址')
  if (/^https?:/i.test(key)) return key
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
