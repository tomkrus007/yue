<template>
  <Teleport to="body">
    <div v-if="open" class="gs-backdrop" @mousedown.self="close">
      <div ref="panelEl" class="gs-panel" role="dialog" aria-label="全局搜索">
        <div class="gs-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.2 4.2" />
          </svg>
          <input
            ref="inputEl"
            v-model="keyword"
            type="search"
            placeholder="搜索消息、文件名、会话、联系人"
            aria-label="搜索"
          />
          <span v-if="loading" class="gs-loading">搜索中…</span>
          <button type="button" class="gs-esc" aria-label="关闭搜索" @click="close">Esc</button>
        </div>

        <div class="gs-body">
          <p v-if="!kw" class="gs-empty">
            输入关键词搜索本地聊天记录（含附件文件名）、会话和联系人
            <span>⌘K 打开 · ↑↓ 选择 · Enter 打开</span>
          </p>
          <template v-else>
            <section v-if="sessionItems.length" class="gs-group">
              <h4>会话</h4>
              <button
                v-for="(item, index) in sessionItems"
                :key="item.key"
                :class="['gs-item', { on: activeIndex === index }]"
                @click="choose(item)"
                @mousemove="activeIndex = index"
              >
                <ContactAvatar class="gs-avatar" :id="item.avatarId || ''" :type="item.avatarType" :name="item.title" />
                <span class="gs-main">
                  <span class="gs-title">{{ item.title }}</span>
                  <span v-if="item.sub" class="gs-sub">{{ item.sub }}</span>
                </span>
              </button>
            </section>

            <section v-if="messageItems.length" class="gs-group">
              <h4>聊天记录</h4>
              <button
                v-for="(item, index) in messageItems"
                :key="item.key"
                :class="['gs-item', { on: activeIndex === messageStart + index }]"
                @click="choose(item)"
                @mousemove="activeIndex = messageStart + index"
              >
                <ContactAvatar class="gs-avatar" :id="item.avatarId || ''" :type="item.avatarType" :name="item.title" />
                <span class="gs-main">
                  <span class="gs-title-row">
                    <span class="gs-title">{{ item.title }}</span>
                    <span v-if="item.sub" class="gs-sub">{{ item.sub }}</span>
                    <span class="gs-time">{{ item.time }}</span>
                  </span>
                  <span class="gs-snippet">
                    <template v-if="item.snippet?.hit">{{ item.snippet.before }}<mark>{{ item.snippet.hit }}</mark>{{ item.snippet.after }}</template>
                    <template v-else>{{ item.snippet?.before }}</template>
                  </span>
                </span>
              </button>
            </section>

            <section v-if="contactItems.length" class="gs-group">
              <h4>联系人</h4>
              <button
                v-for="(item, index) in contactItems"
                :key="item.key"
                :class="['gs-item', { on: activeIndex === contactStart + index }]"
                @click="choose(item)"
                @mousemove="activeIndex = contactStart + index"
              >
                <ContactAvatar class="gs-avatar" :id="item.avatarId || ''" :type="item.avatarType" :name="item.title" />
                <span class="gs-main">
                  <span class="gs-title">{{ item.title }}</span>
                  <span v-if="item.sub" class="gs-sub">{{ item.sub }}</span>
                </span>
              </button>
            </section>
          </template>

          <div class="gs-history">
            <template v-if="im.historyBackfill.running">
              <p class="gs-history-title">正在拉取全部历史：{{ im.historyBackfill.done }}/{{ im.historyBackfill.total }} 个会话</p>
              <p v-if="scanned" class="gs-history-note">当前会话已扫描 {{ scanned }} 条，边拉取边建立索引。</p>
              <div class="gs-history-actions">
                <button class="secondary gs-small" @click="im.cancelBackfillAllHistory()">取消拉取</button>
              </div>
            </template>
            <template v-else-if="confirmOpen">
              <p class="gs-history-title">拉取全部历史后重新搜索</p>
              <ul class="gs-history-cost">
                <li>逐会话向服务端翻页，一次拉取几百到上千个请求，可能要几分钟。</li>
                <li>历史消息会写入本地数据库并建立索引，占用额外的磁盘和内存。</li>
                <li>过程中可以随时取消，已拉取的部分会保留并参与搜索。</li>
              </ul>
              <div class="gs-history-actions">
                <button class="secondary gs-small" @click="confirmOpen = false">取消</button>
                <button class="gs-small" @click="startBackfill">开始拉取</button>
              </div>
            </template>
            <template v-else-if="backfilled">
              <p class="gs-history-title">
                {{ im.historyBackfill.cancelled
                  ? '已取消拉取，已拉到的部分已参与搜索'
                  : (kw && messageHits.length ? '已拉取全部历史' : '已拉取全部历史，仍未找到匹配') }}
              </p>
              <p v-if="im.historyBackfill.failed || (!im.historyBackfill.cancelled && !(kw && messageHits.length))" class="gs-history-note">
                <template v-if="im.historyBackfill.failed">
                  有 {{ im.historyBackfill.failed }} 个会话拉取失败，可以再试一次。
                </template>
                <template v-else>
                  这条消息可能不在服务端历史里，例如已被撤回或超出服务端保留范围。
                </template>
              </p>
              <div class="gs-history-actions">
                <button class="secondary gs-small" @click="startBackfill">再拉一次</button>
              </div>
            </template>
            <template v-else>
              <p class="gs-history-title">
                {{ kw && !messageHits.length ? '本地已加载的记录里没有匹配' : '拉取全部历史' }}
              </p>
              <p class="gs-history-note">可以拉取服务端全部历史后再搜索。只补未完成的会话，已拉取的部分不会重复。</p>
              <div class="gs-history-actions">
                <button class="secondary gs-small" @click="confirmOpen = true">拉取全部历史</button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useImStore, type ChatSession } from '../stores/im'
import type { ContactEntry } from '../services/contact-client'
import type { PersistedMessage } from '../services/im/store'
import { messageText } from '../services/im/content'
import ContactAvatar from './ContactAvatar.vue'

interface Snippet {
  before: string
  hit: string
  after: string
}

interface SearchItem {
  key: string
  kind: 'session' | 'message' | 'contact'
  session?: ChatSession
  message?: PersistedMessage
  contact?: ContactEntry
  title: string
  sub?: string
  time?: string
  snippet?: Snippet
  avatarId?: string
  avatarType?: number
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  locate: [message: PersistedMessage]
  'open-session': [session: ChatSession]
  'open-contact': [contact: ContactEntry]
}>()

const im = useImStore()
const keyword = ref('')
const messageHits = ref<PersistedMessage[]>([])
const contactHits = ref<ContactEntry[]>([])
const loading = ref(false)
const activeIndex = ref(0)
const confirmOpen = ref(false)
/** 本次面板会话里是否已经跑过一次全量拉取（用于区分“没搜过”和“搜过还是没有”）。 */
const backfilled = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const kw = computed(() => keyword.value.trim().toLowerCase())

const sessionHits = computed(() => {
  if (!kw.value) return []
  return im.sessions.filter(session => session.name.toLowerCase().includes(kw.value)).slice(0, 6)
})

const messageStart = computed(() => sessionHits.value.length)
const contactStart = computed(() => messageStart.value + messageHits.value.length)

const items = computed<SearchItem[]>(() => {
  const list: SearchItem[] = []
  for (const session of sessionHits.value) {
    list.push({
      key: 's:' + session.id,
      kind: 'session',
      session,
      title: session.name,
      sub: im.sessionTypeLabel(session.type),
      avatarId: session.id,
      avatarType: session.type,
    })
  }
  for (const message of messageHits.value) {
    const session = im.sessions.find(item => item.id === message.sessionId)
    const name = session?.name || message.to_name || message.from_name || '会话'
    list.push({
      key: 'm:' + message.msg_id,
      kind: 'message',
      message,
      title: name,
      sub: message.from_name || '',
      time: formatTime(Number(message.send_time)),
      snippet: highlight(messageText(Number(message.msg_type), message.content) || '[无文本内容]'),
      avatarId: message.sessionId,
      avatarType: message.sessionType,
    })
  }
  for (const contact of contactHits.value) {
    list.push({
      key: 'c:' + contact.kind + ':' + contact.id,
      kind: 'contact',
      contact,
      title: contact.name,
      sub: [kindLabel(contact.kind), contact.dept].filter(Boolean).join(' · '),
      avatarId: contact.id,
      avatarType: contact.fromType,
    })
  }
  return list
})

const sessionItems = computed(() => items.value.slice(0, sessionHits.value.length))
const messageItems = computed(() =>
  items.value.slice(messageStart.value, messageStart.value + messageHits.value.length),
)
const contactItems = computed(() => items.value.slice(contactStart.value))

/** 当前正在扫描的会话进度（historyProgress 是单会话粒度）。 */
const scanned = computed(() => {
  const active = Object.values(im.historyProgress).find(progress => progress.running)
  return active?.scanned || 0
})

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      window.removeEventListener('keydown', onKeydown)
      if (timer) clearTimeout(timer)
      return
    }
    window.addEventListener('keydown', onKeydown)
    keyword.value = ''
    messageHits.value = []
    contactHits.value = []
    activeIndex.value = 0
    confirmOpen.value = false
    backfilled.value = false
    await nextTick()
    inputEl.value?.focus()
  },
  { immediate: true },
)

onUnmounted(() => window.removeEventListener('keydown', onKeydown))

watch(keyword, () => {
  if (timer) clearTimeout(timer)
  activeIndex.value = 0
  confirmOpen.value = false
  const text = keyword.value.trim()
  if (!text) {
    seq++
    messageHits.value = []
    contactHits.value = []
    loading.value = false
    return
  }
  loading.value = true
  timer = setTimeout(() => void runSearch(text), 180)
})

async function runSearch(text: string): Promise<void> {
  const run = ++seq
  loading.value = true
  const [messages, contacts] = await Promise.all([
    im.searchMessages(text),
    im.searchContacts(text),
  ])
  if (run !== seq) return
  messageHits.value = messages
  contactHits.value = contacts
  activeIndex.value = 0
  loading.value = false
}

function startBackfill(): void {
  confirmOpen.value = false
  backfilled.value = true
  const text = keyword.value.trim()
  void im.backfillAllHistory().finally(() => {
    if (keyword.value.trim() === text) void runSearch(text)
  })
}

watch(activeIndex, async () => {
  await nextTick()
  panelEl.value?.querySelector('.gs-item.on')?.scrollIntoView({ block: 'nearest' })
})

function onKeydown(event: KeyboardEvent): void {
  // 输入法用上下键翻候选时不要抢按键
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  // 焦点在按钮上时，Enter/方向键留给按钮自身处理
  if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    choose(items.value[activeIndex.value])
  }
}

function move(step: number): void {
  const total = items.value.length
  if (!total) return
  activeIndex.value = (activeIndex.value + step + total) % total
}

function choose(item: SearchItem | undefined): void {
  if (!item) return
  close()
  if (item.kind === 'session' && item.session) emit('open-session', item.session)
  else if (item.kind === 'message' && item.message) emit('locate', item.message)
  else if (item.kind === 'contact' && item.contact) emit('open-contact', item.contact)
}

function close(): void {
  emit('update:open', false)
}

function highlight(text: string): Snippet {
  const words = keyword.value.trim().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  for (const word of words) {
    const index = lower.indexOf(word.toLowerCase())
    if (index < 0) continue
    const start = Math.max(0, index - 24)
    const end = Math.min(text.length, index + word.length + 48)
    return {
      before: (start > 0 ? '…' : '') + text.slice(start, index),
      hit: text.slice(index, index + word.length),
      after: text.slice(index + word.length, end) + (end < text.length ? '…' : ''),
    }
  }
  return { before: text.length > 72 ? text.slice(0, 72) + '…' : text, hit: '', after: '' }
}

function formatTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function kindLabel(kind: ContactEntry['kind']): string {
  switch (kind) {
    case 'user': return '联系人'
    case 'group': return '群组'
    case 'org': return '部门'
    case 'serviceno': return '服务号'
    case 'robot': return '机器人'
    default: return ''
  }
}
</script>

<style scoped>
.gs-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 12vh 16px 16px;
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(2px);
}
.gs-panel {
  width: min(640px, 100%);
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-2);
  overflow: hidden;
}
.gs-search {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.gs-search svg {
  width: 17px;
  height: 17px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.gs-search input {
  flex: 1;
  min-width: 0;
  height: 30px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
}
.gs-search kbd,
.gs-esc {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
  font-family: inherit;
}
.gs-esc {
  background: transparent;
  line-height: 1.5;
}
.gs-esc:hover { background: var(--hover); color: var(--text); }
.gs-loading { color: var(--text-muted); font-size: 11px; flex-shrink: 0; }
.gs-body { overflow-y: auto; padding: 6px; }
.gs-group h4 {
  margin: 6px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}
.gs-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  color: var(--text);
}
.gs-item.on { background: var(--selected); }
.gs-item:hover { background: var(--hover); }
.gs-item.on:hover { background: var(--selected); }
.gs-avatar { width: 32px; height: 32px; flex-shrink: 0; font-size: 13px; }
.gs-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.gs-title-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.gs-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs-sub {
  color: var(--text-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs-time { margin-left: auto; color: var(--text-muted); font-size: 11px; flex-shrink: 0; }
.gs-snippet {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs-snippet mark {
  background: rgba(255, 193, 7, 0.35);
  color: var(--text);
  border-radius: 2px;
  padding: 0 1px;
}
.gs-empty {
  margin: 0;
  padding: 26px 18px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}
.gs-history {
  margin: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
}
.gs-history-title { margin: 0; font-size: 12px; font-weight: 600; }
.gs-history-note {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}
.gs-history-cost {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
}
.gs-history-actions {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.gs-small { padding: 4px 10px; font-size: 12px; }
.gs-empty span { display: block; margin-top: 6px; font-size: 11px; opacity: 0.75; }
</style>
