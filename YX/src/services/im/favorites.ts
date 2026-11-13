import { getServerPaths } from '../config'
import { httpJson } from '../http'
import type { ImMessage } from './im-client'
import { MsgType } from './types'

export interface Favorite {
  itemId: string
  contentType: number
  content: any
  sourceId: string
  sourceType: number
  sourceName: string
  sourceDisplayName: string
  createdDate?: string | number
  keyword?: string
}

export interface FavoriteMessageLocation extends ImMessage {
  sessionId: string
  sessionType: number
  sessionName?: string
}

function canonicalContent(value: unknown): string {
  const parsed = typeof value === 'string' ? parseContent(value) : value
  function sorted(item: any): any {
    if (Array.isArray(item)) return item.map(sorted)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])]))
  }
  return JSON.stringify(sorted(parsed))
}

/** 身份键和完整正文键分开索引；文本正文保持原类型，不将数字字符串解析为数字。 */
export function favoriteMatchKeys(favorite: Pick<Favorite, 'sourceId' | 'contentType' | 'itemId' | 'content'>): { identity: string; content: string } {
  const type = Number(favorite.contentType)
  return {
    identity: JSON.stringify([favorite.sourceId, type, favorite.itemId]),
    content: JSON.stringify([favorite.sourceId, type, type === 1 ? favorite.content : canonicalContent(favorite.content)]),
  }
}

/** 收藏没有可靠消息 ID 时，只用发送人、类型及完整正文匹配；多次发送的同内容保留为多个候选。 */
export function favoriteMatchesMessage(favorite: Favorite, message: ImMessage): boolean {
  if (!favorite.sourceId || message.from_id !== favorite.sourceId) return false
  try {
    const candidate = messageFavorite(message)
    const expected = favoriteMatchKeys(favorite)
    const actual = favoriteMatchKeys(candidate)
    return expected.identity === actual.identity || expected.content === actual.content
  } catch { return false }
}

export function favoriteMessageLocations(favorite: Favorite, messages: FavoriteMessageLocation[]): FavoriteMessageLocation[] {
  const matches = new Map<string, FavoriteMessageLocation>()
  for (const message of messages) {
    if (!message.sessionId || !message.msg_id || !favoriteMatchesMessage(favorite, message)) continue
    matches.set(`${message.sessionType}|${message.sessionId}|${message.msg_id}`, message)
  }
  return [...matches.values()].sort((a, b) => Number(b.send_time) - Number(a.send_time))
}

/** 与官方 b64_md5(encodeUtf8(...)) 一致；用于服务端收藏去重，不用于安全校验。 */
function md5Base64(text: string): string {
  const input = new TextEncoder().encode(text)
  const data = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  data.set(input)
  data[input.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(data.length - 8, input.length * 8, true)
  view.setUint32(data.length - 4, Math.floor(input.length / 0x20000000), true)
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let offset = 0; offset < data.length; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      const round = Math.floor(i / 16)
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d)
      const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16
      const sum = (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) + view.getUint32(offset + g * 4, true)) | 0
      const shift = shifts[round * 4 + i % 4]!
      a = d; d = c; c = b; b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0
  }
  const result = new Uint8Array(16)
  const output = new DataView(result.buffer)
  ;[a0, b0, c0, d0].forEach((value, i) => output.setInt32(i * 4, value, true))
  return btoa(String.fromCharCode(...result))
}

function parseContent(content: any): any {
  if (typeof content !== 'string') return content
  try { return JSON.parse(content) } catch { return content }
}

/** 字段及类型映射来自官方 home.js 的 msgFavor；不支持的类型明确拒绝。 */
export function messageFavorite(message: ImMessage, session?: { name: string; type: number }): Favorite {
  if (!message || typeof message.from_id !== 'string' || !message.from_id.trim()) throw new Error('消息缺少发送人，无法收藏')
  const sender = message.from_id
  const type = Number(message.msg_type)
  const supported = [1, 2, 3, 5, 6, 7, 10, 11, 14, 23, 24, 27, 28, 29, 96]
  if (!supported.includes(type)) throw new Error('此消息类型暂不支持服务端收藏')
  let content = type === MsgType.TEXT ? message.content : parseContent(message.content)
  if (type === MsgType.TEXT) {
    if (typeof content !== 'string' || !content.trim()) throw new Error('文字消息内容为空，无法收藏')
  } else if (type === MsgType.RICHTEXT) {
    if (!Array.isArray(content) || !content.length || content.some(item => !item || typeof item !== 'object')) throw new Error('富文本消息格式不正确，无法收藏')
  } else if (!content || typeof content !== 'object' || Array.isArray(content) || !Object.keys(content).length) {
    throw new Error('消息内容格式不正确，无法收藏')
  }
  function attachmentIdentity(): string {
    if (typeof content?.download_url !== 'string' || !content.download_url.trim()) throw new Error('消息缺少附件地址，无法收藏')
    return sender + content.download_url
  }
  let contentType: number
  let identity = ''
  let brief = ''
  let itemId = ''
  switch (Number(message.msg_type)) {
    case MsgType.TEXT: contentType = 1; identity = sender + content; brief = content; break
    case MsgType.RICHTEXT:
      if (Array.isArray(content) && content.length === 1 && Number(content[0].msg_type) === MsgType.PHOTO) {
        content = parseContent(content[0].content); contentType = 3; identity = attachmentIdentity()
      } else { contentType = 9; identity = sender + JSON.stringify(content) }
      break
    case MsgType.VOICE: contentType = 2; identity = attachmentIdentity(); break
    case MsgType.PHOTO: contentType = 3; identity = attachmentIdentity(); break
    case MsgType.VEDIO:
    case MsgType.BIGVIDEO: contentType = 4; identity = attachmentIdentity(); break
    case MsgType.SHARE:
      if (typeof content.action_param === 'string' && content.action_param.startsWith('[BlogMessage]')) {
        const match = content.action_param.match(/(?:^|\s)blogId=([^\s]+)/)
        if (!match) throw new Error('动态分享缺少 blogId，无法收藏')
        itemId = match[1]!; contentType = 8; content = { blogContent: content.msg_content || content.brief }
      } else {
        if (typeof content.url !== 'string' || !content.url.trim()) throw new Error('分享消息缺少链接，无法收藏')
        contentType = 5; identity = sender + content.url
        content = { brief: content.msg_content || content.brief, url: content.url }
      }
      brief = content.brief || ''
      break
    case MsgType.FILE: contentType = 6; identity = attachmentIdentity(); brief = content.file_name || ''; break
    case MsgType.DISKSHARE:
      if (typeof content.shareId !== 'string' || !content.shareId.trim()) throw new Error('云盘分享缺少标识，无法收藏')
      contentType = 7; identity = sender + content.shareId; brief = content.shareName || ''; break
    case MsgType.ADDRESS: contentType = 10; identity = sender + content.longitude + content.latitude; brief = content.addr || ''; break
    case MsgType.COMBINE: contentType = 11; identity = sender + JSON.stringify(content); brief = content.brief || ''; break
    case MsgType.SERVICE: contentType = 12; identity = sender + JSON.stringify(content); brief = content.title || content.brief || ''; break
    case MsgType.EMOJI:
      // 官方此分支漏设 identity，导致所有表情共用 MD5(空串)；沿用卡片的正文去重方式避免覆盖。
      contentType = 28; identity = sender + JSON.stringify(content); brief = content.title || content.brief || ''; break
    case MsgType.ADAPTIVECAED:
    case MsgType.TEMPLATECARD: contentType = Number(message.msg_type); identity = sender + JSON.stringify(content); brief = content.brief || ''; break
    default: throw new Error('此消息类型暂不支持服务端收藏')
  }
  const sourceName = message.from_name || ''
  const sourceDisplayName = sourceName + (session && [2, 4].includes(session.type) ? '-' + session.name : '')
  return {
    itemId: itemId || md5Base64(identity), contentType,
    content: typeof content === 'object' ? JSON.stringify(content) : content,
    sourceId: sender, sourceType: message.from_type, sourceName, sourceDisplayName,
    keyword: sourceName + sourceDisplayName + brief,
  }
}

export function favoriteId(message: ImMessage): string { return messageFavorite(message).itemId }

function endpoint(): string { return getServerPaths().uamApiUri.replace(/\/+$/, '') + '/v1/favorites' }
function checkResponse(data: any): void {
  if (Number(data?.code) !== 200) throw new Error(data?.message || data?.msg || '收藏操作失败')
}

export async function favoriteMessage(message: ImMessage, session?: { name: string; type: number }): Promise<string> {
  const favorite = messageFavorite(message, session)
  const data = await httpJson(endpoint(), { method: 'POST', body: { ...favorite, syncBlogFavor: false } })
  checkResponse(data)
  return favorite.itemId
}

export async function fetchFavorites(options: { keyword?: string; contentTypes?: string; cursor?: string | number } = {}): Promise<Favorite[]> {
  const query = new URLSearchParams({ keyword: options.keyword || '', contentTypes: options.contentTypes || '', cursor: String(options.cursor ?? ''), limit: '15' })
  const data = await httpJson(endpoint() + '?' + query)
  checkResponse(data)
  if (!Array.isArray(data.data) || data.data.some((item: any) => !item || typeof item.itemId !== 'string' || !item.itemId.trim() || !Number.isFinite(Number(item.contentType)) || item.content === null || item.content === undefined)) {
    throw new Error('收藏列表响应格式不正确')
  }
  return data.data.map((item: Favorite) => ({ ...item, contentType: Number(item.contentType) }))
}

export async function removeFavorite(itemId: string, syncBlogFavor = false): Promise<void> {
  if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('缺少收藏标识，无法取消收藏')
  const data = await httpJson(endpoint() + '/' + encodeURIComponent(itemId) + '?syncBlogFavor=' + syncBlogFavor, { method: 'DELETE' })
  checkResponse(data)
}

/** 收藏类型与 IM 类型不同，展示前转换；收藏正文没有 IM 传输混淆。 */
export function favoriteMessageType(contentType: number): number {
  return ({ 1: 1, 2: 6, 3: 2, 4: 5, 5: 10, 6: 3, 7: 14, 8: 10, 9: 96, 10: 7, 11: 24, 12: 11, 27: 27, 28: 28, 29: 29 } as Record<number, number>)[contentType] || 901117
}

export function favoriteContent(favorite: Favorite): any {
  return favorite.contentType === 1 ? favorite.content : parseContent(favorite.content)
}
