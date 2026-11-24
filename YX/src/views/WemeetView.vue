<template>
  <div class="wemeet-layout">
    <SideNav active="wemeet" />

    <main class="wemeet-main">
      <header class="wemeet-head" data-tauri-drag-region="deep">
        <div>
          <h2>会议</h2>
          <div class="sub">由腾讯会议原生窗口承载，YX 负责登录与入会参数</div>
        </div>
        <div class="head-actions">
          <span :class="['pill', stateClass]">{{ stateLabel }}</span>
          <button v-if="wemeet.inMeeting && wemeet.meetingCode" class="small secondary" :disabled="inviting" @click="pickerOpen = true">
            邀请同事
          </button>
          <button v-if="wemeet.inMeeting" class="small" @click="act(wemeet.bringTop)">
            回到会议
          </button>
          <button v-else-if="wemeet.state === 'ready'" class="small secondary" @click="act(wemeet.openHome)">
            打开会前界面
          </button>
        </div>
      </header>

      <div v-if="wemeet.error" class="banner err">
        {{ wemeet.error }}
        <button class="link" @click="wemeet.clearError()">知道了</button>
      </div>

      <section class="card">
        <div class="card-title">发起会议</div>
        <div class="row wrap">
          <button :disabled="busy" @click="act(wemeet.openHome)">
            {{ wemeet.state === 'ready' ? '打开会前界面' : '连接并打开会前界面' }}
          </button>
          <button class="secondary" :disabled="busy" @click="act(wemeet.quickMeeting)">
            快速会议
          </button>
          <span v-if="busy" class="hint">正在连接会议服务…</span>
        </div>
        <div class="hint">
          首次使用需要初始化腾讯会议组件并登录（约 3–10 秒）。会议界面是腾讯原生窗口，
          设置、预约、历史会议都在会前界面里。
        </div>
      </section>

      <section class="card">
        <div class="card-title">加入会议</div>
        <div class="row wrap">
          <input
            v-model="meetingCode"
            class="code-input"
            placeholder="输入会议号"
            spellcheck="false"
            @keyup.enter="join"
          />
          <button :disabled="busy || !meetingCode.trim()" @click="join">
            加入会议
          </button>
          <span class="hint">入会显示名：{{ displayName }}</span>
        </div>
        <div class="hint">默认关闭麦克风和摄像头，可在会前/会中自行打开。</div>
      </section>

      <section class="card">
        <div class="card-title">连接状态</div>
        <div class="grid">
          <div class="field">
            <span>组件</span>
            <b>{{ componentLabel }}</b>
          </div>
          <div class="field">
            <span>会议</span>
            <b>{{ wemeet.inMeeting ? '进行中' : '未在会议中' }}</b>
          </div>
          <div class="field">
            <span>会议号</span>
            <b>{{ wemeet.meetingCode || '—' }}</b>
          </div>
        </div>

        <p v-if="note" class="hint" role="status">{{ note }}</p>

        <details class="events">
          <summary>原生事件（{{ wemeet.events.length }}）</summary>
          <div v-if="!wemeet.events.length" class="hint">还没有事件。</div>
          <div v-else class="log">
            <div v-for="(e, i) in wemeet.events.slice(0, 30)" :key="i" class="log-line">
              <span class="log-func">{{ e.func }}</span>
              <span class="log-code">{{ e.code }}</span>
              <span class="log-msg">{{ e.msg }}</span>
            </div>
          </div>
        </details>
      </section>
    </main>

    <MemberPicker
      v-if="pickerOpen"
      :open="pickerOpen"
      title="选择要邀请的同事"
      source="contacts"
      @close="pickerOpen = false"
      @confirm="confirmInvitees"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import SideNav from '../components/SideNav.vue'
import MemberPicker from '../components/MemberPicker.vue'
import type { PickedMember } from '../components/MemberPicker.vue'
import { useWeMeetStore } from '../stores/wemeet'
import { authService } from '../services/auth'

const wemeet = useWeMeetStore()
const busy = ref(false)
const meetingCode = ref('')
const pickerOpen = ref(false)
const inviting = ref(false)
const note = ref('')

async function confirmInvitees(items: PickedMember[]) {
  pickerOpen.value = false
  if (!items.length) return
  inviting.value = true
  note.value = ''
  try {
    const sent = await wemeet.inviteToMeeting(items)
    note.value = sent ? `已向 ${sent} 人发送邀请` : '没有可邀请的人'
  } catch (error) {
    note.value = error instanceof Error ? error.message : '发送邀请失败'
  } finally {
    inviting.value = false
  }
}

const displayName = authService.getCurrentUserName() || 'YX'

const stateLabel = computed(() => {
  if (wemeet.inMeeting) return '会议中'
  if (wemeet.state === 'connecting') return '连接中'
  return wemeet.state === 'ready' ? '已就绪' : '未连接'
})

const stateClass = computed(() => {
  if (wemeet.inMeeting) return 'live'
  if (wemeet.state === 'connecting') return 'busy'
  return wemeet.state === 'ready' ? 'on' : 'off'
})

const componentLabel = computed(() => {
  if (wemeet.state === 'ready') return '已初始化并登录'
  if (wemeet.state === 'connecting') return '正在启动'
  return '未启动'
})

async function act(fn: () => Promise<void>) {
  busy.value = true
  try {
    await fn()
  } catch {
    // 错误由 store 统一写入 wemeet.error
  } finally {
    busy.value = false
  }
}

function join() {
  const code = meetingCode.value.trim()
  if (!code) return
  void act(async () => {
    await wemeet.joinMeeting(code)
    meetingCode.value = ''
  })
}
</script>

<style scoped>
.wemeet-layout {
  display: grid;
  grid-template-columns: 56px 1fr;
  height: 100%;
}
.wemeet-main {
  overflow-y: auto;
  padding: 0 24px 40px;
  background: var(--bg);
}
.wemeet-head {
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
.wemeet-head h2 { font-size: 15px; font-weight: 600; }
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
.pill.live { color: var(--success); border-color: var(--success); background: var(--success-soft); }
.pill.busy { color: var(--warning-text); background: var(--warning-soft); }
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
.banner .link {
  margin-left: 8px;
  background: none;
  border: 0;
  padding: 0;
  color: inherit;
  text-decoration: underline;
  font-size: 12px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px 14px;
  align-items: center;
  margin-bottom: 12px;
}
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.row { display: flex; align-items: center; gap: 10px; }
.wrap { flex-wrap: wrap; }
.small { padding: 4px 12px; font-size: 12px; }
.hint { font-size: 12px; color: var(--text-muted); line-height: 1.7; margin-top: 10px; }
.row .hint { margin-top: 0; }
.code-input {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
  color: var(--text);
  width: 220px;
  letter-spacing: 1px;
}
.events { margin-top: 8px; }
.events summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  user-select: none;
}
.log {
  margin-top: 8px;
  max-height: 240px;
  overflow-y: auto;
  font-family: Menlo, monospace;
  font-size: 11px;
  line-height: 1.8;
}
.log-line { display: flex; gap: 8px; border-bottom: 1px dashed var(--border); }
.log-func { min-width: 170px; font-weight: 600; }
.log-code { min-width: 56px; color: var(--text-muted); }
.log-msg { flex: 1; word-break: break-all; }
</style>
