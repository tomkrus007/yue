<template>
  <div class="disk-layout" @dragover.prevent @drop.prevent>
    <SideNav active="disk" @apps="appOpen = true" />

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
          <button v-if="!disk.currentShareId" class="secondary small" @click="showMkdir = !showMkdir">+ 新建目录</button>
          <button v-if="!disk.currentShareId" class="small" :disabled="!disk.currentDirId" @click="pickUpload">上传</button>
          <input v-if="!disk.currentShareId" ref="uploadInput" type="file" multiple hidden @change="onUploadChange" />
          <div class="path">
            📁 {{ disk.currentDrive?.name }}<template v-if="disk.currentPath !== '/'"> · {{ disk.currentPath }}</template>
          </div>
          <span v-if="activeUploads" class="upload-note">{{ activeUploads }} 个上传中</span>
        </div>
        <div v-if="disk.currentDrive?.kind !== 'shared'" class="search-bar">
          <input v-model="keyword" placeholder="搜索文件" @keydown.enter="onSearch" />
          <button class="small" @click="onSearch">搜索</button>
          <button class="secondary small" @click="disk.openDrive(disk.currentDrive!)">回到盘根</button>
        </div>
        <div v-else class="search-bar">
          <span class="share-hint">别人分享给我的文件与目录；目录可直接进入浏览。</span>
          <button class="secondary small" @click="disk.openDrive(disk.currentDrive!)">回到盘根</button>
        </div>
      </header>

      <div v-if="showMkdir && !disk.currentShareId" class="mkdir-bar">
        <input v-model="mkdirName" placeholder="新目录名" @keydown.enter="onMkdir" />
        <button class="small" @click="onMkdir">创建</button>
      </div>

      <div v-if="disk.error" class="error">{{ disk.error }}</div>

      <div class="file-list">
        <div v-if="disk.loading" class="loading">加载中…</div>

        <!-- 团队、部门入口列表 -->
        <table v-else-if="disk.subEntries.length > 0">
          <thead><tr><th>{{ subEntryLabel() }}</th><th>类型</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="t in disk.subEntries" :key="t.id" @dblclick="disk.enterTeam(t)">
              <td class="name">
                <span class="f-icon">👥</span>{{ t.name }}
              </td>
              <td>{{ subEntryLabel() }}</td>
              <td class="ops"><button class="small" @click.stop="disk.enterTeam(t)">进入</button></td>
            </tr>
          </tbody>
        </table>

        <!-- 共享给我：收到的分享 -->
        <table v-else-if="isShareRoot">
          <thead>
            <tr><th>名称</th><th>分享人</th><th>类型</th><th>有效期</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in disk.shares" :key="s.id" @dblclick="onOpenShare(s)">
              <td class="name">
                <span class="f-icon">{{ s.resourceType === 'D' ? '📁' : iconFor(extOf(s.title)) }}</span>
                {{ s.title }}
                <span v-if="s.status !== 0" class="invalid-tag">已失效</span>
              </td>
              <td>{{ s.creatorName || '-' }}</td>
              <td>{{ s.resourceType === 'D' ? '目录' : (extOf(s.title) || '文件') }}</td>
              <td>{{ fmtExpire(s.expireDate) }}</td>
              <td class="ops">
                <template v-if="s.status === 0 && s.resourceType === 'D'">
                  <button class="small" @click.stop="onOpenShare(s)">进入</button>
                </template>
                <template v-else-if="s.status === 0">
                  <button v-if="canPreviewName(s.title) && s.permissions?.previewable !== false" class="small" @click.stop="onPreviewShare(s)">预览</button>
                  <button v-if="s.permissions?.downloadable !== false" class="secondary small" @click.stop="onDownloadShare(s)">下载</button>
                </template>
              </td>
            </tr>
            <tr v-if="disk.shares.length === 0">
              <td colspan="5" class="empty">暂无共享给我的内容</td>
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
            <tr v-for="f in disk.files" :key="f.id" @dblclick="onDblClick(f)">
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
                <button v-if="f.type === 'F' && (!disk.currentShareId || f.permissions?.downloadable !== false)" class="secondary small" @click.stop="onDownload(f)">下载</button>
                <button v-if="!disk.currentShareId" class="secondary small danger-btn" @click.stop="onDelete(f)">删除</button>
              </td>
            </tr>
            <tr v-if="disk.files.length === 0 && !disk.loading">
              <td colspan="5" class="empty">空目录</td>
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
    <AppPanel v-model:open="appOpen" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppPanel from '../components/AppPanel.vue'
import SideNav from '../components/SideNav.vue'
import { useAuthStore } from '../stores/auth'
import { useDiskStore, type DiskDrive } from '../stores/disk'
import { OFFICE_EXT } from '../services/pan-client'
import { useUploadStore } from '../stores/uploads'
import { type DiskFile } from '../services/disk-client'
import type { PanShareItem } from '../services/disk-pan'

const auth = useAuthStore()
const disk = useDiskStore()
const appOpen = ref(false)
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

async function onPreview(f: DiskFile) {
  await disk.preview(f)
}

async function onSearch() {
  if (keyword.value.trim()) await disk.search(keyword.value.trim())
  else await disk.refresh()
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

function fmtExpire(t?: number | null): string {
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
.share-hint { flex: 1; color: var(--text-muted); font-size: 12px; }
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
