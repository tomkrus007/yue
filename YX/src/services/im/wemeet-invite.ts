/**
 * 腾讯会议邀请消息。
 *
 * 逆向自官方 home.js：
 * - 主动邀请（`joinWeMeetCallback`）发 msg_type 15 VIDEOCHAT：
 *   `{ cmd: 0, brief: '最新会议：<标题>', contents: [{ action_param: '[OpenApp]\nappCode=linkMeeting\n...', action_type: 3, content: <标题> }] }`
 * - 「分享到聊天」发 msg_type 99 复杂卡片，按钮动作是 `[JoinWeMeet]\nmeetingCode=xxx`。
 *
 * 两种都归一化成 `MeetingInvite`，由 MessageContent 渲染成带「加入会议」按钮的卡片。
 */
import { instructionParams } from './card-actions'

export interface MeetingInvite {
  code: string
  title: string
  /** 会议号等补充信息，作为卡片副标题 */
  detail: string
}

function asObject(content: unknown): any {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content)
    } catch {
      return null
    }
  }
  return content && typeof content === 'object' ? content : null
}

function meetingParams(action: string): Record<string, string> {
  return instructionParams(action.replace(/^\[[^\]]+\]/, '\n'))
}

/** 解析 msg_type 15 的腾讯会议邀请；不是会议邀请时返回 null。 */
export function parseVideoChatInvite(content: unknown): MeetingInvite | null {
  const c = asObject(content)
  if (!c || !Array.isArray(c.contents)) return null
  const action = c.contents
    .map((item: any) => (typeof item?.action_param === 'string' ? item.action_param : ''))
    .find((item: string) => item.includes('appCode=linkMeeting'))
  if (!action) return null
  const params = meetingParams(action)
  if (params.appCode !== 'linkMeeting' || params.supplier !== 'tencent') return null
  const code = (params.meetingCode || '').trim()
  if (!code) return null
  const title = (params.title || '').trim() || String(c.brief || '').trim() || '视频会议'
  return { code, title, detail: `会议号 ${code}` }
}

/** 解析官方「分享到聊天」发出的 99/type=3 会议卡片（按钮动作 `[JoinWeMeet]`）。 */
export function parseMeetingCard(content: unknown): MeetingInvite | null {
  const c = asObject(content)
  if (!c || Number(c.type) !== 3 || !Array.isArray(c.contents)) return null
  let action = ''
  const details: string[] = []
  for (const item of c.contents) {
    if (typeof item?.action_param === 'string' && item.action_param.includes('[JoinWeMeet]')) action = item.action_param
    // display_type=1 是两列表格：会议标题 / 会议ID
    if (item?.display_type === 1 && Array.isArray(item.content?.data)) {
      for (const row of item.content.data) {
        if (Array.isArray(row) && row.length >= 2 && row[0]) details.push(`${row[0]}：${row[1] ?? ''}`)
      }
    }
    // display_type=4 是按钮行，形如 [[{ action_param, name, ... }]]
    if (Array.isArray(item?.content)) {
      for (const row of item.content) {
        if (!Array.isArray(row)) continue
        for (const button of row) {
          if (typeof button?.action_param === 'string' && button.action_param.includes('[JoinWeMeet]')) action = button.action_param
        }
      }
    }
  }
  if (!action) return null
  const code = (meetingParams(action).meetingCode || '').trim()
  if (!code) return null
  return {
    code,
    title: String(c.brief || '').trim() || '视频会议',
    detail: details.join(' · ') || `会议号 ${code}`,
  }
}

/** 构造 msg_type 15 邀请内容，字段与官方 `joinWeMeetCallback` 一致。 */
export function videoChatInviteContent(
  code: string,
  title: string,
  userId: string,
  userName: string,
): unknown {
  return {
    cmd: 0, // VIDEOCHAT_CMD.INVITE
    brief: `最新会议：${title}`,
    contents: [
      {
        action_param: [
          '[OpenApp]',
          'appCode=linkMeeting',
          'supplier=tencent',
          `controlUserID=${userId}`,
          `meetingCode=${code}`,
          `title=${title}`,
          `fromId=${userId}`,
          `fromName=${userName}`,
        ].join('\n'),
        action_type: 3,
        content: title,
      },
    ],
  }
}
