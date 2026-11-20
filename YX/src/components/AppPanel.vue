<template>
  <div v-if="open" class="apps-mask" @click.self="close">
    <div class="apps-panel">
      <header class="apps-head">
        <div>
          <h3>我的应用</h3>
          <div class="sub">{{ stateText }}</div>
        </div>
        <button class="secondary small" @click="close">关闭</button>
      </header>

      <div class="apps-body">
        <div v-if="loading" class="hint">加载中…</div>
        <div v-else-if="error" class="hint err">{{ error }}</div>
        <div v-else-if="!apps.length" class="hint">没有可用应用</div>

        <template v-for="cat in categories" :key="cat.category">
          <div class="app-cat">{{ cat.category }}（{{ cat.apps.length }}）</div>
          <div class="app-grid">
            <div
              v-for="a in cat.apps"
              :key="a.id"
              class="app-tile"
              :title="a.url || a.name"
              @click="openApp(a)"
            >
              <div class="app-ico">
                <img v-if="icons[a.icon]" :src="icons[a.icon]" alt="" />
                <span v-else>{{ a.name.slice(0, 1) }}</span>
              </div>
              <div class="app-name">{{ a.name }}</div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { groupByCategory, loadApps, type AppEntry } from '../services/app-client'
import { getAppIconUrl } from '../services/im/media'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const apps = ref<AppEntry[]>([])
const loading = ref(false)
const error = ref('')
const icons = reactive<Record<string, string>>({})

const categories = computed(() => groupByCategory(apps.value))

const stateText = computed(() =>
  loading.value
    ? '加载中…'
    : error.value
      ? '加载失败'
      : apps.value.length + ' 个应用',
)

function close() {
  emit('update:open', false)
}

async function loadIcons() {
  const pending = apps.value.map((a) => a.icon).filter((k) => k && !icons[k])
  let i = 0
  const worker = async () => {
    while (i < pending.length) {
      const key = pending[i]
      i += 1
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

async function reload() {
  loading.value = true
  error.value = ''
  try {
    apps.value = await loadApps()
    loadIcons()
  } catch (e: any) {
    error.value = '加载失败：' + (e?.message || e)
  } finally {
    loading.value = false
  }
}

async function openApp(a: AppEntry) {
  if (!a.url) {
    error.value = '这个应用没有可打开的地址'
    return
  }
  try {
    await openUrl(a.url)
  } catch {
    window.open(a.url, '_blank', 'noopener')
  }
}

watch(
  () => props.open,
  (v) => {
    if (v && !apps.value.length && !loading.value) reload()
  },
  { immediate: true },
)
</script>

<style scoped>
.apps-mask {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.apps-panel {
  width: min(760px, 88vw);
  height: min(78vh, 720px);
  background: var(--surface);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-2);
}
.apps-head {
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.apps-head h3 { font-size: 15px; }
.sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.small { padding: 4px 10px; font-size: 12px; }
.apps-body { flex: 1; overflow-y: auto; padding: 14px 18px; }
.app-cat {
  font-size: 12px;
  color: var(--text-muted);
  margin: 14px 0 8px;
  font-weight: 600;
}
.app-cat:first-child { margin-top: 0; }
.app-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 12px;
}
.app-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 6px;
  border-radius: 8px;
  cursor: pointer;
}
.app-tile:hover { background: var(--hover); }
.app-ico {
  width: 42px;
  height: 42px;
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
.hint { text-align: center; color: var(--text-muted); padding: 28px; font-size: 13px; }
.hint.err { color: var(--danger); }
</style>