/**
 * 图片 / 文件消息：上传、下载地址与响应解析。
 *
 * 上传请求来自官方 Go 客户端实测抓包：
 *   POST {storeUri}store/putFile?module=message&security=0
 *   Authorization: Bearer <token>
 *   multipart: file / fileName / size
 *
 * 下载：{storeUri}v2/{download_url}/download?access_token=
 * 存储服务回 application/octet-stream + nosniff，图片必须取字节后转 blob URL。
 */
import { fetch } from '@tauri-apps/plugin-http'
import { authService } from '../auth'
import { getServerPaths } from '../config'
import { httpArrayBuffer } from '../http'
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

function buildUploadForm(file: File): FormData {
  const fd = new FormData()
  fd.append('file', file, file.name)
  fd.append('fileName', file.name)
  fd.append('size', String(file.size))
  return fd
}

/**
 * XHR 在 WebView 里可能被 CORS 挡住（Tauri 的 origin 与参考网页不同），
 * 这时退回 plugin-http 的 fetch：走 Rust 侧请求，不受 CORS 限制，只是没有进度。
 */
async function uploadViaTauri(
  url: string,
  file: File,
  token: string,
): Promise<{ status: number; text: string }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    body: buildUploadForm(file),
  })
  return { status: resp.status, text: await resp.text() }
}

function uploadOnce(
  url: string,
  file: File,
  token: string,
  onProgress?: (pct: number) => void,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url, true)
    xhr.timeout = 10 * 60 * 1000
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token)
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () =>
      resolve({ status: xhr.status, text: xhr.responseText || '' })
    xhr.onerror = () => {
      uploadViaTauri(url, file, token).then(resolve, (e) =>
        reject(new Error('网络错误（CORS 或连接失败）: ' + (e?.message || e))),
      )
    }
    xhr.ontimeout = () => reject(new Error('上传超时'))
    xhr.onabort = () => reject(new Error('上传已取消'))
    xhr.send(buildUploadForm(file))
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
  let lastErr: Error | null = null
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const token = authService.getAccessToken()
        const res = await uploadOnce(url, file, token, onProgress)
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