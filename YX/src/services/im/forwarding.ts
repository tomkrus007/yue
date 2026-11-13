import type { ImMessage } from './im-client'
import { MsgType } from './types'
import type { CardActionContext } from './card-actions'

function protectedMessage(message: ImMessage): boolean {
  return String(message.is_need_read_receipt) === 'true' || String(message.is_delete_after_read) === 'true' || [66, 67].includes(Number(message.msg_type))
}
function validateForward(message: ImMessage, depth = 0) {
  if (protectedMessage(message)) throw new Error('记录中含受保护或已撤回消息，不可转发')
  if (depth > 8) throw new Error('嵌套记录层级较深，请选择需要的原消息逐一转发')
  if (Number(message.msg_type) === MsgType.COMBINE && Array.isArray(message.content?.msgs)) {
    for (const row of message.content.msgs) validateForward(row, depth + 1)
  }
}

/** 保留原发送人、附件与引用快照，不携带本机投递状态。 */
export function forwardEnvelope(messages: ImMessage[], known: ImMessage[] = []) {
  if (!messages.length) throw new Error('请先选择消息或文件')
  const ordered = [...messages].sort((a, b) => Number(a.send_time) - Number(b.send_time))
  const byId = new Map(known.map(message => [message.msg_id, message]))
  function cleanContent(type: number, content: any, depth: number, path: Set<string>): any {
    if (depth > 8) throw new Error('引用或记录嵌套较深，请选择原消息逐一转发')
    if (type !== MsgType.COMBINE || !Array.isArray(content?.msgs)) return content
    return { ...content, msgs: content.msgs.map((row: ImMessage) => pack(row, depth + 1, path)) }
  }
  function pack(message: ImMessage, depth = 0, path = new Set<string>()): Record<string, any> {
    validateForward(message)
    const nextPath = new Set(path)
    if (message.msg_id) nextPath.add(message.msg_id)
    const source = message.reply_msg_id ? byId.get(message.reply_msg_id) : undefined
    const masked = !!source && protectedMessage(source)
    const cyclic = !!source && nextPath.has(source.msg_id)
    const replyType = masked || cyclic ? MsgType.TEXT : source?.msg_type || message.reply_msg_type
    const replyContent = masked ? '[受保护消息]' : cyclic ? '[引用原消息]' : cleanContent(Number(replyType), source?.content ?? message.reply_content, depth + 1, nextPath)
    return {
      msg_id: message.msg_id, msg_type: message.msg_type, content: cleanContent(Number(message.msg_type), message.content, depth, nextPath),
      from_id: message.from_id, from_name: message.from_name, from_type: message.from_type,
      to_id: message.to_id, to_name: message.to_name, to_type: message.to_type, send_time: message.send_time,
      ...(message.reply_msg_id ? {
        reply_msg_id: message.reply_msg_id, reply_from_id: source?.from_id || message.reply_from_id,
        reply_from_name: source?.from_name || message.reply_from_name, reply_msg_type: replyType, reply_content: replyContent,
      } : {}),
    }
  }
  return { brief: '[聊天记录]', from_name: ordered[0].from_name, to_name: ordered[0].to_name, msgs: ordered.map(message => pack(message)) }

}

/** 超过原版单条 20000 字符上限时拆成多条记录，单条过大则明确要求逐一转发。 */
export function splitForwardBatches(messages: ImMessage[], known: ImMessage[] = [], maximum = 20000): ImMessage[][] {
  const batches: ImMessage[][] = []
  let batch: ImMessage[] = []
  for (const message of [...messages].sort((a, b) => Number(a.send_time) - Number(b.send_time))) {
    const next = [...batch, message]
    if (JSON.stringify(forwardEnvelope(next, known)).length <= maximum) { batch = next; continue }
    if (!batch.length || JSON.stringify(forwardEnvelope([message], known)).length > maximum) throw new Error('其中一条消息超过合并记录大小限制，请切换为逐一转发')
    batches.push(batch)
    batch = [message]
  }
  if (batch.length) batches.push(batch)
  return batches
}

/** 仅使用已经取得的明细填充 ID 引用；不猜测未核实的远端详情接口。 */
export function hydrateForwardContent(content: any, known: ImMessage[]): any {
  const details = new Map<string, any>()
  function index(value: any, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return
    if (value.forwardMsgDetailId && Array.isArray(value.msgs) && value.msgs.length) details.set(String(value.forwardMsgDetailId), value)
    for (const row of Array.isArray(value.msgs) ? value.msgs : []) index(row?.content, depth + 1)
  }
  for (const message of known) if (Number(message.msg_type) === MsgType.COMBINE) index(message.content)
  function hydrate(value: any, path = new Set<string>(), depth = 0): any {
    if (!value || typeof value !== 'object' || depth > 8) return value
    const id = String(value.forwardMsgDetailId || '')
    if (id && path.has(id)) return value
    const nextPath = new Set(path)
    if (id) nextPath.add(id)
    const source = !value.msgs?.length && id && details.has(id) ? details.get(id) : value
    if (!Array.isArray(source.msgs)) return value
    return { ...source, msgs: source.msgs.map((row: any) => ({ ...row, content: Number(row.msg_type) === MsgType.COMBINE ? hydrate(row.content, nextPath, depth + 1) : row.content })) }
  }
  return hydrate(content)
}

/** 转发内卡片使用原消息自己的会话身份，不借用外层接收会话。 */
export function forwardRowContext(message: ImMessage | undefined, me: string): CardActionContext | undefined {
  if (!message) return undefined
  const multi = [2, 4, 8].includes(Number(message.to_type))
  const mine = message.from_id === me
  const received = message.to_id === me
  return {
    message, messageId: message.msg_id,
    sessionId: multi || mine ? message.to_id : received ? message.from_id : undefined,
    sessionType: multi || mine ? Number(message.to_type) : Number(message.from_type) || 1,
    sessionName: multi || mine ? message.to_name : message.from_name,
  }
}
