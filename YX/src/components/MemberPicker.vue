<template>
  <div v-if="open" class="picker-mask" @click.self="close">
    <section class="picker" role="dialog" aria-modal="true" :aria-label="title">
      <header>
        <h3>{{ title }}</h3>
        <button class="secondary small" :disabled="busy" @click="close">关闭</button>
      </header>

      <input
        v-model="keyword"
        class="search"
        :placeholder="source === 'contacts' ? '搜索同事（中文名 / 账号）' : '搜索群成员'"
        aria-label="搜索"
      />

      <div v-if="presetSelected.length" class="chips">
        <span v-for="id in presetSelected" :key="'p' + id" class="chip">
          <span class="chip-name">{{ nameOf(id) || id }}</span>
          <button class="remove" type="button" :disabled="busy" @click="toggle(id)">×</button>
        </span>
      </div>

      <ul class="list">
        <li v-for="m in visible" :key="m.id">
          <label class="row" :class="{ chosen: isChosen(m.id) }">
            <input
              type="checkbox"
              :checked="isChosen(m.id)"
              :disabled="busy"
              @change="toggle(m.id)"
            />
            <ContactAvatar class="avatar" :id="m.id" :type="1" :name="m.name" />
            <span class="info">
              <span class="name" :title="m.name">{{ m.name }}</span>
              <small v-if="m.meta" class="meta">{{ m.meta }}</small>
            </span>
            <span v-if="m.role" class="role" :class="'r' + m.role">{{ roleLabel(m.role) }}</span>
          </label>
        </li>
        <li v-if="loading" class="hint">加载中…</li>
        <li v-else-if="!visible.length" class="hint">
          {{ keyword.trim() ? '没有匹配的成员' : '暂无可选成员' }}
        </li>
      </ul>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <footer>
        <button class="secondary" :disabled="busy" @click="close">取消</button>
        <button class="primary" :disabled="busy || !selected.length" @click="confirm">
          确定（{{ selected.length }}）
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 成员选择器（群管理复用）：
 * - source=contacts：全员通讯录搜索（好友 + 服务端全员搜索），用于加成员/邀请入群/转让
 * - source=members：群成员列表内选择（禁言/白名单名单），本地过滤
 * single=true 时单选（转让群主）。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { contactService, type ContactEntry } from '../services/contact-client'
import { authService } from '../services/auth'
import { useImStore } from '../stores/im'
import ContactAvatar from './ContactAvatar.vue'
import type { GroupMember } from '../services/group-client'

export interface PickedMember {
  id: string
  name: string
}

interface RowItem extends PickedMember {
  meta?: string
  role?: number
}

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    single?: boolean
    source: 'contacts' | 'members'
    members?: GroupMember[]
    exclude?: string[]
    preset?: string[]
  }>(),
  {
    title: '选择成员',
    single: false,
    members: () => [],
    exclude: () => [],
    preset: () => [],
  },
)
const emit = defineEmits<{
  close: []
  confirm: [items: PickedMember[]]
}>()

const im = useImStore()
const selfId = authService.getCurrentUserId()

const keyword = ref('')
const selected = ref<RowItem[]>([])
const rows = ref<RowItem[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')

let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
onUnmounted(() => clearTimeout(searchTimer))

const excludeSet = computed(() => new Set([...(props.exclude || []), selfId].filter(Boolean)))

const presetSelected = computed(() =>
  selected.value.filter((s) => (props.preset || []).includes(s.id)).map((s) => s.id),
)

function memberName(m: GroupMember): string {
  return m.nickName || m.name || m.userName || m.userId
}

/** 群成员来源：本地过滤（含群内昵称展示） */
const membersVisible = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = props.members
    .filter((m) => !excludeSet.value.has(m.userId))
    .map((m) => ({
      id: m.userId,
      name: memberName(m),
      meta: m.loginId || (typeof m.orgName === 'string' ? m.orgName : '') || '',
      role: m.memberRole === 2 ? 2 : m.memberRole === 1 ? 1 : 0,
    }))
    .filter((r) => r.name || r.id)
  if (!kw) return list
  return list.filter((r) =>
    [r.name, r.id, r.meta].some((v) => (v || '').toLowerCase().includes(kw)),
  )
})

const visible = computed(() =>
  props.source === 'members' ? membersVisible.value : rows.value,
)

function isChosen(id: string): boolean {
  return selected.value.some((m) => m.id === id)
}

function toggle(id: string) {
  const entry = visible.value.find((m) => m.id === id)
  if (!entry) return
  if (props.single) {
    selected.value = [entry]
    return
  }
  selected.value = isChosen(id)
    ? selected.value.filter((m) => m.id !== id)
    : [...selected.value, entry]
}

function nameOf(id: string): string {
  return visible.value.find((m) => m.id === id)?.name || id
}

function roleLabel(role: number): string {
  return role === 2 ? '群主' : role === 1 ? '管理员' : ''
}

/** 合并搜索结果：本地条目字段更全，只补缺失项（与 CreateGroupModal 原逻辑一致） */
function mergeContacts(list: ContactEntry[]) {
  const map = new Map(rows.value.map((m) => [m.id, m]))
  for (const c of list) {
    if (c.fromType !== 1 || !c.id || excludeSet.value.has(c.id)) continue
    const prev = map.get(c.id)
    if (!prev) {
      map.set(c.id, {
        id: c.id,
        name: c.name,
        meta: c.dept || c.company || c.desc || '',
      })
      continue
    }
    map.set(c.id, {
      ...prev,
      name: prev.name || c.name,
      meta: prev.meta || c.dept || c.company || '',
    })
  }
  rows.value = [...map.values()]
}

watch(keyword, (value) => {
  if (props.source !== 'contacts') return
  const query = value.trim()
  const seq = ++searchSeq
  clearTimeout(searchTimer)
  if (!query) return
  searchTimer = setTimeout(async () => {
    loading.value = true
    error.value = ''
    try {
      const list = await contactService.searchEntries(query, im.friends, im.groups)
      if (seq !== searchSeq) return
      mergeContacts(list)
    } catch (e: any) {
      if (seq === searchSeq) error.value = e?.message || '联系人搜索失败'
    } finally {
      if (seq === searchSeq) loading.value = false
    }
  }, 250)
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    searchSeq += 1
    clearTimeout(searchTimer)
    keyword.value = ''
    error.value = ''
    busy.value = false
    if (props.source === 'contacts') {
      const seed = im.contacts
        .filter((c) => c.kind === 'user' && !excludeSet.value.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, meta: c.dept || c.company || '' }))
      mergeContacts([])
      for (const s of seed) {
        if (!rows.value.some((r) => r.id === s.id)) rows.value.push(s)
      }
      if (!rows.value.length) {
        loading.value = true
        im.loadContacts().then(() => {
          if (!rows.value.length) {
            const fresh = im.contacts
              .filter((c) => c.kind === 'user' && !excludeSet.value.has(c.id))
              .map((c) => ({ id: c.id, name: c.name, meta: c.dept || c.company || '' }))
            mergeContacts([])
            for (const s of fresh) {
              if (!rows.value.some((r) => r.id === s.id)) rows.value.push(s)
            }
          }
        })
        loading.value = false
      }
    }
    // 预选（如已禁言名单）
    selected.value = []
    if (props.preset?.length) {
      const pool =
        props.source === 'members'
          ? props.members.map((m) => ({ id: m.userId, name: memberName(m) }))
          : im.contacts.filter((c) => c.kind === 'user').map((c) => ({ id: c.id, name: c.name }))
      const names = new Map(pool.map((p) => [p.id, p.name]))
      selected.value = props.preset
        .filter((id) => !excludeSet.value.has(id))
        .map((id) => ({ id, name: names.get(id) || id }))
    }
  },
  { immediate: true },
)

function close() {
  if (!busy.value) emit('close')
}

function confirm() {
  if (!selected.value.length) return
  busy.value = true
  emit('confirm', selected.value.map((m) => ({ id: m.id, name: m.name || m.id })))
  busy.value = false
}
</script>

<style scoped>
.picker-mask {
  position: fixed; inset: 0; z-index: 90; background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
}
.picker {
  width: min(460px, 92vw); max-height: 86vh; overflow: auto;
  background: var(--surface); padding: 18px; border-radius: 10px;
  display: flex; flex-direction: column; gap: 12px;
}
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3 { margin: 0; font-size: 15px; }
.small { padding: 4px 10px; font-size: 12px; }
.search { width: 100%; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 96px; overflow-y: auto; }
.chip {
  display: flex; align-items: center; gap: 6px; max-width: 100%;
  background: var(--primary-soft); border-radius: 6px; padding: 4px 8px; font-size: 12px;
}
.chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remove {
  flex-shrink: 0; background: transparent; color: var(--text-muted);
  padding: 0 4px; font-size: 14px;
}
.list { list-style: none; min-height: 80px; max-height: 320px; overflow-y: auto; padding: 2px; }
.row {
  display: grid; grid-template-columns: 16px 30px minmax(0, 1fr) auto;
  align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 4px;
  border: 1px solid transparent; border-radius: 8px; cursor: pointer;
}
.row:hover { background: var(--bg); }
.row.chosen { background: var(--primary-soft); border-color: var(--primary); }
.row input[type='checkbox'] { width: 16px; height: 16px; padding: 0; margin: 0; accent-color: var(--primary); }
.avatar {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--info-soft); color: var(--info-text); font-weight: 600; font-size: 13px;
}
.info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role { font-size: 11px; padding: 0 6px; border-radius: 4px; background: var(--chip-bg); color: var(--chip-text); }
.role.r2 { background: var(--primary-soft); color: var(--primary); }
.hint { text-align: center; color: var(--text-muted); font-size: 13px; padding: 16px; }
.error { color: var(--danger); font-size: 13px; margin: 0; }
</style>
