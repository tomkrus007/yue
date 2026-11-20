<template>
  <div class="reply-mask" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section ref="panel" role="dialog" aria-modal="true" aria-label="回复详情" tabindex="-1">
      <header><h3>回复详情</h3><button class="secondary small" @click="emit('close')">关闭</button></header>
      <p class="hint">{{ progress?.running ? `正在自动补全，已检查 ${progress.scanned} 条历史消息` : progress?.complete ? `已扫描当前时间范围内的历史，共 ${progress.scanned} 条` : '历史尚未全部扫描，可继续补全原文与关联回复' }} · 当前识别 {{ replies.length }} 条回复</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="progress?.error" class="error" role="alert">{{ progress.error }}</p>
      <button v-if="progress?.running" class="secondary small" @click="im.cancelHistoryScan(sessionId)">暂停补全</button>
      <button v-else class="secondary small" @click="load">{{ progress?.complete ? '重新扫描最新历史' : '继续自动补全' }}</button>
      <article v-if="source">
        <div class="meta">原消息 · {{ source.from_name }} · {{ fmtMsgTime(source.send_time) }}</div>
        <MessageGuard :message="source"><MessageContent :msg-type="Number(source.msg_type)" :content="source.content" :action-context="context(source)" @preview="!isProtected(source) && emit('preview', $event)" /></MessageGuard>
        <div class="actions"><button class="secondary small" @click="emit('locate', source.msg_id)">定位原消息</button><button v-if="canReply(source)" class="secondary small" @click="emit('reply', source)">回复</button></div>
      </article>
      <p v-else class="hint">原消息尚未加载或已不可访问。</p>
      <article v-for="message in replies.slice(0, visibleLimit)" :key="message.msg_id">
        <div class="meta">{{ message.from_name }} · {{ fmtMsgTime(message.send_time) }}</div>
        <MessageGuard :message="message"><MessageContent :msg-type="Number(message.msg_type)" :content="message.content" :action-context="context(message)" @preview="!isProtected(message) && emit('preview', $event)" /></MessageGuard>
        <div class="actions"><button class="secondary small" @click="emit('locate', message.msg_id)">定位消息</button><button v-if="canReply(message)" class="secondary small" @click="emit('reply', message)">回复</button></div>
      </article>
      <p v-if="!replies.length" class="hint">尚未加载到关联回复。</p>
      <button v-if="replies.length > visibleLimit" class="secondary small" @click="visibleLimit += 100">显示更多回复（还有 {{ replies.length - visibleLimit }} 条）</button>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useImStore } from '../stores/im'
import type { ImMessage } from '../services/im/im-client'
import { replyRoot } from '../services/im/interactions'
import { fmtMsgTime } from '../services/im/content'
import MessageContent from './MessageContent.vue'
import MessageGuard from './MessageGuard.vue'
const props = defineProps<{ messageId: string }>()
const emit = defineEmits<{ close: []; reply: [message: ImMessage]; locate: [id: string]; preview: [payload: { url: string; name: string }] }>()
const im = useImStore()
const error = ref('')
const sessionId = im.currentSessionId
const visibleLimit = ref(100)
const progress = computed(() => im.historyProgress[sessionId])
const panel = ref<HTMLElement | null>(null)
const rootId = computed(() => replyRoot(props.messageId, im.currentMessages))
const source = computed(() => im.currentMessages.find(message => message.msg_id === rootId.value))
const replies = computed(() => im.repliesFor(props.messageId))
function isProtected(message: ImMessage) { return String(message.is_delete_after_read) === 'true' || String(message.is_need_read_receipt) === 'true' }
function canReply(message: ImMessage) { return ![66, 67].includes(Number(message.msg_type)) && String(message.is_delete_after_read) !== 'true' }
function context(message: ImMessage) { return { message, messageId: message.msg_id, sessionId, sessionName: im.currentSession?.name, sessionType: im.currentSession?.type } }
async function load() {
  error.value = ''
  try { await im.completeReplyHistory(sessionId, !!progress.value?.complete) }
  catch { error.value = '加载失败，请检查连接后重试' }
}
onMounted(async () => {
  panel.value?.focus()
  try { await im.completeReplyHistory(sessionId) }
  catch { error.value = '原消息加载失败，可重试加载历史' }
})
onUnmounted(() => im.cancelHistoryScan(sessionId))
</script>
<style scoped>
.reply-mask { position: fixed; inset: 0; z-index: 70; background: var(--overlay); display: grid; place-items: center; }
section { width: min(680px, 90vw); max-height: 85vh; overflow: auto; background: var(--surface); padding: 20px; border-radius: 12px; }
header { display: flex; align-items: center; justify-content: space-between; }
article { padding: 16px 0; border-bottom: 1px solid var(--border); }
.meta, .hint { font-size: 12px; color: var(--text-muted); margin: 8px 0; }
.actions { display: flex; gap: 8px; margin-top: 10px; }
.error { font-size: 12px; color: var(--danger); }
</style>
