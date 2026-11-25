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
 *   共享给我 GET  /v1/share/2/list?offset=&limit=&sortField=createdAt desc
 *
 * 目录 id 规则：个人盘 = CurrentUserId，团队盘 = teamId，部门盘 = orgId，公开文档 = classId。
 * 浏览别人分享给我的目录时必须带 `x-share-id: <shareId>`：不带该头服务端按分享接收人的
 * 自有权限过滤，会返回空数组（不是 403）。
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

/** 收到的分享（共享协作 → 共享给我） */
export interface PanShareItem {
  /** 分享 id，浏览目录时要作为 x-share-id 传回 */
  id: string
  title: string
  /** 被分享的资源 id：目录 id 或文件 id */
  resourceId: string
  resourceType: 'D' | 'F'
  creatorName?: string
  /** 0 = 有效，其余（1 / -1 / -2…）= 已失效或过期 */
  status?: number
  expireDate?: number | null
  permissions?: Record<string, boolean>
}

/**
 * 共享给我列表。
 * 与网页版一致：way=2 表示别人分享给我的，way=1 是我发出的分享。
 */
export async function listReceivedShares(): Promise<PanShareItem[]> {
  const limit = 50
  const out: PanShareItem[] = []
  for (let offset = 0; ; ) {
    const q = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      sortField: 'createdAt desc',
    })
    const json = await requestRaw('GET', '/v1/share/2/list?' + q.toString())
    const list: any[] = Array.isArray(json.data) ? json.data : []
    for (const s of list) {
      const id = String(s.id || '')
      const resourceId = String(s.resourceId || '')
      if (!id || !resourceId) continue
      out.push({
        id,
        title: String(s.title || ''),
        resourceId,
        resourceType: s.resourceType === 'D' ? 'D' : 'F',
        creatorName: s.creatorName ? String(s.creatorName) : undefined,
        status: typeof s.status === 'number' ? s.status : 0,
        expireDate: typeof s.expireDate === 'number' ? s.expireDate : null,
        permissions: s.operationPerm || s.permissions,
      })
    }
    const total = Number(json.total) || 0
    if (!list.length || (total > 0 && out.length >= total)) break
    offset += list.length
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
    { 'x-share-id': shareId },
  )
  return Array.isArray(data) ? data : []
}

/** 下载分享里的文件（下载地址同样要带 x-share-id） */
export function sharedDownloadUrl(fileId: string, shareId: string): Promise<string> {
  return request<string>(
    'GET',
    '/v1/sign/download?fileId=' + encodeURIComponent(fileId),
    undefined,
    { 'x-share-id': shareId },
  )
}

/** 预览分享里的文件 */
export function sharedPreviewUrl(fileId: string, shareId: string): Promise<string> {
  return request<string>(
    'GET',
    '/v1/files/' + encodeURIComponent(fileId) + '/preview',
    undefined,
    { 'x-share-id': shareId },
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
