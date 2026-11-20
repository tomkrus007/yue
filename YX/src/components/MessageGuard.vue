<template>
  <template v-if="!protectedMessage || im.isMine(message)"><slot /></template>
  <button v-else class="protected-message" :disabled="expired" @click="open">
    {{ expired ? '阅后即焚消息已销毁' : burn ? '阅后即焚 · 点击查看（30 秒）' : '回执消息 · 点击查看并确认已读' }}
  </button>
  <Teleport to="body">
    <div v-if="opened" class="read-mask" @click.self="close" @keydown.esc="close">
      <section ref="panel" role="dialog" aria-modal="true" aria-label="阅读消息" tabindex="-1">
        <header><strong>{{ burn ? `阅后即焚 · ${remaining} 秒` : im.localReadConfirmations[message.msg_id] ? '已确认阅读' : '阅读确认已提交，等待服务端确认' }}</strong><button @click="close">关闭</button></header>
        <p v-if="im.readConfirmationError(message.msg_id)" role="status">{{ im.readConfirmationError(message.msg_id) }} <button @click="retryConfirmation">重新提交确认</button></p>
        <slot />
      </section>
    </div>
  </Teleport>
  <p v-if="error" role="alert">{{ error }}</p>
</template>
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'
import type { ImMessage } from '../services/im/im-client'
import { useImStore } from '../stores/im'
const props = defineProps<{ message: ImMessage }>()
const im = useImStore()
const burn = computed(() => String(props.message.is_delete_after_read) === 'true')
const protectedMessage = computed(() => burn.value || String(props.message.is_need_read_receipt) === 'true')
const opened = ref(false)
const expired = ref(false)
const remaining = ref(30)
const error = ref('')
const panel = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
async function open() {
  if (opened.value || expired.value) return
  error.value = ''
  try {
    im.confirmMessageRead(props.message)
    opened.value = true
    if (burn.value) {
      const deadline = im.burnDeadlines[props.message.msg_id] || Date.now() + 30000
      timer = setInterval(() => {
        remaining.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
        if (!remaining.value) close()
      }, 250)
    }
    await nextTick()
    if (opened.value) panel.value?.focus()
  } catch { error.value = '阅读确认发送失败，请检查连接后重试' }
}
function retryConfirmation() {
  try { im.confirmMessageRead(props.message) }
  catch { error.value = '确认暂未发出，请检查连接后重试' }
}
function close() {
  if (!opened.value) return
  opened.value = false
  if (timer) clearInterval(timer)
  if (burn.value) { expired.value = true; im.burnMessage(props.message.msg_id) }
}
onUnmounted(close)
</script>
<style scoped>
.protected-message { background: var(--chip-bg); color: var(--chip-text); padding: 12px; border-radius: 8px; }
.read-mask { position: fixed; inset: 0; z-index: 100; background: var(--overlay); display: grid; place-items: center; }
.read-mask section { width: min(620px, 88vw); max-height: 80vh; overflow: auto; padding: 20px; background: var(--surface); border-radius: 12px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
p { color: var(--danger); font-size: 12px; }
</style>
