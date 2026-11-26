/**
 * 系统通知。
 *
 * 权限只申请一次；用户拒绝后不再重复弹窗（与官方客户端一致）。
 * 通知只携带会话名、发送人和消息预览，不落盘。
 *
 * 点击通知会带着目标（会话 + 消息）回调给调用方，由它唤起窗口并定位。
 * 两个后端：
 * - 打包后的 macOS 走原生 NSUserNotificationCenter（`src-tauri/src/notifications.rs`），
 *   展示即返回，没有等待线程；
 * - dev / 其它平台走 @tauri-apps/plugin-notification，它只要存在点击监听就会给每条
 *   通知挂一个等待线程，直到用户点击或清掉通知才释放，所以这里做会话合并 + 令牌桶
 *   限流，避免消息轰炸（尤其是登录后的离线消息）时线程无限堆积。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

/** 点击通知后要定位的位置。 */
export interface NotificationTarget {
  sessionId: string
  sessionType: number
  sessionName: string
  messageId: string
}

/** 同一会话在这段时间内只弹一条，后到的消息只更新未读和预览。 */
const SESSION_MERGE_MS = 5000
/** 令牌桶：30 秒内最多 10 条，压住登录后的离线消息一次性涌入。 */
const BURST_WINDOW_MS = 30_000
const BURST_LIMIT = 10
/** id → 目标只用于兜底点击，超过这个时间就当通知已被系统回收。 */
const TARGET_TTL_MS = 30 * 60_000

let permission: Promise<boolean> | null = null

/** 首次调用时申请通知权限；后续复用结果。 */
export function ensureNotificationPermission(): Promise<boolean> {
  if (!permission) {
    permission = isPermissionGranted()
      .then((granted) => (granted ? true : requestPermission().then((result) => result === 'granted')))
      .catch(() => {
        // 申请过程异常时允许下次重试，权限被拒则保持缓存避免反复弹窗。
        permission = null
        return false
      })
  }
  return permission
}

let nextId = 1
/** 通知 id → 目标的 JSON，只给插件的点击回调查。 */
const pending = new Map<number, { key: string; at: number }>()
const lastSentAt = new Map<string, number>()
let tokens = BURST_LIMIT
let tokenAt = Date.now()

function takeToken(now: number): boolean {
  tokens = Math.min(BURST_LIMIT, tokens + ((now - tokenAt) * BURST_LIMIT) / BURST_WINDOW_MS)
  tokenAt = now
  if (tokens < 1) return false
  tokens -= 1
  return true
}

/** 清掉过期映射：通知已经被系统回收，不会再有点击回调。 */
function prunePending(now: number): void {
  for (const [id, entry] of pending) {
    if (now - entry.at > TARGET_TTL_MS) pending.delete(id)
  }
}

function parseTarget(key: string | null | undefined): NotificationTarget | null {
  if (!key) return null
  try {
    const value = JSON.parse(key) as Partial<NotificationTarget>
    if (typeof value.sessionId !== 'string' || !value.sessionId) return null
    return {
      sessionId: value.sessionId,
      sessionType: Number(value.sessionType) || 1,
      sessionName: typeof value.sessionName === 'string' && value.sessionName ? value.sessionName : value.sessionId,
      messageId: typeof value.messageId === 'string' ? value.messageId : '',
    }
  } catch {
    return null
  }
}

type ClickHandler = (target: NotificationTarget | null) => void
let clickHandler: ClickHandler | null = null
let listening = false

function dispatchClick(key: string | null): void {
  clickHandler?.(parseTarget(key))
}

/**
 * 注册通知点击监听，只需调用一次。
 * 找不到目标时也会回调一次 null：调用方至少把窗口带到前台。
 */
export function initNotificationClick(handler: ClickHandler): void {
  clickHandler = handler
  if (listening) return
  listening = true
  // 原生后端（打包后的 macOS）：点击由 Rust 的 delegate 转成事件。
  void listen<string>('notification-click', (event) => { dispatchClick(event.payload) }).catch(() => {})
  // 插件后端（dev / 非 macOS）：点击走插件的 tap 动作。
  void onAction((event) => {
    if (event.actionId !== 'tap') return
    const id = event.notification?.id
    const entry = typeof id === 'number' ? pending.get(id) : undefined
    if (typeof id === 'number') pending.delete(id)
    dispatchClick(entry?.key ?? null)
  }).catch(() => {
    // 注册失败允许下次重试（比如插件还没就绪）。
    listening = false
  })
}

/** 把主窗口从隐藏/最小化状态带回前台并聚焦。 */
export async function showMainWindow(): Promise<void> {
  try {
    await invoke('show_main_window')
  } catch {
    /* 窗口已经在前台时可能失败，忽略 */
  }
}

/** 打包后的 .app 才有 bundle id；dev 二进制通知中心不投递，退回插件。 */
let nativeAvailable = !import.meta.env.DEV

async function deliver(
  title: string,
  body: string,
  key: string | null,
  id: number | undefined,
): Promise<void> {
  const safeTitle = title || 'YX'
  const safeBody = body.slice(0, 240)
  if (nativeAvailable) {
    try {
      await invoke('notify_message', { title: safeTitle, body: safeBody, key })
      return
    } catch {
      // 非 macOS 或原生后端不可用：退回插件，避免整条链路失效。
      nativeAvailable = false
    }
  }
  try {
    sendNotification({
      ...(id === undefined ? {} : { id }),
      title: safeTitle,
      body: safeBody,
      group: 'yx-messages',
    })
  } catch {
    /* 通知失败不影响聊天 */
  }
}

/** 发送一条系统通知；没有权限或平台不支持时静默跳过。 */
export async function notifyMessage(
  title: string,
  body: string,
  target?: NotificationTarget,
): Promise<void> {
  if (!title && !body) return
  if (!(await ensureNotificationPermission())) return
  const now = Date.now()
  let id: number | undefined
  let key: string | null = null
  if (target) {
    if (now - (lastSentAt.get(target.sessionId) ?? 0) < SESSION_MERGE_MS) return
    if (!takeToken(now)) return
    lastSentAt.set(target.sessionId, now)
    prunePending(now)
    key = JSON.stringify(target)
    id = nextId
    nextId = nextId >= 2147483647 ? 1 : nextId + 1
    pending.set(id, { key, at: now })
  }
  await deliver(title, body, key, id)
}
