import { defineStore } from 'pinia'
import { ref } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { editUrl, signDownload } from '../services/pan-client'
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
  const currentPath = ref('/Private')
  const files = ref<DiskFile[]>([])
  const loading = ref(false)
  const error = ref('')
  const history = ref<string[]>(['/Private'])
  /** 团队盘和部门盘的入口列表 */
  const subEntries = ref<DiskFile[]>([])

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
        await openDrive(list[0])
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
    history.value = [drive.id]
    subEntries.value = []
    if (drive.kind === 'team') {
      await loadSub('/Team')
      return
    }
    if (drive.kind === 'org') {
      await loadSub('/Org')
      return
    }
    if (drive.kind === 'public') {
      await list('/Public', 100, drive.classId)
      return
    }
    await list('/Private')
  }

  /** 团队盘和部门盘入口列表 */
  async function loadSub(path: string) {
    loading.value = true
    error.value = ''
    try {
      const r = await (path === '/Org' ? diskClient.orgList() : diskClient.teamList())
      subEntries.value = r.files
      files.value = []
      currentPath.value = path
    } catch (e: any) {
      error.value = e.message
      subEntries.value = []
    } finally {
      loading.value = false
    }
  }

  async function list(path: string = currentPath.value, limit = 100, classId?: string) {
    if ((currentDrive.value?.kind === 'team' && path === '/Team') ||
        (currentDrive.value?.kind === 'org' && path === '/Org')) {
      await loadSub(path)
      return
    }
    loading.value = true
    error.value = ''
    try {
      const drive = currentDrive.value
      const cid = classId ?? (drive?.kind === 'public' ? drive.classId : undefined)
      const r = await diskClient.list(path, limit, cid)
      files.value = r.files
      currentPath.value = path
      if (history.value[history.value.length - 1] !== path) {
        history.value.push(path)
      }
    } catch (e: any) {
      error.value = e.message
      files.value = []
    } finally {
      loading.value = false
    }
  }

  async function enter(dir: DiskFile) {
    if (dir.type !== 'D') return
    subEntries.value = []
    await list(dir.path)
  }

  async function enterTeam(team: DiskFile) {
    subEntries.value = []
    await list(team.path || team.id)
  }

  async function back() {
    if (history.value.length > 1) {
      history.value.pop()
      const prev = history.value[history.value.length - 1]
      await list(prev)
    }
  }

  async function refresh() {
    await list(currentPath.value)
  }

  async function mkdir(name: string) {
    const base = currentPath.value === '/' ? '' : currentPath.value
    await diskClient.mkdirs(base + '/' + name)
    await refresh()
  }

  async function remove(file: DiskFile) {
    error.value = ''
    try {
      await diskClient.delete(file.id || file.path)
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

  /** 获取服务端编辑地址后交给系统浏览器打开。 */
  async function onlineEdit(file: DiskFile) {
    error.value = ''
    try {
      await openUrl(await editUrl(file.id))
    } catch (e: any) {
      error.value = '在线编辑失败：' + (e?.message || String(e))
    }
  }

  async function download(file: DiskFile) {
    error.value = ''
    try {
      await openUrl(await signDownload(file.id))
    } catch (e: any) {
      error.value = '下载失败：' + (e?.message || String(e))
    }
  }

  return {
    drives,
    currentDrive,
    currentPath,
    files,
    loading,
    error,
    history,
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
