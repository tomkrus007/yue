/**
 * IM 的 REST 侧：会话列表、历史消息、用户上下文。
 * 实测要点：
 * - 会话列表：GET {embHttpUri}/emb/sessions/latest
 * - 历史：GET {embQueryUri}/get/history/date?targetId&targetType&skip&limit&dateTime
 *   dateTime 必须是毫秒时间戳，且是**含上界**；实测 `skip` 无效（传 0 与非 0 返回同一页），
 *   翻页要把 dateTime 往更早的时间推（见 `HistoryPager`）。
 * - 这两个接口的 content 仍是混淆状态，要自己解一次。
 */
import { getServerPaths } from '../config'
import { httpJson } from '../http'
import type { ImMessage } from './im-client'
import { decryptContent } from './protocol'
import { messageText } from './content'
import { MsgType } from './types'

const PLAIN_TYPES = new Set<number>([
  MsgType.TEXT,
  MsgType.RECALL,
  MsgType.WINDOWSHAKE,
  MsgType.ASCTRL,
])

export interface RemoteSession {
  id: string
  type: number
  name: string
  preview: string
  lastTime: number
}

export function normalizeList(data: any): any[] {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  for (const key of ['messages', 'data', 'list', 'records', 'rows']) {
    if (Array.isArray(data[key])) return data[key]
  }
  return []
}

export function decodeMessageContent(msg: any): ImMessage {
  const copy: any = { ...msg }
  if (typeof copy.content === 'string') {
    const plain = decryptContent(copy.content)
    if (PLAIN_TYPES.has(Number(copy.msg_type))) {
      copy.content = plain
    } else {
      try {
        copy.content = JSON.parse(plain)
      } catch {
        copy.content = plain
      }
    }
  }
  return copy as ImMessage
}

/** 历史接口可能返回 camelCase，统一成 IM 帧的字段名。 */
export function normalizeImMessage(raw: any): ImMessage {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null) return raw[k]
    }
    return undefined
  }
  return decodeMessageContent({
    msg_id: pick('msg_id', 'msgId'),
    msg_type: pick('msg_type', 'msgType'),
    content: pick('content'),
    from_type: pick('from_type', 'fromType'),
    from_id: pick('from_id', 'fromId'),
    from_name: pick('from_name', 'fromName'),
    from_company: pick('from_company', 'fromCompany'),
    from_device: pick('from_device', 'fromDevice'),
    to_type: pick('to_type', 'toType'),
    to_id: pick('to_id', 'toId'),
    to_name: pick('to_name', 'toName'),
    to_company: pick('to_company', 'toCompany'),
    send_time: pick('send_time', 'sendTime'),
    create_time: pick('create_time', 'createTime'),
    is_read: pick('is_read', 'isRead'),
    at_user_ids: pick('at_user_ids', 'atUserIds'),
    reply_msg_id: pick('reply_msg_id', 'replyMsgId'),
    reply_from_id: pick('reply_from_id', 'replyFromId'),
    reply_from_name: pick('reply_from_name', 'replyFromName'),
    reply_msg_type: pick('reply_msg_type', 'replyMsgType'),
    reply_content: pick('reply_content', 'replyContent'),
    is_need_read_receipt: pick('is_need_read_receipt', 'isNeedReadReceipt'),
    is_delete_after_read: pick('is_delete_after_read', 'isDeleteAfterRead'),
    is_need_send_read: pick('is_need_send_read', 'isNeedSendRead'),
    is_count_unread: pick('is_count_unread', 'isCountUnread'),
    talk_with_id: pick('talk_with_id', 'talkWithId'),
    talk_with_type: pick('talk_with_type', 'talkWithType'),
    talk_with_name: pick('talk_with_name', 'talkWithName'),
    offline: pick('offline'),
    __sent: true,
  })
}

export function previewOf(msg: any): string {
  if (!msg) return ''
  const decoded = normalizeImMessage(msg)
  if (String(decoded.is_delete_after_read) === 'true' || String(decoded.is_need_read_receipt) === 'true') return '[受保护消息]'
  return messageText(Number(decoded.msg_type), decoded.content)
    .replace(/\s+/g, ' ')
    .slice(0, 60)
}

/** 拉会话列表；Tauri 的 http 不受 CORS 限制。 */
export async function fetchSessions(): Promise<RemoteSession[]> {
  const base = getServerPaths().embHttpUri.replace(/\/+$/, '')
  if (!base) return []
  const data = await httpJson<any>(base + '/emb/sessions/latest')
  const list = normalizeList(data)
  const out: RemoteSession[] = []
  for (const raw of list) {
    if (!raw || !raw.chatId) continue
    out.push({
      id: String(raw.chatId),
      type: Number(raw.chatType) || 1,
      name: raw.chatName || raw.chatId,
      preview: previewOf(raw.lastMessage),
      lastTime: Number(raw.lastMessage?.send_time ?? raw.lastMessage?.sendTime) || 0,
    })
  }
  return out
}

export interface HistoryPage {
  messages: ImMessage[]
  total: number
}

export async function fetchHistory(
  targetId: string,
  targetType = 1,
  options: { limit?: number; dateTime?: number; skip?: number; signal?: AbortSignal } = {},
): Promise<HistoryPage> {
  const base = getServerPaths().embQueryUri.replace(/\/+$/, '')
  if (!base) throw new Error('缺少 embQueryUri，无法拉历史')
  const limit = options.limit ?? 50
  const dateTime = options.dateTime ?? Date.now()
  const q = new URLSearchParams({
    targetId,
    targetType: String(targetType || 1),
    skip: String(options.skip ?? 0),
    limit: String(limit),
    dateTime: String(dateTime),
  })
  const data = await httpJson<any>(base + '/get/history/date?' + q.toString(), { signal: options.signal })
  const list = normalizeList(data)
  return {
    messages: list
      .filter((m) => m && (m.msg_id || m.msgId))
      .map(normalizeImMessage),
    total: Number(data?.total) || list.length,
  }
}

export interface UserContext {
  id: string
  name: string
  companyCode: string
}

/** 登录后确定「我是谁」：GET {uamApiUri}/v1/users/context */
export async function fetchUserContext(): Promise<UserContext | null> {
  const base = getServerPaths().uamApiUri.replace(/\/+$/, '')
  if (!base) return null
  try {
    const data = await httpJson<any>(base + '/v1/users/context')
    const user = data?.data || data
    if (!user || typeof user !== 'object') return null
    return {
      id: String(user.id || user.userId || user.user_id || user.account || ''),
      name:
        user.name ||
        user.userName ||
        user.user_name ||
        user.displayName ||
        '',
      companyCode: user.eCode || user.companyCode || user.ecode || '',
    }
  } catch {
    return null
  }
}
