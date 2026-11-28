<template>
  <nav class="side-nav">
    <!-- macOS 原生红绿灯悬浮区（Overlay 标题栏），兼作窗口拖动条 -->
    <div class="nav-drag" data-tauri-drag-region></div>
    <ConnectionStatus />
    <router-link to="/chat" :class="['nav-item', { active: active === 'chat' }]" title="消息">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.8a8.2 8.2 0 0 1-8.2 8.2H7.5L3 22.5l1.1-4.6A8.2 8.2 0 1 1 21 11.8Z" />
        <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
      </svg>
      <small v-if="chatUnread" class="nav-badge">{{ chatUnread > 99 ? '99+' : chatUnread }}</small>
    </router-link>

    <button
      v-if="mentionCount !== null"
      class="nav-item"
      :title="`@ 提醒中心 · ${mentionCount} 条待处理`"
      aria-label="@ 提醒中心"
      @click="emit('mentions')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3.8" />
        <path d="M15.8 8.2v5a2.9 2.9 0 0 0 5.8 0v-1.2A9.8 9.8 0 1 0 12 21.8" />
      </svg>
      <small v-if="mentionCount" class="nav-badge">{{ mentionCount > 99 ? '99+' : mentionCount }}</small>
    </button>

    <router-link to="/contacts" :class="['nav-item', { active: active === 'contacts' }]" title="通讯录">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M16 20v-1.6a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
        <circle cx="9" cy="7" r="3.6" />
        <path d="M22 20v-1.6a4 4 0 0 0-3-3.85M16.5 3.5a4 4 0 0 1 0 7.4" />
      </svg>
    </router-link>

    <router-link to="/disk" :class="['nav-item', { active: active === 'disk' }]" title="云盘">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.8l2 2.5h7.2a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z" />
      </svg>
    </router-link>

    <router-link to="/apps" :class="['nav-item', { active: active === 'apps' }]" title="我的应用">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      </svg>
    </router-link>

    <router-link v-if="caps?.meeting !== false" to="/wemeet" :class="['nav-item', { active: active === 'wemeet' }]" title="会议">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2.5" y="6.5" width="12.5" height="11" rx="2.5" />
        <path d="m15 12 6-3.6v7.2L15 12Z" />
      </svg>
    </router-link>

    <router-link v-if="caps?.zero_trust !== false" to="/zt" :class="['nav-item', { active: active === 'zt' }]" title="零信任分流">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3 19 6v5.5c0 4.4-2.9 7.6-7 9.5-4.1-1.9-7-5.1-7-9.5V6l7-3Z" />
        <path d="m9 11.8 2.1 2.1 3.9-3.9" />
      </svg>
    </router-link>

    <div class="spacer"></div>

    <div class="nav-more" @keydown.esc="menuOpen = false">
      <button
        :class="['nav-item', { active: menuOpen }]"
        title="更多"
        aria-label="更多"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
      </button>
      <div v-if="menuOpen" class="nav-menu-backdrop" @click="menuOpen = false"></div>
      <div v-if="menuOpen" class="nav-menu" role="menu" aria-label="更多">
        <button role="menuitem" @click="onSettings">设置</button>
        <button v-if="active === 'chat'" role="menuitem" @click="onLogs">日志</button>
        <button role="menuitem" class="danger" @click="onLogout">退出</button>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useImStore } from '../stores/im'
import { useUiStore } from '../stores/ui'
import { useWeMeetStore } from '../stores/wemeet'
import ConnectionStatus from './ConnectionStatus.vue'
import { useCapabilities } from '../services/platform'

withDefaults(defineProps<{
  active: 'chat' | 'contacts' | 'disk' | 'apps' | 'zt' | 'wemeet'
  /** 传入待处理 @ 数量时显示提醒中心入口；null 表示该页面不显示 */
  mentionCount?: number | null
}>(), { mentionCount: null })
const emit = defineEmits<{ mentions: []; logs: [] }>()

const router = useRouter()
const auth = useAuthStore()
const im = useImStore()
const ui = useUiStore()
const wemeet = useWeMeetStore()
const menuOpen = ref(false)
const { caps, loadCapabilities } = useCapabilities()
onMounted(() => void loadCapabilities())
/** 全部 + 折叠两个分组的未读之和（tabs 内已排除服务号） */
const chatUnread = computed(() => im.tabs.reduce((sum, t) => sum + t.unread, 0))

function onSettings() {
  menuOpen.value = false
  ui.openSettings()
}

function onLogs() {
  menuOpen.value = false
  emit('logs')
}

function onLogout() {
  menuOpen.value = false
  // 登出时释放腾讯会议 SDK，避免 helper 进程残留
  wemeet.stop()
  im.resetLocal()
  auth.logout()
  router.replace('/login')
}
</script>

<style scoped>
.side-nav {
  background: var(--sidebar-bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 0 10px;
  gap: 6px;
  color: var(--sidebar-fg);
  position: relative;
  /* 抬到会话面板之上，底部「更多」菜单才能浮到右侧列上 */
  z-index: 45;
}
/* 与右侧 48px 标题带等高，红绿灯就落在这块空白里 */
.nav-drag { height: var(--titlebar-height); width: 100%; flex-shrink: 0; }
.nav-item {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  padding: 0;
  text-decoration: none;
  position: relative;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: var(--sidebar-hover); color: var(--text); }
.nav-item.active { background: var(--sidebar-active-bg); color: var(--sidebar-active-fg); }
.nav-item svg { width: 20px; height: 20px; }
.nav-more { position: relative; }
.nav-menu-backdrop { position: fixed; inset: 0; z-index: 55; }
.nav-menu {
  position: absolute;
  left: 4px;
  bottom: calc(100% + 7px);
  min-width: 104px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-2);
  z-index: 60;
}
.nav-menu button {
  display: flex;
  align-items: center;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text);
  background: transparent;
  text-align: left;
}
.nav-menu button:hover { background: var(--hover); }
.nav-menu button.danger { color: var(--danger); }
.nav-badge {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
}
.spacer { flex: 1; }
</style>