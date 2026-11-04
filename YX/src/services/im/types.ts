/**
 * 消息类型 / 会话对象类型 —— 逆向自 home.js MSG_TYPE / FROM_TYPE
 */

/** 消息类型 MSG_TYPE */
export enum MsgType {
  CTRL = 0,
  TEXT = 1,
  PHOTO = 2,
  FILE = 3,
  AUDIO = 4,
  VEDIO = 5,
  VOICE = 6,
  ADDRESS = 7,
  EVENT = 8,
  SHARE = 10,
  SERVICE = 11,
  BULLETIN = 12,
  DISKSHARE = 14,
  VIDEOCHAT = 15,
  WINDOWSHAKE = 16,
  GUISE = 17,
  HONGBAO = 18,
  CARD = 19,
  REALTIMEADDR = 20,
  SCHEDULE = 21,
  VOICECHAT = 22,
  BIGVIDEO = 23,
  COMBINE = 24,
  FILEONLINE = 25,
  GENERALDEAL = 26,
  ADAPTIVECAED = 27,
  EMOJI = 28,
  TEMPLATECARD = 29,
  NEWDISKSHARE = 30,
  NOTICE = 31,
  RECALL = 66,
  ADMINRECALL = 67,
  READED = 95,
  RICHTEXT = 96,
  RECEIPT = 97,
  COMPLEX = 99,
  ASCTRL = 999,
  NOSUPPORT = 901117,
}

/** 会话/对象来源类型 FROM_TYPE */
export enum FromType {
  SYSTEM = 0,
  USER = 1,
  GROUP = 2,
  ORGANIZTION = 4,
  PUBLICACCOUNT = 5,
  ROBOT = 7,
  WORKMAIN = 8,
  AI = 9,
}

export const MSG_TYPE_LABEL: Record<number, string> = {
  [MsgType.TEXT]: '文本',
  [MsgType.PHOTO]: '图片',
  [MsgType.FILE]: '文件',
  [MsgType.AUDIO]: '音频',
  [MsgType.VEDIO]: '视频',
  [MsgType.VOICE]: '语音',
  [MsgType.SHARE]: '分享',
  [MsgType.SERVICE]: '服务号',
  [MsgType.BULLETIN]: '公告',
  [MsgType.DISKSHARE]: '云盘分享',
  [MsgType.NEWDISKSHARE]: '云盘分享',
  [MsgType.VIDEOCHAT]: '视频通话',
  [MsgType.WINDOWSHAKE]: '抖动',
  [MsgType.CARD]: '名片',
  [MsgType.BIGVIDEO]: '大视频',
  [MsgType.COMBINE]: '合并消息',
  [MsgType.RICHTEXT]: '富文本',
  [MsgType.COMPLEX]: '复合消息',
  [MsgType.RECALL]: '撤回',
  [MsgType.ADMINRECALL]: '管理员撤回',
  [MsgType.EMOJI]: '表情',
}

export const FROM_TYPE_LABEL: Record<number, string> = {
  [FromType.SYSTEM]: '系统',
  [FromType.USER]: '用户',
  [FromType.GROUP]: '群组',
  [FromType.ORGANIZTION]: '部门',
  [FromType.PUBLICACCOUNT]: '服务号',
  [FromType.ROBOT]: '机器人',
  [FromType.WORKMAIN]: '事务',
  [FromType.AI]: 'AI',
}

/** 文件类消息（需要走文件传输） */
export const FILE_MSG_TYPES = [
  MsgType.PHOTO,
  MsgType.FILE,
  MsgType.AUDIO,
  MsgType.VEDIO,
  MsgType.VOICE,
  MsgType.BIGVIDEO,
  MsgType.DISKSHARE,
  MsgType.NEWDISKSHARE,
]

/** 纯文本类消息（content 不 JSON.parse） */
export const PLAIN_TEXT_MSG_TYPES = [
  MsgType.TEXT,
  MsgType.RECALL,
  MsgType.WINDOWSHAKE,
  MsgType.ASCTRL,
]

export function isFileMsg(t: number): boolean {
  return FILE_MSG_TYPES.includes(t)
}
export function isPlainTextMsg(t: number): boolean {
  return PLAIN_TEXT_MSG_TYPES.includes(t)
}
