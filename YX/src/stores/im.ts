import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
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
import { stripHtml, toPlainText } from '../services/im/content'
import { groupService, type GroupDetail } from '../services/group-client'
import {
  isServiceAccount,
  isTeamGroup,
  loadDirectory,
  loadFoldStates,
  loadMuteStates,
  loadPinned,
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

export type SessionTab = 'dm' | 'group' | 'folded'

const TO_MULTI_TYPES = new Set([2, 4, 8])
const MAX_LOCAL_MESSAGES = 5000

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

  const messages = ref<ChatMessage[]>([])
  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref('')
  const hiddenSessions = ref<Record<string, number>>({})
  // 只有消息页所在窗口位于前台，才把当前会话视为正在阅读。
  const chatActive = ref(false)
  const sending = ref(false)
  const loadingHistory = ref(false)

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

  const sessionTab = ref<SessionTab>(
    (localStorage.getItem(STORAGE_KEYS.imTab) as SessionTab) || 'dm',
  )

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
  let syncingDone = false
  let prefsLoaded = false
  let prefsLoading = false
  let backfilledOnce = false

  /* ---------------- 本地缓存 ---------------- */

  function loadLocal(): void {
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
    const stored = readJson<ChatMessage[]>(STORAGE_KEYS.imMessages, [])
    messages.value = Array.isArray(stored) ? stored : []

    const savedUnread = readJson<Record<string, number>>(
      STORAGE_KEYS.imUnread,
      {},
    )
    unread.value = Object.fromEntries(
      Object.entries(savedUnread).filter(([, v]) => Number(v) > 0),
    )
    unreadAt.value = readJson<Record<string, number>>(
      STORAGE_KEYS.imUnreadAt,
      {},
    )
    unreadIds.value = new Set(
      readJson<string[]>(STORAGE_KEYS.imUnreadIds, []),
    )
    muted.value = new Set(readJson<string[]>(STORAGE_KEYS.imMuted, []))
    folded.value = new Set(readJson<string[]>(STORAGE_KEYS.imFolded, []))
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

    // 服务号的未读不再统计
    for (const s of sessions.value) {
      if (isServiceAccount(s)) delete unread.value[s.id]
    }
  }

  function persistSessions(): void {
    writeJson(STORAGE_KEYS.imSessions, sessions.value)
  }

  function persistMessages(): void {
    if (messages.value.length > MAX_LOCAL_MESSAGES) {
      messages.value.splice(0, messages.value.length - MAX_LOCAL_MESSAGES)
    }
    writeJson(STORAGE_KEYS.imMessages, messages.value)
  }

  function persistUnread(): void {
    writeJson(STORAGE_KEYS.imUnread, unread.value)
    writeJson(STORAGE_KEYS.imUnreadAt, unreadAt.value)
    const ids = [...unreadIds.value]
    // 只留最近 5000 个 id，防止无限增长
    writeJson(
      STORAGE_KEYS.imUnreadIds,
      ids.length > 5000 ? ids.slice(ids.length - 5000) : ids,
    )
  }

  function persistMuted(): void {
    writeJson(STORAGE_KEYS.imMuted, [...muted.value])
  }

  function persistFolded(): void {
    writeJson(STORAGE_KEYS.imFolded, [...folded.value])
  }

  function persistGroupMeta(): void {
    writeJson(STORAGE_KEYS.imGroupMeta, [...groupMeta.value])
  }

  function persistLeftGroups(): void {
    writeJson(STORAGE_KEYS.imLeftGroups, [...leftGroups.value])
  }

  loadLocal()

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
    return stripHtml(toPlainText(Number(msg.msg_type), msg.content))
      .replace(/\s+/g, ' ')
      .slice(0, 60)
  }

  function isMine(m: ImMessage): boolean {
    return m.from_id === authService.getCurrentUserId()
  }

  /** 单条消息进入本地：会话归属、未读、预览 */
  function addMessage(msg: ImMessage): void {
    if (!msg || !msg.msg_id) return
    // 已读/回执类不落库
    if ([0, 95, 97].includes(Number(msg.msg_type))) return
    if (messages.value.some((m) => m.msg_id === msg.msg_id)) {
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
    messages.value.push(item)

    const fromThisDevice =
      !!msg.from_device && msg.from_device === authService.getDeviceId()
    const unreadFlag =
      msg.is_read === 0 || (msg.is_read === undefined && !msg.offline)

    // at_user_ids 是逗号分隔的 user id；@所有人 在服务端是字面量 "ALL"
    const atList = String(msg.at_user_ids || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    const atMe = atList.includes('ALL') || atList.includes(meId)
    const sessionMuted = muted.value.has(ref.id)

    // 只记录提醒判断所需的状态，不记录消息内容、用户标识或凭据。
    log('[提醒诊断] 收到消息 ' + JSON.stringify({
      is_read: msg.is_read,
      is_read类型: typeof msg.is_read,
      offline: msg.offline,
      offline类型: typeof msg.offline,
      未读判定: unreadFlag,
      本设备发送: fromThisDevice,
      自己发送: isMine(msg),
      当前会话: currentSessionId.value === ref.id,
      免打扰: sessionMuted,
      折叠: folded.value.has(ref.id),
      服务号: isServiceAccount({ type: ref.type }),
      提及自己: atMe,
      已计未读: unreadIds.value.has(msg.msg_id),
    }))

    if (unreadFlag && !msg.offline && !isMine(msg) && !fromThisDevice &&
      !sessionMuted && !folded.value.has(ref.id) &&
      !isServiceAccount({ type: ref.type }) && Date.now() - lastSoundAt > 1000) {
      lastSoundAt = Date.now()
      invoke('play_message_sound')
        .then(() => log('[提醒诊断] 提示音命令已执行'))
        .catch((e) => log('[提醒诊断] 提示音调用失败：' + String(e)))
    }


    if (
      unreadFlag &&
      !fromThisDevice &&
      (!chatActive.value || currentSessionId.value !== ref.id) &&
      !isServiceAccount({ type: ref.type }) &&
      !unreadIds.value.has(msg.msg_id) &&
      (!sessionMuted || atMe)
    ) {
      unreadIds.value.add(msg.msg_id)
      unread.value[ref.id] = (unread.value[ref.id] || 0) + 1
      if (atMe) unreadAt.value[ref.id] = (unreadAt.value[ref.id] || 0) + 1
      persistUnread()
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
    persistMessages()
    persistSessions()

    if (chatActive.value && currentSessionId.value === ref.id) {
      delete unread.value[ref.id]
      delete unreadAt.value[ref.id]
      persistUnread()
    }
  }

  /** 本地已读：切到会话就把该会话未读清掉 */
  function clearUnread(id: string): void {
    if (!(id in unread.value) && !(id in unreadAt.value)) return
    delete unread.value[id]
    delete unreadAt.value[id]
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
        for (const m of page.messages) {
          if (!m.msg_id) continue
          if ([0, 95, 97].includes(Number(m.msg_type))) continue
          if (messages.value.some((x) => x.msg_id === m.msg_id)) continue
          messages.value.push({
            ...m,
            sessionId: s.id,
            sessionType: s.type,
          })
          added += 1
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
    if (added) {
      persistMessages()
      persistSessions()
    }
    return added
  }

  /** 拉某会话历史（dateTime 为毫秒；不传则从当前往前） */
  async function loadHistory(
    sessionId: string,
    options: { dateTime?: number; limit?: number } = {},
  ): Promise<number> {
    const s = sessions.value.find((x) => x.id === sessionId)
    if (!s) return 0
    loadingHistory.value = true
    try {
      const page = await fetchHistory(s.id, s.type, {
        limit: options.limit ?? 50,
        dateTime: options.dateTime ?? Date.now(),
      })
      let added = 0
      for (const m of page.messages) {
        if (!m.msg_id) continue
        if (messages.value.some((x) => x.msg_id === m.msg_id)) continue
        messages.value.push({
          ...m,
          sessionId: s.id,
          sessionType: s.type,
        })
        added += 1
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
      persistMessages()
      persistSessions()
      return added
    } finally {
      loadingHistory.value = false
    }
  }

  /** 继续往前翻：用最早一条 send_time - 1 作为游标 */
  async function loadOlderHistory(sessionId: string): Promise<number> {
    const list = messages.value
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.send_time - b.send_time)
    const earliest = list[0]?.send_time
    if (!earliest) return loadHistory(sessionId)
    return loadHistory(sessionId, {
      dateTime: Math.max(0, earliest - 1),
      limit: 50,
    })
  }

  /** 鉴权成功后的固定动作：会话列表、免打扰；离线结束后再补齐折叠/置顶/历史 */
  function onAuthed(): void {
    if (syncingDone) return
    syncingDone = true
    loadSessionsFromServer()
    ensurePreferenceStates().catch(() => {})
  }

  function onOfflineEnd(): void {
    ensurePreferenceStates().catch(() => {})
    if (backfilledOnce) return
    backfilledOnce = true
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
          onAuthed()
          break
        case 'message':
          addMessage(e.data as ImMessage)
          break
        case 'receipt':
          {
            const r = e.data
            const m = messages.value.find((x) => x.msg_id === r?.msg_id)
            if (m) (m as any).__sent = true
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
    imClient.close()
    if (unsub) {
      unsub()
      unsub = null
    }
    connected.value = false
    authed.value = false
    syncingDone = false
    prefsLoaded = false
    backfilledOnce = false
  }

  /** 退出登录时清掉本地账号数据，避免换账号后串数据 */
  function resetLocal(): void {
    stop()
    needLogin.value = ''
    imClient.clearSession()
    sessions.value = []
    messages.value = []
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
    for (const key of [
      STORAGE_KEYS.imSessions,
      STORAGE_KEYS.imHiddenSessions,
      STORAGE_KEYS.imMessages,
      STORAGE_KEYS.imUnread,
      STORAGE_KEYS.imUnreadAt,
      STORAGE_KEYS.imUnreadIds,
      STORAGE_KEYS.imFolded,
      STORAGE_KEYS.imMuted,
      STORAGE_KEYS.imGroupMeta,
      STORAGE_KEYS.imLeftGroups,
    ]) {
      localStorage.removeItem(key)
    }
  }

  function log(msg: string): void {
    const ts = new Date().toLocaleTimeString()
    logs.value.unshift(`[${ts}] ${msg}`)
    if (logs.value.length > 100) logs.value.length = 100
  }

  /* ---------------- 会话操作 ---------------- */

  const currentSession = computed(() =>
    sessions.value.find((s) => s.id === currentSessionId.value),
  )

  const currentMessages = computed(() =>
    messages.value
      .filter((m) => m.sessionId === currentSessionId.value)
      .sort((a, b) => a.send_time - b.send_time),
  )

  const sortedSessions = computed(() =>
    sessions.value
      .filter((s) => !(s.id in hiddenSessions.value))
      .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0)),
  )

  const tabDefs: Array<{
    id: SessionTab
    label: string
    match: (s: ChatSession) => boolean
  }> = [
    {
      id: 'dm',
      label: '单人',
      match: (s) => !folded.value.has(s.id) && (s.type === 1 || s.type === 5),
    },
    {
      id: 'group',
      label: '群聊',
      match: (s) =>
        !folded.value.has(s.id) && (s.type === 2 || s.type === 4 || s.type === 8),
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
    localStorage.setItem(STORAGE_KEYS.imTab, tab)
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

  function selectSession(id: string): void {
    if (id in hiddenSessions.value) {
      delete hiddenSessions.value[id]
      writeJson(STORAGE_KEYS.imHiddenSessions, hiddenSessions.value)
    }
    currentSessionId.value = id
    if (chatActive.value) clearUnread(id)
    const s = sessions.value.find((x) => x.id === id)
    const hasLocal = messages.value.some((m) => m.sessionId === id)
    if (s && !hasLocal) {
      loadHistory(id).catch((e) => log('历史加载失败：' + e.message))
    }
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

  function sendText(text: string, atUserIds: string[] = []): void {
    const s = currentSession.value
    if (!s || !text.trim()) return
    if (!imClient.authed) {
      log('长连接未就绪，消息未发送')
      return
    }
    sending.value = true
    try {
      const msg = imClient.sendText(s.id, s.name, s.type, text, undefined, atUserIds)
      addMessage(msg)
    } finally {
      sending.value = false
    }
  }

  /** 调用方逐条推进，失败时不重发已成功写入连接的消息。 */
  function forwardMessage(target: { id: string; name: string; type: number }, list: ImMessage[], combine: boolean): void {
    if (!list.length) throw new Error('请先选择消息或文件')
    const ordered = [...list].sort((a, b) => a.send_time - b.send_time)
    const first = ordered[0]
    const content = combine ? {
      brief: '[聊天记录]',
      from_name: first.from_name,
      to_name: first.to_name,
      msgs: ordered.map(m => ({
        msg_id: m.msg_id, msg_type: m.msg_type, content: m.content,
        from_id: m.from_id, from_name: m.from_name, from_type: m.from_type,
        to_id: m.to_id, to_name: m.to_name, to_type: m.to_type, send_time: m.send_time,
      })),
    } : first.content
    const msg = imClient.sendForward(target.id, target.name, target.type,
      combine ? MsgType.COMBINE : first.msg_type, content)
    addMessage(msg)
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

  /** 发送图片 / 文件（可多选，逐个上传后按 msg_type 2/3 发送） */
  async function sendFiles(files: File[] | FileList, onSent?: (file: File, index: number) => void): Promise<void> {
    const s = currentSession.value
    if (!s) return
    const list = Array.from(files)
    if (!list.length) return
    if (!imClient.authed) {
      log('长连接未就绪，附件未上传')
      return
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
            (pct) => setUpload(s, i, `上传中 ${label} · ${pct}%`),
          )
          addMessage(msg)
          onSent?.(f, i)
        } catch (e: any) {
          setUpload(s, i, `上传失败：${f.name} · ${e?.message || e}`)
          log(`附件上传失败：${f.name} · ${e?.message || e}`)
          setTimeout(() => clearUpload(s), 4000)
          return
        }
      }
      clearUpload(s)
    } finally {
      sending.value = false
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
    resetLocal,
    log,
    selectSession,
    removeSession,
    setChatActive,
    setTab,
    clearUnread,
    sendText,
    sendFiles,
    forwardMessage,
    openChat,
    loadHistory,
    loadOlderHistory,
    toggleMuteSession,
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
    isMine,
    unreadOf,
    currentUploadText,
  }
})