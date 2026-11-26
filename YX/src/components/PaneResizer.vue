<template>
  <div
    class="pane-resizer"
    :class="{ dragging }"
    role="separator"
    aria-orientation="vertical"
    aria-label="拖动调整分栏宽度"
    :aria-valuenow="Math.round(modelValue)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    title="拖动调整宽度"
    @pointerdown="start"
    @pointermove="move"
    @pointerup="stop"
    @pointercancel="stop"
    @lostpointercapture="endDrag"
  ></div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 被拖动分栏的当前宽度（px） */
    modelValue: number
    min?: number
    max?: number
    /** 给右侧主区保留的宽度（px），窗口过窄时限制被拖分栏的最大宽度 */
    reserve?: number
    /** 记住拖完后的宽度；不同分栏用不同 key */
    storageKey?: string
  }>(),
  { min: 240, max: 640, reserve: 360 },
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const dragging = ref(false)
let dragStart: { x: number; width: number; pointerId: number } | null = null
let lastWidth = props.modelValue

function clamp(width: number): number {
  const viewportMax = window.innerWidth - props.reserve
  const max = Math.max(props.min, Math.min(props.max, viewportMax))
  return Math.round(Math.max(props.min, Math.min(max, width)))
}

function start(event: PointerEvent) {
  if (event.button !== 0 || dragStart) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  dragStart = { x: event.clientX, width: props.modelValue, pointerId: event.pointerId }
  lastWidth = props.modelValue
  dragging.value = true
}

function move(event: PointerEvent) {
  const start = dragStart
  if (!start || start.pointerId !== event.pointerId) return
  lastWidth = clamp(start.width + event.clientX - start.x)
  emit('update:modelValue', lastWidth)
}

function stop(event: PointerEvent) {
  if (!dragStart || dragStart.pointerId !== event.pointerId) return
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
  endDrag()
}

function endDrag() {
  dragStart = null
  dragging.value = false
  if (!props.storageKey) return
  try {
    localStorage.setItem(props.storageKey, String(lastWidth))
  } catch {
    /* 存不下就算了 */
  }
}

onMounted(() => {
  if (!props.storageKey) return
  const saved = Number(localStorage.getItem(props.storageKey))
  if (!Number.isFinite(saved) || saved <= 0) return
  lastWidth = clamp(saved)
  emit('update:modelValue', lastWidth)
})
</script>

<style scoped>
.pane-resizer {
  position: relative;
  z-index: 1;
  cursor: col-resize;
  touch-action: none;
  background: transparent;
}
.pane-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: var(--border);
  transition: background 0.12s, width 0.12s;
}
.pane-resizer:hover::after,
.pane-resizer.dragging::after {
  width: 2px;
  background: var(--primary);
}
:global(body:has(.pane-resizer.dragging)),
:global(body:has(.pane-resizer.dragging) *) {
  cursor: col-resize !important;
  user-select: none !important;
}
</style>
