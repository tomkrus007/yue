<template>
  <div class="zt-layout">
    <nav class="side-nav">
      <div class="nav-avatar" :title="auth.user?.name">
        {{ (auth.user?.name || '?').slice(0, 1) }}
      </div>
      <router-link to="/chat" class="nav-item" title="消息">
        <span class="icon">💬</span>
      </router-link>
      <router-link to="/contacts" class="nav-item" title="通讯录">
        <span class="icon">👥</span>
      </router-link>
      <router-link to="/disk" class="nav-item" title="云盘">
        <span class="icon">📁</span>
      </router-link>
      <button class="nav-item" title="我的应用" @click="appOpen = true">
        <span class="icon">▦</span>
      </button>
      <router-link to="/zt" class="nav-item active" title="零信任分流">
        <span class="icon">🛡</span>
      </router-link>
      <div class="spacer"></div>
      <ConnectionStatus />
      <button class="nav-item logout" @click="onLogout" title="退出">
        <span class="icon">⏻</span>
      </button>
    </nav>

    <main class="zt-main">
      <header class="zt-head">
        <div>
          <h2>零信任分流</h2>
          <div class="sub">
            白名单式本地代理：单端口同时支持 HTTP CONNECT / 普通 HTTP / SOCKS5
          </div>
        </div>
        <div class="head-actions">
          <span :class="['pill', status?.running ? 'on' : 'off']">
            {{ status?.running ? '运行中' : '未启动' }}
          </span>
          <button v-if="!status?.running" :disabled="busy" @click="start">
            {{ busy ? '启动中…' : '启动代理' }}
          </button>
          <button v-else class="danger" :disabled="busy" @click="stop">
            停止
          </button>
        </div>
      </header>

      <div v-if="error" class="banner err">{{ error }}</div>
      <div class="banner">
        说明：这里实现的是 <b>白名单分流代理</b>，不是官方零信任隧道本身。请在
        「上游」填入能访问内网的 HTTP / SOCKS5 代理；未命中规则的请求按默认动作处理。
      </div>

      <div v-if="status?.running" class="stats">
        <div class="stat"><b>{{ status.stats.total }}</b><span>总连接</span></div>
        <div class="stat"><b>{{ status.stats.direct }}</b><span>直连</span></div>
        <div class="stat"><b>{{ status.stats.proxy }}</b><span>走隧道</span></div>
        <div class="stat"><b>{{ status.stats.block }}</b><span>阻断</span></div>
        <div class="stat"><b>{{ status.stats.failed }}</b><span>失败</span></div>
        <div class="stat listen">
          <b>{{ status.host }}:{{ status.port }}</b><span>监听地址</span>
        </div>
      </div>

      <section class="card">
        <div class="card-title">代理设置</div>
        <div class="grid">
          <label class="field check">
            <input v-model="cfg.enabled" type="checkbox" />
            <span>启用分流规则（关闭时按 fallback 处理）</span>
          </label>

          <label class="field">
            <span>监听地址</span>
            <input v-model="cfg.listen.host" placeholder="127.0.0.1" />
          </label>
          <label class="field">
            <span>监听端口</span>
            <input v-model.number="cfg.listen.port" type="number" min="0" max="65535" />
          </label>

          <label class="field">
            <span>未命中规则</span>
            <select v-model="cfg.defaultAction">
              <option value="direct">直连</option>
              <option value="proxy">走上游隧道</option>
              <option value="block">阻断</option>
            </select>
          </label>
          <label class="field">
            <span>总开关关闭时</span>
            <select v-model="cfg.fallback">
              <option value="direct">直连（透传）</option>
              <option value="block">全断</option>
            </select>
          </label>

          <label class="field">
            <span>上游类型</span>
            <select v-model="cfg.upstream.type">
              <option value="direct">直连（无上游）</option>
              <option value="http">HTTP 代理（CONNECT）</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </label>
          <label class="field">
            <span>上游地址</span>
            <input v-model="cfg.upstream.host" placeholder="127.0.0.1" />
          </label>
          <label class="field">
            <span>上游端口</span>
            <input v-model.number="cfg.upstream.port" type="number" min="1" max="65535" />
          </label>
        </div>
      </section>

      <section class="card">
        <div class="card-title">
          规则
          <button class="small secondary" @click="addRule">+ 新增规则</button>
        </div>
        <div v-if="!rules.length" class="hint">
          还没有规则。未命中任何规则时按「未命中规则」处理。
        </div>

        <div v-for="(r, i) in rules" :key="i" class="rule">
          <div class="rule-head">
            <input v-model="r.id" class="rule-id" placeholder="规则 id" />
            <select v-model="r.action">
              <option value="proxy">proxy（走上游）</option>
              <option value="direct">direct（直连）</option>
              <option value="block">block（阻断）</option>
            </select>
            <button class="small danger" @click="rules.splice(i, 1)">删除</button>
          </div>
          <div class="grid">
            <label class="field">
              <span>hostExact（逗号分隔）</span>
              <input v-model="r.hostExact" placeholder="a.example.com" />
            </label>
            <label class="field">
              <span>hostSuffix（逗号分隔）</span>
              <input v-model="r.hostSuffix" placeholder="corp.example.com" />
            </label>
            <label class="field">
              <span>hostRegex（逗号分隔）</span>
              <input v-model="r.hostRegex" placeholder="^.*\\.corp\\.example\\.com$" />
            </label>
            <label class="field">
              <span>CIDR（逗号分隔）</span>
              <input v-model="r.cidr" placeholder="10.0.0.0/8" />
            </label>
            <label class="field">
              <span>端口（逗号分隔，支持 80 或 8000-8100）</span>
              <input v-model="r.portText" placeholder="443,80" />
            </label>
            <label class="field">
              <span>备注</span>
              <input v-model="r.note" placeholder="说明" />
            </label>
          </div>
        </div>
      </section>

      <div class="actions">
        <button class="secondary" :disabled="busy" @click="saveConfig">保存配置</button>
        <button :disabled="busy" @click="start">
          {{ status?.running ? '应用并重启' : '保存并启动' }}
        </button>
      </div>

      <section class="card">
        <div class="card-title">
          最近连接
          <span class="hint">最多保留 500 条</span>
        </div>
        <div class="log-wrap">
          <table class="logs">
            <thead>
              <tr>
                <th>时间</th>
                <th>协议</th>
                <th>目标</th>
                <th>规则</th>
                <th>动作</th>
                <th>上行</th>
                <th>下行</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in logs" :key="l.seq">
                <td class="mono">{{ fmtTs(l.ts) }}</td>
                <td>{{ l.proto }}</td>
                <td class="host" :title="l.host + ':' + l.port">
                  {{ l.host }}:{{ l.port }}
                </td>
                <td>{{ l.rule || '—' }}</td>
                <td>
                  <span :class="['tag', l.action]">{{ actionLabel(l.action) }}</span>
                </td>
                <td>{{ fmtBytes(l.up) }}</td>
                <td>{{ fmtBytes(l.down) }}</td>
                <td :class="l.ok ? 'ok' : 'bad'">
                  {{ l.ok ? (l.ms != null ? l.ms + ' ms' : '成功') : l.err || '失败' }}
                </td>
              </tr>
              <tr v-if="!logs.length">
                <td colspan="8" class="empty">暂无连接记录</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
    <AppPanel v-model:open="appOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppPanel from '../components/AppPanel.vue'
import ConnectionStatus from '../components/ConnectionStatus.vue'
import { useAuthStore } from '../stores/auth'
import { useImStore } from '../stores/im'
import {
  fmtBytes,
  fmtTs,
  loadZtConfig,
  saveZtConfig,
  ztStart,
  ztStatus,
  ztStop,
  type ZtAction,
  type ZtConfig,
  type ZtStatus,
} from '../services/zt'

interface EditRule {
  id: string
  action: ZtAction
  note: string
  hostExact: string
  hostSuffix: string
  hostRegex: string
  cidr: string
  portText: string
}

const auth = useAuthStore()
const im = useImStore()
const appOpen = ref(false)
const router = useRouter()

const status = ref<ZtStatus | null>(null)
const busy = ref(false)
const error = ref('')
const rules = reactive<EditRule[]>([])
const cfg = reactive<ZtConfig>(loadZtConfig())
let timer: ReturnType<typeof setInterval> | null = null

const logs = computed(() => (status.value?.logs || []).slice().reverse())

function toEditable(r: ZtConfig['rules'][number]): EditRule {
  const port = r.match?.port
  const portText = Array.isArray(port)
    ? port.join(',')
    : port === undefined || port === null
      ? ''
      : String(port)
  return {
    id: r.id,
    action: r.action,
    note: r.note || '',
    hostExact: (r.match?.hostExact || []).join(','),
    hostSuffix: (r.match?.hostSuffix || []).join(','),
    hostRegex: (r.match?.hostRegex || []).join(','),
    cidr: (r.match?.cidr || []).join(','),
    portText,
  }
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function hydrate(config: ZtConfig): void {
  cfg.enabled = config.enabled
  cfg.listen = { ...config.listen }
  cfg.defaultAction = config.defaultAction
  cfg.fallback = config.fallback
  cfg.upstream = { ...config.upstream }
  rules.splice(0, rules.length, ...config.rules.map(toEditable))
}

function toConfig(): ZtConfig {
  return {
    enabled: cfg.enabled,
    listen: {
      host: cfg.listen.host || '127.0.0.1',
      port: Number(cfg.listen.port) || 0,
    },
    defaultAction: cfg.defaultAction,
    fallback: cfg.fallback,
    upstream: {
      type: cfg.upstream.type,
      host: cfg.upstream.host || '127.0.0.1',
      port: Number(cfg.upstream.port) || 1080,
    },
    rules: rules.map((r, i) => ({
      id: r.id || `rule-${i}`,
      action: r.action,
      note: r.note,
      match: {
        hostExact: splitList(r.hostExact),
        hostSuffix: splitList(r.hostSuffix),
        hostRegex: splitList(r.hostRegex),
        cidr: splitList(r.cidr),
        port: splitList(r.portText),
      },
    })),
  }
}

function addRule() {
  rules.push({
    id: `rule-${Date.now().toString(36)}`,
    action: 'proxy',
    note: '',
    hostExact: '',
    hostSuffix: '',
    hostRegex: '',
    cidr: '',
    portText: '443,80',
  })
}

async function refreshStatus() {
  try {
    status.value = await ztStatus()
  } catch {
    /* 浏览器里没有 Tauri 命令，忽略 */
  }
}

async function saveConfig() {
  saveZtConfig(toConfig())
  error.value = ''
}

async function start() {
  busy.value = true
  error.value = ''
  try {
    const config = toConfig()
    saveZtConfig(config)
    status.value = await ztStart(config)
  } catch (e: any) {
    error.value =
      '启动失败：' +
      (typeof e === 'string' ? e : e?.message || JSON.stringify(e)) +
      '（零信任代理只在 Tauri 桌面端可用）'
  } finally {
    busy.value = false
  }
}

async function stop() {
  busy.value = true
  error.value = ''
  try {
    await ztStop()
    await refreshStatus()
  } catch (e: any) {
    error.value = '停止失败：' + (typeof e === 'string' ? e : e?.message || e)
  } finally {
    busy.value = false
  }
}

function actionLabel(action: ZtAction): string {
  if (action === 'proxy') return '隧道'
  if (action === 'block') return '阻断'
  return '直连'
}

function onLogout() {
  im.resetLocal()
  auth.logout()
  router.replace('/login')
}

onMounted(async () => {
  if (!auth.isLoggedIn) {
    router.replace('/login')
    return
  }
  const saved = loadZtConfig()
  hydrate(saved)
  await refreshStatus()
  if (status.value?.config && !status.value.running) {
    // 服务端没有运行态时，以本地保存的配置为准
  } else if (status.value?.running) {
    hydrate(status.value.config || saved)
  }
  timer = setInterval(refreshStatus, 2000)
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
.side-nav {
  background: #2b2c2d;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 8px;
}
.nav-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  margin-bottom: 12px;
}
.nav-item {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: #fff;
  font-size: 18px;
  background: transparent;
  padding: 0;
  text-decoration: none;
}
.nav-item:hover { background: rgba(255, 255, 255, 0.1); }
.nav-item.active { background: rgba(242, 136, 35, 0.3); }
.spacer { flex: 1; }

.zt-main {
  overflow-y: auto;
  padding: 18px 24px 40px;
  background: var(--bg);
}
.zt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.zt-head h2 { font-size: 20px; }
.sub { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
.head-actions { display: flex; align-items: center; gap: 10px; }
.pill {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}
.pill.on { color: var(--success); border-color: #bfe8cf; background: #f0fbf4; }
.pill.off { background: #f5f6f7; }

.banner {
  background: #fffaf0;
  border: 1px solid #f3e2c0;
  color: #7a5a20;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
  margin-bottom: 14px;
}
.banner.err { background: #fff2f1; border-color: #f3c6c3; color: var(--danger); }

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.stat {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 14px;
  min-width: 88px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat b { font-size: 16px; }
.stat span { font-size: 11px; color: var(--text-muted); }
.stat.listen b { font-size: 13px; }

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.card-title .hint { font-size: 11px; font-weight: 400; color: var(--text-muted); }
.card-title .small { margin-left: auto; }
.small { padding: 4px 10px; font-size: 12px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px 14px;
}
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.field input,
.field select {
  padding: 6px 9px;
  font-size: 13px;
  color: var(--text);
}
.field.check { flex-direction: row; align-items: center; gap: 8px; grid-column: 1 / -1; }
.field.check input { width: auto; }

.rule {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fcfdfe;
}
.rule-head { display: flex; gap: 8px; margin-bottom: 10px; }
.rule-id { flex: 1; padding: 6px 9px; font-size: 13px; }
.rule-head select { padding: 6px 9px; font-size: 12px; }
.hint { font-size: 12px; color: var(--text-muted); }

.actions { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 14px; }

.log-wrap { max-height: 360px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.logs { width: 100%; border-collapse: collapse; font-size: 12px; }
.logs th,
.logs td {
  padding: 6px 8px;
  border-bottom: 1px solid #f0f2f4;
  text-align: left;
  white-space: nowrap;
}
.logs th {
  position: sticky;
  top: 0;
  background: #f7f8f9;
  color: var(--text-muted);
  font-weight: 500;
}
.logs td.host { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.mono { font-family: Menlo, monospace; color: var(--text-muted); }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 8px; }
.tag.proxy { background: #eef4ff; color: #2f6fd0; }
.tag.direct { background: #f1f3f5; color: #5b6773; }
.tag.block { background: #fff1f0; color: var(--danger); }
.ok { color: var(--success); }
.bad { color: var(--danger); }
.empty { text-align: center; color: var(--text-muted); padding: 20px; }
</style>