/**
 * 服务端点配置 —— 逆向自 web/config.json
 * 运行时可被配置中心覆盖（暂未实现配置中心拉取）
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
  heartbeatInterval: 30,
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
} as const
