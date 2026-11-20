<template>
  <div class="tree-task" :style="{ paddingLeft: 8 + depth * 14 + 'px' }">
    <div class="tree-line">
      <span class="tree-title" :title="task.title || ''">{{ task.title || '(无标题)' }}</span>
      <span class="d-tag" :class="status.cls">{{ status.text }}</span>
    </div>
    <div class="tree-meta">{{ metaText }}</div>
    <div v-if="task.children && task.children.length" class="tree-kids">
      <TaskNode
        v-for="(c, i) in task.children"
        :key="c.id || i"
        :task="c"
        :depth="depth + 1"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { taskStatus, type TeamTask } from '../services/task-client'
import { panDate } from '../services/pan-client'

const props = defineProps<{ task: TeamTask; depth: number }>()

const status = computed(() => taskStatus(props.task))
const metaText = computed(() => {
  const bits: string[] = []
  if (props.task.expiredAt) bits.push('截止 ' + panDate(props.task.expiredAt))
  else if (props.task.finishAt) bits.push('完成 ' + panDate(props.task.finishAt))
  if (props.task.principalName) bits.push(props.task.principalName)
  return bits.join(' · ')
})
</script>

<style scoped>
.tree-task { padding: 4px 0; }
.tree-line { display: flex; align-items: flex-start; gap: 6px; }
.tree-title {
  flex: 1;
  font-size: 13px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.d-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}
.d-tag.doing { color: var(--info-text); border-color: var(--border); background: var(--info-soft); }
.d-tag.done { color: var(--success); border-color: var(--border); background: var(--success-soft); }
.d-tag.over { color: var(--danger); border-color: var(--border); background: var(--danger-soft); }
.tree-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
</style>