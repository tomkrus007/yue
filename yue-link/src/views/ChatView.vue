<template>
  <div class="chat-layout">
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
      <div class="spacer"></div>
      <button class="nav-item logout" @click="onLogout" title="退出">
        <span class="icon">⏻</span>
      </button>
    </nav>

    <!-- 会话列表 / 历史聊天窗口 -->
    <aside class="session-panel">
      <div class="panel-header">
        <h3>消息</h3>
        <router-link to="/contacts" class="small secondary link-btn">通讯录</router-link>
      </div>

      <div class="session-search">
        <input
          v-model="keyword"
          placeholder="搜索联系人/群组（含未聊过的人）"
          @input="onSearch"
        />
      </div>

      <div class="conn-status">
        <span :class="['dot', im.connected ? 'on' : 'off']"></span>
        {{ im.connected ? (im.authed ? '已鉴权' : '连接中') : '未连接' }}
        <span v-if="im.searching" class="searching">搜索中…</span>
      </div>

      <!-- 搜索结果（含未聊过的人） -->
      <ul v-if="keyword.trim()" class="session-list">
        <li
          v-for="c in im.searchResults"
          :key="c.kind + ':' + c.id"
          class="search-entry"
        >
          <div class="s-avatar" :class="c.kind" @click="startChat(c)">
            {{ (c.name || '?').slice(0, 1) }}
          </div>
          <div class="s-info">
            <div class="s-name link" @click="openDetail(c)">{{ c.name }}</div>
            <div class="s-last">{{ kindLabel(c.kind) }}{{ c.desc ? ' · ' + c.desc : '' }}</div>
          </div>
          <button class="small" @click="startChat(c)">聊天</button>
        </li>
        <li v-if="im.searchResults.length === 0 && !im.searching" class="empty">
          没有匹配的联系人
        </li>
      </ul>

      <!-- 历史会话 -->
      <ul v-else class="session-list">
        <li
          v-for="s in im.sessions"
          :key="s.talk_with_id"
          :class="{ active: s.talk_with_id === im.currentSessionId }"
          @click="im.selectSession(s.talk_with_id)"
        >
          <div class="s-avatar">{{ (s.talk_with_name || '?').slice(0, 1) }}</div>
          <div class="s-info">
            <div class="s-name">
              {{ s.talk_with_name }}
              <span class="s-type">{{ im.sessionTypeLabel(s.talk_with_type) }}</span>
            </div>
            <div class="s-last">{{ briefOf(s.last_msg) }}</div>
          </div>
          <span v-if="s.unread > 0" class="badge">{{ s.unread }}</span>
        </li>
        <li v-if="im.sessions.length === 0" class="empty">
          暂无历史会话，去通讯录找人聊天
        </li>
      </ul>
    </aside>

    <!-- 聊天主区 -->
    <main class="chat-main">
      <template v-if="im.currentSession">
        <header class="chat-header">
          <h3>{{ im.currentSession.talk_with_name }}</h3>
          <span class="muted">{{ im.sessionTypeLabel(im.currentSession.talk_with_type) }}</span>
        </header>

        <div class="msg-list" ref="msgList">
          <div
            v-for="m in im.currentMessages"
            :key="m.msg_id"
            :class="['msg', isMine(m) ? 'mine' : 'theirs']"
          >
            <div class="msg-content">
              <div class="msg-name">{{ isMine(m) ? '我' : m.from_name }}</div>
              <div class="bubble">{{ contentOf(m) }}</div>
              <div class="msg-time">{{ fmtTime(m.send_time) }}</div>
            </div>
          </div>
          <div v-if="im.currentMessages.length === 0" class="empty-main">
            发送第一条消息开始对话
          </div>
        </div>

        <footer class="composer">
          <textarea
            v-model="draft"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            @keydown.enter.exact.prevent="onSend"
          ></textarea>
          <button @click="onSend" :disabled="im.sending || !draft.trim()">发送</button>
        </footer>
      </template>

      <div v-else class="empty-main full">
        <div class="placeholder">选择左侧会话，或点「+ 发起」开始聊天</div>
      </div>
    </main>

    <!-- 调试日志 -->
    <aside class="log-panel">
      <div class="panel-header"><h3>协议日志</h3></div>
      <ul class="logs">
        <li v-for="(l, i) in im.logs" :key="i">{{ l }}</li>
      </ul>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useImStore } from '../stores/im'
import type { ImMessage } from '../services/im/im-client'
import type { ContactEntry } from '../services/contact-client'

const auth = useAuthStore()
const im = useImStore()
const route = useRoute()
const router = useRouter()

const draft = ref('')
const msgList = ref<HTMLElement | null>(null)
const keyword = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

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
  im.start()
  if (im.contacts.length === 0 && !im.contactsLoading) {
    im.loadContacts()
  }
})

onUnmounted(() => {
  im.stop()
})

watch(
  () => im.currentMessages.length,
  async () => {
    await nextTick()
    if (msgList.value) msgList.value.scrollTop = msgList.value.scrollHeight
  },
)

function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  const v = keyword.value
  searchTimer = setTimeout(() => im.searchAll(v), 250)
}

function startChat(c: ContactEntry) {
  im.openChat(c.id, c.name, c.fromType)
  keyword.value = ''
  im.searchResults = []
}

function openDetail(c: ContactEntry) {
  router.push({
    path: `/contact/${c.kind}/${encodeURIComponent(c.id)}`,
    query: { name: c.name, desc: c.desc || '' },
  })
}

function onLogout() {
  im.stop()
  auth.logout()
  router.replace('/login')
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'user': return '好友'
    case 'group': return '群组'
    case 'org': return '部门'
    case 'servicenoo': return '服务号'
    case 'serviceno': return '服务号'
    default: return ''
  }
}

function onSend() {
  const text = draft.value.trim()
  if (!text) return
  im.sendText(text)
  draft.value = ''
}

function isMine(m: ImMessage): boolean {
  return m.from_id === localStorage.getItem('CurrentUserId')
}

function contentOf(m: ImMessage): string {
  if (typeof m.content === 'string') return m.content
  if (m.content && typeof m.content === 'object') return JSON.stringify(m.content)
  return ''
}

function briefOf(m?: ImMessage): string {
  if (!m) return ''
  const c = contentOf(m)
  return c.length > 30 ? c.slice(0, 30) + '…' : c
}

function fmtTime(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  return d.toLocaleString('zh-CN', { hour12: false })
}
</script>

<style scoped>
.chat-layout {
  display: grid;
  grid-template-columns: 56px 280px 1fr 240px;
  height: 100%;
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
}
.nav-item:hover { background: rgba(255,255,255,0.1); }
.nav-item.active { background: rgba(242,136,35,0.3); }
.nav-item.logout { background: transparent; }
.spacer { flex: 1; }

.session-panel, .log-panel {
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.log-panel { border-right: none; border-left: 1px solid var(--border); }
.panel-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.panel-header h3 { font-size: 15px; font-weight: 600; }
.small { padding: 4px 10px; font-size: 12px; }

.session-search {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.session-search input { padding: 6px 10px; font-size: 12px; }
.link-btn {
  padding: 4px 10px; font-size: 12px; background: #f0f0f0; color: var(--text);
  border-radius: 6px; text-decoration: none;
}
.link-btn:hover { background: #e0e0e0; }
.searching { margin-left: auto; font-size: 11px; color: var(--text-muted); }
.search-entry { cursor: default; }
.s-avatar { cursor: pointer; }
.s-avatar.group { background: #4a90d9; }
.s-name.link { cursor: pointer; }
.s-name.link:hover { color: var(--primary); text-decoration: underline; }

.conn-status {
  padding: 6px 16px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--border);
}
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.on { background: var(--success); }
.dot.off { background: #ccc; }

.session-list { flex: 1; overflow-y: auto; list-style: none; }
.session-list li {
  padding: 12px 16px;
  display: flex;
  align-items: center;
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
.s-info { flex: 1; min-width: 0; }
.s-name { font-size: 14px; font-weight: 500; }
.s-type { font-size: 11px; color: var(--text-muted); margin-left: 6px; }
.s-last { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge {
  background: var(--danger); color: #fff;
  font-size: 11px; padding: 1px 6px; border-radius: 10px;
}
.empty { padding: 20px; text-align: center; color: var(--text-muted); }

.chat-main {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}
.chat-header {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  align-items: center;
  gap: 12px;
}
.muted { color: var(--text-muted); font-size: 12px; }

.msg-list { flex: 1; overflow-y: auto; padding: 16px 20px; }
.msg { display: flex; margin-bottom: 14px; }
.msg.mine { justify-content: flex-end; }
.msg.theirs { justify-content: flex-start; }
.msg-content { max-width: 70%; }
.msg.mine .msg-content { text-align: right; }
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
.msg-time { font-size: 10px; color: var(--text-muted); margin-top: 3px; }

.composer {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.composer textarea {
  flex: 1;
  resize: none;
  height: 60px;
  padding: 8px 12px;
}

.empty-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.empty-main.full { background: var(--bg); }
.placeholder { text-align: center; }

.logs { list-style: none; padding: 8px; font-size: 11px; color: var(--text-muted); overflow-y: auto; flex: 1; }
.logs li { padding: 3px 4px; border-bottom: 1px solid #f5f5f5; word-break: break-all; }
</style>
