<template>
  <div class="chat-layout" :class="{ 'with-drawer': drawerOpen && drawerAllowed }">
    <!-- 左侧导航 -->
    <nav class="side-nav">
      <ConnectionStatus />
      <router-link to="/chat" class="nav-item active" title="消息">
        <span class="icon">💬</span>
      </router-link>
      <button class="nav-item" :title="`@ 提醒中心 · ${mentions.pending.length} 条待处理`" @click="mentionsOpen = true">@<small v-if="mentions.pending.length">{{ mentions.pending.length }}</small></button>
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
      <button class="nav-item logout" @click="onLogout" title="退出">
        <span class="icon">⏻</span>
      </button>
    </nav>

    <!-- 会话列表 -->
    <aside class="session-panel">
      <div class="panel-header">
        <h3>消息</h3>
        <div class="head-actions">
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
            <div class="s-last"><span v-if="im.unreadAt[s.id]" class="session-at">[有人@我]</span> {{ s.preview || '暂无消息' }}</div>
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
              <button
                class="icon-btn fold"
                title="仅从列表移除，保留消息记录"
                aria-label="移除历史对话"
                @click.stop="im.removeSession(s.id)"
              >
                移除
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
            <button
              v-if="im.currentSession.type === 2"
              class="small secondary"
              @click="groupSettingsOpen = true"
            >
              群设置
            </button>
            <button class="small secondary" @click="historyOpen = true">历史</button>
            <button v-if="[2, 4, 8].includes(im.currentSession.type)" class="small secondary" :disabled="locating" @click="mentionsOpen = true">待处理@（{{ currentPendingMentions.length }}）</button>
            <button
              v-if="drawerAllowed"
              class="small secondary"
              @click="drawerOpen = !drawerOpen"
            >
              {{ drawerOpen ? '收起任务与文档' : '任务与文档' }}
            </button>
          </div>
        </header>

        <div v-if="activeMention" class="active-mention-bar">
          <span>{{ activeMention.sessionName }} · {{ activeMention.status === 'pending' ? '待处理提醒' : '已处理提醒' }}</span>
          <button class="secondary small" :disabled="locating || !mentions.pending.length" @click="nextMention(-1)">上一条</button><button class="secondary small" :disabled="locating || !mentions.pending.length" @click="nextMention(1)">下一条</button>
          <button class="secondary small" :disabled="locating" @click="locateMention(activeMention, true)">回复</button>
          <button v-if="activeMention.status === 'pending'" class="secondary small" @click="mentions.handle(activeMention.id)">标记已处理</button><button v-else class="secondary small" @click="mentions.reopen(activeMention.id)">重新待处理</button>
          <button class="secondary small" @click="activeMentionId = ''">关闭</button>
        </div>
        <div v-if="locating" class="lookup-progress">正在定位，已检查 {{ im.lookupProgress.scanned }} 条历史消息 <button class="secondary small" @click="cancelLocate">停止</button></div>
        <p v-if="actionError" class="chat-action-error" role="status">{{ actionError }}</p>
        <div class="msg-area">
          <div
            ref="msgList"
            class="msg-list"
            @scroll="onMessageScroll"
            @dragover.prevent="onDragOver"
            @drop.prevent="onDrop"
          >
            <button v-if="messageWindowStart > 0" class="secondary small" @click="showEarlierMessages">显示更早已加载的消息（{{ messageWindowStart }} 条）</button>
            <div
              v-for="m in visibleMessages"
              :key="m.msg_id"
              :data-message-id="m.msg_id"
              :class="['msg', im.isMine(m) ? 'mine' : 'theirs', { 'message-located': highlightedMessageId === m.msg_id, 'message-selectable': selecting && forwardable(m), 'message-selected': selecting && selectedIds.includes(m.msg_id) }]"
            >
              <input v-if="selecting && forwardable(m)" v-model="selectedIds" type="checkbox" :value="m.msg_id" aria-label="选择消息或文件" />
              <div class="msg-body">
                <div class="msg-name">
                  {{ im.isMine(m) ? '我' : m.from_name || '未知' }}
                  · {{ fmtMsgTime(m.send_time) }}
                </div>
                <MessageBubble :message="m" :selecting="selecting" :favorite="favorites.isFavorite(m)" :favorite-status="favorites.status(m)" :forwardable="forwardable(m)" :admin-recallable="adminRecallable" :blocked="composerBlocked" @action="messageAction(m, $event)" @reply="beginReply" @thread="replyThreadId = $event" @receipt="receiptMessage = $event" @preview="openPreview" />
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
          <button v-if="!nearBottom || messageWindowEnd < allVisibleMessages.length" class="new-messages" @click="scrollToLatest">{{ newMessageCount ? `${newMessageCount} 条新消息 · ` : '' }}返回最新消息</button>
        </div>
        <div v-if="selecting" class="forward-toolbar">
          <span>已选 <strong>{{ selectedMessages.length }}</strong> 条消息 / 文件</span>
          <button class="small secondary" @click="cancelSelection">取消</button>
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
          <div class="composer-tools">
            <div class="emoji-picker" @keydown.esc="emojiOpen = false">
              <button class="composer-tool" title="表情" aria-label="选择表情" :aria-expanded="emojiOpen" :disabled="submitting || composerBlocked" @mousedown.prevent @click="emojiOpen = !emojiOpen">☺</button>
              <template v-if="emojiOpen">
                <div class="emoji-dismiss" @click="emojiOpen = false"></div>
                <div class="emoji-panel" role="dialog" aria-label="选择表情">
                  <div class="emoji-heading">表情 <button aria-label="关闭表情" @click="emojiOpen = false">×</button></div>
                  <div class="composer-emojis">
                    <button v-for="face in OFFICIAL_FACES" :key="face.name" :title="face.name" :aria-label="face.name" @mousedown.prevent @click="insertEmoji(face.text)"><img :src="face.url" :alt="face.text" width="26" height="26" /></button>
                  </div>
                </div>
              </template>
            </div>
            <button class="composer-tool" title="添加图片 / 文件" aria-label="添加图片或文件" :disabled="submitting || im.sending || !im.authed || composerBlocked" @click="fileInput?.click()">＋</button>
          </div>
          <div class="composer-main">
            <div v-if="replyDraft" class="reply-draft"><span>回复 {{ replyDraft.from_name }}：{{ protectedMessage(replyDraft) ? '[受保护消息]' : messageText(Number(replyDraft.msg_type), replyDraft.content).slice(0, 160) }}</span><button class="secondary small" @click="cancelReply">取消引用</button></div>
            <div v-if="pendingAttachments.length" class="pending-attachments">
              <div v-for="item in pendingAttachments" :key="item.id" class="pending-attachment" :title="item.file.name">
                <img v-if="item.preview" :src="item.preview" :alt="item.file.name" />
                <span v-else class="pending-file-icon">📄</span>
                <span class="pending-name">{{ item.file.name }}</span>
                <button class="remove-attachment" :disabled="submitting" :aria-label="`删除待发送附件：${item.file.name}`" @click="removeAttachment(composerKey, item.id)">×</button>
              </div>
            </div>
            <div v-if="composerBlocked" class="composer-blocked" role="status">
              {{ composerBlockText }}
            </div>
            <textarea
              ref="composerInput"
              v-model="draft"
              @input="onComposerInput"
              @compositionend="onComposerInput"
              :style="{ height: `${composerHeight}px` }"
              :disabled="submitting || composerBlocked"
              :placeholder="composerBlocked ? '' : '输入消息，可粘贴或拖入图片、文件'"
              @keydown.enter.exact="onComposerEnter"
              @paste="onPaste"
            ></textarea>
            <div v-if="im.currentUploadText()" class="upload-state">
              {{ im.currentUploadText() }}
            </div>
          </div>
          <div class="composer-actions">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <label><input v-model="receiptMode" type="checkbox" :disabled="submitting || burnMode" />要求回执</label>
          <label><input v-model="burnMode" type="checkbox" :disabled="submitting || receiptMode" />阅后即焚</label>
          <button
            @click="onSend"
            :disabled="submitting || im.sending || !im.authed || composerBlocked || (!draft.trim() && !pendingAttachments.length)"
          >发送</button>
          </div>
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
    <HistoryModal v-model:open="historyOpen" @preview="openPreview" @locate="locateMessage" @reply="beginReply" />
    <ReplyThread v-if="replyThreadId" :key="im.currentSessionId + replyThreadId" :message-id="replyThreadId" @close="replyThreadId = ''" @reply="beginReply" @locate="locateMessage" @preview="openPreview" />
    <FavoritesModal v-if="favoritesOpen" :messages="favoriteLocations" @close="favoritesOpen = false" @preview="openPreview" @locate="locateFavorite" />
    <ReceiptModal v-if="receiptMessage" :message="receiptMessage" :readers="im.interactions.readers[receiptMessage.msg_id] || {}" :read-times="im.interactions.readTimes[receiptMessage.msg_id] || {}" @close="receiptMessage = null" />
    <MentionCenter v-if="mentionsOpen" @close="mentionsOpen = false" @locate="locateMention" @reply="locateMention($event, true)" />

    <ForwardModal v-if="forwardOpen" :messages="forwardMessages" :combine="forwardCombine" @close="forwardOpen = false" @sent="finishForward" />

    <!-- 应用面板 -->
    <AppPanel v-model:open="appOpen" />

    <!-- 群设置（仅群会话） -->
    <GroupSettingsModal
      v-if="groupSettingsOpen && im.currentSession"
      :open="groupSettingsOpen"
      :group-id="im.currentSession.id"
      :group-name="im.currentSession.name"
      @close="onGroupSettingsClose"
      @left="onGroupLeft"
    />

    <ImageGallery v-if="previewUrl" :images="galleryImages" :initial-index="galleryIndex" :initial-url="previewUrl" :initial-name="previewName" @close="previewUrl = ''" />

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
import { fmtMsgTime, fmtSessionTime, messageText, segmentsOf, combineDetails, type ImageMeta } from '../services/im/content'
import {
  normalizeClipboardImage,
} from '../services/im/media'
import { supportsMute } from '../services/im/prefs'
import ForwardModal from '../components/ForwardModal.vue'
import type { ImMessage } from '../services/im/im-client'
import HistoryModal from '../components/HistoryModal.vue'
import AppPanel from '../components/AppPanel.vue'
import ConnectionStatus from '../components/ConnectionStatus.vue'
import ChatDrawer from '../components/ChatDrawer.vue'
import MessageBubble from '../components/MessageBubble.vue'
import ImageGallery from '../components/ImageGallery.vue'
import { OFFICIAL_FACES } from '../services/im/official-face'
import ReplyThread from '../components/ReplyThread.vue'
import FavoritesModal from '../components/FavoritesModal.vue'
import type { FavoriteMessageLocation } from '../services/im/favorites'
import { useFavoritesStore } from '../stores/favorites'
import { useMentionsStore, type MentionNotice } from '../stores/mentions'
import MentionCenter from '../components/MentionCenter.vue'
import ReceiptModal from '../components/ReceiptModal.vue'
import GroupSettingsModal from '../components/GroupSettingsModal.vue'
import { groupService } from '../services/group-client'

const auth = useAuthStore()
const im = useImStore()
const favorites = useFavoritesStore()
const mentions = useMentionsStore()
const route = useRoute()
const router = useRouter()

const selecting = ref(false)
const selectedIds = ref<string[]>([])
const forwardOpen = ref(false)
const forwardCombine = ref(false)
const forwardMessages = ref<ImMessage[]>([])
const selectedMessages = computed(() => visibleMessages.value.filter(m => selectedIds.value.includes(m.msg_id) && forwardable(m)))
function canForward(type: number) { return [1, 2, 3, 24, 25, 30, 96].includes(Number(type)) }
function cancelSelection() { selecting.value = false; selectedIds.value = [] }
function selectOne(id: string) { selecting.value = true; selectedIds.value = [id] }
function selectAll() { selectedIds.value = visibleMessages.value.filter(m => forwardable(m)).map(m => m.msg_id) }
function openForward(combine: boolean) {
  forwardCombine.value = combine
  forwardMessages.value = [...selectedMessages.value]
  forwardOpen.value = true
}
function finishForward() { forwardOpen.value = false; selecting.value = false; selectedIds.value = [] }
watch(() => im.currentSessionId, () => { selecting.value = false; selectedIds.value = [] })
interface MessageState { deleted?: boolean }
const messageStateKey = `yl.message-actions.${authService.getCurrentUserId()}`
function readMessageState(): Record<string, MessageState> {
  try { return JSON.parse(localStorage.getItem(messageStateKey) || '{}') || {} } catch { return {} }
}
const messageState = ref<Record<string, MessageState>>(readMessageState())
const allVisibleMessages = computed(() => im.currentMessages.filter(m => !messageState.value[m.msg_id]?.deleted))
const messageWindowEndId = ref('')
const messageWindowEnd = computed(() => {
  const index = messageWindowEndId.value ? allVisibleMessages.value.findIndex(message => message.msg_id === messageWindowEndId.value) : -1
  return index < 0 ? allVisibleMessages.value.length : index + 1
})
const messageWindowStart = computed(() => Math.max(0, messageWindowEnd.value - 300))
const visibleMessages = computed(() => allVisibleMessages.value.slice(messageWindowStart.value, messageWindowEnd.value))
const favoriteLocations = computed<FavoriteMessageLocation[]>(() => im.messages.map(message => ({ ...message, sessionName: im.sessions.find(session => session.id === message.sessionId)?.name || message.to_name || message.from_name })))
watch(messageState, value => localStorage.setItem(messageStateKey, JSON.stringify(value)), { deep: true })
const actionError = ref('')
// 操作提示属于当前会话，切换会话后不保留。
watch(() => im.currentSessionId, () => { actionError.value = '' })
const actionPending = ref(false)
const favoritesOpen = ref(false)
const replyThreadId = ref('')
const receiptMessage = ref<ImMessage | null>(null)
const mentionsOpen = ref(false)
const activeMentionId = ref('')
const activeMention = computed(() => mentions.notices[activeMentionId.value])
const currentPendingMentions = computed(() => mentions.pending.filter(notice => notice.sessionId === im.currentSessionId))
const locating = ref(false)
const highlightedMessageId = ref('')
const nearBottom = ref(true)
const newMessageCount = ref(0)
const adminRecallable = computed(() => im.currentSession?.type === 2 && Number(im.groupDetails.get(im.currentSessionId)?.memberRole || 0) > 0)
function protectedMessage(message: ImMessage): boolean {
  return String(message.is_need_read_receipt) === 'true' || String(message.is_delete_after_read) === 'true'
}
function forwardable(message: ImMessage): boolean { return canForward(message.msg_type) && !protectedMessage(message) }
async function locateFavorite(location: { messageId: string; sessionId: string; sessionType: number; sessionName: string }) {
  favoritesOpen.value = false
  im.openChat(location.sessionId, location.sessionName, location.sessionType)
  await locateMessage(location.messageId)
}
async function locateMention(notice: MentionNotice, reply = false) {
  mentionsOpen.value = false
  activeMentionId.value = notice.id
  im.openChat(notice.sessionId, notice.sessionName, notice.sessionType)
  await locateMessage(notice.id)
  const message = im.messages.find(item => item.msg_id === notice.id && item.sessionId === notice.sessionId)
  if (reply && message) await beginReply(message)
}
function nextMention(direction: number) {
  const pending = mentions.pending
  if (!pending.length) return
  const index = pending.findIndex(notice => notice.id === activeMentionId.value)
  const next = index < 0 ? (direction > 0 ? 0 : pending.length - 1) : (index + direction + pending.length) % pending.length
  void locateMention(pending[next])
}
function showEarlierMessages() {
  const message = allVisibleMessages.value[Math.max(0, messageWindowStart.value)]
  if (message) messageWindowEndId.value = message.msg_id
  void nextTick(() => { if (msgList.value) msgList.value.scrollTop = msgList.value.scrollHeight })
}
async function messageAction(message: ImMessage, action: string) {
  if (actionPending.value) return
  const text = messageText(Number(message.msg_type), message.content)
  const state = messageState.value[message.msg_id] ||= {}
  actionError.value = ''
  try {
    switch (action) {
      case 'copy':
        try { await navigator.clipboard.writeText(text) }
        catch { throw new Error('复制失败，请选中消息文字后复制') }
        break
      case 'forward':
        forwardMessages.value = [message]
        forwardCombine.value = false
        forwardOpen.value = true
        break
      case 'quote': await beginReply(message); break
      case 'delete': state.deleted = true; break
      case 'favoriteSync':
        actionPending.value = true
        await favorites.sync()
        break
      case 'favorite':
        actionPending.value = true
        await favorites.toggle(message, im.currentSession || undefined)
        break
      case 'recall': case 'adminRecall':
        // 撤回结果由消息级状态展示：成功后消息变成「已撤回」，失败显示在消息下方。
        im.recallMessage(message, action === 'adminRecall')
        break
      case 'more': selectOne(message.msg_id); break
    }
  } catch (error) {
    actionError.value = (error instanceof Error ? error.message : '操作失败，请重试').replace(/https?:\/\/[^\s)]+/g, '[请求地址]')
  } finally { actionPending.value = false }
}
let locateGeneration = 0
function cancelLocate() { locateGeneration++; im.cancelMessageLookup(im.currentSessionId); locating.value = false; actionError.value = '已停止定位' }
async function locateMessage(id: string) {
  const sessionId = im.currentSessionId
  historyOpen.value = false
  replyThreadId.value = ''
  const request = ++locateGeneration
  locating.value = true
  actionError.value = ''
  try {
    if (!await im.loadUntilMessage(sessionId, id)) {
      if (request === locateGeneration && im.currentSessionId === sessionId) actionError.value = '本次查找未找到原消息，可继续加载更早历史后重试'
      return
    }
    if (request !== locateGeneration || im.currentSessionId !== sessionId) return
    if (messageState.value[id]?.deleted) messageState.value[id]!.deleted = false
    const index = allVisibleMessages.value.findIndex(message => message.msg_id === id)
    messageWindowEndId.value = allVisibleMessages.value[Math.min(allVisibleMessages.value.length - 1, index + 149)]?.msg_id || ''
    await nextTick()
    const element = msgList.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    if (!element) { actionError.value = '原消息已不可显示'; return }
    element.scrollIntoView({ block: 'center' })
    highlightedMessageId.value = id
    nearBottom.value = false
  } catch { if (request === locateGeneration) actionError.value = '定位消息失败，请检查连接后重试' }
  finally { if (request === locateGeneration) locating.value = false }
}
function onMessageScroll() {
  const element = msgList.value
  if (!element) return
  const atLatest = !messageWindowEndId.value || messageWindowEndId.value === allVisibleMessages.value[allVisibleMessages.value.length - 1]?.msg_id
  nearBottom.value = atLatest && element.scrollHeight - element.scrollTop - element.clientHeight < 80
  if (nearBottom.value) { messageWindowEndId.value = ''; newMessageCount.value = 0 }
  else if (!messageWindowEndId.value) messageWindowEndId.value = visibleMessages.value[visibleMessages.value.length - 1]?.msg_id || ''
}
async function scrollToLatest() {
  messageWindowEndId.value = ''
  nearBottom.value = true
  newMessageCount.value = 0
  await nextTick()
  if (msgList.value) msgList.value.scrollTop = msgList.value.scrollHeight
}
interface PendingAttachment {
  id: number
  file: File
  preview: string
}
const composerKey = computed(() => `${im.currentSession?.type}|${im.currentSessionId}`)
const drafts = ref<Record<string, string>>({})
const replyDrafts = ref<Record<string, ImMessage | undefined>>({})
const replyDraft = computed(() => replyDrafts.value[composerKey.value])
const receiptModes = ref<Record<string, boolean>>({})
const burnModes = ref<Record<string, boolean>>({})
const receiptMode = computed({ get: () => receiptModes.value[composerKey.value] || false, set: value => { receiptModes.value[composerKey.value] = value } })
const burnMode = computed({ get: () => burnModes.value[composerKey.value] || false, set: value => { burnModes.value[composerKey.value] = value } })
const attachments = ref<Record<string, PendingAttachment[]>>({})
const draft = computed({
  get: () => drafts.value[composerKey.value] || '',
  set: (value: string) => { drafts.value[composerKey.value] = value },
})
const emojiOpen = ref(false)

watch(composerKey, () => { emojiOpen.value = false })
async function insertEmoji(emoji: string) {
  if (submitting.value || composerBlocked.value) return
  const input = composerInput.value
  const start = input?.selectionStart ?? draft.value.length
  const end = input?.selectionEnd ?? start
  draft.value = draft.value.slice(0, start) + emoji + draft.value.slice(end)
  emojiOpen.value = false
  await nextTick()
  input?.focus()
  input?.setSelectionRange(start + emoji.length, start + emoji.length)
}
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
function cancelReply() { delete replyDrafts.value[composerKey.value] }
async function beginReply(message: ImMessage) {
  if (composerBlocked.value || [66, 67].includes(Number(message.msg_type)) || protectedMessage(message)) return
  replyThreadId.value = ''
  historyOpen.value = false
  replyDrafts.value[composerKey.value] = message
  if ([2, 4, 8].includes(im.currentSession?.type || 0) && !im.isMine(message) && !(draftMentions.value[composerKey.value] || []).some(item => item.id === message.from_id)) {
    const mention = `@${message.from_name || message.from_id}`
    const start = draft.value.length
    const prefix = start && !/\s$/.test(draft.value) ? ' ' : ''
    draft.value += prefix + mention + ' '
    ;(draftMentions.value[composerKey.value] ||= []).push({ id: message.from_id, start: start + prefix.length, end: start + prefix.length + mention.length })
  }
  await nextTick()
  composerInput.value?.focus()
  composerInput.value?.setSelectionRange(draft.value.length, draft.value.length)
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
  if (submitting.value || !im.currentSession || composerBlocked.value) return
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
const groupSettingsOpen = ref(false)
const previewUrl = ref('')
const previewName = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 群发送拦截（对齐官方 isSilentMode 口径）：
 * - 非群成员（memberRole === -1）：不能发送
 * - 全员禁言开启且「我被禁言」：不能发送（禁言状态在成员列表里，按会话缓存于 im.groupSelfMuted）
 */
const composerBlocked = computed(() => {
  const s = im.currentSession
  if (!s || s.type !== 2) return false
  if (Number(im.groupDetails.get(s.id)?.memberRole ?? 0) === -1) return true
  return im.groupSelfMuted.has(s.id)
})
const composerBlockText = computed(() => {
  const notMember =
    Number(im.groupDetails.get(im.currentSession?.id || '')?.memberRole ?? 0) === -1
  return notMember
    ? '你不是该群成员，无法发送消息'
    : `${im.currentSession?.name || '本'}群禁言中，无法发送消息，需解除禁言后才能发送消息`
})

/** 拉取群详情并按官方口径刷新「自己被禁言」标记（仅全员禁言开启时需要查成员列表） */
async function syncGroupGate(groupId: string) {
  try {
    const d = await im.ensureGroupDetail(groupId)
    if (!d || Number(d.silentStatus) !== 1) {
      im.setSelfMuted(groupId, false)
      return
    }
    const me = authService.getCurrentUserId()
    const mine = (await groupService.getMembers(groupId)).find(m => m.userId === me)
    im.setSelfMuted(
      groupId,
      !!mine &&
        (Number(mine.silentExpireIn) > 0 ||
          (Number(mine.silentStatus) === 1 && Number(mine.memberRole) === 0)),
    )
  } catch {
    im.setSelfMuted(groupId, false)
  }
}

function onGroupSettingsClose() {
  groupSettingsOpen.value = false
  const s = im.currentSession
  // 面板内可能变更过禁言名单（如被加入允许发言名单），关闭时复查一次
  if (s?.type === 2) void syncGroupGate(s.id)
}

function onGroupLeft() {
  const s = im.currentSession
  groupSettingsOpen.value = false
  if (s?.type === 2) im.markLeftGroup(s.id)
}

const emptyHint = computed(() => {
  if (im.sessionTab === 'all') return '还没有会话'
  return '没有折叠的会话'
})

let disposed = false
let unlistenFocus: UnlistenFn | undefined

async function trackWindowFocus(): Promise<void> {
  const appWindow = getCurrentWindow()
  let focusChanged = false
  const unlisten = await appWindow.onFocusChanged(({ payload }) => {
    focusChanged = true
    if (!disposed) {
      im.setChatActive(payload)
      if (payload) { mentions.ensureAccount(); void favorites.sync().catch(() => {}) }
    }
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
  mentions.ensureAccount()
  void favorites.sync().catch(() => {})
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
  // 不要在这里 im.stop()：IM 连接是全局的，离开聊天页只应取消"聊天页激活"标记
})

watch(
  () => im.currentMessages.map(message => ({ id: message.msg_id, time: message.send_time })),
  async (messages, previous) => {
    const sessionId = im.currentSessionId
    const element = msgList.value
    const follow = nearBottom.value
    const height = element?.scrollHeight || 0
    const top = element?.scrollTop || 0
    const oldIds = new Set(previous.map(message => message.id))
    const lastTime = previous[previous.length - 1]?.time || 0
    const addedAtEnd = messages.filter(message => !oldIds.has(message.id) && message.time >= lastTime).length
    const prepended = !!previous.length && messages[0]?.id !== previous[0]?.id && messages.some(message => message.id === previous[0].id)
    await nextTick()
    if (locating.value || im.currentSessionId !== sessionId || !msgList.value) return
    if (!previous.length || (follow && addedAtEnd)) scrollToLatest()
    else if (prepended) msgList.value.scrollTop = top + msgList.value.scrollHeight - height
    if (!follow && addedAtEnd) newMessageCount.value += addedAtEnd
  },
)

watch(
  () => im.currentSessionId,
  async () => {
    await nextTick()
    if (msgList.value) msgList.value.scrollTop = msgList.value.scrollHeight
    nearBottom.value = true
    newMessageCount.value = 0
    replyThreadId.value = ''
    messageWindowEndId.value = ''
    highlightedMessageId.value = ''
    drawerOpen.value = false
    drawerAllowed.value = false
    const s = im.currentSession
    if (!s) return
    drawerAllowed.value = await im.ensureTeam(s)
    groupSettingsOpen.value = false
    if (s.type === 2) void syncGroupGate(s.id)
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
  if (composerBlocked.value) return
  const key = composerKey.value
  const text = draft.value.trim()
  const items = [...pendingAttachments.value]
  if (!text && !items.length) return
  if ((receiptMode.value || burnMode.value) && items.length) { actionError.value = '回执与阅后即焚目前仅支持文字，请先移除附件或关闭阅读模式'; return }
  const replyId = replyDraft.value?.msg_id
  const source = replyId ? im.messages.find(message => message.msg_id === replyId) : undefined
  if (source && [66, 67].includes(Number(source.msg_type))) { actionError.value = '原消息已撤回，请取消引用后发送'; return }
  submitting.value = true
  actionError.value = ''
  try {
    if (text) {
      im.sendText(text, (draftMentions.value[key] || []).map(item => item.id), replyId, { receipt: receiptMode.value, deleteAfterRead: burnMode.value })
      drafts.value[key] = ''
      delete replyDrafts.value[key]
    }
    await im.sendFiles(items.map(item => item.file), (_, index) => {
      removeAttachment(key, items[index].id)
      delete replyDrafts.value[key]
    }, text ? undefined : replyId)
    if (composerKey.value === key) scrollToLatest()
  } catch (error) {
    actionError.value = (error instanceof Error ? error.message : '发送失败，草稿已保留').replace(/https?:\/\/[^\s)]+/g, '[请求地址]')
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

const galleryImages = ref<ImageMeta[]>([])
const galleryIndex = ref(0)
function openPreview(payload: { url: string; name: string; image?: ImageMeta }) {
  const images: ImageMeta[] = []
  function collect(type: number, content: unknown, depth = 0) {
    if (depth > 5) return
    if (type === 24) {
      for (const row of combineDetails(content)) collect(row.msgType, row.content, depth + 1)
    } else for (const segment of segmentsOf(type, content)) if (segment.type === 'image') images.push(segment)
  }
  for (const message of allVisibleMessages.value) if (!protectedMessage(message)) collect(Number(message.msg_type), message.content)
  let index = payload.image ? images.findIndex(image => image.downloadUrl === payload.image!.downloadUrl && image.fileName === payload.image!.fileName) : -1
  if (index < 0) {
    images.unshift(payload.image || { fileName: payload.name, downloadUrl: payload.url, extension: '', size: 0 })
    index = 0
  }
  galleryImages.value = images
  galleryIndex.value = index
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

.msg-area { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.msg-list { flex: 1; overflow-y: auto; padding: 16px 20px; }
.msg { display: flex; margin-bottom: 14px; }
.msg.message-selectable { align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid transparent; }
.msg.message-selected { background: #fff5eb; border-color: var(--primary); }
.msg.message-selectable > input[type='checkbox'] { width: 18px; height: 18px; flex: 0 0 18px; padding: 0; margin: 0; accent-color: var(--primary); cursor: pointer; }
.msg.message-selectable:focus-within { outline: 2px solid var(--primary); outline-offset: 1px; }
.msg.mine { justify-content: flex-end; }
.msg.mine.message-selectable > input { margin-right: auto; }
.msg.theirs { justify-content: flex-start; }
.msg-body { max-width: 72%; }
.msg.mine .msg-body { text-align: right; }
.msg-name { font-size: 11px; color: var(--text-muted); margin-bottom: 3px; }
.history-btn { margin-top: 10px; }

.composer {
  position: relative;
  flex-shrink: 0;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  gap: 10px;
  flex-direction: column;
  align-items: stretch;
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
.composer-main { min-width: 0; }
.composer textarea {
  width: 100%;
  resize: none;
  height: 100px;
  min-height: 60px;
  max-height: 45vh;
  padding: 8px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  outline: none;
}
.pending-attachments { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 4px; max-height: 180px; overflow-y: auto; }
.pending-attachment { position: relative; width: 90px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; }
.pending-attachment img { width: 100%; height: 64px; object-fit: contain; display: block; }
.pending-file-icon { display: flex; height: 64px; align-items: center; justify-content: center; font-size: 30px; }
.pending-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; margin-top: 4px; }
.remove-attachment { position: absolute; top: -5px; left: -5px; width: 20px; height: 20px; padding: 0; border-radius: 50%; background: #d94343; color: white; font-size: 16px; line-height: 20px; }
.upload-state { font-size: 11px; color: var(--text-muted); margin-top: 3px; }
.composer-blocked {
  padding: 6px 8px; margin: 6px 0;
  background: #fdecec; color: var(--danger);
  border-radius: 6px; font-size: 12px;
}

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

.detail-btn { flex-shrink: 0; }
</style>
<style scoped>
.forward-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--border); }
.detail-btn { flex-shrink: 0; }
</style>

<style scoped>
.composer-tools { display: flex; align-items: center; gap: 8px; }
.composer-tool { background: transparent; color: var(--text-muted); width: 32px; height: 30px; padding: 0; font-size: 25px; border-radius: 4px; }
.composer-tool:hover { background: var(--bg); color: var(--text); }
.composer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 16px; }
.composer-actions span { font-size: 11px; color: var(--text-muted); }
.composer-actions > button { min-width: 80px; }
.emoji-picker { position: relative; }
.emoji-dismiss { position: fixed; inset: 0; z-index: 49; }
.emoji-panel { position: absolute; bottom: 38px; left: 0; width: min(320px, 70vw); padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 24px #0002; z-index: 50; }
.emoji-heading { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.emoji-heading button { background: transparent; color: inherit; padding: 0 6px; }
.composer-emojis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; max-height: 280px; overflow-y: auto; }
.composer-emojis button { background: transparent; padding: 6px; font-size: 24px; }
.composer-emojis button:hover { background: var(--bg); }
</style>

<style scoped>
.session-at { color: #d97706; }
.mention-messages { max-height: 220px; overflow: auto; padding: 10px 20px; border-bottom: 1px solid var(--border); }
.mention-messages p { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
.mention-messages button { display: block; width: 100%; text-align: left; margin: 5px 0; }
.chat-action-error { color: #b45309; font-size: 12px; padding: 8px 20px; }
.reply-draft { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-left: 3px solid #9eafc5; background: #eef2f7; color: #526277; font-size: 12px; margin-bottom: 8px; }
.reply-draft span { flex: 1; overflow-wrap: anywhere; }
.composer-actions label { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; white-space: nowrap; }
.composer-actions label input { width: auto; }
.message-located { background: #fff0b8; border-radius: 8px; outline: 2px solid #f0b64d; }
.new-messages { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 2; margin: 0; background: #e2efff; color: #1668c7; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); }
</style>

<style scoped>
.active-mention-bar, .lookup-progress { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 20px; font-size: 12px; background: #fff4d6; color: #855200; }
.nav-item small { font-size: 10px; }
</style>
