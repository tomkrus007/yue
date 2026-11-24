<template>
  <div class="msg-content" @click="onContentClick">
    <!-- 合并转发：默认展开，仍可手动收起 -->
    <details v-if="msgType === MsgType.COMBINE && (depth || 0) < 8" class="combine" :open="!!rows.length" @toggle="onCombineToggle">
      <summary>{{ replaceEmojiAliases(combineText) }}</summary>
      <div class="combine-body">
        <div v-if="!rows.length" class="hint">（明细未随消息下发）</div>
        <p v-if="combineLoading" class="hint">正在补全明细…</p>
        <p v-if="combineError" class="todo-error" role="status">{{ combineError }}</p>
        <div v-for="(row, i) in rows" :key="i" class="combine-row">
          <div class="combine-head">
            <span class="who">{{ row.name || '—' }}</span>
            <span class="when">{{ fmtMsgTime(row.time) }}</span>
          </div>
          <details v-if="row.message?.reply_msg_id" class="nested-quote">
            <summary>引用 {{ nestedReply(row)?.from_name || row.message.reply_from_name || '原消息' }}</summary>
            <MessageContent v-if="nestedReply(row)" :msg-type="Number(nestedReply(row)!.msg_type)" :content="nestedReply(row)!.content" :depth="(depth || 0) + 1" @preview="$emit('preview', $event)" />
            <span v-else>引用原文未随记录下发</span>
          </details>
          <MessageContent
            v-if="!rowProtected(row)"
            :msg-type="row.msgType"
            :content="row.content"
            :segments-override="row.segments.length ? row.segments : undefined"
            :depth="(depth || 0) + 1"
            :action-context="rowContext(row)"
            @preview="$emit('preview', $event)"
          />
          <p v-else class="hint">受保护消息不在转发记录中展开。</p>
        </div>
      </div>
    </details>
    <p v-else-if="msgType === MsgType.COMBINE" class="hint">记录嵌套较深，请在原会话中查看后续内容。</p>

    <AdaptiveMessage v-else-if="[MsgType.ADAPTIVECAED, MsgType.TEMPLATECARD, MsgType.NOTICE].includes(msgType)" :content="content" :action-context="actionContext" />

    <!-- 普通消息：文本 / 图片 / 文件片段 -->
    <section v-else-if="specialCard" class="message-card">
      <strong>{{ specialCard.title }}</strong>
      <span>{{ specialCard.brief }}</span>
      <button v-if="msgType === MsgType.CARD && content?.card_id && [1, 2, 5].includes(Number(content.card_type))" class="card-action" @click.stop="openContactCard">查看名片</button>
      <button v-if="specialCard.url" class="card-action" @click.stop="openSpecialCard">打开链接</button>
      <AdaptiveMessage v-else-if="specialActionCard" :content="specialActionCard" :action-context="actionContext" />
    </section>
    <template v-else>
      <template v-if="segments.length">
        <template v-for="(seg, i) in segments" :key="i">
          <div v-if="seg.type === 'card'" class="message-card">
            <strong>{{ seg.title || '通知' }}</strong>
            <div v-if="seg.brief" v-html="sanitizeHtml(seg.brief)"></div>
            <details v-if="seg.more"><summary>更多</summary><div v-html="sanitizeHtml(seg.more)"></div></details>
            <button v-if="todoTarget(seg.action) || todoUrl(seg.action)" class="card-action" title="在系统默认浏览器中打开" :disabled="openingTodo" @click.stop="openTodo(seg)">{{ openingTodo ? '正在打开…' : '查看' + (todoTarget(seg.action)?.tab === 'read' ? '待阅' : todoTarget(seg.action)?.tab === 'done' ? '已办' : '待办') }}</button>
            <AdaptiveMessage v-else-if="seg.action" :content="complexCardAction(seg)" :action-context="actionContext" />
          </div>
          <div v-else-if="seg.type === 'meeting'" class="message-card">
            <strong>🎥 {{ seg.title }}</strong>
            <span class="meeting-detail">{{ seg.detail }}</span>
            <button class="card-action" :disabled="joiningMeeting === seg.code" @click.stop="joinMeeting(seg.code)">
              {{ joiningMeeting === seg.code ? '正在加入…' : '加入会议' }}
            </button>
          </div>
          <span
            v-else-if="seg.type === 'text'"
            :class="{ html: isHtml(seg), ph: isPlaceholder(seg.text, segments.length) }"
          >
            <span v-if="isHtml(seg)" v-html="sanitizeHtml(seg.text)"></span>
            <span v-else v-html="faceTextHtml(seg.text)"></span>
          </span>
          <MessageImage
            v-else-if="seg.type === 'image'"
            :seg="seg"
            @preview="$emit('preview', $event)"
          />
          <MessageMedia v-else-if="seg.type === 'audio' || seg.type === 'video'" :seg="seg" />
          <span
            v-else-if="seg.type === 'file'"
            class="imgchip filechip"
            :title="canPreviewFile(seg) ? '在浏览器中预览' : seg.downloadUrl ? '点击下载' : '缺少下载地址'"
            @click.stop="canPreviewFile(seg) ? previewFile(seg) : download(seg)"
          >
            📎 {{ seg.fileName || '文件' }}{{ seg.size ? ' · ' + humanSize(seg.size) : '' }}
            <button v-if="canPreviewFile(seg)" class="file-action" :disabled="openingFile" @click.stop="previewFile(seg)">{{ openingFile ? '正在打开…' : '预览' }}</button>
            <DownloadButton :seg="seg" />
          </span>
        </template>
      </template>
      <span v-else class="ph">[非文本消息]</span>
    </template>
    <p v-if="todoError" class="todo-error" role="alert">{{ todoError }}</p>
    <p v-if="linkError" class="todo-error" role="alert">{{ linkError }}</p>
    <p v-if="meetingError" class="todo-error" role="alert">{{ meetingError }}</p>
    <p v-if="fileError" class="todo-error" role="alert">{{ fileError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { useRouter } from 'vue-router'
import { openUrl } from '@tauri-apps/plugin-opener'
import { replaceEmojiAliases } from '../services/im/emoji'
import { faceTextHtml } from '../services/im/official-face'
import { MsgType } from '../services/im/types'
import type { CardActionContext } from '../services/im/card-actions'
import { authService } from '../services/auth'
import { forwardRowContext } from '../services/im/forwarding'
import { useImStore } from '../stores/im'
import type { ImMessage } from '../services/im/im-client'
import {
  combineDetails,
  combineToPlain,
  fmtMsgTime,
  humanSize,
  sanitizeHtml,
  segmentsOf,
  type MessageSegment,
  type CombineRow,
} from '../services/im/content'
import { canPreviewFile, filePreviewUrl } from '../services/im/media'
import type { ImageMeta } from '../services/im/content'
import MessageImage from './MessageImage.vue'
import MessageMedia from './MessageMedia.vue'
import DownloadButton from './DownloadButton.vue'
import { useDownloadsStore } from '../stores/downloads'
import { useWeMeetStore } from '../stores/wemeet'
import { openTodoInBrowser, resolveTodoNotice, todoTarget, todoUrl } from '../services/im/todo'
import { msgLinkHref } from '../services/im/autolink'

const AdaptiveMessage = defineAsyncComponent(() => import('./AdaptiveMessage.vue'))
const router = useRouter()
function openContactCard() {
  const c = props.content
  const kind = ({ 1: 'user', 2: 'group', 5: 'serviceno' } as Record<number, string>)[Number(c?.card_type)]
  if (kind && c.card_id) void router.push({ path: `/contact/${kind}/${encodeURIComponent(c.card_id)}`, query: { name: c.card_name || '' } })
}
const specialCard = computed(() => {
  const c = props.content
  if (!c || typeof c !== 'object') return null
  if (props.msgType === MsgType.CARD) return { title: '名片', brief: String(c.card_name || c.name || '未命名名片'), url: '', action: '' }
  if (props.msgType === MsgType.SHARE) {
    const action = typeof (c.action_param || c.url) === 'string' ? c.action_param || c.url : ''
    return { title: '分享', brief: String(c.msg_content || c.brief || '分享内容'), url: safeCardUrl(action), action }
  }
  if (props.msgType === MsgType.SERVICE) return { title: String(c.title || '服务消息'), brief: String(c.brief || ''), url: '', action: typeof (c.action_params || c.action_param) === 'string' ? c.action_params || c.action_param : '' }
  if ([MsgType.SCHEDULE, MsgType.EVENT].includes(props.msgType)) return { title: String(c.title || '日程'), brief: String(c.brief || c.description || ''), url: safeCardUrl(c.url), action: '' }
  return null
})
const specialActionCard = computed(() => specialCard.value?.action ? complexCardAction({ type: 'card', title: specialCard.value.title, brief: specialCard.value.brief, more: '', action: specialCard.value.action }) : null)
function safeCardUrl(value: unknown): string {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' } catch { return '' }
}
async function openSpecialCard() {
  try { if (specialCard.value?.url) await openUrl(specialCard.value.url) }
  catch { fileError.value = '打开链接失败，请重试' }
}

/** 会议邀请卡片：拿会议号直接入会（与官方的 [JoinWeMeet] 行为一致）。 */
async function joinMeeting(code: string) {
  if (!code || joiningMeeting.value) return
  joiningMeeting.value = code
  meetingError.value = ''
  try {
    await useWeMeetStore().joinMeeting(code)
  } catch (error) {
    meetingError.value = error instanceof Error ? error.message : '加入会议失败'
  } finally {
    joiningMeeting.value = ''
  }
}

const openingTodo = ref(false)
const todoError = ref('')
const linkError = ref('')
const meetingError = ref('')
const joiningMeeting = ref('')
const openingFile = ref(false)
const fileError = ref('')

/** 正文里的链接统一交给系统浏览器，避免 WebView 把应用导航到外部页面。 */
async function onContentClick(event: MouseEvent) {
  const href = msgLinkHref(event.target)
  if (!href) return
  event.preventDefault()
  event.stopPropagation()
  // 拖选文本结束时也会触发 click，别在选中文字时误开浏览器。
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) return
  linkError.value = ''
  try {
    await openUrl(href)
  } catch {
    linkError.value = '打开链接失败，请重试'
  }
}

async function previewFile(seg: ImageMeta) {
  if (openingFile.value) return
  openingFile.value = true
  fileError.value = ''
  try {
    await openUrl(await filePreviewUrl(seg))
  } catch (e) {
    const detail = e instanceof Error ? e.message : '未知错误'
    fileError.value = '打开预览失败：' + detail.replace(/https?:\/\/[^\s)]+/g, '[请求地址]')
  } finally {
    openingFile.value = false
  }
}

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
  actionContext?: CardActionContext
  depth?: number
}>()

defineEmits<{ preview: [payload: { url: string; name: string }] }>()

const segments = computed<MessageSegment[]>(
  () => props.segmentsOverride || segmentsOf(props.msgType, props.content),
)

const rows = computed(() => combineDetails(props.content))
const combineText = computed(() => combineToPlain(props.content))
const combineLoading = ref(false)
const combineError = ref('')
function nestedReply(row: CombineRow): ImMessage | undefined {
  const message = row.message
  if (!message?.reply_msg_id) return undefined
  const source = rows.value.find(candidate => candidate.message?.msg_id === message.reply_msg_id)?.message
  if (source) return rowProtected({ ...row, message: source }) ? { ...source, msg_type: MsgType.TEXT, content: '[受保护消息]' } : source
  return message.reply_content !== undefined && message.reply_msg_type !== undefined
    ? { ...message, msg_id: message.reply_msg_id, msg_type: message.reply_msg_type, content: message.reply_content, from_name: message.reply_from_name || '未知' }
    : undefined
}
function rowProtected(row: CombineRow): boolean { return String(row.message?.is_need_read_receipt) === 'true' || String(row.message?.is_delete_after_read) === 'true' }
function rowContext(row: CombineRow): CardActionContext | undefined { return forwardRowContext(row.message, authService.getCurrentUserId()) }

async function onCombineToggle(event: Event) {
  if (!(event.target as HTMLDetailsElement).open || rows.value.length || combineLoading.value || !props.actionContext?.message) return
  combineLoading.value = true
  combineError.value = ''
  try { await useImStore().loadForwardDetails(props.actionContext.message) }
  catch (error) { combineError.value = (error instanceof Error ? error.message : '明细加载失败').replace(/https?:\/\/[^\s)]+/g, '[请求地址]') }
  finally { combineLoading.value = false }
}

/** 复杂通知的动作复用同一自适应卡片执行入口，避免两套指令实现。 */
function complexCardAction(card: Extract<MessageSegment, { type: 'card' }>) {
  return {
    title: card.title,
    brief: card.brief,
    cardContent: { type: 'AdaptiveCard', version: '1.3', body: [], actions: [{ type: 'Action.OpenUrl', title: '打开', url: card.action }] },
  }
}

function isPlaceholder(text: string, total: number): boolean {
  return total === 1 && /^\[[^\]]*\]$/.test(replaceEmojiAliases(text))
}

/** 只有片段明确标记为 HTML（富文本/复合富文本）才解析标签，普通文本按字面显示。 */
function isHtml(seg: MessageSegment): boolean {
  return seg.type === 'text' && seg.html === true
}

function download(seg: ImageMeta) {
  void useDownloadsStore().start(seg).catch(() => { fileError.value = '下载失败，可点击重新下载查看或重试' })
}
</script>

<style scoped>
.msg-content :deep(.official-face) { width: 24px; height: 24px; vertical-align: middle; display: inline-block; }
.msg-content :deep(.msg-link) { color: var(--link); text-decoration: underline; cursor: pointer; }
.msg-content { word-break: break-word; line-height: 1.5; text-align: left; white-space: pre-wrap; }
.msg-content :deep(.html) { display: block; }
.msg-content :deep(.html div),
.msg-content :deep(.html p) { margin: 0; }
.msg-content .ph { color: var(--text-muted); }
.message-card { display: flex; flex-direction: column; gap: 8px; min-width: 200px; padding: 8px; }
.message-card details { font-size: 13px; }
.meeting-detail { color: var(--text-muted); font-size: 12px; }
.card-action { align-self: flex-start; color: var(--link); border: 0; background: transparent; padding: 4px 0; cursor: pointer; }
.todo-error { color: var(--danger); font-size: 12px; margin-top: 8px; }
.filechip {
  display: inline-block;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--chip-bg);
  color: var(--chip-text);
  font-size: 13px;
  cursor: pointer;
  max-width: 100%;
}
.filechip:hover { background: var(--hover); }
.file-action { margin-left: 10px; border: 0; background: transparent; color: var(--link); cursor: pointer; padding: 2px 0; }
.file-action:disabled { cursor: default; opacity: 0.5; }

.combine {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-subtle);
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
