/**
 * 云盘 / 团队文档上传。
 *
 * 官方客户端把文件先传到对象存储，再调用文档服务把存储文件挂到目标目录：
 *   1. POST {storeUri}/store/putFile?module=message&security=0   （multipart）
 *   2. POST {storeUri}/v2/{fileId}/share/document               （form: id + dirId）
 *
 * 不直接使用 pan 的 /v1/sign/upload，因为它返回的 S3 域名（zs3.yuexiu.com）
 * 在当前网络不可解析；store 链路与聊天附件相同，已验证可用。
 */
import { fetch } from '@tauri-apps/plugin-http'
import { authService } from './auth'
import { getServerPaths } from './config'
import { uploadToStore } from './im/media'

function storeBase(): string {
  const base = String(getServerPaths().storeUri || '').replace(/\/+$/, '')
  if (!base) throw new Error('缺少 storeUri（配置中心未下发存储地址）')
  return base
}

/** 把已上传到对象存储的文件挂到文档目录 */
export async function shareStoreFileToDocument(
  storeFileId: string,
  dirId: string,
): Promise<void> {
  if (!storeFileId || !dirId) throw new Error('缺少文件 id 或目标目录')
  const url =
    storeBase() +
    '/v2/' +
    encodeURIComponent(storeFileId) +
    '/share/document'
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + authService.getAccessToken(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ id: storeFileId, dirId }).toString(),
  })
  const text = await resp.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok || !json || json.code !== 200) {
    throw new Error(
      (json && (json.message || json.msg)) ||
        `保存到云盘失败: HTTP ${resp.status} ${text.slice(0, 120)}`,
    )
  }
}

/** 上传一个文件到指定文档目录 */
export async function uploadFileToDir(
  file: File,
  dirId: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  if (!file) throw new Error('未选择文件')
  if (!dirId) throw new Error('请先进入一个目录')
  const storeFileId = await uploadToStore(file, onProgress)
  await shareStoreFileToDocument(storeFileId, dirId)
}
