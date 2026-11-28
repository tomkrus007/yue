<template>
  <div class="nav-profile"
    :title="`${displayName} · 消息服务：${label}`" role="status"
    :aria-label="`${displayName} · 消息服务：${label}`">
    <ContactAvatar class="nav-avatar" :id="userId" :type="1" :name="displayName" />
    <span class="status-dot" :class="{ online }" aria-hidden="true"></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useImStore } from '../stores/im'
import { authService } from '../services/auth'
import ContactAvatar from './ContactAvatar.vue'

const auth = useAuthStore()
const im = useImStore()
const online = computed(() => im.connected && im.authed)
const label = computed(() => !im.connected ? '未连接' : im.authed ? '已鉴权' : '连接中')
const displayName = computed(() => auth.user?.name || authService.getCurrentUserName() || '用户')
const userId = computed(() => auth.user?.id || authService.getCurrentUserId())
</script>

<style scoped>
.nav-profile {
  position: relative;
  margin-bottom: 8px;
  flex-shrink: 0;
  line-height: 1;
}
.nav-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  box-sizing: border-box;
  background: var(--surface-2);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
}
/* 登录状态：头像正下方的小圆点，在线绿色、离线灰色 */
.status-dot {
  position: absolute;
  left: 50%;
  top: calc(100% + 2px);
  transform: translateX(-50%);
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  border: 1.5px solid var(--sidebar-bg);
  box-sizing: border-box;
  transition: background-color 0.2s;
}
.status-dot.online { background: var(--success); }
</style>
