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
  /** 真实登录账号（如 chen.hu2），展示账号时用它 */
  loginId?: string
  name?: string
  /** 企业编码（同公司员工相同），不是账号 */
  eCode?: string
  eName?: string
  /** 子公司名称 */
  address?: string
  orgId?: string
  orgName?: string
  type?: number
}

export interface LinkUserDetail extends LinkFriend {
  userId: string
  mobile?: string
  mobile2?: string
  mobile3?: string
  telephone?: string
  homeTelephone?: string
  deptName?: string
  departmentName?: string
  postDescription?: string
  positionalTitle?: string
  companyName?: string
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
  /** 兼容字段：用户取部门/账号，用于旧展示与过滤 */
  desc?: string
  /** 子公司名称（address），用于通讯录和搜索结果的公司标签 */
  company?: string
  /** 部门（orgName） */
  dept?: string
  /** 手机号（mobile） */
  mobile?: string
  online?: boolean
  raw?: any
}

/** 子公司名称取 address；缺失时隐藏标签，不回退到集团名称。 */
function companyOf(u: any): string {
  return u?.address?.trim() || ''
}

/** 部门（详情接口里是 orgName） */
function deptOf(u: any): string {
  return u?.orgName || u?.deptName || u?.departmentName || u?.comment || ''
}

/** 手机号 */
function mobileOf(u: any): string {
  return u?.mobile || u?.telephone || u?.homeTelephone || ''
}

/**
 * 列表副标题：优先部门，没有部门再退回登录账号。
 * eCode 是「企业编码」（同一公司所有人都一样），不能当账号展示。
 */
function subtitleOf(u: any): string {
  return deptOf(u) || u?.loginId || ''
}

/** 用户 → 通讯录条目（公司、部门、手机都带上，便于列表展示） */
function userEntry(u: any): ContactEntry {
  return {
    id: String(u?.userId || u?.id || ''),
    name: u?.name || u?.userName || u?.loginId || String(u?.userId || ''),
    kind: 'user',
    fromType: 1,
    desc: subtitleOf(u),
    company: companyOf(u),
    dept: deptOf(u),
    mobile: mobileOf(u),
    raw: u,
  }
}

/** 用详情补全条目上缺失的公司/部门/手机（搜索接口只返回基础字段） */
function applyDetail(entry: ContactEntry, detail: any): void {
  const u = (detail && detail.user) || detail || {}
  entry.company = entry.company || companyOf(u)
  entry.dept = entry.dept || deptOf(u)
  entry.mobile = entry.mobile || mobileOf(u)
  entry.desc = entry.dept || entry.desc
}

/** 是否本人：用 userId 判断；eCode 是公司级编码，不能拿来排除自己。 */
function isSelf(userId?: string): boolean {
  const self = localStorage.getItem('CurrentUserId') || ''
  return !!self && !!userId && String(userId) === self
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
      if (json && typeof json.code === 'number' && json.code !== 200) continue
      const data = Array.isArray(json) ? json : json?.data ?? json?.users
      const list = Array.isArray(data) ? data : data?.users
      if (Array.isArray(list)) {
        // 兼容 [{ user: {...} }] 的包装
        out.push(...list.map((it: any) => (it && it.user) || it))
      }
    }
    return out
  }

  /** 单个用户详情（实际返回 { user: {...} } 或 { code, data: {...} }，必须解包） */
  async getUserDetail(userId: string): Promise<LinkUserDetail> {
    const resp = await fetch(this.base + `v2/users/${userId}/details`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) throw new Error(`获取用户详情失败: HTTP ${resp.status}`)
    const json = await resp.json()
    if (json && typeof json.code === 'number' && json.code !== 200) {
      throw new Error(json.message || `API 错误 code=${json.code}`)
    }
    let data: any = json
    if (data && typeof data === 'object') {
      if (data.data && typeof data.data === 'object') data = data.data
      // v2 details 返回 { user: {...}, ... }，字段都在 user 里
      if (data.user && typeof data.user === 'object') data = data.user
    }
    return (data || {}) as LinkUserDetail
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

  /** 当前群组的成员，不使用全员通讯录代替。 */
  async getGroupMembers(groupId: string): Promise<LinkUserDetail[]> {
    const resp = await fetch(this.base + `v1/groups/${encodeURIComponent(groupId)}/members`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!resp.ok) throw new Error(`获取群成员失败: HTTP ${resp.status}`)
    const json = await resp.json()
    const data = json?.code !== undefined ? this.unwrapCode(json) : json
    const list = Array.isArray(data) ? data : data?.members ?? data?.users ?? data?.ids
    if (!Array.isArray(list)) throw new Error('群成员接口返回格式异常')
    const members = list.map((item: any) => typeof item === 'string'
      ? { userId: item } : { ...item, ...(item.user || {}), userId: String(item.user?.userId || item.userId || item.id || '') })
      .filter((item: LinkUserDetail) => item.userId)
    const missing = members.filter((item: LinkUserDetail) => !item.name && !item.userName)
    if (missing.length) {
      const details = await this.getUsersByIds(missing.map((item: LinkUserDetail) => item.userId))
      const byId = new Map(details.map(item => [item.userId, item]))
      for (const member of missing) Object.assign(member, byId.get(member.userId))
    }
    return [...new Map<string, LinkUserDetail>(members.map((item: LinkUserDetail) => [item.userId, item])).values()]
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
   *  - 登录账号 loginId 包含 keyword（"chen" → chen.hu2）
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
    const byId = new Map<string, ContactEntry>()
    /** 同一用户可能先由本地好友命中、再由全员搜索补全，后者只补缺失字段 */
    const put = (e: ContactEntry) => {
      if (!e.id) return
      const prev = byId.get(e.id)
      if (!prev) {
        byId.set(e.id, e)
        return
      }
      prev.name = prev.name || e.name
      prev.desc = prev.desc || e.desc
      prev.company = prev.company || e.company
      prev.dept = prev.dept || e.dept
      prev.mobile = prev.mobile || e.mobile
      prev.raw = prev.raw || e.raw
    }

    for (const f of localFriends) {
      if (isSelf(f.userId)) continue
      const e = userEntry(f)
      const code = (f.loginId || '').toLowerCase()
      const id = (f.userId || '').toLowerCase()
      if (
        e.name.toLowerCase().includes(kw) ||
        code.includes(kw) ||
        id.includes(kw)
      ) {
        put(e)
      }
    }

    for (const g of localGroups) {
      const n = (g.groupName || (g as any).name || '') as string
      const id = (g.groupId || (g as any).id || '').toLowerCase()
      if (n.toLowerCase().includes(kw) || id.includes(kw)) {
        put({
          id: g.groupId || (g as any).id,
          name: n,
          kind: 'group',
          fromType: 2,
          raw: g,
        })
      }
    }

    try {
      const remote = await this.searchUsers(kw)
      for (const u of remote) {
        if (isSelf(u.userId)) continue
        put(userEntry(u))
      }
    } catch {
      /* 离线搜索失败不阻断 */
    }

    // 搜索接口只给 userId/name/eCode 这类基础字段，公司、部门、手机要查批量详情
    const needDetail = [...byId.values()]
      .filter(
        (c) =>
          c.kind === 'user' && (!c.company || !c.dept || !c.mobile),
      )
      .slice(0, 30)
    if (needDetail.length) {
      try {
        const details = await this.getUsersByIds(needDetail.map((c) => c.id))
        const map = new Map(details.map((d) => [d.userId, d]))
        for (const c of needDetail) {
          const d = map.get(c.id)
          if (d) applyDetail(c, d)
        }
      } catch {
        /* 详情失败不阻断，保留基础信息 */
      }
    }

    return [...byId.values()]
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
      const detailsById = new Map<string, LinkUserDetail>()
      try {
        const details = await this.getUsersByIds(
          friends.map((f) => f.userId).filter(Boolean),
        )
        for (const d of details) detailsById.set(d.userId, d)
      } catch {
        /* 详情失败不阻断 */
      }
      for (const f of friends) {
        if (isSelf(f.userId)) continue // 排除自己
        // 好友列表字段少，批量详情里的公司/部门/手机补上来
        const merged: any = { ...f }
        const d = detailsById.get(f.userId)
        if (d) {
          for (const [k, v] of Object.entries(d)) {
            if (v !== null && v !== undefined && v !== '') merged[k] = v
          }
        }
        entries.push({ ...userEntry(merged), raw: f })
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
