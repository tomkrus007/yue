<template>
  <div class="zt-layout">
    <SideNav active="wemeet" />

    <main class="zt-main">
      <header class="zt-head" data-tauri-drag-region="deep">
        <div>
          <h2>腾讯会议验证（P0）</h2>
          <div class="sub">验证 TMSDK 能否在 Tauri 壳内初始化并弹出会前窗口</div>
        </div>
        <div class="head-actions">
          <span :class="['pill', sdkReady ? 'on' : 'off']">
            {{ sdkReady ? 'SDK 已初始化' : 'SDK 未初始化' }}
          </span>
          <button class="small secondary" :disabled="busy" @click="refreshStatus">
            刷新
          </button>
        </div>
      </header>

      <div class="banner">
        这是技术验证页，不属于正式 UI。它只回答两个问题：<br />
        1）<code>v1/tencent/meeting/config</code> 是否对非官方客户端放行；<br />
        2）官方 <code>TMSDK.framework</code> 能否在 Tauri 进程内初始化、登录并弹出会前窗口。
        需要先在 <code>src-tauri/vendor/</code> 放好框架（<code>scripts/sync-wemeet.sh</code>）。
      </div>

      <div v-if="error" class="banner err">{{ error }}</div>

      <section class="card">
        <div class="card-title">1. 账号配置</div>
        <div class="grid">
          <label class="field field-wide">
            <span>会议服务地址（配置中心的 rtcUri，留空则用已缓存的 serverPaths）</span>
            <input v-model="rtcUri" placeholder="https://xxx/rtc/" spellcheck="false" />
          </label>
          <div class="field-wide row">
            <button class="small" :disabled="busy" @click="loadAccount">拉取配置</button>
            <span v-if="account" class="hint">
              sdkKey={{ mask(account.sdkKey) }} · sdkToken={{ account.sdkToken.length }} 字符 ·
              idToken={{ account.idToken.length }} 字符
            </span>
            <span v-else class="hint">尚未拉取</span>
          </div>
          <div v-if="account" class="field field-wide">
            <span>ssoUrlPrefix</span>
            <code class="code">{{ account.ssoUrlPrefix || '（空）' }}</code>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-title">2. SDK 调用</div>
        <div class="row wrap">
          <button class="small" :disabled="busy || !account" @click="doInit">初始化</button>
          <button class="small" :disabled="busy || !account" @click="doLogin">登录</button>
          <button class="small" :disabled="busy || !sdkReady" @click="run('打开会前界面', wemeetShowHome)">
            打开会前界面
          </button>
          <button class="small" :disabled="busy || !sdkReady" @click="run('快速会议', () => wemeetQuick('网络会议'))">
            快速会议
          </button>
          <button class="small" :disabled="busy || !sdkReady" @click="run('置顶', wemeetBringTop)">
            置顶
          </button>
          <button class="small secondary" :disabled="busy || !sdkReady" @click="run('登出', wemeetLogout)">
            登出
          </button>
          <button class="small secondary" :disabled="busy" @click="run('释放 SDK', wemeetRelease)">
            释放
          </button>
        </div>
        <div class="row wrap" style="margin-top: 10px">
          <input v-model="meetingCode" class="inline" placeholder="会议号" spellcheck="false" />
          <button
            class="small"
            :disabled="busy || !sdkReady || !meetingCode.trim()"
            @click="doJoin"
          >
            加入会议
          </button>
          <button class="small" :disabled="busy" @click="runAll">一键验证（拉配置 → 初始化 → 登录 → 会前界面）</button>
        </div>
        <div class="hint" style="margin-top: 8px">
          入会默认关麦克风、关摄像头（与官方「加入会议」一致）。
        </div>
      </section>

      <section class="card">
        <div class="card-title log-head">
          <span>3. 原生事件（{{ events.length }}）</span>
          <button class="small secondary" @click="events = []">清空</button>
        </div>
        <div v-if="!events.length" class="hint">还没有事件。初始化后 TMSDK 会回调 OnSDKInitializeResult 等。</div>
        <div v-else class="log">
          <div v-for="(e, i) in events" :key="i" :class="['log-line', level(e)]">
            <span class="log-func">{{ e.func }}</span>
            <span class="log-code">code={{ e.code }}</span>
            <span v-if="e.service" class="log-svc">{{ e.service }}</span>
            <span class="log-msg">{{ e.msg }}</span>
            <span v-if="e.param" class="log-param">{{ short(e.param) }}</span>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import SideNav from '../components/SideNav.vue'
import { getServerPaths } from '../services/config'
import {
  currentUserName,
  fetchWeMeetAccount,
  listenWeMeetEvent,
  wemeetBringTop,
  wemeetInit,
  wemeetJoin,
  wemeetLogout,
  wemeetLogin,
  wemeetQuick,
  wemeetRelease,
  wemeetShowHome,
  wemeetStatus,
  type WeMeetAccount,
  type WeMeetEvent,
} from '../services/wemeet'

const rtcUri = ref(getServerPaths().rtcUri || '')
const account = ref<WeMeetAccount | null>(null)
const sdkReady = ref(false)
const busy = ref(false)
const error = ref('')
const meetingCode = ref('')
const events = ref<WeMeetEvent[]>([])

let unlisten: UnlistenFn | null = null

/** 等待某个原生事件的 Promise 队列（TMSDK 的初始化/登录都是异步回调）。 */
interface Waiter {
  match: (e: WeMeetEvent) => boolean
  resolve: (e: WeMeetEvent) => void
  timer: ReturnType<typeof setTimeout>
}
let waiters: Waiter[] = []

function waitEvent(
  match: (e: WeMeetEvent) => boolean,
  timeoutMs: number,
  label: string,
): Promise<WeMeetEvent> {
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      match,
      resolve: (e) => {
        clearTimeout(waiter.timer)
        waiters = waiters.filter((w) => w !== waiter)
        resolve(e)
      },
      timer: setTimeout(() => {
        waiters = waiters.filter((w) => w !== waiter)
        reject(new Error(`等待 ${label} 超时（${timeoutMs / 1000}s）`))
      }, timeoutMs),
    }
    waiters.push(waiter)
  })
}

function onEvent(e: WeMeetEvent) {
  events.value.unshift(e)
  if (events.value.length > 200) events.value.length = 200
  // 复制一份：resolve 会修改 waiters
  for (const w of [...waiters]) {
    if (w.match(e)) w.resolve(e)
  }
}

function logLocal(func: string, msg: string, code = '') {
  onEvent({ func, code, msg })
}

function short(v: string): string {
  return v.length > 160 ? v.slice(0, 160) + '…' : v
}

function mask(v: string): string {
  if (!v) return '（空）'
  return v.slice(0, 6) + '…' + v.slice(-4)
}

function level(e: WeMeetEvent) {
  if (e.func === 'OnSDKError' || (e.code && e.code !== '0' && !e.code.startsWith('-'))) return 'warn'
  if (e.code && e.code !== '0' && e.code !== '-1011' && e.code !== '-1012') return 'warn'
  return ''
}

async function refreshStatus() {
  try {
    sdkReady.value = await wemeetStatus()
  } catch {
    sdkReady.value = false
  }
}

async function loadAccount(): Promise<WeMeetAccount> {
  const acc = await fetchWeMeetAccount(rtcUri.value)
  account.value = acc
  logLocal(
    'Config',
    `已获取账号配置：sdkKey=${mask(acc.sdkKey)} ssoUrlPrefix=${acc.ssoUrlPrefix}`,
  )
  return acc
}

async function doInit() {
  const acc = account.value
  if (!acc) return
  busy.value = true
  error.value = ''
  try {
    const pending = waitEvent((e) => e.func === 'OnSDKInitializeResult', 30000, 'OnSDKInitializeResult')
    await wemeetInit(acc)
    const e = await pending
    // -1011 = 重复初始化，可继续使用
    if (e.code !== '0' && e.code !== '-1011') {
      throw new Error(`初始化失败：${e.msg || e.code}`)
    }
    sdkReady.value = true
  } catch (err: any) {
    error.value = typeof err === 'string' ? err : err?.message || String(err)
  } finally {
    busy.value = false
  }
}

async function doLogin() {
  const acc = account.value
  if (!acc) return
  if (!acc.ssoUrlPrefix || !acc.idToken) {
    error.value = '配置缺 ssoUrlPrefix 或 idToken，无法登录'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const pending = waitEvent((e) => e.func === 'OnLogin', 40000, 'OnLogin')
    await wemeetLogin(acc.ssoUrlPrefix + acc.idToken)
    const e = await pending
    // -1012 = 已登录
    if (e.code !== '0' && e.code !== '-1012') {
      throw new Error(`登录失败：${e.msg || e.code}`)
    }
  } catch (err: any) {
    error.value = typeof err === 'string' ? err : err?.message || String(err)
  } finally {
    busy.value = false
  }
}

async function run(label: string, fn: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await fn()
    logLocal('Local', `${label} 调用完成`)
  } catch (err: any) {
    error.value = `${label}失败：` + (typeof err === 'string' ? err : err?.message || String(err))
  } finally {
    busy.value = false
    await refreshStatus()
  }
}

async function doJoin() {
  const name = currentUserName() || 'YX'
  await run(`加入会议 ${meetingCode.value}`, () => wemeetJoin(meetingCode.value.trim(), name))
}

/** P0 主路径：配置 → 初始化 → 登录 → 会前界面。 */
async function runAll() {
  busy.value = true
  error.value = ''
  try {
    logLocal('Local', '一键验证开始')
    const acc = account.value || (await loadAccount())
    const initPending = waitEvent((e) => e.func === 'OnSDKInitializeResult', 30000, 'OnSDKInitializeResult')
    await wemeetInit(acc)
    const initEvt = await initPending
    if (initEvt.code !== '0' && initEvt.code !== '-1011') {
      throw new Error(`初始化失败：${initEvt.msg || initEvt.code}`)
    }
    sdkReady.value = true

    const loginPending = waitEvent((e) => e.func === 'OnLogin', 40000, 'OnLogin')
    await wemeetLogin(acc.ssoUrlPrefix + acc.idToken)
    const loginEvt = await loginPending
    if (loginEvt.code !== '0' && loginEvt.code !== '-1012') {
      throw new Error(`登录失败：${loginEvt.msg || loginEvt.code}`)
    }

    await wemeetShowHome()
    logLocal('Local', '已调用 ShowPreMeetingView，检查是否弹出会前窗口')
  } catch (err: any) {
    error.value = '一键验证失败：' + (typeof err === 'string' ? err : err?.message || String(err))
  } finally {
    busy.value = false
    await refreshStatus()
  }
}

onMounted(async () => {
  unlisten = await listenWeMeetEvent(onEvent)
  await refreshStatus()
})

onUnmounted(() => {
  unlisten?.()
  unlisten = null
  for (const w of waiters) clearTimeout(w.timer)
  waiters = []
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
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.log-head { display: flex; align-items: center; justify-content: space-between; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px 14px;
  align-items: center;
}
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.field-wide { grid-column: 1 / -1; }
.row { display: flex; align-items: center; gap: 10px; }
.wrap { flex-wrap: wrap; }
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
  word-break: break-all;
}
input {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text);
  font-family: inherit;
}
input.inline { width: 180px; }
.log {
  max-height: 340px;
  overflow-y: auto;
  font-family: Menlo, monospace;
  font-size: 11px;
  line-height: 1.8;
}
.log-line { display: flex; gap: 8px; padding: 2px 0; border-bottom: 1px dashed var(--border); }
.log-line.warn { color: var(--danger); }
.log-func { min-width: 160px; font-weight: 600; }
.log-code { min-width: 64px; color: var(--text-muted); }
.log-svc { min-width: 110px; color: var(--text-muted); }
.log-msg { flex: 1; word-break: break-all; }
.log-param { color: var(--text-muted); word-break: break-all; }
</style>
