import { parse } from 'json5'
import type { ImMessage } from './im-client'

export interface CardActionContext {
  messageId?: string
  sessionId?: string
  sessionName?: string
  sessionType?: number
  message?: ImMessage
}

export type CardActionPlan =
  | { kind: 'url'; url: string }
  | { kind: 'app'; code: string; params: Record<string, string> }
  /** 腾讯会议：`code` 为空表示打开会前主页 */
  | { kind: 'meeting'; code: string }
  | { kind: 'chat'; id: string; type: number; name: string }
  | { kind: 'contact'; id: string; type: number; name: string }
  | { kind: 'request'; data: { url: string; method: string; params: Record<string, unknown>; contentType: string } }
  | { kind: 'message'; target: { id: string; name: string; type: number }; type: 1 | 8; content: string | { key: string } }
  | { kind: 'todo'; action: string }
  | { kind: 'favorite' }
  | { kind: 'close' }
  | { kind: 'notice'; text: string }

function requireText(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`卡片动作缺少${field}`)
  return value.trim()
}

export function actionUrl(value: string, paths: Record<string, unknown> = {}): string {
  const expanded = value.replace(/^\$?\{([^}]+)\}/, (_, key: string) => {
    const base = paths[key] || paths[key + 'Uri']
    if (typeof base !== 'string' || !base) throw new Error(`未下发 ${key} 服务地址`)
    return base
  })
  const url = new URL(expanded)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('卡片链接必须是无账号信息的 HTTP(S) 地址')
  return url.href
}

/** 原版动作以换行分隔参数；只按第一个等号拆分，保留链接、JSON 中的等号。 */
export function instructionParams(value: string): Record<string, string> {
  const params: Record<string, string> = Object.create(null)
  for (const line of value.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index > 0) params[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return params
}

function substitute(value: string, context: CardActionContext): string {
  return value.replace(/\$\{(msgId|sessionId)\}/g, (_, key: string) =>
    requireText(key === 'msgId' ? context.messageId : context.sessionId, key === 'msgId' ? '原消息 ID' : '会话 ID'))
}

function targetType(value: string | number | undefined): number {
  const type = Number(value)
  if (![1, 2, 4, 5, 8].includes(type)) throw new Error('卡片动作的会话类型不受支持')
  return type
}

function requestParams(value: string | undefined, contentType: string, context: CardActionContext): Record<string, unknown> {
  if (!value) return {}
  const text = substitute(value, context)
  if (contentType.startsWith('application/x-www-form-urlencoded') && !text.trim().startsWith('{')) return Object.fromEntries(new URLSearchParams(text))
  const params = parse(text)
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('卡片请求参数必须是对象')
  return params
}

/** 静态还原原版已核实的指令，先解析整批再执行，未知动作不会被静默忽略。 */
export function planCardActions(value: string, context: CardActionContext = {}, paths: Record<string, unknown> = {}): CardActionPlan[] {
  let text = value.trim()
  if (text.startsWith('{')) {
    const platforms = parse(text)
    if (typeof platforms?.pc !== 'string' || !platforms.pc.trim()) throw new Error('此卡片未提供电脑端动作')
    text = platforms.pc.trim()
  }
  if (!/[\r\n]/.test(text)) text = text.replace(/\\r\\n|\\n/g, '\n')
  if (!text) throw new Error('卡片动作没有目标')
  if (!text.startsWith('[')) return [{ kind: 'url', url: actionUrl(text, paths) }]
  return text.split(/\n\s*\n(?=\[)/).map(instruction => {
    const command = /^\[([A-Za-z][A-Za-z0-9]*)\]/.exec(instruction)?.[1]
    if (!command) throw new Error('卡片指令格式无效')
    const params = instructionParams(instruction.replace(/^\[[^\]]+\]/, '\n'))
    switch (command) {
      case 'OpenUrl': case 'OpenSafeBrowser': {
        const url = new URL(actionUrl(requireText(params.pcHomeUrl || params.url, '链接'), paths))
        for (const key of ['groupId', 'win_width', 'win_height']) if (params[key]) url.searchParams.set(key, params[key])
        return { kind: 'url', url: url.href }
      }
      case 'OpenApp': {
        // 腾讯会议邀请：原版点击后直接入会，不经过应用列表
        if (params.appCode === 'linkMeeting' && params.supplier === 'tencent') {
          return { kind: 'meeting', code: (params.meetingCode || '').trim() }
        }
        if (params.pcHomeUrl) {
          const url = new URL(actionUrl(params.pcHomeUrl, paths))
          for (const [key, entry] of Object.entries(params)) if (!['pcHomeUrl', 'pcNoTitleWindow', 'appCode', 'appUrl'].includes(key)) url.searchParams.set(key, entry)
          return { kind: 'url', url: url.href }
        }
        return { kind: 'app', code: requireText(params.appCode, '应用编码'), params }
      }
      case 'OpenChat': return { kind: 'chat', id: requireText(params.id, '会话 ID'), type: targetType(params.targetType), name: params.name || '' }
      case 'OpenItem':
        return params.openMode === 'session'
          ? { kind: 'chat', id: requireText(params.id, '会话 ID'), type: targetType(params.type), name: params.name || '' }
          : { kind: 'url', url: actionUrl(requireText(params.url, '链接'), paths) }
      case 'StartUserCard': return { kind: 'contact', id: requireText(params.id, '用户 ID'), type: 1, name: params.name || '' }
      case 'OpenBuiltIn':
        if (params.key !== 'GroupCard') throw new Error(`暂未接入内置功能：${params.key || '未知'}`)
        return { kind: 'contact', id: requireText(params.groupId, '群 ID'), type: 2, name: params.name || params.groupName || '' }
      case 'RequestUrl': {
        const contentType = params.contentType || 'application/json'
        return { kind: 'request', data: { url: actionUrl(substitute(requireText(params.pcHomeUrl || params.url, '请求地址'), context), paths), method: requireText(params.method, '请求方法'), contentType, params: requestParams(params.params, contentType, context) } }
      }
      case 'Message': {
        let target = { id: context.sessionId || '', name: context.sessionName || '', type: context.sessionType || 0 }
        if (params.targetObj) {
          const raw = parse(params.targetObj)
          target = { id: String(raw?.id || ''), name: String(raw?.name || ''), type: Number(raw?.type) }
        }
        target.id = requireText(target.id, '目标会话 ID')
        target.type = targetType(target.type)
        if (params.actionId) return { kind: 'message', target, type: 8, content: { key: params.actionId } }
        if (Number(params.type) !== 1) throw new Error('此卡片消息动作的类型暂未接入')
        return { kind: 'message', target, type: 1, content: requireText(params.content, '消息内容') }
      }
      case 'UnityTodo': return { kind: 'todo', action: instruction }
      case 'StartWeMeet': return { kind: 'meeting', code: '' }
      case 'JoinWeMeet': return { kind: 'meeting', code: requireText(params.meetingCode, '会议号') }
      case 'FavorMsg':
        if (!context.message) throw new Error('缺少原消息，无法收藏此卡片')
        return { kind: 'favorite' }
      case 'Toast': return { kind: 'notice', text: requireText(params.message, '提示文字') }
      case 'CloseDialog': return { kind: 'close' }
      default: throw new Error(`暂未接入卡片指令：${command}`)
    }
  })
}

/** Action.Link 在原版 5.2.97 中也不支持；带明确 url 时按打开链接兼容。 */
export function compatibleCardActions(value: any): any {
  const fields = new Set(['body', 'items', 'columns', 'images', 'actions', 'card', 'selectAction', 'inlineAction', 'inlines'])
  if (Array.isArray(value)) return value.map(compatibleCardActions)
  if (!value || typeof value !== 'object') return value
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fields.has(key) ? compatibleCardActions(item) : item]))
  if (result.type === 'Action.Link' && typeof result.url === 'string' && result.url.trim()) result.type = 'Action.OpenUrl'
  return result
}
