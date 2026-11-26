import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { authService } from '../services/auth'
import type { ImMessage } from '../services/im/im-client'
import { mentionsUser } from '../services/im/interactions'
import { messageText } from '../services/im/content'
import { deleteState, getState, putState } from '../services/im/store'

export interface MentionNotice {
  id: string
  sessionId: string
  sessionName: string
  sessionType: number
  sender: string
  time: number
  preview: string
  status: 'pending' | 'done'
  handledBy?: 'received' | 'reply' | 'manual'
  handledAt?: number
}

/** 提醒处理状态独立于会话未读；打开群聊不会消除待回复事项。 */
export const useMentionsStore = defineStore('mentions', () => {
  const notices = ref<Record<string, MentionNotice>>({})
  const removed = ref<Record<string, number>>({})
  let account = ''
  let hydratedFor = ''
  let hydration: Promise<void> | null = null
  let hydrationEpoch = 0
  const pendingNotices = new Set<string>()
  const pendingRemoved = new Set<string>()
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  const WRITE_DELAY = 500

  async function loadState(target: string, epoch: number): Promise<void> {
    const [rows, removedRows] = await Promise.all([
      getState(target, 'mention'),
      getState(target, 'mention_removed'),
    ])
    if (epoch !== hydrationEpoch || account !== target) return
    const removedIds = new Set(removedRows.map(row => row.key))
    for (const row of rows) {
      if (removedIds.has(row.key)) continue
      // 启动期间新收到的提醒优先，不能被旧快照覆盖；但新提醒还没处理时，
      // 数据库里「已处理」的状态要保留，否则重启后已读事项会重新变待办。
      const existing = notices.value[row.key]
      let notice: MentionNotice
      try {
        notice = JSON.parse(row.value) as MentionNotice
        if (!notice?.id) continue
      } catch {
        continue
      }
      if (existing) {
        if (!pendingNotices.has(row.key) && notice.status === 'done' && existing.status === 'pending') {
          existing.status = 'done'
          existing.handledBy = notice.handledBy
          existing.handledAt = notice.handledAt
        }
        continue
      }
      notices.value[notice.id] = notice
    }
    for (const row of removedRows) {
      if (!(row.key in removed.value)) removed.value[row.key] = Number(row.value) || Date.now()
    }
  }

  /** 按当前账号恢复提醒；重置账号后旧请求的结果会被 epoch 丢弃。 */
  function hydrate(): Promise<void> {
    const next = authService.getCurrentUserId()
    if (next !== account) {
      account = next
      notices.value = {}
      removed.value = {}
      hydratedFor = ''
      hydration = null
      hydrationEpoch++
    }
    if (!account || hydratedFor === account) return hydration || Promise.resolve()
    if (!hydration) {
      const epoch = ++hydrationEpoch
      hydration = loadState(account, epoch)
        .then(() => {
          if (epoch === hydrationEpoch && account) hydratedFor = account
        })
        .catch(() => {
          /* 本地缓存不可用时保持内存模式 */
        })
        .finally(() => {
          if (epoch === hydrationEpoch) hydration = null
        })
    }
    return hydration
  }

  function ensureAccount(): void {
    void hydrate()
  }

  function schedule() {
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      void flush()
    }, WRITE_DELAY)
  }

  async function flush(): Promise<void> {
    const target = account
    if (!target) return
    const noticeIds = [...pendingNotices]
    pendingNotices.clear()
    const removedIds = [...pendingRemoved]
    pendingRemoved.clear()
    const entries = noticeIds
      .filter(id => notices.value[id])
      .map(id => ({ key: id, value: JSON.stringify(notices.value[id]) }))
    const dropped = noticeIds.filter(id => !notices.value[id])
    if (entries.length) await putState(target, 'mention', entries)
    const deleted = [...new Set([...dropped, ...removedIds])]
    if (deleted.length) await deleteState(target, 'mention', deleted)
    if (removedIds.length) {
      await putState(target, 'mention_removed', removedIds.map(id => ({ key: id, value: String(removed.value[id]) })))
    }
  }

  function markNotice(id: string) {
    if (!id) return
    pendingNotices.add(id)
    schedule()
  }

  function observe(message: ImMessage, session: { id: string; name: string; type: number }, historical = false) {
    ensureAccount()
    if (removed.value[message.msg_id]) return
    if (message.from_id === account || !mentionsUser(message, account) || [0, 66, 67, 95, 97].includes(Number(message.msg_type))) return
    if (historical && Number(message.is_read) !== 0 && !notices.value[message.msg_id]) return
    const previous = notices.value[message.msg_id]
    const protectedMessage = String(message.is_need_read_receipt) === 'true' || String(message.is_delete_after_read) === 'true'
    notices.value[message.msg_id] = {
      ...previous, id: message.msg_id, sessionId: session.id, sessionName: session.name, sessionType: session.type,
      sender: message.from_name || '未知', time: Number(message.send_time) || 0,
      preview: protectedMessage ? '[受保护消息]' : messageText(Number(message.msg_type), message.content).slice(0, 200),
      status: previous?.status || 'pending',
    }
    markNotice(message.msg_id)
  }
  function handle(id: string, by: MentionNotice['handledBy'] = 'manual') {
    ensureAccount()
    const notice = notices.value[id]
    if (!notice || notice.status === 'done') return
    notice.status = 'done'; notice.handledBy = by; notice.handledAt = Date.now()
    markNotice(id)
  }
  function reopen(id: string) {
    ensureAccount()
    const notice = notices.value[id]
    if (!notice) return
    notice.status = 'pending'; delete notice.handledBy; delete notice.handledAt
    markNotice(id)
  }
  function handleAll() {
    ensureAccount()
    const handledAt = Date.now()
    for (const notice of Object.values(notices.value)) {
      if (notice.status !== 'pending') continue
      notice.status = 'done'; notice.handledBy = 'manual'; notice.handledAt = handledAt
      markNotice(notice.id)
    }
  }
  function remove(id: string) {
    ensureAccount()
    if (removed.value[id]) return
    removed.value[id] = Date.now()
    delete notices.value[id]
    pendingNotices.delete(id)
    pendingRemoved.add(id)
    schedule()
  }
  function reset() {
    notices.value = {}
    removed.value = {}
    account = ''
    hydratedFor = ''
    hydration = null
    hydrationEpoch++
    pendingNotices.clear()
    pendingRemoved.clear()
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
  }
  ensureAccount()
  const all = computed(() => Object.values(notices.value).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id)))
  const pending = computed(() => all.value.filter(notice => notice.status === 'pending'))
  /** 页面隐藏/退出前立即落盘（无待写项时是空操作）。 */
  function flushNow(): Promise<void> {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    return flush()
  }
  return { notices, all, pending, observe, handle, handleAll, reopen, remove, ensureAccount, hydrate, flush: flushNow, reset }
})
