<template>
  <div class="connection-status" :title="`消息服务：${label}`" role="status">
    <span class="status-dot" :class="state" aria-hidden="true"></span>
    <span>{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useImStore } from '../stores/im'

const im = useImStore()
const state = computed(() => !im.connected ? 'offline' : im.authed ? 'online' : 'connecting')
const label = computed(() => !im.connected ? '未连接' : im.authed ? '已鉴权' : '连接中')
</script>

<style scoped>
.connection-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 8px 0;
  color: #c5c8cc;
  font-size: 10px;
  flex-shrink: 0;
}
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #8a9099; }
.status-dot.online { background: var(--success); }
.status-dot.connecting { background: var(--primary); }
</style>
