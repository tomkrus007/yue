<template>
  <nav class="side-nav">
    <ConnectionStatus />
    <router-link to="/chat" :class="['nav-item', { active: active === 'chat' }]" title="消息">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.8a8.2 8.2 0 0 1-8.2 8.2H7.5L3 22.5l1.1-4.6A8.2 8.2 0 1 1 21 11.8Z" />
        <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
      </svg>
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

    <button class="nav-item" title="我的应用" aria-label="我的应用" @click="emit('apps')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      </svg>
    </button>

    <router-link to="/zt" :class="['nav-item', { active: active === 'zt' }]" title="零信任分流">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3 19 6v5.5c0 4.4-2.9 7.6-7 9.5-4.1-1.9-7-5.1-7-9.5V6l7-3Z" />
        <path d="m9 11.8 2.1 2.1 3.9-3.9" />
      </svg>
    </router-link>

    <div class="spacer"></div>

    <button class="nav-item logout" title="退出" aria-label="退出登录" @click="onLogout">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v9" />
        <path d="M6.8 6.3a8 8 0 1 0 10.4 0" />
      </svg>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useImStore } from '../stores/im'
import ConnectionStatus from './ConnectionStatus.vue'

withDefaults(defineProps<{
  active: 'chat' | 'contacts' | 'disk' | 'zt'
  /** 传入待处理 @ 数量时显示提醒中心入口；null 表示该页面不显示 */
  mentionCount?: number | null
}>(), { mentionCount: null })
const emit = defineEmits<{ apps: []; mentions: [] }>()

const router = useRouter()
const auth = useAuthStore()
const im = useImStore()

function onLogout() {
  im.resetLocal()
  auth.logout()
  router.replace('/login')
}
</script>

<style scoped>
.side-nav {
  background: #2b2c2d;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 8px;
}
.nav-item {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: #fff;
  background: transparent;
  padding: 0;
  text-decoration: none;
  position: relative;
}
.nav-item:hover { background: rgba(255, 255, 255, 0.1); }
.nav-item.active { background: rgba(242, 136, 35, 0.3); }
.nav-item svg { width: 20px; height: 20px; }
.nav-item.logout { background: transparent; }
.nav-badge {
  position: absolute;
  top: 2px;
  right: 2px;
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