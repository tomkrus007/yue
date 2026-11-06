<template>
  <aside class="drawer" @dragover.prevent @drop.prevent>
    <header class="drawer-head">
      <div class="drawer-title" :title="session?.name">{{ session?.name }}</div>
      <button class="secondary small" @click="$emit('close')">收起</button>
    </header>

    <div class="drawer-tabs">
      <button
        :class="['tab', { on: tab === 'task' }]"
        @click="switchTab('task')"
      >
        团队任务
        <i v-if="taskCount">{{ taskCount }}</i>
      </button>
      <button
        :class="['tab', { on: tab === 'doc' }]"
        @click="switchTab('doc')"
      >
        团队文档
        <i v-if="panItems.length">{{ panItems.length }}</i>
      </button>
    </div>

    <!-- 任务 -->
    <div v-if="tab === 'task'" class="drawer-body">
      <div v-if="tasksLoading" class="d-empty">加载中…</div>
      <div v-else-if="tasksError" class="d-empty err">{{ tasksError }}</div>
      <div v-else-if="!taskGroups.length" class="d-empty">这个团队还没有任务分组</div>
      <details v-for="g in taskGroups" :key="g.id" class="tree-group">
        <summary>
          <span class="tree-name" :title="g.name">{{ g.name }}</span>
          <span class="tree-count">{{ g.tasks.length || '' }}</span>
        </summary>
        <div class="tree-kids">
          <div v-if="g.failed" class="tree-empty">这一组加载失败</div>
          <div v-else-if="!g.tasks.length" class="tree-empty">这一组还没有任务</div>
          <TaskNode
            v-for="(t, i) in g.tasks"
            :key="t.id || i"
            :task="t"
            :depth="0"
          />
        </div>
      </details>
    </div>

    <!-- 文档 -->
    <div
      v-else
      class="drawer-body"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <div v-if="dragging" class="drop-mask">松开鼠标上传到「{{ crumb }}」</div>
      <div class="pan-bar">
        <button
          class="secondary small"
          :disabled="panStack.length <= 1 || panLoading"
          @click="panBack"
        >
          返回
        </button>
        <div class="pan-crumb" :title="crumb">
          {{ crumb }}
        </div>
        <button class="secondary small" :disabled="!panStack.length" @click="pickUpload">上传</button>
        <input ref="uploadInput" type="file" multiple hidden @change="onUploadChange" />
      </div>

      <div v-if="panLoading" class="d-empty">加载中…</div>
      <div v-else-if="panError" class="d-empty err">{{ panError }}</div>
      <div v-else-if="!panItems.length" class="d-empty">这个文件夹是空的</div>

      <div
        v-for="item in panItems"
        :key="item.id"
        :class="['pan-row', { dir: item.type === 'D' }]"
        @click="item.type === 'D' ? panEnter(item) : undefined"
      >
        <div class="pan-line">
          <span class="pan-name" :title="item.name">
            {{ item.type === 'D' ? '📁' : '📄' }} {{ item.name }}
          </span>
        </div>
        <div class="pan-meta">
          {{
            item.type === 'D'
              ? '文件夹'
              : [fmtSize(item.size), panDate(item.updatedAt)].filter(Boolean).join(' · ')
          }}
        </div>
        <div class="pan-acts" @click.stop>
          <template v-if="pendingDeleteId === item.id">
            <button class="pan-btn danger" :disabled="deleting" @click="confirmDelete(item)">
              {{ deleting ? '删除中…' : '确认删除' }}
            </button>
            <button class="pan-btn" :disabled="deleting" @click="pendingDeleteId = ''">取消</button>
          </template>
          <template v-else>
            <template v-if="item.type !== 'D'">
              <button class="pan-btn" @click="panAction(item, 'download')">下载</button>
              <button
                v-if="isOffice(item.name)"
                class="pan-btn"
                @click="panAction(item, 'edit')"
              >
                在线编辑
              </button>
              <button class="pan-btn" @click="panAction(item, 'preview')">浏览</button>
            </template>
            <button
              v-if="item.permissions?.deleteable !== false"
              class="pan-btn danger"
              @click="pendingDeleteId = item.id"
            >
              删除
            </button>
          </template>
        </div>
      </div>
    </div>

    <footer class="drawer-foot">{{ foot }}</footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { ChatSession } from '../stores/im'
import {
  editUrl,
  fmtSize,
  listDir,
  OFFICE_EXT,
  panDate,
  previewUrl,
  signDownload,
  type PanItem,
} from '../services/pan-client'
import { loadTeamTasks, type TaskGroup } from '../services/task-client'
import { deleteItem } from '../services/disk-pan'
import { useUploadStore } from '../stores/uploads'
import TaskNode from './TaskNode.vue'

const props = defineProps<{ session: ChatSession | null }>()
defineEmits<{ close: [] }>()

const tab = ref<'task' | 'doc'>('task')
const taskGroups = ref<TaskGroup[]>([])
const tasksLoading = ref(false)
const tasksError = ref('')

const panStack = ref<Array<{ id: string; name: string }>>([])
const panItems = ref<PanItem[]>([])
const panLoading = ref(false)
const panError = ref('')
const uploadInput = ref<HTMLInputElement | null>(null)
const uploads = useUploadStore()
const dragging = ref(false)
const pendingDeleteId = ref('')
const deleting = ref(false)
const foot = ref('团队任务 · 只读')

const taskCount = computed(() =>
  taskGroups.value.reduce((n, g) => n + g.tasks.length, 0),
)
const crumb = computed(
  () => panStack.value.map((x) => x.name).join(' / ') || '团队文档',
)

function reset() {
  taskGroups.value = []
  tasksError.value = ''
  panItems.value = []
  panError.value = ''
  pendingDeleteId.value = ''
  panStack.value = props.session
    ? [{ id: props.session.id, name: '团队文档' }]
    : []
  foot.value = tab.value === 'doc' ? '文档来自品高云盘' : '团队任务 · 只读'
}

async function loadTasks() {
  if (!props.session) return
  tasksLoading.value = true
  tasksError.value = ''
  taskGroups.value = []
  try {
    taskGroups.value = await loadTeamTasks(props.session.id)
  } catch (e: any) {
    tasksError.value = '任务加载失败：' + (e?.message || e)
  } finally {
    tasksLoading.value = false
  }
}

async function loadPanDir() {
  const top = panStack.value[panStack.value.length - 1]
  if (!top) return
  panLoading.value = true
  panError.value = ''
  try {
    panItems.value = await listDir(top.id)
  } catch (e: any) {
    panItems.value = []
    panError.value = '文档加载失败：' + (e?.message || e)
  } finally {
    panLoading.value = false
  }
}

function switchTab(next: 'task' | 'doc') {
  tab.value = next
  pendingDeleteId.value = ''
  foot.value = next === 'doc' ? '文档来自品高云盘' : '团队任务 · 只读'
  if (next === 'task' && !taskGroups.value.length && !tasksError.value) {
    loadTasks()
  } else if (next === 'doc' && !panItems.value.length && !panError.value) {
    loadPanDir()
  }
}

function panEnter(item: PanItem) {
  pendingDeleteId.value = ''
  panStack.value.push({ id: item.id, name: item.name })
  loadPanDir()
}

function panBack() {
  if (panStack.value.length <= 1) return
  pendingDeleteId.value = ''
  panStack.value.pop()
  loadPanDir()
}

function pickUpload() {
  uploadInput.value?.click()
}

function enqueueFiles(files: File[]) {
  const top = panStack.value[panStack.value.length - 1]
  if (!files.length || !top) return
  panError.value = ''
  uploads.enqueue(files, top.id, `团队文档 · ${crumb.value}`, () => {
    loadPanDir()
  })
}

function onUploadChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  enqueueFiles(files)
}

function onDragLeave(event: DragEvent) {
  const target = event.currentTarget as HTMLElement | null
  const related = event.relatedTarget as Node | null
  if (!target || !related || !target.contains(related)) dragging.value = false
}

function onDrop(event: DragEvent) {
  dragging.value = false
  enqueueFiles(Array.from(event.dataTransfer?.files || []))
}

function isOffice(name: string): boolean {
  const ext = String(name).split('.').pop()?.toLowerCase() || ''
  return OFFICE_EXT.has(ext)
}

async function openExternal(url: string) {
  try {
    await openUrl(url)
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}

async function panAction(item: PanItem, mode: 'download' | 'edit' | 'preview') {
  try {
    if (mode === 'download') {
      const url = await signDownload(item.id)
      foot.value = '开始下载：' + item.name
      await openExternal(url)
    } else if (mode === 'edit') {
      await openExternal(await editUrl(item.id))
    } else {
      await openExternal(await previewUrl(item.id))
    }
  } catch (e: any) {
    foot.value =
      (mode === 'edit' ? '在线编辑失败：' : mode === 'download' ? '下载失败：' : '浏览失败：') +
      (e?.message || e)
  }
}

async function confirmDelete(item: PanItem) {
  if (deleting.value) return
  deleting.value = true
  panError.value = ''
  try {
    await deleteItem({
      id: item.id,
      name: item.name,
      type: item.type === 'D' ? 'D' : 'F',
    })
    pendingDeleteId.value = ''
    foot.value = '已删除：' + item.name
    await loadPanDir()
  } catch (e: any) {
    panError.value = '删除失败：' + (e?.message || e)
  } finally {
    deleting.value = false
  }
}

watch(
  () => props.session?.id,
  () => {
    reset()
    if (tab.value === 'task') loadTasks()
    else loadPanDir()
  },
  { immediate: true },
)
</script>

<style scoped>
.drawer {
  width: 320px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.drawer-head {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.drawer-title {
  flex: 1;
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.small { padding: 3px 8px; font-size: 11px; }
.drawer-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}
.tab {
  flex: 1;
  background: transparent;
  color: var(--text-muted);
  border-radius: 0;
  padding: 8px 4px;
  font-size: 12px;
}
.tab:hover { background: #f7f8f9; }
.tab.on { color: var(--primary); box-shadow: inset 0 -2px 0 var(--primary); }
.tab i {
  font-style: normal;
  font-size: 10px;
  background: #eef1f4;
  color: var(--text-muted);
  padding: 0 5px;
  border-radius: 8px;
  margin-left: 4px;
}
.drawer-body { flex: 1; overflow-y: auto; padding: 8px 10px; position: relative; }
.drop-mask {
  position: absolute; inset: 6px; z-index: 20;
  display: flex; align-items: center; justify-content: center;
  border: 2px dashed var(--primary); border-radius: 10px;
  background: rgba(242, 136, 35, 0.08); color: var(--primary);
  font-size: 12px; pointer-events: none;
}
.d-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  padding: 24px 8px;
  line-height: 1.8;
}
.d-empty.err { color: var(--danger); }
.tree-group {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  background: #fcfdfe;
}
.tree-group summary {
  list-style: none;
  cursor: pointer;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}
.tree-group summary::-webkit-details-marker { display: none; }
.tree-group summary::before { content: '▸'; color: var(--text-muted); }
.tree-group[open] summary::before { content: '▾'; }
.tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-count { color: var(--text-muted); font-weight: 400; }
.tree-kids { padding: 0 8px 8px; }
.tree-empty { color: var(--text-muted); font-size: 12px; padding: 6px; }

.pan-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.pan-crumb {
  flex: 1;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pan-row {
  padding: 8px;
  border-radius: 6px;
  border: 1px solid transparent;
}
.pan-row:hover { background: #f7f8f9; }
.pan-row.dir { cursor: pointer; }
.pan-line { display: flex; }
.pan-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pan-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.pan-acts { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.pan-btn {
  background: #f0f2f4;
  color: #35506b;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
}
.pan-btn:hover { background: #e3e7eb; }
.pan-btn.danger { color: var(--danger); }
.drawer-foot {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>