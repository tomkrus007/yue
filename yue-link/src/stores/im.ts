import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { imClient, type ImMessage, type ImSession } from '../services/im/im-client'
import { FromType, FROM_TYPE_LABEL } from '../services/im/types'
import {
  contactService,
  type ContactEntry,
} from '../services/contact-client'

export const useImStore = defineStore('im', () => {
  const connected = ref(false)
  const authed = ref(false)
  const logs = ref<string[]>([])
  const messages = ref<ImMessage[]>([])
  const sessions = ref<ImSession[]>([])
  const currentSessionId = ref<string>('')
  const sending = ref(false)

  /** 联系人（好友+群组） */
  const contacts = ref<ContactEntry[]>([])
  const contactsLoading = ref(false)
  const contactKeyword = ref('')
  const friends = ref<any[]>([])
  const groups = ref<any[]>([])

  /** 聊天页搜索（含未聊过的人） */
  const searchKeyword = ref('')
  const searchResults = ref<ContactEntry[]>([])
  const searching = ref(false)

  const currentSession = computed(() =>
    sessions.value.find((s) => s.talk_with_id === currentSessionId.value),
  )
  const currentMessages = computed(() =>
    messages.value
      .filter(
        (m) =>
          m.to_id === currentSessionId.value ||
          m.from_id === currentSessionId.value,
      )
      .sort((a, b) => a.send_time - b.send_time),
  )

  /** 过滤后的联系人列表 */
  const filteredContacts = computed(() => {
    const kw = contactKeyword.value.trim().toLowerCase()
    if (!kw) return contacts.value
    return contacts.value.filter(
      (c) =>
        c.name.toLowerCase().includes(kw) ||
        (c.desc || '').toLowerCase().includes(kw),
    )
  })

  let unsub: (() => void) | null = null

  function start() {
    if (unsub) return
    unsub = imClient.on((e) => {
      switch (e.type) {
        case 'open':
          connected.value = true
          log('WebSocket 已连接')
          break
        case 'close':
          connected.value = false
          authed.value = false
          log(`连接关闭 ${e.data?.code ?? ''}`)
          break
        case 'authed':
          authed.value = true
          log('鉴权成功')
          break
        case 'message':
          addMessage(e.data as ImMessage)
          break
        case 'receipt':
          // 更新消息发送状态
          {
            const r = e.data
            const m = messages.value.find((x) => x.msg_id === r?.msg_id)
            if (m) (m as any).__sent = true
          }
          break
        case 'offline_end':
          log(e.data?.more ? '在线消息仍有更多' : '离线消息拉取结束')
          break
        case 'log':
          log(e.data)
          break
        case 'error':
          log('错误: ' + JSON.stringify(e.data))
          break
      }
    })
    imClient.init()
  }

  function stop() {
    imClient.close()
    if (unsub) {
      unsub()
      unsub = null
    }
    connected.value = false
    authed.value = false
  }

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString()
    logs.value.unshift(`[${ts}] ${msg}`)
    if (logs.value.length > 100) logs.value.length = 100
  }

  function addMessage(msg: ImMessage) {
    // 去重：断线重连/离线重推时同一 msg_id 可能重复到达
    if (msg.msg_id && messages.value.some((m) => m.msg_id === msg.msg_id)) {
      return
    }
    messages.value.push(msg)
    // 更新会话
    const talkWithId =
      msg.from_id === localStorage.getItem('CurrentUserId')
        ? msg.to_id
        : msg.from_id
    const talkWithName =
      msg.from_id === localStorage.getItem('CurrentUserId')
        ? msg.to_name
        : msg.from_name
    const talkWithType = msg.to_type || FromType.USER
    if (!talkWithId) return
    let s = sessions.value.find((x) => x.talk_with_id === talkWithId)
    if (!s) {
      s = {
        talk_with_id: talkWithId,
        talk_with_name: talkWithName,
        talk_with_type: talkWithType,
        unread: 0,
        last_msg: msg,
        last_send_time: msg.send_time,
      }
      sessions.value.push(s)
    } else {
      s.last_msg = msg
      s.last_send_time = msg.send_time
    }
    if (currentSessionId.value !== talkWithId) s.unread++
  }

  function selectSession(id: string) {
    currentSessionId.value = id
    const s = sessions.value.find((x) => x.talk_with_id === id)
    if (s) s.unread = 0
  }

  function sendText(text: string) {
    const s = currentSession.value
    if (!s || !text.trim()) return
    sending.value = true
    try {
      const msg = imClient.sendText(s.talk_with_id, s.talk_with_name, s.talk_with_type, text)
      messages.value.push(msg)
    } finally {
      sending.value = false
    }
  }

  /** 发起一个临时会话（用于"发起聊天"） */
  function openChat(id: string, name: string, type: number = FromType.USER) {
    let s = sessions.value.find((x) => x.talk_with_id === id)
    if (!s) {
      s = {
        talk_with_id: id,
        talk_with_name: name,
        talk_with_type: type,
        unread: 0,
      }
      sessions.value.push(s)
    }
    selectSession(id)
  }

  function sessionTypeLabel(type: number): string {
    return FROM_TYPE_LABEL[type] || '未知'
  }

  /** 加载联系人（好友+群组） */
  async function loadContacts() {
    contactsLoading.value = true
    try {
      contacts.value = await contactService.loadContactEntries()
      // 缓存原始数据供搜索复用
      try {
        friends.value = await contactService.getFriends()
      } catch { friends.value = [] }
      try {
        groups.value = await contactService.getMyGroups()
      } catch { groups.value = [] }
      log(`联系人加载完成：${contacts.value.length} 条`)
    } catch (e: any) {
      log('联系人加载失败：' + e.message)
    } finally {
      contactsLoading.value = false
    }
  }

  let searchSeq = 0
  /** 统一搜索：本地好友/群组 + 全员目录；含未聊过的人 */
  async function searchAll(keyword: string) {
    searchKeyword.value = keyword
    const kw = keyword.trim()
    const seq = ++searchSeq
    if (!kw) {
      searchResults.value = []
      searching.value = false
      return
    }
    searching.value = true
    try {
      const r = await contactService.searchEntries(kw, friends.value, groups.value)
      // 防止旧请求覆盖新请求
      if (seq === searchSeq) searchResults.value = r
    } catch (e: any) {
      if (seq === searchSeq) searchResults.value = []
      log('搜索失败：' + e.message)
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }

  return {
    connected,
    authed,
    logs,
    messages,
    sessions,
    currentSessionId,
    currentSession,
    currentMessages,
    sending,
    contacts,
    contactsLoading,
    contactKeyword,
    filteredContacts,
    friends,
    groups,
    searchKeyword,
    searchResults,
    searching,
    start,
    stop,
    log,
    selectSession,
    sendText,
    openChat,
    sessionTypeLabel,
    loadContacts,
    searchAll,
  }
})
