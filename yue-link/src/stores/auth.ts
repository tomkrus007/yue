import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authService, type UserInfo } from '../services/auth'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserInfo | null>(null)
  const loading = ref(false)
  const error = ref('')
  const debugLog = ref<string[]>([])

  const isLoggedIn = computed(() => authService.isLoggedIn())
  const token = computed(() => authService.getAccessToken())

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString()
    debugLog.value.unshift(`[${ts}] ${msg}`)
    if (debugLog.value.length > 30) debugLog.value.length = 30
  }

  async function login(username: string, password: string) {
    loading.value = true
    error.value = ''
    debugLog.value = []
    log(`开始登录：${username} → ${authService.buildUsername(username)}`)
    try {
      const res = await authService.login(username, password)
      log(`登录结果：mode=${res.mode}${res.error ? ' error=' + res.error : ''}`)
      log(`uid=${res.uid} expires_in=${res.expires_in} tokenLen=${res.access_token.length}`)
      if (res.mode !== 'ok') {
        error.value = res.error || '登录失败（未知原因）'
        return false
      }
      // 立即写入兜底用户名，保证发送消息 from_name 非空
      authService.setCurrentUserName(username)
      user.value = { id: res.uid, name: username }
      // 用户信息异步拉取，不阻塞跳转（接口慢/挂起时也能进主界面）
      authService
        .getCurrentUser()
        .then((u) => {
          user.value = u
          log(`用户信息：${u.name}`)
        })
        .catch((e: any) => {
          log(`用户信息获取失败（不阻断）：${e.message}`)
          user.value = { id: res.uid, name: username }
          authService.setCurrentUserName(username)
        })
      return true
    } catch (e: any) {
      log(`登录异常：${e.message}`)
      error.value = e.message || '登录异常'
      return false
    } finally {
      loading.value = false
    }
  }

  function logout() {
    authService.logout()
    user.value = null
    debugLog.value = []
  }

  return { user, loading, error, debugLog, isLoggedIn, token, login, logout, log }
})
