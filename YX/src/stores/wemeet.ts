/**
 * 腾讯会议（TMSDK）状态机。
 *
 * 生命周期：idle → connecting（拉配置/初始化/登录）→ ready。
 * SDK 首次调用会有几秒延迟，因此首次点「发起/加入」时才连接，不做启动预热。
 *
 * 事件统一在这里消费：
 * - `OnSDKTokenExpired` 重新拉配置并 RefreshSDKToken；
 * - `OnJoinMeeting` / `OnLeaveMeeting` 维护「会议中」；
 * - 其余事件留在 `events` 里供页面的诊断区查看。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { authService } from '../services/auth'
import {
  fetchWeMeetAccount,
  listenWeMeetEvent,
  wemeetBringTop,
  wemeetInit,
  wemeetIsLoggedIn,
  wemeetJoin,
  wemeetLogin,
  wemeetQuick,
  wemeetRefreshToken,
  wemeetRelease,
  wemeetShowHome,
  wemeetStatus,
  type WeMeetEvent,
} from '../services/wemeet'

export type WeMeetState = 'idle' | 'connecting' | 'ready'

/** 事件面板保留的条数 */
const MAX_EVENTS = 50

interface Waiter {
  match: (e: WeMeetEvent) => boolean
  resolve: (e: WeMeetEvent) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export const useWeMeetStore = defineStore('wemeet', () => {
  const state = ref<WeMeetState>('idle')
  const inMeeting = ref(false)
  const error = ref('')
  const events = ref<WeMeetEvent[]>([])

  let unlisten: UnlistenFn | null = null
  let connecting: Promise<void> | null = null
  let refreshingToken = false
  let waiters: Waiter[] = []

  function pushEvent(e: WeMeetEvent) {
    events.value.unshift(e)
    if (events.value.length > MAX_EVENTS) events.value.length = MAX_EVENTS
  }

  function waitEvent(
    match: (e: WeMeetEvent) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<WeMeetEvent> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (e) => {
          clearTimeout(waiter.timer)
          rejectPending(waiter)
          resolve(e)
        },
        reject,
        timer: setTimeout(() => {
          rejectPending(waiter)
          reject(new Error(`${label}超时（${timeoutMs / 1000} 秒）`))
        }, timeoutMs),
      }
      waiters.push(waiter)
    })
  }

  function rejectPending(waiter: Waiter) {
    waiters = waiters.filter((w) => w !== waiter)
  }

  function fail(e: unknown) {
    error.value = typeof e === 'string' ? e : (e as any)?.message || String(e)
    return new Error(error.value)
  }

  /** 重新拉配置并刷新 token；失败就退回 idle，下次操作重新初始化。 */
  async function onTokenExpired() {
    if (refreshingToken) return
    refreshingToken = true
    try {
      const acc = await fetchWeMeetAccount()
      await wemeetRefreshToken(acc.sdkToken)
    } catch (e) {
      state.value = 'idle'
      error.value = '会议凭证已过期且刷新失败，请重新发起会议'
      pushEvent({ func: 'Local', code: '-1', msg: `刷新 token 失败：${(e as any)?.message || e}` })
    } finally {
      refreshingToken = false
    }
  }

  function onEvent(e: WeMeetEvent) {
    pushEvent(e)
    switch (e.func) {
      case 'OnSDKTokenExpired':
        void onTokenExpired()
        break
      case 'OnSDKError':
        error.value = `会议组件异常：${e.msg || e.code}`
        break
      case 'OnJoinMeeting':
        if (e.code === '0') inMeeting.value = true
        break
      case 'OnLeaveMeeting':
        if (e.code === '0') inMeeting.value = false
        break
      case 'OnLogout':
        state.value = 'idle'
        inMeeting.value = false
        break
      default:
        break
    }
    for (const w of [...waiters]) {
      if (w.match(e)) w.resolve(e)
    }
  }

  /** 注册原生事件监听。幂等；只登记监听，不初始化 SDK。 */
  async function start() {
    if (unlisten) return
    unlisten = await listenWeMeetEvent(onEvent)
  }

  /** 退出登录 / 关闭会议时调用：停止监听并释放 SDK 进程。 */
  function stop() {
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.reject(new Error('会议已断开'))
    }
    waiters = []
    unlisten?.()
    unlisten = null
    const wasReady = state.value !== 'idle'
    state.value = 'idle'
    inMeeting.value = false
    if (wasReady) {
      // 释放失败不影响退出流程
      void wemeetRelease().catch(() => {})
    }
  }

  /** 确保 SDK 已初始化并登录；并发调用共用同一次连接。 */
  async function ensureReady(): Promise<void> {
    if (state.value === 'ready') return
    if (connecting) return connecting
    error.value = ''
    state.value = 'connecting'

    const task = (async () => {
      try {
        const acc = await fetchWeMeetAccount()

        if (!(await wemeetStatus())) {
          const initDone = waitEvent(
            (e) => e.func === 'OnSDKInitializeResult',
            30000,
            '初始化',
          )
          await wemeetInit(acc)
          const evt = await initDone
          // -1011 = 重复初始化，可继续使用
          if (evt.code !== '0' && evt.code !== '-1011') {
            throw new Error(`会议组件初始化失败：${evt.msg || evt.code}`)
          }
        }

        if (!(await wemeetIsLoggedIn())) {
          const loginDone = waitEvent((e) => e.func === 'OnLogin', 40000, '登录')
          await wemeetLogin(acc.ssoUrlPrefix + acc.idToken)
          const evt = await loginDone
          // -1012 = 已登录
          if (evt.code !== '0' && evt.code !== '-1012') {
            throw new Error(`登录会议服务失败：${evt.msg || evt.code}`)
          }
        }

        state.value = 'ready'
      } catch (e) {
        state.value = 'idle'
        throw fail(e)
      } finally {
        connecting = null
      }
    })()

    connecting = task
    return task
  }

  function displayName(): string {
    return authService.getCurrentUserName() || 'YX'
  }

  /** 打开腾讯会议会前主页（原生窗口）。 */
  async function openHome(): Promise<void> {
    await ensureReady()
    await wemeetShowHome().catch((e) => {
      throw fail(e)
    })
  }

  /** 快速会议：使用默认会议设置，进入后置顶会中窗口。 */
  async function quickMeeting(): Promise<void> {
    await ensureReady()
    await wemeetQuick('网络会议').catch((e) => {
      throw fail(e)
    })
    await wemeetBringTop().catch(() => {})
  }

  /** 加入指定会议。默认关麦克风/摄像头，与官方入会一致。 */
  async function joinMeeting(code: string): Promise<void> {
    const meetingCode = code.trim()
    if (!meetingCode) throw new Error('请填写会议号')
    await ensureReady()
    await wemeetJoin(meetingCode, displayName()).catch((e) => {
      throw fail(e)
    })
  }

  /** 把会中窗口拉到最前（会议中切回 YX 后使用）。 */
  async function bringTop(): Promise<void> {
    await wemeetBringTop().catch((e) => {
      throw fail(e)
    })
  }

  function clearError() {
    error.value = ''
  }

  return {
    state,
    inMeeting,
    error,
    events,
    start,
    stop,
    ensureReady,
    openHome,
    quickMeeting,
    joinMeeting,
    bringTop,
    clearError,
  }
})
