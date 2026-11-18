/**
 * 消息内容归一与渲染片段。
 * 结构逆向自官方 home.js：
 *   96 RICHTEXT → [{msg_type:1, content:'文本'}, {msg_type:2, content:'{...图片JSON}'}]
 *   99 COMPLEX  → {brief, contents:[{content}]}，content 有时是 HTML
 *   24 COMBINE  → {brief, msgs:[...]}
 */
import { MsgType } from './types'
import { appendFaceText } from './official-face'
import type { ImMessage } from './im-client'

export interface ImageMeta {
  storeV1?: boolean
  downloadUrl: string
  extension: string
  size: number
  fileName: string
}

export type MessageSegment =
  /** html 为 true 时按富文本渲染；普通文本保持字面内容，标签原样显示。 */
  | { type: 'text'; text: string; html?: boolean }
  | { type: 'card'; title: string; brief: string; more: string; action: string }
  | ({ type: 'image' } & ImageMeta)
  | ({ type: 'file' } & ImageMeta)
  | ({ type: 'audio' | 'video' } & ImageMeta)

export function richTextToPlain(content: any): string {
  let blocks = content
  if (typeof blocks === 'string') {
    try {
      blocks = JSON.parse(blocks)
    } catch {
      return blocks
    }
  }
  if (!Array.isArray(blocks)) return typeof content === 'string' ? content : ''
  const parts: string[] = []
  for (const block of blocks) {
    if (!block) continue
    if (block.msg_type === 1) {
      parts.push(typeof block.content === 'string' ? block.content : '')
    } else if (block.msg_type === 2) {
      parts.push('[图片]')
    } else if (block.msg_type === 3) {
      parts.push('[文件]')
    } else if (typeof block.content === 'string') {
      parts.push(block.content)
    }
  }
  return parts.join('')
}

export function complexToPlain(content: any): string {
  if (!content || typeof content !== 'object') {
    return typeof content === 'string' ? content : '[复杂消息]'
  }
  const parts: string[] = []
  if (content.brief) parts.push(String(content.brief))
  for (const item of content.contents || []) {
    if (item && typeof item.content === 'string' && item.content.trim()) {
      parts.push(item.content.trim())
    }
  }
  return parts.filter((p, i) => parts.indexOf(p) === i).join('\n')
}

export function combineToPlain(content: any): string {
  if (!content || typeof content !== 'object') return '[聊天记录]'
  const count = Array.isArray(content.msgs) ? content.msgs.length : 0
  const brief = content.brief || '[聊天记录]'
  const who =
    content.from_name && content.to_name
      ? `${content.from_name} → ${content.to_name}`
      : ''
  return `${brief}${count ? `（${count} 条）` : ''}${who ? ` · ${who}` : ''}`
}

export function imageMeta(content: any): ImageMeta {
  let c = content
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c)
    } catch {
      c = {}
    }
  }
  c = c || {}
  return {
    downloadUrl: c.download_url || '',
    extension: c.extension || '',
    size: Number(c.size) || 0,
    fileName: c.file_name || c.show_name || '',
  }
}

export function richTextToSegments(content: any): MessageSegment[] {
  let blocks = content
  if (typeof blocks === 'string') {
    try {
      blocks = JSON.parse(blocks)
    } catch {
      return [{ type: 'text', text: blocks, html: looksLikeHtml(blocks) }]
    }
  }
  if (!Array.isArray(blocks)) {
    return [{ type: 'text', text: String(content ?? '') }]
  }
  const out: MessageSegment[] = []
  for (const block of blocks) {
    if (!block) continue
    if (block.msg_type === 1) {
      if (typeof block.content === 'string') {
        out.push({ type: 'text', text: block.content, html: looksLikeHtml(block.content) })
      }
    } else if (block.msg_type === 2) {
      out.push({ type: 'image', ...imageMeta(block.content) })
    } else if (block.msg_type === 3) {
      out.push({ type: 'file', ...imageMeta(block.content) })
    } else if (typeof block.content === 'string') {
      out.push({ type: 'text', text: block.content })
    }
  }
  return out
}

export function toPlainText(msgType: number, content: any): string {
  const c = content
  switch (msgType) {
    case MsgType.TEXT:
      return typeof c === 'string' ? c : ''
    case MsgType.RICHTEXT:
      return richTextToPlain(c)
    case MsgType.COMPLEX:
      return complexToPlain(c)
    case MsgType.COMBINE:
      return combineToPlain(c)
    case MsgType.PHOTO:
      return c?.file_name ? `[图片] ${c.file_name}` : '[图片]'
    case MsgType.FILE:
    case MsgType.FILEONLINE:
      return c?.file_name ? `[文件] ${c.file_name}` : '[文件]'
    case MsgType.AUDIO:
    case MsgType.VOICE:
      return '[语音]'
    case MsgType.VEDIO:
    case MsgType.BIGVIDEO:
      return '[视频]'
    case MsgType.EVENT:
      return c?.title ? `[日程] ${c.title}` : '[日程]'
    case MsgType.SHARE:
      return c?.msg_content || c?.brief
        ? `[分享] ${c.msg_content || c.brief}`
        : '[分享]'
    case MsgType.SERVICE:
      return c?.brief || '[服务消息]'
    case MsgType.BULLETIN:
      return c?.title ? `[公告] ${c.title}` : '[群公告]'
    case MsgType.WINDOWSHAKE:
      return '[窗口抖动]'
    case MsgType.CARD:
      return c?.name ? `[名片] ${c.name}` : '[名片]'
    case MsgType.SCHEDULE:
      return c?.title ? `[日程] ${c.title}` : '[日程]'
    case MsgType.ADAPTIVECAED:
    case MsgType.TEMPLATECARD:
      return c?.brief || '[卡片消息]'
    case MsgType.EMOJI:
      return typeof c === 'string' ? c : c?.brief || '[表情]'
    case MsgType.NEWDISKSHARE:
      return c?.file_name ? `[云盘文件] ${c.file_name}` : '[云盘文件]'
    case MsgType.RECALL:
    case MsgType.ADMINRECALL:
      return '[消息已撤回]'
    case MsgType.CTRL:
    case MsgType.READED:
    case MsgType.RECEIPT:
      return ''
    default:
      return msgType ? `[消息 ${msgType}]` : ''
  }
}

/** 一条消息 → 可渲染片段（合并转发单独走卡片）。 */
export function segmentsOf(msgType: number, content: any): MessageSegment[] {
  if (msgType === MsgType.COMPLEX && Number(content?.type) === 5 && Array.isArray(content.contents)) {
    const cards: MessageSegment[] = content.contents.map((item: any) => {
      const card = item?.content
      return {
        type: 'card',
        title: typeof card?.title === 'string' ? card.title : '',
        brief: typeof card?.brief === 'string' ? card.brief : '',
        more: typeof card?.more === 'string' ? card.more : '',
        action: typeof item?.action_param === 'string' ? item.action_param : '',
      }
    })
    if (cards.length) return cards
  }
  // 官方 99/type 0、1 才把 contents[].content 当 HTML；其余分支按字面文本。
  if (msgType === MsgType.COMPLEX && rendersHtml(msgType, content) && Array.isArray(content?.contents)) {
    const html = content.contents
      .map((item: any) => (typeof item?.content === 'string' ? item.content : ''))
      .filter(Boolean)
      .join('')
    if (html) return [{ type: 'text', text: html, html: true }]
  }
  if (msgType === MsgType.EMOJI && content?.emojiUrl) return [{ type: 'image', downloadUrl: String(content.emojiUrl), extension: String(content.emojiExt || ''), fileName: String(content.brief || '表情'), size: 0, storeV1: true }]
  if ([MsgType.AUDIO, MsgType.VOICE, MsgType.VEDIO, MsgType.BIGVIDEO].includes(msgType)) {
    return [{ type: msgType === MsgType.AUDIO || msgType === MsgType.VOICE ? 'audio' : 'video', ...imageMeta(content) }]
  }
  if (msgType === MsgType.RICHTEXT) return richTextToSegments(content)
  if (msgType === MsgType.PHOTO) {
    return [{ type: 'image', ...imageMeta(content) }]
  }
  if (
    msgType === MsgType.FILE ||
    msgType === MsgType.FILEONLINE ||
    msgType === MsgType.NEWDISKSHARE
  ) {
    return [{ type: 'file', ...imageMeta(content) }]
  }
  const text = toPlainText(msgType, content)
  return text ? [{ type: 'text', text }] : []
}

export interface CombineRow {
  msgType: number
  content: any
  name: string
  text: string
  segments: MessageSegment[]
  time: number
  message?: ImMessage
}

export function combineDetails(content: any): CombineRow[] {
  if (!content || !Array.isArray(content.msgs)) return []
  return content.msgs.map((m: any) => ({
    msgType: Number(m.msg_type),
    content: m.content,
    name: m.from_name || '',
    text: toPlainText(m.msg_type, m.content),
    segments: segmentsOf(m.msg_type, m.content),
    time: m.send_time || 0,
    message: m.msg_id ? { ...m, msg_type: Number(m.msg_type), content: m.content } : undefined,
  }))
}

export function looksLikeHtml(text: unknown): boolean {
  return typeof text === 'string' && /<\/?[a-z][^>]*>/i.test(text)
}

/** 预览用：去标签、解码实体、压空白。 */
export function stripHtml(text: string): string {
  if (!looksLikeHtml(text)) return text
  try {
    const doc = new DOMParser().parseFromString(String(text), 'text/html')
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
  } catch {
    return String(text)
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
}

/** 与官方一致：只有富文本与复合消息的 type 0/1 把内容当 HTML，普通文本按字面显示。 */
export function rendersHtml(msgType: number, content?: any): boolean {
  if (msgType === MsgType.RICHTEXT) return true
  if (msgType === MsgType.COMPLEX) return [0, 1].includes(Number(content?.type))
  return false
}

/** 摘要、复制、引用预览用：只对 HTML 消息去标签，避免吃掉普通文本里的代码。 */
export function messageText(msgType: number, content: any): string {
  const text = toPlainText(msgType, content)
  return rendersHtml(msgType, content) ? stripHtml(text) : text
}

const SAFE_TAGS = new Set([
  'DIV',
  'SPAN',
  'P',
  'BR',
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'CODE',
  'PRE',
])
const SAFE_STYLES = [
  'color',
  'background-color',
  'font-weight',
  'font-style',
  'text-decoration',
  'padding-left',
  'padding-right',
  'padding-top',
  'padding-bottom',
  'margin-bottom',
  'margin-top',
  'margin-left',
  'border-left',
  'border-left-width',
  'border-left-style',
  'border-left-color',
  'white-space',
  'word-break',
  'overflow',
  'text-overflow',
]

/**
 * 白名单净化。消息 HTML 来自别人，必须当不可信输入处理：
 * 保留排版标签/安全行内样式，丢弃 script、事件属性、链接、图片。
 */
export function sanitizeHtml(html: string): string {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(String(html), 'text/html')
  } catch {
    return escapeHtml(String(html))
  }
  const out = document.createElement('div')
  const walk = (node: Node, parent: HTMLElement) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        appendFaceText(parent, child.nodeValue || '')
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as HTMLElement
      const tag = el.tagName
      if (
        tag === 'SCRIPT' ||
        tag === 'STYLE' ||
        tag === 'IFRAME' ||
        tag === 'OBJECT' ||
        tag === 'IMG' ||
        tag === 'LINK'
      ) {
        continue
      }
      if (tag === 'BR') {
        parent.appendChild(document.createElement('br'))
        continue
      }
      if (!SAFE_TAGS.has(tag)) {
        walk(el, parent)
        continue
      }
      const safe = document.createElement(tag.toLowerCase())
      for (const prop of SAFE_STYLES) {
        const v = el.style && el.style.getPropertyValue(prop)
        if (v) safe.style.setProperty(prop, v)
      }
      walk(el, safe)
      parent.appendChild(safe)
    }
  }
  walk(doc.body, out)
  return out.innerHTML
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function humanSize(bytes: number): string {
  const n = Number(bytes) || 0
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

export function fmtMsgTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hm = d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? hm
    : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
        ' ' +
        hm
}

export function fmtSessionTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
