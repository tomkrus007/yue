import { Channel, invoke } from '@tauri-apps/api/core'
import { fetch } from '@tauri-apps/plugin-http'
import type { ImageMeta } from './content'
import { downloadCandidates } from './media'
import { authService } from '../auth'

export interface SavedDownload { id: string; path: string }
export interface MediaLease { id: string; url: string; close: () => Promise<void> }
interface MediaRequest { kind: 'request' | 'abort'; id: string; method?: string; range?: string | null }

export function mediaMime(seg: ImageMeta, video = false): string {
  const extension = (seg.extension || seg.fileName.split('.').pop() || '').toLowerCase().replace(/^\./, '')
  const types: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: video ? 'video/ogg' : 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }
  return types[extension] || 'application/octet-stream'
}
function ensureAccount(accountId: string, controller: AbortController): void {
  if (authService.getCurrentUserId() !== accountId) {
    controller.abort()
    throw new Error('账号已切换，下载已取消')
  }
  if (controller.signal.aborted) throw new Error('下载已取消')
}
/** 网络层错误（TLS/证书/超时/连接失败）：值得换候选地址重试；HTTP 层错误交给上层处理。 */
function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /certificate|ssl|tls|network|timeout|timed?\s*out|aborted|failed to fetch|connection/i.test(message)
}
async function remoteResponse(seg: ImageMeta, controller: AbortController, accountId: string, range?: string | null, method = 'GET'): Promise<Response> {
  const signal = controller.signal
  const request = async (url: string) => {
    ensureAccount(accountId, controller)
    const response = await fetch(url, { method, signal, headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) } })
    try { ensureAccount(accountId, controller) }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error }
    return response
  }
  // store 主机遇证书/DNS 问题时换网关同路径重试；每个候选内再处理 401 刷新。
  const candidates = downloadCandidates(seg)
  if (!candidates.length) throw new Error('缺少下载地址')
  let lastError: unknown
  for (const url of candidates) {
    try {
      let response = await request(url)
      if (response.status === 401 && !signal.aborted) {
        await response.body?.cancel()
        ensureAccount(accountId, controller)
        const fresh = await authService.refreshToken()
        ensureAccount(accountId, controller)
        if (fresh) response = await request(url)
      }
      return response
    } catch (error) {
      if (controller.signal.aborted || authService.getCurrentUserId() !== accountId) throw error
      lastError = error
      if (!isNetworkError(error)) throw error
    }
  }
  throw lastError
}
/** plugin-http 的响应体按 pull 读取；每次原始字节 IPC 完成后再取下一块，避免大文件内存累计。 */
export async function readResponse(response: Response, signal: AbortSignal, write: (bytes: Uint8Array) => Promise<unknown>): Promise<number> {
  const reader = response.body?.getReader()
  if (!reader) return 0
  let received = 0
  try {
    while (true) {
      if (signal.aborted) throw new Error('下载已取消')
      const chunk = await reader.read()
      if (chunk.done) return received
      for (let offset = 0; offset < chunk.value.byteLength; offset += 256 * 1024) {
        if (signal.aborted) throw new Error('下载已取消')
        const bytes = chunk.value.subarray(offset, offset + 256 * 1024)
        await write(bytes)
        received += bytes.byteLength
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export async function saveAttachment(seg: ImageMeta, id: string, controller: AbortController, onProgress: (received: number, total?: number) => void): Promise<SavedDownload> {
  const accountId = authService.getCurrentUserId()
  let begun = false
  let response: Response | undefined
  try {
    response = await remoteResponse(seg, controller, accountId)
    ensureAccount(accountId, controller)
    if (!response.ok) { await response.body?.cancel(); throw new Error(`下载失败（HTTP ${response.status}）`) }
    const length = response.headers.get('content-length')
    const total = length !== null && !response.headers.get('content-encoding') && Number.isFinite(Number(length)) && Number(length) >= 0 ? Number(length) : undefined
    await invoke('attachment_download_begin', { id, name: seg.fileName || '文件', total: total ?? null })
    begun = true
    ensureAccount(accountId, controller)
    let written = 0
    onProgress(0, total)
    await readResponse(response, controller.signal, async bytes => {
      ensureAccount(accountId, controller)
      written = await invoke<number>('attachment_download_chunk', bytes, { headers: { 'x-download-id': id, 'x-download-offset': String(written) } })
      ensureAccount(accountId, controller)
      onProgress(written, total)
    })
    ensureAccount(accountId, controller)
    const saved = await invoke<SavedDownload>('attachment_download_commit', { id })
    ensureAccount(accountId, controller)
    return saved
  } catch (error) {
    if (begun) await invoke('attachment_download_cancel', { id }).catch(() => {})
    if (controller.signal.aborted) throw new Error('下载已取消')
    throw error
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}) }
}
export async function openMediaStream(seg: ImageMeta, video: boolean): Promise<MediaLease> {
  const accountId = authService.getCurrentUserId()
  const requests = new Map<string, AbortController>()
  const channel = new Channel<MediaRequest>()
  let closed = false
  let lease: { id: string; url: string } | undefined
  async function close() {
    if (closed) return
    closed = true
    for (const controller of requests.values()) controller.abort()
    requests.clear()
    if (lease) await invoke('media_stream_close', { id: lease.id })
  }
  async function respond(event: MediaRequest) {
    if (closed || event.kind === 'abort') { requests.get(event.id)?.abort(); return }
    if (authService.getCurrentUserId() !== accountId) { await close().catch(() => {}); return }
    const controller = new AbortController()
    requests.set(event.id, controller)
    let headerSent = false
    try {
      const response = await remoteResponse(seg, controller, accountId, event.range, event.method || 'GET')
      ensureAccount(accountId, controller)
      const headers: Record<string, string> = {}
      for (const key of ['content-length', 'content-range', 'content-type', 'etag', 'last-modified']) {
        const value = response.headers.get(key)
        if (value !== null) headers[key] = value
      }
      if (response.headers.get('content-encoding')) delete headers['content-length']
      await invoke('media_response_head', { id: event.id, head: { status: response.status, headers } })
      ensureAccount(accountId, controller)
      headerSent = true
      if (event.method !== 'HEAD') await readResponse(response, controller.signal, async bytes => {
        ensureAccount(accountId, controller)
        await invoke('media_response_chunk', bytes, { headers: { 'x-media-request': event.id } })
        ensureAccount(accountId, controller)
      })
      else await response.body?.cancel()
      ensureAccount(accountId, controller)
      await invoke('media_response_end', { id: event.id })
    } catch {
      if (authService.getCurrentUserId() !== accountId) { await close().catch(() => {}); return }
      if (!controller.signal.aborted) {
        if (!headerSent) await invoke('media_response_head', { id: event.id, head: { status: 502, headers: {} } }).catch(() => {})
        await invoke('media_response_end', { id: event.id }).catch(() => {})
      }
    } finally { controller.abort(); requests.delete(event.id) }
  }
  channel.onmessage = event => { void respond(event) }
  lease = await invoke<{ id: string; url: string }>('media_stream_open', { mime: mediaMime(seg, video), onRequest: channel })
  if (closed || authService.getCurrentUserId() !== accountId) {
    await invoke('media_stream_close', { id: lease.id }).catch(() => {})
    throw new Error('账号已切换，播放已取消')
  }
  return { ...lease, close }
}
export async function openConvertedMedia(id: string, video: boolean): Promise<MediaLease> {
  const lease = await invoke<{ id: string; url: string }>('media_local_open', { id, mime: video ? 'video/mp4' : 'audio/mp4' })
  return { ...lease, close: () => invoke('media_stream_close', { id: lease.id }) }
}
