<template>
  <div class="disk-layout">
    <nav class="side-nav">
      <div class="nav-avatar" :title="auth.user?.name">
        {{ (auth.user?.name || '?').slice(0, 1) }}
      </div>
      <router-link to="/chat" class="nav-item" title="消息">
        <span class="icon">💬</span>
      </router-link>
      <router-link to="/contacts" class="nav-item" title="通讯录">
        <span class="icon">👥</span>
      </router-link>
      <router-link to="/disk" class="nav-item active" title="云盘">
        <span class="icon">📁</span>
      </router-link>
      <button class="nav-item" title="我的应用" @click="appOpen = true">
        <span class="icon">▦</span>
      </button>
      <router-link to="/zt" class="nav-item" title="零信任分流">
        <span class="icon">🛡</span>
      </router-link>
      <div class="spacer"></div>
      <ConnectionStatus />
      <button class="nav-item logout" @click="onLogout" title="退出">
        <span class="icon">⏻</span>
      </button>
    </nav>

    <!-- 盘列表 -->
    <aside class="drive-panel">
      <div class="panel-header"><h3>云盘</h3></div>
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

    <main class="disk-main">
      <header class="disk-header">
        <div class="path-bar">
          <button class="secondary small" @click="disk.back()" :disabled="disk.history.length <= 1">← 返回</button>
          <button class="secondary small" @click="disk.refresh()">刷新</button>
          <button class="secondary small" @click="showMkdir = !showMkdir">+ 新建目录</button>
          <div class="path">📁 {{ disk.currentDrive?.name }} · {{ disk.currentPath }}</div>
        </div>
        <div class="search-bar">
          <input v-model="keyword" placeholder="搜索文件" @keydown.enter="onSearch" />
          <button class="small" @click="onSearch">搜索</button>
          <button class="secondary small" @click="disk.openDrive(disk.currentDrive!)">回到盘根</button>
        </div>
      </header>

      <div v-if="showMkdir" class="mkdir-bar">
        <input v-model="mkdirName" placeholder="新目录名" @keydown.enter="onMkdir" />
        <button class="small" @click="onMkdir">创建</button>
      </div>

      <div v-if="disk.error" class="error">{{ disk.error }}</div>

      <div class="file-list">
        <div v-if="disk.loading" class="loading">加载中…</div>

        <!-- 团队和部门入口列表 -->
        <table v-else-if="disk.subEntries.length > 0">
          <thead><tr><th>{{ disk.currentDrive?.kind === 'org' ? '部门' : '团队' }}</th><th>类型</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="t in disk.subEntries" :key="t.id" @dblclick="disk.enterTeam(t)">
              <td class="name"><span class="f-icon">👥</span>{{ t.name }}</td>
              <td>{{ disk.currentDrive?.kind === 'org' ? '部门' : '团队' }}</td>
              <td class="ops"><button class="small" @click.stop="disk.enterTeam(t)">进入</button></td>
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
                <button v-if="f.type === 'F'" class="small" @click.stop="onOnlineEdit(f)">在线编辑</button>
                <button v-if="f.type === 'F'" class="secondary small" @click.stop="onDownload(f)">下载</button>
                <button class="secondary small danger-btn" @click.stop="onDelete(f)">删除</button>
              </td>
            </tr>
            <tr v-if="disk.files.length === 0 && !disk.loading">
              <td colspan="5" class="empty">空目录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
    <AppPanel v-model:open="appOpen" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppPanel from '../components/AppPanel.vue'
import ConnectionStatus from '../components/ConnectionStatus.vue'
import { useAuthStore } from '../stores/auth'
import { useImStore } from '../stores/im'
import { useDiskStore, type DiskDrive } from '../stores/disk'
import { type DiskFile } from '../services/disk-client'

const auth = useAuthStore()
const disk = useDiskStore()
const appOpen = ref(false)
const router = useRouter()

const keyword = ref('')
const showMkdir = ref(false)
const mkdirName = ref('')

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
    default: return '📁'
  }
}

async function onOpenDrive(d: DiskDrive) {
  keyword.value = ''
  await disk.openDrive(d)
}

function onLogout() {
  useImStore().resetLocal()
  auth.logout()
  router.replace('/login')
}

async function onDblClick(f: DiskFile) {
  if (f.type === 'D') await disk.enter(f)
}

async function onSearch() {
  if (keyword.value.trim()) await disk.search(keyword.value.trim())
  else await disk.refresh()
}

async function onMkdir() {
  if (!mkdirName.value.trim()) return
  await disk.mkdir(mkdirName.value.trim())
  mkdirName.value = ''
  showMkdir.value = false
}

async function onDelete(f: DiskFile) {
  if (!confirm(`确定删除「${f.name}」？`)) return
  await disk.remove(f)
}

async function onDownload(f: DiskFile) {
  await disk.download(f)
}

async function onOnlineEdit(f: DiskFile) {
  await disk.onlineEdit(f)
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
</script>

<style scoped>
.disk-layout { display: grid; grid-template-columns: 56px 200px 1fr; height: 100%; }
.side-nav {
  background: #2b2c2d; display: flex; flex-direction: column; align-items: center;
  padding: 12px 0; gap: 8px;
}
.nav-avatar {
  width: 36px; height: 36px; border-radius: 50%;
  background: var(--primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; margin-bottom: 12px;
}
.nav-item {
  width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; color: #fff; font-size: 18px; background: transparent; padding: 0;
}
.nav-item:hover { background: rgba(255,255,255,0.1); }
.nav-item.active { background: rgba(242,136,35,0.3); }
.spacer { flex: 1; }

.drive-panel {
  background: var(--panel); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
}
.panel-header { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.panel-header h3 { font-size: 15px; font-weight: 600; }
.drive-list { list-style: none; flex: 1; overflow-y: auto; }
.drive-list li {
  padding: 12px 16px; display: flex; align-items: center; gap: 10px;
  cursor: pointer; border-bottom: 1px solid #f0f0f0; font-size: 14px;
}
.drive-list li:hover { background: #f7f8f9; }
.drive-list li.active { background: #eef6fb; color: var(--primary); font-weight: 500; }
.drive-list li.empty { color: var(--text-muted); cursor: default; justify-content: center; }
.drive-icon { font-size: 16px; }

.disk-main { display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.disk-header {
  padding: 12px 20px; background: var(--panel);
  border-bottom: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 10px;
}
.path-bar { display: flex; align-items: center; gap: 8px; }
.path { flex: 1; color: var(--text-muted); font-size: 13px; }
.search-bar { display: flex; gap: 8px; }
.search-bar input { flex: 1; }
.small { padding: 5px 12px; font-size: 12px; }
.secondary { background: #f0f0f0; color: var(--text); }
.secondary:hover { background: #e0e0e0; }
.danger-btn { color: var(--danger); }

.mkdir-bar {
  padding: 10px 20px; background: #fafafa; border-bottom: 1px solid var(--border);
  display: flex; gap: 8px;
}

.error { margin: 12px 20px; padding: 8px 12px; background: #fff0f0; color: var(--danger); border-radius: 6px; }

.file-list { flex: 1; overflow-y: auto; padding: 16px 20px; }
.loading, .empty { text-align: center; color: var(--text-muted); padding: 20px; }
table { width: 100%; border-collapse: collapse; }
thead th {
  text-align: left; padding: 8px 12px; font-size: 12px; color: var(--text-muted);
  border-bottom: 1px solid var(--border); font-weight: 500;
}
tbody td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
tbody tr:hover { background: #f7f8f9; }
.name .f-icon { margin-right: 6px; }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
