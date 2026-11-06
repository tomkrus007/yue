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
 *
 * 目录 id 规则：个人盘 = CurrentUserId，团队盘 = teamId，部门盘 = orgId，公开文档 = classId。
 * 旧的 /openapi/file/* 写接口在服务端被 666 拦截，这里不再使用。
 */
import { fetch } from '@tauri-apps/plugin-http'
import { authService } from './auth'
import { getServerPaths } from './config'

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

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(withToken(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
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
  return json.data as T
}

/** 列出目录内容 */
export async function listDir(dirId: string): Promise<PanDiskItem[]> {
  const data = await request<PanDiskItem[]>('GET', `/v1/directories/${encodeURIComponent(dirId)}/items`)
  return Array.isArray(data) ? data : []
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
