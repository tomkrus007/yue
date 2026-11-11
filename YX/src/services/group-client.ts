/**
 * 群管理服务 —— 逆向自官方 home.js groupSetting 弹窗（端点与参数已逐一对齐）
 *
 * 地址与请求头同 contact-client（uamapi）：
 *   {uamApiUri} + Authorization/ClientType: pc/deviceId/version/displayVersion/X-Requested-With
 *
 * 约定（对齐官方）：
 * - 成功判定统一为响应体 code === 200，失败取 message 抛错；写接口不自动重试
 * - 路径中的 {groupId} 需要 encodeURIComponent
 * - 「JSON」= Content-Type: application/json；「表单」= x-www-form-urlencoded；「无 body」= POST 不带内容
 *
 * 权限口径（官方）：
 *   memberRole：-1 非成员 / 0 普通 / 1 管理员 / 2 群主
 *   canEdit = memberRole > 0（改群名/介绍/公开设置/加移成员）
 *   ownerRole = memberRole === 2（审批开关/允许邀请/禁言/转让/解散）
 *   canAddMember = memberRole > 0 || isAllowMemInvite
 */
import { fetch } from '@tauri-apps/plugin-http'
import { authService } from './auth'
import { DEFAULT_CONFIG, getServerPaths } from './config'

/** 群详情（v2/groups/{id}/details 返回；字段按官方 groups 表口径取用） */
export interface GroupDetail {
  groupId: string
  name?: string
  /** 群介绍 */
  notes?: string
  /** -1 非成员 / 0 普通 / 1 管理员 / 2 群主 */
  memberRole: number
  type?: number
  templateId?: string
  templateCode?: string
  isPublic?: number | boolean
  joinMode?: number | boolean | string
  isAllowMemInvite?: boolean
  silentStatus?: number
  msgReceiveType?: number
  memberCount?: number
  ownerId?: string
  /** 当前入群码（4 位） */
  joinCode?: string
  /** 入群码过期时间 */
  expireDate?: number | string
  relatedAccountId?: string
  /** 群已解散（官方在查不到群时置位） */
  groupJieSan?: boolean
  [key: string]: unknown
}

/** 群成员（v2/groups/{id}/users/page 条目） */
export interface GroupMember {
  userId: string
  name?: string
  userName?: string
  loginId?: string
  /** 群内昵称 */
  nickName?: string
  /** 0 普通 / 1 管理员 / 2 群主 */
  memberRole: number
  /** 个人禁言状态（全员禁言时 1 表示被禁言） */
  silentStatus?: number
  /** 个人禁言剩余毫秒数（未禁言为 0） */
  silentExpireIn?: number
  [key: string]: unknown
}

export interface BulletinItem {
  bulletinId: string
  groupId?: string
  title?: string
  content?: string
  isImportant?: boolean
  resources?: any[]
  createName?: string
  createTime?: number | string
  [key: string]: unknown
}

export interface MembersPage {
  members: GroupMember[]
  total: number
  hasMore: boolean
}

export interface BulletinPage {
  items: BulletinItem[]
  total: number
  /** 空串表示已到底 */
  cursor: string
}

interface RequestOpts {
  json?: unknown
  form?: Record<string, string | number | boolean>
  query?: Record<string, string | number | boolean>
  token?: string
  retried?: boolean
}

function truthy(v: unknown): boolean {
  return v === 1 || v === '1' || v === true
}

/** 禁言剩余时间文案（对齐官方 getExpireInInfo + i18n） */
export function silentExpireTip(expireIn: number): string {
  const DAY = 86400000
  const HOUR = 3600000
  const MIN = 60000
  let day = 0
  let hour = 0
  let min = 0
  if (expireIn > DAY) {
    day = Math.floor(expireIn / DAY)
    hour = Math.floor((expireIn - day * DAY) / HOUR)
  } else if (expireIn > HOUR) {
    hour = Math.floor(expireIn / HOUR)
    min = Math.floor((expireIn - hour * HOUR) / MIN)
  } else if (expireIn > 0) {
    min = Math.floor(expireIn / MIN) || 1
  } else {
    return '已解除禁言'
  }
  if (day) return `约${day}天${hour}小时后解除`
  if (hour) return `约${hour}小时${min}分后解除`
  return `约${min}分钟后解除`
}

/** 禁言时长档位（对齐官方 editSilentTime 下拉框） */
export const SILENT_TIME_OPTIONS = [
  { value: 1, label: '5分钟' },
  { value: 2, label: '1小时' },
  { value: 3, label: '1天' },
  { value: 4, label: '7天' },
  { value: 5, label: '30天' },
] as const

export class GroupService {
  config = DEFAULT_CONFIG

  private base(): string {
    return String(getServerPaths().uamApiUri || '').replace(/\/+$/, '')
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: 'Bearer ' + token,
      version: this.config.version2,
      displayVersion: this.config.version,
      ClientType: 'pc',
      deviceId: authService.getDeviceId() || '',
      'Accept-Language': 'zh_cn',
      'X-Requested-With': 'XMLHttpRequest',
    }
  }

  /** 统一请求：401 刷新重试一次；code !== 200 抛 message */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: RequestOpts = {},
  ): Promise<any> {
    const base = this.base()
    if (!base) throw new Error('缺少 uamApiUri')
    let url = base + '/' + path.replace(/^\/+/, '')
    if (opts.query) {
      const params = new URLSearchParams(
        Object.entries(opts.query).map(([k, v]) => [k, String(v)]),
      )
      url += '?' + params.toString()
    }
    const token = opts.token ?? authService.getAccessToken()
    const headers = this.headers(token)
    let body: string | undefined
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.json)
    } else if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
      body = new URLSearchParams(
        Object.entries(opts.form).map(([k, v]) => [k, String(v)]),
      ).toString()
    }
    const resp = await fetch(url, { method, headers, body })
    const text = await resp.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!resp.ok) {
      if (resp.status === 401 && token && !opts.retried) {
        const fresh = await authService.refreshToken()
        if (fresh) {
          return this.request(method, path, { ...opts, token: fresh, retried: true })
        }
      }
      const detail =
        (json && (json.message || json.err || json.error)) || String(text || '').slice(0, 120)
      throw new Error(`HTTP ${resp.status} ${detail}`.trim())
    }
    if (json && typeof json.code === 'number' && json.code !== 200) {
      throw new Error(json.message || `API 错误 code=${json.code}`)
    }
    return json
  }

  private gid(id: string): string {
    return encodeURIComponent(id)
  }

  /* ---------------- 群资料 ---------------- */

  /** 群详情：GET v2/groups/{id}/details */
  async getGroupDetail(id: string): Promise<GroupDetail | null> {
    const json = await this.request('GET', `v2/groups/${this.gid(id)}/details`)
    const d = json?.data ?? json
    if (!d || typeof d !== 'object') return null
    return { ...d, groupId: String(d.groupId || d.id || id), memberRole: Number(d.memberRole ?? 0) } as GroupDetail
  }

  /**
   * 局部更新群资料：POST v2/groups/{id}/update（JSON）
   * patch 可含 name / notes / isPublic(0|1) / joinMode("0"|"1") / isAllowMemInvite / relatedAccountId("")
   */
  async updateGroup(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/update`, { json: patch })
  }

  /* ---------------- 成员管理 ---------------- */

  /**
   * 成员分页：GET v2/groups/{id}/users/page
   * query：groupId、offset、limit=500、isCount=true、includeRole=true
   * 返回 { data: 成员[], total }；条目含 memberRole / nickName / silentStatus
   */
  async getMembersPage(
    id: string,
    offset = 0,
    limit = 500,
  ): Promise<MembersPage> {
    const json = await this.request('GET', `v2/groups/${this.gid(id)}/users/page`, {
      query: { groupId: id, offset, limit, isCount: 'true', includeRole: 'true' },
    })
    const raw = json?.data ?? json
    const list = Array.isArray(raw) ? raw : (raw?.users ?? raw?.members ?? [])
    const members = (Array.isArray(list) ? list : []).map((it: any) => {
      const u = (it && it.user) || it || {}
      return {
        ...u,
        ...it,
        userId: String(u.userId || it?.userId || u.id || ''),
        memberRole: Number(u.memberRole ?? it?.memberRole ?? 0),
      } as GroupMember
    }).filter((m: GroupMember) => m.userId)
    const total = Number(json?.total ?? raw?.total ?? 0) || members.length
    return { members, total, hasMore: offset + members.length < total }
  }

  /** 全部成员（自动翻页，最多 20 页 = 1 万人，兜底） */
  async getMembers(id: string): Promise<GroupMember[]> {
    const all: GroupMember[] = []
    for (let offset = 0; offset < 20 * 500; offset += 500) {
      const page = await this.getMembersPage(id, offset)
      all.push(...page.members)
      if (!page.hasMore || !page.members.length) break
    }
    return all
  }

  /** 加成员：POST v2/groups/{id}/members（JSON）{ users: [{ id, memRole: 0 }] } */
  async addMembers(id: string, users: { id: string; memRole?: number }[]): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/members`, {
      json: { users: users.map((u) => ({ id: u.id, memRole: u.memRole ?? 0 })) },
    })
  }

  /** 移成员：POST v2/groups/{id}/members/delete（JSON） */
  async removeMembers(id: string, userIds: string[]): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/members/delete`, {
      json: { users: userIds.map((uid) => ({ id: uid })) },
    })
  }

  /**
   * 重置管理员：POST v2/groups/{id}/admin/reset（JSON）
   * 整份覆盖：传入所有应保留的管理员（不含群主）；空数组清空全部管理员
   */
  async resetAdmins(id: string, userIds: string[]): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/admin/reset`, {
      json: { users: userIds.map((uid) => ({ id: uid })) },
    })
  }

  /** 我的群内昵称：POST v2/groups/{id}/members/nickname（JSON） */
  async setMyNickname(id: string, nickName: string): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/members/nickname`, {
      json: { nickName },
    })
  }

  /* ---------------- 转让 / 退群 / 解散 ---------------- */

  /** 转让群主：POST v2/groups/{id}/transfer（JSON）{ userId } */
  async transferOwner(id: string, userId: string): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/transfer`, {
      json: { userId },
    })
  }

  /** 退群：POST v2/groups/{id}/quit（无 body） */
  async quitGroup(id: string): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/quit`)
  }

  /** 解散（仅群主）：POST v2/groups/{id}/dismiss（无 body） */
  async dismissGroup(id: string): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/dismiss`)
  }

  /* ---------------- 申请 / 邀请 / 审批 ---------------- */

  /** 申请入群：POST v2/groups/{id}/apply（JSON）{ content, joinCode? } */
  async applyJoin(id: string, content: string, joinCode = ''): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/apply`, {
      json: { content, joinCode },
    })
  }

  /** 邀请入群：POST v2/groups/{id}/members/apply（JSON）{ content, userIds } */
  async inviteMembers(id: string, content: string, userIds: string[]): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/members/apply`, {
      json: { content, userIds },
    })
  }

  /** 审批入群：POST v2/groups/{id}/approve（JSON）{ userIds, result } */
  async approveMembers(id: string, userIds: string[], result = true): Promise<void> {
    await this.request('POST', `v2/groups/${this.gid(id)}/approve`, {
      json: { userIds, result },
    })
  }

  /* ---------------- 禁言 ---------------- */

  /** 全员禁言开/关：POST v1/groups/{id}/silent、/silent/cancel（无 body） */
  async setMuteAll(id: string, on: boolean): Promise<void> {
    await this.request('POST', `v1/groups/${this.gid(id)}/silent/${on ? '' : 'cancel'}`.replace(/\/$/, ''))
  }

  /** 禁言名单：GET v1/groups/{id}/silent/members */
  async listMutedMembers(id: string): Promise<GroupMember[]> {
    const json = await this.request('GET', `v1/groups/${this.gid(id)}/silent/members`)
    const list = json?.data ?? []
    return (Array.isArray(list) ? list : []).map((it: any) => ({
      ...it,
      userId: String(it?.userId || it?.id || ''),
    })).filter((m: GroupMember) => m.userId)
  }

  /** 新增禁言名单：POST v1/groups/{id}/silent/members（JSON）{ memberIds, silentTimeType } */
  async addMutedMembers(id: string, memberIds: string[], silentTimeType: number): Promise<void> {
    await this.request('POST', `v1/groups/${this.gid(id)}/silent/members`, {
      json: { memberIds, silentTimeType },
    })
  }

  /** 移除禁言名单：POST v1/groups/{id}/silent/members/remove（JSON） */
  async removeMutedMembers(id: string, memberIds: string[]): Promise<void> {
    await this.request('POST', `v1/groups/${this.gid(id)}/silent/members/remove`, {
      json: { memberIds },
    })
  }

  /** 白名单（不受限发言）名单：GET v1/groups/{id}/unsilent/members */
  async listWhitelistMembers(id: string): Promise<GroupMember[]> {
    const json = await this.request('GET', `v1/groups/${this.gid(id)}/unsilent/members`)
    const list = json?.data ?? []
    return (Array.isArray(list) ? list : []).map((it: any) => ({
      ...it,
      userId: String(it?.userId || it?.id || ''),
    })).filter((m: GroupMember) => m.userId)
  }

  /** 新增白名单：POST v1/groups/{id}/unsilent/members（JSON） */
  async addWhitelistMembers(id: string, memberIds: string[]): Promise<void> {
    await this.request('POST', `v1/groups/${this.gid(id)}/unsilent/members`, {
      json: { memberIds },
    })
  }

  /** 移除白名单：POST v1/groups/{id}/unsilent/members/remove（JSON） */
  async removeWhitelistMembers(id: string, memberIds: string[]): Promise<void> {
    await this.request('POST', `v1/groups/${this.gid(id)}/unsilent/members/remove`, {
      json: { memberIds },
    })
  }

  /* ---------------- 群公告 ---------------- */

  /**
   * 公告列表：POST v1/groups/{id}/bulletins（**表单**）{ groupId, limit=10, cursor }
   * 返回 { data, total, cursor }；cursor 为空表示到底
   */
  async listBulletins(id: string, cursor = '', limit = 10): Promise<BulletinPage> {
    const json = await this.request('POST', `v1/groups/${this.gid(id)}/bulletins`, {
      form: { groupId: id, limit, cursor },
    })
    const raw = json?.data ?? json
    const list = Array.isArray(raw) ? raw : (raw?.data ?? [])
    const items = (Array.isArray(list) ? list : []).map((b: any) => ({
      ...b,
      bulletinId: String(b?.bulletinId || b?.id || ''),
    })).filter((b: BulletinItem) => b.bulletinId)
    return {
      items,
      total: Number(json?.total ?? raw?.total ?? 0) || items.length,
      cursor: String(json?.cursor ?? raw?.cursor ?? ''),
    }
  }

  /** 创建公告：POST v1/groups/{id}/bulletins/create（JSON） */
  async createBulletin(
    id: string,
    body: { isImportant: boolean; title: string; content: string; resources?: any[] },
  ): Promise<void> {
    await this.request('POST', `v1/groups/${this.gid(id)}/bulletins/create`, {
      json: { resources: [], ...body },
    })
  }

  /** 更新公告：POST v1/groups/{id}/bulletins/update?bulletinId=&isSendMessage=（JSON） */
  async updateBulletin(
    id: string,
    bulletinId: string,
    body: { isImportant: boolean; title: string; content: string; resources?: any[] },
    isSendMessage: boolean,
  ): Promise<void> {
    await this.request(
      'POST',
      `v1/groups/${this.gid(id)}/bulletins/update?bulletinId=${encodeURIComponent(bulletinId)}&isSendMessage=${isSendMessage ? 1 : 0}`,
      { json: { resources: [], ...body } },
    )
  }

  /** 删除公告：POST v1/groups/{id}/bulletins/delete（表单） */
  async deleteBulletin(id: string, bulletinId: string): Promise<void> {
    await this.request('POST', `v1/groups/${this.gid(id)}/bulletins/delete`, {
      form: { bulletinId },
    })
  }

  /**
   * 设为/取消重要公告：POST v1/groups/bulletins/important|unimportant（表单）
   * 官方端点路径不含 groupId，body 仅 bulletinId（此处多带 groupId 无副作用）
   */
  async setBulletinImportant(
    id: string,
    bulletinId: string,
    important: boolean,
  ): Promise<void> {
    await this.request('POST', `v1/groups/bulletins/${important ? 'important' : 'unimportant'}`, {
      form: { groupId: id, bulletinId },
    })
  }

  /* ---------------- 邀请码 ---------------- */

  /** 生成入群码：POST v1/groups/joincode（表单）{ groupId, isOverride } → { code, expireDate } */
  async createJoinCode(id: string, isOverride = false): Promise<{ code: string; expireDate: number | string }> {
    const json = await this.request('POST', 'v1/groups/joincode', {
      form: { groupId: id, isOverride },
    })
    const d = json?.data ?? {}
    const code = String(d?.code ?? '')
    if (!code) throw new Error('生成入群码失败：接口未返回 code')
    return { code, expireDate: d?.expireDate ?? '' }
  }

  /* ---------------- 配置中心开关 ---------------- */

  /** 全员禁言功能开关（配置中心 IS_ENABLE_GROUP_SILENT） */
  isGroupSilentEnabled(): boolean {
    return truthy(getServerPaths().IS_ENABLE_GROUP_SILENT)
  }

  /* ---------------- 派生判定 ---------------- */

  isPublicGroup(d: GroupDetail | null): boolean {
    return !!d && truthy(d.isPublic)
  }
  isJoinModeOn(d: GroupDetail | null): boolean {
    return !!d && truthy(d.joinMode)
  }
  isSilentOn(d: GroupDetail | null): boolean {
    return !!d && Number(d.silentStatus) === 1
  }
  roleOf(d: GroupDetail | null): number {
    return d ? Number(d.memberRole ?? 0) : 0
  }
}

export const groupService = new GroupService()
