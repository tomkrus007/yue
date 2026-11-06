<template>
  <router-view />
  <UploadProgress />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuthStore } from './stores/auth'
import UploadProgress from './components/UploadProgress.vue'

const auth = useAuthStore()

onMounted(() => {
  // 恢复登录态时预取用户信息
  if (auth.isLoggedIn && !auth.user) {
    import('./services/auth').then(({ authService }) => {
      authService.getCurrentUser().catch(() => {})
    })
  }
})
</script>
