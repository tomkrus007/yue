/**
 * IM WebSocket 客户端 —— 完整实现逆向到的协议
 * 逆向自 home.js 的 a.Init / a.Auth / a.SendMsg / a.Beat 等
 *
 * 实测修正（2026-10）：
 * - 鉴权成功后要主动发 uOfflineStart 拉离线消息，不能只等服务端推送
 * - 离线游标是「已收到离线消息的 max(send_time)」，不是最早时间
 * - 101 表示还有下一批（要续拉），97 才是真正结束
 * - 收到 99（刷新 token）时换 token 后重连
 */
import { Cmd } from './cmd'
import { MsgType, FromType, isPlainTextMsg } from './types'
import {
  encodeFrame,
  decodeFrame,
  decryptContent,
  type ImFrame,
} from './protocol'
import { authService } from '../auth'
import { getServerPaths, DEFAULT_CONFIG, type AppConfig } from '../config'
import { buildMediaContent, uploadToStore } from './media'

export interface ImMessage {
  msg_id: string
  msg_type: number
  content: any
  from_id: string
  from_name: string
  from_type: number
  from_device?: string
  from_company?: string
  to_id: string
  to_name: string
  to_type: number
  to_company?: string
  to_device?: string
  send_time: number
  user_id?: string
  is_read?: number
  rec_receipt?: any
  is_delete_after_read?: boolean
  is_need_read_receipt?: boolean
  is_count_unread?: boolean
  is_need_send_read?: number
  at_user_ids?: any
  reply_msg_id?: string
  e_code?: string
  offline?: boolean
  _send_times?: number
}

export interface ImAuthPayload {
  UserId?: string
  PLATFORM: string
  DeviceToken: string
  DeviceUID: string
  AccessToken: string
  Version: string
  displayVersion: string
  protocolVersion: number
  batchPushOfflineMessage: boolean
  Force: boolean
  isFirstLogin: boolean
}

export interface ImSession {
  talk_with_id: string
  talk_with_name: string
  talk_with_type: number
  talk_with_company?: string
  unread: number
  last_msg?: ImMessage
  last_send_time?: number
}

export type ImEventType =
  | 'open'
  | 'close'
  | 'error'
  | 'authed'
  | 'message'
  | 'receipt'
  | 'session'
  | 'offline_end'
  | 'offline_more'
  | 'need_login'
  | 'state_change'
  | 'log'

export interface ImEvent {
  type: ImEventType
  data?: any
}

export type ImEventListener = (e: ImEvent) => void

const READY = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

/** 离线消息最多续拉 50 页，避免服务端异常时无限循环 */
const MAX_OFFLINE_PAGES = 50

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export class ImClient {
  config: AppConfig
  private ws: WebSocket | null = null
  private beatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private beatLoss = 0
  authed = false
  /** 离线拉取游标：已收到离线消息的 max(send_time)，0 表示从头拉 */
  private offlineCursor = 0
  private offlinePages = 0
  private reconnectAttempt = 0
  private authFailures = 0
  private manualClose = false
  private listeners = new Set<ImEventListener>()
  private _connected = false

  constructor(config: AppConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  on(fn: ImEventListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: ImEvent) {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error('IM listener error', err)
      }
    }
  }

  get connected(): boolean {
    return this._connected
  }

  getWebSocketState(): { state: number; desc: string } {
    const s = (this.ws?.readyState ?? READY.CLOSED) as number
    const desc =
      s === READY.CONNECTING
        ? 'CONNECTING'
        : s === READY.OPEN
          ? 'OPEN'
          : s === READY.CLOSING
            ? 'CLOSING'
            : 'CLOSED'
    return { state: s, desc }
  }

  /** 建立 WebSocket 连接 */
  async init(): Promise<void> {
    if (this.ws) this.close()
    this.manualClose = false
    const url = getServerPaths().embWebSocketUri
    this.emit({ type: 'log', data: `连接 ${url}` })
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this._connected = true
      this.beatLoss = 0
      this.emit({ type: 'open' })
      this.emit({ type: 'state_change', data: { state: 'connecting' } })
      // 连接后立即鉴权
      this.auth()
    }
    ws.onerror = (ev) => {
      this.emit({ type: 'error', data: ev })
    }
    ws.onclose = (ev) => {
      const wasReady = this.authed
      this._connected = false
      this.authed = false
      this.stopBeat()
      this.emit({ type: 'close', data: { code: ev.code, reason: ev.reason } })
      if (this.manualClose) return
      if (!wasReady) {
        // 鉴权没成功就断开 = token 可能失效；连续 3 次就让用户重新登录
        this.authFailures += 1
        if (this.authFailures >= 3) {
          this.emit({ type: 'need_login', data: '登录已失效，请重新登录' })
          return
        }
      }
      this.scheduleReconnect()
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
  }

  /** 鉴权 */
  auth(): void {
    const payload: ImAuthPayload = {
      PLATFORM: 'pc',
      DeviceToken: authService.getDeviceId(),
      DeviceUID: authService.getDeviceId(),
      AccessToken: authService.getAccessToken(),
      Version: '5.1.9',
      displayVersion: this.config.version,
      protocolVersion: this.config.embProtocolVersion,
      batchPushOfflineMessage: true,
      Force: true,
      isFirstLogin: false,
    }
    this.send(Cmd.uAuth, 1, payload)
  }

  /** 原始发送：组帧并发送 */
  send(command: number, operation: number = 1, data?: any): boolean {
    if (!this.ws || this.ws.readyState !== READY.OPEN) {
      this.emit({ type: 'log', data: 'WebSocket 未就绪，无法发送' })
      return false
    }
    const frame = encodeFrame(command, operation, data)
    // 拷贝到独立 ArrayBuffer 以规避 TS 中 Uint8Array.buffer 的 SharedArrayBuffer 类型歧义
    const buf = new ArrayBuffer(frame.byteLength)
    new Uint8Array(buf).set(frame)
    this.ws.send(buf)
    return true
  }

  /** 收包处理 */
  private onMessage(data: ArrayBuffer | string): void {
    if (typeof data === 'string') return
    const frame = decodeFrame(data)
    // 收到任意包：重置心跳丢失计数
    this.beatLoss = 0

    switch (frame.command) {
      case Cmd.dAuthDone:
        this.authed = true
        this.authFailures = 0
        this.reconnectAttempt = 0
        this.startBeat()
        this.emit({ type: 'authed' })
        this.emit({ type: 'state_change', data: { state: 'ready' } })
        // 主动拉离线：首次从头，之后用游标增量
        this.offlinePages = 0
        this.requestOfflinePage()
        break

      case Cmd.dBeats:
        // 心跳响应，无需处理
        break

      case Cmd.dRecMsg:
      case Cmd.uSendMsg:
        this.handleIncomingMsg(frame)
        break

      case Cmd.dSendMsg:
        // 发送消息回执
        this.emit({ type: 'receipt', data: frame.data })
        break

      case Cmd.dReadedSession:
        this.emit({ type: 'session', data: { kind: 'readed', ...frame.data } })
        break

      case Cmd.dEOFoffline:
        // 97 = 真正结束
        this.offlinePages = 0
        this.emit({ type: 'offline_end', data: { more: false } })
        break

      case Cmd.dEOFonline:
        // 101 = 还有下一批（不是结束！）
        this.offlinePages += 1
        if (this.offlinePages <= MAX_OFFLINE_PAGES) {
          this.requestOfflinePage()
          this.emit({ type: 'offline_more', data: { page: this.offlinePages } })
        } else {
          this.emit({
            type: 'log',
            data: `离线消息超过 ${MAX_OFFLINE_PAGES} 页，已停止`,
          })
          this.offlinePages = 0
          this.emit({ type: 'offline_end', data: { more: false } })
        }
        break

      case Cmd.dRefreshToken:
        // 通知刷新 token：换到之后重连一次
        authService.refreshToken().then((t) => {
          if (!t) {
            this.emit({ type: 'need_login', data: '登录已失效，请重新登录' })
            return
          }
          this.emit({ type: 'log', data: 'Token 已刷新，重连中' })
          this.manualClose = true
          this.close()
          setTimeout(() => {
            this.manualClose = false
            this.init()
          }, 200)
        })
        break

      case Cmd.dSleep:
        this.emit({ type: 'need_login', data: '登录已失效（服务端要求重新认证）' })
        break

      default:
        this.emit({
          type: 'log',
          data: `未处理命令 ${frame.command} (0x${frame.command.toString(16)})`,
        })
    }
  }

  /** 处理收到的消息 */
  private handleIncomingMsg(frame: ImFrame): void {
    if (!frame.data) return
    const msg = frame.data as ImMessage
    // 离线游标只对离线消息生效：取 max(send_time)
    if (msg.offline && msg.send_time) {
      this.offlineCursor = Math.max(this.offlineCursor, msg.send_time)
    }
    // 解码 content：WS 帧里的 content 一律是被取反编码的
    if (msg.content) {
      const raw = typeof msg.content === 'string' ? msg.content : ''
      if (raw) {
        let decoded = decryptContent(raw)
        if (!isPlainTextMsg(msg.msg_type)) {
          try {
            decoded = JSON.parse(decoded)
          } catch {
            /* 保持字符串 */
          }
        }
        msg.content = decoded
      }
    }
    this.emit({ type: 'message', data: msg })
  }

  /** 发一页离线消息请求 */
  private requestOfflinePage(): void {
    if (!this.ws || !this.authed) return
    this.send(Cmd.uOfflineStart, 1, {
      pageSize: 500,
      startSendTime: this.offlineCursor,
    })
  }

  /** 启动心跳 */
  startBeat(): void {
    this.stopBeat()
    const interval = this.config.heartbeatInterval
    this.beatTimer = setInterval(() => {
      if (!this.authed) return
      if (this.beatLoss >= 3) {
        this.emit({ type: 'log', data: '心跳累计 3 次未收到回执，重连' })
        this.manualClose = true
        this.close()
        this.manualClose = false
        this.init()
        return
      }
      this.beat()
      this.beatLoss++
    }, 1000 * interval)
  }

  stopBeat(): void {
    if (this.beatTimer) {
      clearInterval(this.beatTimer)
      this.beatTimer = null
    }
  }

  /** 发送心跳（command=6, operation=0, 无负载） */
  beat(): void {
    this.send(Cmd.uBeats, 0)
  }

  /** 关闭连接 */
  close(): void {
    this.stopBeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.authed = false
    this._connected = false
    if (this.ws) {
      try {
        this.ws.onopen = null
        this.ws.onmessage = null
        this.ws.onerror = null
        this.ws.onclose = null
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  /** 重连 */
  reconnect(): void {
    this.close()
    this.manualClose = false
    this.init()
  }

  clearSession(): void {
    this.offlineCursor = 0
    this.offlinePages = 0
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.manualClose) this.init()
    }, delay + Math.random() * 500)
  }

  /* ============ 高层消息操作 ============ */

  private baseMessage(
    msgType: number,
    content: any,
    toId: string,
    toName: string,
    toType: number,
    replyMsgId?: string,
  ): ImMessage {
    return {
      msg_id: uuid(),
      msg_type: msgType,
      content,
      from_id: authService.getCurrentUserId(),
      from_name: authService.getCurrentUserName(),
      from_type: FromType.USER,
      from_company: localStorage.getItem('CurrentECode') || '',
      from_device: authService.getDeviceId(),
      send_time: Date.now(),
      to_id: toId,
      to_name: toName,
      to_type: toType,
      to_company: '',
      is_read: 0,
      is_need_read_receipt: false,
      is_delete_after_read: false,
      is_need_send_read: 0,
      is_count_unread: true,
      reply_msg_id: replyMsgId || '',
      at_user_ids: '',
      _send_times: 1,
    }
  }

  /**
   * 发送文本消息
   * @param toId 目标 id
   * @param toName 目标名称
   * @param toType 目标类型（1用户 2群组 4部门 5服务号）
   * @param text 文本内容
   * @param replyMsgId 可选，回复的消息 id
   */
  sendText(
    toId: string,
    toName: string,
    toType: number,
    text: string,
    replyMsgId?: string,
    atUserIds: string[] = [],
  ): ImMessage {
    const msg = this.baseMessage(
      MsgType.TEXT,
      text,
      toId,
      toName,
      toType,
      replyMsgId,
    )
    msg.at_user_ids = [...new Set(atUserIds)].join(',')
    this.send(Cmd.uSendMsg, 1, msg)
    return msg
  }

  /**
   * 发送图片 / 文件：先上传到 store/putFile，再按 msg_type 2/3 发送。
   * 后缀决定类型（只有 jpg/jpeg/png/gif/bmp 算图片）。
   */
  async sendMedia(
    file: File,
    toId: string,
    toName: string,
    toType: number,
    onProgress?: (pct: number) => void,
  ): Promise<ImMessage> {
    const fileId = await uploadToStore(file, onProgress)
    const { msgType, content } = buildMediaContent(file.name, file.size, fileId)
    const msg = this.baseMessage(msgType, content, toId, toName, toType)
    this.send(Cmd.uSendMsg, 1, msg)
    return msg
  }

  /** 转发保留内容与类型，但重新生成发送者、接收者和消息编号。 */
  sendForward(toId: string, toName: string, toType: number, msgType: number, content: any): ImMessage {
    if (!this.authed) throw new Error('长连接未就绪，请稍后重试')
    const msg = this.baseMessage(msgType, JSON.parse(JSON.stringify(content)), toId, toName, toType)
    if (!this.send(Cmd.uSendMsg, 1, msg)) throw new Error('连接已断开，消息未发送')
    return msg
  }

  /** 发送已读回执 */
  sendReaded(readMsgIds: string, readMsgTypes: number, toId: string): void {
    this.send(Cmd.uReadedSession, 1, {
      readMsgIds,
      readMsgTypes,
      sendToId: toId,
    })
  }

  /** 标记会话已读 */
  markSessionRead(talkWithId: string, talkWithType: number): void {
    this.send(Cmd.uReadedSession, 1, {
      toId: talkWithId,
      toType: talkWithType,
    })
  }

  /** 手动拉取离线消息（保留给外部调用） */
  requestOffline(): void {
    this.offlinePages = 0
    this.requestOfflinePage()
  }
}

export const imClient = new ImClient()