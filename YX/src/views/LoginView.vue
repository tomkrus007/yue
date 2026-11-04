<template>
  <div class="login-page">
    <div class="login-card">
      <div class="logo">YX</div>
      <div class="subtitle">云上越秀 · IM 与网盘客户端</div>

      <form @submit.prevent="onLogin">
        <div class="field">
          <label>账号</label>
          <input v-model="username" placeholder="例如 12345（自动补 @yuexiu）" autocomplete="username" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="password" type="password" placeholder="登录密码" autocomplete="current-password" />
        </div>

        <div class="options">
          <label><input v-model="remember" type="checkbox" @change="onRememberChange" /> 记住密码</label>
          <label title="打开页面时用保存的账号密码自动登录">
            <input v-model="autoLogin" type="checkbox" @change="onAutoChange" /> 自动登录
          </label>
        </div>

        <div v-if="auth.error" class="error">{{ auth.error }}</div>

        <button type="submit" :disabled="auth.loading">
          {{ auth.loading ? '登录中…' : '登 录' }}
        </button>
      </form>

      <div class="tools-toggle">
        <button
          type="button"
          class="tools-button"
          title="调试与高级设置"
          aria-label="调试与高级设置"
          aria-controls="login-tools"
          :aria-expanded="showTools"
          @click="showTools = !showTools"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M4 7h16M4 17h16" />
            <circle cx="9" cy="7" r="3" fill="white" />
            <circle cx="15" cy="17" r="3" fill="white" />
          </svg>
        </button>
      </div>
      <div v-show="showTools" id="login-tools">
        <details class="debug" open>
          <summary>调试日志（点击折叠）</summary>
          <ul class="debug-log">
            <li v-for="(l, i) in auth.debugLog" :key="i">{{ l }}</li>
            <li v-if="!auth.debugLog.length" class="muted">尚未登录</li>
          </ul>
        </details>
  
        <details class="debug">
          <summary>高级：自定义服务地址</summary>
          <div class="adv">
            <input v-model="ssoUrl" placeholder="ssoUrl（留空用配置中心/内置值）" />
            <input v-model="microServiceUrl" placeholder="配置中心 microServiceUrl" />
          </div>
        </details>
  
        <details class="debug">
          <summary>服务端点（点击展开）</summary>
          <pre>{{ endpoints }}</pre>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { DEFAULT_CONFIG } from '../services/config'
import {
  clearCreds,
  decodeSavedPassword,
  encodeSavedPassword,
  loadCreds,
  saveCreds,
} from '../services/credentials'

const auth = useAuthStore()
const router = useRouter()
const username = ref('')
const password = ref('')
const remember = ref(false)
const autoLogin = ref(false)
const showTools = ref(false)
const ssoUrl = ref(localStorage.getItem('ssoUrl') || '')
const microServiceUrl = ref(localStorage.getItem('microServiceUrl') || '')
let autoTried = false

const endpoints = computed(() => ({
  ssoUrl: DEFAULT_CONFIG.ssoUrl,
  embUrl: DEFAULT_CONFIG.embUrl,
  diskOpenApiUrl: DEFAULT_CONFIG.diskOpenApiUrl,
  clientId: DEFAULT_CONFIG.clientId,
}))

onMounted(() => {
  const c = loadCreds()
  if (!c) return
  username.value = c.username
  if (c.remember && c.password) password.value = decodeSavedPassword(c.password)
  remember.value = c.remember
  autoLogin.value = c.auto
  if (c.auto && c.username && password.value && !autoTried) {
    autoTried = true
    onLogin()
  }
})

function onRememberChange() {
  if (!remember.value) autoLogin.value = false
}

function onAutoChange() {
  if (autoLogin.value) remember.value = true
}

async function doLogin() {
  if (ssoUrl.value.trim()) localStorage.setItem('ssoUrl', ssoUrl.value.trim())
  else localStorage.removeItem('ssoUrl')
  if (microServiceUrl.value.trim()) {
    localStorage.setItem('microServiceUrl', microServiceUrl.value.trim())
  } else {
    localStorage.removeItem('microServiceUrl')
  }
  const ok = await auth.login(username.value, password.value)
  if (!ok) return false
  const useRemember = remember.value || autoLogin.value
  if (useRemember) {
    saveCreds({
      username: username.value,
      password: encodeSavedPassword(password.value),
      remember: true,
      auto: autoLogin.value,
    })
  } else {
    clearCreds()
  }
  password.value = ''
  await router.replace('/chat')
  return true
}

async function onLogin() {
  if (!username.value || !password.value) return
  try {
    await doLogin()
  } catch (e: any) {
    auth.log('跳转异常：' + (e?.message || e))
    auth.error = e?.message || '登录后跳转失败'
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100%;
  padding: 24px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f28823 0%, #e07b18 100%);
}
.login-card {
  width: 380px;
  max-width: 100%;
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
.options {
  display: flex;
  gap: 18px;
  margin: -4px 0 16px;
  font-size: 12px;
  color: var(--text-muted);
}
.options label { display: flex; align-items: center; gap: 5px; cursor: pointer; white-space: nowrap; }
.options input[type='checkbox'] { width: auto; flex-shrink: 0; }
.tools-toggle { display: flex; justify-content: flex-end; margin-top: 12px; }
.tools-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
}
.tools-button:hover, .tools-button[aria-expanded='true'] { background: #f0f0f0; color: var(--text); }
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
.adv { display: flex; flex-direction: column; gap: 6px; }
.adv input { padding: 6px 9px; font-size: 11px; color: var(--text); }
.debug pre {
  background: #f7f7f7;
  padding: 8px;
  border-radius: 4px;
  margin-top: 8px;
  font-size: 11px;
  overflow-x: auto;
}
</style>