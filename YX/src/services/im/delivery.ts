import type { ImMessage } from './im-client'

export interface DeliveryState {
  state: 'pending' | 'queued' | 'failed' | 'confirmed'
  attempts: number
  updatedAt: number
}

/** 重试复用消息 ID；显式拒绝不自动重试，确认超时最多发送三次。 */
export class MessageDelivery {
  private pending = new Map<string, ImMessage>()
  private tracked = new Map<string, ImMessage>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private handlers: {
    connected: () => boolean
    resend: (message: ImMessage) => void
    changed: (message: ImMessage) => void
    confirmed?: (message: ImMessage) => void
  }, private timeout = 15000) {}

  private clear(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
  }
  private change(message: ImMessage, state: DeliveryState['state'], error?: string) {
    message.__delivery = { state, attempts: message.__delivery?.attempts || 1, updatedAt: Date.now() }
    message.__sent = state === 'confirmed'
    if (error) message.__error = error
    else delete message.__error
    this.handlers.changed(message)
  }
  private arm(message: ImMessage) {
    this.clear(message.msg_id)
    this.timers.set(message.msg_id, setTimeout(() => {
      this.clear(message.msg_id)
      if (!this.pending.has(message.msg_id)) return
      if (!this.handlers.connected()) return this.change(message, 'queued', '连接中断，恢复后继续确认')
      if ((message.__delivery?.attempts || 1) >= 3) {
        this.pending.delete(message.msg_id)
        this.change(message, 'failed', '服务端确认超时，请重试；重试会复用原消息编号')
      } else this.sendAgain(message)
    }, this.timeout))
  }
  private sendAgain(message: ImMessage) {
    if (!this.handlers.connected()) return this.change(message, 'queued', '等待连接恢复')
    try {
      this.handlers.resend(message)
      message.__delivery = { state: 'pending', attempts: (message.__delivery?.attempts || 0) + 1, updatedAt: Date.now() }
      this.change(message, 'pending')
      this.arm(message)
    } catch {
      this.change(message, 'queued', '连接中断，恢复后继续发送')
    }
  }
  track(message: ImMessage) {
    if (this.pending.has(message.msg_id) || message.__sent) return
    this.pending.set(message.msg_id, message)
    this.tracked.set(message.msg_id, message)
    message.__delivery = { state: 'pending', attempts: 1, updatedAt: Date.now() }
    this.change(message, 'pending')
    this.arm(message)
  }
  acknowledge(id: string, success: boolean, error?: string): boolean {
    const message = this.tracked.get(id)
    if (!message) return false
    if (message.__sent) return success
    this.clear(id)
    this.pending.delete(id)
    this.change(message, success ? 'confirmed' : 'failed', error)
    if (success) this.handlers.confirmed?.(message)
    return true
  }
  restore(messages: ImMessage[]) {
    // 只合并、不清空：数据库恢复可能晚于用户刚发出的消息，不能把新队列冲掉。
    for (const message of messages) {
      if (this.tracked.has(message.msg_id)) continue
      if (message.__delivery) this.tracked.set(message.msg_id, message)
      if (message.__sent || !['pending', 'queued'].includes(message.__delivery?.state || '')) continue
      this.pending.set(message.msg_id, message)
      this.change(message, 'queued', '等待连接恢复后确认')
    }
  }
  suspend() {
    for (const [id, message] of this.pending) {
      this.clear(id)
      this.change(message, 'queued', '连接中断，恢复后继续确认')
    }
  }
  resume() {
    for (const message of this.pending.values()) {
      if (message.__delivery?.state !== 'queued') continue
      if ((message.__delivery?.attempts || 0) >= 3) {
        this.pending.delete(message.msg_id)
        this.change(message, 'failed', '重试次数已用尽，请手动重试')
      } else this.sendAgain(message)
    }
  }
  retry(message: ImMessage) {
    if (this.pending.has(message.msg_id) && message.__delivery?.state === 'pending') throw new Error('消息正在等待确认，请勿重复提交')
    this.pending.set(message.msg_id, message)
    this.tracked.set(message.msg_id, message)
    message.__delivery = { state: 'queued', attempts: 0, updatedAt: Date.now() }
    this.sendAgain(message)
  }
  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pending.clear()
    this.tracked.clear()
  }
}
