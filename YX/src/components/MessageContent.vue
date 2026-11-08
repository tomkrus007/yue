<template>
  <div class="msg-content">
    <!-- 合并转发：默认展开，仍可手动收起 -->
    <details v-if="msgType === MsgType.COMBINE" class="combine" open>
      <summary>{{ replaceEmojiAliases(combineText) }}</summary>
      <div class="combine-body">
        <div v-if="!rows.length" class="hint">（明细未随消息下发）</div>
        <div v-for="(row, i) in rows" :key="i" class="combine-row">
          <div class="combine-head">
            <span class="who">{{ row.name || '—' }}</span>
            <span class="when">{{ fmtMsgTime(row.time) }}</span>
          </div>
          <MessageContent
            :msg-type="row.msgType"
            :content="row.content"
            :segments-override="row.segments.length ? row.segments : undefined"
            @preview="$emit('preview', $event)"
          />
        </div>
      </div>
    </details>

    <!-- 普通消息：文本 / 图片 / 文件片段 -->
    <template v-else>
      <template v-if="segments.length">
        <template v-for="(seg, i) in segments" :key="i">
          <div v-if="seg.type === 'card'" class="message-card">
            <strong>{{ seg.title || '通知' }}</strong>
            <div v-if="seg.brief" v-html="sanitizeHtml(seg.brief)"></div>
            <details v-if="seg.more"><summary>更多</summary><div v-html="sanitizeHtml(seg.more)"></div></details>
            <button v-if="todoTarget(seg.action) || todoUrl(seg.action)" class="card-action" title="在系统默认浏览器中打开" :disabled="openingTodo" @click.stop="openTodo(seg)">{{ openingTodo ? '正在打开…' : '查看' + (todoTarget(seg.action)?.tab === 'read' ? '待阅' : todoTarget(seg.action)?.tab === 'done' ? '已办' : '待办') }}</button>
          </div>
          <span
            v-else-if="seg.type === 'text'"
            :class="{ html: looksLikeHtml(seg.text), ph: isPlaceholder(seg.text, segments.length) }"
          >
            <span v-if="looksLikeHtml(seg.text)" v-html="sanitizeHtml(seg.text)"></span>
            <template v-else>{{ replaceEmojiAliases(seg.text) }}</template>
          </span>
          <MessageImage
            v-else-if="seg.type === 'image'"
            :seg="seg"
            @preview="$emit('preview', $event)"
          />
          <span
            v-else-if="seg.type === 'file'"
            class="imgchip filechip"
            :title="seg.downloadUrl ? '点击下载' : '缺少下载地址'"
            @click.stop="download(seg)"
          >
            📎 {{ seg.fileName || '文件' }}{{ seg.size ? ' · ' + humanSize(seg.size) : '' }}
          </span>
        </template>
      </template>
      <span v-else class="ph">[非文本消息]</span>
    </template>
    <p v-if="todoError" class="todo-error" role="alert">{{ todoError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { replaceEmojiAliases } from '../services/im/emoji'
import { MsgType } from '../services/im/types'
import {
  combineDetails,
  combineToPlain,
  fmtMsgTime,
  humanSize,
  looksLikeHtml,
  sanitizeHtml,
  segmentsOf,
  type MessageSegment,
} from '../services/im/content'
import { fileUrl } from '../services/im/media'
import type { ImageMeta } from '../services/im/content'
import MessageImage from './MessageImage.vue'
import { openTodoInBrowser, resolveTodoNotice, todoTarget, todoUrl } from '../services/im/todo'

const openingTodo = ref(false)
const todoError = ref('')

async function openTodo(card: Extract<MessageSegment, { type: 'card' }>) {
  if (openingTodo.value) return
  openingTodo.value = true
  todoError.value = ''
  let stage = '查询待办详情'
  try {
    const url = await resolveTodoNotice(card)
    stage = '打开系统浏览器'
    await openTodoInBrowser(url)
  } catch (e) {
    const detail = e instanceof Error ? e.message : typeof e === 'string' ? e : '未知错误'
    todoError.value = `打开待办失败（${stage}）：${detail.replace(/https?:\/\/[^\s)]+/g, '[请求地址]')}`
  } finally {
    openingTodo.value = false
  }
}

const props = defineProps<{
  msgType: number
  content: any
  segmentsOverride?: MessageSegment[]
}>()

defineEmits<{ preview: [payload: { url: string; name: string }] }>()

const segments = computed<MessageSegment[]>(
  () => props.segmentsOverride || segmentsOf(props.msgType, props.content),
)

const rows = computed(() => combineDetails(props.content))
const combineText = computed(() => combineToPlain(props.content))

function isPlaceholder(text: string, total: number): boolean {
  return total === 1 && /^\[[^\]]*\]$/.test(replaceEmojiAliases(text))
}

function download(seg: ImageMeta) {
  const url = fileUrl(seg)
  if (!url) return
  openUrl(url).catch(() => {
    const a = document.createElement('a')
    a.href = url
    a.download = seg.fileName || ''
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  })
}
</script>

<style scoped>
.msg-content { word-break: break-word; line-height: 1.5; text-align: left; }
.msg-content :deep(.html) { display: block; }
.msg-content :deep(.html div),
.msg-content :deep(.html p) { margin: 0; }
.msg-content .ph { color: var(--text-muted); }
.message-card { display: flex; flex-direction: column; gap: 8px; min-width: 200px; padding: 8px; }
.message-card details { font-size: 13px; }
.card-action { align-self: flex-start; color: #1677ff; border: 0; background: transparent; padding: 4px 0; cursor: pointer; }
.todo-error { color: var(--danger); font-size: 12px; margin-top: 8px; }
.filechip {
  display: inline-block;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f2f3f5;
  color: #35506b;
  font-size: 13px;
  cursor: pointer;
  max-width: 100%;
}
.filechip:hover { background: #e8eaed; }

.combine {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fafbfc;
  padding: 8px 10px;
  min-width: 200px;
}
.combine summary { cursor: pointer; font-weight: 500; }
.combine-body { margin-top: 8px; max-height: 320px; overflow-y: auto; }
.combine-row { padding: 6px 0; border-top: 1px dashed var(--border); }
.combine-head { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); }
.combine-row .msg-content { font-size: 13px; }
.hint { color: var(--text-muted); font-size: 12px; }
</style>
