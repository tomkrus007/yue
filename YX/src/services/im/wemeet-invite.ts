/**
 * 腾讯会议邀请消息。
 *
 * 逆向自官方 home.js：
 * - 主动邀请（`joinWeMeetCallback`）先发 msg_type 15 VIDEOCHAT（只用于触发邀请弹窗，
 *   官方客户端不渲染它）：
 *   `{ cmd: 0, brief: '最新会议：<标题>', contents: [{ action_param: '[OpenApp]\nappCode=linkMeeting\n...', action_type: 3, content: <标题> }] }`
 * - 随后发 msg_type 99 复杂卡片（聊天里的可回看记录）：
 *   `{ brief: '<我>邀请您加入视频会议', contents: [...], type: 3 }`，按钮动作是
 *   `[JoinWeMeet]\nmeetingCode=xxx`。
 * - 「分享到聊天」只发上面那张 99 卡片。
 *
 * 两种都归一化成 `MeetingInvite`，由 MessageContent 渲染成带「加入会议」按钮的卡片。
 */
import { instructionParams } from './card-actions'
import { MsgType } from './types'

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

/**
 * 构造 msg_type 99 会议卡片，字段与官方 `sendWemeetInviteMessage` 一致。
 * 15 只负责弹窗，这张卡片才是聊天里可回看的入口。
 */
export function videoChatCardContent(
  code: string,
  title: string,
  userName: string,
): unknown {
  const brief = `${userName}邀请您加入视频会议`
  return {
    brief,
    contents: [
      {
        action_type: 0,
        content: brief,
        display_pattern: 0,
        display_type: 0,
        font_bold: true,
      },
      {
        action_type: 0,
        content: {
          column: [
            { align: 'left', font_color: '#000000', title: '', width: 30 },
            { align: 'left', font_color: '#000000', title: '', width: 70 },
          ],
          data: [
            ['会议标题', title],
            ['会议ID', code],
          ],
        },
        display_type: 1,
      },
      {
        action_type: 0,
        content: [
          [
            {
              action_param: `[JoinWeMeet]\nmeetingCode=${code}`,
              action_type: 3,
              id: 'button-id1',
              isClickable: true,
              name: '加入会议',
            },
          ],
        ],
        display_type: 4,
      },
    ],
    invokeType: 2,
    ringLevel: 0,
    senderStyle: 0,
    type: 3,
  }
}

/** 15 与它配套的 99 卡片之间允许的时间差 */
const CARD_DEDUPE_WINDOW = 10 * 60_000

interface MeetingMessageLike {
  msg_type: number
  from_id?: string
  send_time?: number
  content: unknown
}

/**
 * 官方一次邀请会发 15（弹窗）+ 99（卡片），两条都渲染就重复了。
 * 这里把「同发送人 + 同会议号 + 时间相近」的 99 卡片过滤掉，时间线只留 15 卡片；
 * 单独的「分享到聊天」卡片没有配套 15，照常显示。
 */
export function dedupeMeetingCards<T extends MeetingMessageLike>(list: T[]): T[] {
  const invites: { from: string; code: string; time: number }[] = []
  for (const message of list) {
    if (Number(message.msg_type) !== MsgType.VIDEOCHAT) continue
    const invite = parseVideoChatInvite(message.content)
    if (invite) {
      invites.push({
        from: String(message.from_id || ''),
        code: invite.code,
        time: Number(message.send_time) || 0,
      })
    }
  }
  if (!invites.length) return list
  return list.filter((message) => {
    if (Number(message.msg_type) !== MsgType.COMPLEX) return true
    const card = parseMeetingCard(message.content)
    if (!card) return true
    const from = String(message.from_id || '')
    const time = Number(message.send_time) || 0
    return !invites.some(
      (invite) =>
        invite.from === from &&
        invite.code === card.code &&
        Math.abs(invite.time - time) <= CARD_DEDUPE_WINDOW,
    )
  })
}
