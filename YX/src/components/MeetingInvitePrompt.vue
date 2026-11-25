<template>
  <div v-if="current" class="invite-mask" @click.self="dismiss">
    <section class="invite-box" role="dialog" aria-modal="true" aria-label="视频会议邀请">
      <h3>视频会议邀请</h3>
      <p class="who">{{ current.fromName || '同事' }} 邀请你加入视频会议</p>
      <p class="title">🎥 {{ current.title }}</p>
      <p class="hint">{{ current.detail }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="secondary" :disabled="joining" @click="dismiss">稍后</button>
        <button :disabled="joining" @click="accept">{{ joining ? '正在加入…' : '加入会议' }}</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 收到腾讯会议邀请时的全局弹窗。
 *
 * 官方在 `MSG_TYPE.VIDEOCHAT` 且有 `appCode=linkMeeting` 时 publish
 * `OpenWemeetInviteView` 弹邀请窗；这里用同一个判断，只是把 UI 放在 Vue 侧。
 * 离线补发的旧邀请不弹，避免重连后一次弹出一堆；会议中也不弹。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { authService } from '../services/auth'
import { imClient, type ImEvent, type ImMessage } from '../services/im/im-client'
import { MsgType } from '../services/im/types'
import { parseVideoChatInvite, type MeetingInvite } from '../services/im/wemeet-invite'
import { useAuthStore } from '../stores/auth'
import { useWeMeetStore } from '../stores/wemeet'

interface PendingInvite extends MeetingInvite {
  msgId: string
  fromName: string
}

/** 同时在队列里最多保留的邀请数，避免异常刷屏 */
const MAX_PENDING = 3
/** 超过这个时长的邀请不弹（重连补拉历史时兜底，主要靠 `msg.offline`） */
const INVITE_TTL = 10 * 60_000
/** `seen` 只用于去重，超过阈值直接清空（重复弹出最多一次） */
const SEEN_LIMIT = 500

const wemeet = useWeMeetStore()
const auth = useAuthStore()
const queue = ref<PendingInvite[]>([])
const joining = ref(false)
const error = ref('')
const current = computed(() => queue.value[0] || null)

const seen = new Set<string>()
let off: (() => void) | null = null

function onImEvent(event: ImEvent) {
  if (event.type !== 'message') return
  const msg = event.data as ImMessage | undefined
  if (!msg?.msg_id || Number(msg.msg_type) !== MsgType.VIDEOCHAT) return
  if (msg.offline) return
  if (msg.send_time && Date.now() - msg.send_time > INVITE_TTL) return
  if (msg.from_id === authService.getCurrentUserId()) return
  if (seen.has(msg.msg_id)) return
  const invite = parseVideoChatInvite(msg.content)
  if (!invite) return
  seen.add(msg.msg_id)
  if (seen.size > SEEN_LIMIT) seen.clear()
  // 已在会议中时不再打扰，邀请仍留在会话里
  if (wemeet.inMeeting || queue.value.length >= MAX_PENDING) return
  queue.value.push({ ...invite, msgId: msg.msg_id, fromName: msg.from_name || '' })
}

onMounted(() => {
  off = imClient.on(onImEvent)
})

onUnmounted(() => {
  off?.()
  off = null
})

// 退出登录时清掉还没处理的邀请，下次登录不会残留
watch(
  () => auth.isLoggedIn,
  (logged) => {
    if (!logged) {
      queue.value = []
      error.value = ''
      seen.clear()
    }
  },
)

function dismiss() {
  queue.value = queue.value.slice(1)
  error.value = ''
}

async function accept() {
  const item = current.value
  if (!item || joining.value) return
  joining.value = true
  error.value = ''
  try {
    await wemeet.joinMeeting(item.code)
    dismiss()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加入会议失败'
  } finally {
    joining.value = false
  }
}
</script>

<style scoped>
.invite-mask {
  position: fixed;
  inset: 0;
  z-index: 72;
  display: grid;
  place-items: center;
  background: var(--overlay);
}
.invite-box {
  width: min(380px, calc(100vw - 48px));
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}
.invite-box h3 {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 14px;
}
.who { font-size: 13px; color: var(--text); }
.title { font-size: 14px; font-weight: 600; margin-top: 6px; }
.hint { font-size: 12px; color: var(--text-muted); margin-top: 6px; }
.error { font-size: 12px; color: var(--danger); margin-top: 10px; }
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
</style>
