<template>
  <div class="message-envelope" :class="{ 'at-me': atMe, recalled, mine: im.isMine(message) }">
    <span v-if="atMe && !recalled" class="at-label">{{ allMention ? '@所有人' : '@我' }}</span>
    <div class="bubble-row">
      <div class="bubble">
        <button v-if="message.reply_msg_id && !recalled" class="reply-source" @click="emit('thread', message.reply_msg_id)">
          {{ quoteBrief }}
        </button>
        <MessageGuard :message="message">
          <MessageContent :msg-type="Number(message.msg_type)" :content="message.content" :action-context="{ message, messageId: message.msg_id, sessionId: im.currentSessionId, sessionName: im.currentSession?.name, sessionType: im.currentSession?.type }" @preview="!protectedMessage && emit('preview', $event)" />
        </MessageGuard>
        <button v-if="Number(message.msg_type) === 24 && !message.content?.msgs?.length" class="reload-details" :disabled="loadingDetails" @click="reloadDetails">{{ loadingDetails ? '正在获取…' : '从服务端历史重新获取明细' }}</button>
      </div>
      <MessageToolbar v-if="!selecting && !recalled" :favorite="favorite" :favorite-status="favoriteStatus" :reaction="myReaction" :forwardable="forwardable" :protected-message="protectedMessage" :recallable="im.isMine(message)" :admin-recallable="adminRecallable" @action="emit('action', $event)" @react="react" />
    </div>
    <div v-if="atMe && !selecting && !recalled && !protectedMessage" class="quick-reply">
      <button :disabled="!im.authed || blocked || pending" :class="{ chosen: received }" @click="react('[ok]')">👌 {{ pending ? '正在提交…' : '收到' }}</button>
      <button :disabled="blocked" @click="emit('reply', message)">回复</button>
    </div>
    <div v-if="reactions.length && !recalled" class="message-reactions">
      <button v-for="reaction in reactions" :key="reaction.userId + reaction.emoji" :class="{ mine: reaction.userId === myId }" :disabled="reaction.userId !== myId || !im.authed || blocked || pending" :title="reaction.userId === myId ? '点击取消自己的回应' : reaction.name" @click="react(reaction.emoji)">{{ emojiText(reaction.emoji) }} {{ reaction.name || '未知' }}</button>
    </div>
    <div class="message-state">
      <button v-if="replyCount" @click="emit('thread', message.msg_id)">{{ replyCount }} 条回复{{ im.historyProgress[im.currentSessionId]?.complete ? '' : '（可补全）' }}</button>
      <span v-if="favorite">☆ 已收藏</span>
      <details v-if="im.isMine(message) && !recalled && Object.keys(readers).length"><summary>{{ Object.keys(readers).length }} 人已读</summary>{{ Object.values(readers).join('、') }}</details>
      <span v-else-if="im.isMine(message) && !recalled">{{ deliveryLabel }}</span>
      <button v-if="im.isMine(message) && !recalled && (message.is_need_read_receipt || message.is_delete_after_read || message.is_need_send_read || Object.keys(readers).length)" @click="emit('receipt', message)">回执详情</button>
      <button v-if="message.__error && im.isMine(message) && !recalled && (!message.__delivery || message.__delivery.state === 'failed')" :disabled="!im.authed" @click="retry">重试</button>
    </div>
    <p v-if="error || im.interactionErrors[message.msg_id]" class="message-error" role="alert">{{ error || im.interactionErrors[message.msg_id] }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useImStore } from '../stores/im'
import { authService } from '../services/auth'
import type { ImMessage } from '../services/im/im-client'
import { messageText } from '../services/im/content'
import { replaceEmojiAliases } from '../services/im/emoji'
import MessageContent from './MessageContent.vue'
import MessageToolbar from './MessageToolbar.vue'
import MessageGuard from './MessageGuard.vue'
const props = defineProps<{ message: ImMessage; selecting: boolean; favorite: boolean; favoriteStatus?: 'saved' | 'unsaved' | 'unknown'; forwardable: boolean; adminRecallable?: boolean; blocked?: boolean }>()
const emit = defineEmits<{ action: [name: string]; reply: [message: ImMessage]; receipt: [message: ImMessage]; thread: [id: string]; preview: [payload: { url: string; name: string }] }>()
const im = useImStore()
const myId = authService.getCurrentUserId()
const error = ref('')
const loadingDetails = ref(false)
const recalled = computed(() => [66, 67].includes(Number(props.message.msg_type)))
const protectedMessage = computed(() => String(props.message.is_need_read_receipt) === 'true' || String(props.message.is_delete_after_read) === 'true')
const atMe = computed(() => im.isAtMe(props.message))
const allMention = computed(() => String(props.message.at_user_ids || '').split(',').includes('ALL'))
const reactions = computed(() => im.reactionsFor(props.message.msg_id))
const myReaction = computed(() => reactions.value.find(item => item.userId === myId)?.emoji)
const received = computed(() => reactions.value.some(item => item.userId === myId && item.emoji === '[ok]'))
const pending = computed(() => im.interactionPending(props.message.msg_id))
const replyCount = computed(() => im.repliesFor(props.message.msg_id).length)
const readers = computed(() => im.interactions.readers[props.message.msg_id] || {})
const deliveryLabel = computed(() => {
  const message = props.message
  if (message.__sent) return '已发送'
  if (message.__delivery?.state === 'queued') return '等待连接恢复'
  if (message.__delivery?.state === 'pending') return message.__delivery.attempts > 1 ? `正在重试（${message.__delivery.attempts}/3）` : '等待服务端确认'
  return message.__error ? '发送失败：' + message.__error : '已提交'
})
const quoteBrief = computed(() => {
  const source = im.replySource(props.message)
  if (!source) return '引用的原消息尚未加载 · 点击查看'
  if (String(source.is_delete_after_read) === 'true' || String(source.is_need_read_receipt) === 'true') return `${source.from_name}：[受保护消息]`
  return `${source.from_name || '未知'}：${messageText(Number(source.msg_type), source.content).slice(0, 160)}`
})
function emojiText(emoji: string) { return emoji === '[ok]' ? '👌' : replaceEmojiAliases(emoji) }
function react(emoji: string) {
  if (props.blocked || pending.value) return
  error.value = ''
  try { im.toggleReaction(props.message, emoji) }
  catch { error.value = '回应未发送，请检查连接后重试' }
}
function retry() {
  try { im.retryMessage(props.message) }
  catch { error.value = '重发失败，请检查连接后重试' }
}
async function reloadDetails() {
  loadingDetails.value = true
  error.value = ''
  try { await im.loadForwardDetails(props.message) }
  catch (cause) { error.value = (cause instanceof Error ? cause.message : '明细获取失败').replace(/https?:\/\/[^\s)]+/g, '[请求地址]') }
  finally { loadingDetails.value = false }
}
</script>
<style scoped>
.message-envelope { min-width: 100px; }
.bubble-row { display: flex; gap: 5px; align-items: center; min-width: 0; }
.mine .bubble-row { justify-content: flex-end; }
.bubble { padding: 10px 14px; background: var(--bubble-other, var(--panel)); border: 1px solid var(--border); border-radius: 10px; min-width: 0; max-width: 100%; font-size: 14px; text-align: left; }
.mine .bubble { background: var(--bubble-me); }
.at-me .bubble { border-color: #f0b64d; box-shadow: 0 0 0 1px #f0b64d33; }
.at-label { display: inline-block; color: #ad6500; background: #fff4d6; border-radius: 4px; padding: 1px 5px; font-size: 11px; margin-bottom: 4px; }
.reply-source { display: block; width: 100%; text-align: left; font-size: 12px; color: var(--text-muted); padding: 6px 9px; margin-bottom: 8px; border-left: 3px solid #b3bfce; background: #eef1f5; white-space: pre-wrap; overflow-wrap: anywhere; }
.quick-reply, .message-reactions, .message-state { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; font-size: 12px; align-items: center; }
.quick-reply button, .message-reactions button, .message-state button { background: #eef2f7; color: #35506b; padding: 3px 8px; border-radius: 5px; }
.quick-reply .chosen, .message-reactions .mine { background: #e2efff; color: #1668c7; }
.message-reactions button:disabled { opacity: 1; cursor: default; }
.message-state { color: var(--text-muted); }
.message-error { color: var(--danger); font-size: 12px; }
.reload-details { padding: 6px; background: transparent; color: #1668c7; font-size: 12px; }
.recalled .bubble { color: var(--text-muted); background: transparent; }
</style>
