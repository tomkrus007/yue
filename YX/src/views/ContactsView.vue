<template>
  <div class="app-layout">
    <nav class="side-nav">
      <ConnectionStatus />
      <router-link to="/chat" class="nav-item" title="消息">
        <span class="icon">💬</span>
      </router-link>
      <router-link to="/contacts" class="nav-item active" title="通讯录">
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

    <main class="contacts-main">
      <header class="contacts-header">
        <div class="header-row">
          <h2>通讯录</h2>
          <button class="primary-btn" @click="createOpen = true">创建群组</button>
        </div>
        <div class="search-box">
          <input
            v-model="keyword"
            placeholder="输入中文名 / 账号搜索，如 陈 或 chen"
            @input="onInput"
          />
          <span v-if="im.searching" class="spinner">搜索中…</span>
        </div>
      </header>

      <div class="contacts-body">
        <!-- 搜索结果 -->
        <template v-if="keyword.trim()">
          <div class="section-title">
            搜索结果（{{ im.searchResults.length }}）
            <span class="muted">点击联系人进入聊天</span>
          </div>
          <ul class="entry-list">
            <li
              v-for="c in im.searchResults"
              :key="c.kind + ':' + c.id"
              class="entry search-entry"
              @click="startChat(c)"
            >
              <div
                class="avatar"
                :class="c.kind"
                :title="'和 ' + c.name + ' 聊天'"
              >
                {{ (c.name || '?').slice(0, 1) }}
              </div>
              <div class="info">
                <div class="name-row">
                  <span class="name">{{ c.name }}</span>
                  <span v-if="c.company" class="company" :title="c.company">{{ c.company }}</span>
                </div>
                <div v-if="kindLabel(c.kind) || c.dept" class="desc">
                  <span v-if="kindLabel(c.kind)" class="tag">{{ kindLabel(c.kind) }}</span>{{ c.dept || '' }}
                </div>
                <div v-if="c.mobile" class="mobile">{{ c.mobile }}</div>
              </div>
              <button class="small secondary detail-btn" @click.stop="openDetail(c)">详情</button>
            </li>
            <li v-if="im.searchResults.length === 0 && !im.searching" class="empty">
              没有匹配的联系人或群组
            </li>
          </ul>
        </template>

        <!-- 默认：好友 + 群组 -->
        <template v-else>
          <div class="section-title">
            我的好友（{{ friendsOnly.length }}）
            <button class="small secondary" @click="im.loadContacts()">刷新</button>
          </div>
          <ul class="entry-list">
            <li v-if="im.contactsLoading" class="empty">加载中…</li>
            <li
              v-for="c in friendsOnly"
              :key="'u:' + c.id"
              class="entry"
              @click="startChat(c)"
            >
              <div class="avatar user">{{ (c.name || '?').slice(0, 1) }}</div>
              <div class="info">
                <div class="name-row">
                  <span class="name">{{ c.name }}</span>
                  <span v-if="c.company" class="company" :title="c.company">{{ c.company }}</span>
                </div>
                <div v-if="c.dept" class="desc">{{ c.dept }}</div>
                <div v-if="c.mobile" class="mobile">{{ c.mobile }}</div>
              </div>
              <button class="small secondary detail-btn" @click.stop="openDetail(c)">详情</button>
            </li>
            <li v-if="!im.contactsLoading && friendsOnly.length === 0" class="empty">
              暂无好友
            </li>
          </ul>

          <div class="section-title">我的群组（{{ groupsOnly.length }}）</div>
          <ul class="entry-list">
            <li v-for="c in groupsOnly" :key="'g:' + c.id" class="entry" @click="startChat(c)">
              <div class="avatar group">{{ (c.name || '?').slice(0, 1) }}</div>
              <div class="info">
                <div class="name">{{ c.name }}</div>
              </div>
              <button class="small secondary detail-btn" @click.stop="openDetail(c)">详情</button>
            </li>
            <li v-if="groupsOnly.length === 0" class="empty">暂无群组</li>
          </ul>
        </template>
      </div>
    </main>
    <AppPanel v-model:open="appOpen" />
    <CreateGroupModal
      :open="createOpen"
      @close="createOpen = false"
      @created="onGroupCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppPanel from '../components/AppPanel.vue'
import ConnectionStatus from '../components/ConnectionStatus.vue'
import CreateGroupModal from '../components/CreateGroupModal.vue'
import { useAuthStore } from '../stores/auth'
import { useImStore } from '../stores/im'
import { FromType } from '../services/im/types'
import type { ContactEntry } from '../services/contact-client'

const auth = useAuthStore()
const im = useImStore()
const appOpen = ref(false)
const createOpen = ref(false)
const router = useRouter()
const keyword = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

const friendsOnly = computed(() => im.contacts.filter((c) => c.kind === 'user'))
const groupsOnly = computed(() => im.contacts.filter((c) => c.kind === 'group'))

onMounted(() => {
  if (!auth.isLoggedIn) {
    router.replace('/login')
    return
  }
  if (im.contacts.length === 0 && !im.contactsLoading) im.loadContacts()
})

function onInput() {
  if (timer) clearTimeout(timer)
  const v = keyword.value
  timer = setTimeout(() => im.searchAll(v), 250)
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'org': return '部门'
    case 'serviceno': return '服务号'
    default: return ''
  }
}

function openDetail(c: ContactEntry) {
  router.push({
    path: `/contact/${c.kind}/${encodeURIComponent(c.id)}`,
    query: { name: c.name, desc: c.desc || '' },
  })
}

function startChat(c: ContactEntry) {
  im.openChat(c.id, c.name, c.fromType)
  router.push('/chat')
}

/** 建群成功：本端本地补会话并直接打开聊天，再刷新通讯录群列表（对齐官方 OpenChat 行为） */
function onGroupCreated(group: { id: string; name: string }) {
  createOpen.value = false
  im.openChat(group.id, group.name, FromType.GROUP)
  im.loadContacts()
  router.push('/chat')
}

function onLogout() {
  im.resetLocal()
  auth.logout()
  router.replace('/login')
}
</script>

<style scoped>
.app-layout { display: grid; grid-template-columns: 56px 1fr; height: 100%; }
.side-nav {
  background: #2b2c2d; display: flex; flex-direction: column;
  align-items: center; padding: 12px 0; gap: 8px;
}

.nav-item {
  width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; color: #fff; font-size: 18px; background: transparent; padding: 0;
}
.nav-item:hover { background: rgba(255,255,255,0.1); }
.nav-item.active { background: rgba(242,136,35,0.3); }
.spacer { flex: 1; }

.contacts-main { display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.contacts-header {
  background: var(--panel); padding: 16px 24px; border-bottom: 1px solid var(--border);
}
.contacts-header h2 { font-size: 18px; margin-bottom: 0; }
.header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.primary-btn { padding: 6px 14px; font-size: 13px; }
.search-box { position: relative; display: flex; align-items: center; }
.search-box input { max-width: 520px; }
.spinner { margin-left: 10px; font-size: 12px; color: var(--text-muted); }

.contacts-body { flex: 1; overflow-y: auto; padding: 16px 24px; }
.section-title {
  display: flex; align-items: center; gap: 12px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--text-muted);
  margin: 8px 0 10px;
}
.section-title .muted { font-weight: 400; font-size: 12px; }
.entry-list { list-style: none; margin-bottom: 24px; }
.entry {
  display: flex; align-items: center; gap: 12px; cursor: pointer;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 14px; margin-bottom: 8px;
}
.avatar {
  width: 40px; height: 40px; border-radius: 8px; flex-shrink: 0;
  background: var(--primary); color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 15px;
}
.avatar.user { background: var(--primary); }
.avatar.group { background: #4a90d9; }
.info { flex: 1; min-width: 0; }
.name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.search-entry .name-row { flex-direction: column; align-items: flex-start; gap: 2px; }
.search-entry .name { overflow-wrap: anywhere; max-width: 100%; }
.name { font-size: 14px; font-weight: 500; cursor: pointer; }
.company {
  display: inline-block; background: #eef2f7; color: #5b6b7c;
  border-radius: 4px; padding: 0 6px; font-size: 11px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.mobile {
  font-size: 12px; color: var(--text-muted); margin-top: 2px;
  font-family: Menlo, monospace;
}
.tag {
  display: inline-block; background: #eef2f7; color: #5b6b7c;
  border-radius: 4px; padding: 0 6px; font-size: 11px; margin-right: 6px;
}
.small { padding: 5px 12px; font-size: 12px; }
.secondary { background: #f0f0f0; color: var(--text); }
.empty { text-align: center; color: var(--text-muted); padding: 20px; }
.detail-btn { flex-shrink: 0; }
</style>