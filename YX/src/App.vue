<template>
  <router-view />
  <UploadProgress />
  <MeetingInvitePrompt />
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useAuthStore } from './stores/auth'
import { useImStore } from './stores/im'
import { useWeMeetStore } from './stores/wemeet'
import UploadProgress from './components/UploadProgress.vue'
import MeetingInvitePrompt from './components/MeetingInvitePrompt.vue'

const auth = useAuthStore()
const im = useImStore()
const wemeet = useWeMeetStore()

onMounted(() => {
  // 恢复登录态时预取用户信息
  if (auth.isLoggedIn && !auth.user) {
    import('./services/auth').then(({ authService }) => {
      authService.getCurrentUser().catch(() => {})
    })
  }
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
      im.start()
      void wemeet.start()
    } else {
      im.stop()
      wemeet.stop()
    }
  },
)
</script>
