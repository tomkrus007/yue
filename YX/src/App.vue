<template>
  <router-view />
  <UploadProgress />
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useAuthStore } from './stores/auth'
import { useImStore } from './stores/im'
import UploadProgress from './components/UploadProgress.vue'

const auth = useAuthStore()
const im = useImStore()

onMounted(() => {
  // 恢复登录态时预取用户信息
  if (auth.isLoggedIn && !auth.user) {
    import('./services/auth').then(({ authService }) => {
      authService.getCurrentUser().catch(() => {})
    })
  }
  // IM 连接是全局的：不能随聊天页卸载而断开（否则切到其它页面就显示"未连接"）
  if (auth.isLoggedIn) im.start()
})

watch(
  () => auth.isLoggedIn,
  (logged) => {
    if (logged) {
      im.start()
    } else {
      im.stop()
    }
  },
)
</script>
