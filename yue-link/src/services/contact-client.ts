/**
 * 联系人服务 —— 逆向自 home.js user 模块
 * base: config.uamApiUrl (https://yxgroup.bingolink.biz/uamapi)
 *
 * - GET  /v1/user/friend/list     好友列表 → { code, data: Friend[] }
 * - POST /v1/users/batch          批量用户详情（body: ["id1","id2"]，50 个一批）→ { code, data: UserDetail[] }
 * - GET  /v2/users/{id}/details   单个用户详情
 * - GET  /v1/contacts/list        联系人列表 → { code, data }
 * - GET  /v1/groups/joined        我加入的群组 → { code, data }
 */
import { fetch } from '@tauri-apps/plugin-http'
import { authService } from './auth'
import { DEFAULT_CONFIG, type AppConfig } from './config'

export interface LinkFriend {
  userId: string
  userName?: string
  name?: string
  eCode?: string
  eName?: string
  orgId?: string
  orgName?: string
  type?: number
}

export interface LinkUserDetail extends LinkFriend {
  userId: string
  mobile?: string
  deptName?: string
  postDescription?: string
}

export interface LinkGroup {
  groupId: string
  groupName: string
  /** 群类型：1 普通 2 讨论 3 项目 4 工作 */
  type?: number
}

export type ContactKind =
  | 'user'
  | 'group'
  | 'org'
  | 'serviceno'
  | 'robot'
  | 'public'

/** 统一的"可聊对象"（联系人选择器条目） */
export interface ContactEntry {
  id: string
  name: string
  kind: ContactKind
  /** FromType：1 用户 2 群组 5 服务号 */
  fromType: number
  desc?: string
  online?: boolean
  raw?: any
}

export class ContactService {
  config: AppConfig

  constructor(config: AppConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  get base(): string {
    return (
      localStorage.getItem('uamApiUri') ||
      this.config.uamApiUrl
    ).replace(/\/+$/, '') + '/'
  }

  private headers(): Record<string, string> {
    return {
      Authorization: 'Bearer ' + authService.getAccessToken(),
      version: this.config.version2,
      displayVersion: this.config.version,
      ClientType: 'pc',
      deviceId: authService.getDeviceId() || '',
      'Accept-Language': 'zh_cn',
      'X-Requested-With': 'XMLHttpRequest',
    }
  }

  private unwrapCode(json: any): any {
    // 大部分 uamapi 返回 {code:200, data:...}
    if (json && typeof json.code === 'number' && json.code !== 200) {
      throw new Error(json.message || `API 错误 code=${json.code}`)
    }
    return json.data
  }

  /** 好友列表 */
  async getFriends(): Promise<LinkFriend[]> {
    const resp = await fetch(this.base + 'v1/user/friend/list', {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) throw new Error(`获取好友列表失败: HTTP ${resp.status}`)
    const json = await resp.json()
    return (this.unwrapCode(json) || []) as LinkFriend[]
  }

  /** 批量用户详情（≥50 个自动分批） */
  async getUsersByIds(ids: string[]): Promise<LinkUserDetail[]> {
    const batches: string[][] = []
    for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50))
    const out: LinkUserDetail[] = []
    for (const b of batches) {
      const resp = await fetch(this.base + 'v1/users/batch', {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      })
      if (!resp.ok) continue
      const json = await resp.json()
      if (json && json.code === 200) out.push(...((json.data || []) as LinkUserDetail[]))
    }
    return out
  }

  /** 单个用户详情 */
  async getUserDetail(userId: string): Promise<LinkUserDetail> {
    const resp = await fetch(this.base + `v2/users/${userId}/details`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) throw new Error(`获取用户详情失败: HTTP ${resp.status}`)
    return (await resp.json()) as LinkUserDetail
  }

  /** 联系人列表（含部门组织结构） */
  async getContacts(): Promise<any[]> {
    const resp = await fetch(this.base + 'v1/contacts/list', {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) throw new Error(`获取联系人失败: HTTP ${resp.status}`)
    const json = await resp.json()
    return (this.unwrapCode(json) || []) as any[]
  }

  /** 我加入的群组 */
  async getMyGroups(): Promise<LinkGroup[]> {
    const resp = await fetch(this.base + 'v1/groups/joined', {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) throw new Error(`获取群组失败: HTTP ${resp.status}`)
    const json = await resp.json()
    const data = this.unwrapCode(json) || []
    // 兼容 {groups:[...]} 或数组
    return (Array.isArray(data) ? data : data.groups || data.ids || []) as LinkGroup[]
  }

  /** 部门用户列表：POST /v2/orgs/{orgId}/users 或 /v1/org/{orgId}/users（按原版 org tree） */
  async orgTree(): Promise<any[]> {
    const resp = await fetch(this.base + 'v1/orgs/tree', {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) return []
    return resp.json().catch(() => [])
  }

  /**
   * 搜索用户（全员，非仅好友）
   * GET /v1/users/search?keyword=&offset=&limit=20&scope=1&isCount=false
   */
  async searchUsers(keyword: string, page = 1): Promise<LinkUserDetail[]> {
    const params = new URLSearchParams({
      keyword,
      offset: String(20 * (page - 1)),
      limit: '20',
      scope: '1',
      isCount: 'false',
    })
    const resp = await fetch(this.base + 'v1/users/search?' + params.toString(), {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) return []
    const json = await resp.json().catch(() => null)
    if (!json) return []
    if (Array.isArray(json)) return json as LinkUserDetail[]
    if (Array.isArray(json.data)) return json.data as LinkUserDetail[]
    if (json.data && Array.isArray(json.data.users)) return json.data.users as LinkUserDetail[]
    if (Array.isArray(json.users)) return json.users as LinkUserDetail[]
    return []
  }

  /** 群组详情 */
  async getGroupDetail(groupId: string): Promise<any> {
    const resp = await fetch(this.base + `v1/groups/${groupId}/detail`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) return null
    const json = await resp.json().catch(() => null)
    if (!json) return null
    return json.code !== undefined ? this.unwrapCode(json) : json
  }

  /**
   * 统一搜索：本地好友/群组（模糊匹配）+ 服务端全员用户搜索
   * 匹配规则：
   *  - 中文名包含 keyword（"陈" → 所有姓陈的）
   *  - 账号 eCode 包含 keyword（"chen" → chen.yue）
   *  - userId 包含 keyword
   *  - 群组名包含 keyword
   */
  async searchEntries(
    keyword: string,
    localFriends: LinkFriend[] = [],
    localGroups: LinkGroup[] = [],
  ): Promise<ContactEntry[]> {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return []
    const seen = new Set<string>()
    const out: ContactEntry[] = []
    const push = (e: ContactEntry) => {
      if (!e.id || seen.has(e.id)) return
      seen.add(e.id)
      out.push(e)
    }

    const selfECode = localStorage.getItem('CurrentECode') || ''
    const nameOf = (f: LinkFriend) =>
      f.name || f.userName || f.eName || f.eCode || f.userId

    for (const f of localFriends) {
      if (f.eCode === selfECode) continue
      const n = nameOf(f)
      const code = (f.eCode || '').toLowerCase()
      const id = (f.userId || '').toLowerCase()
      if (n.toLowerCase().includes(kw) || code.includes(kw) || id.includes(kw)) {
        push({ id: f.userId, name: n, kind: 'user', fromType: 1, desc: f.eCode, raw: f })
      }
    }

    for (const g of localGroups) {
      const n = (g.groupName || (g as any).name || '') as string
      const id = (g.groupId || (g as any).id || '').toLowerCase()
      if (n.toLowerCase().includes(kw) || id.includes(kw)) {
        push({ id: g.groupId || (g as any).id, name: n, kind: 'group', fromType: 2, raw: g })
      }
    }

    try {
      const remote = await this.searchUsers(kw)
      for (const u of remote) {
        if (u.eCode === selfECode) continue
        push({
          id: u.userId,
          name: nameOf(u),
          kind: 'user',
          fromType: 1,
          desc: u.eCode || u.orgName || u.deptName,
          raw: u,
        })
      }
    } catch {
      /* 离线搜索失败不阻断 */
    }

    return out
  }

  /**
   * 组装"联系人选择器"数据：好友 + 群组
   * （原版主面板 tab 顺序：好友/群组/部门/服务号；复刻 MVP 做好友+群组）
   */
  async loadContactEntries(): Promise<ContactEntry[]> {
    const entries: ContactEntry[] = []
    const errs: string[] = []

    // 好友
    try {
      const friends = await this.getFriends()
      const names = new Map<string, string>()
      try {
        const details = await this.getUsersByIds(
          friends.map((f) => f.userId).filter(Boolean),
        )
        for (const d of details) {
          names.set(
            d.userId,
            d.name || d.userName || d.eName || d.eCode || d.userId,
          )
          if (d.orgName) d.orgName = d.orgName
        }
      } catch {
        /* 详情失败不阻断 */
      }
      for (const f of friends) {
        if (f.eCode === localStorage.getItem('CurrentECode')) continue // 排除自己
        entries.push({
          id: f.userId,
          name:
            names.get(f.userId) ||
            f.userName ||
            f.name ||
            f.eName ||
            f.eCode ||
            f.userId,
          kind: 'user',
          fromType: 1,
          desc: f.eCode,
          raw: f,
        })
      }
    } catch (e: any) {
      errs.push('好友: ' + e.message)
    }

    // 群组
    try {
      const groups = await this.getMyGroups()
      for (const g of groups) {
        entries.push({
          id: g.groupId || (g as any).id,
          name: g.groupName || (g as any).name || '',
          kind: 'group',
          fromType: 2,
          raw: g,
        })
      }
    } catch (e: any) {
      errs.push('群组: ' + e.message)
    }

    if (errs.length && entries.length === 0) {
      throw new Error(errs.join('；'))
    }
    return entries
  }
}

export const contactService = new ContactService()
