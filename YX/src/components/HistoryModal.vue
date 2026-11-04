<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal">
      <header class="modal-head">
        <div>
          <h3>历史消息</h3>
          <div class="sub">{{ session?.name }}</div>
        </div>
        <button class="secondary small" @click="close">关闭</button>
      </header>

      <div ref="listEl" class="modal-body">
        <div class="more">
          <button
            class="secondary small"
            :disabled="im.loadingHistory"
            @click="loadOlder"
          >
            {{ im.loadingHistory ? '加载中…' : '加载更早的消息' }}
          </button>
          <span class="muted">共 {{ messages.length }} 条已加载</span>
        </div>

        <div
          v-for="m in messages"
          :key="m.msg_id"
          :class="['hmsg', im.isMine(m) ? 'mine' : 'theirs']"
        >
          <div class="hmeta">
            {{ im.isMine(m) ? '我' : m.from_name || '' }} ·
            {{ fmtMsgTime(m.send_time) }}
          </div>
          <div class="hbubble">
            <MessageContent
              :msg-type="Number(m.msg_type)"
              :content="m.content"
              @preview="$emit('preview', $event)"
            />
          </div>
        </div>
        <div v-if="!messages.length" class="empty">还没有消息</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useImStore } from '../stores/im'
import { fmtMsgTime } from '../services/im/content'
import MessageContent from './MessageContent.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  preview: [payload: { url: string; name: string }]
}>()

const im = useImStore()
const listEl = ref<HTMLElement | null>(null)

const session = computed(() => im.currentSession)
const messages = computed(() => im.currentMessages)

function close() {
  emit('update:open', false)
}

async function loadOlder() {
  if (!session.value) return
  await im.loadOlderHistory(session.value.id)
  await nextTick()
}

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    await nextTick()
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
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
.modal-body { flex: 1; overflow-y: auto; padding: 12px 16px; background: var(--bg); }
.more { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.muted { font-size: 12px; color: var(--text-muted); }
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
.empty { text-align: center; color: var(--text-muted); padding: 24px; }
</style>