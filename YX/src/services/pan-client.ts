/**
 * 团队文档：品高云盘接口，只认 query 里的 access_token。
 *   目录：GET {panServerUri}/v1/directories/{dirId}/items
 *   下载：GET {panServerUri}/v1/sign/download?fileId=
 *   预览：GET {panServerUri}/v1/files/{fileId}/preview
 *   编辑：GET {panDocUri}/v1/doc/open?fileId=&behavior=1
 */
import { getServerPaths } from './config'
import { tokenGet } from './http'

export interface PanItem {
  id: string
  name: string
  type: 'D' | 'F' | string
  size?: number
  updatedAt?: number
}

export const OFFICE_EXT = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'csv',
  'rtf',
])

function panBase(): string {
  return String(getServerPaths().panServerUri || '').replace(/\/+$/, '')
}

function panDocBase(): string {
  return String(getServerPaths().panDocUri || '').replace(/\/+$/, '')
}

export async function listDir(dirId: string): Promise<PanItem[]> {
  const base = panBase()
  if (!base) throw new Error('缺少 panServerUri')
  const d = await tokenGet<any>(
    base + '/v1/directories/' + encodeURIComponent(dirId) + '/items',
  )
  const list = Array.isArray(d && d.data) ? d.data : []
  return list
    .map((it: any) => ({
      id: String(it.id),
      name: String(it.name || ''),
      type: it.type === 'D' ? 'D' : 'F',
      size: Number(it.size) || 0,
      updatedAt: Number(it.updatedAt) || 0,
    }))
    .sort((a: PanItem, b: PanItem) =>
      a.type === b.type
        ? a.name.localeCompare(b.name, 'zh')
        : a.type === 'D'
          ? -1
          : 1,
    )
}

export async function signDownload(fileId: string): Promise<string> {
  const base = panBase()
  if (!base) throw new Error('缺少 panServerUri')
  const d = await tokenGet<any>(
    base + '/v1/sign/download?fileId=' + encodeURIComponent(fileId),
  )
  const url = String((d && d.data) || '')
  if (!url) throw new Error('没有拿到下载地址')
  return url
}

export async function previewUrl(fileId: string): Promise<string> {
  const base = panBase()
  if (!base) throw new Error('缺少 panServerUri')
  const d = await tokenGet<any>(
    base + '/v1/files/' + encodeURIComponent(fileId) + '/preview',
  )
  const url = String((d && d.data) || '')
  if (!url) throw new Error('没有拿到打开地址')
  return url
}

export async function editUrl(fileId: string): Promise<string> {
  const base = panDocBase()
  if (!base) throw new Error('缺少 panDocUri')
  const d = await tokenGet<any>(
    base +
      '/v1/doc/open?fileId=' +
      encodeURIComponent(fileId) +
      '&behavior=1',
  )
  const url = String((d && d.data) || '')
  if (!url) throw new Error('没有拿到打开地址')
  return url
}

export function fmtSize(n: number | undefined): string {
  if (n == null) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Number(n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  const s = i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)
  return s + ' ' + units[i]
}

export function panDate(ms: number | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (x: number) => String(x).padStart(2, '0')
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const day = sameYear
    ? pad(d.getMonth() + 1) + '/' + pad(d.getDate())
    : d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate())
  return d.toDateString() === now.toDateString() ? '今天' : day
}