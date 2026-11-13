import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { authService } from '../services/auth'
import { getServerPaths } from '../services/config'
import { useImStore } from './im'
import { fetchSessions } from '../services/im/session-api'
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
import { editUrl } from '../services/pan-client'

export interface DiskDrive {
  /** 盘标识：/Private /Team /Org /Groups /Public/<classId> */
  id: string
  name: string
  /** private | team | org | group | public */
  kind: 'private' | 'team' | 'org' | 'group' | 'public'
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
      // 群文档：把聊天群/团队群的文档空间聚合成一个入口
      list.push({ id: '/Groups', name: '群文档', kind: 'group' })
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
    if (drive.kind === 'group') {
      trail.value = []
      await loadGroups()
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

  /** 群文档：聊天群/团队群的文档空间 */
  async function loadGroups() {
    loading.value = true
    error.value = ''
    try {
      const im = useImStore()
      let groups: Array<{ id: string; name: string; type: number }> =
        im.sessions.filter((s) => s.type === 2)
      if (!groups.length) {
        groups = (await fetchSessions()).filter((s) => s.type === 2)
      }
      subEntries.value = groups
        .map((s) => ({ id: s.id, name: s.name, path: '', type: 'D' as const }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      files.value = []
      trail.value = []
    } catch (e: any) {
      error.value = '群文档加载失败：' + (e?.message || String(e))
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
    // 团队/部门/群文档从具体目录返回入口列表
    const kind = currentDrive.value?.kind
    if (kind === 'team' || kind === 'org' || kind === 'group') {
      trail.value = []
      if (kind === 'team') await loadSub('/Team')
      else if (kind === 'org') await loadSub('/Org')
      else await loadGroups()
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
