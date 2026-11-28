import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { authService } from '../services/auth'
import { getServerPaths } from '../services/config'
import {
  clearInvalidShares,
  createFolder,
  createShare,
  deleteItem,
  deleteShare,
  listDepartmentSpaces,
  listDir,
  listMyShares,
  listReceivedShares,
  listSharedDir,
  listTeamSpaces,
  modifyShare,
  previewUrl,
  sharedDownloadUrl,
  sharedPreviewUrl,
  transferShare,
  type PanDiskItem,
  type PanShareInput,
  type PanShareItem,
  type PanShareLinkInfo,
} from '../services/disk-pan'
import {
  diskClient,
  type DiskFile,
} from '../services/disk-client'
import { editUrl } from '../services/pan-client'

export interface DiskDrive {
  /** 盘标识：/Private /Team /Org /Public/<classId> /Shared */
  id: string
  name: string
  /** private | team | org | public | shared | myshare */
  kind: 'private' | 'team' | 'org' | 'public' | 'shared' | 'myshare'
  classId?: string
}

export const useDiskStore = defineStore('disk', () => {
  const drives = ref<DiskDrive[]>([])
  const currentDrive = ref<DiskDrive | null>(null)
  const files = ref<DiskFile[]>([])
  const loading = ref(false)
  const error = ref('')
  /** 当前浏览路径：{id: 目录 id, name: 显示名}，根目录为第一条 */
  const trail = ref<Array<{ id: string; name: string }>>([])
  /** 团队盘和部门盘的入口列表 */
  const subEntries = ref<DiskFile[]>([])
  /** 共享给我列表（仅「共享给我」入口使用） */
  const shares = ref<PanShareItem[]>([])
  /** 我发出的分享列表（仅「我的共享」入口使用） */
  const myShares = ref<PanShareItem[]>([])
  /** 当前正在浏览的分享 id；为空表示浏览自己的盘 */
  const currentShareId = ref('')
  /** 全盘搜索关键词；非空表示列的是搜索结果而不是目录内容 */
  const searchKeyword = ref('')

  const currentPath = computed(
    () => trail.value.slice(1).map((x) => x.name).join(' / ') || '/',
  )
  /** 模板用 history.length 判断能否返回 */
  const history = computed(() => trail.value)
  const currentDirId = computed(() =>
    trail.value.length ? trail.value[trail.value.length - 1]!.id : '',
  )

  function toDiskFile(it: PanDiskItem): DiskFile {
    const name = String(it.name || '')
    const ext =
      it.type === 'F' && name.includes('.')
        ? name.split('.').pop()!.toLowerCase()
        : undefined
    return {
      id: String(it.id ?? ''),
      name,
      path: '',
      type: it.type === 'D' ? 'D' : 'F',
      ext,
      size: typeof it.size === 'number' ? it.size : undefined,
      updateTime: it.updatedAt || undefined,
      permissions: it.permissions,
    }
  }

  function sortFiles(list: DiskFile[]): DiskFile[] {
    return [...list].sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name, 'zh')
        : a.type === 'D'
          ? -1
          : 1,
    )
  }

  /** 加载各盘（system/info + public 分类） */
  async function loadDrives() {
    loading.value = true
    error.value = ''
    try {
      const info = await diskClient.systemInfo().catch(() => ({}))
      const list: DiskDrive[] = []
      if (info.enabledPrivate !== 0)
        list.push({ id: '/Private', name: info.privateName || '个人盘', kind: 'private' })
      if (info.enabledTeam !== 0)
        list.push({ id: '/Team', name: info.teamName || '团队盘', kind: 'team' })
      if (info.enabledOrg !== 0)
        list.push({ id: '/Org', name: info.orgName || '公司盘', kind: 'org' })
      // 公开文档分类
      try {
        const classes = await diskClient.publicClasses()
        for (const c of classes) {
          if (c.isDeleted) continue
          list.push({
            id: '/Public/' + c.classId,
            name: c.name || '公开文档',
            kind: 'public',
            classId: c.classId,
          })
        }
      } catch {
        /* 无公开盘 */
      }
      // 共享协作：服务端没有对应的「盘」，这里补两个本地入口
      list.push({ id: '/MyShares', name: '我的共享', kind: 'myshare' })
      list.push({ id: '/Shared', name: '共享给我', kind: 'shared' })
      drives.value = list
      if (list.length && !currentDrive.value) {
        await openDrive(list[0]!)
      }
    } catch (e: any) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  /** 切换盘 */
  async function openDrive(drive: DiskDrive) {
    currentDrive.value = drive
    subEntries.value = []
    shares.value = []
    myShares.value = []
    currentShareId.value = ''
    searchKeyword.value = ''
    error.value = ''
    if (drive.kind === 'shared') {
      trail.value = [{ id: '', name: drive.name }]
      await loadShares()
      return
    }
    if (drive.kind === 'myshare') {
      trail.value = [{ id: '', name: drive.name }]
      await loadMyShares()
      return
    }
    if (drive.kind === 'team') {
      trail.value = [{ id: '', name: drive.name }]
      await loadSub('/Team')
      return
    }
    if (drive.kind === 'org') {
      trail.value = [{ id: '', name: drive.name }]
      await loadSub('/Org')
      return
    }
    const rootId =
      drive.kind === 'private'
        ? authService.getCurrentUserId()
        : drive.classId || ''
    trail.value = [{ id: rootId, name: drive.name }]
    await list(rootId)
  }

  /** 团队盘和部门盘入口列表 */
  async function loadSub(path: string) {
    loading.value = true
    error.value = ''
    searchKeyword.value = ''
    try {
      if (path === '/Org') {
        subEntries.value = (await listDepartmentSpaces()).map(toDiskFile)
      } else {
        subEntries.value = (await listTeamSpaces()).map(toDiskFile)
      }
      files.value = []
    } catch (e: any) {
      error.value = e.message
      subEntries.value = []
    } finally {
      loading.value = false
    }
  }

  /** 列出目录 */
  async function list(dirId: string) {
    loading.value = true
    error.value = ''
    searchKeyword.value = ''
    try {
      const items = (await listDir(dirId)).map(toDiskFile)
      // 列表与写操作统一使用文档服务，旧 openapi 会返回已删除的历史条目。
      files.value = sortFiles(items)
      subEntries.value = []
    } catch (e: any) {
      error.value = e.message
      files.value = []
    } finally {
      loading.value = false
    }
  }

  /** 共享给我：加载分享列表 */
  async function loadShares() {
    loading.value = true
    error.value = ''
    currentShareId.value = ''
    searchKeyword.value = ''
    try {
      shares.value = await listReceivedShares()
      myShares.value = []
      files.value = []
      subEntries.value = []
    } catch (e: any) {
      error.value = '加载共享给我的内容失败：' + (e?.message || String(e))
      shares.value = []
    } finally {
      loading.value = false
    }
  }

  /** 我的共享：加载我发出的分享 */
  async function loadMyShares() {
    loading.value = true
    error.value = ''
    currentShareId.value = ''
    searchKeyword.value = ''
    try {
      myShares.value = await listMyShares()
      shares.value = []
      files.value = []
      subEntries.value = []
    } catch (e: any) {
      error.value = '加载我的共享失败：' + (e?.message || String(e))
      myShares.value = []
    } finally {
      loading.value = false
    }
  }

  /** 共享给我：列出分享目录内容（需带 x-share-id） */
  async function listShared(dirId: string) {
    loading.value = true
    error.value = ''
    searchKeyword.value = ''
    try {
      const items = (await listSharedDir(dirId, currentShareId.value)).map(toDiskFile)
      files.value = sortFiles(items)
      shares.value = []
      subEntries.value = []
    } catch (e: any) {
      error.value = e.message
      files.value = []
    } finally {
      loading.value = false
    }
  }

  /** 共享给我：进入一条分享；文件分享不进入目录，由列表里的下载/预览处理 */
  async function enterShare(share: PanShareItem) {
    const valid = share.status === 0 || share.status === -2
    if (share.resourceType !== 'D' || !valid) return
    currentShareId.value = share.id
    const root = trail.value[0] || { id: '', name: currentDrive.value?.name || '共享给我' }
    trail.value = [root, { id: share.resourceId, name: share.title }]
    await listShared(share.resourceId)
  }

  async function enter(dir: DiskFile) {
    if (dir.type !== 'D') return
    trail.value.push({ id: dir.id, name: dir.name })
    if (currentShareId.value) await listShared(dir.id)
    else await list(dir.id)
  }

  async function enterTeam(team: DiskFile) {
    const root = trail.value[0] || { id: '', name: currentDrive.value?.name || '' }
    trail.value = [root, { id: team.id, name: team.name }]
    await list(team.id)
  }

  async function back() {
    if (trail.value.length <= 1) return
    trail.value.pop()
    if (currentShareId.value) {
      if (trail.value.length === 1) await loadShares()
      else await listShared(currentDirId.value)
      return
    }
    // 团队/部门根节点只是入口列表的标题，没有可列出的目录
    const kind = currentDrive.value?.kind
    if (trail.value.length === 1 && (kind === 'team' || kind === 'org')) {
      if (kind === 'team') await loadSub('/Team')
      else await loadSub('/Org')
      return
    }
    await list(currentDirId.value)
  }

  async function refresh() {
    if (searchKeyword.value) {
      await search(searchKeyword.value)
      return
    }
    if (currentShareId.value) {
      if (trail.value.length > 1) await listShared(currentDirId.value)
      else await loadShares()
      return
    }
    if (currentDirId.value) await list(currentDirId.value)
    else if (currentDrive.value) await openDrive(currentDrive.value)
  }

  async function mkdir(name: string) {
    if (!currentDirId.value) throw new Error('请先进入一个目录')
    await createFolder(currentDirId.value, name)
    await refresh()
  }

  async function remove(file: DiskFile) {
    error.value = ''
    try {
      await deleteItem({
        id: file.id,
        name: file.name,
        type: file.type,
      })
    } catch (e: any) {
      error.value = '删除失败：' + (e?.message || String(e))
      throw e
    }
    await refresh()
  }

  async function search(keyword: string) {
    loading.value = true
    error.value = ''
    searchKeyword.value = keyword
    try {
      files.value = sortFiles(await diskClient.search(keyword))
      subEntries.value = []
      shares.value = []
    } catch (e: any) {
      error.value = e.message
      files.value = []
    } finally {
      loading.value = false
    }
  }

  /** 退出全盘搜索，回到当前目录 */
  async function exitSearch() {
    searchKeyword.value = ''
    await refresh()
  }

  /** 打开在线编辑（WPS），失败时退回预览 */
  async function onlineEdit(file: DiskFile) {
    error.value = ''
    try {
      let url = ''
      try {
        // 与「消息 → 群聊 → 任务与文档」一致：群文档只存在于 pan 文档服务，
        // 必须按 fileId 向 panDocUri 换编辑地址。
        url = await editUrl(file.id)
      } catch {
        // 仅存在于旧 openapi 的历史文件不在 pan 文档服务里，退回 WPS 3rd。
        url = wps3rdUrl(file)
      }
      await openUrl(url)
    } catch (e: any) {
      error.value = '在线编辑失败：' + (e?.message || String(e))
    }
  }

  function wps3rdUrl(file: DiskFile): string {
    const paths = getServerPaths()
    const wps = String(paths.driveWpsUri || paths.onlineDocUri || '').replace(/\/+$/, '')
    if (!wps) throw new Error('缺少 driveWpsUri')
    const ext = file.ext || ''
    return (
      wps +
      '/v1/api/file/wps3rd?storeSource=2&fileId=' +
      encodeURIComponent(file.id) +
      '&filePath=' +
      encodeURIComponent(ext) +
      '&access_token=' +
      encodeURIComponent(authService.getAccessToken())
    )
  }

  /** 下载：openapi 的 stream 接口会 302 到 S3 签名地址 */
  async function download(file: DiskFile) {
    error.value = ''
    try {
      const url = currentShareId.value
        ? await sharedDownloadUrl(file.id, currentShareId.value)
        : diskClient.getDownloadUrl(file.id)
      await openUrl(url)
    } catch (e: any) {
      error.value = '下载失败：' + (e?.message || String(e))
    }
  }

  /** 共享给我：下载文件分享（文件分享没有进入目录这一步） */
  async function downloadShare(share: PanShareItem) {
    if (share.resourceType !== 'F') return
    error.value = ''
    try {
      await openUrl(await sharedDownloadUrl(share.resourceId, share.id))
    } catch (e: any) {
      error.value = '下载失败：' + (e?.message || String(e))
    }
  }

  /** 预览：自己的文件与共享里的文件走同一入口，地址来源不同 */
  async function preview(file: DiskFile) {
    error.value = ''
    try {
      const url = currentShareId.value
        ? await sharedPreviewUrl(file.id, currentShareId.value)
        : await previewUrl(file.id)
      await openUrl(url)
    } catch (e: any) {
      error.value = '预览失败：' + (e?.message || String(e))
    }
  }

  /** 共享给我：预览文件分享 */
  async function previewShare(share: PanShareItem) {
    if (share.resourceType !== 'F') return
    error.value = ''
    try {
      await openUrl(await sharedPreviewUrl(share.resourceId, share.id))
    } catch (e: any) {
      error.value = '预览失败：' + (e?.message || String(e))
    }
  }

  /** 创建或修改共享；在「我的共享」页时顺带刷新列表 */
  async function saveShare(
    input: PanShareInput,
    shareId?: string,
  ): Promise<PanShareLinkInfo> {
    const info = shareId
      ? await modifyShare(shareId, input)
      : await createShare(input)
    if (currentDrive.value?.kind === 'myshare') await loadMyShares()
    return info
  }

  /** 取消我发出的共享 / 删除收到的共享 */
  async function revokeShare(share: PanShareItem) {
    const way = share.way || 1
    await deleteShare(share.id, way)
    if (way === 1) await loadMyShares()
    else await loadShares()
  }

  /** 一键清理失效共享 */
  async function clearInvalid(way: 1 | 2) {
    await clearInvalidShares(way)
    if (way === 1) await loadMyShares()
    else await loadShares()
  }

  /** 转存收到的共享到自己的目录（默认个人盘根目录） */
  async function transfer(share: PanShareItem, targetDirId: string) {
    await transferShare(share.id, targetDirId)
  }

  return {
    drives,
    currentDrive,
    currentPath,
    currentDirId,
    currentShareId,
    searchKeyword,
    files,
    shares,
    myShares,
    loading,
    error,
    history,
    trail,
    subEntries,
    loadDrives,
    openDrive,
    loadShares,
    loadMyShares,
    list,
    listShared,
    enter,
    enterShare,
    enterTeam,
    back,
    refresh,
    mkdir,
    remove,
    search,
    exitSearch,
    onlineEdit,
    download,
    downloadShare,
    preview,
    previewShare,
    saveShare,
    revokeShare,
    clearInvalid,
    transfer,
  }
})
