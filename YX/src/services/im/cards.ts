import { Template } from 'adaptivecards-templating'
import { getServerPaths } from '../config'
import { authService } from '../auth'
import { httpJson, postForm, httpArrayBuffer } from '../http'

export function cardHttpUrl(value: unknown): string {
  const url = new URL(String(value || ''))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('卡片地址不受支持')
  return url.href
}
function tokenFor(url: string): string {
  const target = new URL(url).origin
  const trusted = [...Object.values(getServerPaths()), localStorage.getItem('cardUri')].some(value => {
    try { return typeof value === 'string' && new URL(value).origin === target } catch { return false }
  })
  return trusted ? authService.getAccessToken() : ''
}
export function checkCardResult(result: any): any {
  if (result?.error || result?.success === false || (result?.s !== undefined && Number(result.s) !== 1) || Number(result?.code) >= 400) {
    throw new Error(result?.message || result?.m || String(result.error || '卡片操作失败'))
  }
  return result
}
/** 刷新失败时清除所有层级动作，避免基于过期内容提交。 */
const cardChildFields = new Set(['body', 'items', 'columns', 'images', 'actions', 'card', 'selectAction', 'inlineAction', 'inlines'])
export function disableCardActions(value: any): any {
  if (Array.isArray(value)) return value.map(disableCardActions)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['actions', 'selectAction', 'inlineAction'].includes(key)).map(([key, item]) => [key, cardChildFields.has(key) ? disableCardActions(item) : item]))
}
export async function queryCard(url: unknown): Promise<any> {
  const address = cardHttpUrl(url)
  return checkCardResult(await httpJson(address, { token: tokenFor(address) }))
}
export async function loadCard(content: any): Promise<any> {
  if (content.templateId) {
    const base = String((getServerPaths() as Record<string, unknown>).cardUri || localStorage.getItem('cardUri') || '').replace(/\/+$/, '')
    if (!base) throw new Error('缺少卡片模板服务地址 cardUri')
    const response = await queryCard(base + '/v1/template/' + encodeURIComponent(content.templateId) + '?terminalType=4')
    const raw = response?.data?.template
    if (!raw) throw new Error('模板服务未返回卡片模板')
    const template = typeof raw === 'string' ? JSON.parse(raw) : raw
    return new Template(template).expand({ $root: content.data || {} })
  }
  const card = content.cardContent || content
  return typeof card === 'string' ? JSON.parse(card) : card
}
export async function submitCard(data: any): Promise<void> {
  const url = cardHttpUrl(data?.url)
  const method = String(data?.method || '').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('卡片提交方法不受支持')
  const params = data?.params ?? {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('卡片提交参数格式无效')
  const contentType = data?.contentType || 'application/json'
  let result: any
  if (method === 'GET') {
    const target = new URL(url)
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value))
    result = await queryCard(target.href)
  } else if (contentType.startsWith('application/x-www-form-urlencoded') && method === 'POST') {
    result = await postForm(url, params, { token: tokenFor(url) })
  } else if (contentType === 'application/json') {
    result = await httpJson(url, { method, body: params, token: tokenFor(url) })
  } else throw new Error('卡片提交内容格式不受支持')
  checkCardResult(result)
}
/** SDK 不直接加载网络图片；先取字节生成短生命周期 Blob。 */
export async function cardImages(card: any, blobs: string[]): Promise<any> {
  const copy = JSON.parse(JSON.stringify(card))
  async function walk(node: any): Promise<void> {
    if (!node || typeof node !== 'object') return
    if (node.backgroundImage) delete node.backgroundImage
    if (node.type === 'Image' && node.url) {
      try {
      const url = cardHttpUrl(node.url)
      const bytes = await httpArrayBuffer(url, { token: tokenFor(url) })
      const extension = new URL(url).pathname.split('.').pop()?.toLowerCase()
      const mime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[extension || ''] || 'image/png'
      node.url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      blobs.push(node.url)
      } catch { node.type = 'TextBlock'; node.text = node.altText || '图片加载失败'; delete node.url }
    }
    if (node.iconUrl) delete node.iconUrl
    if (node.type === 'Media') { node.type = 'TextBlock'; node.text = '卡片内媒体暂不支持，请使用聊天附件播放'; delete node.sources }
    for (const key of cardChildFields) {
      const value = node[key]
      if (Array.isArray(value)) await Promise.all(value.map(walk))
      else if (value && typeof value === 'object') await walk(value)
    }
  }
  await walk(copy)
  return copy
}
