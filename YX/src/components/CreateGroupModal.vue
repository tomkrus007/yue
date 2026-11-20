<template>
  <div v-if="open" class="group-mask" @click.self="close">
    <section class="group-dialog" role="dialog" aria-modal="true" aria-label="创建群组">
      <header>
        <h3>创建群组</h3>
        <button class="secondary small" :disabled="busy" @click="close">关闭</button>
      </header>

      <label class="name-field">
        <span>群名称</span>
        <input
          v-model="name"
          maxlength="64"
          placeholder="默认取前 3 位成员姓名"
          aria-label="群名称"
          @input="nameEdited = true"
        />
      </label>

      <div class="selected">
        <div class="selected-heading">已选 {{ selected.length + 1 }} 人（含自己）</div>
        <div class="chips">
          <span v-for="m in selected" :key="m.id" class="chip">
            <span class="chip-name" :title="m.name">{{ m.name }}</span>
            <button
              class="remove"
              type="button"
              :disabled="busy"
              :aria-label="`移除${m.name}`"
              @click="unselect(m.id)"
            >×</button>
          </span>
          <span v-if="!selected.length" class="chip-empty">点击下方按钮选择至少 1 位同事</span>
        </div>
        <button class="secondary pick-btn" :disabled="busy" @click="pickerOpen = true">
          添加成员
        </button>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p class="tip">建群后可直接发消息；群主为你本人。</p>

      <footer>
        <button class="secondary" :disabled="busy" @click="close">取消</button>
        <button class="primary" :disabled="busy || !selected.length" @click="submit">
          {{ busy ? '创建中…' : '创建群组' }}
        </button>
      </footer>
    </section>
  </div>

  <MemberPicker
    :open="pickerOpen && open"
    title="选择群成员"
    source="contacts"
    :exclude="[selfId]"
    @close="pickerOpen = false"
    @confirm="onPicked"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ContactEntry } from '../services/contact-client'
import { authService } from '../services/auth'
import { useAuthStore } from '../stores/auth'
import { contactService } from '../services/contact-client'
import MemberPicker from './MemberPicker.vue'
import type { PickedMember } from './MemberPicker.vue'

const props = defineProps<{ open: boolean; preset?: { id: string; name: string }[] }>()
const emit = defineEmits<{ close: []; created: [group: { id: string; name: string }] }>()

const auth = useAuthStore()

const selfId = computed(() => auth.user?.id || authService.getCurrentUserId())
const selfName = computed(
  () => auth.user?.name || authService.getCurrentUserName() || '我',
)

const name = ref('')
const nameEdited = ref(false)
const selected = ref<ContactEntry[]>([])
const busy = ref(false)
const error = ref('')
const pickerOpen = ref(false)

/** 默认群名：自己 + 已选成员，最多取前 3 人姓名逗号拼接（对齐官方） */
const defaultName = computed(() =>
  [selfName.value, ...selected.value.map((m) => m.name)].slice(0, 3).join(','),
)

watch(selected, () => {
  if (!nameEdited.value) name.value = defaultName.value
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    error.value = ''
    busy.value = false
    pickerOpen.value = false
    /** 打开时预置成员（如当前单聊对象），可手动移除 */
    selected.value = (props.preset || []).map((p) => ({ id: p.id, name: p.name, kind: 'user' as const, fromType: 1 }))
    name.value = ''
    nameEdited.value = false
  },
  { immediate: true },
)

function unselect(id: string) {
  selected.value = selected.value.filter((m) => m.id !== id)
}

/** 选择器确认：按 id 去重合并（保留已有条目的完整字段） */
function onPicked(items: PickedMember[]) {
  pickerOpen.value = false
  if (!items.length) return
  const map = new Map(selected.value.map((m) => [m.id, m]))
  for (const p of items) {
    if (!map.has(p.id)) {
      map.set(p.id, { id: p.id, name: p.name, kind: 'user', fromType: 1 })
    }
  }
  selected.value = [...map.values()]
}

function close() {
  if (!busy.value) emit('close')
}

async function submit() {
  if (busy.value || !selected.value.length) return
  const uid = selfId.value
  if (!uid) {
    error.value = '未获取到当前用户信息，请重新登录后再建群'
    return
  }
  const groupName = name.value.trim() || defaultName.value
  busy.value = true
  error.value = ''
  try {
    const groupId = await contactService.createGroup(groupName, [
      { memRole: 2, id: uid },
      ...selected.value.map((m) => ({ memRole: 0, id: m.id })),
    ])
    emit('created', { id: groupId, name: groupName })
  } catch (e: any) {
    error.value = e?.message || '创建群组失败'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.group-mask {
  position: fixed; inset: 0; z-index: 80; background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
}
.group-dialog {
  width: min(520px, 92vw); max-height: 88vh; overflow: auto;
  background: var(--surface); padding: 20px; border-radius: 10px;
  display: flex; flex-direction: column; gap: 12px;
}
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3 { margin: 0; font-size: 16px; }
.name-field { display: flex; align-items: center; gap: 10px; }
.name-field span { font-size: 13px; color: var(--text-muted); flex-shrink: 0; }
.name-field input { flex: 1; }
.selected { border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
.selected-heading { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; max-height: 132px; overflow-y: auto; }
.chip {
  display: flex; align-items: center; gap: 6px; max-width: 100%;
  background: var(--primary-soft); border-radius: 6px; padding: 5px 8px; font-size: 13px;
}
.chip-empty { font-size: 12px; color: var(--text-muted); }
.chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remove { flex-shrink: 0; background: transparent; color: var(--text-muted); padding: 0 4px; font-size: 16px; }
.pick-btn { margin-top: 10px; }
.tip { font-size: 12px; color: var(--text-muted); margin: 0; }
.error { color: var(--danger); font-size: 13px; margin: 0; }
.small { padding: 5px 12px; font-size: 12px; }
footer { justify-content: flex-end; }
</style>
