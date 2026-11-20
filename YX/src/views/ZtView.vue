<template>
  <div class="zt-layout">
    <SideNav active="zt" @apps="appOpen = true" />

    <main class="zt-main">
      <header class="zt-head" data-tauri-drag-region="deep">
        <div>
          <h2>零信任</h2>
          <div class="sub">由本机官方零信任客户端提供隧道；YX 只负责登录与状态展示</div>
        </div>
        <div class="head-actions">
          <span :class="['pill', stateClass]">{{ stateLabel }}</span>
          <button class="small secondary" :disabled="busy" @click="refresh()">刷新</button>
        </div>
      </header>

      <div v-if="error" class="banner err">{{ error }}</div>

      <div class="banner">
        登录后会调用官方客户端的本机 SDK（<code>127.0.0.1:35440-35443</code> 的
        <code>/trustagent</code>），把当前云上越秀的 AccessToken 交给它完成零信任登录，
        等价于官方 App 登录后自动做的事。登录成功后内网流量由官方客户端的 utun 与内网路由接管。
      </div>

      <section class="card">
        <div class="card-title">本机零信任客户端</div>
        <div class="grid">
          <div class="field">
            <span>状态</span>
            <b>{{ sdk ? `${sdk.state}（:${sdk.port}）` : '未检测到' }}</b>
          </div>
          <div class="field">
            <span>网关认证方式</span>
            <b>{{ authTypes.length ? authTypes.join(' / ') : '—' }}</b>
          </div>
          <div class="field-wide row">
            <button class="small" :disabled="busy" @click="login">
              {{ busy ? '处理中…' : '用登录态登录零信任' }}
            </button>
            <button class="small secondary" :disabled="busy" @click="logout">注销</button>
            <span v-if="message" class="hint">{{ message }}</span>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-title">与 Clash 共存</div>
        <div class="hint">
          零信任登录后可能把系统默认路由指向它的 utun，导致 Clash 的 TUN 失效。发现 Clash 异常时执行：
        </div>
        <pre class="code">netstat -rn -f inet | grep default
sudo route delete default -ifscope utun8</pre>
        <div class="hint">
          之后公网回到 Clash，内网仍走零信任（它的 <code>/32</code> 路由保留）。
          重新登录零信任后可能再次被抢走，重复上面两步即可。
        </div>
      </section>
    </main>

    <AppPanel :open="appOpen" @update:open="appOpen = $event" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppPanel from '../components/AppPanel.vue'
import SideNav from '../components/SideNav.vue'
import { useAuthStore } from '../stores/auth'
import {
  ztSdkAuthTypes,
  ztSdkLogin,
  ztSdkLogout,
  ztSdkStatus,
  type ZtSdkStatus,
} from '../services/zt'

const auth = useAuthStore()
const router = useRouter()

const appOpen = ref(false)
const busy = ref(false)
const error = ref('')
const message = ref('')
const sdk = ref<ZtSdkStatus | null>(null)
const authTypes = ref<string[]>([])

const stateLabel = computed(() => {
  if (!sdk.value) return '未检测到'
  return sdk.value.state === 'online' ? '已连接' : '未连接'
})
const stateClass = computed(() =>
  sdk.value?.state === 'online' ? 'on' : 'off',
)

const DETECT_MSG = '未检测到本机零信任客户端：'

/**
 * 状态查询。
 *
 * `silent` 供 5 秒轮询使用：不占用 busy（否则登录按钮会一直显示“处理中…”）、
 * 失败只查一次、不重复拉取需要网关往返的认证方式。
 */
async function refresh(silent = false): Promise<void> {
  const wasOnline = sdk.value?.state === 'online'
  if (!silent) {
    busy.value = true
    error.value = ''
    message.value = ''
  }
  let lastErr: unknown = null
  const attempts = silent ? 1 : 3
  for (let i = 0; i < attempts; i++) {
    try {
      sdk.value = await ztSdkStatus()
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600))
    }
  }
  if (lastErr) {
    sdk.value = null
    authTypes.value = []
    message.value =
      DETECT_MSG +
      (typeof lastErr === 'string'
        ? lastErr
        : (lastErr as any)?.message || JSON.stringify(lastErr))
    if (!silent) busy.value = false
    return
  }
  if (message.value.startsWith(DETECT_MSG)) message.value = ''
  // 认证方式需要网关可达；离线时跳过，在线后仅在首次或状态刚恢复时查询
  if (sdk.value?.state === 'online') {
    if (!silent || !wasOnline) {
      try {
        authTypes.value = await ztSdkAuthTypes()
      } catch {
        authTypes.value = []
      }
    }
  } else {
    authTypes.value = []
  }
  if (!silent) busy.value = false
}

async function login(): Promise<void> {
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const result = await ztSdkLogin(auth.token || '')
    await refresh()
    message.value = result
  } catch (e: any) {
    error.value =
      '零信任登录失败：' + (typeof e === 'string' ? e : e?.message || JSON.stringify(e))
    busy.value = false
  }
}

async function logout(): Promise<void> {
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const result = await ztSdkLogout()
    await refresh()
    message.value = result
  } catch (e: any) {
    error.value =
      '注销失败：' + (typeof e === 'string' ? e : e?.message || JSON.stringify(e))
    busy.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
/** 后台轮询进行中：避免慢查询（状态/网关）叠加，且不占用 busy */
let polling = false

async function poll(): Promise<void> {
  polling = true
  try {
    await refresh(true)
  } finally {
    polling = false
  }
}

onMounted(() => {
  if (!auth.isLoggedIn) {
    router.replace('/login')
    return
  }
  refresh()
  timer = setInterval(() => {
    if (!busy.value && !polling) void poll()
  }, 5000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.zt-layout {
  display: grid;
  grid-template-columns: 56px 1fr;
  height: 100%;
}

.zt-main {
  overflow-y: auto;
  padding: 0 24px 40px;
  background: var(--bg);
}
.zt-head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: var(--titlebar-height);
  margin-bottom: 8px;
  background: var(--bg);
}
.zt-head h2 { font-size: 15px; font-weight: 600; }
.sub { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
.head-actions { display: flex; align-items: center; gap: 10px; }
.pill {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}
.pill.on { color: var(--success); border-color: var(--success); background: var(--success-soft); }
.pill.off { background: var(--surface-2); }

.banner {
  background: var(--warning-soft);
  border: 1px solid var(--border);
  color: var(--warning-text);
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
  margin-bottom: 14px;
}
.banner.err { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px 14px;
  align-items: center;
}
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.field-wide { grid-column: 1 / -1; }
.row { display: flex; align-items: center; gap: 10px; }
.small { padding: 4px 12px; font-size: 12px; }
.hint { font-size: 12px; color: var(--text-muted); line-height: 1.7; }
.code {
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: Menlo, monospace;
  font-size: 12px;
  color: var(--text-muted);
  margin: 8px 0;
  white-space: pre-wrap;
}
</style>
