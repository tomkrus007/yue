<template>
  <div class="apps-layout">
    <SideNav active="apps" />

    <main class="apps-main">
      <header class="apps-head" data-tauri-drag-region="deep">
        <div class="header-row">
          <div>
            <h2>我的应用</h2>
            <div class="sub">{{ stateText }}</div>
          </div>
          <div class="head-actions">
            <button
              v-if="mode === 'desk'"
              class="small secondary"
              :disabled="loading"
              @click="openAllApps"
            >全部应用</button>
            <button class="small secondary" :disabled="loading" @click="reload">刷新</button>
          </div>
        </div>
        <div class="search-box">
          <input
            v-model="keyword"
            type="search"
            placeholder="搜索应用名称"
            aria-label="搜索应用"
          />
        </div>
        <div v-if="desks.length > 1" class="desk-tabs">
          <button
            v-for="d in desks"
            :key="d.deskId"
            :class="['desk-tab', { active: d.deskId === activeDeskId }]"
            @click="selectDesk(d)"
          >{{ d.deskName }}</button>
        </div>
      </header>

      <div class="apps-body">
        <div v-if="notice" :class="['notice', notice.kind]">
          <span>{{ notice.text }}</span>
          <button class="secondary small" @click="notice = null">知道了</button>
        </div>

        <div v-if="loading" class="hint">加载中…</div>
        <div v-else-if="error" class="hint err">{{ error }}</div>

        <template v-else-if="mode === 'desk'">
          <div v-if="!visibleFolders.length" class="hint">
            <template v-if="keyword.trim()">没有匹配的应用</template>
            <template v-else>
              桌面上还没有应用，点击右上角「全部应用」添加。
            </template>
          </div>
          <section v-for="f in visibleFolders" :key="f.id" class="app-folder">
            <div v-if="folders.length > 1" class="app-cat">
              {{ folderTitle(f) }}（{{ f.apps.length }}）
            </div>
            <div class="app-grid">
              <div
                v-for="a in f.apps"
                :key="a.id"
                class="app-tile"
                :title="a.name"
                @click="openApp(a)"
              >
                <div class="app-ico">
                  <img v-if="icons[a.icon]" :src="icons[a.icon]" alt="" />
                  <span v-else>{{ a.name.slice(0, 1) }}</span>
                </div>
                <div class="app-name">{{ a.name }}</div>
                <button
                  class="app-remove"
                  title="从桌面移除"
                  @click.stop="removeFromDesk(a, f.id)"
                >×</button>
              </div>
            </div>
          </section>
        </template>

        <template v-else>
          <div v-if="!fallbackGroups.length" class="hint">没有匹配的应用</div>
          <section v-for="cat in fallbackGroups" :key="cat.category" class="app-folder">
            <div class="app-cat">{{ cat.category }}（{{ cat.apps.length }}）</div>
            <div class="app-grid">
              <div
                v-for="a in cat.apps"
                :key="a.id"
                class="app-tile"
                :title="a.name"
                @click="openFallbackApp(a)"
              >
                <div class="app-ico">
                  <img v-if="icons[a.icon]" :src="icons[a.icon]" alt="" />
                  <span v-else>{{ a.name.slice(0, 1) }}</span>
                </div>
                <div class="app-name">{{ a.name }}</div>
              </div>
            </div>
          </section>
        </template>
      </div>
    </main>

    <div v-if="showAll" class="all-mask" @click.self="showAll = false">
      <section class="all-panel" role="dialog" aria-modal="true" aria-label="全部应用">
        <header class="all-head">
          <div>
            <h3>全部应用</h3>
            <p class="sub">点击应用可添加到桌面，再次点击可移除。</p>
          </div>
          <input
            v-model="allKeyword"
            class="all-search"
            type="search"
            placeholder="搜索应用"
            @input="onAllKeyword"
          />
          <button class="secondary small" @click="showAll = false">关闭</button>
        </header>
        <div class="all-body">
          <nav class="all-cats">
            <button
              v-for="c in categories"
              :key="c.id"
              :class="['all-cat', { active: c.id === activeCategory }]"
              @click="pickCategory(c.id)"
            >{{ c.name }}</button>
          </nav>
          <div class="all-list">
            <div v-if="allLoading" class="hint">加载中…</div>
            <div v-else-if="!allApps.length" class="hint">没有应用</div>
            <div v-else class="app-grid">
              <div
                v-for="a in allApps"
                :key="a.id"
                :class="['app-tile', { added: addedIds.has(a.id), busy: adding === a.id }]"
                :title="addedIds.has(a.id) ? '点击从桌面移除' : '点击添加到桌面'"
                @click="toggleApp(a)"
              >
                <div class="app-ico">
                  <img v-if="icons[a.icon]" :src="icons[a.icon]" alt="" />
                  <span v-else>{{ a.name.slice(0, 1) }}</span>
                </div>
                <div class="app-name">{{ a.name }}</div>
                <span v-if="addedIds.has(a.id)" class="app-badge">已添加</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import SideNav from '../components/SideNav.vue'
import {
  addDeskApp,
  DEFAULT_FOLDER,
  loadCategories,
  loadCategoryApps,
  loadDeskDetails,
  loadDesks,
  openDeskApp,
  removeDeskApp,
  searchApps,
  type AppCategory,
  type Desk,
  type DeskApp,
  type DeskFolder,
} from '../services/app-desk'
import { groupByCategory, loadApps, type AppEntry } from '../services/app-client'
import { getAppIconUrl } from '../services/im/media'
import { usePreferencesStore } from '../stores/preferences'

type NoticeKind = 'info' | 'error'

const prefs = usePreferencesStore()

const mode = ref<'desk' | 'fallback'>('desk')
const desks = ref<Desk[]>([])
const activeDeskId = ref('')
const folders = ref<DeskFolder[]>([])
const fallback = ref<AppEntry[]>([])

const loading = ref(false)
const error = ref('')
const notice = ref<{ text: string; kind: NoticeKind } | null>(null)
const keyword = ref('')
const icons = reactive<Record<string, string>>({})

const showAll = ref(false)
const categories = ref<AppCategory[]>([])
const activeCategory = ref('')
const allApps = ref<DeskApp[]>([])
const allLoading = ref(false)
const allKeyword = ref('')
const adding = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function info(text: string) {
  notice.value = { text, kind: 'info' }
}

function warn(text: string) {
  notice.value = { text, kind: 'error' }
}

const deskApps = computed(() => folders.value.flatMap((f) => f.apps))
const addedIds = computed(() => new Set(deskApps.value.map((a) => a.id)))

function matches(name: string, code = ''): boolean {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return true
  return name.toLowerCase().includes(q) || code.toLowerCase().includes(q)
}

const visibleFolders = computed(() =>
  folders.value
    .map((f) => ({ ...f, apps: f.apps.filter((a) => matches(a.name)) }))
    .filter((f) => f.apps.length > 0),
)

const fallbackGroups = computed(() =>
  groupByCategory(fallback.value.filter((a) => matches(a.name, a.code))),
)

const shownCount = computed(() =>
  mode.value === 'desk'
    ? visibleFolders.value.reduce((n, f) => n + f.apps.length, 0)
    : fallbackGroups.value.reduce((n, c) => n + c.apps.length, 0),
)

const totalCount = computed(() =>
  mode.value === 'desk' ? deskApps.value.length : fallback.value.length,
)

const stateText = computed(() => {
  if (loading.value) return '加载中…'
  if (error.value) return '加载失败'
  if (keyword.value.trim()) return `${shownCount.value} / ${totalCount.value} 个应用`
  return mode.value === 'desk' ? `${totalCount.value} 个应用` : `${totalCount.value} 个授权应用`
})

/** 默认文件夹由服务端自动生成，界面上给它一个更直观的名字。 */
function folderTitle(folder: DeskFolder): string {
  if (folder.id === DEFAULT_FOLDER || !folder.name) return '常用应用'
  return folder.name
}

async function loadIcons(keys: string[]) {
  const pending = Array.from(new Set(keys.filter((k) => k && !icons[k])))
  let index = 0
  const worker = async () => {
    while (index < pending.length) {
      const key = pending[index]
      index += 1
      try {
        const url = await getAppIconUrl(key)
        if (url) icons[key] = url
      } catch {
        /* 失败保留首字色块 */
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
}

async function loadDesk(deskId: string) {
  folders.value = await loadDeskDetails(deskId)
  void loadIcons(deskApps.value.map((a) => a.icon))
}

async function reload() {
  loading.value = true
  error.value = ''
  try {
    const list = await loadDesks()
    if (!list.length) throw new Error('当前账号没有应用桌面')
    mode.value = 'desk'
    desks.value = list
    if (!list.some((d) => d.deskId === activeDeskId.value)) {
      activeDeskId.value = list[0].deskId
    }
    await loadDesk(activeDeskId.value)
  } catch (e) {
    await useFallback(e)
  } finally {
    loading.value = false
  }
}

/**
 * 应用桌面接口不可用（老服务端或未开通）时，回退到 `es/authorized` 全量应用，
 * 至少保证页面还能打开应用。
 */
async function useFallback(cause: unknown) {
  mode.value = 'fallback'
  desks.value = []
  folders.value = []
  try {
    fallback.value = await loadApps(true)
    void loadIcons(fallback.value.map((a) => a.icon))
    info('应用桌面加载失败，已回退到全部授权应用：' + errorText(cause))
    if (!fallback.value.length) error.value = '没有可用应用'
  } catch (e) {
    error.value = '加载失败：' + errorText(e)
  }
}

async function selectDesk(desk: Desk) {
  if (desk.deskId === activeDeskId.value) return
  activeDeskId.value = desk.deskId
  loading.value = true
  error.value = ''
  try {
    await loadDesk(desk.deskId)
  } catch (e) {
    error.value = '加载桌面失败：' + errorText(e)
  } finally {
    loading.value = false
  }
}

async function openApp(app: DeskApp) {
  try {
    await openDeskApp(app, prefs.appOpenInBrowser ? 'browser' : 'embedded')
  } catch (e) {
    warn(errorText(e))
  }
}

async function openFallbackApp(app: AppEntry) {
  if (!app.url) {
    warn('这个应用没有可打开的地址')
    return
  }
  try {
    await openUrl(app.url)
  } catch (e) {
    warn('打开失败：' + errorText(e))
  }
}

async function removeFromDesk(app: DeskApp, folderId: string) {
  if (!activeDeskId.value) return
  try {
    await removeDeskApp(activeDeskId.value, app.id, folderId)
    folders.value = folders.value.map((f) =>
      f.id === folderId
        ? { ...f, apps: f.apps.filter((item) => item.id !== app.id) }
        : f,
    )
  } catch (e) {
    warn('移除失败：' + errorText(e))
  }
}

async function openAllApps() {
  showAll.value = true
  if (!categories.value.length) {
    try {
      categories.value = await loadCategories()
    } catch (e) {
      warn('读取应用分类失败：' + errorText(e))
      return
    }
  }
  if (!allApps.value.length) {
    const first = categories.value[0]?.id
    if (first) await pickCategory(first)
  }
}

async function pickCategory(categoryId: string) {
  if (!categoryId) return
  activeCategory.value = categoryId
  allKeyword.value = ''
  allLoading.value = true
  try {
    allApps.value = await loadCategoryApps(categoryId, activeDeskId.value)
  } catch (e) {
    warn('读取应用失败：' + errorText(e))
  } finally {
    allLoading.value = false
  }
}

function onAllKeyword() {
  if (searchTimer) clearTimeout(searchTimer)
  const q = allKeyword.value.trim()
  if (!q) {
    const id = activeCategory.value || categories.value[0]?.id
    if (id) void pickCategory(id)
    return
  }
  searchTimer = setTimeout(async () => {
    allLoading.value = true
    try {
      allApps.value = await searchApps(q)
    } catch (e) {
      warn('搜索失败：' + errorText(e))
    } finally {
      allLoading.value = false
    }
  }, 300)
}

async function toggleApp(app: DeskApp) {
  if (!activeDeskId.value || adding.value) return
  const deskId = activeDeskId.value
  const added = addedIds.value.has(app.id)
  const owner = folders.value.find((f) => f.apps.some((item) => item.id === app.id))
  adding.value = app.id
  try {
    if (added) {
      await removeDeskApp(deskId, app.id, owner?.id)
    } else {
      // 不指定 folderId：服务端会放进桌面自带的默认文件夹，多文件夹桌面里也不会猜错
      await addDeskApp(deskId, app.id)
    }
    if (deskId !== activeDeskId.value) return
    await loadDesk(deskId)
  } catch (e) {
    warn((added ? '移除失败：' : '添加失败：') + errorText(e))
  } finally {
    adding.value = ''
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && showAll.value) showAll.value = false
}

onMounted(() => {
  void prefs.load()
  window.addEventListener('keydown', onKeydown)
  void reload()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<style scoped>
.apps-layout { display: grid; grid-template-columns: 56px 1fr; height: 100%; }

.apps-main { display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.apps-head {
  background: var(--panel); padding: 0 24px 10px; border-bottom: 1px solid var(--border);
}
.apps-head h2 { font-size: 15px; font-weight: 600; }
.header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: var(--titlebar-height); }
.head-actions { display: flex; gap: 8px; }
.sub { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
.small { padding: 5px 12px; font-size: 12px; }
.search-box { display: flex; align-items: center; }
.search-box input { max-width: 520px; }

.desk-tabs { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.desk-tab {
  background: var(--surface-2); color: var(--text); font-size: 12px;
  padding: 5px 12px; border-radius: 999px;
}
.desk-tab:hover { background: var(--hover); }
.desk-tab.active { background: var(--primary-soft); color: var(--primary-soft-text); }

.apps-body { flex: 1; overflow-y: auto; padding: 16px 24px 40px; }
.notice {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 12px; border-radius: 8px; font-size: 12px; margin-bottom: 12px;
}
.notice.info { background: var(--info-soft); color: var(--info-text); }
.notice.error { background: var(--danger-soft); color: var(--danger); }

.app-cat {
  font-size: 13px;
  color: var(--text-muted);
  font-weight: 600;
  margin: 18px 0 10px;
}
.app-cat:first-child { margin-top: 0; }
.app-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 12px;
}
.app-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.app-tile:hover { background: var(--bg-subtle); border-color: var(--primary); }
.app-tile.added { border-color: var(--primary); }
.app-tile.busy { opacity: 0.6; pointer-events: none; }
.app-ico {
  width: 46px;
  height: 46px;
  border-radius: 10px;
  background: linear-gradient(135deg, #ffb066, var(--primary));
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  overflow: hidden;
}
.app-ico img { width: 100%; height: 100%; object-fit: cover; }
.app-name {
  font-size: 12px;
  text-align: center;
  line-height: 1.3;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.app-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 50%;
  font-size: 13px;
  line-height: 1;
  background: var(--surface-2);
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.12s;
}
.app-tile:hover .app-remove { opacity: 1; }
.app-remove:hover { background: var(--danger-soft); color: var(--danger); }
.app-badge {
  position: absolute;
  right: 6px;
  top: 6px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary-soft-text);
}
.hint { text-align: center; color: var(--text-muted); padding: 28px; font-size: 13px; }
.hint.err { color: var(--danger); }

.all-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: var(--overlay);
  display: grid;
  place-items: center;
}
.all-panel {
  width: min(880px, 92vw);
  height: min(620px, 88vh);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: 12px;
  box-shadow: var(--shadow-2);
  overflow: hidden;
}
.all-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.all-head h3 { font-size: 15px; font-weight: 600; }
.all-head > div { flex: 1; min-width: 160px; }
.all-search { max-width: 260px; }
.all-body { flex: 1; display: grid; grid-template-columns: 160px 1fr; overflow: hidden; }
.all-cats {
  border-right: 1px solid var(--border);
  padding: 12px 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--panel);
}
.all-cat {
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 6px;
}
.all-cat:hover { background: var(--hover); }
.all-cat.active { background: var(--primary-soft); color: var(--primary-soft-text); }
.all-list { overflow-y: auto; padding: 16px 20px 24px; }
</style>
