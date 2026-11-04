/**
 * 应用面板：GET {appApiUri}/es/authorized?terminalType=4
 * 图标走 v1 的 store/getFile?fileId=（v2 的 download 不认带路径的 key）。
 */
import { getServerPaths } from './config'
import { httpJson } from './http'

export interface AppEntry {
  id: string
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
      name: a.name,
      category: a.categoryName || '其他',
      icon: String(a.icon || '').split('||')[0],
      url: (String(a.actionParams || '').match(/url=(\S+)/) || [])[1] || '',
      order: Number(a.orderNo) || 0,
    }))
    .sort(
      (a: AppEntry, b: AppEntry) =>
        a.order - b.order || a.name.localeCompare(b.name, 'zh'),
    )
  return cache || []
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