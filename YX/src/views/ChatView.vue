<template>
  <div class="chat-layout" :class="{ 'with-drawer': drawerOpen && drawerAllowed }">
    <!-- 左侧导航 -->
    <nav class="side-nav">
      <div class="nav-avatar" :title="auth.user?.name">
        {{ (auth.user?.name || '?').slice(0, 1) }}
      </div>
      <router-link to="/chat" class="nav-item active" title="消息">
        <span class="icon">💬</span>
      </router-link>
      <router-link to="/contacts" class="nav-item" title="通讯录">
        <span class="icon">👥</span>
      </router-link>
      <router-link to="/disk" class="nav-item" title="云盘">
        <span class="icon">📁</span>
      </router-link>
      <button class="nav-item" title="我的应用" @click="appOpen = true">
        <span class="icon">▦</span>
      </button>
      <router-link to="/zt" class="nav-item" title="零信任分流">
        <span class="icon">🛡</span>
      </router-link>
      <div class="spacer"></div>
      <ConnectionStatus />
      <button class="nav-item logout" @click="onLogout" title="退出">
        <span class="icon">⏻</span>
      </button>
    </nav>

    <!-- 会话列表 -->
    <aside class="session-panel">
      <div class="panel-header">
        <h3>消息</h3>
        <div class="head-actions">
          <button class="small secondary" @click="appOpen = true">应用</button>
          <button class="small secondary" @click="showLogs = !showLogs">日志</button>
        </div>
      </div>

      <div class="tabs">
        <button
          v-for="t in im.tabs"
          :key="t.id"
          :class="['tab', { on: im.sessionTab === t.id }]"
          @click="im.setTab(t.id)"
        >
          {{ t.label }}
          <i v-if="t.unread > 0">{{ t.unread > 99 ? '99+' : t.unread }}</i>
        </button>
      </div>

      <div class="session-search">
        <input
          v-model="keyword"
          placeholder="搜索联系人/群组（含未聊过的人）"
          @input="onSearch"
        />
      </div>

      <div v-if="im.searching" class="searching">搜索中…</div>

      <!-- 搜索结果（含未聊过的人） -->
      <ul v-if="keyword.trim()" class="session-list">
        <li
          v-for="c in im.searchResults"
          :key="c.kind + ':' + c.id"
          class="search-entry"
          @click="startChat(c)"
        >
          <div class="s-avatar" :class="c.kind">
            {{ (c.name || '?').slice(0, 1) }}
          </div>
          <div class="s-info">
            <div class="s-name-row">
              <span class="s-name">{{ c.name }}</span>
              <span v-if="c.company" class="s-company" :title="c.company">{{ c.company }}</span>
            </div>
            <div v-if="kindLabel(c.kind) || c.dept" class="s-last">{{ [kindLabel(c.kind), c.dept].filter(Boolean).join(' · ') }}</div>
            <div v-if="c.mobile" class="s-mobile">{{ c.mobile }}</div>
          </div>
          <button class="small secondary detail-btn" @click.stop="openDetail(c)">详情</button>
        </li>
        <li v-if="im.searchResults.length === 0 && !im.searching" class="empty">
          没有匹配的联系人
        </li>
      </ul>

      <!-- 会话列表 -->
      <ul v-else class="session-list">
        <li
          v-for="s in im.visibleSessions"
          :key="s.id"
          :class="[
            'sess',
            { active: s.id === im.currentSessionId, muted: im.muted.has(s.id) },
          ]"
          @click="im.selectSession(s.id)"
        >
          <div class="s-avatar" :class="'t' + s.type">
            {{ (s.name || '?').slice(0, 1) }}
          </div>
          <div class="s-info">
            <div class="s-name">
              <span v-if="im.pinned[s.id]" class="pin">📌</span>
              {{ s.name }}
            </div>
            <div class="s-last">{{ s.preview || '暂无消息' }}</div>
          </div>
          <div class="s-side">
            <div class="s-time">{{ fmtSessionTime(s.lastTime) }}</div>
            <div class="s-acts">
              <button
                v-if="supportsMute(s)"
                class="icon-btn"
                :title="im.muted.has(s.id) ? '取消免打扰' : '开启免打扰'"
                @click.stop="im.toggleMuteSession(s)"
              >
                {{ im.muted.has(s.id) ? '🔕' : '🔔' }}
              </button>
              <button
                class="icon-btn fold"
                :title="im.folded.has(s.id) ? '展开' : '折叠'"
                @click.stop="im.toggleFoldSession(s)"
              >
                {{ im.folded.has(s.id) ? '展开' : '折叠' }}
              </button>
              <span v-if="im.unreadOf(s.id) > 0" class="badge">
                {{ im.unreadOf(s.id) > 99 ? '99+' : im.unreadOf(s.id) }}
              </span>
            </div>
          </div>
        </li>
        <li v-if="im.visibleSessions.length === 0" class="empty">
          {{ emptyHint }}
        </li>
      </ul>
    </aside>

    <!-- 聊天主区 -->
    <main class="chat-main">
      <template v-if="im.currentSession">
        <header class="chat-header">
          <div class="chat-title">
            <h3>{{ im.currentSession.name }}</h3>
            <span class="muted">{{ im.sessionTypeLabel(im.currentSession.type) }}</span>
          </div>
          <div class="head-actions">
            <button class="small secondary" @click="toggleSelection">{{ selecting ? '取消多选' : '多选转发' }}</button>
            <button class="small secondary" @click="historyOpen = true">历史</button>
            <button
              v-if="drawerAllowed"
              class="small secondary"
              @click="drawerOpen = !drawerOpen"
            >
              {{ drawerOpen ? '收起任务与文档' : '任务与文档' }}
            </button>
          </div>
        </header>

        <div
          ref="msgList"
          class="msg-list"
          @dragover.prevent="onDragOver"
          @drop.prevent="onDrop"
        >
          <div
            v-for="m in visibleMessages"
            :key="m.msg_id"
            :class="['msg', im.isMine(m) ? 'mine' : 'theirs']"
          >
            <input v-if="selecting && canForward(m.msg_type)" v-model="selectedIds" type="checkbox" :value="m.msg_id" aria-label="选择消息或文件" />
            <div class="msg-body">
              <div class="msg-name">
                {{ im.isMine(m) ? '我' : m.from_name || '未知' }}
                · {{ fmtMsgTime(m.send_time) }}
              </div>
              <div class="bubble-row">
              <div class="bubble">
                <MessageContent
                  :msg-type="Number(m.msg_type)"
                  :content="m.content"
                  @preview="openPreview"
                />
              </div>
              <MessageToolbar v-if="!selecting" :key="composerKey + m.msg_id" :reaction="messageState[m.msg_id]?.reaction" :favorite="!!messageState[m.msg_id]?.favorite" :forwardable="canForward(m.msg_type)" @action="messageAction(m, $event)" @react="setReaction(m.msg_id, $event)" />
              </div>
              <div v-if="messageState[m.msg_id]?.reaction || messageState[m.msg_id]?.favorite" class="message-marks">
                <button v-if="messageState[m.msg_id]?.reaction" title="取消表情回应（本机）" @click="setReaction(m.msg_id, messageState[m.msg_id]!.reaction!)">{{ messageState[m.msg_id]?.reaction }}</button>
                <span v-if="messageState[m.msg_id]?.favorite" title="已收藏到本机">☆ 已收藏</span>
              </div>
            </div>
          </div>

          <div v-if="visibleMessages.length === 0" class="empty-main">
            <div>
              <div>还没有消息</div>
              <button
                class="secondary small history-btn"
                :disabled="im.loadingHistory"
                @click="loadRecent"
              >
                {{ im.loadingHistory ? '加载中…' : '从服务端拉取历史' }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="selecting" class="forward-toolbar">
          <span>已选 {{ selectedMessages.length }} 条消息 / 文件</span>
          <button class="small secondary" @click="selectAll">全选可转发消息</button>
          <button :disabled="!selectedMessages.length || !im.authed" @click="openForward(false)">逐一转发</button>
          <button :disabled="!selectedMessages.length || !im.authed" @click="openForward(true)">合并转发</button>
        </div>
        <footer class="composer" :class="{ 'composer-resizing': resizeStart !== null }" @dragover.prevent="onDragOver" @drop.prevent="onDrop">
          <div
            class="composer-resize-handle"
            title="按住并上下拖动，调整输入框高度"
            role="separator"
            aria-label="调整输入框高度"
            aria-orientation="horizontal"
            @pointerdown="startComposerResize"
            @pointermove="resizeComposer"
            @pointerup="stopComposerResize"
            @pointercancel="stopComposerResize"
            @lostpointercapture="resizeStart = null"
          ></div>
          <input
            ref="fileInput"
            type="file"
            multiple
            hidden
            @change="onPick"
          />
          <button
            class="attach"
            title="添加待发送图片 / 文件"
            :disabled="submitting || im.sending || !im.authed"
            @click="fileInput?.click()"
          >
            ＋
          </button>
          <div class="composer-main">
            <div v-if="pendingAttachments.length" class="pending-attachments">
              <div v-for="item in pendingAttachments" :key="item.id" class="pending-attachment" :title="item.file.name">
                <img v-if="item.preview" :src="item.preview" :alt="item.file.name" />
                <span v-else class="pending-file-icon">📄</span>
                <span class="pending-name">{{ item.file.name }}</span>
                <button class="remove-attachment" :disabled="submitting" :aria-label="`删除待发送附件：${item.file.name}`" @click="removeAttachment(composerKey, item.id)">×</button>
              </div>
            </div>
            <textarea
              ref="composerInput"
              v-model="draft"
              @input="onComposerInput"
              @compositionend="onComposerInput"
              :style="{ height: `${composerHeight}px` }"
              :disabled="submitting"
              placeholder="输入消息，Enter 发送，Shift+Enter 换行；可直接粘贴或拖入图片/文件"
              @keydown.enter.exact="onComposerEnter"
              @paste="onPaste"
            ></textarea>
            <div v-if="im.currentUploadText()" class="upload-state">
              {{ im.currentUploadText() }}
            </div>
          </div>
          <button @click="onSend" :disabled="submitting || im.sending || !im.authed || (!draft.trim() && !pendingAttachments.length)">发送</button>
        </footer>
      </template>

      <div v-else class="empty-main full">
        <div class="placeholder">选择左侧会话，或去通讯录找人开始聊天</div>
      </div>
    </main>

    <!-- 任务 / 文档抽屉 -->
    <ChatDrawer
      v-if="drawerOpen && drawerAllowed && im.currentSession"
      :session="im.currentSession"
      @close="drawerOpen = false"
    />

    <MentionPicker v-if="mentionPosition !== null && im.currentSession" :key="composerKey" :group-id="im.currentSession.id" @close="closeMention" @confirm="confirmMention" />

    <!-- 历史消息 -->
    <HistoryModal v-model:open="historyOpen" @preview="openPreview" />

    <ForwardModal v-if="forwardOpen" :messages="forwardMessages" :combine="forwardCombine" @close="forwardOpen = false" @sent="finishForward" />

    <!-- 应用面板 -->
    <AppPanel v-model:open="appOpen" />

    <!-- 大图 -->
    <div v-if="previewUrl" class="imgview" @click="previewUrl = ''">
      <img :src="previewUrl" :alt="previewName" />
      <div class="imgview-tip">{{ previewName }}</div>
    </div>

    <!-- 协议日志 -->
    <aside v-if="showLogs" class="log-panel">
      <div class="panel-header">
        <h3>协议日志</h3>
        <button class="small secondary" @click="showLogs = false">关闭</button>
      </div>
      <ul class="logs">
        <li v-for="(l, i) in im.logs" :key="i">{{ l }}</li>
      </ul>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useAuthStore } from '../stores/auth'
import { authService } from '../services/auth'
import { useImStore } from '../stores/im'
import MentionPicker from '../components/MentionPicker.vue'
import type { LinkUserDetail } from '../services/contact-client'
import type { ContactEntry } from '../services/contact-client'
import { fmtMsgTime, fmtSessionTime, toPlainText, stripHtml } from '../services/im/content'
import {
  normalizeClipboardImage,
} from '../services/im/media'
import { supportsMute } from '../services/im/prefs'
import ForwardModal from '../components/ForwardModal.vue'
import type { ImMessage } from '../services/im/im-client'
import MessageContent from '../components/MessageContent.vue'
import HistoryModal from '../components/HistoryModal.vue'
import AppPanel from '../components/AppPanel.vue'
import ConnectionStatus from '../components/ConnectionStatus.vue'
import ChatDrawer from '../components/ChatDrawer.vue'
import MessageToolbar from '../components/MessageToolbar.vue'

const auth = useAuthStore()
const im = useImStore()
const route = useRoute()
const router = useRouter()

const selecting = ref(false)
const selectedIds = ref<string[]>([])
const forwardOpen = ref(false)
const forwardCombine = ref(false)
const forwardMessages = ref<ImMessage[]>([])
const selectedMessages = computed(() => visibleMessages.value.filter(m => selectedIds.value.includes(m.msg_id) && canForward(m.msg_type)))
function canForward(type: number) { return [1, 2, 3, 24, 25, 30, 96].includes(Number(type)) }
function toggleSelection() { selecting.value = !selecting.value; selectedIds.value = [] }
function selectOne(id: string) { selecting.value = true; selectedIds.value = [id] }
function selectAll() { selectedIds.value = visibleMessages.value.filter(m => canForward(m.msg_type)).map(m => m.msg_id) }
function openForward(combine: boolean) {
  forwardCombine.value = combine
  forwardMessages.value = [...selectedMessages.value]
  forwardOpen.value = true
}
function finishForward() { forwardOpen.value = false; selecting.value = false; selectedIds.value = [] }
watch(() => im.currentSessionId, () => { selecting.value = false; selectedIds.value = [] })
interface MessageState { reaction?: string; favorite?: boolean; deleted?: boolean }
const messageStateKey = `yl.message-actions.${authService.getCurrentUserId()}`
function readMessageState(): Record<string, MessageState> {
  try { return JSON.parse(localStorage.getItem(messageStateKey) || '{}') || {} } catch { return {} }
}
const messageState = ref<Record<string, MessageState>>(readMessageState())
const visibleMessages = computed(() => im.currentMessages.filter(m => !messageState.value[m.msg_id]?.deleted))
watch(messageState, value => localStorage.setItem(messageStateKey, JSON.stringify(value)), { deep: true })
function setReaction(id: string, emoji: string) {
  const state = messageState.value[id] ||= {}
  state.reaction = state.reaction === emoji ? undefined : emoji
}
async function messageAction(message: ImMessage, action: string) {
  const text = stripHtml(toPlainText(Number(message.msg_type), message.content))
  const state = messageState.value[message.msg_id] ||= {}
  switch (action) {
    case 'copy':
      try { await navigator.clipboard.writeText(text) } catch { window.alert('复制失败，请选中消息文字后复制。') }
      break
    case 'forward':
      forwardMessages.value = [message]
      forwardCombine.value = false
      forwardOpen.value = true
      break
    case 'quote':
      draft.value = `${draft.value}${draft.value ? '\n' : ''}> ${message.from_name || (im.isMine(message) ? '我' : '未知')}：${text.replace(/\n/g, '\n> ')}\n`
      await nextTick()
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
      break
    case 'delete': state.deleted = true; break
    case 'favorite': state.favorite = !state.favorite; break
    case 'more': selectOne(message.msg_id); break
  }
}
interface PendingAttachment {
  id: number
  file: File
  preview: string
}
const composerKey = computed(() => `${im.currentSession?.type}|${im.currentSessionId}`)
const drafts = ref<Record<string, string>>({})
const attachments = ref<Record<string, PendingAttachment[]>>({})
const draft = computed({
  get: () => drafts.value[composerKey.value] || '',
  set: (value: string) => { drafts.value[composerKey.value] = value },
})
const composerInput = ref<HTMLTextAreaElement | null>(null)
const mentionPosition = ref<number | null>(null)
interface DraftMention { id: string; start: number; end: number }
const draftMentions = ref<Record<string, DraftMention[]>>({})
watch(() => [composerKey.value, draft.value] as const, ([key, value], [previousKey, previous]) => {
  if (key !== previousKey) return
  // 保留未被编辑的提醒，并随前方文字的增删移动位置。
  let start = 0
  while (start < value.length && start < previous.length && value[start] === previous[start]) start++
  let end = previous.length
  let newEnd = value.length
  while (end > start && newEnd > start && previous[end - 1] === value[newEnd - 1]) { end--; newEnd-- }
  draftMentions.value[composerKey.value] = (draftMentions.value[composerKey.value] || []).flatMap(item => {
    if (item.end <= start) return [item]
    if (item.start >= end) return [{ ...item, start: item.start + newEnd - end, end: item.end + newEnd - end }]
    return []
  })
}, { flush: 'sync' })
watch(composerKey, () => { mentionPosition.value = null })
function onComposerInput(event: Event) {
  if (event instanceof InputEvent && event.isComposing) return
  if (im.currentSession?.type !== 2) return
  const input = event.target as HTMLTextAreaElement
  const position = input.selectionStart - 1
  if (input.value[position] === '@' && (event.type === 'compositionend' || (event as InputEvent).data?.endsWith('@'))) {
    mentionPosition.value = position
  }
}
async function closeMention() {
  mentionPosition.value = null
  await nextTick()
  composerInput.value?.focus()
}
async function confirmMention(members: LinkUserDetail[]) {
  const position = mentionPosition.value
  if (position === null || !members.length) return
  const text = members.map(member => `@${member.name || member.userName || member.userId} `).join('')
  draft.value = draft.value.slice(0, position) + text + draft.value.slice(position + 1)
  let offset = position
  for (const member of members) {
    const length = 1 + (member.name || member.userName || member.userId).length
    ;(draftMentions.value[composerKey.value] ||= []).push({ id: member.userId, start: offset, end: offset + length })
    offset += length + 1
  }
  await closeMention()
  composerInput.value?.setSelectionRange(offset, offset)
}
const pendingAttachments = computed(() => attachments.value[composerKey.value] || [])
const submitting = ref(false)
let attachmentId = 0
const composerHeight = ref(100)
const resizeStart = ref<{ y: number; height: number; pointerId: number } | null>(null)

function startComposerResize(event: PointerEvent) {
  if (event.button !== 0 || resizeStart.value) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const textarea = handle.parentElement?.querySelector('textarea')
  resizeStart.value = {
    y: event.clientY,
    height: textarea?.getBoundingClientRect().height || composerHeight.value,
    pointerId: event.pointerId,
  }
}

function resizeComposer(event: PointerEvent) {
  const start = resizeStart.value
  if (!start || start.pointerId !== event.pointerId) return
  composerHeight.value = Math.max(60, Math.min(window.innerHeight * 0.45,
    start.height + start.y - event.clientY))
}

function stopComposerResize(event: PointerEvent) {
  if (resizeStart.value?.pointerId !== event.pointerId) return
  resizeStart.value = null
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
}

function addAttachments(files: File[]) {
  if (submitting.value || !im.currentSession) return
  const items = files.map(file => ({
    id: ++attachmentId,
    file,
    preview: file.type.startsWith('image/') || /\.(jpg|jpeg|png|gif|bmp)$/i.test(file.name)
      ? URL.createObjectURL(file) : '',
  }))
  attachments.value[composerKey.value] = [...pendingAttachments.value, ...items]
}

function removeAttachment(key: string, id: number) {
  const items = attachments.value[key] || []
  const item = items.find(item => item.id === id)
  if (item?.preview) URL.revokeObjectURL(item.preview)
  attachments.value[key] = items.filter(item => item.id !== id)
}
const msgList = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const keyword = ref('')
const historyOpen = ref(false)
const appOpen = ref(false)
const showLogs = ref(false)
const drawerOpen = ref(false)
const drawerAllowed = ref(false)
const previewUrl = ref('')
const previewName = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const emptyHint = computed(() => {
  if (im.sessionTab === 'dm') return '还没有单聊'
  if (im.sessionTab === 'group') return '还没有群聊'
  return '没有折叠的会话'
})

let disposed = false
let unlistenFocus: UnlistenFn | undefined

async function trackWindowFocus(): Promise<void> {
  const appWindow = getCurrentWindow()
  let focusChanged = false
  const unlisten = await appWindow.onFocusChanged(({ payload }) => {
    focusChanged = true
    if (!disposed) im.setChatActive(payload)
  })
  if (disposed) {
    unlisten()
    return
  }
  unlistenFocus = unlisten
  const focused = await appWindow.isFocused()
  // 初始化查询期间发生的焦点事件优先，避免旧查询结果覆盖隐藏状态。
  if (!disposed && !focusChanged) im.setChatActive(focused)
}

onMounted(() => {
  if (!auth.isLoggedIn) {
    router.replace('/login')
    return
  }
  const sid = String(route.query.session || '')
  if (sid) {
    const nm = String(route.query.name || '')
    const tp = Number(route.query.type || 1)
    im.openChat(sid, nm || sid, tp)
  }
  trackWindowFocus().catch((e) => im.log('窗口焦点监听失败：' + String(e)))
  im.start()
  // 恢复登录会话时也刷新姓名，修复旧版本把用户 ID 缓存成姓名的情况。
  // 保持异步，不阻塞聊天页面和长连接启动。
  if (!auth.user) {
    authService.getCurrentUser().then(user => {
      if (auth.isLoggedIn && user.id === authService.getCurrentUserId()) auth.user = user
    }).catch(() => {})
  }
  if (im.contacts.length === 0 && !im.contactsLoading) {
    im.loadContacts()
  }
})

onUnmounted(() => {
  disposed = true
  unlistenFocus?.()
  im.setChatActive(false)
  for (const items of Object.values(attachments.value)) {
    for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview)
  }
  im.stop()
})

watch(
  () => im.currentMessages.length,
  async () => {
    await nextTick()
    if (msgList.value) msgList.value.scrollTop = msgList.value.scrollHeight
  },
)

watch(
  () => im.currentSessionId,
  async () => {
    await nextTick()
    if (msgList.value) msgList.value.scrollTop = msgList.value.scrollHeight
    drawerOpen.value = false
    drawerAllowed.value = false
    const s = im.currentSession
    if (!s) return
    drawerAllowed.value = await im.ensureTeam(s)
  },
  { immediate: true },
)

watch(
  () => im.needLogin,
  (msg) => {
    if (!msg) return
    im.resetLocal()
    auth.logout()
    router.replace('/login')
  },
)

function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  const v = keyword.value
  searchTimer = setTimeout(() => im.searchAll(v), 250)
}

function openDetail(c: ContactEntry) {
  router.push({
    path: `/contact/${c.kind}/${encodeURIComponent(c.id)}`,
    query: { name: c.name, desc: c.desc || '' },
  })
}

function startChat(c: ContactEntry) {
  im.openChat(c.id, c.name, c.fromType)
  keyword.value = ''
  im.searchResults = []
}

function onLogout() {
  im.resetLocal()
  auth.logout()
  router.replace('/login')
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'org': return '部门'
    case 'serviceno': return '服务号'
    default: return ''
  }
}

function onComposerEnter(event: KeyboardEvent) {
  // 部分输入法确认时已结束组合，但仍以 229 标记该次按键。
  if (event.isComposing || event.keyCode === 229) return
  if (mentionPosition.value !== null) { event.preventDefault(); return }
  event.preventDefault()
  void onSend()
}

async function onSend() {
  if (submitting.value || im.sending || !im.authed || !im.currentSession) return
  const key = composerKey.value
  const text = draft.value.trim()
  const items = [...pendingAttachments.value]
  if (!text && !items.length) return
  submitting.value = true
  try {
    if (text) {
      im.sendText(text, (draftMentions.value[key] || []).map(item => item.id))
      drafts.value[key] = ''
    }
    await im.sendFiles(items.map(item => item.file), (_, index) => {
      removeAttachment(key, items[index].id)
    })
  } finally {
    submitting.value = false
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length) addAttachments(Array.from(input.files))
  input.value = ''
}

function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files || [])
  if (!files.length) return
  e.preventDefault()
  addAttachments(files.map(file => file.type.startsWith('image/')
    ? normalizeClipboardImage(file, file.type) : file))
}

function onDragOver(e: DragEvent) {
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = submitting.value || !im.currentSession ? 'none' : 'copy'
  }
}

function onDrop(e: DragEvent) {
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  addAttachments(files.map(file => file.type.startsWith('image/')
    ? normalizeClipboardImage(file, file.type) : file))
}

function loadRecent() {
  const s = im.currentSession
  if (!s) return
  im.loadHistory(s.id).catch(() => {})
}

function openPreview(payload: { url: string; name: string }) {
  previewUrl.value = payload.url
  previewName.value = payload.name
}
</script>

<style scoped>
.chat-layout {
  display: grid;
  grid-template-columns: 56px 300px 1fr;
  grid-template-rows: 100%;
  height: 100%;
}
.chat-layout.with-drawer {
  grid-template-columns: 56px 300px 1fr 320px;
}
.side-nav {
  background: #2b2c2d;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 8px;
}
.nav-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  margin-bottom: 12px;
}
.nav-item {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: #fff;
  font-size: 18px;
  background: transparent;
  padding: 0;
  text-decoration: none;
}
.nav-item:hover { background: rgba(255,255,255,0.1); }
.nav-item.active { background: rgba(242,136,35,0.3); }
.nav-item.logout { background: transparent; }
.spacer { flex: 1; }

.session-panel {
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.panel-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.panel-header h3 { font-size: 15px; font-weight: 600; }
.head-actions { display: flex; gap: 6px; }
.small { padding: 4px 10px; font-size: 12px; }

.tabs { display: flex; border-bottom: 1px solid var(--border); }
.tab {
  flex: 1;
  background: transparent;
  color: var(--text-muted);
  border-radius: 0;
  padding: 7px 4px;
  font-size: 12px;
}
.tab:hover { background: #f7f8f9; }
.tab.on { color: var(--primary); box-shadow: inset 0 -2px 0 var(--primary); }
.tab i {
  font-style: normal;
  font-size: 10px;
  background: var(--danger);
  color: #fff;
  padding: 0 5px;
  border-radius: 8px;
  margin-left: 4px;
}

.session-search {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.session-search input { padding: 6px 10px; font-size: 12px; }
.searching { padding: 6px 16px; font-size: 11px; color: var(--text-muted); }
.search-entry { cursor: pointer; }
.s-avatar { cursor: pointer; }
.s-avatar.group { background: #4a90d9; }
.s-name-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.search-entry .s-name { white-space: normal; overflow-wrap: anywhere; }
.s-company {
  display: inline-block; background: #eef2f7; color: #5b6b7c;
  border-radius: 4px; padding: 0 6px; font-size: 11px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.s-mobile { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

.session-list { flex: 1; overflow-y: auto; list-style: none; }
.session-list li {
  padding: 10px 12px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f0;
}
.session-list li:hover { background: #f7f8f9; }
.session-list li.active { background: #eef6fb; }
.s-avatar {
  width: 36px; height: 36px; border-radius: 6px;
  background: var(--primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; flex-shrink: 0;
}
.s-avatar.t2, .s-avatar.t4, .s-avatar.t8 { background: #4a90d9; }
.s-avatar.t5 { background: #7e8a97; }
.s-info { flex: 1; min-width: 0; }
.s-name { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pin { font-size: 11px; }
.s-last { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess.muted .s-name { color: var(--text-muted); }
.s-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}
.s-time { font-size: 10px; color: var(--text-muted); }
.s-acts { display: flex; align-items: center; gap: 4px; }
.icon-btn {
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  padding: 0 2px;
  border-radius: 4px;
}
.icon-btn:hover { background: #eef1f4; }
.icon-btn.fold { font-size: 10px; }
.badge {
  background: var(--danger); color: #fff;
  font-size: 11px; padding: 0 6px; border-radius: 10px;
  line-height: 16px;
}
.empty { padding: 20px; text-align: center; color: var(--text-muted); }

.chat-main {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
  min-width: 0;
}
.chat-header {
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.chat-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.chat-title h3 { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--text-muted); font-size: 12px; }

.msg-list { flex: 1; overflow-y: auto; padding: 16px 20px; }
.msg { display: flex; margin-bottom: 14px; }
.msg.mine { justify-content: flex-end; }
.msg.theirs { justify-content: flex-start; }
.msg-body { max-width: 72%; }
.msg.mine .msg-body { text-align: right; }
.bubble-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.msg.mine .bubble-row { justify-content: flex-end; }
.bubble-row .bubble { min-width: 0; }
.message-marks { display: flex; gap: 6px; align-items: center; margin-top: 4px; font-size: 11px; color: var(--text-muted); }
.msg.mine .message-marks { justify-content: flex-end; }
.message-marks button { background: var(--panel); border: 1px solid var(--border); padding: 1px 6px; border-radius: 12px; }
.msg-name { font-size: 11px; color: var(--text-muted); margin-bottom: 3px; }
.bubble {
  display: inline-block;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 14px;
  word-break: break-word;
  text-align: left;
  max-width: 100%;
}
.msg.theirs .bubble { background: var(--bubble-other); border: 1px solid var(--border); }
.msg.mine .bubble { background: var(--bubble-me); }
.history-btn { margin-top: 10px; }

.composer {
  position: relative;
  flex-shrink: 0;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.composer-resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 8px;
  z-index: 1;
  cursor: ns-resize;
  touch-action: none;
}
.composer-resize-handle:hover,
.composer-resizing .composer-resize-handle { background: var(--border); }
:global(body:has(.composer-resizing)),
:global(body:has(.composer-resizing) *) { cursor: ns-resize !important; user-select: none !important; }
.attach {
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 20px;
  line-height: 1;
  background: #f0f2f4;
  color: #555;
  border-radius: 8px;
}
.attach:hover { background: #e3e7eb; }
.composer-main { flex: 1; min-width: 0; }
.composer textarea {
  width: 100%;
  resize: none;
  height: 100px;
  min-height: 60px;
  max-height: 45vh;
  padding: 8px 12px;
}
.pending-attachments { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 4px; max-height: 180px; overflow-y: auto; }
.pending-attachment { position: relative; width: 90px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; }
.pending-attachment img { width: 100%; height: 64px; object-fit: contain; display: block; }
.pending-file-icon { display: flex; height: 64px; align-items: center; justify-content: center; font-size: 30px; }
.pending-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; margin-top: 4px; }
.remove-attachment { position: absolute; top: -5px; left: -5px; width: 20px; height: 20px; padding: 0; border-radius: 50%; background: #d94343; color: white; font-size: 16px; line-height: 20px; }
.upload-state { font-size: 11px; color: var(--text-muted); margin-top: 3px; }

.empty-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  text-align: center;
  line-height: 2;
}
.empty-main.full { background: var(--bg); }
.placeholder { text-align: center; }

.log-panel {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 300px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 40;
  box-shadow: -6px 0 20px rgba(0, 0, 0, 0.12);
}
.logs { list-style: none; padding: 8px; font-size: 11px; color: var(--text-muted); overflow-y: auto; flex: 1; }
.logs li { padding: 3px 4px; border-bottom: 1px solid #f5f5f5; word-break: break-all; }

.imgview {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  z-index: 70;
  cursor: zoom-out;
}
.imgview img { max-width: 88vw; max-height: 82vh; border-radius: 6px; }
.imgview-tip { color: #eee; font-size: 12px; }
.detail-btn { flex-shrink: 0; }
</style>
<style scoped>
.forward-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--border); }
.detail-btn { flex-shrink: 0; }
</style>
