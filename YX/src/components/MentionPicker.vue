<template>
  <div class="mention-mask" @click.self="emit('close')" @keydown.esc.stop="emit('close')">
    <section role="dialog" aria-modal="true" aria-label="选择要提醒的群成员">
      <header><h3>选择群成员</h3><button class="secondary" @click="emit('close')">取消</button></header>
      <input ref="searchInput" v-model="keyword" placeholder="搜索姓名或账号" aria-label="搜索群成员" />
      <p v-if="loading">正在加载群成员…</p>
      <p v-else-if="error" role="alert">{{ error }} <button @click="load">重试</button></p>
      <div v-else class="members">
        <label v-for="member in filtered" :key="member.userId">
          <input v-model="selected" type="checkbox" :value="member.userId" />
          <span>{{ member.name || member.userName || member.userId }}<small>{{ member.orgName || member.loginId || member.userId }}</small></span>
        </label>
        <p v-if="!filtered.length">没有匹配的群成员</p>
      </div>
      <footer><button :disabled="loading || !!error || !selected.length" @click="confirm">确认（{{ selected.length }}）</button></footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { contactService, type LinkUserDetail } from '../services/contact-client'
const props = defineProps<{ groupId: string }>()
const emit = defineEmits<{ close: []; confirm: [members: LinkUserDetail[]] }>()
const members = ref<LinkUserDetail[]>([])
const selected = ref<string[]>([])
const keyword = ref('')
const loading = ref(false)
const error = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const filtered = computed(() => members.value.filter(member =>
  [member.name, member.userName, member.loginId, member.userId].some(value => value?.toLowerCase().includes(keyword.value.trim().toLowerCase()))))
async function load() {
  loading.value = true
  error.value = ''
  try { members.value = await contactService.getGroupMembers(props.groupId) }
  catch (e) { error.value = e instanceof Error ? e.message : '获取群成员失败' }
  finally { loading.value = false }
}
function confirm() { emit('confirm', members.value.filter(member => selected.value.includes(member.userId))) }
onMounted(() => { searchInput.value?.focus(); void load() })
</script>

<style scoped>
.mention-mask { position: fixed; inset: 0; z-index: 100; background: #0006; display: flex; align-items: center; justify-content: center; }
section { width: 420px; max-width: 90vw; background: var(--panel); border-radius: 12px; padding: 20px; }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
section > input { width: 100%; box-sizing: border-box; padding: 10px; }
.members { max-height: 45vh; overflow-y: auto; margin: 12px 0; }
label { display: flex; gap: 12px; padding: 10px; cursor: pointer; }
small { display: block; color: var(--text-muted); }
footer { display: flex; justify-content: flex-end; margin-top: 16px; }
p { padding: 12px 0; }
</style>
