<template>
  <div v-if="open" class="modal-mask" @click.self="close" @keydown.esc="close">
    <div class="modal" role="dialog" aria-modal="true" aria-label="历史消息">
      <header class="modal-head">
        <div>
          <h3>历史消息</h3>
          <div class="sub">{{ session?.name }}</div>
        </div>
        <button class="secondary small" @click="close">关闭</button>
      </header>

      <div class="history-search">
        <input v-model="keyword" placeholder="搜索消息内容、附件名称或发送人" aria-label="搜索已加载历史消息" />
        <select v-model="kind" aria-label="按消息类型筛选">
          <option value="all">全部类型</option>
          <option value="text">文本与富文本</option>
          <option value="image">图片</option>
          <option value="file">文件</option>
          <option value="media">语音与视频</option>
          <option value="combine">聊天记录</option>
          <option value="mentions">@我／@所有人</option>
        </select>
      </div>
      <div class="history-range">
        <span>仅搜索当前会话已加载的 {{ messages.length }} 条消息，匹配 {{ filteredMessages.length }} 条。可继续加载更早的消息扩大范围。</span>
        <div class="more">
          <button
            class="secondary small"
            :disabled="im.loadingHistory || im.olderHistoryComplete(session?.id || '')"
            @click="loadOlder"
          >
            {{ im.loadingHistory ? '加载中…' : '加载更早的消息' }}
          </button>
          <span v-if="loadHint" class="muted" role="status">{{ loadHint }}</span>
        </div>
        <p v-if="loadError" class="load-error" role="alert">{{ loadError }}</p>
      </div>

      <div ref="listEl" class="modal-body">
        <div
          v-for="m in filteredMessages.slice(0, displayedLimit)"
          :key="m.msg_id"
          :class="['hmsg', im.isMine(m) ? 'mine' : 'theirs']"
        >
          <div class="hmeta">
            {{ im.isMine(m) ? '我' : m.from_name || '' }} ·
            {{ fmtMsgTime(m.send_time) }}
          </div>
          <div class="hbubble">
            <button v-if="m.reply_msg_id" class="reply-source" title="定位原消息" @click="locate(m.reply_msg_id)">
              引用：{{ replyBrief(m.reply_msg_id) }}
            </button>
            <MessageGuard :message="m"><MessageContent
              :msg-type="Number(m.msg_type)"
              :content="m.content"
              :action-context="{ message: m, messageId: m.msg_id, sessionId: session?.id, sessionName: session?.name, sessionType: session?.type }"
              @preview="!isProtected(m) && $emit('preview', $event)"
            /></MessageGuard>
          </div>
          <div class="history-actions">
            <button class="secondary small" @click="locate(m.msg_id)">定位消息</button>
            <button v-if="![0, 66, 67, 95, 97].includes(Number(m.msg_type)) && !isProtected(m)" class="secondary small" @click="reply(m)">回复</button>
          </div>
        </div>
        <button v-if="filteredMessages.length > displayedLimit" class="secondary small" @click="displayedLimit += 300">显示更多匹配消息（还有 {{ filteredMessages.length - displayedLimit }} 条）</button>
        <div v-if="!filteredMessages.length" class="empty">{{ messages.length ? '已加载的历史中没有匹配消息，可调整条件或加载更早的消息。' : '还没有消息，可从服务端加载历史。' }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useImStore } from '../stores/im'
import { combineDetails, fmtMsgTime, stripHtml, toPlainText } from '../services/im/content'
import type { ImMessage } from '../services/im/im-client'
import MessageContent from './MessageContent.vue'
import MessageGuard from './MessageGuard.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  preview: [payload: { url: string; name: string }]
  locate: [id: string]
  reply: [message: ImMessage]
}>()

const im = useImStore()
const listEl = ref<HTMLElement | null>(null)
const keyword = ref('')
const kind = ref('all')
const displayedLimit = ref(300)
const loadError = ref('')
const loadHint = ref('')

const session = computed(() => im.currentSession)
const messages = computed(() => im.currentMessages)
const kindTypes: Record<string, number[]> = {
  text: [1, 96, 99],
  image: [2],
  file: [3, 14, 25, 30],
  media: [4, 5, 6, 23],
  combine: [24],
}
function searchText(message: Pick<ImMessage, 'msg_type' | 'content' | 'from_name'>, depth = 0): string {
  const plain = `${message.from_name || ''} ${stripHtml(toPlainText(Number(message.msg_type), message.content))}`
  if (Number(message.msg_type) !== 24 || depth >= 5) return plain
  return plain + ' ' + combineDetails(message.content).map(row => searchText({
    msg_type: row.msgType, content: row.content, from_name: row.name,
  }, depth + 1)).join(' ')
}
const filteredMessages = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase()
  const types = kindTypes[kind.value]
  return messages.value.filter(message => (!types || types.includes(Number(message.msg_type))) &&
    (kind.value !== 'mentions' || im.isAtMe(message)) &&
    (!query || (isProtected(message) ? message.from_name : searchText(message)).toLocaleLowerCase().includes(query)))
})
function isProtected(message: ImMessage) { return String(message.is_delete_after_read) === 'true' || String(message.is_need_read_receipt) === 'true' }

function replyBrief(id: string): string {
  const source = messages.value.find(message => message.msg_id === id)
  if (source && isProtected(source)) return `${source.from_name}：[受保护消息]`
  return source ? `${source.from_name || '未知'}：${stripHtml(toPlainText(Number(source.msg_type), source.content)).slice(0, 160)}` : '原消息尚未加载，点击尝试定位'
}

function locate(id: string) {
  close()
  emit('locate', id)
}

function reply(message: ImMessage) {
  close()
  emit('reply', message)
}

function close() {
  emit('update:open', false)
}

async function loadOlder() {
  if (!session.value || im.loadingHistory) return
  const sessionId = session.value.id
  loadError.value = ''
  loadHint.value = ''
  try {
    const added = await im.loadOlderHistory(sessionId)
    if (session.value?.id !== sessionId) return
    loadHint.value = added ? `新增 ${added} 条消息` : im.olderHistoryComplete(sessionId) ? '更早历史已到末尾' : '此页已在缓存，可继续翻页扩大范围'
  } catch (error) {
    if (session.value?.id !== sessionId) return
    loadError.value = '加载历史失败：' + (error instanceof Error ? error.message : '未知错误').replace(/https?:\/\/[^\s)]+/g, '[请求地址]')
  }
}

watch(() => session.value?.id, () => {
  keyword.value = ''
  kind.value = 'all'
  loadError.value = ''
  loadHint.value = ''
})
watch([keyword, kind], () => { displayedLimit.value = 300; if (listEl.value) listEl.value.scrollTop = 0 })

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    await nextTick()
    if (listEl.value) listEl.value.scrollTop = keyword.value.trim() || kind.value !== 'all' ? 0 : listEl.value.scrollHeight
  },
)
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.modal {
  width: min(720px, 86vw);
  height: min(80vh, 760px);
  background: var(--panel);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
}
.modal-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal-head h3 { font-size: 15px; }
.sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.small { padding: 4px 10px; font-size: 12px; }
.history-search { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px 8px; }
.history-search input { flex: 1; min-width: 180px; padding: 8px; }
.history-search select { padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); }
.history-range { padding: 0 16px 12px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); }
.modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; background: var(--bg); }
.more { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; }
.muted { font-size: 12px; color: var(--text-muted); }
.load-error { margin-top: 8px; color: var(--danger); }
.hmsg { display: flex; flex-direction: column; margin-bottom: 12px; }
.hmsg.mine { align-items: flex-end; }
.hmsg.theirs { align-items: flex-start; }
.hmeta { font-size: 11px; color: var(--text-muted); margin-bottom: 3px; }
.hbubble {
  max-width: 78%;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid var(--border);
}
.hmsg.mine .hbubble { background: var(--bubble-me); border-color: transparent; }
.reply-source { display: block; max-width: 100%; margin-bottom: 8px; padding: 6px 8px; border-left: 3px solid var(--primary); background: #00000008; color: var(--text-muted); text-align: left; overflow-wrap: anywhere; font-size: 12px; }
.history-actions { display: flex; gap: 6px; margin-top: 5px; }
.empty { text-align: center; color: var(--text-muted); padding: 24px; }
</style>
