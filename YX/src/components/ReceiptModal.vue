<template>
  <div class="receipt-mask" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section ref="panel" class="receipt-modal" role="dialog" aria-modal="true" aria-label="阅读回执：本机捕获名单" tabindex="-1">
      <header><div><h3>阅读回执 · 本机捕获名单</h3><p>{{ session.name }}</p></div><button class="secondary small" @click="emit('close')">关闭</button></header>
      <div class="receipt-summary">
        <p>已读依据本机收到的阅读确认，未收到回执不等于尚未阅读。</p>
        <p v-if="loading">正在捕获接收人名单…</p>
        <template v-else-if="snapshot">
          <p v-if="snapshot.timing === 'direct'">接收人来自这条单聊消息。</p>
          <p v-else>名单捕获时间：{{ displayTime(snapshot.capturedAt) }}。{{ snapshot.timing === 'send' ? '发送时发起成员查询，以查询返回的成员为准。' : '这是发送后的补采名单，无法还原发送时的完整成员。' }}</p>
          <p v-if="!snapshot.complete || snapshot.reason" class="warning" role="status">{{ snapshot.reason || '名单完整性尚未确认' }}</p>
          <p>本机捕获 {{ snapshot.members.length }} 名接收人<span v-if="snapshot.reportedGroupSize !== undefined">，接口报告群／部门 {{ snapshot.reportedGroupSize }} 人（含发送方等成员）</span>。</p>
        </template>
        <p v-if="error" class="warning" role="alert">{{ error }}</p>
        <button class="secondary small" :disabled="loading || refreshing" @click="refresh">{{ refreshing ? '正在查询…' : '查询当前参考名单' }}</button>
        <details v-if="candidate" class="current-members">
          <summary>当前参考名单（{{ candidate.members.length }} 人）</summary>
          <p>当前查询仅供比较，原捕获快照保持不变。</p>
          <p v-if="candidate.reason" class="warning">{{ candidate.reason }}</p>
          <p v-if="snapshot">相较快照，当前新增 {{ addedMembers }} 人，当前不在名单中 {{ removedMembers }} 人。</p>
          <ul><li v-for="member in candidate.members" :key="member.id">{{ member.name }} <small>{{ member.id }}</small></li></ul>
        </details>
      </div>
      <div class="receipt-filters">
        <button :class="{ active: tab === 'read' }" @click="tab = 'read'">已收到阅读确认（{{ received.length }}）</button>
        <button :class="{ active: tab === 'pending' }" @click="tab = 'pending'">尚未收到回执（{{ pending.length }}）</button>
        <input v-model="keyword" placeholder="搜索姓名或账号" aria-label="搜索回执名单" />
      </div>
      <ul class="receipt-people">
        <li v-for="member in filtered" :key="member.id">
          <div><strong>{{ member.name }}</strong><small>{{ member.id }}</small><span v-if="member.outside" class="outside">捕获名单外的阅读确认</span></div>
          <time v-if="tab === 'read' && readTimes?.[member.id]">{{ displayTime(readTimes[member.id]) }}</time>
        </li>
        <li v-if="!filtered.length" class="empty">{{ keyword ? '没有匹配的姓名或账号' : tab === 'read' ? '本机尚未收到阅读确认' : snapshot?.members.length ? '捕获名单中均已收到回执' : '接收人名单未知，无法列出尚未收到回执的人' }}</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ImMessage } from '../services/im/im-client'
import { useReceiptAudienceStore, type ReceiptAudience, type ReceiptMember } from '../stores/receipts'

const props = defineProps<{ message: ImMessage; readers: Record<string, string>; readTimes?: Record<string, number> }>()
const emit = defineEmits<{ close: [] }>()
const audience = useReceiptAudienceStore()
const panel = ref<HTMLElement | null>(null)
const snapshot = ref<ReceiptAudience>()
const candidate = ref<ReceiptAudience>()
const loading = ref(false)
const refreshing = ref(false)
const error = ref('')
const keyword = ref('')
const tab = ref<'read' | 'pending'>('read')
const session = computed(() => ({ id: props.message.to_id, name: props.message.to_name || props.message.to_id, type: Number(props.message.to_type) }))
const received = computed(() => {
  const known = new Map(snapshot.value?.members.map(member => [member.id, member]) || [])
  return Object.entries(props.readers).map(([id, name]) => ({ id, name: name || known.get(id)?.name || id, outside: !known.has(id) }))
})
const pending = computed(() => (snapshot.value?.members || []).filter(member => !Object.prototype.hasOwnProperty.call(props.readers, member.id)).map(member => ({ ...member, outside: false })))
const filtered = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase()
  return (tab.value === 'read' ? received.value : pending.value).filter(member => !query || `${member.name} ${member.id}`.toLocaleLowerCase().includes(query))
})
function difference(left: ReceiptMember[] = [], right: ReceiptMember[] = []): number {
  const ids = new Set(right.map(member => member.id))
  return left.filter(member => !ids.has(member.id)).length
}
const addedMembers = computed(() => difference(candidate.value?.members, snapshot.value?.members))
const removedMembers = computed(() => difference(snapshot.value?.members, candidate.value?.members))
function displayTime(value: number): string { return Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '时间未知' }
let generation = 0
watch(() => props.message.msg_id, async () => {
  const request = ++generation
  loading.value = true
  error.value = ''
  candidate.value = undefined
  refreshing.value = false
  keyword.value = ''
  snapshot.value = audience.get(props.message.msg_id)
  try {
    const result = await audience.capture(props.message, session.value)
    if (request === generation) snapshot.value = result
  } catch { if (request === generation) error.value = '捕获名单失败，可查询当前参考名单；已收到的阅读确认仍可查看' }
  finally { if (request === generation) loading.value = false }
}, { immediate: true })
async function refresh() {
  if (refreshing.value) return
  const request = generation
  refreshing.value = true
  error.value = ''
  try {
    const result = await audience.refresh(props.message, session.value)
    if (request === generation) candidate.value = result
  } catch { if (request === generation) error.value = '当前参考名单查询失败，请稍后重试' }
  finally { if (request === generation) refreshing.value = false }
}
onMounted(() => panel.value?.focus())
onUnmounted(() => { generation++ })
</script>

<style scoped>
.receipt-mask { position: fixed; inset: 0; z-index: 75; background: var(--overlay); display: grid; place-items: center; }
.receipt-modal { width: min(760px, 92vw); max-height: 85vh; background: var(--surface); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
header p { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
.receipt-summary { padding: 10px 20px; max-height: 35vh; overflow-y: auto; font-size: 12px; color: var(--text-muted); }
.receipt-summary p { margin-bottom: 6px; }
.warning { color: var(--warning-text); }
.current-members { margin-top: 8px; }
.current-members ul { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 6px; }
.current-members small { opacity: 0.7; }
.receipt-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 20px; border-block: 1px solid var(--border); }
.receipt-filters button { background: var(--bg); color: var(--text-muted); padding: 7px 10px; border-radius: 6px; }
.receipt-filters .active { color: var(--info-text); background: var(--info-soft); }
.receipt-filters input { flex: 1; min-width: 150px; padding: 8px; }
.receipt-people { overflow-y: auto; min-height: 100px; padding: 0 20px 14px; }
.receipt-people li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.receipt-people small { display: block; font-size: 11px; color: var(--text-muted); }
.receipt-people strong { font-size: 14px; }
.receipt-people time { font-size: 12px; color: var(--text-muted); }
.outside { font-size: 11px; color: var(--warning-text); }
.receipt-people .empty { color: var(--text-muted); font-size: 13px; justify-content: center; padding: 24px 0; }
.small { padding: 5px 10px; }
</style>
