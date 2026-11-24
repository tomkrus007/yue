/**
 * 网盘 REST API 客户端 —— 逆向自 disk/html/app/common/services/fileService.js
 * 直连 pan.bingolink.biz/openapi（生产：streamapi.bingolink.biz/openapi）
 *
 * 认证：Authorization: Bearer <token> + appId: BingoCloudDisk
 */
import { fetch } from '@tauri-apps/plugin-http'
import { authService } from './auth'
import { DEFAULT_CONFIG, type AppConfig } from './config'

export interface DiskFile {
  id: string
  name: string
  path: string
  type: 'F' | 'D' // F=file D=directory
  ext?: string
  size?: number
  parentId?: string
  classId?: string
  createTime?: number
  updateTime?: number
  preview?: {
    available: boolean
    wopiSupport: boolean
  }
  previewable?: boolean
  permissions?: Record<string, boolean>
}

export interface DiskListResult {
  files: DiskFile[]
  path: string
  hasMore: boolean
}

export class DiskClient {
  config: AppConfig

  constructor(config: AppConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  /** 网盘 API 基址 */
  get apiBase(): string {
    return localStorage.getItem('diskOpenApiUrl') || this.config.diskOpenApiUrl
  }

  /** 网盘站点 */
  get siteUrl(): string {
    return localStorage.getItem('diskSiteUrl') || 'https://pan.bingolink.biz/'
  }

  /** 通用请求头（逆向自 ajaxSetting.js：appId + appVersion + Pan-Version + deviceId + os） */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const os = /Mac|iPhone|iPad/.test(navigator.userAgent)
      ? 'Mac'
      : /Windows/.test(navigator.userAgent)
        ? 'Windows'
        : 'Linux'
    return {
      Authorization: 'Bearer ' + authService.getAccessToken(),
      appId: this.config.diskAppId,
      appVersion: '3.6.0',
      'Pan-Version': '3.6.1',
      deviceId: authService.getDeviceId() || '',
      os,
      'Accept-Language': 'zh_cn',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
      ...extra,
    }
  }

  private async request<T = any>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    path: string,
    params?: Record<string, any>,
    body?: any,
  ): Promise<T> {
    const url = new URL(this.apiBase + path)
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null)
          url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      })
    }
    const opts: any = {
      method,
      headers: this.headers(
        body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
      ),
    }
    if (body !== undefined) {
      const form = new URLSearchParams()
      Object.entries(body).forEach(([k, v]) => {
        form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      })
      opts.body = form.toString()
    }
    const resp = await fetch(url.toString(), opts)
    if (resp.status === 401) {
      const newToken = await authService.refreshToken()
      if (newToken) {
        opts.headers = this.headers(
          body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
        )
        const retry = await fetch(url.toString(), opts)
        if (!retry.ok) throw new Error(`网盘请求失败: HTTP ${retry.status}`)
        return retry.json()
      }
      throw new Error('认证已过期，请重新登录')
    }
    if (!resp.ok) {
      const txt = await resp.text()
      throw new Error(`网盘请求失败: HTTP ${resp.status} ${txt.slice(0, 200)}`)
    }
    const ct = resp.headers.get('content-type') || ''
    if (ct.includes('application/json')) return resp.json()
    return (await resp.text()) as unknown as T
  }

  /* ============ 网盘类型 ============ */

  /** 网盘系统信息（各盘名称与启用状态） */
  systemInfo(): Promise<any> {
    return this.request<any>('GET', '/system/info')
  }

  /** 团队盘列表（仅我加入的） */
  teamList(): Promise<DiskListResult> {
    return this.request<any>('GET', '/team/list', {
      // 服务端只认 filter=<JSON>；写成 filter.onlyMember 会被忽略，
      // 返回的团队不完整（表现为「团队文档里少了很多团队」）。
      filter: JSON.stringify({ onlyMember: true }),
      options: 'withPermissions',
    }).then((r) => ({
      files: (r.rows || r.files || r.items || []).map(this.normalizeFile),
      path: '/Team',
      hasMore: !!r.hasMore,
    }))
  }

  /** 部门文档入口：与原版一致，列出有文档的部门及其下级部门。 */
  orgList(): Promise<DiskListResult> {
    return this.request<any>('GET', '/org/list', {
      filter: JSON.stringify({ fileNotEmpty: true, withDescendants: true }),
    }).then((r) => ({
      files: (r.rows || []).map((org: any) => this.normalizeFile({
        ...org,
        path: '/Org/' + org.id,
        type: 'D',
      })),
      path: '/Org',
      hasMore: !!r.hasMore,
    }))
  }

  /** 公开文档分类列表 */
  publicClasses(): Promise<any[]> {
    return this.request<any>('GET', '/public/list_class').then((r) =>
      (Array.isArray(r) ? r : r.rows || r.files || r.items || []).map((c: any) => ({
        id: '/Public',
        name: c.name || c.className || '',
        classId: c.classId || c.id,
        isDeleted: !!c.isDeleted,
      })),
    )
  }

  /* ============ 文件操作 ============ */

  /**
   * 列目录
   * 逆向自 home.js loadFolder + getDiskFileList：
   * - 个人盘根目录是 /Private（传 / 会 500！）
   * - 参数：path + bounds(JSON: {offset,limit}) + options(JSON: {dataLimitMode})
   * - getDiskFileList 会 delete 掉 orders，个人盘不需要 orders
   * - 响应：{ rows: [...], hasMore: bool }
   */
  list(
    path: string = '/Private',
    limit: number = 100,
    classId?: string,
  ): Promise<DiskListResult> {
    const params: Record<string, any> = {
      path,
      bounds: JSON.stringify({ offset: 0, limit }),
      options: JSON.stringify({ dataLimitMode: 'hasMore' }),
    }
    if (classId) {
      params.classId = classId
      params.orders = JSON.stringify([
        { by: 'type', ascending: true },
        { by: 'name', ascending: true },
      ])
    }
    return this.request<any>('GET', '/file/list', params).then((r) => ({
      files: (r.rows || r.files || r.items || []).map(this.normalizeFile),
      path,
      hasMore: !!r.hasMore,
    }))
  }

  /** 文件详情 */
  info(fileId: string): Promise<DiskFile> {
    return this.request<any>('GET', '/file/info', { file: fileId }).then(
      this.normalizeFile,
    )
  }

  /** 批量详情 */
  batchInfo(ids: string[]): Promise<DiskFile[]> {
    return this.request<any>('POST', '/file/batchInfo', {}, { ids }).then((r) =>
      (r.files || r || []).map(this.normalizeFile),
    )
  }

  /** 路径链 */
  chain(path: string): Promise<any[]> {
    return this.request<any[]>('GET', '/file/chain', { path })
  }

  /** 创建目录 */
  mkdirs(path: string, classId?: string): Promise<any> {
    return this.request('POST', '/file/mkdirs', {}, { path, classId })
  }

  /** 移动 */
  move(from: string, to: string): Promise<any> {
    return this.request('POST', '/file/move', {}, { from, to })
  }

  /** 复制 */
  copy(from: string, to: string): Promise<any> {
    return this.request('POST', '/file/copy', {}, { from, to })
  }

  /** 搜索 */
  search(keyword: string): Promise<DiskFile[]> {
    return this.request<any>('GET', '/file/search', {
      keyword,
      bounds: JSON.stringify({ offset: 0, limit: 100 }),
    }).then((r) =>
      (r.rows || r.files || r.items || []).map(this.normalizeFile),
    )
  }

  /** 锁定文件 */
  lock(files: string | string[]): Promise<any> {
    const f = Array.isArray(files) ? files.join(',') : files
    return this.request('POST', '/file/lock', {}, { files: f })
  }

  /** 校验目录名 */
  checkDirName(parentDirId: string, childDirName: string, classId?: string): Promise<any> {
    return this.request('GET', '/file/check_dir_name', {
      parentDirId,
      childDirName,
      classId,
    })
  }

  /** 创建空白文件 */
  createBlank(name: string, parentPath: string, type: string = 'doc'): Promise<any> {
    return this.request('POST', '/files/create/blank', {}, { name, parentPath, type })
  }

  /* ============ 分享 ============ */

  /** 分享列表（我发出的） */
  myShares(): Promise<any[]> {
    return this.request<any[]>('GET', '/share/list/', { type: 'by' })
  }

  /** 分享给我的 */
  sharesToMe(): Promise<any[]> {
    return this.request<any[]>('GET', '/share/list/', { type: 'to' })
  }

  /* ============ 配额 ============ */

  quota(): Promise<any> {
    return this.request<any>('GET', '/quota')
  }

  /* ============ 上传/下载（直连 stream，简化版）============ */

  /**
   * 获取文件下载 URL
   * 原版通过本地 PC 服务 ws://127.0.0.1:pc_port/v1/store/download 中转
   * 复刻版简化：直连 stream 端点
   */
  getDownloadUrl(fileId: string): string {
    const params = new URLSearchParams({
      fileId,
      access_token: authService.getAccessToken(),
      appId: this.config.diskAppId,
      appVersion: '3.6.0',
      deviceId: authService.getDeviceId() || '',
      os: /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Mac' : 'Windows',
    })
    return this.apiBase + '/stream/download?' + params.toString()
  }

  /**
   * 上传文件（HTTP 直传，简化版；原版走 WS 分片）
   * @param parentPath 父目录路径
   * @param file 文件对象（浏览器 File）
   */
  async upload(parentPath: string, file: File): Promise<any> {
    const form = new FormData()
    form.append('parentPath', parentPath)
    form.append('file', file)
    const resp = await fetch(this.apiBase + '/file/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + authService.getAccessToken(),
        appId: this.config.diskAppId,
      },
      body: form,
    })
    if (!resp.ok) throw new Error(`上传失败: HTTP ${resp.status}`)
    return resp.json()
  }

  /* ============ 在线编辑 ============ */

  /** 构造在线编辑 WebSocket URL（WPS 协同） */
  getOnlineEditWsUrl(fileId: string): string {
    const streamUrl =
      localStorage.getItem('diskStreamUrl') ||
      this.siteUrl.replace(/\/$/, '') + '/stream'
    return (
      streamUrl +
      '/v1/file/open?Authorization=Bearer ' +
      encodeURIComponent(authService.getAccessToken()) +
      '&fileId=' +
      encodeURIComponent(fileId)
    )
  }

  /* ============ 工具 ============ */

  private normalizeFile = (r: any): DiskFile => {
    const modified = r.modifiedTime || r.updateTime || r.update_time
    return {
      id: String(r.id ?? r.fileId ?? ''),
      name: r.name || r.fileName || '',
      path: r.path || r.filepath || '',
      type: (r.type === 'D' || r.isDirectory ? 'D' : 'F') as 'F' | 'D',
      ext: r.ext || r.extension,
      size: r.actualSize ?? r.size,
      parentId: r.parentId || r.parent_id,
      classId: r.classId,
      createTime: r.createTime || r.create_time || r.joinTime,
      // openapi 搜索返回 "YYYY-MM-DD hh:mm" 字符串，pan 接口返回毫秒时间戳
      updateTime:
        typeof modified === 'number'
          ? modified
          : modified
            ? Date.parse(String(modified).replace(' ', 'T'))
            : undefined,
      preview:
        r.preview != null
          ? { available: !!r.preview.available, wopiSupport: !!r.preview.wopiSupport }
          : undefined,
      previewable: !!r.previewable || !!(r.permissions && r.permissions.previewable),
      permissions: r.permissions,
    }
  }
}

export const diskClient = new DiskClient()
