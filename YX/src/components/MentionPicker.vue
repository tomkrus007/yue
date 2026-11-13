<template>
  <div class="mention-mask" @click.self="emit('close')" @keydown.esc.stop="emit('close')">
    <section role="dialog" aria-modal="true" aria-label="选择要提醒的群成员">
      <header><h3>选择群成员</h3><button class="secondary" @click="emit('close')">取消</button></header>
      <input ref="searchInput" v-model="keyword" placeholder="搜索姓名或账号" aria-label="搜索群成员" />
      <p v-if="loading">正在加载群成员…</p>
      <p v-else-if="error" role="alert">{{ error }} <button @click="load">重试</button></p>
      <div v-else class="member-list">
        <label class="select-all"><input v-model="everyone" type="checkbox" /><span>@所有人<small>提醒群内所有成员</small></span></label>
        <label v-if="filtered.length" class="select-all">
          <input type="checkbox" :disabled="everyone" :checked="allSelected" :indeterminate="partiallySelected" @change="toggleAll" />
          <span>{{ keyword.trim() ? '全选搜索结果' : '全选' }}（{{ filtered.length }}）</span>
        </label>
        <div class="members">
        <label v-for="member in filtered" :key="member.userId">
          <input v-model="selected" type="checkbox" :disabled="everyone" :value="member.userId" />
          <span>{{ member.name || member.userName || '未命名成员' }}<small v-if="member.orgName">{{ member.orgName }}</small></span>
        </label>
        <p v-if="!filtered.length">没有匹配的群成员</p>
        </div>
      </div>
      <footer><button :disabled="loading || !!error || (!everyone && !selected.length)" @click="confirm">确认（{{ everyone ? '所有人' : selected.length }}）</button></footer>
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
const everyone = ref(false)
const keyword = ref('')
const loading = ref(false)
const error = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const filtered = computed(() => members.value.filter(member =>
  [member.name, member.userName, member.loginId, member.userId].some(value => value?.toLowerCase().includes(keyword.value.trim().toLowerCase()))))
const allSelected = computed(() => filtered.value.length > 0 && filtered.value.every(member => selected.value.includes(member.userId)))
const partiallySelected = computed(() => !allSelected.value && filtered.value.some(member => selected.value.includes(member.userId)))
function toggleAll() {
  const visibleIds = new Set(filtered.value.map(member => member.userId))
  selected.value = allSelected.value
    ? selected.value.filter(id => !visibleIds.has(id))
    : [...new Set([...selected.value, ...visibleIds])]
}
async function load() {
  loading.value = true
  error.value = ''
  try { members.value = await contactService.getGroupMembers(props.groupId) }
  catch (e) { error.value = e instanceof Error ? e.message : '获取群成员失败' }
  finally { loading.value = false }
}
function confirm() { emit('confirm', everyone.value ? [{ userId: 'ALL', name: '所有人' }] : members.value.filter(member => selected.value.includes(member.userId))) }
onMounted(() => { searchInput.value?.focus(); void load() })
</script>

<style scoped>
.mention-mask { position: fixed; inset: 0; z-index: 100; background: #0006; display: flex; align-items: center; justify-content: center; }
section { box-sizing: border-box; width: 420px; max-width: 90vw; background: var(--panel); border-radius: 12px; padding: 20px; }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
section > input { width: 100%; box-sizing: border-box; padding: 10px; }
.members { max-height: 45vh; overflow-y: auto; margin: 12px 0; }
label { display: flex; align-items: center; justify-content: flex-start; gap: 12px; min-height: 44px; box-sizing: border-box; padding: 8px 10px; cursor: pointer; border-radius: 6px; }
label:hover { background: var(--bg); }
label > input[type="checkbox"] { flex: 0 0 16px; width: 16px; height: 16px; margin: 0; padding: 0; accent-color: var(--primary); }
label > span { flex: 1; min-width: 0; text-align: left; overflow-wrap: anywhere; line-height: 1.5; }
.select-all { border-bottom: 1px solid var(--border); margin-top: 12px; }
small { display: block; font-size: 12px; color: var(--text-muted); }
footer { display: flex; justify-content: flex-end; margin-top: 16px; }
p { padding: 12px 0; }
</style>
