import { getServerPaths } from '../config'
import { httpJson } from '../http'

/** 原版 getServiceNoInfo：serviceNoUri/v2/servicenos/{id}/detail，terminalType=3。 */
export async function getServiceNoDetail(id: string): Promise<Record<string, any>> {
  const base = String(getServerPaths().serviceNoUri || '').replace(/\/+$/, '')
  if (!base) throw new Error('未下发服务号服务地址')
  if (!id.trim()) throw new Error('缺少服务号 ID')
  const response = await httpJson<any>(base + '/v2/servicenos/' + encodeURIComponent(id) + '/detail?terminalType=3')
  if ((response?.code !== undefined && Number(response.code) !== 200) || !response?.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error(response?.message || '服务号详情不可用')
  return response.data
}
