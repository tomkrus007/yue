/**
 * 云上越秀 IM 协议 —— 命令码表
 * 逆向自 home.7717570b45127039f907.js 的 v 对象
 */
export enum Cmd {
  /** ↑ 心跳 */
  uBeats = 6,
  /** ↓ 心跳响应 */
  dBeats = 16,
  /** ↑ 登出 */
  uLogout = 7,
  /** ↓ 登出回执 */
  dLogout = 8,
  /** ↑ 鉴权（连接后首包） */
  uAuth = 11,
  /** ↓ 鉴权成功 */
  dAuthDone = 200,
  /** ↑ 上报在线状态 */
  uOnlineStatus = 24,
  /** ↓ 在线状态推送 */
  dOnlineStatus = 25,
  /** ↑ 订阅他人在线状态 */
  uListenOnlineStatus = 26,
  /** ↓ 订阅结果推送 */
  dListenOnlineStatus = 27,
  /** ↓ 设备信息 */
  dDevice = 201,
  /** ↓ 通知刷新 Token */
  dRefreshToken = 99,
  /** ↓ 进入休眠 */
  dSleep = 100,
  /** ↓ 接收消息 / ↑ 发送消息回执 */
  dSendMsg = 13,
  uRecMsg = 13,
  /** ↑/↓ 收发消息（双向同码） */
  uSendMsg = 3,
  dRecMsg = 3,
  /** ↓ 会话已读 */
  dReadedSession = 14,
  /** ↑ 标记会话已读 */
  uReadedSession = 19,
  /** ↓ 离线消息拉取结束 */
  dEOFoffline = 97,
  /** ↓ 在线消息结束（仍有更多） */
  dEOFonline = 101,
  /** ↑ 启动离线消息拉取 */
  uOfflineStart = 102,
  /** ↑ 会话游标 */
  uSessionCursor = 105,
  /** ↓ 会话游标响应 */
  dSessionCursor = 106,
  /** ↑ 错误上报 */
  uError = 98,
}

export const CMD_NAMES: Record<number, string> = {
  [Cmd.uBeats]: 'uBeats',
  [Cmd.dBeats]: 'dBeats',
  [Cmd.uLogout]: 'uLogout',
  [Cmd.dLogout]: 'dLogout',
  [Cmd.uAuth]: 'uAuth',
  [Cmd.dAuthDone]: 'dAuthDone',
  [Cmd.uOnlineStatus]: 'uOnlineStatus',
  [Cmd.dOnlineStatus]: 'dOnlineStatus',
  [Cmd.uListenOnlineStatus]: 'uListenOnlineStatus',
  [Cmd.dListenOnlineStatus]: 'dListenOnlineStatus',
  [Cmd.dDevice]: 'dDevice',
  [Cmd.dRefreshToken]: 'dRefreshToken',
  [Cmd.dSleep]: 'dSleep',
  [Cmd.dSendMsg]: 'dSendMsg',
  [Cmd.uSendMsg]: 'uSendMsg',
  [Cmd.dReadedSession]: 'dReadedSession',
  [Cmd.uReadedSession]: 'uReadedSession',
  [Cmd.dEOFoffline]: 'dEOFoffline',
  [Cmd.dEOFonline]: 'dEOFonline',
  [Cmd.uOfflineStart]: 'uOfflineStart',
  [Cmd.uSessionCursor]: 'uSessionCursor',
  [Cmd.dSessionCursor]: 'dSessionCursor',
  [Cmd.uError]: 'uError',
}
