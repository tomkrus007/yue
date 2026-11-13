<template>
  <div class="forward-mask" @click.self="close">
    <section class="forward-dialog" role="dialog" aria-modal="true" aria-label="转发消息">
      <header><h3>{{ combine ? '合并转发' : '逐一转发' }} · {{ pending.length }} 条消息</h3><button class="secondary small" @click="close">关闭</button></header>
      <p>选择接收人或群组，文件沿用原附件，无需重新上传。</p>
      <fieldset class="forward-mode" :disabled="started">
        <legend>转发方式</legend>
        <label :class="{ active: !combine }"><input v-model="combine" type="radio" :value="false" /><span>逐一转发</span></label>
        <label :class="{ active: combine }"><input v-model="combine" type="radio" :value="true" /><span>合并转发<small>聊天记录</small></span></label>
      </fieldset>
      <input v-model="keyword" placeholder="搜索会话、联系人或群组" aria-label="搜索转发接收人" />
      <div v-if="selectedTargets.length" class="selected-targets">
        <div class="selected-heading">已选 {{ selectedTargets.length }} 个接收人</div>
        <div class="selected-list">
          <div v-for="t in selectedTargets" :key="targetKey(t)" class="selected-chip">
            <div class="target-info">
              <span class="target-name" :title="t.name">{{ t.name }}</span>
              <small v-if="t.type === 1" class="target-meta">{{ t.company || '子公司未提供' }} · {{ t.dept || '组织未提供' }}</small>
            </div>
            <button class="remove-target" :disabled="started" :aria-label="`移除${t.name}`" @click="removeTarget(t)">×</button>
          </div>
        </div>
      </div>
      <div class="targets">
        <label
          v-for="t in targets"
          :key="`${t.type}|${t.id}`"
          :class="['target-row', { chosen: selected.includes(targetKey(t)), locked: started }]"
        >
          <input v-model="selected" type="checkbox" :value="`${t.type}|${t.id}`" :disabled="started" />
          <span :class="['target-avatar', { group: t.type !== 1 }]" aria-hidden="true">{{ t.type === 1 ? t.name.slice(0, 1) : '群' }}</span>
          <span class="target-info">
            <span class="target-name" :title="t.name">{{ t.name }}</span>
            <small v-if="t.type === 1" class="target-meta">
              <span :title="t.company">{{ t.company || '子公司未提供' }}</span>
              <span :title="t.dept">{{ t.dept || '组织未提供' }}</span>
            </small>
          </span>
          <small class="target-type">{{ im.sessionTypeLabel(t.type) }}</small>
        </label>
        <p v-if="searching">正在搜索联系人…</p>
        <p v-else-if="!targets.length">没有匹配的接收人</p>
      </div>
      <div class="preview"><div v-for="m in pending" :key="m.msg_id">{{ m.from_name }}：{{ toPlainText(m.msg_type, m.content) }}</div></div>
      <p v-if="combine" class="hint">较大的记录会按原版大小限制拆为多条聊天记录；单条超限时可切换逐一转发。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="done">已提交发送 {{ done }} 次</p>
      <footer><button :disabled="!selectedTargets.length || !im.authed || busy || !pending.length" @click="send">{{ busy ? '发送中…' : started ? '重试剩余转发' : `确认转发给 ${selectedTargets.length} 个接收人` }}</button></footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { contactService, type ContactEntry } from '../services/contact-client'
import { splitForwardBatches } from '../services/im/forwarding'
import { useImStore } from '../stores/im'
import type { ImMessage } from '../services/im/im-client'
import { toPlainText } from '../services/im/content'
const props = defineProps<{ messages: ImMessage[]; combine: boolean }>()
const emit = defineEmits<{ close: []; sent: [] }>()
const im = useImStore()
const combine = ref(props.combine)
const pending = ref([...props.messages])
const keyword = ref('')
interface ForwardTarget {
  id: string
  name: string
  type: number
  company?: string
  dept?: string
}
const selected = ref<string[]>([])
const jobs = ref<{ receiver: ForwardTarget; messages: ImMessage[] }[]>([])
function targetKey(t: ForwardTarget) { return `${t.type}|${t.id}` }
function removeTarget(t: ForwardTarget) {
  if (!started.value) selected.value = selected.value.filter(key => key !== targetKey(t))
}
const error = ref('')
const busy = ref(false)
const started = ref(false)
const done = ref(0)
const searchResults = ref<ContactEntry[]>([])
const searching = ref(false)
// 已选的目录用户跨搜索保留，避免更改关键词后无法确认转发。
const directoryTargets = ref<ContactEntry[]>([])
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (value) => {
  const seq = ++searchSeq
  clearTimeout(searchTimer)
  searchResults.value = []
  const query = value.trim()
  searching.value = !!query
  if (!query) return
  searchTimer = setTimeout(async () => {
    try {
      const results = await contactService.searchEntries(query, im.friends, im.groups)
      if (seq !== searchSeq) return
      searchResults.value = results
      const entries = new Map(directoryTargets.value.map(c => [`${c.fromType}|${c.id}`, c]))
      for (const c of results) entries.set(`${c.fromType}|${c.id}`, c)
      directoryTargets.value = [...entries.values()]
    } catch {
      if (seq === searchSeq) error.value = '联系人搜索失败，请稍后重试'
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }, 250)
})
onUnmounted(() => { clearTimeout(searchTimer); searchSeq += 1 })
const allTargets = computed(() => {
  const map = new Map<string, ForwardTarget>()
  for (const s of im.sessions) {
    if ([1, 2, 4, 8].includes(s.type)) map.set(targetKey(s), { ...s })
  }
  for (const c of [...im.contacts, ...directoryTargets.value]) {
    if (c.fromType !== 1 && c.fromType !== 2) continue
    const key = `${c.fromType}|${c.id}`
    const prev = map.get(key)
    map.set(key, {
      id: c.id, name: c.name && c.name !== c.id ? c.name : prev?.name || c.id,
      type: c.fromType, company: c.company || prev?.company, dept: c.dept || prev?.dept,
    })
  }
  return [...map.values()]
})
// 已有会话可能没有通讯录详情；为其补齐子公司、组织信息。
const detailRequested = new Set<string>()
let disposed = false
onUnmounted(() => { disposed = true })
watch(allTargets, async (list) => {
  const ids = list.filter(t => t.type === 1 && (!t.company || !t.dept) && !detailRequested.has(t.id)).map(t => t.id)
  if (!ids.length) return
  ids.forEach(id => detailRequested.add(id))
  try {
    const details = await contactService.getUsersByIds(ids)
    if (disposed) return
    const entries = new Map(directoryTargets.value.map(c => [`${c.fromType}|${c.id}`, c]))
    for (const d of details) {
      const key = `1|${d.userId}`
      const prev = entries.get(key)
      entries.set(key, {
        ...prev, id: d.userId, kind: 'user', fromType: 1,
        name: d.name || d.userName || prev?.name || d.userId,
        company: d.address || prev?.company,
        dept: d.orgName || prev?.dept,
      })
    }
    directoryTargets.value = [...entries.values()]
  } catch {
    // 详情不可用时保留选择，并明确展示缺失状态。
  }
}, { immediate: true })
const targets = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const found = new Set(searchResults.value.map(c => `${c.fromType}|${c.id}`))
  return allTargets.value.filter(t => !kw || found.has(`${t.type}|${t.id}`) ||
    t.name.toLowerCase().includes(kw) || t.id.toLowerCase().includes(kw))
    .sort((a, b) => Number(b.type === 1) - Number(a.type === 1))
})
const selectedTargets = computed(() => selected.value.map(key => allTargets.value.find(t => targetKey(t) === key)).filter((t): t is ForwardTarget => !!t))
function close() { if (!busy.value) emit('close') }
async function send() {
  if (!selectedTargets.value.length || busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!started.value) {
      const batches = combine.value ? splitForwardBatches(pending.value, im.messages) : pending.value.map(message => [message])
      jobs.value = selectedTargets.value.flatMap(receiver => batches.map(messages => ({ receiver: { ...receiver }, messages })))
      started.value = true
    }
    while (jobs.value.length) {
      const job = jobs.value[0]
      await im.forwardMessage(job.receiver, job.messages, combine.value)
      jobs.value.shift()
      done.value += 1
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    emit('sent')
  } catch (e: any) {
    error.value = started.value ? `转发中断：${e?.message || e}。可重试剩余消息。` : String(e?.message || e)
  } finally { busy.value = false }
}
</script>

<style scoped>
.forward-mask { position: fixed; inset: 0; z-index: 70; background: #0006; display: flex; align-items: center; justify-content: center; }
.forward-dialog { width: min(520px, 90vw); max-height: 85vh; overflow: auto; background: var(--panel); padding: 20px; border-radius: 10px; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3 { margin: 0; }
.forward-mode { display: flex; flex-wrap: wrap; gap: 10px; min-width: 0; margin: 16px 0; padding: 0; border: 0; }
.forward-mode legend { padding: 0; margin-bottom: 8px; font-size: 13px; color: var(--text-muted); }
.forward-mode label { flex: 1 1 180px; display: flex; align-items: center; gap: 10px; box-sizing: border-box; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.forward-mode label.active { border-color: var(--primary); background: #fff5eb; }
.forward-mode label:focus-within { outline: 2px solid var(--primary); outline-offset: 2px; }
.forward-mode input[type='radio'] { width: 16px; height: 16px; flex: 0 0 16px; padding: 0; margin: 0; accent-color: var(--primary); }
.forward-mode label > span { white-space: nowrap; font-size: 14px; }
.forward-mode small { margin-left: 8px; font-size: 12px; }
.forward-mode:disabled label { opacity: 0.6; cursor: default; }
p, small { color: var(--text-muted); font-size: 13px; }
.targets { max-height: 280px; overflow-y: auto; margin: 12px 0; padding: 2px; }
.target-row {
  display: grid;
  grid-template-columns: 16px 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  margin-bottom: 4px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, border-color 0.15s;
}
.target-row:hover { background: var(--bg); }
.target-row.chosen { background: #fff5eb; border-color: var(--primary); }
.target-row:focus-within { outline: 2px solid var(--primary); outline-offset: -2px; }
.target-row.locked { cursor: default; }
.target-row input[type='checkbox'] {
  width: 16px;
  height: 16px;
  padding: 0;
  margin: 0;
  accent-color: var(--primary);
}
.target-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: #eaf2ff;
  color: #446a9e;
  font-size: 15px;
  font-weight: 600;
}
.target-avatar.group { background: #edf5ef; color: #4c7c5c; }
.target-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.target-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.target-meta span { min-width: 0; }
.selected-targets { margin-top: 12px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
.selected-heading { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.selected-list { display: flex; flex-wrap: wrap; gap: 8px; max-height: 160px; overflow-y: auto; }
.selected-chip { display: flex; align-items: center; gap: 8px; max-width: 100%; padding: 6px 8px; background: #fff5eb; border-radius: 6px; }
.remove-target { flex-shrink: 0; background: transparent; color: var(--text-muted); padding: 2px 6px; font-size: 18px; }
.target-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.target-type { white-space: nowrap; padding: 3px 7px; border-radius: 4px; background: var(--bg); font-size: 11px; }
@media (max-width: 420px) {
  .target-row { gap: 8px; padding: 8px; }
}
.preview { max-height: 140px; overflow: auto; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 0; }
footer { justify-content: flex-end; }
</style>
