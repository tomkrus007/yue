<template>
  <div class="nav-avatar" :class="{ online: im.connected && im.authed }"
    :title="`${auth.user?.name || '用户'} · 消息服务：${label}`" role="status"
    :aria-label="`${auth.user?.name || '用户'} · 消息服务：${label}`">
    {{ (auth.user?.name || '?').slice(0, 1) }}
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useImStore } from '../stores/im'

const auth = useAuthStore()
const im = useImStore()
const label = computed(() => !im.connected ? '未连接' : im.authed ? '已鉴权' : '连接中')
</script>

<style scoped>
.nav-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--surface-2);
  box-sizing: border-box;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  margin-bottom: 6px;
  flex-shrink: 0;
  transition: background-color 0.2s, color 0.2s;
}
.nav-avatar.online { background: var(--primary); color: #fff; }
</style>
