/**
 * IM WebSocket 客户端 —— 完整实现逆向到的协议
 * 逆向自 home.js 的 a.Init / a.Auth / a.SendMsg / a.Beat 等
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
import { DEFAULT_CONFIG, type AppConfig } from '../config'

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
  _send_times?: number
}

export interface ImAuthPayload {
  UserId: string
  DeviceName: string
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
  private beatLoss = 0
  authed = false
  /** 离线拉取：已收到消息的最小 send_time，用于续拉 */
  private earliestOfflineTime = 0
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
    const url = localStorage.getItem('embWebSocketUri') || this.config.embUrl
    this.emit({ type: 'log', data: `连接 ${url}` })
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this._connected = true
      this.beatLoss = 0
      this.emit({ type: 'open' })
      // 连接后立即鉴权
      this.auth()
    }
    ws.onerror = (ev) => {
      this.emit({ type: 'error', data: ev })
    }
    ws.onclose = (ev) => {
      this._connected = false
      this.authed = false
      this.stopBeat()
      this.emit({ type: 'close', data: { code: ev.code, reason: ev.reason } })
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
  }

  /** 鉴权 */
  auth(): void {
    const payload: ImAuthPayload = {
      UserId: authService.getCurrentUserId(),
      DeviceName: authService.getPlatform(),
      DeviceToken: authService.getDeviceId(),
      DeviceUID: authService.getDeviceId(),
      AccessToken: authService.getAccessToken(),
      Version: '5.1.9',
      displayVersion: this.config.version,
      protocolVersion: this.config.embProtocolVersion,
      batchPushOfflineMessage: true,
      Force: true,
      isFirstLogin:
        localStorage.getItem('MsgSessionIsInited') !== '1',
    }
    this.send(Cmd.uAuth, 1, payload)
  }

  /** 原始发送：组帧并发送 */
  send(command: number, operation: number = 1, data?: any): void {
    if (!this.ws || this.ws.readyState !== READY.OPEN) {
      this.emit({ type: 'log', data: 'WebSocket 未就绪，无法发送' })
      return
    }
    const frame = encodeFrame(command, operation, data)
    // 拷贝到独立 ArrayBuffer 以规避 TS 中 Uint8Array.buffer 的 SharedArrayBuffer 类型歧义
    const buf = new ArrayBuffer(frame.byteLength)
    new Uint8Array(buf).set(frame)
    this.ws.send(buf)
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
        localStorage.setItem('MsgSessionIsInited', '1')
        this.startBeat()
        // 鉴权成功后服务端会按 batchPushOfflineMessage=true 自动推送离线消息，
        // 无需主动发送 uOfflineStart（原版也不发）
        this.emit({ type: 'authed' })
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
        this.emit({ type: 'offline_end', data: { more: false } })
        break

      case Cmd.dEOFonline:
        // 离线消息还没结束：带上已收到的最早 send_time 继续拉
        this.send(Cmd.uOfflineStart, 1, {
          pageSize: 100,
          startSendTime: this.earliestOfflineTime,
        })
        this.earliestOfflineTime = 0
        this.emit({ type: 'offline_end', data: { more: true } })
        break

      case Cmd.dRefreshToken:
        // 通知刷新 token
        authService.refreshToken().then((t) => {
          if (t) this.emit({ type: 'log', data: 'Token 已刷新' })
        })
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
    // 记录离线续拉用的最早时间
    if (msg.send_time) {
      if (!this.earliestOfflineTime || msg.send_time < this.earliestOfflineTime) {
        this.earliestOfflineTime = msg.send_time
      }
    }
    // 解码 content（非发送消息回执时）
    if (msg.content) {
      let decoded = decryptContent(msg.content)
      if (!isPlainTextMsg(msg.msg_type)) {
        try {
          decoded = JSON.parse(decoded)
        } catch {
          /* 保持字符串 */
        }
      }
      msg.content = decoded
    }
    this.emit({ type: 'message', data: msg })
  }

  /** 启动心跳 */
  startBeat(): void {
    this.stopBeat()
    const interval = this.config.heartbeatInterval
    this.beatTimer = setInterval(() => {
      if (this.beatLoss > 2) {
        this.emit({ type: 'log', data: '心跳累计 3 次未收到回执，重连' })
        this.close()
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
    this.init()
  }

  /* ============ 高层消息操作 ============ */

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
  ): ImMessage {
    const msg: ImMessage = {
      msg_id: uuid(),
      msg_type: MsgType.TEXT,
      content: text,
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
    this.send(Cmd.uSendMsg, 1, msg)
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

  /** 发送离线拉取请求 */
  requestOffline(): void {
    this.send(Cmd.uOfflineStart, 1, {})
  }
}

export const imClient = new ImClient()
