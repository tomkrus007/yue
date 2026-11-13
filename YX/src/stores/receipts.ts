import { defineStore } from 'pinia'
import { ref } from 'vue'
import { authService } from '../services/auth'
import { groupService } from '../services/group-client'
import { getServerPaths } from '../services/config'
import { httpJson } from '../services/http'
import type { ImMessage } from '../services/im/im-client'

export interface ReceiptMember {
  id: string
  name: string
}

export interface ReceiptSession {
  id: string
  name: string
  type: number
}

export interface ReceiptAudience {
  messageId: string
  session: ReceiptSession
  sentAt: number
  capturedAt: number
  timing: 'direct' | 'send' | 'later'
  members: ReceiptMember[]
  complete: boolean
  reason: string
  reportedGroupSize?: number
}

function storageKey(accountId: string): string { return `yl.im.receipt-audiences.${accountId}` }
function validSnapshot(value: any): value is ReceiptAudience {
  return !!value && typeof value.messageId === 'string' && value.session && typeof value.session.id === 'string' &&
    Array.isArray(value.members) && value.members.every((member: any) => member && typeof member.id === 'string' && typeof member.name === 'string')
}
function disabled(value: unknown): boolean { return value === false || value === 0 || value === 'false' || value === '0' }
function deleted(value: unknown): boolean { return value === true || value === 1 || value === 'true' || value === '1' }

/** 原版回执名单来自发送时本机成员快照；不把当前成员当作历史发送名单。 */
export const useReceiptAudienceStore = defineStore('receipt-audiences', () => {
  const snapshots = ref<Record<string, ReceiptAudience>>({})
  let owner = ''
  let epoch = 0
  const pending = new Map<string, Promise<ReceiptAudience>>()

  function ensureAccount(): string {
    const accountId = authService.getCurrentUserId()
    if (accountId === owner) return accountId
    owner = accountId
    epoch++
    snapshots.value = {}
    if (!accountId) return accountId
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(accountId)) || '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const restored: Record<string, ReceiptAudience> = {}
        for (const [key, value] of Object.entries(saved)) if (validSnapshot(value)) restored[key] = value
        snapshots.value = restored
      }
    } catch { /* 损坏的本机缓存不阻止查看已收到的阅读确认。 */ }
    return accountId
  }

  function persist(): void {
    if (!owner) return
    const entries = Object.values(snapshots.value).sort((a, b) => a.capturedAt - b.capturedAt).slice(-5000)
    try { localStorage.setItem(storageKey(owner), JSON.stringify(Object.fromEntries(entries.map(item => [item.messageId, item])))) }
    catch { /* 写入失败不丢掉当前页面已取得的名单。 */ }
  }

  function get(messageId: string): ReceiptAudience | undefined {
    ensureAccount()
    return snapshots.value[messageId]
  }

  async function collect(message: ImMessage, session: ReceiptSession, atSend: boolean, stopped: () => boolean = () => false): Promise<ReceiptAudience> {
    const accountId = authService.getCurrentUserId()
    const assertAccount = () => {
      if (stopped()) throw new Error('本次名单查询已结束')
      if (authService.getCurrentUserId() !== accountId) throw new Error('账号已切换，本次名单查询已停止')
    }
    const audience: ReceiptAudience = {
      messageId: message.msg_id,
      session: { ...session },
      sentAt: Number(message.send_time) || 0,
      capturedAt: Date.now(),
      timing: Number(message.to_type) === 1 ? 'direct' : atSend ? 'send' : 'later',
      members: [], complete: false, reason: '',
    }
    if (!accountId || message.from_id !== accountId) { audience.reason = '未捕获此消息发送方的接收人名单'; return audience }
    const type = Number(message.to_type)
    if (type === 1) {
      if (message.to_id) { audience.members = [{ id: message.to_id, name: message.to_name || message.to_id }]; audience.complete = true }
      else audience.reason = '消息缺少接收人 ID'
      return audience
    }
    if (type === 2) {
      let expected: number | undefined
      let detail: Awaited<ReturnType<typeof groupService.getGroupDetail>> = null
      try { detail = await groupService.getGroupDetail(message.to_id) } catch { /* 继续尝试分页；覆盖范围会单独说明。 */ }
      assertAccount()
      if (detail?.memberCount !== undefined && Number.isFinite(Number(detail.memberCount)) && Number(detail.memberCount) >= 0) expected = Number(detail.memberCount)
      const all = new Map<string, { userId: string; name?: string; userName?: string; nickName?: string; isDeleted?: unknown }>()
      let exhausted = false
      let reason = ''
      for (let pageIndex = 0, offset = 0; pageIndex < 20; pageIndex++) {
        assertAccount()
        const page = await groupService.getMembersPage(message.to_id, offset, 500)
        assertAccount()
        if (page.hasMore || page.total > page.members.length) expected = Math.max(expected || 0, page.total)
        const previous = all.size
        for (const member of page.members) if (member.userId) all.set(member.userId, member)
        offset += page.members.length
        if (!page.hasMore) { exhausted = true; break }
        if (!page.members.length || all.size === previous) { reason = '成员分页没有继续推进，名单可能不完整'; break }
      }
      audience.reportedGroupSize = expected
      audience.members = [...all.values()].filter(member => member.userId !== accountId && !member.userId.startsWith('robot:') && !deleted(member.isDeleted))
        .map(member => ({ id: member.userId, name: member.name || member.userName || member.nickName || member.userId }))
      audience.complete = exhausted && expected !== undefined && all.size === expected
      audience.reason = audience.complete ? '' : reason || (!exhausted ? '成员分页达到本机上限，名单可能不完整' : expected === undefined ? '接口未提供可核对的群总人数，无法确认名单完整性' : '成员列表数量与群总人数不一致')
      return audience
    }
    if (type === 4) {
      // 官方 getMyDepartmentUsers 只查询 CurrentUserOrgId，offset=1、limit=800。
      const orgId = localStorage.getItem('CurrentUserOrgId') || ''
      if (!orgId || message.to_id !== orgId) { audience.reason = '尚未核实此目标部门的完整接收人范围'; return audience }
      const base = getServerPaths().uamApiUri.replace(/\/+$/, '')
      const query = new URLSearchParams({ orgId, offset: '1', limit: '800', isCount: 'true' })
      const result = await httpJson<any>(base + '/v1/organizations/users?' + query)
      assertAccount()
      if (Number(result?.code) !== 200 || !Array.isArray(result?.data)) throw new Error(result?.message || '部门名单响应格式不正确')
      const raw = result.data.filter((member: any) => member && (member.userId || member.id))
      const all = new Map<string, any>(raw.map((member: any) => [String(member.userId || member.id), member]))
      const showDisabled = Number(localStorage.getItem('ADDRESS_BOOK_IS_SHOW_DISABLEDUSER')) === 1
      audience.members = [...all].filter(([id, member]) => id !== accountId && !id.startsWith('robot:') && !deleted(member.isDeleted) && (showDisabled || !disabled(member.isEnable)))
        .map(([id, member]) => ({ id, name: member.name || member.userName || id }))
      const total = result.total ?? result.count
      audience.reportedGroupSize = total === undefined ? undefined : Number(total)
      audience.complete = Number.isFinite(audience.reportedGroupSize) && Number(audience.reportedGroupSize) >= 0 && all.size === Number(audience.reportedGroupSize)
      audience.reason = audience.complete ? '' : '部门仅取得已核实的第一页（最多 800 人），无法确认完整名单'
      return audience
    }
    audience.reason = '此会话类型尚未核实发送时接收人名单'
    return audience
  }

  async function boundedCollect(message: ImMessage, session: ReceiptSession, atSend: boolean, current: () => boolean = () => true): Promise<ReceiptAudience> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    try {
      return await Promise.race([
        collect(message, session, atSend, () => stopped || !current()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { stopped = true; reject(new Error('接收人名单查询超时')) }, 10000) }),
      ])
    } catch (error) {
      return { messageId: message.msg_id, session: { ...session }, sentAt: Number(message.send_time) || 0, capturedAt: Date.now(), timing: atSend ? 'send' : 'later', members: [], complete: false,
        reason: (error instanceof Error ? error.message : '接收人名单查询失败').replace(/https?:\/\/[^\s)]+/g, '[请求地址]') }
    } finally { stopped = true; if (timer) clearTimeout(timer) }
  }

  function capture(message: ImMessage, session: ReceiptSession, options: { atSend?: boolean } = {}): Promise<ReceiptAudience> {
    const accountId = ensureAccount()
    if (!accountId || message.from_id !== accountId) return collect(message, session, !!options.atSend)
    const saved = snapshots.value[message.msg_id]
    if (saved) return Promise.resolve(saved)
    const version = epoch
    const key = `${accountId}|${version}|${message.msg_id}`
    const existing = pending.get(key)
    if (existing) return existing
    // 单聊接收人来自消息自身，无需等待 HTTP。
    if (Number(message.to_type) === 1) {
      const snapshot: ReceiptAudience = { messageId: message.msg_id, session: { ...session }, sentAt: Number(message.send_time) || 0, capturedAt: Date.now(), timing: 'direct', members: message.to_id ? [{ id: message.to_id, name: message.to_name || message.to_id }] : [], complete: !!message.to_id, reason: message.to_id ? '' : '消息缺少接收人 ID' }
      if (accountId && message.from_id === accountId) { snapshots.value[message.msg_id] = snapshot; persist() }
      return Promise.resolve(snapshot)
    }
    const task = boundedCollect({ ...message }, { ...session }, !!options.atSend, () => owner === accountId && epoch === version).then(snapshot => {
      if (authService.getCurrentUserId() === accountId && owner === accountId && epoch === version && accountId) { snapshots.value[message.msg_id] = snapshot; persist() }
      return snapshot
    }).finally(() => pending.delete(key))
    pending.set(key, task)
    return task
  }

  /** 返回当前参考名单，不覆盖消息首次捕获的快照。 */
  async function refresh(message: ImMessage, session: ReceiptSession): Promise<ReceiptAudience> {
    ensureAccount()
    return boundedCollect({ ...message }, { ...session }, false)
  }

  function clear(): void {
    ensureAccount()
    if (owner) localStorage.removeItem(storageKey(owner))
    snapshots.value = {}
    epoch++
  }

  return { snapshots, get, capture, refresh, clear }
})
