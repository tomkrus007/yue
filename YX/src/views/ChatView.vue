<template>
  <div class="chat-layout" :style="layoutStyle">
    <GlobalSearch
      v-model:open="globalSearchOpen"
      @locate="locateSearchMessage"
      @open-session="openSearchSession"
      @open-contact="startChat"
    />

    <!-- 左侧导航 -->
    <SideNav
      active="chat"
      :mention-count="prefs.mentionCenter ? mentions.pending.length : null"
      @mentions="mentionsOpen = true"
      @logs="showLogs = !showLogs"
    />

    <!-- 会话列表 -->
    <aside class="session-panel">
      <div class="panel-header" data-tauri-drag-region="deep">
        <input
          v-model="keyword"
          class="panel-search"
          placeholder="搜索联系人 / 群组"
          @input="onSearch"
          @keydown.enter="onSearchEnter"
          @keydown.down="onSearchArrow($event, 1)"
          @keydown.up="onSearchArrow($event, -1)"
        />
        <button
          class="panel-search-global"
          title="搜索全部聊天记录（⌘K）"
          aria-label="搜索全部聊天记录"
          @click="globalSearchOpen = true"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.2 4.2" />
          </svg>
        </button>
      </div>

      <div class="tabs">
        <button
          v-for="t in im.tabs"
          :key="t.id"
          :class="['tab', { on: im.sessionTab === t.id }]"
          @click="im.setTab(t.id)"
        >
          {{ t.label }}
        </button>
      </div>

      <div v-if="im.searching" class="searching">搜索中…</div>

      <!-- 搜索结果（含未聊过的人） -->
      <ul v-if="keyword.trim()" ref="searchListEl" class="session-list">
        <li
          v-for="(c, index) in im.searchResults"
          :key="c.kind + ':' + c.id"
          :class="['search-entry', { on: index === searchActive }]"
          @click="startChat(c)"
        >
          <ContactAvatar
            class="s-avatar"
            :class="c.kind"
            :id="c.id"
            :type="c.fromType"
            :name="c.name"
          />
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
          <div class="s-avatar-wrap">
            <ContactAvatar
              class="s-avatar"
              :class="'t' + s.type"
              :id="s.id"
              :type="s.type"
              :name="s.name"
            />
            <span
              v-if="im.unreadOf(s.id) > 0"
              class="avatar-badge"
              :title="`${im.unreadOf(s.id)} 条未读消息`"
            >{{ im.unreadOf(s.id) > 99 ? '99+' : im.unreadOf(s.id) }}</span>
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
                :class="['icon-btn', { 'mute-on': im.muted.has(s.id) }]"
                :title="im.muted.has(s.id) ? '取消免打扰' : '开启免打扰'"
                :aria-label="im.muted.has(s.id) ? '取消免打扰' : '开启免打扰'"
                @click.stop="im.toggleMuteSession(s)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
                  <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                  <path v-if="im.muted.has(s.id)" d="M3 3l18 18" />
                </svg>
              </button>
              <button
                class="icon-btn more"
                title="更多操作"
                aria-label="更多操作"
                :aria-expanded="sessionMenu?.session.id === s.id"
                @click.stop="openSessionMenu(s, $event)"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.7" />
                  <circle cx="12" cy="12" r="1.7" />
                  <circle cx="19" cy="12" r="1.7" />
                </svg>
              </button>
            </div>
          </div>
        </li>
        <li v-if="im.visibleSessions.length === 0" class="empty">
          {{ emptyHint }}
        </li>
      </ul>

      <!-- 会话「更多操作」：折叠/展开、移除收进二级菜单，避免列表内误触 -->
      <Teleport to="body">
        <div
          v-if="sessionMenu"
          class="sess-menu-backdrop"
          @click="closeSessionMenu"
        >
          <div
            class="sess-menu"
            role="menu"
            :aria-label="`${sessionMenu.session.name} 的更多操作`"
            :style="{ left: sessionMenu.left + 'px', top: sessionMenu.top + 'px' }"
            @click.stop
          >
            <button v-if="sessionDetailKind(sessionMenu.session)" role="menuitem" @click="openSessionDetail(sessionMenu.session)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="8" r="3.4" />
                <path d="M5 20c.6-3.4 3.4-5.4 7-5.4s6.4 2 7 5.4" />
              </svg>
              查看联系人详情
            </button>
            <button role="menuitem" @click="pinFromSessionMenu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9.5 3.5h5l-1 6 4 4h-11l4-4-1-6z" />
                <path d="M12 13.5V21" />
              </svg>
              {{ im.pinned[sessionMenu.session.id] ? '取消置顶' : '置顶会话' }}
            </button>
            <button role="menuitem" @click="foldFromSessionMenu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="im.folded.has(sessionMenu.session.id) ? 'm6 9 6 6 6-6' : 'm18 15-6-6-6 6'" />
              </svg>
              {{ im.folded.has(sessionMenu.session.id) ? '展开' : '折叠' }}
            </button>
            <button role="menuitem" class="danger" @click="removeFromSessionMenu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
              </svg>
              移除
            </button>
          </div>
        </div>
      </Teleport>
    </aside>

    <!-- 拖动调整会话/联系人分栏宽度 -->
    <PaneResizer v-model="sessionWidth" storage-key="chat_session_panel_width" :min="240" :max="640" :reserve="420" />

    <!-- 聊天主区 -->
    <main class="chat-main">
      <template v-if="im.currentSession">
        <header class="chat-header" data-tauri-drag-region="deep">
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
            <button v-if="im.currentSession.type === 1" class="small secondary" @click="groupChatOpen = true">群聊</button>
            <button class="small secondary" @click="historyOpen = true">历史</button>
            <button
              v-if="[1, 2, 4, 8].includes(im.currentSession.type)"
              class="small secondary"
              :disabled="meetingBusy || !im.authed"
              @click="startVideoMeeting"
            >
              {{ meetingBusy ? '会议启动中…' : '视频会议' }}
            </button>
            <button v-if="prefs.mentionCenter && [2, 4, 8].includes(im.currentSession.type)" class="small secondary" :disabled="locating" @click="mentionsOpen = true">待处理@（{{ currentPendingMentions.length }}）</button>
            <button
              v-if="drawerAllowed"
              class="small secondary"
              @click="drawerOpen = !drawerOpen"
            >
              {{ drawerOpen ? '收起任务与文档' : '任务与文档' }}
            </button>
          </div>
        </header>

        <div v-if="prefs.mentionCenter && activeMention" class="active-mention-bar">
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
              <ContactAvatar
                v-if="showSenderAvatar(m)"
                class="msg-avatar"
                :id="m.from_id"
                :type="FromType.USER"
                :name="m.from_name"
                :title="`双击与${m.from_name || '对方'}发起单聊`"
                @dblclick.stop="startPrivateChat(m)"
              />
              <div class="msg-body">
                <div class="msg-name">
                  {{ im.isMine(m) ? '我' : m.from_name || '未知' }}
                  · {{ fmtMsgTime(m.send_time) }}
                </div>
                <MessageBubble :message="m" :selecting="selecting" :favorite="favorites.isFavorite(m)" :favorite-status="favorites.status(m)" :forwardable="forwardable(m)" :admin-recallable="adminRecallable" :blocked="composerBlocked" :contactable="showSenderDetail(m)" @action="messageAction(m, $event)" @reply="beginReply" @thread="replyThreadId = $event" @receipt="receiptMessage = $event" @preview="openPreview" />
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
          <button v-if="showScrollTop" class="jump-btn to-top" title="回到顶部" aria-label="回到顶部" @click="scrollToTop">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m6 13 6-6 6 6" />
              <path d="m6 19 6-6 6 6" />
            </svg>
          </button>
          <button
            v-if="!nearBottom || messageWindowEnd < allVisibleMessages.length"
            class="jump-btn to-latest"
            :title="latestButtonTitle"
            :aria-label="latestButtonTitle"
            @click="scrollToLatest"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m6 5 6 6 6-6" />
              <path d="m6 11 6 6 6-6" />
            </svg>
            <span v-if="newMessageCount" class="jump-badge">{{ newMessageCount > 99 ? '99+' : newMessageCount }}</span>
          </button>
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
            <div v-if="activeSpecialMode" class="composer-mode-bar" role="status">
              <span class="mode-tag">[{{ activeSpecialMode }}]</span>
              <span class="mode-note">{{ specialModeNote }}</span>
              <button class="secondary small" @click="clearSpecialMode">取消</button>
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
            <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            <button
              v-if="canUseReceipt"
              class="composer-mode"
              :class="{ active: receiptMode }"
              :aria-pressed="receiptMode"
              title="群聊/部门消息：成员看到就自动回执，仅支持文字"
              :disabled="submitting || composerBlocked"
              @click="toggleReceiptMode"
            >回执消息</button>
            <button
              v-if="canUseReceipt"
              class="composer-mode"
              :class="{ active: cardMode }"
              :aria-pressed="cardMode"
              title="群聊/部门消息：成员点开后才回执，仅支持文字"
              :disabled="submitting || composerBlocked"
              @click="toggleCardMode"
            >回执卡片</button>
            <button
              v-if="canUseBurn"
              class="composer-mode"
              :class="{ active: burnMode }"
              :aria-pressed="burnMode"
              title="单聊消息：对方打开后 30 秒销毁，仅支持文字"
              :disabled="submitting || composerBlocked"
              @click="toggleBurnMode"
            >无痕消息</button>
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
    <ReceiptModal v-if="receiptMessage" :message="receiptMessage" :readers="im.readersOf(receiptMessage.msg_id)" :read-times="im.readTimesOf(receiptMessage.msg_id)" @close="receiptMessage = null" />
    <MentionCenter v-if="mentionsOpen" @close="mentionsOpen = false" @locate="locateMention" @reply="locateMention($event, true)" />

    <ForwardModal v-if="forwardOpen" :messages="forwardMessages" :combine="forwardCombine" @close="forwardOpen = false" @sent="finishForward" />

    <!-- 群设置（仅群会话） -->
    <GroupSettingsModal
      v-if="groupSettingsOpen && im.currentSession"
      :open="groupSettingsOpen"
      :group-id="im.currentSession.id"
      :group-name="im.currentSession.name"
      @close="onGroupSettingsClose"
      @left="onGroupLeft"
    />

    <!-- 单聊拉群：当前对象 + 选择其他联系人建群 -->
    <CreateGroupModal
      v-if="groupChatOpen && im.currentSession"
      :open="groupChatOpen"
      :preset="groupChatPreset"
      @close="groupChatOpen = false"
      @created="onGroupChatCreated"
    />

    <!-- 群/部门会话发起会议：先选邀请人 -->
    <MemberPicker
      v-if="meetingPickerOpen"
      :open="meetingPickerOpen"
      title="选择要邀请的同事"
      source="contacts"
      @close="meetingPickerOpen = false"
      @confirm="confirmMeetingInvitees"
    />

    <ImageGallery v-if="previewUrl" :images="galleryImages" :initial-index="galleryIndex" :initial-url="previewUrl" :initial-name="previewName" @close="previewUrl = ''" />

    <!-- 应用日志：协议 + 登录 + console + 未捕获异常 -->
    <aside v-if="showLogs" class="log-panel">
      <div class="panel-header">
        <h3>日志</h3>
        <div class="log-actions">
          <button class="small secondary" :disabled="!appLog.entries.length" @click="clearLogs">清空</button>
          <button class="small secondary" @click="showLogs = false">关闭</button>
        </div>
      </div>
      <div class="log-filters" role="group" aria-label="日志来源筛选">
        <button :class="['log-filter', { active: logScope === '' }]" @click="logScope = ''">
          全部 <small>{{ appLog.entries.length }}</small>
        </button>
        <button
          v-for="scope in logScopes"
          :key="scope"
          :class="['log-filter', { active: logScope === scope }]"
          @click="logScope = logScope === scope ? '' : scope"
        >
          {{ scope }} <small>{{ logScopeCount(scope) }}</small>
        </button>
      </div>
      <ul class="logs">
        <li v-for="entry in shownLogs" :key="entry.id" :class="['log-line', `log-${entry.level}`]">
          <span class="log-meta">{{ entry.time }} · {{ entry.scope }}</span>
          <span class="log-text">{{ entry.text }}</span>
        </li>
        <li v-if="!shownLogs.length" class="log-empty">暂无日志</li>
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
import { useImStore, type ChatSession } from '../stores/im'
import MentionPicker from '../components/MentionPicker.vue'
import type { LinkUserDetail } from '../services/contact-client'
import type { ContactEntry } from '../services/contact-client'
import { fmtMsgTime, fmtSessionTime, messageText, segmentsOf, combineDetails, type ImageMeta } from '../services/im/content'
import { dedupeMeetingCards } from '../services/im/wemeet-invite'
import {
  IMAGE_MSG_EXTS,
  normalizeClipboardImage,
} from '../services/im/media'
import { supportsMute } from '../services/im/prefs'
import ForwardModal from '../components/ForwardModal.vue'
import type { ImMessage } from '../services/im/im-client'
import HistoryModal from '../components/HistoryModal.vue'
import SideNav from '../components/SideNav.vue'
import PaneResizer from '../components/PaneResizer.vue'
import ChatDrawer from '../components/ChatDrawer.vue'
import MessageBubble from '../components/MessageBubble.vue'
import ContactAvatar from '../components/ContactAvatar.vue'
import GlobalSearch from '../components/GlobalSearch.vue'
import type { PersistedMessage } from '../services/im/store'
import ImageGallery from '../components/ImageGallery.vue'
import { OFFICIAL_FACES } from '../services/im/official-face'
import { appLog, clearLogs } from '../services/app-log'
import ReplyThread from '../components/ReplyThread.vue'
import FavoritesModal from '../components/FavoritesModal.vue'
import type { FavoriteMessageLocation } from '../services/im/favorites'
import { useFavoritesStore } from '../stores/favorites'
import { useMentionsStore, type MentionNotice } from '../stores/mentions'
import { usePreferencesStore } from '../stores/preferences'
import MentionCenter from '../components/MentionCenter.vue'
import ReceiptModal from '../components/ReceiptModal.vue'
import GroupSettingsModal from '../components/GroupSettingsModal.vue'
import CreateGroupModal from '../components/CreateGroupModal.vue'
import MemberPicker from '../components/MemberPicker.vue'
import type { PickedMember } from '../components/MemberPicker.vue'
import { groupService } from '../services/group-client'
import { FromType } from '../services/im/types'
import { useWeMeetStore } from '../stores/wemeet'

const auth = useAuthStore()
const im = useImStore()
const favorites = useFavoritesStore()
const mentions = useMentionsStore()
const prefs = usePreferencesStore()
const route = useRoute()
const router = useRouter()

const selecting = ref(false)
const selectedIds = ref<string[]>([])
const globalSearchOpen = ref(false)
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
const allVisibleMessages = computed(() => dedupeMeetingCards(
  im.currentMessages.filter(m => !messageState.value[m.msg_id]?.deleted),
))
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
const wemeet = useWeMeetStore()
const meetingBusy = ref(false)
const meetingPickerOpen = ref(false)

/**
 * 聊天里发起视频会议：单聊直接邀请对方，群/部门会话先选人。
 * 会议号由 SDK 的 `OnJoinMeeting` 回调带回，拿到后再发邀请。
 */
function startVideoMeeting() {
  const session = im.currentSession
  if (!session || meetingBusy.value) return
  if (session.type === 1) {
    void inviteToVideoMeeting([{ id: session.id, name: session.name }])
  } else {
    meetingPickerOpen.value = true
  }
}

function confirmMeetingInvitees(items: PickedMember[]) {
  meetingPickerOpen.value = false
  if (items.length) void inviteToVideoMeeting(items)
}

async function inviteToVideoMeeting(invitees: { id: string; name: string }[]) {
  meetingBusy.value = true
  actionError.value = ''
  try {
    const { sent } = await wemeet.startMeetingAndInvite(invitees)
    actionError.value = sent
      ? `会议已开始，已向 ${sent} 人发送邀请`
      : '会议已开始，但没有可邀请的人'
  } catch (error) {
    actionError.value = (error instanceof Error ? error.message : '发起会议失败，请重试').replace(/https?:\/\/[^\s)]+/g, '[请求地址]')
  } finally {
    meetingBusy.value = false
  }
}
const favoritesOpen = ref(false)
const replyThreadId = ref('')
const receiptMessage = ref<ImMessage | null>(null)
const mentionsOpen = ref(false)
const activeMentionId = ref('')
const activeMention = computed(() => mentions.notices[activeMentionId.value])
const currentPendingMentions = computed(() => mentions.pending.filter(notice => notice.sessionId === im.currentSessionId))
watch(() => prefs.mentionCenter, (enabled) => {
  if (enabled) return
  mentionsOpen.value = false
  activeMentionId.value = ''
})
const locating = ref(false)
const highlightedMessageId = ref('')
const nearBottom = ref(true)
const newMessageCount = ref(0)
/** 顶部回顶按钮只在离开顶部一定距离后出现，避免长会话里一直浮着。 */
const showScrollTop = ref(false)
const latestButtonTitle = computed(() => newMessageCount.value ? `${newMessageCount.value} 条新消息 · 返回最新消息` : '返回最新消息')
const adminRecallable = computed(() => im.currentSession?.type === 2 && Number(im.groupDetails.get(im.currentSessionId)?.memberRole || 0) > 0)
function protectedMessage(message: ImMessage): boolean {
  return String(message.is_need_read_receipt) === 'true' || String(message.is_delete_after_read) === 'true'
}
function forwardable(message: ImMessage): boolean { return canForward(message.msg_type) && !protectedMessage(message) }
async function locateSearchMessage(message: PersistedMessage) {
  globalSearchOpen.value = false
  const session = im.sessions.find(item => item.id === message.sessionId)
  const name = session?.name || message.to_name || message.from_name || '会话'
  im.openChat(message.sessionId, name, message.sessionType)
  await locateMessage(message.msg_id)
}
function openSearchSession(session: ChatSession) {
  globalSearchOpen.value = false
  im.selectSession(session.id)
}
function onGlobalSearchKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
  event.preventDefault()
  globalSearchOpen.value = true
}
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
      case 'contact': openSenderDetail(message); break
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
/** 通知/外部唤起带来的深链：query.msg 是要定位的消息。 */
function locateFromQuery(): void {
  const mid = String(route.query.msg || '')
  const sid = String(route.query.session || '')
  if (!mid || !sid) return
  // 已经在聊天页时不会有新的挂载，这里自己切会话。
  if (im.currentSessionId !== sid) {
    const nm = String(route.query.name || '')
    const tp = Number(route.query.type || 1)
    im.openChat(sid, nm || sid, tp)
  }
  // 去掉 msg 参数，避免离开再回来时重复定位；其余参数保留，维持原有深链行为。
  const query: Record<string, string> = { session: sid }
  if (route.query.name) query.name = String(route.query.name)
  if (route.query.type) query.type = String(route.query.type)
  void router.replace({ path: '/chat', query }).catch(() => {})
  void nextTick().then(() => locateMessage(mid))
}
watch(() => route.query.msg, () => { locateFromQuery() })

function onMessageScroll() {
  const element = msgList.value
  if (!element) return
  showScrollTop.value = element.scrollTop > 200
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
  showScrollTop.value = false
}
function scrollToTop() {
  msgList.value?.scrollTo({ top: 0, behavior: 'smooth' })
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
const cardModes = ref<Record<string, boolean>>({})
const burnModes = ref<Record<string, boolean>>({})
const receiptMode = computed({ get: () => receiptModes.value[composerKey.value] || false, set: value => { receiptModes.value[composerKey.value] = value } })
const cardMode = computed({ get: () => cardModes.value[composerKey.value] || false, set: value => { cardModes.value[composerKey.value] = value } })
const burnMode = computed({ get: () => burnModes.value[composerKey.value] || false, set: value => { burnModes.value[composerKey.value] = value } })
// 官方把这三个模式放在输入框上方的浮动条里，且按会话类型限制：单聊本身已有逐条
// 已读，所以「回执消息/回执卡片」只给群聊/部门；「无痕消息」只给单聊。
// 回执消息会在正文前加 U+200C，接收端进入可视区就自动回执；回执卡片要等点开。
const sessionType = computed(() => Number(im.currentSession?.type || 0))
const canUseReceipt = computed(() => sessionType.value === 2 || sessionType.value === 4)
const canUseBurn = computed(() => sessionType.value === 1)
const activeSpecialMode = computed(() =>
  receiptMode.value ? '回执消息' : cardMode.value ? '回执卡片' : burnMode.value ? '无痕消息' : '',
)
const specialModeNote = computed(() => {
  switch (activeSpecialMode.value) {
    case '回执消息': return '接收人看到消息就回执，仅支持文字'
    case '回执卡片': return '接收人点开后回执，仅支持文字'
    case '无痕消息': return '接收人打开后 30 秒销毁，仅支持文字'
    default: return ''
  }
})
function specialModeGuard(name: string): boolean {
  if (pendingAttachments.value.length) {
    actionError.value = `请先发送或移除附件后再使用${name}`
    return false
  }
  return true
}
function toggleReceiptMode() {
  if (!receiptMode.value && !specialModeGuard('回执消息')) return
  receiptMode.value = !receiptMode.value
  if (receiptMode.value) { cardMode.value = false; burnMode.value = false }
  actionError.value = ''
}
function toggleCardMode() {
  if (!cardMode.value && !specialModeGuard('回执卡片')) return
  cardMode.value = !cardMode.value
  if (cardMode.value) { receiptMode.value = false; burnMode.value = false }
  actionError.value = ''
}
function toggleBurnMode() {
  if (!burnMode.value && !specialModeGuard('无痕消息')) return
  burnMode.value = !burnMode.value
  if (burnMode.value) { receiptMode.value = false; cardMode.value = false }
  actionError.value = ''
}
function clearSpecialMode() {
  receiptModes.value[composerKey.value] = false
  cardModes.value[composerKey.value] = false
  burnModes.value[composerKey.value] = false
  actionError.value = ''
}
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
const composerHeight = ref(76)
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

/** 与 sendMedia 的判定一致：只有这 5 种后缀才算图片，其余按文件发送。 */
function isImageFile(file: File): boolean {
  const dot = file.name.lastIndexOf('.')
  return dot >= 0 && IMAGE_MSG_EXTS.has(file.name.slice(dot + 1).toLowerCase())
}

function addAttachments(files: File[]) {
  if (submitting.value || !im.currentSession || composerBlocked.value) return
  if (receiptMode.value || cardMode.value || burnMode.value) {
    actionError.value = '回执消息/回执卡片/无痕消息仅支持文字，请先取消该模式'
    return
  }
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
/** 搜索结果键盘选中的下标；输入焦点始终留在搜索框 */
const searchActive = ref(0)
const searchListEl = ref<HTMLElement | null>(null)
const historyOpen = ref(false)
const showLogs = ref(false)
const logScope = ref('')
/** 按来源筛选：全部 / 协议 / 登录 / console / 系统 */
const logScopes = computed(() => [...new Set(appLog.entries.map((e) => e.scope))])
const shownLogs = computed(() =>
  logScope.value ? appLog.entries.filter((e) => e.scope === logScope.value) : appLog.entries,
)
function logScopeCount(scope: string) {
  return appLog.entries.filter((e) => e.scope === scope).length
}
const drawerOpen = ref(false)
const drawerAllowed = ref(false)
/** 会话/联系人分栏宽度（可拖动 PaneResizer 调整） */
const sessionWidth = ref(300)
const layoutStyle = computed(() => ({
  gridTemplateColumns: `56px ${sessionWidth.value}px 6px 1fr${drawerOpen.value && drawerAllowed.value ? ' 320px' : ''}`,
}))
const groupSettingsOpen = ref(false)
/** 单聊里拉群弹窗 */
const groupChatOpen = ref(false)
/** 预置成员：当前单聊对象 */
const groupChatPreset = computed(() => {
  const s = im.currentSession
  return s && s.type === 1 ? [{ id: s.id, name: s.name }] : []
})
/** 建群成功：本地补会话并直接切到新群聊天，再刷新通讯录群列表 */
function onGroupChatCreated(group: { id: string; name: string }) {
  groupChatOpen.value = false
  im.openChat(group.id, group.name, FromType.GROUP)
  im.loadContacts()
}
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

// 折叠/展开、移除收进「更多」菜单，避免会话行里按钮过多导致误触。
const sessionMenu = ref<{ session: ChatSession; left: number; top: number } | null>(null)
function openSessionMenu(session: ChatSession, event: MouseEvent) {
  if (sessionMenu.value?.session.id === session.id) {
    closeSessionMenu()
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const width = sessionDetailKind(session) ? 168 : 132
  const height = sessionDetailKind(session) ? 152 : 118
  sessionMenu.value = {
    session,
    left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
  }
  window.addEventListener('resize', closeSessionMenu)
  window.addEventListener('scroll', closeSessionMenu, true)
  window.addEventListener('keydown', onSessionMenuKeydown)
}
function onSessionMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeSessionMenu()
}
function closeSessionMenu() {
  sessionMenu.value = null
  window.removeEventListener('resize', closeSessionMenu)
  window.removeEventListener('scroll', closeSessionMenu, true)
  window.removeEventListener('keydown', onSessionMenuKeydown)
}
function pinFromSessionMenu() {
  const session = sessionMenu.value?.session
  closeSessionMenu()
  if (session) void im.togglePinSession(session)
}
function foldFromSessionMenu() {
  const session = sessionMenu.value?.session
  closeSessionMenu()
  if (session) void im.toggleFoldSession(session)
}
function removeFromSessionMenu() {
  const session = sessionMenu.value?.session
  closeSessionMenu()
  if (session) im.removeSession(session.id)
}

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
  window.addEventListener('keydown', onGlobalSearchKey)
  const sid = String(route.query.session || '')
  if (sid) {
    const nm = String(route.query.name || '')
    const tp = Number(route.query.type || 1)
    im.openChat(sid, nm || sid, tp)
  }
  locateFromQuery()
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
  window.removeEventListener('keydown', onGlobalSearchKey)
  unlistenFocus?.()
  im.setChatActive(false)
  closeSessionMenu()
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
    showScrollTop.value = false
    replyThreadId.value = ''
    messageWindowEndId.value = ''
    highlightedMessageId.value = ''
    drawerOpen.value = false
    drawerAllowed.value = false
    const s = im.currentSession
    if (!s) return
    drawerAllowed.value = await im.ensureTeam(s)
    groupSettingsOpen.value = false
    groupChatOpen.value = false
    if (s.type === 2) void syncGroupGate(s.id)
  },
  { immediate: true },
)

function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchActive.value = 0
  const v = keyword.value
  searchTimer = setTimeout(() => im.searchAll(v), 250)
}

// 结果刷新后高亮回到第一位
watch(
  () => im.searchResults,
  () => {
    searchActive.value = 0
    void scrollSearchActive()
  },
)

/** 上下键移动搜索结果高亮，输入焦点始终留在搜索框 */
function onSearchArrow(event: KeyboardEvent, step: number) {
  // 输入法用上下键翻候选时不要抢按键
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  const total = im.searchResults.length
  if (!total) return
  const next = Math.min(total - 1, Math.max(0, searchActive.value + step))
  if (next === searchActive.value) return
  searchActive.value = next
  void scrollSearchActive()
}

async function scrollSearchActive() {
  await nextTick()
  const el = searchListEl.value?.children[searchActive.value] as HTMLElement | undefined
  el?.scrollIntoView({ block: 'nearest' })
}

function openDetail(c: ContactEntry) {
  router.push({
    path: `/contact/${c.kind}/${encodeURIComponent(c.id)}`,
    query: { name: c.name, desc: c.desc || '' },
  })
}

/** 会话对应的联系人详情类型：单聊/群聊/服务号才有详情页。 */
function sessionDetailKind(session: ChatSession): string {
  if (session.type === FromType.USER) return 'user'
  if (session.type === FromType.GROUP) return 'group'
  if (session.type === FromType.PUBLICACCOUNT) return 'serviceno'
  return ''
}

function openSessionDetail(session: ChatSession) {
  const kind = sessionDetailKind(session)
  closeSessionMenu()
  if (!kind) return
  router.push({
    path: `/contact/${kind}/${encodeURIComponent(session.id)}`,
    query: { name: session.name },
  })
}

/** 消息发送人可查看联系人详情：他人的用户消息（撤回/控制消息除外）。 */
function showSenderDetail(message: ImMessage): boolean {
  return (
    !im.isMine(message) &&
    Number(message.from_type) === FromType.USER &&
    !!message.from_id &&
    ![66, 67].includes(Number(message.msg_type))
  )
}

/** 群聊里给其他成员的消息显示头像，供双击发起单聊。 */
function showSenderAvatar(message: ImMessage): boolean {
  const type = Number(im.currentSession?.type || 0)
  return [2, 4, 8].includes(type) && showSenderDetail(message)
}

/** 双击群成员头像：打开（或新建）与他的单聊会话。 */
function startPrivateChat(message: ImMessage) {
  if (!message.from_id || message.from_id === authService.getCurrentUserId()) return
  im.openChat(message.from_id, message.from_name || message.from_id, FromType.USER)
  im.bumpSessionToTop(message.from_id)
}

/** 消息操作里的「详情」：查看该条消息发送人的联系人详情。 */
function openSenderDetail(message: ImMessage) {
  if (!message.from_id) return
  router.push({
    path: `/contact/user/${encodeURIComponent(message.from_id)}`,
    query: { name: message.from_name || '' },
  })
}

/** 回车默认打开搜索结果的第一位；结果还没回来时先补一次搜索 */
async function onSearchEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  const kw = keyword.value.trim()
  if (!kw) return
  event.preventDefault()
  if (searchTimer) clearTimeout(searchTimer)
  // 结果来自旧关键词或尚未返回时，先按当前关键词搜索一次
  if (im.searchKeyword.trim() !== kw || !im.searchResults.length) {
    if (im.searching) return
    await im.searchAll(kw)
  }
  const first = im.searchResults[searchActive.value] || im.searchResults[0]
  if (first) startChat(first)
}

function startChat(c: ContactEntry) {
  im.openChat(c.id, c.name, c.fromType)
  im.bumpSessionToTop(c.id)
  keyword.value = ''
  im.searchResults = []
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
  if ((receiptMode.value || cardMode.value || burnMode.value) && items.length) { actionError.value = '回执消息/回执卡片/无痕消息仅支持文字，请先移除附件或取消该模式'; return }
  const replyId = replyDraft.value?.msg_id
  const source = replyId ? im.messages.find(message => message.msg_id === replyId) : undefined
  if (source && [66, 67].includes(Number(source.msg_type))) { actionError.value = '原消息已撤回，请取消引用后发送'; return }
  submitting.value = true
  actionError.value = ''
  try {
    const atUserIds = (draftMentions.value[key] || []).map(item => item.id)
    const images = items.filter(item => isImageFile(item.file))
    const others = items.filter(item => !isImageFile(item.file))
    if (text && images.length) {
      // 与官方一致：文字和内嵌图片合成一条富文本，其余附件仍逐条发送。
      await im.sendTextWithImages(images.map(item => item.file), text, atUserIds, replyId)
      drafts.value[key] = ''
      delete replyDrafts.value[key]
      for (const item of images) removeAttachment(key, item.id)
      if (others.length) {
        await im.sendFiles(others.map(item => item.file), (_, index) => {
          removeAttachment(key, others[index].id)
          delete replyDrafts.value[key]
        }, undefined)
      }
    } else {
      if (text) {
        im.sendText(text, atUserIds, replyId, { receipt: receiptMode.value, receiptCard: cardMode.value, deleteAfterRead: burnMode.value })
        drafts.value[key] = ''
        delete replyDrafts.value[key]
        // 原版模式是一次性的：发送后输入框上方的浮动条自动消失
        receiptModes.value[key] = false
        cardModes.value[key] = false
        burnModes.value[key] = false
      }
      await im.sendFiles(items.map(item => item.file), (_, index) => {
        removeAttachment(key, items[index].id)
        delete replyDrafts.value[key]
      }, text ? undefined : replyId)
    }
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
  grid-template-columns: 56px 300px 6px 1fr;
  grid-template-rows: 100%;
  height: 100%;
}

.session-panel {
  background: var(--panel);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.panel-header {
  height: var(--titlebar-height);
  padding: 0 12px 0 26px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.panel-header h3 { font-size: 15px; font-weight: 600; }
.panel-search {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  font-size: 12px;
  border-radius: 6px;
  background: var(--surface);
}
.panel-search-global {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
}
.panel-search-global:hover { background: var(--hover); color: var(--text); }
.panel-search-global svg { width: 15px; height: 15px; }
.head-actions { display: flex; gap: 6px; }
.log-panel .panel-header { justify-content: space-between; padding: 0 10px 0 16px; }
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
.tab:hover { background: var(--hover); color: var(--text); }
.tab.on { color: var(--primary); box-shadow: inset 0 -2px 0 var(--primary); }

.searching { padding: 6px 16px; font-size: 11px; color: var(--text-muted); }
.search-entry { cursor: pointer; }
.search-entry.on { background: var(--selected); }
.s-avatar { cursor: pointer; }
.s-avatar:not(.photo) { background: var(--primary); }
.s-avatar.group:not(.photo) { background: #4a90d9; }
.s-avatar.photo { background: transparent; border: none; }
.s-name-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.search-entry .s-name { white-space: normal; overflow-wrap: anywhere; }
.s-company {
  display: inline-block; background: var(--chip-bg); color: var(--chip-text);
  border-radius: 4px; padding: 0 6px; font-size: 11px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.s-mobile { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

.session-list { flex: 1; overflow-y: auto; list-style: none; }
.session-list li {
  padding: 9px 12px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  border-bottom: none;
}
.session-list li:hover { background: var(--hover); }
.session-list li.active { background: var(--selected); }
.s-avatar {
  width: 36px; height: 36px; border-radius: 50%;
  color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; flex-shrink: 0;
}
.s-avatar.t2:not(.photo), .s-avatar.t4:not(.photo), .s-avatar.t8:not(.photo) { background: #4a90d9; }
.s-avatar.t5:not(.photo) { background: #7e8a97; }
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
.s-acts { display: flex; align-items: center; gap: 2px; }
.icon-btn {
  background: transparent;
  color: var(--text-muted);
  padding: 3px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}
.icon-btn:hover { background: var(--hover); color: var(--text); opacity: 1; }
.icon-btn svg { width: 15px; height: 15px; display: block; }
.icon-btn.more svg { width: 16px; height: 16px; }
.icon-btn.mute-on { opacity: 1; }
.s-avatar-wrap { position: relative; flex-shrink: 0; }
.avatar-badge {
  position: absolute;
  top: -4px;
  right: -7px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
  text-align: center;
  white-space: nowrap;
  pointer-events: none;
}

/* 会话「更多操作」菜单：Teleport 到 body，避免被列表滚动区域裁剪 */
.sess-menu-backdrop { position: fixed; inset: 0; z-index: 70; }
.sess-menu {
  position: fixed;
  min-width: 132px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-2);
}
.sess-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text);
  background: transparent;
  text-align: left;
}
.sess-menu button:hover { background: var(--hover); }
.sess-menu button.danger { color: var(--danger); }
.sess-menu svg { width: 15px; height: 15px; flex-shrink: 0; }
.empty { padding: 20px; text-align: center; color: var(--text-muted); }

.chat-main {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
  min-width: 0;
}
.chat-header {
  height: var(--titlebar-height);
  padding: 0 14px 0 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.chat-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.chat-title h3 { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--text-muted); font-size: 12px; }

.msg-area { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.msg-list { flex: 1; overflow-y: auto; padding: 16px 20px; }
.msg { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 14px; }
.msg.message-selectable { align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid transparent; }
.msg.message-selected { background: var(--primary-soft); border-color: var(--primary); }
.msg.message-selectable > input[type='checkbox'] { width: 18px; height: 18px; flex: 0 0 18px; padding: 0; margin: 0; accent-color: var(--primary); cursor: pointer; }
.msg.message-selectable .msg-avatar { margin-top: 0; }
.msg.message-selectable:focus-within { outline: 2px solid var(--primary); outline-offset: 1px; }
.msg.mine { justify-content: flex-end; }
.msg.mine.message-selectable > input { margin-right: auto; }
.msg.theirs { justify-content: flex-start; }
.msg-body { max-width: 95%; }
.msg.mine .msg-body { text-align: right; }
.msg-avatar {
  width: 34px; height: 34px; border-radius: 50%;
  margin-top: 15px; flex-shrink: 0; cursor: pointer;
  background: var(--primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600; user-select: none;
}
.msg-avatar.photo { background: transparent; }
.msg-avatar:hover { box-shadow: 0 0 0 2px var(--primary-soft); }
.msg-name { font-size: 11px; color: var(--text-muted); margin-bottom: 3px; }
.history-btn { margin-top: 10px; }

.composer {
  position: relative;
  flex-shrink: 0;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  gap: 6px;
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
  background: var(--surface-2);
  color: var(--text-muted);
  border-radius: 8px;
}
.attach:hover { background: var(--hover); color: var(--text); }
.composer-main { min-width: 0; }
.composer textarea {
  width: 100%;
  resize: none;
  height: 100px;
  min-height: 60px;
  max-height: 45vh;
  padding: 6px 0;
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
  background: var(--danger-soft); color: var(--danger);
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
  width: 360px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 40;
  box-shadow: -6px 0 20px rgba(0, 0, 0, 0.18);
}
.log-actions { display: flex; gap: 6px; }
.log-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--divider);
}
.log-filter {
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 11px;
}
.log-filter small { margin-left: 2px; opacity: 0.7; }
.log-filter:hover { background: var(--hover); }
.log-filter.active { background: var(--primary-soft); color: var(--primary); }
.logs {
  list-style: none;
  padding: 4px 8px 10px;
  font-size: 11px;
  color: var(--text-muted);
  overflow-y: auto;
  flex: 1;
}
.log-line { padding: 5px 4px; border-bottom: 1px solid var(--divider); word-break: break-all; }
.log-meta { display: block; font-size: 10px; color: var(--text-muted); opacity: 0.85; }
.log-text { display: block; margin-top: 1px; color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.log-line.log-warn .log-text { color: var(--warning-text); }
.log-line.log-error .log-text { color: var(--danger); }
.log-empty { padding: 16px 4px; text-align: center; }

.detail-btn { flex-shrink: 0; }
</style>
<style scoped>
.forward-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--border); }
.detail-btn { flex-shrink: 0; }
</style>

<style scoped>
.composer-tools { display: flex; align-items: center; gap: 4px; }
.composer-tool { background: transparent; color: var(--text-muted); width: 26px; height: 26px; padding: 0; font-size: 18px; line-height: 1; border-radius: 4px; }
.composer-tool:hover { background: var(--bg); color: var(--text); }
.composer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.composer-hint { margin-left: auto; }
.composer-actions span { font-size: 11px; color: var(--text-muted); }
.composer-tools { flex-shrink: 0; }
.composer-actions > button { min-width: 64px; height: 28px; padding: 0 12px; font-size: 12px; border-radius: 5px; }
.emoji-picker { position: relative; }
.emoji-dismiss { position: fixed; inset: 0; z-index: 49; }
.emoji-panel { position: absolute; bottom: 32px; left: 0; width: min(320px, 70vw); padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-2); z-index: 50; }
.emoji-heading { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.emoji-heading button { background: transparent; color: inherit; padding: 0 6px; }
.composer-emojis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; max-height: 280px; overflow-y: auto; }
.composer-emojis button { background: transparent; padding: 6px; font-size: 24px; }
.composer-emojis button:hover { background: var(--bg); }
</style>

<style scoped>
.session-at { color: var(--primary); }
.mention-messages { max-height: 220px; overflow: auto; padding: 10px 20px; border-bottom: 1px solid var(--border); }
.mention-messages p { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
.mention-messages button { display: block; width: 100%; text-align: left; margin: 5px 0; }
.chat-action-error { color: var(--warning-text); font-size: 12px; padding: 8px 20px; }
.reply-draft { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-left: 3px solid var(--primary); background: var(--chip-bg); color: var(--chip-text); font-size: 12px; margin-bottom: 8px; }
.reply-draft span { flex: 1; overflow-wrap: anywhere; }
.composer-actions .composer-mode {
  min-width: 0; height: 24px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 999px;
  background: transparent; color: var(--text-muted);
  font-size: 11px; line-height: 1;
}
.composer-actions .composer-mode:hover { background: var(--hover); color: var(--text); }
.composer-actions .composer-mode.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary-soft-text);
  font-weight: 500;
}
.composer-mode-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 6px;
  background: var(--info-soft); color: var(--info-text);
  font-size: 12px;
}
.composer-mode-bar .mode-tag { font-weight: 600; }
.composer-mode-bar .mode-note { flex: 1; }
.composer-mode-bar button { padding: 2px 8px; font-size: 11px; }
.message-located { background: var(--warning-soft); border-radius: 8px; outline: 2px solid var(--primary); }
/* 滚动辅助按钮：贴在消息区右侧滚动条旁，图标按钮不打断阅读 */
.jump-btn {
  position: absolute;
  right: 16px;
  z-index: 2;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-muted);
  opacity: 0.75;
}
.jump-btn:hover { opacity: 1; background: var(--hover); color: var(--text); }
.jump-btn svg { width: 16px; height: 16px; display: block; }
.jump-btn.to-top { top: 12px; }
.jump-btn.to-latest { bottom: 12px; }
.jump-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
</style>

<style scoped>
.active-mention-bar, .lookup-progress { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 20px; font-size: 12px; background: var(--warning-soft); color: var(--warning-text); }
</style>
