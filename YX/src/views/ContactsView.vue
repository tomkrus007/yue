<template>
  <div class="app-layout">
    <SideNav active="contacts" @apps="appOpen = true" />

    <main class="contacts-main">
      <header class="contacts-header" data-tauri-drag-region="deep">
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

      <div class="contacts-body" :style="bodyStyle">
        <!-- 左栏：列表 -->
        <section class="list-col">
          <!-- 搜索结果 -->
          <template v-if="keyword.trim()">
            <div class="section-title">
              搜索结果（{{ im.searchResults.length }}）
              <span class="muted">点击查看详情</span>
            </div>
            <ul class="entry-list">
              <li
                v-for="c in im.searchResults"
                :key="c.kind + ':' + c.id"
                class="entry search-entry"
                :class="{ active: isActive(c) }"
                @click="select(c)"
              >
                <ContactAvatar
                  class="avatar"
                  :class="c.kind"
                  :id="c.id"
                  :type="c.fromType"
                  :name="c.name"
                />
                <div class="info">
                  <div class="name-row">
                    <span class="name">{{ c.name }}</span>
                    <span v-if="c.company" class="company" :title="c.company">{{ c.company }}</span>
                  </div>
                  <div v-if="kindLabel(c.kind) || c.dept" class="desc">
                    <span v-if="kindLabel(c.kind)" class="tag">{{ kindLabel(c.kind) }}</span>{{ c.dept || '' }}
                  </div>
                </div>
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
                :class="{ active: isActive(c) }"
                @click="select(c)"
              >
                <ContactAvatar
                  class="avatar user"
                  :id="c.id"
                  :type="c.fromType"
                  :name="c.name"
                />
                <div class="info">
                  <div class="name-row">
                    <span class="name">{{ c.name }}</span>
                    <span v-if="c.company" class="company" :title="c.company">{{ c.company }}</span>
                  </div>
                  <div v-if="c.dept" class="desc">{{ c.dept }}</div>
                </div>
              </li>
              <li v-if="!im.contactsLoading && friendsOnly.length === 0" class="empty">
                暂无好友
              </li>
            </ul>

            <div class="section-title">我的群组（{{ groupsOnly.length }}）</div>
            <ul class="entry-list">
              <li
                v-for="c in groupsOnly"
                :key="'g:' + c.id"
                class="entry"
                :class="{ active: isActive(c) }"
                @click="select(c)"
              >
                <ContactAvatar
                  class="avatar group"
                  :id="c.id"
                  :type="c.fromType"
                  :name="c.name"
                />
                <div class="info">
                  <div class="name">{{ c.name }}</div>
                </div>
              </li>
              <li v-if="groupsOnly.length === 0" class="empty">暂无群组</li>
            </ul>
          </template>
        </section>

        <!-- 拖动调整联系人分栏宽度 -->
        <PaneResizer v-model="listWidth" storage-key="contacts_list_width" :min="260" :max="640" :reserve="360" />

        <!-- 右栏：详情 -->
        <section class="detail-col">
          <ContactDetailPanel
            v-if="selected"
            :key="selected.kind + ':' + selected.id"
            :kind="selected.kind"
            :id="selected.id"
            :name="selected.name"
            @chat="onPanelChat"
            @group-left="onGroupLeft"
          />
          <div v-else class="detail-empty">选择联系人或群组查看详情</div>
        </section>
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
import SideNav from '../components/SideNav.vue'
import CreateGroupModal from '../components/CreateGroupModal.vue'
import ContactDetailPanel from '../components/ContactDetailPanel.vue'
import ContactAvatar from '../components/ContactAvatar.vue'
import PaneResizer from '../components/PaneResizer.vue'
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
/** 联系人分栏宽度（可拖动 PaneResizer 调整） */
const listWidth = ref(340)
const bodyStyle = computed(() => ({
  gridTemplateColumns: `${listWidth.value}px 6px 1fr`,
}))

const friendsOnly = computed(() => im.contacts.filter((c) => c.kind === 'user'))
const groupsOnly = computed(() => im.contacts.filter((c) => c.kind === 'group'))

/** 当前选中（右栏展示）的联系人/群组 */
const selected = ref<ContactEntry | null>(null)

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

function isActive(c: ContactEntry): boolean {
  return !!selected.value && selected.value.kind === c.kind && selected.value.id === c.id
}

function select(c: ContactEntry) {
  selected.value = c
}

function startChat(c: ContactEntry) {
  im.openChat(c.id, c.name, c.fromType)
  router.push('/chat')
}

/** 右栏详情里的「发消息」：优先用详情接口解析出的名称 */
function onPanelChat(name: string) {
  if (!selected.value) return
  startChat({ ...selected.value, name: name || selected.value.name })
}

/** 退群后：同步会话/列表并取消选中 */
function onGroupLeft() {
  if (selected.value) im.markLeftGroup(selected.value.id)
  selected.value = null
}

/** 建群成功：本端本地补会话并直接打开聊天，再刷新通讯录群列表（对齐官方 OpenChat 行为） */
function onGroupCreated(group: { id: string; name: string }) {
  createOpen.value = false
  im.openChat(group.id, group.name, FromType.GROUP)
  im.loadContacts()
  router.push('/chat')
}
</script>

<style scoped>
.app-layout { display: grid; grid-template-columns: 56px 1fr; height: 100%; }

.contacts-main { display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.contacts-header {
  background: var(--panel); padding: 0 24px 10px; border-bottom: 1px solid var(--border);
}
.contacts-header h2 { font-size: 15px; font-weight: 600; }
.header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: var(--titlebar-height); }
.primary-btn { padding: 6px 14px; font-size: 13px; }
.search-box { position: relative; display: flex; align-items: center; }
.search-box input { max-width: 520px; }
.spinner { margin-left: 10px; font-size: 12px; color: var(--text-muted); }

.contacts-body { flex: 1; display: grid; grid-template-columns: 340px 6px 1fr; overflow: hidden; }
.list-col { overflow-y: auto; padding: 16px 12px 24px 20px; }
.detail-col { overflow: hidden; min-width: 0; }

.section-title {
  display: flex; align-items: center; gap: 12px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--text-muted);
  margin: 8px 0 10px;
}
.section-title .muted { font-weight: 400; font-size: 12px; }
.entry-list { list-style: none; margin-bottom: 24px; }
.entry {
  display: flex; align-items: center; gap: 12px; cursor: pointer;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 14px; margin-bottom: 8px;
  transition: background 0.12s;
}
.entry:hover { background: var(--bg-subtle); }
.entry.active { background: var(--bg-subtle); border-color: var(--primary); }
.avatar {
  width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
  color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 15px;
}
.avatar:not(.photo) { background: var(--primary); }
.avatar.user:not(.photo) { background: var(--primary); }
.avatar.group:not(.photo) { background: #4a90d9; }
.avatar.photo { background: transparent; border: none; }
.info { flex: 1; min-width: 0; }
.name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.search-entry .name-row { flex-direction: column; align-items: flex-start; gap: 2px; }
.search-entry .name { overflow-wrap: anywhere; max-width: 100%; }
.name { font-size: 14px; font-weight: 500; cursor: pointer; }
.company {
  display: inline-block; background: var(--chip-bg); color: var(--chip-text);
  border-radius: 4px; padding: 0 6px; font-size: 11px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.tag {
  display: inline-block; background: var(--chip-bg); color: var(--chip-text);
  border-radius: 4px; padding: 0 6px; font-size: 11px; margin-right: 6px;
}
.small { padding: 5px 12px; font-size: 12px; }
.empty { text-align: center; color: var(--text-muted); padding: 20px; }
.detail-empty {
  height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: 13px;
}
</style>
