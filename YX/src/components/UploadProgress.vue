<template>
  <Teleport to="body">
    <section v-if="uploads.visible" :class="['upload-panel', { collapsed: uploads.collapsed }]" role="region" aria-label="上传进度">
      <header class="panel-head" @click="uploads.collapsed = !uploads.collapsed">
        <span class="head-title">
          上传 · {{ summary }}
        </span>
        <span class="head-actions" @click.stop>
          <button class="mini" :title="uploads.collapsed ? '展开' : '收起'" @click="uploads.collapsed = !uploads.collapsed">
            {{ uploads.collapsed ? '▴' : '▾' }}
          </button>
          <button class="mini" title="关闭" @click="uploads.close()">×</button>
        </span>
      </header>

      <div v-if="uploads.collapsed" class="collapsed-body">
        <div class="bar"><div class="bar-fill" :class="{ err: hasError }" :style="{ width: overall + '%' }"></div></div>
      </div>

      <template v-else>
        <ul class="task-list">
          <li v-for="task in uploads.tasks" :key="task.id" class="task">
            <div class="task-line">
              <span class="task-name" :title="task.name">{{ task.name }}</span>
              <span class="task-state" :class="task.status">{{ stateText(task) }}</span>
            </div>
            <div class="bar">
              <div
                class="bar-fill"
                :class="{ done: task.status === 'done', err: task.status === 'error' }"
                :style="{ width: Math.max(task.status === 'error' ? 100 : 0, task.progress) + '%' }"
              ></div>
            </div>
            <div class="task-sub">
              <span class="task-dir" :title="task.dirLabel">{{ task.dirLabel || '云盘' }}</span>
              <button v-if="task.status === 'error'" class="retry" @click="uploads.retry(task.id)">重试</button>
            </div>
            <p v-if="task.status === 'error'" class="task-error" :title="task.error">{{ task.error }}</p>
          </li>
        </ul>
        <footer class="panel-foot">
          <button v-if="hasError" class="mini-text" @click="uploads.retryAll()">重试全部失败</button>
          <button v-if="hasDone" class="mini-text" @click="uploads.clearFinished()">清除已完成</button>
        </footer>
      </template>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useUploadStore, type UploadTask } from '../stores/uploads'

const uploads = useUploadStore()

const activeCount = computed(
  () => uploads.tasks.filter((t) => ['queued', 'uploading', 'saving'].includes(t.status)).length,
)
const hasError = computed(() => uploads.tasks.some((t) => t.status === 'error'))
const hasDone = computed(() => uploads.tasks.some((t) => t.status === 'done'))
const overall = computed(() => {
  if (!uploads.tasks.length) return 0
  const sum = uploads.tasks.reduce(
    (n, t) => n + (t.status === 'done' ? 100 : t.status === 'error' ? 0 : t.progress),
    0,
  )
  return Math.round(sum / uploads.tasks.length)
})
const summary = computed(() => {
  if (hasError.value) return `${activeCount.value} 个进行中 · 有失败`
  if (activeCount.value) return `${activeCount.value} 个进行中`
  return '已完成'
})

function stateText(task: UploadTask): string {
  switch (task.status) {
    case 'queued':
      return '等待'
    case 'uploading':
      return `${task.progress}%`
    case 'saving':
      return '保存中…'
    case 'done':
      return '已完成'
    case 'error':
      return '失败'
    default:
      return ''
  }
}
</script>

<style scoped>
.upload-panel {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 60;
  width: 320px;
  max-width: calc(100vw - 36px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-2);
  overflow: hidden;
  font-size: 12px;
}
.upload-panel.collapsed { width: 220px; }
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}
.head-title { font-weight: 600; color: var(--text); }
.head-actions { display: flex; gap: 2px; }
.mini {
  border: none;
  background: transparent;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.mini:hover { background: var(--hover); color: var(--text); }
.collapsed-body { padding: 8px 10px; }
.task-list {
  list-style: none;
  margin: 0;
  padding: 6px 10px;
  max-height: 260px;
  overflow-y: auto;
}
.task { padding: 7px 0; border-bottom: 1px dashed var(--divider); }
.task:last-child { border-bottom: none; }
.task-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.task-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.task-state { flex: none; color: var(--text-muted); }
.task-state.done { color: var(--success); }
.task-state.error { color: var(--danger); }
.bar {
  height: 4px;
  margin-top: 5px;
  background: var(--surface-2);
  border-radius: 2px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  background: var(--primary);
  transition: width 0.2s ease;
}
.bar-fill.done { background: var(--success); }
.bar-fill.err { background: var(--danger); }
.task-sub { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.task-dir { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.retry {
  flex: none;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--primary);
  padding: 1px 8px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 11px;
}
.retry:hover { background: var(--hover); }
.task-error {
  margin-top: 4px;
  color: var(--danger);
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.panel-foot {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 6px 10px 8px;
  border-top: 1px solid var(--border);
}
.mini-text {
  border: none;
  background: transparent;
  color: var(--primary);
  cursor: pointer;
  font-size: 11px;
  padding: 0;
}
</style>
