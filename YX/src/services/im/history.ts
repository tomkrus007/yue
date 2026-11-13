import { fetchHistory } from './session-api'
import type { HistoryPage } from './session-api'

/** 固定时间上界再用 skip 翻页，避免同一毫秒内消息超过一页时漏消息。 */
export class HistoryPager {
  offset = 0
  complete = false
  private signatures = new Set<string>()
  private inFlight: Promise<HistoryPage> | null = null
  private controller: AbortController | null = null
  constructor(readonly targetId: string, readonly targetType: number, readonly bound = Date.now()) {}
  next(limit = 100): Promise<HistoryPage> {
    if (this.inFlight) return this.inFlight
    if (this.complete) return Promise.resolve({ messages: [], total: this.offset })
    this.controller = new AbortController()
    const timer = setTimeout(() => this.controller?.abort(), 15000)
    this.inFlight = fetchHistory(this.targetId, this.targetType, { dateTime: this.bound, skip: this.offset, limit, signal: this.controller.signal }).then(page => {
      const signature = page.messages.map(message => message.msg_id).sort().join('|')
      if (signature && this.signatures.has(signature)) throw new Error('服务端历史分页未推进，已停止重复查询，请稍后重试')
      if (signature) this.signatures.add(signature)
      this.offset += page.messages.length
      this.complete = page.messages.length < limit
      return page
    }).finally(() => { clearTimeout(timer); this.inFlight = null; this.controller = null })
    return this.inFlight
  }
  cancel() { this.controller?.abort() }
}
