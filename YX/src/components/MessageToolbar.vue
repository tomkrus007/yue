<template>
  <button ref="trigger" class="message-more" title="消息操作" aria-label="消息操作" :aria-expanded="opened" @click.stop="toggle">···</button>
  <Teleport to="body">
    <div v-if="opened" class="message-toolbar-backdrop" @click.self="close" @keydown.esc="close">
      <section ref="panel" class="message-toolbar" :style="position" role="dialog" aria-label="消息操作" tabindex="-1">
        <div v-if="!protectedMessage" class="emoji-row">
          <button v-for="emoji in quickEmojis" :key="emoji" :class="{ chosen: reaction === emoji }" :aria-label="`回应 ${emoji}`" @click="react(emoji)" v-html="faceTextHtml(emoji)"></button>
          <button class="emoji-more" aria-label="更多表情" :aria-expanded="expanded" @click="expanded = !expanded">⊕</button>
        </div>
        <div v-if="expanded && !protectedMessage" class="emoji-grid">
          <button v-for="emoji in moreEmojis" :key="emoji" :aria-label="`回应 ${emoji}`" @click="react(emoji)" v-html="faceTextHtml(emoji)"></button>
        </div>
        <div class="action-row">
          <button v-for="action in visibleActions" :key="action.id" :disabled="action.id === 'forward' && !forwardable" @click="act(action.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="action.path" /></svg>
            <span>{{ action.id === 'favorite' ? favoriteStatus === 'unknown' ? '同步状态' : favorite ? '取消收藏' : '收藏' : action.label }}</span>
          </button>
        </div>
        <p>回应与收藏同步到服务端；删除仅在本机隐藏</p>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { faceTextHtml } from '../services/im/official-face'
const props = defineProps<{ reaction?: string; favorite: boolean; favoriteStatus?: 'saved' | 'unsaved' | 'unknown'; forwardable: boolean; recallable?: boolean; adminRecallable?: boolean; protectedMessage?: boolean; contactable?: boolean }>()
const emit = defineEmits<{ action: [name: string]; react: [emoji: string] }>()
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const opened = ref(false)
const expanded = ref(false)
const position = ref({ left: '0px', top: '0px' })
const quickEmojis = ['[微笑]', '[胜利]', '[咧嘴]', '[点赞]', '[呲牙]', '[ok]']
const moreEmojis = ['[爱心]', '[鼓掌]', '[礼花]', '[祈祷]', '[奋斗]', '[害羞]', '[色]', '[疑问]', '[惊呆了]', '[流泪]', '[苦笑]', '[满分]', '[对]', '[玫瑰]', '[咖啡]', '[握手]']
const actions = [
  { id: 'contact', label: '联系人', path: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21c.7-4 4-6 8-6s7.3 2 8 6' },
  { id: 'copy', label: '复制', path: 'M8 7V3h12v14h-4 M4 7h12v14H4Z' },
  { id: 'forward', label: '转发', path: 'm14 3 7 7-7 7v-5C7 12 4 16 3 20c0-9 3-14 11-14Z' },
  { id: 'quote', label: '引用', path: 'M21 11a9 9 0 0 1-9 9H8l-5 2 1-6a9 9 0 1 1 17-5Z M8 11h.01 M12 11h.01 M16 11h.01' },
  { id: 'delete', label: '删除', path: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7' },
  { id: 'favorite', label: '收藏', path: 'm12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z' },
  { id: 'more', label: '更多', path: 'M20 12v9H3V4h12 M9 10l4 4L22 3' },
  { id: 'recall', label: '撤回', path: 'm9 4-6 6 6 6 M3 10h10a7 7 0 0 1 7 7' },
  { id: 'adminRecall', label: '管理撤回', path: 'm9 4-6 6 6 6 M3 10h10a7 7 0 0 1 7 7' },
]
const visibleActions = computed(() => actions.filter(action => {
  if (action.id === 'contact') return !!props.contactable
  if (props.protectedMessage && !['delete', 'recall', 'adminRecall'].includes(action.id)) return false
  return action.id === 'recall' ? props.recallable : action.id === 'adminRecall' ? props.adminRecallable && !props.recallable : true
}))
async function toggle() {
  if (opened.value) return close()
  const rect = trigger.value!.getBoundingClientRect()
  const width = Math.min(280, window.innerWidth - 24)
  position.value = {
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    top: `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 260))}px`,
  }
  opened.value = true
  await nextTick()
  panel.value?.focus()
  window.addEventListener('resize', close)
}
function close() {
  opened.value = false
  expanded.value = false
  window.removeEventListener('resize', close)
  trigger.value?.focus()
}
function act(name: string) { emit('action', name === 'favorite' && props.favoriteStatus === 'unknown' ? 'favoriteSync' : name); close() }
function react(emoji: string) { emit('react', emoji); close() }
onUnmounted(() => window.removeEventListener('resize', close))
</script>

<style scoped>
.message-more { background: transparent; color: var(--text-muted); padding: 1px 4px; font-size: 16px; line-height: 18px; flex-shrink: 0; border-radius: 4px; }
.message-more:hover { background: var(--hover); color: var(--text); }
.message-toolbar-backdrop { position: fixed; inset: 0; z-index: 65; }
.message-toolbar { position: absolute; width: min(280px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow-y: auto; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-2); outline: none; }
.message-toolbar button { background: transparent; color: inherit; border-radius: 6px; padding: 5px 2px; }
.message-toolbar button:hover, .message-toolbar button.chosen { background: var(--hover); }
.emoji-row { display: grid; grid-template-columns: repeat(7, 1fr); padding: 8px 6px; gap: 2px; }
.emoji-row button { font-size: 20px; }
.emoji-row :deep(.official-face) { width: 20px; height: 20px; vertical-align: middle; }
.emoji-row .emoji-more { font-size: 26px; line-height: 1; }
.emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); padding: 0 6px 6px; }
.emoji-grid button { font-size: 18px; }
.emoji-grid :deep(.official-face) { width: 18px; height: 18px; vertical-align: middle; }
.action-row { display: flex; align-items: flex-start; border-top: 1px solid var(--border); padding: 8px 4px 2px; }
.action-row button { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 4px 1px; font-size: 10px; }
.action-row button span { max-width: 100%; text-align: center; line-height: 1.15; }
.action-row svg { width: 18px; height: 18px; flex-shrink: 0; }
.message-toolbar p { font-size: 10px; text-align: center; color: var(--text-muted); margin: 2px 0 6px; }
</style>
