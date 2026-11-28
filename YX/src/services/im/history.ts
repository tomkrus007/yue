import { fetchHistory } from './session-api'
import type { HistoryPage } from './session-api'
import type { ImMessage } from './im-client'

/**
 * 历史接口的 `skip` 在服务端无效（传 0 与非 0 返回同一页），`dateTime` 是毫秒时间戳且为
 * **含上界**。因此翻页只能把 `dateTime` 往更早的时间推，并用 msg_id 去重：
 * 含上界重查会重复当前最早一毫秒内已取到的消息，去重后只保留新消息。
 */
export class HistoryPager {
  offset = 0
  complete = false
  private cursor: number
  private seen = new Set<string>()
  private inFlight: Promise<HistoryPage> | null = null
  private controller: AbortController | null = null
  constructor(readonly targetId: string, readonly targetType: number, readonly bound = Date.now()) {
    this.cursor = bound
  }
  next(limit = 100): Promise<HistoryPage> {
    if (this.inFlight) return this.inFlight
    if (this.complete || this.cursor <= 0) {
      this.complete = true
      return Promise.resolve({ messages: [], total: this.offset })
    }
    this.controller = new AbortController()
    const timer = setTimeout(() => this.controller?.abort(), 15000)
    this.inFlight = fetchHistory(this.targetId, this.targetType, { dateTime: this.cursor, limit, signal: this.controller.signal }).then(page => {
      const messages: ImMessage[] = []
      for (const message of page.messages) {
        if (!message.msg_id || this.seen.has(message.msg_id)) continue
        this.seen.add(message.msg_id)
        messages.push(message)
      }
      this.offset += messages.length
      const oldest = Math.min(...page.messages.map(message => Number(message.send_time) || 0).filter(time => time > 0))
      if (page.messages.length < limit) {
        this.complete = true
      } else if (Number.isFinite(oldest) && oldest > 0) {
        // 有空出一条新消息时把上界推到本轮最早一条（含），下一轮才能捞到同毫秒的其余消息；
        // 整页都已见过说明服务端忽略了更早的上界，退一毫秒强制前进，避免无限重复查询。
        const nextCursor = messages.length && oldest < this.cursor ? oldest : oldest - 1
        if (nextCursor >= this.cursor) this.complete = true
        else this.cursor = nextCursor
      } else {
        this.complete = true
      }
      return { messages, total: page.total }
    }).finally(() => { clearTimeout(timer); this.inFlight = null; this.controller = null })
    return this.inFlight
  }
  cancel() { this.controller?.abort() }
}
