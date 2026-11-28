<template>
  <router-view />
  <UploadProgress />
  <MeetingInvitePrompt />
  <SettingsModal v-if="ui.settingsOpen" />
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useImStore } from './stores/im'
import { useWeMeetStore } from './stores/wemeet'
import { usePreferencesStore } from './stores/preferences'
import { useUiStore } from './stores/ui'
import { authService } from './services/auth'
import { initNotificationClick, showMainWindow } from './services/notifications'
import UploadProgress from './components/UploadProgress.vue'
import MeetingInvitePrompt from './components/MeetingInvitePrompt.vue'
import SettingsModal from './components/SettingsModal.vue'

const auth = useAuthStore()
const im = useImStore()
const wemeet = useWeMeetStore()
const prefs = usePreferencesStore()
const ui = useUiStore()
const router = useRouter()

onMounted(async () => {
  // 点击系统通知：先唤起窗口，再跳到对应会话并定位到那条消息。
  // 通知只负责唤起，找不到目标（通知已被回收）时就把窗口带到前台。
  initNotificationClick((target) => {
    void showMainWindow()
    if (!target || !auth.isLoggedIn) return
    const query: Record<string, string> = {
      session: target.sessionId,
      name: target.sessionName,
      type: String(target.sessionType),
    }
    if (target.messageId) query.msg = target.messageId
    void router.push({ path: '/chat', query }).catch(() => {})
  })
  // 恢复登录态时接上自动续期（原版提前 60 秒刷新），
  // 否则后台休眠/长时间挂起后 token 过期只能等 99 或 401 才补救。
  authService.bindAutoRefresh()
  // 恢复登录态时预取用户信息
  if (auth.isLoggedIn && !auth.user) {
    authService.getCurrentUser().catch(() => {})
  }
  // 本地配置（含 @ 提醒中心开关）必须先就绪，再开始接收离线消息，
  // 否则关闭提醒后仍会把启动瞬间到达的 @ 记成待处理。
  await prefs.load()
  // IM 连接是全局的：不能随聊天页卸载而断开（否则切到其它页面就显示"未连接"）
  if (auth.isLoggedIn) {
    im.start()
    // 会议只登记事件监听，真正初始化等到用户点「发起/加入」
    void wemeet.start()
  }
})

watch(
  () => auth.isLoggedIn,
  (logged) => {
    if (logged) {
      void prefs.load().then(() => im.start())
      void wemeet.start()
    } else {
      im.stop()
      // 退出登录：释放 SDK 并清掉该账号的会议缓存（与官方 cleanWeMeetCache 一致）
      wemeet.stop(true)
    }
  },
)

// 凭证确实失效（续期与静默重登都失败）时，无论在哪个页面都回到登录页；
// 原来只在聊天页监听，停在别的页面时会出现「一直收不到消息也不提示」。
watch(
  () => im.needLogin,
  (msg) => {
    if (!msg) return
    im.resetLocal()
    auth.logout()
    void router.replace('/login')
  },
)
</script>
