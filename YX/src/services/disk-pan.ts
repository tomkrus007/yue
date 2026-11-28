/**
 * 云盘文档接口（panServerUri，/pan/v1）。
 *
 * 与「群聊 → 任务与文档 → 团队文档」使用同一套接口：
 *   列表    GET  /v1/directories/{dirId}/items?access_token=
 *   新建目录 POST /v1/directories/create        {name, parentId}
 *   重命名   POST /v1/directories/rename|/v1/files/rename {dirId|fileId, name}
 *   移动     POST /v1/directories/move|/v1/files/move    {dirId|fileId, targetParentId}
 *   删除     POST /v1/directories/delete?dirId= | /v1/files/delete?fileId=
 *   下载     GET  /v1/sign/download?fileId=
 *   预览     GET  /v1/files/{fileId}/preview
 *   共享列表 GET  /v1/share/{way}/list?offset=&limit=&sortField=createdAt desc
 *             way=1 我共享的，way=2 共享给我
 *   创建共享 POST /v1/share/create        {type,shareResources,days,previewLimit,downloadLimit,operationPerm…}
 *   修改共享 POST /v1/share/modify        {id,type,days,…}
 *   取消共享 GET  /v1/share/{id}/delete?way=
 *   共享详情 GET  /v1/share/{id}/info
 *   转存     POST /v1/share/transfer      {shareLinkId,shareResources,whole,targetDirId}
 *
 * 目录 id 规则：个人盘 = CurrentUserId，团队盘 = teamId，部门盘 = orgId，公开文档 = classId。
 * 浏览别人分享给我的目录时必须带分享头（原版目录/转存接口用 `xShareId`，下载签名用
 * `x-share-id`，这里两个都带）：不带该头服务端按分享接收人的自有权限过滤，会返回空数组
 * （不是 403）。
 * 旧的 /openapi/file/* 写接口在服务端被 666 拦截，这里不再使用。
 */
import { fetch } from '@tauri-apps/plugin-http'
import { authService } from './auth'
import { getServerPaths } from './config'
import { tokenGet } from './http'

export interface PanDiskItem {
  id: string
  name: string
  type: 'D' | 'F'
  size?: number | null
  updatedAt?: number | null
  permissions?: Record<string, boolean>
}

function base(): string {
  const b = String(getServerPaths().panServerUri || '').replace(/\/+$/, '')
  if (!b) throw new Error('缺少 panServerUri')
  return b
}

function withToken(path: string): string {
  const token = authService.getAccessToken()
  return (
    base() +
    path +
    (path.includes('?') ? '&' : '?') +
    'access_token=' +
    encodeURIComponent(token)
  )
}

async function requestRaw(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<any> {
  const resp = await fetch(withToken(path), {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await resp.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok || !json || json.code !== 200) {
    const msg =
      (json && (json.message || json.error)) ||
      `云盘请求失败: HTTP ${resp.status} ${text.slice(0, 120)}`
    throw new Error(msg)
  }
  return json
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<T> {
  const json = await requestRaw(method, path, body, headers)
  return json.data as T
}

/** 列出目录内容 */
export async function listDir(dirId: string): Promise<PanDiskItem[]> {
  const data = await request<PanDiskItem[]>('GET', `/v1/directories/${encodeURIComponent(dirId)}/items`)
  return Array.isArray(data) ? data : []
}

/**
 * 分页拉 formal/page。
 * offset 是绝对偏移，用 total 收敛；不能用 `list.length < limit` 判断结束，
 * 服务端可能把单页截得比 limit 更小。
 */
async function listFormalPages(url: string, pinToPan: boolean): Promise<any[]> {
  const limit = 200
  const out: any[] = []
  for (let offset = 0; ; ) {
    const q = new URLSearchParams({
      scope: '1',
      isCount: 'true',
      offset: String(offset),
      limit: String(limit),
    })
    if (pinToPan) q.set('pinToPan', 'true')
    const r = await tokenGet<any>(url + '?' + q.toString())
    const list = Array.isArray(r && r.data) ? r.data : []
    out.push(...list)
    const total = Number(r && r.total) || 0
    if (!list.length || (total > 0 && out.length >= total)) break
    offset += list.length
  }
  return out
}

/**
 * 团队文档空间（原版首页「文档 → 团队文档」的数据源）。
 * 原版 5.2.97 已启用新文档模块，团队文档列的是正式团队群 + 云盘团队空间：
 *   GET {taskUri}/v1/group/formal/page?scope=1&isCount=true&pinToPan=true
 *   GET {uamApiUri}/v3/groups/formal/page?scope=1&isCount=true&pinToPan=true
 * taskapi 忽略 pinToPan，只返回「我加入的正式群」，云盘里创建/被授权的团队
 * 空间（typeName=团队空间）会漏掉；uam 侧才返回完整可见列表，两者取并集。
 * 旧的 /openapi/team/list 只返回单独创建的云盘团队，数量同样偏少。
 */
export async function listTeamSpaces(): Promise<PanDiskItem[]> {
  const paths = getServerPaths()
  const base = String(paths.taskUri || '').replace(/\/+$/, '')
  if (!base) throw new Error('缺少 taskUri，无法加载团队文档')
  const out: PanDiskItem[] = []
  const seen = new Set<string>()
  const append = (list: any[]) => {
    for (const g of list) {
      const id = String(g.groupId || g.id || '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({ id, name: String(g.name || id), type: 'D' })
    }
  }
  append(await listFormalPages(base + '/v1/group/formal/page', true))
  // 云盘团队空间 / 被授权团队只在 uam 的 pinToPan=true 结果里；失败不影响主列表。
  const uam = String(paths.uamApiUri || '').replace(/\/+$/, '')
  if (uam) {
    try {
      append(await listFormalPages(uam + '/v3/groups/formal/page', true))
    } catch (e) {
      console.warn('[团队文档] 加载云盘团队空间失败', e)
    }
  }
  return out
}

/**
 * 部门文档空间：与原版「部门文档」一致。
 * 原版新文档模块用 {pan} /v1/principals/departments，返回用户可见的部门链；
 * 旧 /openapi/org/list 的 fileNotEmpty 过滤会漏掉仍有文档的上级部门。
 */
export async function listDepartmentSpaces(): Promise<PanDiskItem[]> {
  const data = await request<any[]>('GET', '/v1/principals/departments')
  return (Array.isArray(data) ? data : []).map((d) => ({
    id: String(d.id),
    name: String(d.name || d.id),
    type: 'D',
  }))
}

/** 分享类型：P 外链、K 带提取码外链、S 内部共享 */
export type PanShareType = 'P' | 'K' | 'S'

/** 收到的分享（共享协作 → 共享给我）与我发出的分享（我的共享） */
export interface PanShareItem {
  /** 分享 id，浏览目录时要作为 x-share-id 传回 */
  id: string
  title: string
  /** 被分享的资源 id：目录 id 或文件 id */
  resourceId: string
  resourceType: 'D' | 'F'
  creatorName?: string
  /** 0 = 永久有效，-2 = 有到期日，1 = 已过期，-1 = 已失效 */
  status?: number
  expireDate?: number | string | null
  /** 服务端直接给的到期文案，如「无限期」「2026-01-01」 */
  expiredInfo?: string
  createdAt?: number | null
  /** 原版列表里的分享形式（服务端返回 P/K/S） */
  shareType?: PanShareType
  /** 外链地址与提取码；列表接口直接返回，便于「复制链接」 */
  href?: string
  password?: string
  /** 1 = 我发出的，2 = 别人发给我的 */
  way?: 1 | 2
  downloadLimit?: number | null
  previewLimit?: number | null
  operationPerm?: Record<string, boolean>
  permissions?: Record<string, boolean>
}

/** 按 way 拉分享列表：1 我共享的，2 共享给我 */
async function listShares(way: 1 | 2): Promise<PanShareItem[]> {
  const limit = 50
  const out: PanShareItem[] = []
  for (let offset = 0; ; ) {
    const q = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      sortField: 'createdAt desc',
    })
    const json = await requestRaw('GET', `/v1/share/${way}/list?` + q.toString())
    const list: any[] = Array.isArray(json.data) ? json.data : []
    for (const s of list) {
      const id = String(s.id || '')
      const resourceId = String(s.resourceId || '')
      // 我共享的列表只保证有分享 id；共享给我必须有资源 id 才能浏览
      if (!id || (way === 2 && !resourceId)) continue
      out.push({
        id,
        title: String(s.title || ''),
        resourceId,
        resourceType:
          s.resourceType === 'D' || s.type === 'D' ? 'D' : 'F',
        creatorName: s.creatorName ? String(s.creatorName) : undefined,
        status: typeof s.status === 'number' ? s.status : 0,
        expireDate:
          typeof s.expireDate === 'number' || typeof s.expireDate === 'string'
            ? s.expireDate
            : null,
        expiredInfo: s.expiredInfo ? String(s.expiredInfo) : undefined,
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : null,
        shareType: s.type === 'P' || s.type === 'K' || s.type === 'S' ? s.type : undefined,
        href: s.href ? String(s.href) : undefined,
        password: s.password ? String(s.password) : undefined,
        way,
        downloadLimit: typeof s.downloadLimit === 'number' ? s.downloadLimit : null,
        previewLimit: typeof s.previewLimit === 'number' ? s.previewLimit : null,
        operationPerm: s.operationPerm,
        permissions: s.operationPerm || s.permissions,
      })
    }
    const total = Number(json.total) || 0
    if (!list.length || (total > 0 && out.length >= total)) break
    // 服务端不回 total 时，短页即末页，避免空转
    if (!total && list.length < limit) break
    offset += list.length
  }
  return out
}

/** 共享给我列表。 */
export function listReceivedShares(): Promise<PanShareItem[]> {
  return listShares(2)
}

/** 我发出的分享列表。 */
export function listMyShares(): Promise<PanShareItem[]> {
  return listShares(1)
}

/** 内部分享的共享对象：id 不带 U/G/D 前缀，code 区分用户/团队/部门 */
export interface PanSharePrincipal {
  id: string
  code: 'user' | 'team' | 'department'
  name?: string
}

export interface PanShareResource {
  resourceId: string
  resourceType: 'D' | 'F'
}

export interface PanShareOperationPerm {
  previewable: boolean
  downloadable: boolean
  editable: boolean
  uploadable: boolean
}

export interface PanShareInput {
  type: 'P' | 'S'
  resources: PanShareResource[]
  principals?: PanSharePrincipal[]
  previewLimit: number
  downloadLimit: number
  operationPerm: PanShareOperationPerm
  /** 0 = 永久有效，-1 = 按 expireDate 到期 */
  days: number
  expireDate?: string
  password?: string
  isForward?: boolean
}

/** 创建/修改共享返回的外链信息 */
export interface PanShareLinkInfo {
  type: PanShareType
  href?: string
  password?: string
  /** -1 = 按 expireDate 到期，其余为永久 */
  validity?: number
  expireDate?: string | number
}

export interface PanShareInfo extends PanShareLinkInfo {
  id?: string
  title?: string
  status?: number
  expiredInfo?: string
  downloadLimit?: number | null
  previewLimit?: number | null
  operationPerm?: Record<string, boolean>
  /** 内部分享成员：id 带 U/G/D 前缀，type 为 user/team/department */
  shareMembers?: Array<{ id: string; type?: string; name?: string }>
}

function shareBody(input: PanShareInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: input.type,
    shareResources: input.resources,
    days: input.days,
    previewLimit: input.previewLimit,
    downloadLimit: input.downloadLimit,
    operationPerm: input.operationPerm,
  }
  if (input.principals && input.principals.length) {
    body.principalPermissions = input.principals.map((p) => ({ id: p.id, code: p.code }))
  }
  if (input.expireDate) body.expireDate = input.expireDate
  if (input.password) body.password = input.password
  if (input.isForward !== undefined) body.isForward = input.isForward
  return body
}

/** 创建共享（P 外链 / S 内部） */
export function createShare(input: PanShareInput): Promise<PanShareLinkInfo> {
  return request<PanShareLinkInfo>('POST', '/v1/share/create', shareBody(input))
}

/** 修改共享；password 传空表示清除提取码（与原版一致） */
export function modifyShare(
  id: string,
  input: PanShareInput,
): Promise<PanShareLinkInfo> {
  const body = shareBody(input)
  // 修改接口只按 id 定位，原版请求体不带 shareResources
  delete body.shareResources
  body.id = id
  body.password = input.password || null
  return request<PanShareLinkInfo>('POST', '/v1/share/modify', body)
}

/** 取消共享（way=1）或删除收到的共享（way=2） */
export function deleteShare(shareId: string, way: 1 | 2): Promise<unknown> {
  return request(
    'GET',
    `/v1/share/${encodeURIComponent(shareId)}/delete?way=${way}`,
  )
}

/** 一键清理失效共享 */
export function clearInvalidShares(way: 1 | 2): Promise<unknown> {
  return request('POST', `/v1/share/clear/invalid?way=${way}`, { way })
}

/** 共享详情（编辑共享时用于回填权限、有效期与内部成员） */
export function shareInfo(shareId: string): Promise<PanShareInfo> {
  return request<PanShareInfo>(
    'GET',
    `/v1/share/${encodeURIComponent(shareId)}/info`,
  )
}

/** 分享上下文请求头：目录/转存接口认 xShareId，下载签名认 x-share-id，两个都带 */
function shareHeaders(shareId: string): Record<string, string> {
  return { 'x-share-id': shareId, xShareId: shareId }
}

/**
 * 转存共享到自己的目录。
 * whole=true 表示整条共享；targetDirId 通常是个人盘根目录（CurrentUserId）。
 */
export function transferShare(
  shareId: string,
  targetDirId: string,
  resources: PanShareResource[] = [],
): Promise<unknown> {
  return request(
    'POST',
    '/v1/share/transfer',
    {
      shareLinkId: shareId,
      shareResources: resources,
      whole: true,
      targetDirId,
    },
    shareHeaders(shareId),
  )
}

/**
 * 内部分享的共享对象搜索：用户 + 正式团队 + 部门。
 * 与原版 InsideShare 一致，三个来源合并；任一来源失败不影响其余结果。
 */
export async function searchSharePrincipals(
  keyword: string,
): Promise<PanSharePrincipal[]> {
  const kw = keyword.trim()
  if (!kw) return []
  const base = String(getServerPaths().uamApiUri || '').replace(/\/+$/, '')
  if (!base) return []

  const out: PanSharePrincipal[] = []
  const seen = new Set<string>()
  const put = (
    id: unknown,
    code: PanSharePrincipal['code'],
    name: unknown,
  ) => {
    const value = String(id || '')
    if (!value) return
    const key = code + ':' + value
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id: value, code, name: String(name || value) })
  }
  const query = new URLSearchParams({
    keyword: kw,
    offset: '0',
    limit: '1000',
  })

  try {
    // 用户搜索的参数名与团队/部门不同：page/size/showSize
    const q = new URLSearchParams({
      keyword: kw,
      page: '0',
      size: '1000',
      showSize: '1000',
      scope: '1',
    })
    const r = await tokenGet<any>(base + '/v1/users/search?' + q.toString())
    const list: any[] = Array.isArray(r)
      ? r
      : Array.isArray(r?.data)
        ? r.data
        : Array.isArray(r?.data?.users)
          ? r.data.users
          : Array.isArray(r?.users)
            ? r.users
            : []
    for (const u of list) {
      put(u?.userId || u?.id, 'user', u?.name || u?.userName || u?.loginId)
    }
  } catch {
    /* 搜索用户失败不阻断团队/部门 */
  }

  try {
    const q = new URLSearchParams(query)
    q.set('scope', '1')
    q.set('isCount', 'true')
    q.set('pinToPan', 'false')
    const r = await tokenGet<any>(base + '/v3/groups/formal/page?' + q.toString())
    const list: any[] = Array.isArray(r?.res)
      ? r.res
      : Array.isArray(r?.data)
        ? r.data
        : []
    for (const g of list) put(g?.groupId || g?.id, 'team', g?.name)
  } catch {
    /* 无正式团队 */
  }

  try {
    // 原版部门搜索固定带空 eCode
    const q = new URLSearchParams(query)
    q.set('eCode', '')
    const r = await tokenGet<any>(base + '/v1/organizations/search?' + q.toString())
    const list: any[] = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : []
    for (const d of list) put(d?.orgId || d?.id, 'department', d?.name)
  } catch {
    /* 无部门搜索权限 */
  }

  return out
}

/** 浏览分享目录内容（必须带 x-share-id，否则服务端按自有权限返回空数组） */
export async function listSharedDir(
  dirId: string,
  shareId: string,
): Promise<PanDiskItem[]> {
  const data = await request<PanDiskItem[]>(
    'GET',
    `/v1/directories/${encodeURIComponent(dirId)}/items`,
    undefined,
    shareHeaders(shareId),
  )
  return Array.isArray(data) ? data : []
}

/** 下载分享里的文件（下载地址同样要带 x-share-id） */
export function sharedDownloadUrl(fileId: string, shareId: string): Promise<string> {
  return request<string>(
    'GET',
    '/v1/sign/download?fileId=' + encodeURIComponent(fileId),
    undefined,
    shareHeaders(shareId),
  )
}

/** 预览分享里的文件 */
export function sharedPreviewUrl(fileId: string, shareId: string): Promise<string> {
  return request<string>(
    'GET',
    '/v1/files/' + encodeURIComponent(fileId) + '/preview',
    undefined,
    shareHeaders(shareId),
  )
}

/** 新建目录 */
export function createFolder(parentId: string, name: string): Promise<unknown> {
  return request('POST', '/v1/directories/create', { name, parentId })
}

/** 删除文件或目录 */
export function deleteItem(item: PanDiskItem): Promise<unknown> {
  return item.type === 'D'
    ? request('POST', '/v1/directories/delete?dirId=' + encodeURIComponent(item.id))
    : request('POST', '/v1/files/delete', { ids: [item.id] })
}

/** 重命名文件或目录 */
export function renameItem(item: PanDiskItem, name: string): Promise<unknown> {
  return item.type === 'D'
    ? request('POST', '/v1/directories/rename', { dirId: item.id, name })
    : request('POST', '/v1/files/rename', { id: item.id, name })
}

/** 移动到目标目录 */
export function moveItem(item: PanDiskItem, targetParentId: string): Promise<unknown> {
  return item.type === 'D'
    ? request('POST', '/v1/directories/move', { dirId: item.id, targetParentId })
    : request('POST', '/v1/files/move', { ids: [item.id], targetParentId })
}

/** 下载地址（302 前的签名 URL） */
export function downloadUrl(fileId: string): Promise<string> {
  return request<string>('GET', '/v1/sign/download?fileId=' + encodeURIComponent(fileId))
}

/** 预览地址 */
export function previewUrl(fileId: string): Promise<string> {
  return request<string>('GET', '/v1/files/' + encodeURIComponent(fileId) + '/preview')
}
