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

export function clearAppCache(): void {
  cache = null
}

export async function loadApps(): Promise<AppEntry[]> {
  if (cache) return cache
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
