import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { authService } from '../services/auth'
import { getServerPaths } from '../services/config'
import {
  createFolder,
  deleteItem,
  listDir,
  type PanDiskItem,
} from '../services/disk-pan'
import {
  diskClient,
  type DiskFile,
} from '../services/disk-client'

export interface DiskDrive {
  /** 盘标识：/Private /Team /Org /Public/<classId> */
  id: string
  name: string
  /** private | team | org | public */
  kind: 'private' | 'team' | 'org' | 'public'
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
    error.value = ''
    if (drive.kind === 'team') {
      trail.value = []
      await loadSub('/Team')
      return
    }
    if (drive.kind === 'org') {
      trail.value = []
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
    try {
      const r = await (path === '/Org' ? diskClient.orgList() : diskClient.teamList())
      subEntries.value = r.files
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
    try {
      const items = await listDir(dirId)
      files.value = sortFiles(items.map(toDiskFile))
      subEntries.value = []
    } catch (e: any) {
      error.value = e.message
      files.value = []
    } finally {
      loading.value = false
    }
  }

  async function enter(dir: DiskFile) {
    if (dir.type !== 'D') return
    trail.value.push({ id: dir.id, name: dir.name })
    await list(dir.id)
  }

  async function enterTeam(team: DiskFile) {
    trail.value = [{ id: team.id, name: team.name }]
    await list(team.id)
  }

  async function back() {
    if (trail.value.length > 1) {
      trail.value.pop()
      await list(currentDirId.value)
      return
    }
    // 团队/部门盘从具体团队返回入口列表
    if (currentDrive.value?.kind === 'team' || currentDrive.value?.kind === 'org') {
      trail.value = []
      await loadSub(currentDrive.value.kind === 'team' ? '/Team' : '/Org')
    }
  }

  async function refresh() {
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
    try {
      files.value = await diskClient.search(keyword)
    } catch (e: any) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  /** 打开在线编辑（WPS），失败时退回预览 */
  async function onlineEdit(file: DiskFile) {
    error.value = ''
    try {
      const paths = getServerPaths()
      const wps = String(paths.driveWpsUri || paths.onlineDocUri || '').replace(/\/+$/, '')
      if (!wps) throw new Error('缺少 driveWpsUri')
      const ext = file.ext || ''
      const url =
        wps +
        '/v1/api/file/wps3rd?storeSource=2&fileId=' +
        encodeURIComponent(file.id) +
        '&filePath=' +
        encodeURIComponent(ext) +
        '&access_token=' +
        encodeURIComponent(authService.getAccessToken())
      await openUrl(url)
    } catch (e: any) {
      error.value = '在线编辑失败：' + (e?.message || String(e))
    }
  }

  /** 下载：openapi 的 stream 接口会 302 到 S3 签名地址 */
  async function download(file: DiskFile) {
    error.value = ''
    try {
      await openUrl(diskClient.getDownloadUrl(file.id))
    } catch (e: any) {
      error.value = '下载失败：' + (e?.message || String(e))
    }
  }

  return {
    drives,
    currentDrive,
    currentPath,
    currentDirId,
    files,
    loading,
    error,
    history,
    trail,
    subEntries,
    loadDrives,
    openDrive,
    list,
    enter,
    enterTeam,
    back,
    refresh,
    mkdir,
    remove,
    search,
    onlineEdit,
    download,
  }
})
