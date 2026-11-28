/**
 * 应用面板：GET {appApiUri}/es/authorized?terminalType=4
 * 图标走 v1 的 store/getFile?fileId=（v2 的 download 不认带路径的 key）。
 */
import { getServerPaths } from './config'
import { httpJson } from './http'
import { actionUrl, instructionParams } from './im/card-actions'

export interface AppEntry {
  id: string
  code?: string
  name: string
  category: string
  icon: string
  url: string
  order: number
}

let cache: AppEntry[] | null = null
let cachedAt = 0
/** 目录类接口变化不频繁，短时缓存避免每次打开页面都请求；刷新按钮传 force。 */
const CACHE_TTL = 5 * 60 * 1000

export function clearAppCache(): void {
  cache = null
  cachedAt = 0
}

export async function loadApps(force = false): Promise<AppEntry[]> {
  if (!force && cache && Date.now() - cachedAt < CACHE_TTL) return cache
  const base = String(getServerPaths().appApiUri || '').replace(/\/+$/, '')
  if (!base) return []
  const d = await httpJson<any>(base + '/es/authorized?terminalType=4')
  const list = Array.isArray(d) ? d : (d && d.data) || []
  cache = list
    .filter((a: any) => a && a.name)
    .map((a: any) => ({
      id: String(a.appId || a.id || ''),
      code: String(a.appCode || a.code || ''),
      name: a.name,
      category: a.categoryName || '其他',
      icon: String(a.icon || '').split('||')[0],
      url: applicationUrl(a.actionParams),
      order: Number(a.orderNo) || 0,
    }))
    .sort(
      (a: AppEntry, b: AppEntry) =>
        a.order - b.order || a.name.localeCompare(b.name, 'zh'),
    )
  cachedAt = Date.now()
  return cache || []
}

function applicationUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const text = /[\r\n]/.test(value) ? value : value.replace(/\\n/g, '\n')
  const params = instructionParams(text)
  try { return actionUrl(params.pcHomeUrl || params.url || '', getServerPaths()) } catch { return '' }
}

export function groupByCategory(
  apps: AppEntry[],
): Array<{ category: string; apps: AppEntry[] }> {
  const cats = new Map<string, AppEntry[]>()
  for (const a of apps) {
    if (!cats.has(a.category)) cats.set(a.category, [])
    cats.get(a.category)!.push(a)
  }
  return Array.from(cats, ([category, list]) => ({ category, apps: list }))
}
