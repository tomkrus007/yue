import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ensureNotificationPermission, notifyMessage } from '../services/notifications'
import {
  imClient,
  type ImMessage,
} from '../services/im/im-client'
import { MsgType, FromType, FROM_TYPE_LABEL } from '../services/im/types'
import {
  contactService,
  type ContactEntry,
} from '../services/contact-client'
import { authService } from '../services/auth'
import { STORAGE_KEYS } from '../services/config'
import {
  fetchHistory,
  fetchSessions,
} from '../services/im/session-api'
import { messageText } from '../services/im/content'
import { logEvent } from '../services/app-log'
import { applyInteraction, emptyInteractions, mentionsUser, type MessageInteractions } from '../services/im/interactions'
import { uploadForwardDetails, type MediaContent } from '../services/im/media'
import { MessageDelivery } from '../services/im/delivery'
import { HistoryPager } from '../services/im/history'
import { forwardEnvelope, hydrateForwardContent } from '../services/im/forwarding'
import {
  clearAccount as clearStoredAccount,
  deleteState,
  getState,
  loadMessagesAround,
  loadRecentMessages,
  loadSessionMessages,
  putState,
  saveMessages,
  searchMessages as searchStoredMessages,
} from '../services/im/store'
import type { PersistedMessage } from '../services/im/store'
import { useMentionsStore } from './mentions'
import { useReceiptAudienceStore } from './receipts'
import { groupService, type GroupDetail } from '../services/group-client'
import {
  addPin,
  isServiceAccount,
  isTeamGroup,
  loadDirectory,
  loadFoldStates,
  loadMuteStates,
  loadPinned,
  removePin,
  setFold,
  sessionOfMsg,
  supportsMute,
  toggleMute,
  unmute,
  type DirectoryEntry,
} from '../services/im/prefs'

/** 会话（本地聚合 + REST 会话列表） */
export interface ChatSession {
  id: string
  type: number
  name: string
  preview: string
  lastTime: number
  hasLocal: boolean
}

export interface ChatMessage extends ImMessage {
  sessionId: string
  sessionType: number
}

export type SessionTab = 'all' | 'folded'

const TO_MULTI_TYPES = new Set([2, 4, 8])
/** 启动时跨会话读取的最近消息数：覆盖最近聊天与未读会话，其余按会话懒加载 */
const STARTUP_MESSAGE_LIMIT = 1000
/** 打开会话时从本地缓存加载的最近消息数（与 ChatView 的 300 条窗口一致） */
const SESSION_MESSAGE_WINDOW = 300
const MESSAGE_WRITE_DELAY = 500
const MESSAGE_WRITE_BATCH = 500
const STATE_WRITE_DELAY = 500
const MAX_UNREAD_IDS = 5000

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存不下就算了 */
  }
}

export const useImStore = defineStore('im', () => {
  const connected = ref(false)
  const authed = ref(false)
  const needLogin = ref('')
  const logs = ref<string[]>([])
  const mentions = useMentionsStore()
  const receiptAudiences = useReceiptAudienceStore()

  const messages = ref<ChatMessage[]>([])
  /** msg_id → 消息：避免每条消息都对最多 5000 条的数组做线性查找 */
  const messageIndex = new Map<string, ChatMessage>()
  function findMessage(msgId: string): ChatMessage | undefined {
    return messageIndex.get(msgId)
  }
  const delivery = new MessageDelivery({
    connected: () => imClient.authed,
    resend: message => imClient.retryMessage(message),
    changed: message => {
      if ((message as ChatMessage).sessionId) {
        persistMessages(message as ChatMessage)
        // 未确认的消息单独存一份，避免滚出启动窗口后丢失重发入口。
        markOutbox(message)
      }
      if (pendingReadCommands.value[message.msg_id]) markReadCommand(message.msg_id)
      persistInteractions()
    },
    confirmed: message => {
      if (Number(message.msg_type) === MsgType.READED) {
        for (const id of String(message.content?.readMsgIds || '').split(',').filter(Boolean)) {
          localReadConfirmations.value[id] = true
          markConfirmation(id)
        }
        if (pendingReadCommands.value[message.msg_id]) {
          delete pendingReadCommands.value[message.msg_id]
          markReadCommandDeleted(message.msg_id)
        }
        persistInteractions()
      } else if (message.reply_msg_id) mentions.handle(message.reply_msg_id, 'reply')
    },
  })
  function trackOutgoing(message: ImMessage) {
    const local = findMessage(message.msg_id)
    if (local) {
      delivery.track(local)
      const session = sessions.value.find(item => item.id === local.sessionId)
      if (session && (String(local.is_need_read_receipt) === 'true' || String(local.is_delete_after_read) === 'true' || Number(local.is_need_send_read) === 1)) void receiptAudiences.capture(local, session, { atSend: true })
    }
  }
  function confirmOutgoing(message: ImMessage) {
    delivery.acknowledge(message.msg_id, true)
    message.__sent = true
    delete message.__error
    message.__delivery = { state: 'confirmed', attempts: message.__delivery?.attempts || 1, updatedAt: Date.now() }
    if (message.reply_msg_id) mentions.handle(message.reply_msg_id, 'reply')
  }
  const interactions = ref<MessageInteractions>(emptyInteractions())
  const pendingInteractions = ref<Record<string, ImMessage>>({})
  const interactionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const interactionErrors = ref<Record<string, string>>({})
  const localReadConfirmations = ref<Record<string, boolean>>({})
  const pendingReadCommands = ref<Record<string, ImMessage>>({})
  const burnDeadlines = ref<Record<string, number>>({})
  function applyRecall(message: ImMessage): boolean {
    const recall = interactions.value.recalls[message.msg_id]
    if (!recall) return false
    message.msg_type = recall.type
    message.content = ''
    message.reply_msg_id = ''
    message.is_delete_after_read = false
    message.is_need_read_receipt = false
    delete interactions.value.reactions[message.msg_id]
    return true
  }
  /** 一条交互消息会影响到的原消息 id：用于按消息粒度写 SQLite。 */
  function interactionMessageIds(message: ImMessage): string[] {
    const type = Number(message.msg_type)
    if (type === MsgType.CTRL) {
      const params = message.content?.params
      const ids: string[] = []
      if (params?.msgId) ids.push(String(params.msgId))
      if (params?.msgIds) ids.push(...String(params.msgIds).split(',').filter(Boolean))
      return ids
    }
    if (type === MsgType.RECALL) return typeof message.content === 'string' ? [message.content] : []
    if (type === MsgType.ADMINRECALL) return message.content?.msgId ? [String(message.content.msgId)] : []
    if (type === MsgType.READED && message.content?.readMsgIds) {
      return String(message.content.readMsgIds).split(',').filter(Boolean)
    }
    return []
  }
  function consumeInteraction(message: ImMessage): boolean {
    if (Number(message.msg_type) === MsgType.READED && isMine(message) && pendingReadCommands.value[message.msg_id]) delivery.acknowledge(message.msg_id, true)
    if (Number(message.msg_type) === MsgType.READED && message.content?.lastSendTime && !message.content?.readMsgIds) {
      // 自己的会话已读游标（多端同步）与「别人是否读了这条消息」无关，不能把本端标成读者。
      if (isMine(message)) return true
      const multi = [2, 4, 8].includes(Number(message.content.toType))
      const sessionId = multi ? message.content.toId : message.from_id
      const ids = messages.value.filter(item => item.sessionId === sessionId && isMine(item) && Number(item.send_time) <= Number(message.content.lastSendTime)).map(item => item.msg_id)
      if (ids.length) message = { ...message, content: { ...message.content, readMsgIds: ids.join(',') } }
    }
    if (!applyInteraction(interactions.value, message, authService.getCurrentUserId())) return false
    for (const id of interactionMessageIds(message)) markInteraction(id)
    if (isMine(message)) delete interactionErrors.value[interactionTarget(message)]
    delete pendingInteractions.value[message.msg_id]
    clearTimeout(interactionTimers.get(message.msg_id))
    interactionTimers.delete(message.msg_id)
    const recalled: ChatMessage[] = []
    for (const item of messages.value) if (applyRecall(item)) recalled.push(item)
    for (const id of Object.keys(interactions.value.recalls)) mentions.remove(id)
    if (isMine(message) && Number(message.msg_type) === MsgType.CTRL && Number(message.content?.cmd) === 1000 && message.content?.params?.emoji === '[ok]') mentions.handle(message.content.params.msgId, 'received')
    for (const session of sessions.value) {
      const latest = messages.value.filter(item => item.sessionId === session.id).sort((a, b) => b.send_time - a.send_time)[0]
      if (latest && latest.send_time >= session.lastTime && interactions.value.recalls[latest.msg_id]) session.preview = previewOfMessage(latest)
    }
    persistInteractions()
    persistMessages(...recalled)
    persistSessions()
    return true
  }
  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref('')
  const hiddenSessions = ref<Record<string, number>>({})
  /**
   * 从搜索结果打开的会话 id → 打开时间。列表按 max(lastTime, boost) 排序，
   * 让刚选中的联系人置顶；之后有新消息自然接管，无需额外清理。
   */
  const sessionBoosts = ref<Record<string, number>>({})
  // 只有消息页所在窗口位于前台，才把当前会话视为正在阅读。
  const chatActive = ref(false)
  const sending = ref(false)
  const loadingHistory = ref(false)
  let historyLoads = 0
  const olderPagers = new Map<string, HistoryPager>()
  const forwardUploads = new Map<string, Promise<string>>()
  const forwardLoads = new Map<string, Promise<void>>()
  const historyProgress = ref<Record<string, { scanned: number; running: boolean; complete: boolean; cancelled: boolean; error: string }>>({})
  const lookupProgress = ref({ scanned: 0, running: false })
  const scans = new Map<string, { pager: HistoryPager; cancelled: boolean; promise?: Promise<void> }>()
  const scanPagers = new Map<string, HistoryPager>()
  const lookups = new Map<string, { pager: HistoryPager; cancelled: boolean }>()
  let historyGeneration = 0

  /** 未读：会话 id → 条数；@我：会话 id → 条数 */
  const unread = ref<Record<string, number>>({})
  const unreadAt = ref<Record<string, number>>({})
  const unreadIds = ref<Set<string>>(new Set())
  const muted = ref<Set<string>>(new Set())
  const folded = ref<Set<string>>(new Set())
  const trayUnread = computed(() => Object.entries(unread.value)
    .filter(([id]) => !(id in hiddenSessions.value) && !muted.value.has(id) && !folded.value.has(id))
    .reduce((sum, [, count]) => sum + count, 0))
  watch(trayUnread, (count) => {
    // Dock 角标与托盘共用同一套未读口径（排除免打扰、折叠和已移除会话）。
    void getCurrentWindow()
      .setBadgeCount(count > 0 ? count : undefined)
      .catch((e) => log('[提醒诊断] Dock 未读角标更新失败：' + String(e)))
    invoke('set_tray_unread', { count })
      .then(() => log(`[提醒诊断] 托盘未读已更新：${count}`))
      .catch((e) => log('[提醒诊断] 托盘未读更新失败：' + String(e)))
  }, { immediate: true })
  let lastSoundAt = 0

  const pinned = ref<Record<string, number>>({})
  const directory = ref<Map<string, DirectoryEntry>>(new Map())
  const groupMeta = ref<Map<string, boolean>>(new Map())

  /** 群详情缓存（群管理用）；memberRole=-1 非成员、groupJieSan 已解散都依赖它 */
  const groupDetails = ref<Map<string, GroupDetail>>(new Map())
  /** 本端已退群/已解散的群（防止服务端同步把旧会话加回来） */
  const leftGroups = ref<Set<string>>(
    new Set(readJson<string[]>(STORAGE_KEYS.imLeftGroups, [])),
  )
  /** 全员禁言群里「自己被禁言」的会话 id（禁言状态在成员列表里，按会话缓存） */
  const groupSelfMuted = ref<Set<string>>(new Set())

  /** 每个会话各自的上传状态：key = type|id */
  const uploads = ref<Record<string, { count: number; text: string }>>({})

  /** 分栏默认「全部」且不持久化：重启后若停在某个筛选栏，会出现「右侧在聊、左侧找不到人」 */
  const sessionTab = ref<SessionTab>('all')
  // 清掉旧版本持久化的分栏值（旧值还会跨账号残留）
  localStorage.removeItem(STORAGE_KEYS.imTab)

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

  let unsub: (() => void) | null = null
  let prefsLoaded = false
  let prefsLoading = false

  /* ---------------- 本地缓存 ---------------- */

  const accountId = () => authService.getCurrentUserId()

  /**
   * 旧版 IM 数据全部整块存在 localStorage。这里不做迁移：
   * 消息按需从服务端重拉；未读/交互/回执首启会重建一次，之后都走 SQLite。
   */
  function cleanupLegacyStorage(): void {
    for (const key of [
      STORAGE_KEYS.imMessages,
      STORAGE_KEYS.imUnread,
      STORAGE_KEYS.imUnreadAt,
      STORAGE_KEYS.imUnreadIds,
    ]) {
      localStorage.removeItem(key)
    }
    // 旧版交互/回执/提醒按账号分 key，同一台机器可能登录过多个账号，
    // 这里按前缀全部清掉，避免只清当前账号留下其它账号的大块旧数据。
    const legacyPrefixes = ['yl.im.interactions.', 'yl.im.receipt-audiences.', 'yl.im.mentions.']
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && legacyPrefixes.some(prefix => key.startsWith(prefix))) {
        localStorage.removeItem(key)
      }
    }
  }

  function loadLocal(): void {
    cleanupLegacyStorage()
    // 消息、未读、交互由 hydratePersisted() 异步恢复；这里只同步加载可回填的偏好。
    interactions.value = emptyInteractions()
    localReadConfirmations.value = {}
    pendingReadCommands.value = {}
    burnDeadlines.value = {}
    hiddenSessions.value = readJson<Record<string, number>>(STORAGE_KEYS.imHiddenSessions, {})
    sessions.value = readJson<ChatSession[]>(STORAGE_KEYS.imSessions, []).map(
      (s) => ({
        id: String(s.id),
        type: Number(s.type) || 1,
        name: s.name || String(s.id),
        preview: s.preview || '',
        lastTime: Number(s.lastTime) || 0,
        hasLocal: Boolean(s.hasLocal),
      }),
    )
    // 只保留仍存在的会话的置顶记录，避免本地缓存无限增长
    const savedBoosts = readJson<Record<string, number>>(STORAGE_KEYS.imSessionBoosts, {})
    sessionBoosts.value = Object.fromEntries(
      Object.entries(savedBoosts).filter(([id]) => sessions.value.some((s) => s.id === id)),
    )
    muted.value = new Set(readJson<string[]>(STORAGE_KEYS.imMuted, []))
    folded.value = new Set(readJson<string[]>(STORAGE_KEYS.imFolded, []))
    pinned.value = readJson<Record<string, number>>(STORAGE_KEYS.imPinned, {})
    try {
      for (const [id, team] of readJson<Array<[string, boolean]>>(
        STORAGE_KEYS.imGroupMeta,
        [],
      )) {
        groupMeta.value.set(id, team)
      }
    } catch {
      /* 忽略 */
    }
  }

  function persistSessions(): void {
    writeJson(STORAGE_KEYS.imSessions, sessions.value)
  }

  /* ---------------- SQLite 持久化队列 ---------------- */

  const loadedWindows = new Set<string>()
  let hydration: Promise<void> | null = null
  let hydrationEpoch = 0

  /*
   * 消息：只写变化的单条消息。离线消息成批到达时，500ms 内的多次标脏合并成
   * 一个事务；单条消息且距上次写入超过 500ms 时立即写，保证实时性。
   */
  const pendingMessageWrites = new Map<string, ChatMessage>()
  let messageWriteTimer: ReturnType<typeof setTimeout> | null = null
  let lastMessageWriteAt = 0
  let messageWriteInFlight = false
  let messageWriteFailures = 0

  function scheduleMessageWrite(delay: number): void {
    if (messageWriteTimer) return
    messageWriteTimer = setTimeout(() => {
      messageWriteTimer = null
      void flushMessageWrites()
    }, delay)
  }

  function persistMessages(...items: ChatMessage[]): void {
    for (const item of items) {
      if (item?.msg_id && item.sessionId) pendingMessageWrites.set(item.msg_id, item)
    }
    if (!pendingMessageWrites.size) return
    const idle = Date.now() - lastMessageWriteAt
    scheduleMessageWrite(idle >= MESSAGE_WRITE_DELAY ? 0 : MESSAGE_WRITE_DELAY - idle)
  }

  async function flushMessageWrites(): Promise<void> {
    if (messageWriteInFlight) return
    const account = accountId()
    if (!account) {
      pendingMessageWrites.clear()
      return
    }
    messageWriteInFlight = true
    try {
      while (pendingMessageWrites.size) {
        if (account !== accountId()) {
          pendingMessageWrites.clear()
          return
        }
        const batch = [...pendingMessageWrites.values()].slice(0, MESSAGE_WRITE_BATCH)
        for (const message of batch) pendingMessageWrites.delete(message.msg_id)
        const ok = await saveMessages(account, batch)
        if (!ok) {
          for (const message of batch) {
            if (!pendingMessageWrites.has(message.msg_id)) pendingMessageWrites.set(message.msg_id, message)
          }
          messageWriteFailures += 1
          if (messageWriteFailures < 5) {
            const delay = [2, 5, 10, 30][Math.min(messageWriteFailures - 1, 3)] * 1000
            scheduleMessageWrite(delay)
          }
          return
        }
        messageWriteFailures = 0
        lastMessageWriteAt = Date.now()
      }
    } finally {
      messageWriteInFlight = false
    }
  }

  /* 未读：按会话标脏，flush 时只写变化的会话与新增的已读消息 id。 */
  const pendingUnreadSessions = new Set<string>()
  const pendingUnreadAtSessions = new Set<string>()
  const pendingUnreadIds = new Set<string>()
  const touchedUnread = new Set<string>()
  const touchedUnreadAt = new Set<string>()
  let unreadWriteTimer: ReturnType<typeof setTimeout> | null = null

  function markUnread(id: string, at = false): void {
    pendingUnreadSessions.add(id)
    touchedUnread.add(id)
    if (at) {
      pendingUnreadAtSessions.add(id)
      touchedUnreadAt.add(id)
    }
  }

  function persistUnread(): void {
    if (unreadWriteTimer) return
    unreadWriteTimer = setTimeout(() => {
      unreadWriteTimer = null
      void flushUnread()
    }, STATE_WRITE_DELAY)
  }

  async function flushUnread(): Promise<void> {
    const account = accountId()
    if (!account) return
    const sessionsToWrite = [...pendingUnreadSessions]
    pendingUnreadSessions.clear()
    if (sessionsToWrite.length) {
      const entries = sessionsToWrite
        .filter(id => (unread.value[id] || 0) > 0)
        .map(id => ({ key: id, value: String(unread.value[id]) }))
      const removed = sessionsToWrite.filter(id => !((unread.value[id] || 0) > 0))
      if (entries.length) await putState(account, 'unread', entries)
      if (removed.length) await deleteState(account, 'unread', removed)
    }
    const atToWrite = [...pendingUnreadAtSessions]
    pendingUnreadAtSessions.clear()
    if (atToWrite.length) {
      const entries = atToWrite
        .filter(id => (unreadAt.value[id] || 0) > 0)
        .map(id => ({ key: id, value: String(unreadAt.value[id]) }))
      const removed = atToWrite.filter(id => !((unreadAt.value[id] || 0) > 0))
      if (entries.length) await putState(account, 'unread_at', entries)
      if (removed.length) await deleteState(account, 'unread_at', removed)
    }
    const ids = [...pendingUnreadIds]
    pendingUnreadIds.clear()
    if (ids.length) {
      const now = String(Date.now())
      await putState(account, 'unread_id', ids.map(id => ({ key: id, value: now })))
      trimUnreadIds(account)
    }
  }

  /* 交互：一条消息一行，只写被标脏的消息；阅读确认/待发命令/焚毁单独成 scope。 */
  const pendingInteractionIds = new Set<string>()
  const pendingConfirmationIds = new Set<string>()
  const pendingReadCommandIds = new Set<string>()
  const deletedReadCommandIds = new Set<string>()
  const pendingBurnIds = new Set<string>()
  const deletedBurnIds = new Set<string>()
  const pendingOutboxIds = new Set<string>()
  const deletedOutboxIds = new Set<string>()
  let interactionWriteTimer: ReturnType<typeof setTimeout> | null = null

  function markInteraction(id: string): void {
    if (id) pendingInteractionIds.add(id)
  }

  function markConfirmation(id: string): void {
    if (id) pendingConfirmationIds.add(id)
  }

  function markReadCommand(id: string): void {
    if (id) {
      pendingReadCommandIds.add(id)
      deletedReadCommandIds.delete(id)
    }
  }

  function markReadCommandDeleted(id: string): void {
    if (id) {
      pendingReadCommandIds.delete(id)
      deletedReadCommandIds.add(id)
    }
  }

  function markBurn(id: string): void {
    if (id) {
      pendingBurnIds.add(id)
      deletedBurnIds.delete(id)
    }
  }

  function markBurnDeleted(id: string): void {
    if (id) {
      pendingBurnIds.delete(id)
      deletedBurnIds.add(id)
    }
  }

  /** 待确认/失败的消息进 outbox；确认后只删这一条。 */
  function markOutbox(message: ImMessage): void {
    const id = message.msg_id
    if (!id) return
    if (message.__delivery?.state === 'confirmed') {
      pendingOutboxIds.delete(id)
      deletedOutboxIds.add(id)
    } else {
      deletedOutboxIds.delete(id)
      pendingOutboxIds.add(id)
    }
    persistInteractions()
  }

  function persistInteractions(): void {
    if (interactionWriteTimer) return
    interactionWriteTimer = setTimeout(() => {
      interactionWriteTimer = null
      void flushInteractions()
    }, STATE_WRITE_DELAY)
  }

  function interactionValue(id: string): string {
    const value: Record<string, unknown> = {}
    if (interactions.value.reactions[id]) value.reactions = interactions.value.reactions[id]
    if (interactions.value.recalls[id]) value.recall = interactions.value.recalls[id]
    if (interactions.value.readers[id]) value.readers = interactions.value.readers[id]
    if (interactions.value.readTimes[id]) value.readTimes = interactions.value.readTimes[id]
    return JSON.stringify(value)
  }

  async function flushInteractions(): Promise<void> {
    const account = accountId()
    if (!account) return
    const interactionIds = [...pendingInteractionIds]
    pendingInteractionIds.clear()
    if (interactionIds.length) {
      await putState(account, 'interaction', interactionIds.map(id => ({ key: id, value: interactionValue(id) })))
    }
    const confirmations = [...pendingConfirmationIds]
    pendingConfirmationIds.clear()
    if (confirmations.length) {
      await putState(account, 'read_confirmation', confirmations.map(id => ({ key: id, value: '1' })))
    }
    const commands = [...pendingReadCommandIds].filter(id => pendingReadCommands.value[id])
    pendingReadCommandIds.clear()
    if (commands.length) {
      await putState(account, 'read_command', commands.map(id => ({
        key: id,
        value: JSON.stringify(pendingReadCommands.value[id]),
      })))
    }
    const removedCommands = [...deletedReadCommandIds]
    deletedReadCommandIds.clear()
    if (removedCommands.length) await deleteState(account, 'read_command', removedCommands)
    const burns = [...pendingBurnIds].filter(id => burnDeadlines.value[id])
    pendingBurnIds.clear()
    if (burns.length) {
      await putState(account, 'burn_deadline', burns.map(id => ({ key: id, value: String(burnDeadlines.value[id]) })))
    }
    const removedBurns = [...deletedBurnIds]
    deletedBurnIds.clear()
    if (removedBurns.length) await deleteState(account, 'burn_deadline', removedBurns)
    const outbox = [...pendingOutboxIds].filter(id => findMessage(id))
    pendingOutboxIds.clear()
    if (outbox.length) {
      await putState(account, 'outbox', outbox.map(id => ({
        key: id,
        value: JSON.stringify(findMessage(id)),
      })))
    }
    const removedOutbox = [...deletedOutboxIds]
    deletedOutboxIds.clear()
    if (removedOutbox.length) await deleteState(account, 'outbox', removedOutbox)
  }

  /** 立即落盘（页面隐藏/关闭、退出登录时调用），避免节流窗口内丢数据 */
  function flushPersist(): void {
    if (messageWriteTimer) {
      clearTimeout(messageWriteTimer)
      messageWriteTimer = null
    }
    void flushMessageWrites()
    if (unreadWriteTimer) {
      clearTimeout(unreadWriteTimer)
      unreadWriteTimer = null
    }
    void flushUnread()
    if (interactionWriteTimer) {
      clearTimeout(interactionWriteTimer)
      interactionWriteTimer = null
    }
    void flushInteractions()
    void mentions.flush()
    void receiptAudiences.flush()
  }

  /** 把数据库里的消息并入内存；已存在的消息以内存为准。 */
  function mergeLoadedMessages(list: PersistedMessage[]): number {
    let added = 0
    for (const message of list) {
      if (!message?.msg_id || messageIndex.has(message.msg_id) || !message.sessionId) continue
      messages.value.push(message)
      messageIndex.set(message.msg_id, message)
      added += 1
    }
    return added
  }

  /** 按消息 id 批量恢复交互状态；内存里已有（启动期间新收到）的不覆盖。 */
  async function loadInteractionState(ids: string[]): Promise<void> {
    if (!ids.length) return
    const account = accountId()
    if (!account) return
    const [rows, confirmations] = await Promise.all([
      getState(account, 'interaction', ids),
      getState(account, 'read_confirmation', ids),
    ])
    if (account !== accountId()) return
    for (const row of rows) {
      try {
        const value = JSON.parse(row.value) as {
          reactions?: MessageInteractions['reactions'][string]
          recall?: MessageInteractions['recalls'][string]
          readers?: MessageInteractions['readers'][string]
          readTimes?: MessageInteractions['readTimes'][string]
        }
        if (value.reactions && !interactions.value.reactions[row.key]) interactions.value.reactions[row.key] = value.reactions
        if (value.recall && !interactions.value.recalls[row.key]) interactions.value.recalls[row.key] = value.recall
        if (value.readers && !interactions.value.readers[row.key]) interactions.value.readers[row.key] = value.readers
        if (value.readTimes && !interactions.value.readTimes[row.key]) interactions.value.readTimes[row.key] = value.readTimes
      } catch {
        /* 单条损坏不影响其它状态 */
      }
    }
    for (const row of confirmations) localReadConfirmations.value[row.key] = true
    // 阅后即焚的截止时间单独存，窗口外消息补载时也要按「已打开」隐藏正文。
    for (const id of ids) {
      if (!burnDeadlines.value[id] || interactions.value.recalls[id]) continue
      interactions.value.recalls[id] = { type: MsgType.RECALL, time: Date.now(), hidden: true }
    }
  }

  /** 服务端历史页在合并前先补本地交互状态，避免已撤回/已读状态因窗口外而丢失。 */
  async function preloadPageInteractions(list: ImMessage[]): Promise<void> {
    const ids = list.map(message => message.msg_id).filter(Boolean)
    if (ids.length) await loadInteractionState(ids)
  }

  function trimUnreadIds(account: string): void {
    const ids = [...unreadIds.value]
    if (ids.length <= MAX_UNREAD_IDS) return
    const removed = ids.slice(0, ids.length - MAX_UNREAD_IDS)
    unreadIds.value = new Set(ids.slice(ids.length - MAX_UNREAD_IDS))
    void deleteState(account, 'unread_id', removed)
  }

  /** 启动恢复：待发阅读确认/焚毁状态全量，消息与交互只取最近窗口。 */
  async function hydratePersisted(account: string, epoch: number): Promise<void> {
    // 提醒与消息各自持久化，先拉起提醒，消息合并时 observe 就不会覆盖旧状态。
    await mentions.hydrate()
    if (epoch !== hydrationEpoch || account !== accountId()) return
    const [unreadRows, unreadAtRows, unreadIdRows, commandRows, burnRows, outboxRows] = await Promise.all([
      getState(account, 'unread'),
      getState(account, 'unread_at'),
      getState(account, 'unread_id'),
      getState(account, 'read_command'),
      getState(account, 'burn_deadline'),
      getState(account, 'outbox'),
    ])
    if (epoch !== hydrationEpoch || account !== accountId()) return
    for (const row of unreadRows) {
      if (touchedUnread.has(row.key)) continue
      const count = Number(row.value)
      if (count > 0) unread.value[row.key] = count
    }
    for (const row of unreadAtRows) {
      if (touchedUnreadAt.has(row.key)) continue
      const count = Number(row.value)
      if (count > 0) unreadAt.value[row.key] = count
    }
    for (const row of unreadIdRows) unreadIds.value.add(row.key)
    for (const row of commandRows) {
      try {
        const command = JSON.parse(row.value) as ImMessage
        if (command?.msg_id) pendingReadCommands.value[command.msg_id] = command
      } catch {
        /* 损坏的待发命令直接跳过 */
      }
    }
    for (const row of burnRows) {
      const deadline = Number(row.value)
      if (deadline > 0) {
        burnDeadlines.value[row.key] = deadline
        interactions.value.recalls[row.key] = { type: MsgType.RECALL, time: Date.now(), hidden: true }
      }
    }
    // 已发送过的阅读确认不再补发：旧版同样在启动时折算成“已确认”。
    for (const [id, command] of Object.entries(pendingReadCommands.value)) {
      if (!command.__sent) continue
      for (const target of String(command.content?.readMsgIds || '').split(',').filter(Boolean)) {
        localReadConfirmations.value[target] = true
        markConfirmation(target)
      }
      delete pendingReadCommands.value[id]
      markReadCommandDeleted(id)
    }
    persistInteractions()

    const recent = await loadRecentMessages(account, STARTUP_MESSAGE_LIMIT)
    if (epoch !== hydrationEpoch || account !== accountId()) return
    mergeLoadedMessages(recent)
    const outbox: PersistedMessage[] = []
    for (const row of outboxRows) {
      try {
        const message = JSON.parse(row.value) as PersistedMessage
        if (message?.msg_id && message.sessionId) outbox.push(message)
      } catch {
        /* 单条损坏不影响其它待确认消息 */
      }
    }
    mergeLoadedMessages(outbox)
    await loadInteractionState([...recent, ...outbox].map(message => message.msg_id))
    if (epoch !== hydrationEpoch || account !== accountId()) return
    for (const message of messages.value) applyRecall(message)
    trimUnreadIds(account)
    delivery.restore([...messages.value.filter(isMine), ...Object.values(pendingReadCommands.value)])
    // 服务号不计未读（与会话同步后的口径一致）。
    for (const session of sessions.value) {
      if (!isServiceAccount(session) || !(session.id in unread.value)) continue
      delete unread.value[session.id]
      markUnread(session.id)
    }
    if (recent.length || unreadRows.length) log(`本地缓存已恢复：${recent.length} 条消息`)
  }

  function startHydration(): Promise<void> {
    if (hydration) return hydration
    const account = accountId()
    if (!account) return Promise.resolve()
    cleanupLegacyStorage()
    const epoch = ++hydrationEpoch
    hydration = hydratePersisted(account, epoch).catch((error) => {
      log('本地缓存恢复失败：' + (error instanceof Error ? error.message : String(error)))
    })
    return hydration
  }

  function persistMuted(): void {
    writeJson(STORAGE_KEYS.imMuted, [...muted.value])
  }

  function persistFolded(): void {
    writeJson(STORAGE_KEYS.imFolded, [...folded.value])
  }

  function persistPinned(): void {
    writeJson(STORAGE_KEYS.imPinned, pinned.value)
  }

  function persistGroupMeta(): void {
    writeJson(STORAGE_KEYS.imGroupMeta, [...groupMeta.value])
  }

  function persistLeftGroups(): void {
    writeJson(STORAGE_KEYS.imLeftGroups, [...leftGroups.value])
  }

  loadLocal()
  // 页面隐藏/关闭前把节流中的消息与未读立即落盘
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushPersist)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPersist()
      })
    }
  }

  /* ---------------- 会话聚合 ---------------- */

  function upsertSession(input: {
    id: string
    type?: number
    name?: string
    preview?: string
    lastTime?: number
    hasLocal?: boolean
  }): ChatSession {
    // 已退群/解散的群不再回填会话（官方不删本地会话，复刻版显式清理）
    if (input.type === 2 && leftGroups.value.has(input.id)) {
      const found = sessions.value.find((s) => s.id === input.id)
      if (found) {
        sessions.value = sessions.value.filter((s) => s.id !== input.id)
        delete unread.value[input.id]
        delete unreadAt.value[input.id]
        markUnread(input.id, true)
        persistSessions()
        persistUnread()
        return found
      }
      // 会话不存在：返回一次性对象，避免调用方写入不存在的会话
      return {
        id: input.id,
        type: 2,
        name: input.name || input.id,
        preview: '',
        lastTime: 0,
        hasLocal: false,
      }
    }
    if (input.lastTime && input.lastTime > (hiddenSessions.value[input.id] ?? Infinity)) {
      delete hiddenSessions.value[input.id]
      writeJson(STORAGE_KEYS.imHiddenSessions, hiddenSessions.value)
    }
    let found = sessions.value.find((s) => s.id === input.id)
    if (found) {
      if (input.name) found.name = input.name
      if (input.type) found.type = input.type
      if (input.lastTime && input.lastTime >= found.lastTime) {
        found.preview = input.preview ?? found.preview
        found.lastTime = input.lastTime || found.lastTime
      }
      if (input.hasLocal) found.hasLocal = true
      return found
    }
    found = {
      id: input.id,
      type: input.type || 1,
      name: input.name || input.id,
      preview: input.preview || '',
      lastTime: input.lastTime || 0,
      hasLocal: Boolean(input.hasLocal),
    }
    sessions.value.push(found)
    return found
  }

  function fillNamesFromDirectory(): void {
    for (const s of sessions.value) {
      if (s.name && s.name !== s.id) continue
      const info = directory.value.get(s.id)
      if (info) {
        if (info.name) s.name = info.name
        if (info.type) s.type = info.type
      }
    }
  }

  /** 会话预览文本（内存里的消息 content 已解码） */
  function previewOfMessage(msg: ImMessage): string {
    if (interactions.value.recalls[msg.msg_id]) return interactions.value.recalls[msg.msg_id].hidden ? '[消息已移除]' : '[消息已撤回]'
    if (String(msg.is_delete_after_read) === 'true' || String(msg.is_need_read_receipt) === 'true') return '[受保护消息]'
    return messageText(Number(msg.msg_type), msg.content)
      .replace(/\s+/g, ' ')
      .slice(0, 60)
  }

  function isMine(m: ImMessage): boolean {
    return m.from_id === authService.getCurrentUserId()
  }

  /** 展示用读者名单：历史版本可能把本端误写成读者，统一在这里剔除。 */
  function readersOf(id: string): Record<string, string> {
    const all = interactions.value.readers[id]
    if (!all) return {}
    const me = authService.getCurrentUserId()
    const result: Record<string, string> = {}
    for (const [userId, name] of Object.entries(all)) if (userId !== me) result[userId] = name
    return result
  }

  function readTimesOf(id: string): Record<string, number> {
    const all = interactions.value.readTimes[id]
    if (!all) return {}
    const me = authService.getCurrentUserId()
    const result: Record<string, number> = {}
    for (const [userId, time] of Object.entries(all)) if (userId !== me) result[userId] = time
    return result
  }

  /** 单条消息进入本地：会话归属、未读、预览 */
  function addMessage(msg: ImMessage): void {
    if (!msg || !msg.msg_id) return
    if (consumeInteraction(msg)) return
    // 已读/回执类不落库
    if ([0, 95, 97].includes(Number(msg.msg_type))) return
    const existingMessage = findMessage(msg.msg_id)
    if (existingMessage) {
      if (isMine(msg)) confirmOutgoing(existingMessage)
      if (!msg.offline) log('[提醒诊断] 收到实时推送，但本地已有该消息，已跳过去重')
      return
    }

    const meId = authService.getCurrentUserId()
    const ref = sessionOfMsg(msg, meId)
    if (!ref.id) {
      log('[提醒诊断] 消息缺少会话归属，已跳过')
      return
    }

    const item: ChatMessage = {
      ...msg,
      sessionId: ref.id,
      sessionType: ref.type || 1,
    }
    applyRecall(item)
    messages.value.push(item)
    messageIndex.set(item.msg_id, item)
    mentions.observe(item, { id: ref.id, name: ref.name, type: ref.type })

    const fromThisDevice =
      !!msg.from_device && msg.from_device === authService.getDeviceId()
    const selfChat = ref.id === meId
    // 自聊（文件传输助手）里 from_id 永远是自己，只能按发送设备区分是不是本机发的。
    // 其他会话里，本账号在别的设备上发出的消息属于「自己发的」，不提醒也不计未读。
    const incoming = selfChat ? !fromThisDevice : !isMine(msg)
    const isRead = msg.is_read === undefined ? undefined : Number(msg.is_read)
    const unreadFlag = isRead === 0 || (isRead === undefined && !msg.offline)
    // 手机端发送自聊消息时服务端可能已把 is_read 置 1；另一台设备仍应提示。
    const notifyFlag = unreadFlag || (selfChat && !fromThisDevice && !msg.offline)

    // at_user_ids 是逗号分隔的 user id；@所有人 在服务端是字面量 "ALL"
    const atMe = mentionsUser(msg, meId)
    const sessionMuted = muted.value.has(ref.id)

    // 只记录提醒判断所需的状态，不记录消息内容、用户标识或凭据。
    log('[提醒诊断] 收到消息 ' + JSON.stringify({
      is_read: msg.is_read,
      is_read类型: typeof msg.is_read,
      offline: msg.offline,
      offline类型: typeof msg.offline,
      未读判定: unreadFlag,
      提醒判定: notifyFlag,
      本设备发送: fromThisDevice,
      自己发送: isMine(msg),
      自聊: selfChat,
      当前会话: currentSessionId.value === ref.id,
      免打扰: sessionMuted,
      折叠: folded.value.has(ref.id),
      服务号: isServiceAccount({ type: ref.type }),
      提及自己: atMe,
      已计未读: unreadIds.value.has(msg.msg_id),
    }))

    if (notifyFlag && incoming && !msg.offline &&
      !sessionMuted && !folded.value.has(ref.id) &&
      !isServiceAccount({ type: ref.type }) && Date.now() - lastSoundAt > 1000) {
      lastSoundAt = Date.now()
      invoke('play_message_sound')
        .then(() => log('[提醒诊断] 提示音命令已执行'))
        .catch((e) => log('[提醒诊断] 提示音调用失败：' + String(e)))
    }


    if (
      notifyFlag &&
      incoming &&
      (!chatActive.value || currentSessionId.value !== ref.id) &&
      !isServiceAccount({ type: ref.type }) &&
      !unreadIds.value.has(msg.msg_id) &&
      (!sessionMuted || atMe)
    ) {
      unreadIds.value.add(msg.msg_id)
      pendingUnreadIds.add(msg.msg_id)
      unread.value[ref.id] = (unread.value[ref.id] || 0) + 1
      if (atMe) unreadAt.value[ref.id] = (unreadAt.value[ref.id] || 0) + 1
      markUnread(ref.id, atMe)
      persistUnread()
    }

    // 系统通知：只在消息不能直接看到时提示（不在当前会话或窗口不在前台），
    // 免打扰、折叠和服务号沿用未读口径；@我 时即使免打扰也提醒。
    if (
      notifyFlag &&
      incoming &&
      !msg.offline &&
      (!chatActive.value || currentSessionId.value !== ref.id) &&
      (!sessionMuted || atMe) &&
      !folded.value.has(ref.id) &&
      !isServiceAccount({ type: ref.type })
    ) {
      const preview = previewOfMessage(item)
      const isGroup = TO_MULTI_TYPES.has(ref.type)
      const title = isGroup ? ref.name || '群消息' : msg.from_name || ref.name || '新消息'
      const body = isGroup ? `${msg.from_name || '未知'}：${preview}` : preview
      void notifyMessage(title, body)
    }

    const s = upsertSession({
      id: ref.id,
      type: ref.type,
      name: ref.name || ref.id,
      hasLocal: true,
      lastTime: msg.send_time || Date.now(),
    })
    const prefix =
      TO_MULTI_TYPES.has(ref.type) && msg.from_name && !isMine(msg)
        ? msg.from_name + '：'
        : ''
    const messageTime = msg.send_time || Date.now()
    if (messageTime >= s.lastTime) {
      s.preview = prefix + previewOfMessage(msg)
      s.lastTime = messageTime
    }
    s.hasLocal = true
    persistMessages(item)
    persistSessions()

    if (chatActive.value && currentSessionId.value === ref.id) {
      clearUnread(ref.id)
    }
  }

  /** 本地已读：切到会话就把该会话未读清掉 */
  function clearUnread(id: string): void {
    const session = sessions.value.find(item => item.id === id)
    if (session && imClient.authed) {
      imClient.markSessionRead(id, session.type)
      for (const message of messages.value.filter(item => item.sessionId === id)) {
        if (isMine(message) || Number(message.is_need_send_read) !== 1 || String(message.is_need_read_receipt) === 'true' || String(message.is_delete_after_read) === 'true' || localReadConfirmations.value[message.msg_id]) continue
        if (![1, 2, 7, 19, 28, 96].includes(Number(message.msg_type)) && !(Number(message.msg_type) === 99 && Number(message.content?.type) === 0)) continue
        try {
          queueReadConfirmation(message, session)
        } catch { break }
      }
      persistInteractions()
    }
    if (!(id in unread.value) && !(id in unreadAt.value)) return
    delete unread.value[id]
    delete unreadAt.value[id]
    markUnread(id, true)
    persistUnread()
  }

  /* ---------------- REST 同步 ---------------- */

  async function loadSessionsFromServer(): Promise<void> {
    try {
      const list = await fetchSessions()
      for (const raw of list) {
        upsertSession({
          id: raw.id,
          type: raw.type,
          name: raw.name,
          preview: raw.preview,
          lastTime: raw.lastTime,
        })
      }
      fillNamesFromDirectory()
      persistSessions()
      log(`会话列表已同步：${list.length} 个`)
    } catch (e: any) {
      log('会话列表同步失败：' + (e?.message || e))
    }
  }

  /** 折叠加置顶：服务端状态回填 + 按 id 补出没有消息的会话 */
  async function loadPreferenceStates(): Promise<void> {
    if (prefsLoaded || prefsLoading) return
    prefsLoading = true
    try {
      directory.value = await loadDirectory()
    } catch {
      /* 忽略 */
    }
    fillNamesFromDirectory()

    try {
      const list = await loadPinned()
      const map: Record<string, number> = {}
      for (const it of list) {
        map[it.id] = it.time
        if (!sessions.value.some((s) => s.id === it.id)) {
          const info = directory.value.get(it.id)
          upsertSession({
            id: it.id,
            type: it.type || info?.type || 1,
            name: info?.name || it.id,
          })
        }
      }
      pinned.value = map
      persistPinned()
      persistSessions()
    } catch {
      /* 忽略 */
    }

    try {
      folded.value = await loadFoldStates(
        sessions.value.map((s) => ({ id: s.id, type: s.type })),
      )
      persistFolded()
    } catch {
      /* 忽略 */
    }

    try {
      const map = await loadMuteStates()
      muted.value = new Set(
        [...map].filter(([, on]) => on).map(([id]) => id),
      )
      // 同步通知偏好不代表用户已读，保留其他会话已有的未读数。
      persistMuted()
    } catch {
      /* 忽略 */
    }
    prefsLoaded = true
    prefsLoading = false
    persistSessions()
  }

  async function ensurePreferenceStates(): Promise<void> {
    if (prefsLoaded || prefsLoading) return
    await loadPreferenceStates()
  }

  function mergeHistoryMessage(message: ImMessage, session: ChatSession): boolean {
    if (consumeInteraction(message) || [0, 95, 97].includes(Number(message.msg_type))) return false
    const existing = findMessage(message.msg_id)
    if (existing) {
      if (isMine(existing)) confirmOutgoing(existing)
      if (Number(existing.msg_type) === MsgType.COMBINE && Array.isArray(message.content?.msgs)) {
        existing.content = message.content
        persistMessages(existing as ChatMessage)
      }
      applyRecall(existing)
      return false
    }
    const item = { ...message, sessionId: session.id, sessionType: session.type }
    applyRecall(item)
    messages.value.push(item)
    messageIndex.set(item.msg_id, item)
    mentions.observe(item, session, true)
    persistMessages(item)
    return true
  }

  /** 按会话补最近历史，兜住离线推送的遗漏 */
  async function backfillRecent(
    sessionLimit = 20,
    perSession = 30,
  ): Promise<number> {
    const targets = [...sessions.value]
      .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
      .slice(0, sessionLimit)
    let added = 0
    for (const s of targets) {
      try {
        const page = await fetchHistory(s.id, s.type, {
          limit: perSession,
          dateTime: Date.now(),
        })
        await preloadPageInteractions(page.messages)
        for (const m of page.messages) {
          if (m.msg_id && mergeHistoryMessage(m, s)) added += 1
        }
        const newest = Math.max(0, ...page.messages.map((m) => m.send_time || 0))
        if (newest > (s.lastTime || 0)) {
          s.lastTime = newest
          const last = page.messages[0]
          if (last) s.preview = previewOfMessage(last)
        }
      } catch {
        /* 单个失败不影响其它 */
      }
    }
    if (added) persistSessions()
    return added
  }

  /** 拉某会话历史（dateTime 为毫秒；不传则从当前往前） */
  async function loadHistory(
    sessionId: string,
    options: { dateTime?: number; limit?: number } = {},
  ): Promise<number> {
    const s = sessions.value.find((x) => x.id === sessionId)
    if (!s) return 0
    const generation = historyGeneration
    loadingHistory.value = ++historyLoads > 0
    try {
      const page = await fetchHistory(s.id, s.type, {
        limit: options.limit ?? 50,
        dateTime: options.dateTime ?? Date.now(),
      })
      if (generation !== historyGeneration) return 0
      await preloadPageInteractions(page.messages)
      if (generation !== historyGeneration) return 0
      let added = 0
      for (const m of page.messages) {
        if (m.msg_id && mergeHistoryMessage(m, s)) added += 1
      }
      const newest = Math.max(
        0,
        ...page.messages.map((m) => m.send_time || 0),
      )
      if (newest > (s.lastTime || 0)) {
        s.lastTime = newest
        const last = page.messages[0]
        if (last) s.preview = previewOfMessage(last)
      }
      persistSessions()
      return added
    } finally {
      if (generation === historyGeneration) loadingHistory.value = --historyLoads > 0
    }
  }

  /** 在固定时间上界下按 skip 翻页，重复缓存页不等于历史结束。 */
  async function loadOlderHistory(sessionId: string): Promise<number> {
    const session = sessions.value.find(item => item.id === sessionId)
    if (!session) return 0
    let pager = olderPagers.get(sessionId)
    if (!pager) {
      const earliest = Math.min(...messages.value.filter(message => message.sessionId === sessionId).map(message => Number(message.send_time)).filter(time => time > 0))
      pager = new HistoryPager(session.id, session.type, Number.isFinite(earliest) ? earliest + 1 : Date.now())
      olderPagers.set(sessionId, pager)
    }
    const generation = historyGeneration
    loadingHistory.value = ++historyLoads > 0
    try {
      const page = await pager.next(100)
      if (generation !== historyGeneration) return 0
      await preloadPageInteractions(page.messages)
      if (generation !== historyGeneration) return 0
      let added = 0
      for (const message of page.messages) if (mergeHistoryMessage(message, session)) added++
      return added
    } finally { if (generation === historyGeneration) loadingHistory.value = --historyLoads > 0 }
  }
  function olderHistoryComplete(sessionId: string): boolean { return !!historyProgress.value[sessionId]?.complete || !!olderPagers.get(sessionId)?.complete }

  function cancelMessageLookup(sessionId: string) {
    const job = lookups.get(sessionId)
    if (job) { job.cancelled = true; job.pager.cancel() }
  }

  async function loadUntilMessage(sessionId: string, messageId: string): Promise<boolean> {
    if (messages.value.some(message => message.sessionId === sessionId && message.msg_id === messageId)) return true
    const session = sessions.value.find(item => item.id === sessionId)
    if (!session) return false
    // 先查本地窗口：历史消息大多已落库，命中就不用再扫服务端。
    const account = accountId()
    if (account) {
      const cached = await loadMessagesAround(account, sessionId, messageId, 150, 150)
      if (account !== accountId()) return false
      if (cached.length) {
        const added = mergeLoadedMessages(cached)
        if (added) {
          for (const message of cached) applyRecall(message)
          await loadInteractionState(cached.map(message => message.msg_id))
          if (account !== accountId()) return false
        }
        if (messages.value.some(message => message.sessionId === sessionId && message.msg_id === messageId)) return true
      }
    }
    cancelMessageLookup(sessionId)
    const sourceTime = mentions.notices[messageId]?.time || messages.value.find(message => message.sessionId === sessionId && message.reply_msg_id === messageId)?.send_time
    const job = { pager: new HistoryPager(session.id, session.type, sourceTime ? Number(sourceTime) + 1 : Date.now()), cancelled: false }
    lookups.set(sessionId, job)
    lookupProgress.value = { scanned: 0, running: true }
    const generation = historyGeneration
    try {
      while (!job.pager.complete && !job.cancelled && generation === historyGeneration && currentSessionId.value === sessionId) {
        const page = await job.pager.next()
        if (job.cancelled || generation !== historyGeneration || currentSessionId.value !== sessionId) return false
        await preloadPageInteractions(page.messages)
        if (job.cancelled || generation !== historyGeneration || currentSessionId.value !== sessionId) return false
        for (const message of page.messages) mergeHistoryMessage(message, session)
        lookupProgress.value.scanned = job.pager.offset
        if (messages.value.some(message => message.sessionId === sessionId && message.msg_id === messageId)) return true
      }
      return false
    } finally {
      if (lookups.get(sessionId) === job) { lookups.delete(sessionId); lookupProgress.value.running = false }
    }
  }

  function cancelHistoryScan(sessionId: string) {
    const job = scans.get(sessionId)
    if (job) { job.cancelled = true; job.pager.cancel() }
  }

  async function completeReplyHistory(sessionId: string, refresh = false): Promise<void> {
    const session = sessions.value.find(item => item.id === sessionId)
    if (!session) throw new Error('会话不存在')
    const running = scans.get(sessionId)
    if (running && !running.cancelled) return running.promise
    if (historyProgress.value[sessionId]?.complete && !refresh) return
    const pager = !refresh && scanPagers.get(sessionId) || new HistoryPager(session.id, session.type)
    scanPagers.set(sessionId, pager)
    const job = { pager, cancelled: false, promise: undefined as Promise<void> | undefined }
    scans.set(sessionId, job)
    historyProgress.value[sessionId] = { scanned: pager.offset, running: true, complete: false, cancelled: false, error: '' }
    const progress = historyProgress.value[sessionId]
    const generation = historyGeneration
    job.promise = (async () => {
      try {
        while (!job.pager.complete && !job.cancelled && generation === historyGeneration) {
          const page = await job.pager.next()
          if (generation !== historyGeneration) return
          await preloadPageInteractions(page.messages)
          if (generation !== historyGeneration) return
          for (const message of page.messages) mergeHistoryMessage(message, session)
          progress.scanned = job.pager.offset
        }
        progress.complete = job.pager.complete
      } catch (error) {
        if (!job.cancelled) progress.error = error instanceof Error ? error.message.replace(/https?:\/\/[^\s)]+/g, '[请求地址]') : '历史补全失败，可重试'
      } finally {
        progress.running = false
        progress.cancelled = job.cancelled
        if (scans.get(sessionId) === job) scans.delete(sessionId)
      }
    })()
    return job.promise
  }

  /** 全局历史拉取进度：会话级 done/total，细粒度进度复用 historyProgress。 */
  const historyBackfill = ref({ running: false, done: 0, total: 0, failed: 0, cancelled: false, current: '' })
  let historyBackfillTask: Promise<void> | null = null

  /**
   * 为全文搜索拉取全部会话历史。
   *
   * 复用 `completeReplyHistory`：按会话从最新往前翻页，消息照常落库/建索引；
   * 已补全过的会话直接跳过。用户确认后才调用，可随时取消，已拉取部分保留。
   */
  async function backfillAllHistory(): Promise<void> {
    if (historyBackfillTask) return historyBackfillTask
    const account = accountId()
    if (!account) return
    const targets = [...sessions.value].sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
    const progress = historyBackfill.value
    progress.running = true
    progress.cancelled = false
    progress.done = 0
    progress.failed = 0
    progress.total = targets.length
    historyBackfillTask = (async () => {
      try {
        for (const session of targets) {
          if (!progress.running || progress.cancelled || account !== accountId()) break
          progress.current = session.id
          try {
            await completeReplyHistory(session.id)
            if (historyProgress.value[session.id]?.error) progress.failed += 1
          } catch (error) {
            progress.failed += 1
            log(`拉取历史失败（${session.name}）：` + (error instanceof Error ? error.message : String(error)))
          }
          progress.current = ''
          progress.done += 1
        }
      } finally {
        progress.current = ''
        progress.running = false
        historyBackfillTask = null
      }
    })()
    return historyBackfillTask
  }

  function cancelBackfillAllHistory(): void {
    if (!historyBackfill.value.running) return
    historyBackfill.value.cancelled = true
    // 只停掉当前会话：别的扫描可能是楼层回复面板自己开的。
    if (historyBackfill.value.current) cancelHistoryScan(historyBackfill.value.current)
  }

  async function loadForwardDetails(message: ImMessage): Promise<void> {
    const key = String(message.content?.forwardMsgDetailId || message.msg_id)
    const pending = forwardLoads.get(key)
    if (pending) return pending
    const generation = historyGeneration
    const task = (async () => {
      const local = messages.value.find(item => item.msg_id === message.msg_id) || message
      const hydrated = hydrateForwardContent(local.content, messages.value)
      if (hydrated?.msgs?.length) { local.content = hydrated; persistMessages(local as ChatMessage); return }
      const session = sessions.value.find(item => item.id === (message as ChatMessage).sessionId) || currentSession.value
      if (!session) throw new Error('会话不存在')
      const page = await fetchHistory(session.id, session.type, { dateTime: Number(message.send_time) + 1, limit: 100 })
      if (generation !== historyGeneration) return
      const remote = page.messages.find(item => item.msg_id === message.msg_id)
      for (const item of page.messages) mergeHistoryMessage(item, session)
      const content = hydrateForwardContent(remote?.content || local.content, messages.value)
      if (!Array.isArray(content?.msgs) || !content.msgs.length) throw new Error('服务端历史未返回聊天记录明细，可在统一联调时核对原版响应')
      local.content = content
      persistMessages(local as ChatMessage)
    })().finally(() => forwardLoads.delete(key))
    forwardLoads.set(key, task)
    return task
  }

  function isAtMe(message: ImMessage): boolean {
    return !isMine(message) && mentionsUser(message, authService.getCurrentUserId())
  }

  function replySource(message: ImMessage): ImMessage | undefined {
    return messages.value.find(item => item.msg_id === message.reply_msg_id)
  }

  function repliesFor(messageId: string): ChatMessage[] {
    return replyThreads.value.groups.get(replyThreads.value.roots.get(messageId) || messageId) || []
  }

  function reactionsFor(messageId: string) {
    return (interactions.value.reactions[messageId] || []).filter(item => item.active)
  }

  function toggleReaction(message: ImMessage, emoji: string): void {
    const session = sessions.value.find(item => item.id === (message as ChatMessage).sessionId) || currentSession.value
    if (!session || [66, 67].includes(Number(message.msg_type))) throw new Error('原消息不可回应')
    if (interactionPending(message.msg_id)) throw new Error('该消息的操作正在提交')
    delete interactionErrors.value[message.msg_id]
    const remove = reactionsFor(message.msg_id).some(item => item.userId === authService.getCurrentUserId() && item.emoji === emoji)
    const control = imClient.sendReaction(message, session, emoji, remove)
    queueInteraction(control)
  }

  function recallMessage(message: ImMessage, admin = false): void {
    const session = sessions.value.find(item => item.id === (message as ChatMessage).sessionId) || currentSession.value
    if (!session) throw new Error('会话不存在')
    if (!admin && !isMine(message)) throw new Error('只能撤回自己发送的消息')
    if (interactionPending(message.msg_id)) throw new Error('该消息的操作正在提交')
    const control = imClient.sendRecall(message, session, admin)
    delete interactionErrors.value[message.msg_id]
    queueInteraction(control)
    // 保留原文直到服务端广播撤回指令，避免服务端拒绝后本机误删。
    log('撤回请求已提交，等待服务端确认')
  }

  function interactionTarget(message: ImMessage): string {
    return Number(message.msg_type) === MsgType.CTRL ? message.content?.params?.msgId || '' : Number(message.msg_type) === MsgType.RECALL ? message.content : message.content?.msgId || ''
  }

  function queueInteraction(control: ImMessage) {
    pendingInteractions.value[control.msg_id] = control
    interactionTimers.set(control.msg_id, setTimeout(() => {
      if (!pendingInteractions.value[control.msg_id]) return
      interactionErrors.value[interactionTarget(control)] = '服务端确认超时，可检查连接后重试'
      delete pendingInteractions.value[control.msg_id]
      interactionTimers.delete(control.msg_id)
    }, 15000))
  }

  function interactionPending(messageId: string): boolean {
    return Object.values(pendingInteractions.value).some(message => interactionTarget(message) === messageId)
  }

  function retryMessage(message: ImMessage): void {
    if (!isMine(message)) throw new Error('只能重发自己发送的消息')
    delivery.retry(message)
  }

  function queueReadConfirmation(message: ImMessage, session: { id: string; type: number }) {
    if (localReadConfirmations.value[message.msg_id]) return
    const previous = Object.values(pendingReadCommands.value).find(command => String(command.content?.readMsgIds || '').split(',').includes(message.msg_id))
    if (previous) {
      if (previous.__delivery?.state === 'failed') delivery.retry(previous)
      return
    }
    const isBurn = message.is_delete_after_read === true || String(message.is_delete_after_read) === 'true'
    const receipt = String(message.is_need_read_receipt) === 'true'
    const command = imClient.sendMessageRead(message, session, isBurn ? 1 : receipt ? 2 : undefined)
    pendingReadCommands.value[command.msg_id] = command
    delivery.track(pendingReadCommands.value[command.msg_id])
    markReadCommand(command.msg_id)
    persistInteractions()
  }

  function readConfirmationError(id: string): string {
    return Object.values(pendingReadCommands.value).find(command => String(command.content?.readMsgIds || '').split(',').includes(id))?.__error || ''
  }

  function readConfirmationPending(id: string): boolean {
    return Object.values(pendingReadCommands.value).some(command => String(command.content?.readMsgIds || '').split(',').includes(id))
  }

  function confirmMessageRead(message: ImMessage): void {
    const sessionId = (message as ChatMessage).sessionId
    const session = sessions.value.find(item => item.id === sessionId) || currentSession.value
    if (!session || isMine(message)) return
    queueReadConfirmation(message, session)
    if (String(message.is_delete_after_read) === 'true' && !burnDeadlines.value[message.msg_id]) {
      burnDeadlines.value[message.msg_id] = Date.now() + 30000
      markBurn(message.msg_id)
      persistInteractions()
    }
  }

  function burnMessage(messageId: string): void {
    const message = findMessage(messageId)
    interactions.value.recalls[messageId] = { type: MsgType.RECALL, time: Date.now(), hidden: true }
    delete burnDeadlines.value[messageId]
    if (message) applyRecall(message)
    mentions.remove(messageId)
    markInteraction(messageId)
    markBurnDeleted(messageId)
    persistInteractions()
    persistMessages(message as ChatMessage)
  }

  /** 鉴权成功后的固定动作：每次（含重连）都拉一次会话列表；偏好只在首次拉 */
  function onAuthed(): void {
    loadSessionsFromServer()
    ensurePreferenceStates().catch(() => {})
    // 登录后申请一次系统通知权限；拒绝后不会反复弹窗。
    void ensureNotificationPermission()
  }

  let lastBackfillAt = 0

  function onOfflineEnd(): void {
    delivery.resume()
    ensurePreferenceStates().catch(() => {})
    // 每次重连都回填最近历史兜住离线推送遗漏（离线队列按设备投递，漏发不可重放）。
    // 60 秒限流：频繁断连时不重复请求。
    if (Date.now() - lastBackfillAt < 60000) return
    lastBackfillAt = Date.now()
    backfillRecent(20, 30)
      .then((n) => {
        if (n) log(`历史补齐 ${n} 条`)
      })
      .catch(() => {})
  }

  /* ---------------- 连接 ---------------- */

  function start(): void {
    if (unsub) return
    needLogin.value = ''
    // 先读本地窗口再连 WebSocket：hydrate 与新消息按 msg_id 去重，不阻塞建连。
    void startHydration()
    unsub = imClient.on((e) => {
      switch (e.type) {
        case 'open':
          connected.value = true
          log('WebSocket 已连接')
          break
        case 'close':
          connected.value = false
          authed.value = false
          delivery.suspend()
          log(`连接关闭 ${e.data?.code ?? ''}`)
          break
        case 'authed':
          authed.value = true
          log('鉴权成功')
          onAuthed()
          break
        case 'message':
          addMessage(e.data as ImMessage)
          break
        case 'session':
          {
            // 下行 14：有人把会话读到了 lastSendTime。只按对方已读处理，
            // 不回显自己的游标（否则会把自己写进已读名单）。
            const data = (e.data || {}) as Record<string, any>
            const readerId = String(data.from_id || data.fromId || data.userId || '')
            const lastSendTime = Number(data.lastSendTime || 0)
            if (data.kind !== 'readed' || !readerId || !lastSendTime || readerId === authService.getCurrentUserId()) break
            consumeInteraction({
              msg_id: `readed-session-${String(data.toId || data.to_id || readerId)}-${lastSendTime}`,
              msg_type: MsgType.READED,
              from_id: readerId,
              from_name: String(data.from_name || data.fromName || readerId),
              from_type: Number(data.from_type || 1),
              to_id: String(data.to_id || data.toId || ''),
              to_type: Number(data.to_type || data.toType || 1),
              send_time: Number(data.send_time || data.readTime || Date.now()),
              content: {
                toId: data.toId ?? data.to_id,
                toType: data.toType ?? data.to_type,
                lastSendTime,
              },
            } as ImMessage)
          }
          break
        case 'receipt':
          {
            const r = e.data
            // 官方成功回执的 content 是原消息 ID；失败回执才使用 msg_id。
            const id = r?.success ? String(r.content || r.msg_id || '') : String(r?.msg_id || '')
            const m = findMessage(id)
            const control = pendingInteractions.value[id]
            if (pendingReadCommands.value[id] && typeof r?.success === 'boolean') {
              delivery.acknowledge(id, r.success, r.success ? undefined : '阅读确认被拒绝，请重新提交')
            }
            if (r?.success === true) {
              if (m) { confirmOutgoing(m); if (Number(r.time)) m.send_time = Number(r.time) }
              if (control) consumeInteraction({ ...control, send_time: Number(r.time) || control.send_time })
            } else if (r?.success === false) {
              const detail = (typeof r.content === 'string' ? r.content : '服务端拒绝消息')
                .replace(/https?:\/\/[^\s)]+/g, '[请求地址]').slice(0, 200)
              if (m && !m.__sent) { delivery.acknowledge(id, false, detail); m.__sent = false; m.__error = detail; m.__delivery = { state: 'failed', attempts: m.__delivery?.attempts || 1, updatedAt: Date.now() } }
              if (control) { interactionErrors.value[interactionTarget(control)] = detail; delete pendingInteractions.value[id] }
              log('消息提交失败：' + detail)
            }
            if (m) persistMessages(m)
          }
          break
        case 'offline_more':
          log(`离线消息第 ${e.data?.page ?? ''} 页`)
          break
        case 'offline_end':
          log('离线消息拉取结束')
          onOfflineEnd()
          break
        case 'need_login':
          needLogin.value = String(e.data || '登录已失效，请重新登录')
          log(needLogin.value)
          break
        case 'log':
          log(String(e.data))
          break
        case 'error':
          log('错误: ' + JSON.stringify(e.data))
          break
      }
    })
    imClient.init()
  }

  function stop(): void {
    delivery.suspend()
    flushPersist()
    historyGeneration++
    for (const pager of olderPagers.values()) pager.cancel()
    for (const id of scans.keys()) cancelHistoryScan(id)
    for (const id of lookups.keys()) cancelMessageLookup(id)
    scans.clear()
    scanPagers.clear()
    lookups.clear()
    olderPagers.clear()
    forwardLoads.clear()
    forwardUploads.clear()
    historyLoads = 0
    loadingHistory.value = false
    lookupProgress.value = { scanned: 0, running: false }
    imClient.close()
    if (unsub) {
      unsub()
      unsub = null
    }
    connected.value = false
    authed.value = false
    for (const timer of interactionTimers.values()) clearTimeout(timer)
    interactionTimers.clear()
    pendingInteractions.value = {}
    prefsLoaded = false
    lastBackfillAt = 0
  }

  /** 退出登录时清掉本地账号数据，避免换账号后串数据 */
  function resetLocal(): void {
    const leavingAccount = authService.getCurrentUserId()
    void import('./downloads').then(({ useDownloadsStore }) => useDownloadsStore().cancelAll(leavingAccount)).catch(() => log('退出时下载任务清理失败'))
    stop()
    needLogin.value = ''
    imClient.clearSession()
    // 取消待写队列，避免退出后把旧消息重新写回已清除的缓存；
    // 真正的库清理排进写入串行链，保证在已发出的写入之后执行。
    if (messageWriteTimer) {
      clearTimeout(messageWriteTimer)
      messageWriteTimer = null
    }
    pendingMessageWrites.clear()
    messageWriteFailures = 0
    if (unreadWriteTimer) {
      clearTimeout(unreadWriteTimer)
      unreadWriteTimer = null
    }
    pendingUnreadSessions.clear()
    pendingUnreadAtSessions.clear()
    pendingUnreadIds.clear()
    touchedUnread.clear()
    touchedUnreadAt.clear()
    if (interactionWriteTimer) {
      clearTimeout(interactionWriteTimer)
      interactionWriteTimer = null
    }
    pendingInteractionIds.clear()
    pendingConfirmationIds.clear()
    pendingReadCommandIds.clear()
    deletedReadCommandIds.clear()
    pendingBurnIds.clear()
    deletedBurnIds.clear()
    pendingOutboxIds.clear()
    deletedOutboxIds.clear()
    hydrationEpoch++
    hydration = null
    loadedWindows.clear()
    if (leavingAccount) void clearStoredAccount(leavingAccount)
    sessions.value = []
    messages.value = []
    messageIndex.clear()
    interactions.value = emptyInteractions()
    delivery.dispose()
    mentions.reset()
    historyProgress.value = {}
    pendingInteractions.value = {}
    interactionErrors.value = {}
    localReadConfirmations.value = {}
    pendingReadCommands.value = {}
    burnDeadlines.value = {}
    receiptAudiences.clear()
    currentSessionId.value = ''
    hiddenSessions.value = {}
    unread.value = {}
    unreadAt.value = {}
    unreadIds.value = new Set()
    muted.value = new Set()
    folded.value = new Set()
    pinned.value = {}
    directory.value = new Map()
    groupMeta.value = new Map()
    groupDetails.value = new Map()
    leftGroups.value = new Set()
    groupSelfMuted.value = new Set()
    uploads.value = {}
    contacts.value = []
    friends.value = []
    groups.value = []
    searchResults.value = []
    sessionBoosts.value = {}
    for (const key of [
      STORAGE_KEYS.imSessions,
      STORAGE_KEYS.imHiddenSessions,
      STORAGE_KEYS.imSessionBoosts,
      STORAGE_KEYS.imMessages,
      STORAGE_KEYS.imUnread,
      STORAGE_KEYS.imUnreadAt,
      STORAGE_KEYS.imUnreadIds,
      STORAGE_KEYS.imFolded,
      STORAGE_KEYS.imPinned,
      STORAGE_KEYS.imMuted,
      STORAGE_KEYS.imGroupMeta,
      STORAGE_KEYS.imLeftGroups,
    ]) {
      localStorage.removeItem(key)
    }
    for (const key of [
      `yl.im.interactions.${leavingAccount}`,
      `yl.im.receipt-audiences.${leavingAccount}`,
      `yl.im.mentions.${leavingAccount}`,
    ]) {
      localStorage.removeItem(key)
    }
  }

  function log(msg: string): void {
    const ts = new Date().toLocaleTimeString()
    logs.value.unshift(`[${ts}] ${msg}`)
    if (logs.value.length > 100) logs.value.length = 100
    logEvent('协议', msg)
  }

  /* ---------------- 会话操作 ---------------- */

  const currentSession = computed(() =>
    sessions.value.find((s) => s.id === currentSessionId.value),
  )

  const currentMessages = computed(() =>
    messages.value
      .filter((m) => m.sessionId === currentSessionId.value && !interactions.value.recalls[m.msg_id]?.hidden)
      .sort((a, b) => a.send_time - b.send_time),
  )
  const replyThreads = computed(() => {
    const list = currentMessages.value
    const byId = new Map(list.map(message => [message.msg_id, message]))
    const roots = new Map<string, string>()
    for (const message of list) {
      const path: string[] = []
      const visited = new Set<string>()
      let id = message.msg_id
      while (byId.get(id)?.reply_msg_id && !roots.has(id) && !visited.has(id)) {
        visited.add(id)
        path.push(id)
        id = byId.get(id)!.reply_msg_id!
      }
      const root = roots.get(id) || (visited.has(id) ? [...visited].sort()[0] : id)
      roots.set(id, root)
      for (const child of path) roots.set(child, root)
    }
    const groups = new Map<string, ChatMessage[]>()
    for (const message of list) {
      const root = roots.get(message.msg_id) || message.msg_id
      if (!message.reply_msg_id || message.msg_id === root) continue
      const group = groups.get(root) || []
      group.push(message)
      groups.set(root, group)
    }
    return { roots, groups }
  })

  /** 会话排序时间：从搜索结果打开的会话按打开时间置顶，新消息到达后自然回落 */
  const sessionSortTime = (s: ChatSession) =>
    Math.max(s.lastTime || 0, sessionBoosts.value[s.id] || 0)

  /**
   * 置顶排序键，对齐官方 `mutiKeySort("topTime","sendTime","desc")`：
   * 置顶会话按 max(置顶时间, 最新消息时间) 排在最前，未置顶为 0（再按消息时间排）。
   */
  const sessionTopTime = (s: ChatSession): number => {
    const pin = pinned.value[s.id] || 0
    return pin ? Math.max(pin, sessionSortTime(s)) : 0
  }

  const sortedSessions = computed(() =>
    sessions.value
      .filter((s) => !(s.id in hiddenSessions.value))
      .sort(
        (a, b) =>
          sessionTopTime(b) - sessionTopTime(a) ||
          sessionSortTime(b) - sessionSortTime(a),
      ),
  )

  const tabDefs: Array<{
    id: SessionTab
    label: string
    match: (s: ChatSession) => boolean
  }> = [
    {
      id: 'all',
      label: '全部',
      match: (s) => !folded.value.has(s.id),
    },
    {
      id: 'folded',
      label: '折叠',
      match: (s) => folded.value.has(s.id),
    },
  ]

  const tabs = computed(() =>
    tabDefs.map((t) => {
      const list = sortedSessions.value.filter(t.match)
      const count = list
        .filter((s) => !isServiceAccount(s))
        .reduce((sum, s) => sum + (unread.value[s.id] || 0), 0)
      return { id: t.id, label: t.label, unread: count }
    }),
  )

  const visibleSessions = computed(() => {
    const active =
      tabDefs.find((t) => t.id === sessionTab.value) || tabDefs[0]
    return sortedSessions.value.filter(active.match)
  })

  function setTab(tab: SessionTab): void {
    sessionTab.value = tab
  }

  function setChatActive(active: boolean): void {
    chatActive.value = active
    if (active && currentSessionId.value) clearUnread(currentSessionId.value)
  }

  /** 仅隐藏列表项，保留会话信息和全部消息。 */
  function removeSession(id: string): void {
    const session = sessions.value.find((s) => s.id === id)
    if (!session) return
    hiddenSessions.value[id] = Math.max(Date.now(), session.lastTime)
    writeJson(STORAGE_KEYS.imHiddenSessions, hiddenSessions.value)
    clearUnread(id)
    if (currentSessionId.value === id) currentSessionId.value = ''
  }

  /**
   * 目标会话不在当前分栏时把左侧归位，避免「右侧在聊、左侧找不到」。
   * 只在不可见时切换，这样在「全部」里点会话不会把分栏跳走。
   */
  function revealSession(id: string): void {
    if (visibleSessions.value.some((s) => s.id === id)) return
    const s = sessions.value.find((x) => x.id === id)
    const target = s
      ? tabDefs.find((t) => t.id !== 'all' && t.match(s))
      : undefined
    setTab(target ? target.id : 'all')
  }

  const sessionWindowLoads = new Map<string, Promise<void>>()

  /** 打开会话时先补最近窗口；本地没有缓存才回退到服务端历史。 */
  function ensureSessionWindow(id: string): void {
    if (loadedWindows.has(id)) return
    const account = accountId()
    if (!account) return
    const running = sessionWindowLoads.get(id)
    if (running) return
    const task = (async () => {
      const hadLocal = messages.value.some(message => message.sessionId === id)
      const list = await loadSessionMessages(account, id, SESSION_MESSAGE_WINDOW)
      if (account !== accountId()) return
      // 用户已切走时仍可并入内存（按 id 去重），但没有必要再做交互回填。
      const added = mergeLoadedMessages(list)
      if (added) {
        for (const message of list) applyRecall(message)
        await loadInteractionState(list.map(message => message.msg_id))
        if (account !== accountId()) return
      }
      loadedWindows.add(id)
      // 只有本地一条都没有时才请求服务端；启动窗口已经覆盖的会话不重复拉。
      const hasLocal = hadLocal || messages.value.some(message => message.sessionId === id)
      if (!hasLocal && currentSessionId.value === id) {
        await loadHistory(id).catch((e) => log('历史加载失败：' + e.message))
      }
    })().finally(() => sessionWindowLoads.delete(id))
    sessionWindowLoads.set(id, task)
  }

  function selectSession(id: string): void {
    if (id in hiddenSessions.value) {
      delete hiddenSessions.value[id]
      writeJson(STORAGE_KEYS.imHiddenSessions, hiddenSessions.value)
    }
    revealSession(id)
    currentSessionId.value = id
    if (chatActive.value) clearUnread(id)
    ensureSessionWindow(id)
  }

  /** 从搜索结果选中联系人后，让该会话在列表内置顶 */
  function bumpSessionToTop(id: string): void {
    sessionBoosts.value[id] = Date.now()
    writeJson(STORAGE_KEYS.imSessionBoosts, sessionBoosts.value)
  }

  function openChat(
    id: string,
    name: string,
    type: number = FromType.USER,
  ): void {
    upsertSession({ id, name, type })
    fillNamesFromDirectory()
    persistSessions()
    selectSession(id)
  }

  function sendText(text: string, atUserIds: string[] = [], replyMsgId?: string, options: { receipt?: boolean; deleteAfterRead?: boolean } = {}): void {
    const s = currentSession.value
    if (!s || !text.trim()) return
    if (!imClient.authed) {
      throw new Error('长连接未就绪，消息未发送')
    }
    sending.value = true
    try {
      const msg = imClient.sendText(s.id, s.name, s.type, text, replyMsgId, atUserIds, options)
      addMessage(msg)
      trackOutgoing(msg)
    } finally {
      sending.value = false
    }
  }

  /** 发送一条结构化消息（会议邀请等非文本消息）。 */
  function sendStructured(target: { id: string; name: string; type: number }, msgType: number, content: any): void {
    if (!imClient.authed) throw new Error('长连接未就绪，消息未发送')
    const msg = imClient.sendForward(target.id, target.name, target.type, msgType, content)
    addMessage(msg)
    trackOutgoing(msg)
  }

  /** 调用方逐条推进，失败时不重发已成功写入连接的消息。 */
  async function forwardMessage(target: { id: string; name: string; type: number }, list: ImMessage[], combine: boolean): Promise<void> {
    const generation = historyGeneration
    if (!list.length) throw new Error('请先选择消息或文件')
    if (list.some(message => String(message.is_need_read_receipt) === 'true' || String(message.is_delete_after_read) === 'true' || [66, 67].includes(Number(message.msg_type)))) throw new Error('受保护或已撤回消息不可转发')
    const first = [...list].sort((a, b) => Number(a.send_time) - Number(b.send_time))[0]
    const content = combine ? forwardEnvelope(list, messages.value) : first.content
    if (combine) {
      if (JSON.stringify(content).length > 20000) throw new Error('合并转发内容过长，请减少消息数量')
      const key = JSON.stringify(content.msgs)
      let upload = forwardUploads.get(key)
      if (!upload) {
        upload = uploadForwardDetails(content.msgs).catch(error => { forwardUploads.delete(key); throw error })
        forwardUploads.set(key, upload)
        if (forwardUploads.size > 32) forwardUploads.delete(forwardUploads.keys().next().value!)
      }
      content.forwardMsgDetailId = await upload
    }
    if (generation !== historyGeneration) throw new Error('账号会话已变化，转发已停止')
    const msg = imClient.sendForward(target.id, target.name, target.type,
      combine ? MsgType.COMBINE : first.msg_type, content)
    addMessage(msg)
    trackOutgoing(msg)
  }

  function uploadKey(s: ChatSession): string {
    return `${s.type}|${s.id}`
  }

  function setUpload(s: ChatSession, count: number, text: string): void {
    uploads.value = {
      ...uploads.value,
      [uploadKey(s)]: { count, text },
    }
  }

  function clearUpload(s: ChatSession): void {
    const next = { ...uploads.value }
    delete next[uploadKey(s)]
    uploads.value = next
  }

  function currentUploadText(): string {
    const s = currentSession.value
    if (!s) return ''
    return uploads.value[uploadKey(s)]?.text || ''
  }

  /**
   * 文字 + 图片合并成一条富文本消息：先上传全部图片，再发一条 msg_type 96。
   * 与官方一致：块数组首块是文字，后续每块是一张图片的 content JSON。
   */
  async function sendTextWithImages(
    files: File[] | FileList,
    text: string,
    atUserIds: string[] = [],
    replyMsgId?: string,
  ): Promise<void> {
    const generation = historyGeneration
    const s = currentSession.value
    const list = Array.from(files)
    if (!s || !text.trim() || !list.length) return
    if (!imClient.authed) {
      throw new Error('长连接未就绪，附件未上传')
    }
    sending.value = true
    try {
      const images: MediaContent[] = []
      for (let i = 0; i < list.length; i += 1) {
        const f = list[i]
        const label = `${i + 1}/${list.length} ${f.name}`
        setUpload(s, i, `上传中 ${label} · 0%`)
        try {
          const { content } = await imClient.uploadMedia(f, (pct) => {
            if (generation === historyGeneration) setUpload(s, i, `上传中 ${label} · ${pct}%`)
          })
          images.push(content)
        } catch (e: any) {
          if (generation !== historyGeneration) return
          setUpload(s, i, `上传失败：${f.name} · ${e?.message || e}`)
          log(`附件上传失败：${f.name} · ${e?.message || e}`)
          setTimeout(() => clearUpload(s), 4000)
          throw e
        }
      }
      if (generation !== historyGeneration) return
      const msg = imClient.sendRichText(s.id, s.name, s.type, text, images, replyMsgId, atUserIds)
      addMessage(msg)
      trackOutgoing(msg)
      if (generation === historyGeneration) clearUpload(s)
    } finally {
      if (generation === historyGeneration) sending.value = false
    }
  }

  /** 发送图片 / 文件（可多选，逐个上传后按 msg_type 2/3 发送） */
  async function sendFiles(files: File[] | FileList, onSent?: (file: File, index: number) => void, replyMsgId?: string): Promise<void> {
    const generation = historyGeneration
    const s = currentSession.value
    if (!s) return
    const list = Array.from(files)
    if (!list.length) return
    if (!imClient.authed) {
      throw new Error('长连接未就绪，附件未上传')
    }
    sending.value = true
    try {
      for (let i = 0; i < list.length; i += 1) {
        const f = list[i]
        const label = `${i + 1}/${list.length} ${f.name}`
        setUpload(s, i, `上传中 ${label} · 0%`)
        try {
          const msg = await imClient.sendMedia(
            f,
            s.id,
            s.name,
            s.type,
            (pct) => { if (generation === historyGeneration) setUpload(s, i, `上传中 ${label} · ${pct}%`) },
            replyMsgId,
          )
          if (generation !== historyGeneration) return
          addMessage(msg)
          trackOutgoing(msg)
          onSent?.(f, i)
        } catch (e: any) {
          if (generation !== historyGeneration) return
          setUpload(s, i, `上传失败：${f.name} · ${e?.message || e}`)
          log(`附件上传失败：${f.name} · ${e?.message || e}`)
          setTimeout(() => clearUpload(s), 4000)
          throw e
        }
      }
      if (generation === historyGeneration) clearUpload(s)
    } finally {
      if (generation === historyGeneration) sending.value = false
    }
  }

  /* ---------------- 免打扰 / 折叠 ---------------- */

  function applyMute(id: string, on: boolean): void {
    if (on) muted.value.add(id)
    else muted.value.delete(id)
    persistMuted()
    // 显式开启免打扰时只调整目标会话，不能清理其他会话的未读。
    if (on) {
      const keep = unreadAt.value[id] || 0
      if (keep > 0) unread.value[id] = keep
      else delete unread.value[id]
      markUnread(id)
      persistUnread()
    }
  }

  async function toggleMuteSession(s: ChatSession): Promise<boolean> {
    if (!supportsMute(s)) return false
    const on = !muted.value.has(s.id)
    try {
      if (on) await toggleMute(s)
      else await unmute(s)
      applyMute(s.id, on)
      log((on ? '已开启' : '已取消') + '免打扰：' + s.name)
      return on
    } catch (e: any) {
      log('免打扰设置失败：' + (e?.message || e))
      return muted.value.has(s.id)
    }
  }

  /** 置顶 / 取消置顶：服务端成功后更新本地，失败保持原状 */
  async function togglePinSession(s: ChatSession): Promise<boolean> {
    const on = !(pinned.value[s.id] > 0)
    try {
      if (on) {
        const time = await addPin(s)
        pinned.value = { ...pinned.value, [s.id]: time }
      } else {
        await removePin(s.id)
        const next = { ...pinned.value }
        delete next[s.id]
        pinned.value = next
      }
      persistPinned()
      log((on ? '已置顶：' : '已取消置顶：') + s.name)
      return on
    } catch (e: any) {
      log('置顶设置失败：' + (e?.message || e))
      return pinned.value[s.id] > 0
    }
  }

  /** 折叠 / 展开：先更新本地，再同步服务端，失败回滚 */
  async function toggleFoldSession(s: ChatSession): Promise<void> {
    const wantFold = !folded.value.has(s.id)
    if (wantFold) folded.value.add(s.id)
    else folded.value.delete(s.id)
    persistFolded()
    try {
      await setFold(s, wantFold)
      log((wantFold ? '已折叠：' : '已展开：') + s.name)
    } catch (e: any) {
      if (wantFold) folded.value.delete(s.id)
      else folded.value.add(s.id)
      persistFolded()
      log('折叠同步失败：' + (e?.message || e))
    }
  }

  async function ensureTeam(s: ChatSession): Promise<boolean> {
    const cached = groupMeta.value.get(s.id)
    if (cached !== undefined) return cached
    const team = await isTeamGroup(s)
    groupMeta.value.set(s.id, team)
    persistGroupMeta()
    return team
  }

  /* ---------------- 群管理 ---------------- */

  /** 群详情缓存（群设置/非成员与禁言判定依赖）；失败返回缓存或 null */
  async function ensureGroupDetail(groupId: string): Promise<GroupDetail | null> {
    const cached = groupDetails.value.get(groupId)
    if (cached) return cached
    try {
      const d = await groupService.getGroupDetail(groupId)
      if (d) groupDetails.value.set(groupId, d)
      return d || cached || null
    } catch (error) {
      if (cached) return cached
      throw error
    }
  }

  function setGroupDetail(d: GroupDetail): void {
    groupDetails.value.set(String(d.groupId), d)
  }

  /** 群改名后同步：会话名 + 联系人/群列表条目 */
  function renameSession(id: string, name: string): void {
    if (!name) return
    const s = sessions.value.find((x) => x.id === id)
    if (s) s.name = name
    for (const c of contacts.value) {
      if (c.id === id && c.kind === 'group') c.name = name
    }
    for (const g of groups.value) {
      if (String(g.groupId || g.id) === id) {
        g.name = name
        g.groupName = name
      }
    }
    persistSessions()
  }

  /** 退群/解散成功后：移除会话并标记，防止服务端同步把旧会话加回来 */
  function markLeftGroup(id: string): void {
    leftGroups.value.add(id)
    persistLeftGroups()
    const idx = sessions.value.findIndex((x) => x.id === id)
    if (idx >= 0) {
      sessions.value.splice(idx, 1)
      delete unread.value[id]
      delete unreadAt.value[id]
      markUnread(id, true)
      persistSessions()
      persistUnread()
    }
    if (currentSessionId.value === id) currentSessionId.value = ''
    groupDetails.value.delete(id)
  }

  /** 全员禁言群里「自己被禁言」的判定缓存（数据来自成员列表） */
  function setSelfMuted(id: string, on: boolean): void {
    if (on) groupSelfMuted.value.add(id)
    else groupSelfMuted.value.delete(id)
  }

  /* ---------------- 联系人 / 搜索 ---------------- */

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

  async function loadContacts(): Promise<void> {
    contactsLoading.value = true
    try {
      contacts.value = await contactService.loadContactEntries()
      try {
        friends.value = await contactService.getFriends()
      } catch {
        friends.value = []
      }
      try {
        groups.value = await contactService.getMyGroups()
      } catch {
        groups.value = []
      }
      log(`联系人加载完成：${contacts.value.length} 条`)
    } catch (e: any) {
      log('联系人加载失败：' + e.message)
    } finally {
      contactsLoading.value = false
    }
  }

  let searchSeq = 0
  /** 统一搜索：本地好友/群组 + 全员目录；含未聊过的人 */
  async function searchAll(keyword: string): Promise<void> {
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
      const r = await contactService.searchEntries(
        kw,
        friends.value,
        groups.value,
      )
      if (seq === searchSeq) {
        searchResults.value = r.sort((a, b) => Number(b.kind === 'user') - Number(a.kind === 'user'))
      }
    } catch (e: any) {
      if (seq === searchSeq) searchResults.value = []
      log('搜索失败：' + e.message)
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }

  function sessionTypeLabel(type: number): string {
    return FROM_TYPE_LABEL[type] || '未知'
  }

  /** 本地消息全文检索（SQLite FTS）；失败返回空数组，不影响界面。 */
  async function searchMessages(keyword: string): Promise<PersistedMessage[]> {
    const account = accountId()
    if (!account || !keyword.trim()) return []
    const page = await searchStoredMessages(account, keyword, { limit: 40 })
    return page.messages
  }

  /** 联系人/群组搜索，不改动左侧面板的搜索状态（供全局搜索复用）。 */
  async function searchContacts(keyword: string): Promise<ContactEntry[]> {
    const kw = keyword.trim()
    if (!kw) return []
    try {
      const results = await contactService.searchEntries(kw, friends.value, groups.value)
      return results.sort((a, b) => Number(b.kind === 'user') - Number(a.kind === 'user'))
    } catch (e: any) {
      log('搜索联系人失败：' + e.message)
      return []
    }
  }

  function unreadOf(id: string): number {
    const s = sessions.value.find((x) => x.id === id)
    if (isServiceAccount(s)) return 0
    return unread.value[id] || 0
  }

  return {
    connected,
    authed,
    needLogin,
    logs,
    messages,
    sessions,
    currentSessionId,
    currentSession,
    currentMessages,
    sortedSessions,
    visibleSessions,
    tabs,
    sessionTab,
    sending,
    loadingHistory,
    historyProgress,
    historyBackfill,
    backfillAllHistory,
    cancelBackfillAllHistory,
    lookupProgress,
    completeReplyHistory,
    cancelHistoryScan,
    cancelMessageLookup,
    interactions,
    pendingInteractions,
    interactionErrors,
    localReadConfirmations,
    pendingReadCommands,
    burnDeadlines,
    readConfirmationError,
    readConfirmationPending,
    uploads,
    unread,
    unreadAt,
    muted,
    folded,
    pinned,
    directory,
    groupMeta,
    groupDetails,
    leftGroups,
    groupSelfMuted,
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
    /** 等待本地缓存恢复完成（重复调用复用同一个 Promise） */
    hydrate: startHydration,
    /** 立即把节流中的消息/未读/交互写入 SQLite */
    flush: flushPersist,
    resetLocal,
    log,
    selectSession,
    removeSession,
    bumpSessionToTop,
    setChatActive,
    setTab,
    clearUnread,
    sendText,
    sendTextWithImages,
    sendFiles,
    sendStructured,
    forwardMessage,
    openChat,
    loadHistory,
    loadOlderHistory,
    olderHistoryComplete,
    loadUntilMessage,
    loadForwardDetails,
    isAtMe,
    replySource,
    repliesFor,
    reactionsFor,
    toggleReaction,
    recallMessage,
    interactionPending,
    retryMessage,
    confirmMessageRead,
    burnMessage,
    toggleMuteSession,
    togglePinSession,
    toggleFoldSession,
    ensureTeam,
    ensureGroupDetail,
    setGroupDetail,
    renameSession,
    markLeftGroup,
    setSelfMuted,
    sessionTypeLabel,
    loadContacts,
    searchAll,
    searchMessages,
    searchContacts,
    isMine,
    readersOf,
    readTimesOf,
    unreadOf,
    currentUploadText,
  }
})
