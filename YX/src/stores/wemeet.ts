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
import { videoChatCardContent, videoChatInviteContent } from '../services/im/wemeet-invite'
import { MsgType } from '../services/im/types'
import { useImStore } from './im'
import {
  fetchWeMeetAccount,
  listenWeMeetEvent,
  wemeetBringTop,
  wemeetComponentStatus,
  wemeetEnableRing,
  wemeetInit,
  wemeetIsLoggedIn,
  wemeetJoin,
  wemeetLogin,
  wemeetPurgeCache,
  wemeetQuick,
  wemeetRefreshToken,
  wemeetRelease,
  wemeetShowHome,
  wemeetStatus,
  type WeMeetComponentStatus,
  type WeMeetEvent,
} from '../services/wemeet'

export type WeMeetState = 'idle' | 'connecting' | 'ready'

/** 事件面板保留的条数 */
const MAX_EVENTS = 50
/** 响铃邀请开关（localStorage 持久化，默认开） */
const RING_KEY = 'wemeet_ring_invitation'

interface Waiter {
  match: (e: WeMeetEvent) => boolean
  resolve: (e: WeMeetEvent) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export const useWeMeetStore = defineStore('wemeet', () => {
  const state = ref<WeMeetState>('idle')
  const inMeeting = ref(false)
  /** 当前会议号（OnJoinMeeting 回调带回），用于发送邀请 */
  const meetingCode = ref('')
  /** 响铃邀请：开启后 SDK 自己弹接听窗口，不受 IM 连接影响 */
  const ringEnabled = ref(localStorage.getItem(RING_KEY) !== '0')
  const error = ref('')
  const events = ref<WeMeetEvent[]>([])
  /** 组件安装情况；null 表示还没查过 */
  const component = ref<WeMeetComponentStatus | null>(null)

  let unlisten: UnlistenFn | null = null
  let connecting: Promise<void> | null = null
  let refreshingToken = false
  let waiters: Waiter[] = []
  /** 当前 SDK 登录的账号；退出登录时按它清理缓存 */
  let sessionUserId = ''

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
        if (e.code === '0') {
          inMeeting.value = true
          // 快速会议只有回调里才有会议号，邀请要用它
          if (e.param) meetingCode.value = e.param
        }
        break
      case 'OnLeaveMeeting':
        if (e.code === '0') {
          inMeeting.value = false
          meetingCode.value = ''
        }
        break
      case 'OnLogout':
        state.value = 'idle'
        inMeeting.value = false
        meetingCode.value = ''
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
    void refreshComponent()
  }

  /** 刷新组件状态；失败不写入 wemeet.error（只影响状态展示）。 */
  async function refreshComponent() {
    try {
      component.value = await wemeetComponentStatus()
    } catch (e) {
      component.value = {
        state: 'absent',
        version: null,
        path: null,
        error: (e as any)?.message || String(e),
      }
    }
  }

  /** 退出登录 / 关闭会议时调用：停止监听并释放 SDK 进程。 */
  function stop(purgeCache = false) {
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.reject(new Error('会议已断开'))
    }
    waiters = []
    unlisten?.()
    unlisten = null
    const wasReady = state.value !== 'idle'
    const uid = sessionUserId
    sessionUserId = ''
    state.value = 'idle'
    inMeeting.value = false
    meetingCode.value = ''
    if (wasReady) {
      // 释放失败不影响退出流程；缓存要等 SDK 真正退出后再删
      void wemeetRelease()
        .catch(() => {})
        .then(() => (purgeCache && uid ? wemeetPurgeCache(uid) : Promise.resolve()))
        .catch(() => {})
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
        const uid = authService.getCurrentUserId() || ''

        if (!(await wemeetStatus())) {
          const initDone = waitEvent(
            (e) => e.func === 'OnSDKInitializeResult',
            30000,
            '初始化',
          )
          await wemeetInit(acc, uid)
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

        sessionUserId = uid
        // 响铃是进程级设置，每次连上都重新下发；失败不影响正常入会
        await wemeetEnableRing(ringEnabled.value).catch(() => {})
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
    const target = code.trim()
    if (!target) throw new Error('请填写会议号')
    await ensureReady()
    await wemeetJoin(target, displayName()).catch((e) => {
      throw fail(e)
    })
  }

  /** 逐个发送 msg_type 15 会议邀请，返回实际发送条数。 */
  function sendInvites(invitees: { id: string; name: string }[], code: string): number {
    const im = useImStore()
    const meId = authService.getCurrentUserId()
    const meName = displayName()
    const title = `${meName}发起的视频会议`
    let sent = 0
    for (const item of invitees) {
      const id = String(item.id || '').trim()
      if (!id || id === meId) continue
      im.sendStructured(
        { id, name: item.name || id, type: 1 },
        MsgType.VIDEOCHAT,
        videoChatInviteContent(code, title, meId, meName),
      )
      // 官方同样再发一条 99 卡片，作为聊天里可回看的入口；
      // 15 已经送达（弹窗），卡片失败不回滚、也不计入失败
      try {
        im.sendStructured(
          { id, name: item.name || id, type: 1 },
          MsgType.COMPLEX,
          videoChatCardContent(code, title, meName),
        )
      } catch {
        /* 连接在两条消息之间断开时，保留已经发出的 15 */
      }
      sent++
    }
    return sent
  }

  /**
   * 快速会议 → 等 `OnJoinMeeting` 拿到会议号 → 给选中的人发邀请。
   * 与官方 `joinWeMeetCallback` 的流程一致。
   */
  async function startMeetingAndInvite(
    invitees: { id: string; name: string }[],
  ): Promise<{ code: string; sent: number }> {
    await ensureReady()
    const joined = waitEvent((e) => e.func === 'OnJoinMeeting', 60000, '发起会议')
    // 提前失败（quick 调用抛错）时 joined 不会被 await，先挂个兜底避免未处理拒绝
    joined.catch(() => {})
    await wemeetQuick('网络会议').catch((e) => {
      throw fail(e)
    })
    const evt = await joined
    if (evt.code !== '0') throw fail(`发起会议失败：${evt.msg || evt.code}`)
    const code = (evt.param || '').trim()
    meetingCode.value = code
    await wemeetBringTop().catch(() => {})
    if (!code) throw fail('会议已开始，但没拿到会议号，邀请未发送')
    return { code, sent: sendInvites(invitees, code) }
  }

  /** 向指定同事发送当前会议的邀请；返回发送条数。 */
  async function inviteToMeeting(invitees: { id: string; name: string }[]): Promise<number> {
    const code = meetingCode.value
    if (!code) throw new Error('还没有会议号：先发起会议，再邀请同事')
    return sendInvites(invitees, code)
  }

  /** 把会中窗口拉到最前（会议中切回 YX 后使用）。 */
  async function bringTop(): Promise<void> {
    await wemeetBringTop().catch((e) => {
      throw fail(e)
    })
  }

  /** 切换响铃邀请：已连接时立即生效，否则记下设置、下次登录生效。 */
  async function setRingEnabled(value: boolean): Promise<void> {
    ringEnabled.value = value
    localStorage.setItem(RING_KEY, value ? '1' : '0')
    if (state.value === 'ready') {
      await wemeetEnableRing(value).catch((e) => {
        throw fail(e)
      })
    }
  }

  function clearError() {
    error.value = ''
  }

  return {
    state,
    inMeeting,
    meetingCode,
    ringEnabled,
    error,
    events,
    component,
    start,
    stop,
    refreshComponent,
    ensureReady,
    openHome,
    quickMeeting,
    joinMeeting,
    startMeetingAndInvite,
    inviteToMeeting,
    bringTop,
    setRingEnabled,
    clearError,
  }
})
