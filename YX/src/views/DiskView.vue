<template>
  <div class="disk-layout" @dragover.prevent @drop.prevent>
    <SideNav active="disk" />

    <!-- 盘列表 -->
    <aside class="drive-panel">
      <div class="panel-header" data-tauri-drag-region="deep"><h3>云盘</h3></div>
      <ul class="drive-list">
        <li
          v-for="d in disk.drives"
          :key="d.id"
          :class="{ active: disk.currentDrive?.id === d.id }"
          @click="onOpenDrive(d)"
        >
          <span class="drive-icon">{{ driveIcon(d.kind) }}</span>
          <span>{{ d.name }}</span>
        </li>
        <li v-if="disk.drives.length === 0" class="empty">加载中…</li>
      </ul>
    </aside>

    <main
      class="disk-main"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <header class="disk-header" data-tauri-drag-region="deep">
        <div class="path-bar">
          <button class="secondary small" @click="disk.back()" :disabled="disk.history.length <= 1">← 返回</button>
          <button class="secondary small" @click="disk.refresh()">刷新</button>
          <button v-if="!disk.currentShareId && !isMyShareRoot" class="secondary small" @click="showMkdir = !showMkdir">+ 新建目录</button>
          <button v-if="!disk.currentShareId && !isMyShareRoot" class="small" :disabled="!disk.currentDirId" @click="pickUpload">上传</button>
          <input v-if="!disk.currentShareId && !isMyShareRoot" ref="uploadInput" type="file" multiple hidden @change="onUploadChange" />
          <div class="path">
            📁 {{ disk.currentDrive?.name }}<template v-if="disk.currentPath !== '/'"> · {{ disk.currentPath }}</template>
          </div>
          <span v-if="activeUploads" class="upload-note">{{ activeUploads }} 个上传中</span>
        </div>
        <div v-if="isShareRoot" class="share-hint">别人分享给我的文件与目录；目录可直接进入浏览。</div>
        <div v-if="isMyShareRoot" class="share-hint">我发出的外链与内部共享；可编辑有效期/权限、复制链接或取消共享。</div>
        <div class="search-bar">
          <input
            v-model="keyword"
            :placeholder="filterPlaceholder"
            @keydown.esc="keyword = ''"
          />
          <button v-if="disk.currentDrive?.kind !== 'shared' && disk.currentDrive?.kind !== 'myshare'" class="small" :disabled="!keyword.trim()" @click="onGlobalSearch">全盘搜索</button>
          <button v-if="isMyShareRoot" class="secondary small" :disabled="disk.loading" @click="onClearInvalid">清理失效</button>
          <button class="secondary small" @click="onOpenDrive(disk.currentDrive!)">回到盘根</button>
        </div>
      </header>

      <div v-if="showMkdir && !disk.currentShareId && !isMyShareRoot" class="mkdir-bar">
        <input v-model="mkdirName" placeholder="新目录名" @keydown.enter="onMkdir" />
        <button class="small" @click="onMkdir">创建</button>
      </div>

      <div v-if="disk.error" class="error">{{ disk.error }}</div>
      <div v-if="notice" class="notice">
        {{ notice }}
        <button class="link-btn" @click="notice = ''">知道了</button>
      </div>

      <div v-if="!disk.loading" class="list-meta">
        <span class="count-text">{{ countText }}</span>
        <button v-if="hasFilter" class="link-btn" @click="keyword = ''">清除筛选</button>
        <button v-if="disk.searchKeyword" class="link-btn" @click="disk.exitSearch()">退出全盘搜索</button>
      </div>

      <div class="file-list">
        <div v-if="disk.loading" class="loading">加载中…</div>

        <!-- 团队、部门入口列表 -->
        <table v-else-if="disk.subEntries.length > 0">
          <thead><tr><th>{{ subEntryLabel() }}</th><th>类型</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="t in visibleSubEntries" :key="t.id" @dblclick="disk.enterTeam(t)">
              <td class="name">
                <span class="f-icon">👥</span>{{ t.name }}
              </td>
              <td>{{ subEntryLabel() }}</td>
              <td class="ops"><button class="small" @click.stop="disk.enterTeam(t)">进入</button></td>
            </tr>
            <tr v-if="visibleSubEntries.length === 0">
              <td colspan="3" class="empty">{{ emptyHint }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 我的共享：我发出的分享 -->
        <table v-else-if="isMyShareRoot" class="share-table">
          <thead>
            <tr><th>名称</th><th>形式</th><th>有效期</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in visibleMyShares" :key="s.id">
              <td class="name">
                <span class="f-icon">{{ shareIcon(s) }}</span>
                {{ s.title }}
              </td>
              <td class="nowrap">{{ shareTypeLabel(s) }}</td>
              <td class="nowrap">{{ shareExpireText(s) }}</td>
              <td class="nowrap">{{ shareStatusText(s) }}</td>
              <td class="ops">
                <template v-if="isShareValid(s)">
                  <button v-if="s.shareType !== 'S'" class="small" @click.stop="onCopyShareLink(s)">复制链接</button>
                  <button class="secondary small" @click.stop="onEditShare(s)">编辑</button>
                </template>
                <button class="secondary small danger-btn" @click.stop="askRevoke(s)">取消共享</button>
              </td>
            </tr>
            <tr v-if="visibleMyShares.length === 0">
              <td colspan="5" class="empty">{{ hasFilter ? emptyHint : '暂无我发出的共享' }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 共享给我：收到的分享 -->
        <table v-else-if="isShareRoot" class="share-table">
          <thead>
            <tr><th>名称</th><th>分享人</th><th>类型</th><th>有效期</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in visibleShares" :key="s.id" @dblclick="onOpenShare(s)">
              <td class="name">
                <span class="f-icon">{{ s.resourceType === 'D' ? '📁' : iconFor(extOf(s.title)) }}</span>
                {{ s.title }}
                <span v-if="!isShareValid(s)" class="invalid-tag">已失效</span>
              </td>
              <td class="nowrap">{{ s.creatorName || '-' }}</td>
              <td class="nowrap">{{ s.resourceType === 'D' ? '目录' : (extOf(s.title) || '文件') }}</td>
              <td class="nowrap">{{ fmtExpire(s.expireDate) }}</td>
              <td class="ops">
                <template v-if="isShareValid(s) && s.resourceType === 'D'">
                  <button class="small" @click.stop="onOpenShare(s)">进入</button>
                  <button v-if="s.permissions?.downloadable !== false" class="secondary small" @click.stop="askTransfer(s)">转存</button>
                </template>
                <template v-else-if="isShareValid(s)">
                  <button v-if="canPreviewName(s.title) && s.permissions?.previewable !== false" class="small" @click.stop="onPreviewShare(s)">预览</button>
                  <button v-if="s.permissions?.downloadable !== false" class="secondary small" @click.stop="onDownloadShare(s)">下载</button>
                  <button v-if="s.permissions?.downloadable !== false" class="secondary small" @click.stop="askTransfer(s)">转存</button>
                </template>
                <button v-if="isShareValid(s) && s.href" class="secondary small" @click.stop="onCopyShareLink(s)">复制链接</button>
                <button class="secondary small danger-btn" @click.stop="askRevoke(s)">删除共享</button>
              </td>
            </tr>
            <tr v-if="visibleShares.length === 0">
              <td colspan="5" class="empty">{{ hasFilter ? emptyHint : '暂无共享给我的内容' }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 普通文件列表 -->
        <table v-else>
          <thead>
            <tr>
              <th>名称</th><th>类型</th><th>大小</th><th>修改时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in visibleFiles" :key="f.id" @dblclick="onDblClick(f)">
              <td class="name">
                <span class="f-icon">{{ f.type === 'D' ? '📁' : iconFor(f.ext) }}</span>
                {{ f.name }}
              </td>
              <td>{{ f.type === 'D' ? '目录' : (f.ext || '文件') }}</td>
              <td>{{ f.size ? fmtSize(f.size) : '-' }}</td>
              <td>{{ fmtTime(f.updateTime) }}</td>
              <td class="ops">
                <button v-if="disk.currentShareId && canPreview(f) && f.permissions?.previewable !== false" class="small" @click.stop="onPreview(f)">预览</button>
                <button v-if="!disk.currentShareId && canOnlineEdit(f)" class="small" @click.stop="onOnlineEdit(f)">在线编辑</button>
                <button v-if="canShare(f)" class="secondary small" @click.stop="onShare(f)">分享</button>
                <button v-if="f.type === 'F' && (!disk.currentShareId || f.permissions?.downloadable !== false)" class="secondary small" @click.stop="onDownload(f)">下载</button>
                <button v-if="!disk.currentShareId" class="secondary small danger-btn" @click.stop="onDelete(f)">删除</button>
              </td>
            </tr>
            <tr v-if="visibleFiles.length === 0 && !disk.loading">
              <td colspan="5" class="empty">{{ emptyHint }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="dragging" class="drop-mask">松开鼠标上传到当前目录</div>
    </main>

    <!-- macOS WebView 不支持原生 confirm()，删除确认必须在应用内完成 -->
    <div v-if="pendingDelete" class="confirm-mask" @click.self="closeDelete">
      <section
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        tabindex="-1"
        @keydown.esc="closeDelete"
      >
        <h3 id="delete-title">删除{{ pendingDelete.type === 'D' ? '目录' : '文件' }}</h3>
        <p>确定删除「{{ pendingDelete.name }}」？删除后该条目会从当前目录移除。</p>
        <p v-if="deleteError" class="confirm-error" role="alert">{{ deleteError }}</p>
        <footer>
          <button class="secondary small" :disabled="deleting" @click="closeDelete">取消</button>
          <button ref="confirmButton" class="secondary small danger-btn" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? '删除中…' : '确认删除' }}
          </button>
        </footer>
      </section>
    </div>
    <!-- 我发出的共享：编辑/复制链接 -->
    <ShareDialog
      v-model:open="shareOpen"
      :item="shareItem"
      :edit="shareEdit"
      @saved="onShareSaved"
    />

    <!-- 取消共享 / 删除收到的共享 -->
    <div v-if="pendingRevoke" class="confirm-mask" @click.self="closeRevoke">
      <section class="confirm-dialog" role="alertdialog" aria-modal="true">
        <h3>{{ (pendingRevoke.way || 1) === 1 ? '取消共享' : '删除共享' }}</h3>
        <p v-if="(pendingRevoke.way || 1) === 1">
          确定取消共享「{{ pendingRevoke.title }}」？取消后，链接将失效。
        </p>
        <p v-else>确定删除「{{ pendingRevoke.title }}」这条共享记录？</p>
        <p v-if="revokeError" class="confirm-error" role="alert">{{ revokeError }}</p>
        <footer>
          <button class="secondary small" :disabled="revoking" @click="closeRevoke">取消</button>
          <button class="secondary small danger-btn" :disabled="revoking" @click="confirmRevoke">
            {{ revoking ? '处理中…' : '确认' }}
          </button>
        </footer>
      </section>
    </div>

    <!-- 转存收到的分享 -->
    <div v-if="pendingTransfer" class="confirm-mask" @click.self="closeTransfer">
      <section class="confirm-dialog" role="alertdialog" aria-modal="true">
        <h3>转存到我的盘</h3>
        <p>将「{{ pendingTransfer.title }}」整体转存到个人盘根目录。</p>
        <p v-if="transferError" class="confirm-error" role="alert">{{ transferError }}</p>
        <footer>
          <button class="secondary small" :disabled="transferring" @click="closeTransfer">取消</button>
          <button class="secondary small" :disabled="transferring" @click="confirmTransfer">
            {{ transferring ? '转存中…' : '确认转存' }}
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import SideNav from '../components/SideNav.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { useAuthStore } from '../stores/auth'
import { useDiskStore, type DiskDrive } from '../stores/disk'
import { OFFICE_EXT } from '../services/pan-client'
import { useUploadStore } from '../stores/uploads'
import { type DiskFile } from '../services/disk-client'
import { authService } from '../services/auth'
import { shareInfo, type PanShareItem } from '../services/disk-pan'

const auth = useAuthStore()
const disk = useDiskStore()
const router = useRouter()

const keyword = ref('')
const showMkdir = ref(false)
const mkdirName = ref('')
const uploadInput = ref<HTMLInputElement | null>(null)
const uploads = useUploadStore()
const dragging = ref(false)
const isShareRoot = computed(
  () => disk.currentDrive?.kind === 'shared' && !disk.currentShareId,
)
const activeUploads = computed(
  () => uploads.tasks.filter((t) => ['queued', 'uploading', 'saving'].includes(t.status)).length,
)
const isMyShareRoot = computed(
  () => disk.currentDrive?.kind === 'myshare' && !disk.currentShareId,
)

/** 当前目录的即时筛选（不区分大小写，匹配名称或扩展名） */
const hasFilter = computed(() => keyword.value.trim().length > 0)
const filterPlaceholder = computed(() => {
  if (isMyShareRoot.value) return '筛选我发出的共享'
  if (isShareRoot.value) return '筛选共享给我的文档或目录'
  if (disk.searchKeyword) return '在搜索结果中筛选'
  return '筛选当前目录的文档或目录'
})

function matchKeyword(name: string, ext?: string): boolean {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return true
  return (
    name.toLowerCase().includes(q) ||
    (!!ext && ext.toLowerCase().includes(q))
  )
}

const visibleFiles = computed(() => disk.files.filter((f) => matchKeyword(f.name, f.ext)))
const visibleShares = computed(() => disk.shares.filter((s) => matchKeyword(s.title)))
const visibleMyShares = computed(() => disk.myShares.filter((s) => matchKeyword(s.title)))
const visibleSubEntries = computed(() => disk.subEntries.filter((t) => matchKeyword(t.name)))

/** 列表项数量：目录 / 我的共享 / 共享给我 / 团队入口四种形态 */
const listTotal = computed(() => {
  if (disk.subEntries.length) return disk.subEntries.length
  if (isMyShareRoot.value) return visibleMyShares.value.length
  if (isShareRoot.value) return disk.shares.length
  return disk.files.length
})
const listShown = computed(() => {
  if (disk.subEntries.length) return visibleSubEntries.value.length
  if (isMyShareRoot.value) return visibleMyShares.value.length
  if (isShareRoot.value) return visibleShares.value.length
  return visibleFiles.value.length
})

const countText = computed(() => {
  const parts: string[] = []
  if (disk.searchKeyword) parts.push(`全盘搜索「${disk.searchKeyword}」`)
  if (hasFilter.value) parts.push(`筛选「${keyword.value.trim()}」`)
  const prefix = parts.length ? parts.join(' · ') + '：' : ''
  const size = hasFilter.value ? `${listShown.value} / ${listTotal.value}` : `${listTotal.value}`

  if (disk.subEntries.length) return `${prefix}共 ${size} 个${subEntryLabel()}`

  if (isMyShareRoot.value) return `${prefix}共 ${size} 项`

  if (isShareRoot.value) {
    const dirs = visibleShares.value.filter((s) => s.resourceType === 'D').length
    return `${prefix}共 ${size} 项（目录 ${dirs} · 文件 ${visibleShares.value.length - dirs}）`
  }

  const dirs = visibleFiles.value.filter((f) => f.type === 'D').length
  return `${prefix}共 ${size} 项（目录 ${dirs} · 文件 ${visibleFiles.value.length - dirs}）`
})

const emptyHint = computed(() => {
  if (hasFilter.value) return `没有匹配「${keyword.value.trim()}」的条目`
  if (disk.searchKeyword) return `全盘搜索「${disk.searchKeyword}」没有结果`
  if (disk.subEntries.length) return `暂无${subEntryLabel()}`
  if (isMyShareRoot.value) return '暂无我发出的共享'
  return '空目录'
})

onMounted(async () => {
  if (!auth.isLoggedIn) {
    router.replace('/login')
    return
  }
  await disk.loadDrives()
})

function driveIcon(kind: string): string {
  switch (kind) {
    case 'private': return '👤'
    case 'team': return '👥'
    case 'org': return '🏢'
    case 'public': return '📢'
    case 'shared': return '🤝'
    case 'myshare': return '🔗'
    default: return '📁'
  }
}

function subEntryLabel(): string {
  const kind = disk.currentDrive?.kind
  return kind === 'org' ? '部门' : '团队'
}

async function onOpenDrive(d: DiskDrive) {
  keyword.value = ''
  await disk.openDrive(d)
}

async function onDblClick(f: DiskFile) {
  if (f.type === 'D') await disk.enter(f)
}

async function onOpenShare(s: PanShareItem) {
  if (s.resourceType === 'D') await disk.enterShare(s)
  else if (s.permissions?.downloadable !== false) await disk.downloadShare(s)
}

async function onDownloadShare(s: PanShareItem) {
  await disk.downloadShare(s)
}

async function onPreviewShare(s: PanShareItem) {
  await disk.previewShare(s)
}

/* ============ 共享 ============ */

const notice = ref('')
const shareOpen = ref(false)
const shareItem = ref<{ id: string; name: string; type: 'D' | 'F' } | null>(null)
const shareEdit = ref<PanShareItem | null>(null)

/** 自己的盘里的文件/目录才能发起共享 */
function canShare(f: DiskFile): boolean {
  const kind = disk.currentDrive?.kind
  return (
    !!f.id &&
    !disk.currentShareId &&
    kind !== 'shared' &&
    kind !== 'myshare'
  )
}

function onShare(f: DiskFile) {
  shareItem.value = { id: f.id, name: f.name, type: f.type }
  shareEdit.value = null
  shareOpen.value = true
}

function onEditShare(s: PanShareItem) {
  shareItem.value = {
    id: s.resourceId || s.id,
    name: s.title,
    type: s.resourceType,
  }
  shareEdit.value = s
  shareOpen.value = true
}

function onShareSaved(edited: boolean) {
  // 新建成功由弹窗展示链接；编辑保存后弹窗直接关闭，这里给个提示
  if (edited) notice.value = '共享已更新'
}

function shareTypeLabel(s: PanShareItem): string {
  return s.shareType === 'S' ? '内部共享' : '外链共享'
}

function isShareValid(s: PanShareItem): boolean {
  return s.status === 0 || s.status === -2
}

function shareStatusText(s: PanShareItem): string {
  if (s.status === 1) return '已过期'
  if (s.status === -1) return '已失效'
  return '有效'
}

function shareExpireText(s: PanShareItem): string {
  if (s.expiredInfo) return s.expiredInfo
  if (s.status === 0) return '永久有效'
  return fmtExpire(s.expireDate)
}

function shareIcon(s: PanShareItem): string {
  return s.resourceType === 'D' ? '📁' : '📄'
}

async function onCopyShareLink(s: PanShareItem) {
  notice.value = ''
  try {
    let href = s.href
    let password = s.password
    if (!href) {
      const info = await shareInfo(s.id)
      href = info.href
      password = info.password
    }
    if (!href) throw new Error('服务端未返回链接地址')
    const text = password ? `${href} 提取码：${password}` : href
    await navigator.clipboard.writeText(text)
    notice.value = password ? '链接及提取码已复制' : '链接已复制'
  } catch (e: any) {
    disk.error = '复制链接失败：' + (e?.message || String(e))
  }
}

async function onClearInvalid() {
  try {
    await disk.clearInvalid(1)
    notice.value = '已清理失效共享'
  } catch (e: any) {
    disk.error = '清理失败：' + (e?.message || String(e))
  }
}

const pendingRevoke = ref<PanShareItem | null>(null)
const revoking = ref(false)
const revokeError = ref('')

function askRevoke(s: PanShareItem) {
  revokeError.value = ''
  pendingRevoke.value = s
}

function closeRevoke() {
  if (revoking.value) return
  pendingRevoke.value = null
  revokeError.value = ''
}

async function confirmRevoke() {
  const s = pendingRevoke.value
  if (!s || revoking.value) return
  const way = s.way || 1
  revoking.value = true
  revokeError.value = ''
  try {
    await disk.revokeShare(s)
    pendingRevoke.value = null
    notice.value = way === 1 ? '已取消共享' : '已删除共享'
  } catch (e: any) {
    revokeError.value = e?.message || String(e)
  } finally {
    revoking.value = false
  }
}

const pendingTransfer = ref<PanShareItem | null>(null)
const transferring = ref(false)
const transferError = ref('')

function askTransfer(s: PanShareItem) {
  transferError.value = ''
  pendingTransfer.value = s
}

function closeTransfer() {
  if (transferring.value) return
  pendingTransfer.value = null
  transferError.value = ''
}

async function confirmTransfer() {
  const s = pendingTransfer.value
  if (!s || transferring.value) return
  transferring.value = true
  transferError.value = ''
  try {
    await disk.transfer(s, authService.getCurrentUserId())
    pendingTransfer.value = null
    notice.value = '已转存到个人盘根目录：' + s.title
  } catch (e: any) {
    transferError.value = e?.message || String(e)
  } finally {
    transferring.value = false
  }
}

async function onPreview(f: DiskFile) {
  await disk.preview(f)
}

async function onGlobalSearch() {
  const kw = keyword.value.trim()
  if (!kw) return
  keyword.value = ''
  await disk.search(kw)
}

async function onMkdir() {
  if (!mkdirName.value.trim()) return
  try {
    await disk.mkdir(mkdirName.value.trim())
    mkdirName.value = ''
    showMkdir.value = false
  } catch (e: any) {
    disk.error = '新建目录失败：' + (e?.message || String(e))
  }
}

function pickUpload() {
  uploadInput.value?.click()
}

function enqueueFiles(files: File[]) {
  if (!files.length) return
  const dirId = disk.currentDirId
  if (!dirId) {
    disk.error = '请先进入一个目录'
    return
  }
  disk.error = ''
  uploads.enqueue(files, dirId, `${disk.currentDrive?.name || '云盘'} · ${disk.currentPath}`, () => {
    disk.refresh()
  })
}

function onUploadChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  enqueueFiles(files)
}

function onDragLeave(event: DragEvent) {
  const target = event.currentTarget as HTMLElement | null
  const related = event.relatedTarget as Node | null
  if (!target || !related || !target.contains(related)) dragging.value = false
}

function onDrop(event: DragEvent) {
  dragging.value = false
  enqueueFiles(Array.from(event.dataTransfer?.files || []))
}

const pendingDelete = ref<DiskFile | null>(null)
const deleting = ref(false)
const deleteError = ref('')
const confirmButton = ref<HTMLButtonElement | null>(null)

function onDelete(f: DiskFile) {
  deleteError.value = ''
  pendingDelete.value = f
  nextTick(() => confirmButton.value?.focus())
}

function closeDelete() {
  if (deleting.value) return
  pendingDelete.value = null
  deleteError.value = ''
}

async function confirmDelete() {
  const f = pendingDelete.value
  if (!f || deleting.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    await disk.remove(f)
    pendingDelete.value = null
  } catch (e: any) {
    deleteError.value = e?.message || String(e)
  } finally {
    deleting.value = false
  }
}

async function onDownload(f: DiskFile) {
  await disk.download(f)
}

async function onOnlineEdit(f: DiskFile) {
  await disk.onlineEdit(f)
}

function canOnlineEdit(f: DiskFile): boolean {
  return f.type === 'F' && !!f.ext && OFFICE_EXT.has(f.ext.toLowerCase())
}

/** 预览只对文档类有效：图片/压缩包等 `/v1/files/{id}/preview` 会返回 430601 */
const PREVIEW_EXT = new Set([...OFFICE_EXT, 'pdf'])

function canPreview(f: DiskFile): boolean {
  return f.type === 'F' && !!f.ext && PREVIEW_EXT.has(f.ext.toLowerCase())
}

function extOf(name: string): string | undefined {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : undefined
}

function canPreviewName(name: string): boolean {
  const ext = extOf(name)
  return !!ext && PREVIEW_EXT.has(ext)
}

function iconFor(ext?: string): string {
  if (!ext) return '📄'
  const e = ext.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(e)) return '🖼️'
  if (['doc', 'docx'].includes(e)) return '📝'
  if (['xls', 'xlsx'].includes(e)) return '📊'
  if (['ppt', 'pptx'].includes(e)) return '📽️'
  if (['mp4', 'mov', 'avi', 'mkv'].includes(e)) return '🎬'
  if (['mp3', 'wav', 'm4a'].includes(e)) return '🎵'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return '📦'
  if (['pdf'].includes(e)) return '📕'
  if (['txt', 'md', 'log', 'json', 'xml'].includes(e)) return '📃'
  return '📄'
}

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}

function fmtTime(t?: number): string {
  if (!t) return '-'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function fmtExpire(t?: number | string | null): string {
  if (!t) return '永久'
  return new Date(t).toLocaleDateString('zh-CN')
}
</script>

<style scoped>
.disk-layout { display: grid; grid-template-columns: 56px 200px 1fr; height: 100%; }

.drive-panel {
  background: var(--panel); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
}
.panel-header { height: var(--titlebar-height); padding: 0 16px 0 26px; display: flex; align-items: center; border-bottom: 1px solid var(--border); }
.panel-header h3 { font-size: 15px; font-weight: 600; }
.drive-list { list-style: none; flex: 1; overflow-y: auto; }
.drive-list li {
  padding: 12px 16px; display: flex; align-items: center; gap: 10px;
  cursor: pointer; font-size: 14px;
}
.drive-list li:hover { background: var(--hover); }
.drive-list li.active { background: var(--selected); color: var(--primary); font-weight: 500; }
.drive-list li.empty { color: var(--text-muted); cursor: default; justify-content: center; }
.drive-icon { font-size: 16px; }

.disk-main { position: relative; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.disk-header {
  padding: 0 16px 10px; background: var(--panel);
  border-bottom: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 8px;
}
.path-bar { min-height: var(--titlebar-height); align-items: center; }
.path-bar { display: flex; align-items: center; gap: 8px; }
.path { flex: 1; color: var(--text-muted); font-size: 13px; }
.upload-note { color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.drop-mask {
  position: absolute; inset: 8px; z-index: 20;
  display: flex; align-items: center; justify-content: center;
  border: 2px dashed var(--primary); border-radius: 10px;
  background: rgba(242, 136, 35, 0.08); color: var(--primary);
  font-size: 14px; pointer-events: none;
}
.search-bar { display: flex; gap: 8px; }
.search-bar input { flex: 1; }
.share-hint { color: var(--text-muted); font-size: 12px; }
.invalid-tag {
  margin-left: 6px; padding: 1px 6px; border-radius: 4px; font-size: 11px;
  background: var(--bg-subtle); color: var(--text-muted);
}
.small { padding: 5px 12px; font-size: 12px; }
.danger-btn { color: var(--danger); }

.mkdir-bar {
  padding: 10px 20px; background: var(--bg-subtle); border-bottom: 1px solid var(--border);
  display: flex; gap: 8px;
}

.error { margin: 12px 20px; padding: 8px 12px; background: var(--danger-soft); color: var(--danger); border-radius: 6px; }
.notice {
  margin: 12px 20px 0; padding: 8px 12px; border-radius: 6px;
  background: var(--bg-subtle); color: var(--text-muted); font-size: 12px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}

.list-meta {
  padding: 6px 20px; background: var(--bg-subtle); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 12px;
  font-size: 12px; color: var(--text-muted);
}
.count-text { flex: 1; }
.link-btn {
  background: none; border: none; padding: 0; cursor: pointer;
  color: var(--primary); font-size: 12px;
}
.link-btn:hover { text-decoration: underline; }

.file-list { flex: 1; overflow-y: auto; padding: 16px 20px; }
.loading, .empty { text-align: center; color: var(--text-muted); padding: 20px; }
table { width: 100%; border-collapse: collapse; }
thead th {
  text-align: left; padding: 8px 12px; font-size: 12px; color: var(--text-muted);
  border-bottom: 1px solid var(--border); font-weight: 500;
}
tbody td { padding: 10px 12px; border-bottom: 1px solid var(--divider); font-size: 13px; }
tbody tr:hover { background: var(--hover); }
.name .f-icon { margin-right: 6px; }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
/* 共享列表：名称列可换行，其余列不挤压 */
.share-table th { white-space: nowrap; }
.share-table td.nowrap { white-space: nowrap; }
.share-table td.name { min-width: 200px; word-break: break-all; }

.confirm-mask {
  position: fixed; inset: 0; z-index: 50;
  background: var(--overlay);
  display: flex; align-items: center; justify-content: center;
}
.confirm-dialog {
  width: min(380px, 90vw); padding: 20px;
  background: var(--surface); border-radius: 10px;
  box-shadow: var(--shadow-2);
}
.confirm-dialog h3 { font-size: 15px; margin-bottom: 10px; }
.confirm-dialog p { font-size: 13px; line-height: 1.6; color: var(--text-muted); }
.confirm-dialog .confirm-error { margin-top: 8px; color: var(--danger); }
.confirm-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
</style>
