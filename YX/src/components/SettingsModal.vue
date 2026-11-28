<template>
  <div class="settings-mask" @click.self="ui.closeSettings()" @keydown.esc="ui.closeSettings()">
    <section
      ref="panel"
      class="settings-panel"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      tabindex="-1"
    >
      <header>
        <div>
          <h3>设置</h3>
          <p class="sub">配置保存在本机，重启应用后继续生效。</p>
        </div>
        <button class="secondary small" @click="ui.closeSettings()">关闭</button>
      </header>

      <div class="settings-body">
        <section class="group">
          <h4>提醒</h4>
          <label class="row">
            <span class="row-text">
              <strong>@ 提醒中心</strong>
              <small>关闭后隐藏导航栏的 @ 入口，不再统计待处理提醒；历史记录会保留。</small>
            </span>
            <input
              type="checkbox"
              class="toggle"
              role="switch"
              :checked="prefs.mentionCenter"
              @change="toggleMention"
            />
          </label>
          <label v-if="caps?.message_sound !== false" class="row">
            <span class="row-text">
              <strong>消息提示音</strong>
              <small>收到新消息时播放系统提示音。</small>
            </span>
            <input
              type="checkbox"
              class="toggle"
              role="switch"
              :checked="prefs.messageSound"
              @change="toggleSound"
            />
          </label>
        </section>

        <section class="group">
          <h4>应用</h4>
          <label class="row">
            <span class="row-text">
              <strong>用系统浏览器打开应用</strong>
              <small>
                默认在应用窗口内打开（写入登录 Cookie，免二次登录）；个别应用只兼容浏览器时可打开此开关，浏览器里可能需要单独登录一次。
              </small>
            </span>
            <input
              type="checkbox"
              class="toggle"
              role="switch"
              :checked="prefs.appOpenInBrowser"
              @change="toggleAppOpenInBrowser"
            />
          </label>
        </section>

        <section class="group">
          <h4>文件</h4>
          <div class="row column">
            <span class="row-text">
              <strong>下载目录</strong>
              <small>聊天附件和云盘文件默认保存到这里，路径不存在时会自动创建。</small>
            </span>
            <code class="path">{{ prefs.downloadDir || '读取中…' }}</code>
            <div class="row-actions">
              <button class="secondary small" @click="chooseDownloadDir">选择目录</button>
              <button
                class="secondary small"
                :disabled="!prefs.downloadDirCustomized"
                @click="resetDownloadDir"
              >恢复默认</button>
            </div>
            <small v-if="prefs.downloadDirCustomized" class="muted">
              默认位置：{{ prefs.downloadDirDefault }}
            </small>
          </div>
        </section>

        <section class="group">
          <h4>关于</h4>
          <p class="about">
            YX 是云上越秀桌面端的复刻客户端。提醒记录随账号保存在本机数据库，
            退出登录会清除当前账号的数据。
          </p>
        </section>
      </div>

      <p v-if="status" :class="['status', statusKind]">{{ status }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { open } from '@tauri-apps/plugin-dialog'
import { usePreferencesStore } from '../stores/preferences'
import { useUiStore } from '../stores/ui'
import { useCapabilities } from '../services/platform'

const prefs = usePreferencesStore()
const ui = useUiStore()
const { caps, loadCapabilities } = useCapabilities()
const panel = ref<HTMLElement | null>(null)
const status = ref('')
const statusKind = ref<'ok' | 'error'>('ok')

onMounted(async () => {
  void loadCapabilities()
  await prefs.load()
  if (prefs.error) note(`读取配置失败：${prefs.error}`, 'error')
  panel.value?.focus()
})

function note(message: string, kind: 'ok' | 'error' = 'ok') {
  status.value = message
  statusKind.value = kind
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function toggleMention(event: Event) {
  const input = event.target as HTMLInputElement
  try {
    await prefs.setMentionCenter(input.checked)
    note(input.checked ? '已开启 @ 提醒中心' : '已关闭 @ 提醒中心')
  } catch (error) {
    input.checked = prefs.mentionCenter
    note(`保存失败：${errorText(error)}`, 'error')
  }
}

async function toggleSound(event: Event) {
  const input = event.target as HTMLInputElement
  try {
    await prefs.setMessageSound(input.checked)
    note(input.checked ? '已开启消息提示音' : '已关闭消息提示音')
  } catch (error) {
    input.checked = prefs.messageSound
    note(`保存失败：${errorText(error)}`, 'error')
  }
}

async function toggleAppOpenInBrowser(event: Event) {
  const input = event.target as HTMLInputElement
  try {
    await prefs.setAppOpenInBrowser(input.checked)
    note(input.checked ? '应用将用系统浏览器打开' : '应用将在窗口内打开')
  } catch (error) {
    input.checked = prefs.appOpenInBrowser
    note(`保存失败：${errorText(error)}`, 'error')
  }
}

async function chooseDownloadDir() {
  try {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: prefs.downloadDir || undefined,
    })
    if (typeof picked !== 'string' || !picked) return
    await prefs.setDownloadDir(picked)
    note('下载目录已更新')
  } catch (error) {
    note(`保存失败：${errorText(error)}`, 'error')
  }
}

async function resetDownloadDir() {
  try {
    await prefs.setDownloadDir(null)
    note('已恢复默认下载目录')
  } catch (error) {
    note(`保存失败：${errorText(error)}`, 'error')
  }
}
</script>

<style scoped>
.settings-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: var(--overlay);
  display: grid;
  place-items: center;
}
.settings-panel {
  width: min(560px, 92vw);
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  padding: 20px;
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-2);
  outline: none;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
h3 { font-size: 16px; }
.small { padding: 5px 12px; font-size: 12px; }
.sub, .about, .muted { color: var(--text-muted); font-size: 12px; }
.sub { margin-top: 4px; }
.settings-body { flex: 1; overflow-y: auto; min-height: 0; padding: 16px 2px 4px; }
.group + .group { margin-top: 20px; }
h4 {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
}
.row + .row { border-top: 1px solid var(--divider); }
.row.column { flex-direction: column; align-items: stretch; gap: 10px; }
.row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.row-text small { color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.path {
  display: block;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.row-actions { display: flex; gap: 8px; }
.about { line-height: 1.7; }
.status { padding-top: 12px; font-size: 12px; color: var(--success); }
.status.error { color: var(--danger); }
.toggle {
  appearance: none;
  flex-shrink: 0;
  width: 38px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 11px;
  background: var(--border);
  position: relative;
  cursor: pointer;
  transition: background 0.15s;
}
.toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-1);
  transition: transform 0.15s;
}
.toggle:checked { background: var(--primary); }
.toggle:checked::after { transform: translateX(16px); }
.toggle:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
