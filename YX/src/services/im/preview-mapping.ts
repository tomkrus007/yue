import JSON5 from 'json5'

type Mapping = Record<string, string>
/** 企业 indiviConfig 与原版 UIConfig 相同，可为 JSON5 字符串。 */
export function previewMapping(value: unknown): Mapping {
  try {
    const config = typeof value === 'string' ? JSON5.parse(value) : value
    const source = config && typeof config === 'object' ? (config as Record<string, unknown>).ReplaceRequestUri : null
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
    return Object.fromEntries(Object.entries(source).filter(([key, target]) => safeHttp(key) && typeof target === 'string' && safeHttp(target))) as Mapping
  } catch { return {} }
}
function safeHttp(value: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}
/** 只替换首个匹配前缀，替换结果仍须是无 userinfo 的 HTTP(S) 地址。 */
function mapPrefix(value: string, mapping: Mapping): string {
  for (const [prefix, target] of Object.entries(mapping)) {
    if (!value.startsWith(prefix)) continue
    const mapped = target + value.slice(prefix.length)
    if (safeHttp(mapped)) return mapped
    break
  }
  return value
}
/**
 * 官方 `openBrowserUrl` 先对整条页面地址跑 `formatUrl`（含 `formatReqUrl`），
 * 预览页本身也可能带内网前缀；`previewStoreFile` 再单独映射 furl。
 * 两处都映射，与官方一致。
 */
export function mapPreviewUrl(value: string, mapping: Mapping): string {
  if (!safeHttp(value)) throw new Error('预览地址无效')
  const page = new URL(mapPrefix(value, mapping))
  const file = page.searchParams.get('furl')
  if (!file) return page.href
  const mapped = mapPrefix(file, mapping)
  if (mapped !== file) page.searchParams.set('furl', mapped)
  return page.href
}
/** 按账号、企业与服务地址缓存；失败不缓存，后续可重试。 */
export function createPreviewMappingCache() {
  const values = new Map<string, Mapping>()
  const pending = new Map<string, Promise<Mapping>>()
  return async (key: string, load: () => Promise<unknown>): Promise<Mapping> => {
    if (values.has(key)) return values.get(key)!
    if (pending.has(key)) return pending.get(key)!
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('企业配置查询超时')), 4000) })
    const task = Promise.race([load(), timeout]).then(config => {
      const mapping = previewMapping(config)
      values.set(key, mapping)
      return mapping
    }).catch(() => ({})).finally(() => { clearTimeout(timer); pending.delete(key) })
    pending.set(key, task)
    return task
  }
}
