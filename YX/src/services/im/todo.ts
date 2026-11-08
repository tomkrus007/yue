/** 待办通知动作、只读列表与外部浏览器跳转。 */
import { openUrl } from '@tauri-apps/plugin-opener'
import { parse } from 'json5'
import { DEFAULT_CONFIG, getServerPaths } from '../config'
import { authService } from '../auth'
import { httpJson } from '../http'
import { stripHtml } from './content'

export type TodoTab = 'todo' | 'read' | 'done'
export interface TodoItem {
  id: string
  title: string
  brief?: string
  source?: string
  dealTerminal?: number
  action?: string | { pc?: string; android?: string }
}

/** 同时兼容真实换行与动作字符串中的字面量 \\n，保留 URL 内的等号。 */
export function actionParams(action: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const line of action.replace(/\\n/g, '\n').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) result[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return result
}

export function todoTarget(action: string): { tab: TodoTab; source: string } | null {
  if (!action.includes('[UnityTodo]')) return null
  const params = actionParams(action)
  return { tab: params.defaultIndex === '1' ? 'read' : params.defaultIndex === '2' ? 'done' : 'todo', source: params.source || '' }
}

export function safeWebUrl(value: string): string {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

const OPEN_URL = '[OpenUrl]'

/** 还原动作串里的转义：官方数据既有字面量 \n，也有真实换行。 */
function decodeActionText(raw: string): string {
  return raw
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
}

/** 从已解析的数据里取电脑端动作，优先取真正带 [OpenUrl] 的字段。 */
function actionTextFrom(data: any): string {
  if (Array.isArray(data)) {
    for (const item of data) {
      const value = actionTextFrom(item)
      if (value) return value
    }
    return ''
  }
  if (!data || typeof data !== 'object') return ''
  const values = ['pc', 'android', 'app']
    .map(key => data[key])
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
  return values.find(value => value.trim().startsWith(OPEN_URL)) || values[0] || ''
}

/** 兜底：从对象字面量里抽取字符串值，不执行任何表达式。 */
function extractActionLiteral(text: string): string {
  for (const key of ['pc', 'android', 'app']) {
    const match = new RegExp(`${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`).exec(text)
    if (!match) continue
    const value = decodeActionText(match[1].slice(1, -1))
    if (value.trim()) return value
  }
  return ''
}

/**
 * 读出动作串。官方会先把真实换行压成空格再 JSON.parse（失败才 eval），
 * 因为服务端下发的 JSON 字符串里常内嵌未转义的换行。
 */
function readAction(action: unknown, depth = 0): string {
  if (action && typeof action === 'object') return actionTextFrom(action)
  if (typeof action !== 'string' || depth > 2) return ''
  const text = action.trim()
  if (!text) return ''
  if (text.startsWith(OPEN_URL)) return text
  const flat = text.replace(/[\r\n]+/g, ' ')
  for (const candidate of [text, flat]) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      try { parsed = parse(candidate) } catch { continue }
    }
    const value = typeof parsed === 'string' ? readAction(parsed, depth + 1) : actionTextFrom(parsed)
    if (value) return value
  }
  return extractActionLiteral(text)
}

export function todoUrl(action: unknown): string {
  const pc = readAction(action).trim()
  if (!pc) return ''
  if (!pc.startsWith(OPEN_URL)) return safeWebUrl(pc)
  // 只把「key=」前的空白当分隔符，避免切断 URL 里未编码的空格。
  const params = actionParams(pc.slice(OPEN_URL.length).replace(/\s+(?=[\w.-]+\s*=)/g, '\n'))
  const value = safeWebUrl(params.url || params.pcHomeUrl || '')
  if (!value) return ''
  const url = new URL(value)
  for (const [key, val] of Object.entries(params)) {
    if (key !== 'url' && key !== 'pcHomeUrl' && !key.startsWith('win_')) url.searchParams.append(key, val)
  }
  return url.href
}

function base(): string {
  return String(getServerPaths().toDoUri || '').replace(/\/+$/, '')
}

function todoGet(path: string) {
  if (!authService.getAccessToken()) throw new Error('登录凭证已失效，请重新登录')
  return httpJson<any>(base() + path, { tokenInQuery: true, extraHeaders: {
    ClientType: 'pc', version: DEFAULT_CONFIG.version2, displayVersion: DEFAULT_CONFIG.version,
  } })
}

export async function listTodos(tab: TodoTab, source: string, title: string, page: number): Promise<{ items: TodoItem[]; total: number }> {
  const paths = { todo: '/v1/api/todos', read: '/v1/api/toreads', done: '/api/todo/done_list' }
  const query = new URLSearchParams({ page: String(page), limit: '20', total: 'true', source, title, dealTerminal: '0', orderBy: '' })
  let response: any
  try {
    response = await todoGet(paths[tab] + '?' + query)
  } catch (e) {
    const label = { todo: '待办', read: '待阅', done: '已办' }[tab]
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`${label}列表（${paths[tab]}）请求失败：${detail}`)
  }
  const data = response?.data
  const items = Array.isArray(data) ? data : data?.data
  if (!Array.isArray(items)) throw new Error('待办列表响应格式不正确')
  return { items, total: Number(response.total ?? data?.total ?? items.length) }
}

/** 通知没有条目 ID 时，只打开来源和标题能唯一匹配的详情。 */
export async function resolveTodoNotice(card: { title: string; brief: string; action: string }): Promise<string> {
  const direct = todoUrl(card.action)
  if (direct) return direct
  const target = todoTarget(card.action)
  if (!target) throw new Error('该消息没有可打开的待办链接')
  const normalize = (text: string) => stripHtml(text).replace(/\s+/g, '').trim()
  const titleText = stripHtml(card.title).replace(/\s+/g, ' ').trim()
  const genericTitle = /^(?:您|你)有一条新的待[办阅]$/
  const title = !titleText || genericTitle.test(titleText)
    ? stripHtml(card.brief).replace(/\s+/g, ' ').trim()
    : titleText
  if (!title || genericTitle.test(title)) throw new Error('消息缺少具体待办标题，无法定位详情')
  // 历史通知对应的条目可能已经从待办移到已办。
  const tabs: TodoTab[] = [target.tab, ...(['todo', 'read', 'done'] as TodoTab[]).filter(tab => tab !== target.tab)]
  const fallbackErrors: string[] = []
  for (const tab of tabs) {
    const matches = new Map<string, TodoItem>()
    try {
      for (let page = 1; ; page++) {
        const result = await listTodos(tab, target.source, title, page)
        for (const item of result.items) {
          if (target.source && item.source !== target.source) continue
          if (normalize(title) === normalize(item.title)) matches.set(String(item.id), item)
        }
        if (matches.size > 1) break
        if (page * 20 >= result.total || !result.items.length) break
      }
    } catch (e) {
      if (tab === target.tab) throw e
      fallbackErrors.push(e instanceof Error ? e.message : String(e))
      continue
    }
    if (matches.size > 1) throw new Error('找到多条同名待办，无法确定这条消息对应的详情')
    const item = matches.values().next().value
    if (!item) continue
    if (Number(item.dealTerminal) === 3) throw new Error('该待办请在移动端处理')
    const url = todoUrl(item.action)
    if (!url) throw new Error('该待办未提供可打开的电脑端链接')
    return url
  }
  if (fallbackErrors.length) throw new Error(fallbackErrors.join('；'))
  throw new Error('未找到这条消息对应的待办，可能已删除或不再可见')
}

/** 直接交给系统默认浏览器，不请求 SSO/CAS 或兑换登录票据。 */
export async function openTodoInBrowser(service: string): Promise<void> {
  const url = safeWebUrl(service)
  if (!url) throw new Error('待办链接无效')
  await openUrl(url)
}
