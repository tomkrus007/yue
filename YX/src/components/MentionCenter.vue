<template>
  <div class="mention-center-mask" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section ref="panel" role="dialog" aria-modal="true" aria-label="@ 提醒中心" tabindex="-1">
      <header><h3>@ 提醒中心 · {{ mentions.pending.length }} 条待处理</h3><div class="actions"><button class="secondary small" :disabled="!mentions.pending.length" title="将当前账号的全部待处理提醒标记为已处理（包含搜索范围外的提醒）" @click="mentions.handleAll()">一键标记已处理</button><button class="secondary small" @click="emit('close')">关闭</button></div></header>
      <div class="filters"><input v-model="keyword" placeholder="搜索群聊、发送人或消息" aria-label="搜索提醒" /><select v-model="status" aria-label="提醒处理状态"><option value="pending">待处理</option><option value="done">已处理</option><option value="all">全部</option></select></div>
      <p class="hint">打开会话仅清除未读数；“收到”或回复发送成功后自动完成提醒，也可手动标记。记录按当前账号保存在本机。</p>
      <div class="notice-list">
        <article v-for="notice in visible" :key="notice.id">
          <div class="meta"><strong>{{ notice.sessionName }}</strong><span>{{ notice.sender }} · {{ fmtMsgTime(notice.time) }}</span><span>{{ notice.status === 'pending' ? '待处理' : '已处理' }}</span></div>
          <p>{{ notice.preview }}</p>
          <div class="actions"><button class="secondary small" @click="emit('locate', notice)">定位</button><button class="small" @click="emit('reply', notice)">去回复</button><button v-if="notice.status === 'pending'" class="secondary small" @click="mentions.handle(notice.id)">标记已处理</button><button v-else class="secondary small" @click="mentions.reopen(notice.id)">重新待处理</button></div>
        </article>
        <p v-if="!filtered.length" class="empty">没有匹配的提醒</p>
        <button v-if="filtered.length > limit" class="secondary small" @click="limit += 100">继续显示（还有 {{ filtered.length - limit }} 条）</button>
      </div>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useMentionsStore, type MentionNotice } from '../stores/mentions'
import { fmtMsgTime } from '../services/im/content'
const emit = defineEmits<{ close: []; locate: [notice: MentionNotice]; reply: [notice: MentionNotice] }>()
const mentions = useMentionsStore()
const panel = ref<HTMLElement | null>(null)
const keyword = ref('')
const status = ref('pending')
const limit = ref(100)
const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return mentions.all.filter(notice => (status.value === 'all' || notice.status === status.value) &&
    (!query || `${notice.sessionName} ${notice.sender} ${notice.preview}`.toLowerCase().includes(query)))
})
const visible = computed(() => filtered.value.slice(0, limit.value))
watch([keyword, status], () => { limit.value = 100 })
onMounted(() => { mentions.ensureAccount(); panel.value?.focus() })
</script>
<style scoped>
.mention-center-mask { position: fixed; inset: 0; z-index: 75; background: var(--overlay); display: grid; place-items: center; }
section { width: min(760px, 90vw); height: min(80vh, 850px); display: flex; flex-direction: column; padding: 20px; border-radius: 12px; background: var(--surface); }
header, .filters, .meta, .actions { display: flex; align-items: center; gap: 10px; }
header { justify-content: space-between; }
.filters { margin: 12px 0; }
.filters input { flex: 1; min-width: 0; }
input, select { padding: 8px; border: 1px solid var(--border); border-radius: 6px; }
.hint, .meta { font-size: 12px; color: var(--text-muted); }
.notice-list { flex: 1; overflow-y: auto; min-height: 0; }
article { padding: 14px 0; border-bottom: 1px solid var(--border); }
article p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0; }
.meta strong { color: var(--text); }
.meta span:last-child { margin-left: auto; }
.empty { padding: 30px; text-align: center; color: var(--text-muted); }
</style>
