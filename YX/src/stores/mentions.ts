import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { authService } from '../services/auth'
import type { ImMessage } from '../services/im/im-client'
import { mentionsUser } from '../services/im/interactions'
import { stripHtml, toPlainText } from '../services/im/content'

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
  const key = () => `yl.im.mentions.${account}`
  function ensureAccount() {
    const next = authService.getCurrentUserId()
    if (next === account) return
    account = next
    try {
      const saved = JSON.parse(localStorage.getItem(key()) || '{}') || {}
      notices.value = saved.notices || saved
      removed.value = saved.removed || {}
    } catch { notices.value = {}; removed.value = {} }
  }
  function persist() { try { localStorage.setItem(key(), JSON.stringify({ notices: notices.value, removed: removed.value })) } catch { /* 保留内存状态 */ } }
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
      preview: protectedMessage ? '[受保护消息]' : stripHtml(toPlainText(Number(message.msg_type), message.content)).slice(0, 200),
      status: previous?.status || 'pending',
    }
    persist()
  }
  function handle(id: string, by: MentionNotice['handledBy'] = 'manual') {
    ensureAccount()
    const notice = notices.value[id]
    if (!notice || notice.status === 'done') return
    notice.status = 'done'; notice.handledBy = by; notice.handledAt = Date.now()
    persist()
  }
  function reopen(id: string) {
    ensureAccount()
    const notice = notices.value[id]
    if (!notice) return
    notice.status = 'pending'; delete notice.handledBy; delete notice.handledAt
    persist()
  }
  function handleAll() {
    ensureAccount()
    const handledAt = Date.now()
    let changed = false
    for (const notice of Object.values(notices.value)) {
      if (notice.status !== 'pending') continue
      notice.status = 'done'; notice.handledBy = 'manual'; notice.handledAt = handledAt
      changed = true
    }
    if (changed) persist()
  }
  function remove(id: string) {
    ensureAccount()
    if (removed.value[id]) return
    removed.value[id] = Date.now()
    delete notices.value[id]
    persist()
  }
  function reset() { notices.value = {}; removed.value = {}; try { localStorage.removeItem(key()) } catch { /* 忽略 */ } account = '' }
  ensureAccount()
  const all = computed(() => Object.values(notices.value).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id)))
  const pending = computed(() => all.value.filter(notice => notice.status === 'pending'))
  return { notices, all, pending, observe, handle, handleAll, reopen, remove, ensureAccount, reset }
})
