<template>
  <div class="login-page">
    <div class="login-card">
      <div class="logo">越秀 Link</div>
      <div class="subtitle">云上越秀 · IM 与网盘客户端</div>

      <form @submit.prevent="onLogin">
        <div class="field">
          <label>工号 / 账号</label>
          <input v-model="username" placeholder="例如 12345（自动补 @yuexiu）" autocomplete="username" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="password" type="password" placeholder="登录密码" autocomplete="current-password" />
        </div>

        <div v-if="auth.error" class="error">{{ auth.error }}</div>

        <button type="submit" :disabled="auth.loading">
          {{ auth.loading ? '登录中…' : '登 录' }}
        </button>
      </form>

      <details class="debug" open>
        <summary>调试日志（点击折叠）</summary>
        <ul class="debug-log">
          <li v-for="(l, i) in auth.debugLog" :key="i">{{ l }}</li>
          <li v-if="!auth.debugLog.length" class="muted">尚未登录</li>
        </ul>
      </details>

      <details class="debug">
        <summary>服务端点（点击展开）</summary>
        <pre>{{ endpoints }}</pre>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { DEFAULT_CONFIG } from '../services/config'

const auth = useAuthStore()
const router = useRouter()
const username = ref('')
const password = ref('')

const endpoints = computed(() => ({
  ssoUrl: DEFAULT_CONFIG.ssoUrl,
  embUrl: DEFAULT_CONFIG.embUrl,
  diskOpenApiUrl: DEFAULT_CONFIG.diskOpenApiUrl,
  clientId: DEFAULT_CONFIG.clientId,
}))

async function onLogin() {
  if (!username.value || !password.value) return
  try {
    const ok = await auth.login(username.value, password.value)
    if (ok) {
      await router.replace('/chat')
    } else {
      auth.log('登录未成功，停留登录页')
    }
  } catch (e: any) {
    auth.log('跳转异常：' + (e?.message || e))
    auth.error = e?.message || '登录后跳转失败'
  }
}
</script>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f28823 0%, #e07b18 100%);
}
.login-card {
  width: 380px;
  background: #fff;
  border-radius: 12px;
  padding: 36px 32px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}
.logo {
  font-size: 26px;
  font-weight: 700;
  color: var(--primary);
  text-align: center;
}
.subtitle {
  text-align: center;
  color: var(--text-muted);
  margin: 6px 0 28px;
  font-size: 13px;
}
.field { margin-bottom: 18px; }
.field label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--text-muted);
}
.error {
  background: #fff0f0;
  color: var(--danger);
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 16px;
  font-size: 13px;
}
button[type='submit'] {
  width: 100%;
  padding: 11px;
  font-size: 15px;
}
.debug {
  margin-top: 16px;
  font-size: 12px;
  color: var(--text-muted);
}
.debug summary { cursor: pointer; user-select: none; margin-bottom: 6px; }
.debug-log {
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
  background: #2b2c2d;
  color: #9ad9a0;
  padding: 8px;
  border-radius: 6px;
  font-family: Menlo, monospace;
  font-size: 11px;
}
.debug-log .muted { color: #666; }
.debug pre {
  background: #f7f7f7;
  padding: 8px;
  border-radius: 4px;
  margin-top: 8px;
  font-size: 11px;
  overflow-x: auto;
}
</style>
