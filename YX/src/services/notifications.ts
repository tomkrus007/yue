/**
 * macOS 系统通知。
 *
 * 权限只申请一次；用户拒绝后不再重复弹窗（与官方客户端一致）。
 * 通知只携带会话名、发送人和消息预览，不落盘。
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

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

/** 发送一条系统通知；没有权限或平台不支持时静默跳过。 */
export async function notifyMessage(title: string, body: string): Promise<void> {
  if (!title && !body) return
  if (!(await ensureNotificationPermission())) return
  try {
    sendNotification({
      title: title || 'YX',
      body: body.slice(0, 240),
      group: 'yx-messages',
    })
  } catch {
    /* 通知失败不影响聊天 */
  }
}
