import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authService, type UserInfo } from '../services/auth'
import { disableAutoLogin } from '../services/credentials'
import { STORAGE_KEYS } from '../services/config'
import { logEvent } from '../services/app-log'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserInfo | null>(null)
  const loading = ref(false)
  const error = ref('')
  const debugLog = ref<string[]>([])

  // 登录态必须用响应式状态：之前直接 computed 里读 localStorage 没有任何依赖，
  // 结果在 App.vue 启动时读一次就被缓存成 false，登录成功后 ChatView 仍判未登录而被弹回登录页。
  const token = ref(authService.getAccessToken())
  const expiresAt = ref(
    Number(localStorage.getItem(STORAGE_KEYS.expiresAt) || 0),
  )

  const isLoggedIn = computed(() => {
    if (!token.value) return false
    // 0 表示没拿到过期时间，只要有 token 就算登录
    if (!expiresAt.value) return true
    return Date.now() < expiresAt.value
  })

  /** 登录 / 退出 / 刷新 token 后把 localStorage 里的会话同步到响应式状态 */
  function syncSession() {
    token.value = authService.getAccessToken()
    expiresAt.value = Number(
      localStorage.getItem(STORAGE_KEYS.expiresAt) || 0,
    )
  }

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString()
    debugLog.value.unshift(`[${ts}] ${msg}`)
    if (debugLog.value.length > 30) debugLog.value.length = 30
    logEvent('登录', msg)
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
      syncSession()
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
    // 退出后保留「记住密码」，但关掉自动登录，否则重开又直接进去
    disableAutoLogin()
    authService.logout()
    syncSession()
    user.value = null
    debugLog.value = []
  }

  return {
    user,
    loading,
    error,
    debugLog,
    isLoggedIn,
    token,
    login,
    logout,
    log,
    syncSession,
  }
})
