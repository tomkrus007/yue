import type { ImMessage } from './im-client'
import { MsgType } from './types'

export interface MessageReaction {
  userId: string
  name: string
  emoji: string
  time: number
  active: boolean
}

export interface MessageRecall {
  type: number
  time: number
  hidden: boolean
}

export interface MessageInteractions {
  reactions: Record<string, MessageReaction[]>
  recalls: Record<string, MessageRecall>
  readers: Record<string, Record<string, string>>
  readTimes: Record<string, Record<string, number>>
}

export function emptyInteractions(): MessageInteractions {
  return { reactions: {}, recalls: {}, readers: {}, readTimes: {} }
}

export function mentionsUser(message: ImMessage, userId: string): boolean {
  const ids = Array.isArray(message.at_user_ids)
    ? message.at_user_ids.map(String)
    : String(message.at_user_ids || '').split(',').map(id => id.trim())
  return !!userId && (ids.includes(userId) || ids.includes('ALL'))
}

/** 回应与撤回可能先于原消息抵达；保留目标状态，历史加载时同样应用。 */
export function applyInteraction(state: MessageInteractions, message: ImMessage): boolean {
  const type = Number(message.msg_type)
  const content = message.content
  const time = Number(message.send_time) || 0
  if (type === MsgType.CTRL) {
    const cmd = Number(content?.cmd)
    const params = content?.params
    if ([1000, 1001].includes(cmd) && params?.msgId && typeof params.emoji === 'string') {
      const list = state.reactions[params.msgId] ||= []
      const previous = list.find(item => item.userId === message.from_id && item.emoji === params.emoji)
      if (!previous || time >= previous.time) {
        const next = { userId: message.from_id, name: message.from_name, emoji: params.emoji, time, active: cmd === 1000 }
        if (previous) Object.assign(previous, next)
        else list.push(next)
      }
      return true
    }
    if (cmd === 99 && params?.msgIds) {
      for (const id of String(params.msgIds).split(',').filter(Boolean)) {
        if (!state.recalls[id] || time >= state.recalls[id].time) {
          state.recalls[id] = { type: MsgType.RECALL, time, hidden: content.traceless === true || content.traceless === 'true' }
        }
      }
      return true
    }
  }
  if (type === MsgType.RECALL || type === MsgType.ADMINRECALL) {
    const id = type === MsgType.RECALL ? content : content?.msgId
    if (typeof id === 'string' && id) {
      if (!state.recalls[id] || time >= state.recalls[id].time) state.recalls[id] = { type, time, hidden: false }
      return true
    }
  }
  if (type === MsgType.READED && content?.readMsgIds) {
    for (const id of String(content.readMsgIds).split(',').filter(Boolean)) {
      ;(state.readers[id] ||= {})[message.from_id] = message.from_name || message.from_id
      const times = state.readTimes[id] ||= {}
      times[message.from_id] = Math.max(times[message.from_id] || 0, time)
      if (Number(content.cmd) === 1) state.recalls[id] = { type: MsgType.RECALL, time, hidden: true }
    }
    return true
  }
  return false
}

/** 跟随引用找到讨论根消息，防止损坏数据形成循环。 */
export function replyRoot(messageId: string, messages: ImMessage[]): string {
  const byId = new Map(messages.map(message => [message.msg_id, message]))
  const visited = new Set<string>()
  let id = messageId
  while (!visited.has(id)) {
    visited.add(id)
    const parent = byId.get(id)?.reply_msg_id
    if (!parent || visited.has(parent)) break
    id = parent
  }
  return id
}
