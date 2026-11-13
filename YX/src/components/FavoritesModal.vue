<template>
  <div class="modal-mask" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section class="favorites-modal" role="dialog" aria-modal="true" aria-label="我的收藏" tabindex="-1">
      <header><h3>我的收藏</h3><button class="secondary small" @click="emit('close')">关闭</button></header>
      <form class="filters" @submit.prevent="search">
        <input ref="searchInput" v-model="keyword" placeholder="搜索收藏" aria-label="搜索收藏" />
        <select v-model="contentTypes" aria-label="收藏类型" @change="search">
          <option value="">全部类型</option><option value="1">文字</option><option value="3">图片</option><option value="6">文件</option><option value="5">链接</option>
        </select>
        <button>搜索</button><button type="button" :disabled="favorites.loading" @click="refresh">{{ favorites.loading ? '同步中…' : '同步' }}</button>
      </form>
      <p v-if="favorites.error" class="error" role="alert">{{ favorites.error }}</p>
      <p class="sync-status">{{ favorites.complete ? `已同步全部收藏 · 共 ${favorites.items.length} 条` : '尚未完成全量同步；不会据此清除聊天收藏标记' }}</p>
      <div class="favorites-list">
        <article v-for="item in items" :key="item.itemId">
          <div class="favorite-meta"><span>{{ item.sourceDisplayName || item.sourceName }} · {{ fmtMsgTime(item.createdDate ? new Date(item.createdDate).getTime() : 0) }}</span><button class="secondary small" :disabled="favorites.pending[item.itemId]" @click="remove(item)">{{ favorites.pending[item.itemId] ? '正在取消…' : '取消收藏' }}</button></div>
          <MessageContent :msg-type="favoriteMessageType(item.contentType)" :content="favoriteContent(item)" @preview="emit('preview', $event)" />
          <button class="secondary small locate-button" @click="locate(item)">定位原消息</button>
          <div v-if="locatingId === item.itemId" class="location-options">
            <p role="status">{{ locationHint }}</p>
            <button v-for="message in candidates" :key="message.sessionType + '|' + message.sessionId + '|' + message.msg_id" class="secondary small" @click="choose(message)">{{ message.sessionName || message.sessionId }} · {{ message.from_name }} · {{ fmtMsgTime(message.send_time) }}</button>
          </div>
        </article>
        <p v-if="!items.length && !favorites.loading" class="empty">{{ favorites.complete ? '没有匹配的收藏' : '同步完成后可查看全部收藏' }}</p>
        <button v-if="shown < filtered.length" class="secondary more" @click="shown += 30">显示更多（{{ filtered.length - shown }}）</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import MessageContent from './MessageContent.vue'
import { fmtMsgTime } from '../services/im/content'
import { favoriteContent, favoriteMessageType, favoriteMessageLocations, type Favorite, type FavoriteMessageLocation } from '../services/im/favorites'
import { useFavoritesStore } from '../stores/favorites'

const props = withDefaults(defineProps<{ messages?: FavoriteMessageLocation[] }>(), { messages: () => [] })
const emit = defineEmits<{
  close: []
  preview: [payload: { url: string; name: string }]
  removed: [itemId: string]
  locate: [location: { messageId: string; sessionId: string; sessionType: number; sessionName: string }]
}>()
const favorites = useFavoritesStore()
const searchInput = ref<HTMLInputElement | null>(null)
const keyword = ref('')
const contentTypes = ref('')
const shown = ref(30)
const locatingId = ref('')
const locationHint = ref('')
const candidates = ref<FavoriteMessageLocation[]>([])
const filtered = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase()
  return favorites.items.filter(item => (!contentTypes.value || Number(item.contentType) === Number(contentTypes.value)) &&
    (!query || [item.sourceName, item.sourceDisplayName, item.keyword, typeof item.content === 'string' ? item.content : JSON.stringify(item.content)].some(text => String(text || '').toLocaleLowerCase().includes(query))))
})
const items = computed(() => filtered.value.slice(0, shown.value))
async function refresh() { try { await favorites.sync() } catch { /* store 保留快照并展示错误。 */ } }
function search() { shown.value = 30; locationHint.value = ''; locatingId.value = ''; candidates.value = [] }
async function remove(item: Favorite) {
  try { await favorites.remove(item.itemId); emit('removed', item.itemId) } catch { /* store 展示错误。 */ }
}
function choose(location: FavoriteMessageLocation) {
  emit('locate', { messageId: location.msg_id, sessionId: location.sessionId, sessionType: location.sessionType, sessionName: location.sessionName || '' })
}
function locate(item: Favorite) {
  locatingId.value = item.itemId
  candidates.value = favoriteMessageLocations(item, props.messages)
  if (candidates.value.length === 1) { choose(candidates.value[0]); return }
  locationHint.value = candidates.value.length
    ? `找到 ${candidates.value.length} 条相同内容，请选择原消息，不会自动打开第一条。`
    : '当前已加载消息中未找到对应原消息。可先加载目标会话历史，再回到收藏重试定位。'
}
onMounted(() => { searchInput.value?.focus(); void refresh() })
</script>

<style scoped>
.modal-mask { position: fixed; inset: 0; z-index: 60; background: #0005; display: flex; align-items: center; justify-content: center; }
.favorites-modal { width: min(760px, 90vw); height: min(80vh, 800px); display: flex; flex-direction: column; background: var(--panel); border-radius: 12px; overflow: hidden; }
header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.filters { display: flex; gap: 8px; padding: 12px 20px; }
.filters input { flex: 1; min-width: 0; }
.filters input, .filters select { padding: 8px; border: 1px solid var(--border); border-radius: 6px; }
.favorites-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 20px 20px; }
article { padding: 14px 0; border-bottom: 1px solid var(--border); }
.favorite-meta { display: flex; justify-content: space-between; gap: 12px; align-items: center; font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }
.small { padding: 4px 8px; font-size: 12px; }
.error { color: var(--danger); margin: 0 20px 12px; }
.empty { text-align: center; padding: 32px; color: var(--text-muted); }
.sync-status { margin: 0 20px 12px; color: var(--text-muted); font-size: 12px; }
.locate-button { margin-top: 10px; }
.location-options { font-size: 12px; color: var(--text-muted); margin-top: 8px; }
.location-options button { display: block; margin-top: 6px; }
.more { margin: 16px auto; display: block; }
</style>
