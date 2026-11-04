<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuthStore } from './stores/auth'

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
