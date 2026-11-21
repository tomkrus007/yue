/**
 * 服务端点配置 —— 逆向自 web/config.json
 * 登录时优先从配置中心拉取真实地址，失败时回落到这里的默认值。
 */

export interface AppConfig {
  /** 用户中心 */
  uamUrl: string
  /** WebOS */
  webosUrl: string
  /** Web 资源 */
  webUrl: string
  /** SSO 单点登录 */
  ssoUrl: string
  /** 应用商店 */
  storeUrl: string
  /** ★ IM WebSocket 地址 */
  embUrl: string
  /** 动态 */
  dynamicUrl: string
  /** 配置中心 */
  microServiceUrl: string
  /** 配置中心 Basic Auth（用户名:密码） */
  microServiceAuth: string
  /** ★ 网盘 Drive */
  diskDriveUrl: string
  /** ★ 网盘 OpenAPI */
  diskOpenApiUrl: string
  /** ★ 用户中心 API（联系人/好友/群组），结尾无斜杠 */
  uamApiUrl: string
  /** IM HTTP API */
  embHttpUrl: string
  /** IM 历史查询 API */
  embQueryUrl: string
  /** 对象存储 */
  storeUrlBase: string
  /** 日程 */
  scheduleUrl: string
  /** 升级检查 */
  updateCheckUrl: string
  /** OAuth2 客户端 */
  clientId: string
  clientSecret: string
  /** 登录名后缀 */
  loginNameSuffix: string
  /** RSA 公钥（密码加密） */
  rsaPublicKey: string
  /** 网盘 appId */
  diskAppId: string
  /** IM 协议版本 */
  embProtocolVersion: number
  /** 客户端版本 */
  version: string
  /** callAjax 用的 version 头 */
  version2: string
  /** IM 心跳间隔（秒） */
  heartbeatInterval: number
}

export const DEFAULT_CONFIG: AppConfig = {
  uamUrl: 'https://yxgroupuam.bingolink.biz/uam/',
  webosUrl: 'https://www.bingolink.biz/webos/',
  webUrl: 'https://yxgroup.bingolink.biz/web/',
  ssoUrl: 'https://www.bingolink.biz/sso',
  storeUrl: 'https://yxgroupstore.bingolink.biz/store',
  /** IM WebSocket（配置中心下发，真实值；config.json 里的 ws://msg... 只是兜底） */
  embUrl: 'wss://yxgroupembwss.bingolink.biz',
  dynamicUrl: 'https://yxgroup.bingolink.biz/blogapi/',
  /** 配置中心（登录前后都可拉取，可覆盖以下端点） */
  microServiceUrl:
    'https://config.bingolink.biz/config/server/configs/yuexiu',
  microServiceAuth: 'lconfig:config$$2018Link',
  /** ★ 网盘 Drive */
  diskDriveUrl: 'https://pan.bingolink.biz/drive',
  /** ★ 网盘 OpenAPI */
  diskOpenApiUrl: 'https://streamapi.bingolink.biz/openapi',
  /** ★ 用户中心 API——联系人/好友/群组 */
  uamApiUrl: 'https://yxgroup.bingolink.biz/uamapi',
  /** IM HTTP（消息历史等） */
  embHttpUrl: 'https://yxgroupemb.bingolink.biz',
  /** IM 历史查询（实测：embquery 域名） */
  embQueryUrl: 'https://embquery.bingolink.biz/embquery',
  /** 对象存储（聊天附件） */
  storeUrlBase: 'https://yxgroupstore.bingolink.biz/store/',
  scheduleUrl: 'https://www.bingolink.biz/linkweb/todo.html',
  updateCheckUrl: 'https://vrmapi.bingolink.biz/vrm/yuexiunew/check',
  clientId: 'link_desktop',
  clientSecret: 'bGlua19jbGllbnRfc2VjcmV1',
  loginNameSuffix: '@yuexiu',
  rsaPublicKey:
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCDqDV9+DSIDSHT8J4pUYzuDpgk2Sn5bGDi/N0I1Ctmn9x38L5VVBJWj8FP9ZK6vvCqrbkcH3pGl7TiVcBbxdbkNKSoYSh8ViWpxCIm0Xc+c4AYNsnKbIgjFT83Xjkh4Oa2uQgiqiLI8BRXHABqyIzO+XD+OJjmZnV4SZ4CANlEAwIDAQAB',
  diskAppId: 'BingoCloudDisk',
  embProtocolVersion: 2.8,
  version: '5.2.97',
  version2: '5.2.4',
  heartbeatInterval: 25,
}

/**
 * 配置中心下发的服务地址表（只列用到的）。
 * 键名与官方 localStorage 一致，便于和抓包结果对照。
 */
export interface ServerPaths {
  /** 仅用于覆盖 ssoUrl */
  ssoUri?: string
  embWebSocketUri?: string
  embHttpUri?: string
  embQueryUri?: string
  uamApiUri?: string
  storeUri?: string
  panServerUri?: string
  panDocUri?: string
  taskUri?: string
  appApiUri?: string
  serviceNoUri?: string
  toDoUri?: string
  [key: string]: unknown
}

export const SERVER_PATHS_KEY = 'serverPaths'

/** 读取运行时服务地址：配置中心结果 > 手工 localStorage 覆盖 > 内置默认。 */
export function getServerPaths(): Required<
  Pick<
    ServerPaths,
    | 'ssoUri'
    | 'embWebSocketUri'
    | 'embHttpUri'
    | 'embQueryUri'
    | 'uamApiUri'
    | 'storeUri'
  >
> &
  ServerPaths {
  let saved: ServerPaths = {}
  try {
    saved = JSON.parse(localStorage.getItem(SERVER_PATHS_KEY) || '{}') || {}
  } catch {
    saved = {}
  }
  return {
    ...saved,
    ssoUri:
      localStorage.getItem('ssoUrl') ||
      saved.ssoUri ||
      DEFAULT_CONFIG.ssoUrl,
    embWebSocketUri: saved.embWebSocketUri || DEFAULT_CONFIG.embUrl,
    embHttpUri: saved.embHttpUri || DEFAULT_CONFIG.embHttpUrl,
    embQueryUri: saved.embQueryUri || DEFAULT_CONFIG.embQueryUrl,
    uamApiUri: saved.uamApiUri || DEFAULT_CONFIG.uamApiUrl,
    storeUri: saved.storeUri || DEFAULT_CONFIG.storeUrlBase,
    toDoUri: saved.toDoUri || 'https://gw.yuexiu.com/todosrvapi',
  }
}

export function saveServerPaths(paths: ServerPaths): void {
  localStorage.setItem(SERVER_PATHS_KEY, JSON.stringify(paths || {}))
}

/** localStorage 键 */
export const STORAGE_KEYS = {
  accessToken: 'AccessToken',
  authAccessToken: 'auth_accessToken',
  refreshToken: 'refresh_token',
  currentUserId: 'CurrentUserId',
  currentUserName: 'CurrentUserName',
  deviceId: 'DeviceId',
  loginId: 'LoginId',
  expiresAt: 'expires_at',
  imSessions: 'yl.im.sessions',
  imHiddenSessions: 'yl.im.hiddenSessions',
  imSessionBoosts: 'yl.im.sessionBoosts',
  imMessages: 'yl.im.messages',
  imUnread: 'yl.im.unread',
  imUnreadAt: 'yl.im.unreadAt',
  imUnreadIds: 'yl.im.unreadIds',
  imFolded: 'yl.im.folded',
  imMuted: 'yl.im.muted',
  imGroupMeta: 'yl.im.groupMeta',
  imLeftGroups: 'yl.im.leftGroups',
  imTab: 'yl.im.tab',
  savedCreds: 'yl.creds',
} as const
