/**
 * IM 本地缓存仓储层（SQLite）。
 *
 * 只负责三件事：拼 `invoke` 参数、把返回的 JSON 还原成消息、把错误收敛成日志。
 * 业务状态仍是内存里的 Pinia；这里失败时不能让收发消息跟着失败，所以所有
 * 写操作都吞掉异常，读操作失败返回空列表（调用方按“本地无缓存”处理）。
 *
 * 写入串行链保证：退出登录时的 `clearAccount` 一定排在已发出的写入之后。
 */
import { invoke } from '@tauri-apps/api/core'
import { logEvent } from '../app-log'
import type { ImMessage } from './im-client'

export interface PersistedMessage extends ImMessage {
  sessionId: string
  sessionType: number
}

export interface StateEntry {
  key: string
  value: string
}

let unavailable = false
let lastErrorAt = 0

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function report(action: string, error: unknown): void {
  const text = error instanceof Error ? error.message : String(error)
  const now = Date.now()
  // 同一类错误 60 秒内只记一次，避免数据库故障时刷屏。
  if (now - lastErrorAt < 60_000) return
  lastErrorAt = now
  logEvent('存储', `${action}失败：${text}`, 'warn')
}

function skip(): boolean {
  if (unavailable) return true
  if (inTauri()) return false
  unavailable = true
  logEvent('存储', '当前环境不支持本地数据库，IM 数据将只保留在内存', 'warn')
  return true
}

async function call<T>(action: string, command: string, args: Record<string, unknown>): Promise<T | null> {
  if (skip()) return null
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    report(action, error)
    return null
  }
}

/* 写操作串行化：后一个任务一定等前一个结束（无论成功失败）。 */
let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task)
  chain = next.catch(() => {})
  return next
}

function parseMessage(raw: string): PersistedMessage | null {
  try {
    const value = JSON.parse(raw) as PersistedMessage
    if (!value || typeof value.msg_id !== 'string' || !value.sessionId) return null
    return value
  } catch {
    return null
  }
}

function parseMessages(list: string[] | null): PersistedMessage[] {
  if (!Array.isArray(list)) return []
  const result: PersistedMessage[] = []
  for (const raw of list) {
    const message = parseMessage(raw)
    if (message) result.push(message)
  }
  return result
}

/** 批量写入消息；同一批在一个事务里完成。返回 false 表示写入失败，可重试。 */
export function saveMessages(accountId: string, messages: PersistedMessage[]): Promise<boolean> {
  if (!accountId || !messages.length) return Promise.resolve(true)
  const rows = messages
    .filter(message => message && message.msg_id && message.sessionId)
    .map(message => ({
      msgId: String(message.msg_id),
      sessionId: String(message.sessionId),
      sessionType: Number(message.sessionType) || 1,
      sendTime: Number(message.send_time) || 0,
      msgType: Number(message.msg_type) || 0,
      fromId: String(message.from_id || ''),
      isRead: message.is_read === undefined || message.is_read === null ? null : Number(message.is_read),
      body: JSON.stringify(message),
    }))
  if (!rows.length) return Promise.resolve(true)
  return enqueue(async () => {
    const result = await call<number>('写入消息', 'im_messages_upsert', { accountId, rows })
    return result !== null
  })
}

export async function loadRecentMessages(accountId: string, limit = 1000): Promise<PersistedMessage[]> {
  if (!accountId) return []
  const result = await call<string[]>('读取消息', 'im_messages_recent', { accountId, limit })
  return parseMessages(result)
}

export async function loadSessionMessages(
  accountId: string,
  sessionId: string,
  limit = 300,
): Promise<PersistedMessage[]> {
  if (!accountId || !sessionId) return []
  const result = await call<string[]>('读取会话消息', 'im_messages_session', {
    accountId,
    sessionId,
    limit,
  })
  return parseMessages(result)
}

export async function loadMessagesAround(
  accountId: string,
  sessionId: string,
  msgId: string,
  before = 150,
  after = 150,
): Promise<PersistedMessage[]> {
  if (!accountId || !sessionId || !msgId) return []
  const result = await call<string[]>('读取消息上下文', 'im_messages_around', {
    accountId,
    sessionId,
    msgId,
    before,
    after,
  })
  return parseMessages(result)
}

export async function getMessage(accountId: string, msgId: string): Promise<PersistedMessage | null> {
  if (!accountId || !msgId) return null
  const result = await call<string>('读取消息', 'im_messages_get', { accountId, msgId })
  return typeof result === 'string' ? parseMessage(result) : null
}

export function deleteMessages(accountId: string, ids: string[]): Promise<void> {
  if (!accountId || !ids.length) return Promise.resolve()
  return enqueue(async () => {
    await call('删除消息', 'im_messages_delete', { accountId, ids })
  })
}

/** 退出登录：删除该账号全部消息与 IM 状态。 */
export function clearAccount(accountId: string): Promise<void> {
  if (!accountId) return Promise.resolve()
  return enqueue(async () => {
    await call('清理本地数据', 'im_account_clear', { accountId })
  })
}

export function putState(accountId: string, scope: string, entries: StateEntry[]): Promise<void> {
  if (!accountId || !entries.length) return Promise.resolve()
  return enqueue(async () => {
    await call('写入状态', 'im_state_upsert', { accountId, scope, entries })
  })
}

export async function getState(
  accountId: string,
  scope: string,
  keys?: string[],
): Promise<StateEntry[]> {
  if (!accountId) return []
  const result = await call<StateEntry[]>('读取状态', 'im_state_query', {
    accountId,
    scope,
    keys: keys && keys.length ? keys : undefined,
  })
  return Array.isArray(result) ? result : []
}

export function deleteState(accountId: string, scope: string, keys: string[]): Promise<void> {
  if (!accountId || !keys.length) return Promise.resolve()
  return enqueue(async () => {
    await call('删除状态', 'im_state_delete', { accountId, scope, keys })
  })
}

export function clearState(accountId: string, scopes?: string[]): Promise<void> {
  if (!accountId) return Promise.resolve()
  return enqueue(async () => {
    await call('清理状态', 'im_state_clear', { accountId, scopes })
  })
}

export function trimState(accountId: string, scope: string, keep: number): Promise<void> {
  if (!accountId || keep <= 0) return Promise.resolve()
  return enqueue(async () => {
    await call('整理状态', 'im_state_trim', { accountId, scope, keep })
  })
}
