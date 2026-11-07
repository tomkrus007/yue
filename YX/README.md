# YX

云上越秀（品高 BingoLink）桌面端的 IM 通信 + 云盘功能复刻客户端。

- **技术栈**：Tauri v2 + Vue 3 + TypeScript + Pinia + Vue Router
- **目标服务端**：直连真实越秀生产环境（纯客户端，不自建服务端）
  - IM：配置中心下发的 `embWebSocketUri`（生产为 `wss://…:443`）
  - 网盘：`https://streamapi.bingolink.biz/openapi`
  - 登录：`https://www.bingolink.biz/sso/oauth2/token`（OAuth2 password 模式 + RSA 密码加密）
- **不复刻**：视频会议、日程、红包等重业务；零信任不自研隧道，只驱动本机官方零信任客户端的登录接口

## 功能范围

### IM 通信
- OAuth2 登录 → 配置中心 → WebSocket 连接 → 鉴权（Cmd.uAuth=11）
- 心跳保活（Cmd.uBeats=6 / dBeats=16，30 秒间隔，3 次丢失重连）
- 收发文本 / 图片 / 文件消息（Cmd.uSendMsg=3 / dRecMsg=3）
- 附件上传 `store/putFile`，支持多选、粘贴、拖拽；图片内联显示
- 离线消息拉取（Cmd.uOfflineStart=102 / dEOFoffline=97 / dEOFonline=101）
- 历史消息（`get/history/date`）与继续往前翻页
- REST 会话列表（`emb/sessions/latest`）、未读数、置顶、折叠、免打扰
- 富文本 / 复杂消息 / 合并转发的文本与 HTML 白名单渲染
- 会话已读回执（Cmd.uReadedSession=19）
- Token 刷新通知（Cmd.dRefreshToken=99）
- 自定义二进制帧协议（非 protobuf）
- 内容"加密"：按位取反 + Base64（伪加密，已还原）
- 记住密码 / 自动登录（Base64 混淆，不是加密）

### 扩展面板
- 我的应用（`appApiUri/es/authorized`，含图标）
- 团队任务（`taskUri`，团队群 → 分组 → 任务树）
- 团队文档（品高云盘目录、上传、下载、预览、在线编辑、删除）
- 仅 `templateCode = workGroupDefault` 的团队群显示任务/文档抽屉

### 零信任
- 用当前云上越秀 AccessToken 调本机官方客户端 SDK（`127.0.0.1:35440-35443/trustagent`）完成登录
- 展示状态（online/offline）、网关认证方式（YX_TOKEN / AD / LOCAL_UP），支持注销
- 按需启动：平时不驻留，点登录才拉起官方客户端进程，注销即退出（`launchctl kickstart` 失败时直接 spawn 二进制兜底）
- 隧道与内网路由由官方客户端负责；与 Clash 共存需删掉零信任抢占的默认路由（页面内有命令）
- 不自研隧道、不做系统级 DNS/路由注入

#### 按需启动

`YX` 只在点击「用登录态登录零信任」时拉起官方客户端，注销时 `bootout` 用户级 agent 并结束进程。

只有 SDK 的 plist 需要手工改一次（root 所有，客户端不会覆盖）：

```bash
sudo /usr/libexec/PlistBuddy -c "Set :RunAtLoad false" -c "Set :KeepAlive false" \
  /Library/LaunchAgents/com.legendsec.trustagentsdk.plist
```

`trustagentservice`、`trustdservice` 的 plist 会被客户端每次启动时改回 `RunAtLoad`/`KeepAlive=true`，
改了也会被还原；`YX` 注销时用 `launchctl bootout` 解除用户级任务，所以不依赖改这两个文件。
`trustdservice` 是 root 守护进程，要彻底停住（重启前）需手工执行：

```bash
sudo launchctl bootout system/com.legendsec.trustdservice
```

另外在「系统设置 → 通用 → 登录项」里关掉 `TrustAgentLauncher` 的开机自启。
`jobblesshelper` / `trustuninstall` 平时不驻留，可以保留。

### 云盘
- 列目录 / 进入 / 返回 / 刷新（`panServerUri /v1/directories/{dirId}/items`）
- 创建目录 / 删除 / 重命名 / 移动（`/v1/directories|files/*`，与「任务与文档 → 团队文档」同一套接口）
- 上传文件（选择或拖拽；浮动窗口显示进度，失败可点击重试）
- 搜索（`/openapi/file/search`）
- 文件下载（`/openapi/stream/download`，302 到 S3 签名地址）
- 在线编辑（优先 `panDocUri /v1/doc/open`；仅旧 openapi 的历史文件退回 `driveWpsUri /v1/api/file/wps3rd`）
- 群文档入口：把聊天群/团队群的文档空间聚合成一个盘，进入后按群 id 浏览
- 个人/团队/部门/公开四类盘的目录 id：`CurrentUserId` / teamId / orgId / classId

## 目录结构

```
YX/
├── src/
│   ├── components/
│   │   ├── MessageContent.vue   # 文本/图片/文件/合并转发渲染
│   │   ├── MessageImage.vue     # 图片 blob 加载与大图
│   │   ├── HistoryModal.vue     # 历史消息
│   │   ├── AppPanel.vue         # 应用面板
│   │   ├── ChatDrawer.vue       # 团队任务 / 文档抽屉
│   │   ├── UploadProgress.vue   # 上传进度浮窗
│   │   └── TaskNode.vue         # 任务树节点
│   ├── services/
│   │   ├── im/
│   │   │   ├── cmd.ts           # IM 命令码表
│   │   │   ├── types.ts         # 消息类型/会话类型
│   │   │   ├── protocol.ts      # 帧编解码 + 内容编解码
│   │   │   ├── content.ts       # 消息归一/HTML 净化
│   │   │   ├── media.ts         # 附件上传/图片获取
│   │   │   ├── prefs.ts         # 免打扰/折叠/置顶/团队群
│   │   │   ├── session-api.ts   # 会话列表/历史
│   │   │   └── im-client.ts     # WebSocket 客户端
│   │   ├── auth.ts              # OAuth2 + RSA + 配置中心
│   │   ├── http.ts              # 统一 HTTP + 401 续期
│   │   ├── config.ts            # 服务端点配置
│   │   ├── credentials.ts       # 记住密码
│   │   ├── app-client.ts        # 应用面板
│   │   ├── task-client.ts       # 团队任务
│   │   ├── pan-client.ts        # 团队文档
│   │   ├── zt.ts                # 零信任 SDK 调用（状态/登录/注销）
│   │   ├── disk-pan.ts          # 网盘文档接口（/pan/v1）
│   │   ├── disk-upload.ts       # 网盘/团队文档上传（store → 文档服务）
│   │   └── disk-client.ts       # 网盘 REST 客户端（/openapi 元数据）
│   ├── stores/
│   │   ├── auth.ts              # 登录态
│   │   ├── im.ts                # 会话/消息/未读/上传
│   │   ├── uploads.ts           # 上传队列/进度/重试
│   │   └── disk.ts              # 文件列表
│   ├── views/
│   │   ├── LoginView.vue        # 登录页
│   │   ├── ChatView.vue         # 聊天页
│   │   ├── ContactsView.vue     # 通讯录
│   │   ├── DiskView.vue         # 网盘页
│   │   └── ZtView.vue           # 零信任（登录/状态）
│   ├── assets/styles.css
│   ├── App.vue
│   └── main.ts
└── src-tauri/
    ├── src/zt_sdk.rs            # 零信任：驱动官方客户端 SDK 的 JSON-RPC
    ├── tauri.conf.json          # CSP 允许 blob/ws/wss/http/https
    └── capabilities/default.json  # http 域名白名单 *.bingolink.biz *.yuexiu.com
```

## 开发

```bash
pnpm install
pnpm tauri dev    # 启动开发（首次编译 Rust 较慢）
pnpm tauri build  # 打包
```

## 协议要点

帧格式（8 字节头 + payload）：
```
[header:1][command:1][number:1][operation:1][length:4 BE][payload: UTF-8 JSON]
```
- `operation=0` 表示无负载（心跳）
- `length` 为 payload 字节数，big-endian
- payload 是 JSON，其中 `content` 字段会被 `encryptContent`（取反 + Base64）编码

详见同目录的 `../doc/云上越秀_技术规格_深挖版.md`。

## 系统托盘与消息提醒

- 启动后显示系统托盘图标，macOS 菜单栏在图标旁显示未读消息总数；为零时隐藏数字。点击图标恢复并聚焦主窗口。
- 当前会话仅在消息窗口位于前台时自动已读；关闭隐藏窗口或切换到其他窗口后，新消息仍累计未读，返回消息窗口时仅清除当前会话未读。
- 托盘未读数仅统计同时未免打扰、未折叠的会话；阅读消息、修改会话设置或退出登录后自动更新。免打扰会话的 @ 消息也不计入托盘数字。
- macOS 收到上述会话的他人实时未读消息时播放系统 Glass 提示音，当前打开的会话同样提醒；离线补发、历史加载、重复消息及自己发送的消息不响铃，连续消息最多每秒响一次。
- 数字展示和原生声音提醒目前面向 macOS；Windows 托盘仅显示图标及未读数量悬浮提示，尚未实现声音提醒。声音受系统音量控制。

## 已知限制

- 网盘旧的 `/openapi/file/*` 写接口已被服务端以 `app.ex.666` 退役，目录与写操作统一走 `panServerUri /pan/v1`
- 上传走对象存储 `store/putFile` + `v2/{id}/share/document`（与聊天附件保存到云盘一致），写入文档服务；盘根会合并 `/openapi/file/list` 展示历史文件
- 回收站、分享、文件属性/版本/标签等入口尚未实现
- 群管理、@提醒、语音/视频等高级能力未实现
- 团队任务/文档依赖配置中心下发对应地址；部分账号可能没有权限
- 零信任需要本机已安装官方客户端（`/Applications/TrustAgentLauncher.app`），不需要它常驻；未登录时 SDK 报 `offline`
- 官方客户端升级会重写 launchd plist（恢复 `RunAtLoad`/`KeepAlive`），需要重新关闭才能保持按需启动
- 图片/附件下载走带 `access_token` 的 query，链接有时效性
- 设备序列号用随机 UUID 替代（原版用 serial-number 模块）


## 消息与文件转发

- 聊天顶部点击“多选转发”，或点击消息旁的“…”后选择“更多”，勾选多条文本、图片、文件、富文本或聊天记录；可混选、全选。工具条的“转发”可直接转发单条消息。
- “逐一转发”按原消息时间顺序保留内容和类型；“合并转发”发送一条默认展开、可手动收起的聊天记录，保留原发送人、时间和附件。接收人弹窗中也可切换转发方式，开始发送后锁定。接收人可从已有会话、已加载通讯录及全员目录搜索并多选，支持未聊过的个人；多次搜索的选择持续保留在“已选”区域，可单独移除。个人同时展示子公司（address）与组织（orgName），缺失信息会自动查询补齐，接口未提供时明确标注。
- 文件转发复用原附件地址，不重新上传。原附件失效或接收人没有访问权限时，转发不能恢复其可访问性。
- 逐一和合并转发均逐个接收人发送；中途失败时，弹窗保留剩余发送任务，可重试，已提交的任务不会重复发送。开始发送后锁定接收人选择。已提交发送只代表写入 WebSocket，最终投递仍依赖服务端回执。
- 当前范围是聊天内已有的消息与文件消息；不包含从云盘文件列表直接转发。更多历史消息可先通过“历史”加载，再回聊天区多选。
- 协议依据：仓库技术规格列出 `COMBINE = 24`；参考项目 `repo/kit/src/emb/content.js` 描述 `{brief, from_name, to_name, forwardMsgDetailId, msgs}`。当前实现直接随消息内嵌 `msgs`。参考资料还列出 `{embHttpUri}emb/upload/forwardMsgDetail`，但标注未测，没有可核实的请求参数，因此当前没有调用此接口。内嵌合并消息与官方客户端的互通、大体积消息限制，仍需可用生产账号实测。

## 消息工具条

- 每条消息泡泡旁的“…”打开两排工具条：上排为快捷表情，“⊕”展开更多表情；下排为复制、转发、引用、删除、收藏和更多（进入多选）。点击外部或按 Esc 关闭。
- 表情回应、收藏和删除按当前账号保存在本机；不会同步到服务端或其他设备。再次点击同一表情可取消回应，再次收藏可取消收藏。删除只隐藏本机聊天列表中的该条消息，不是撤回。
- 复制使用消息的文本表示，图片和文件复制名称或占位说明；引用将发送人及消息文本加入当前输入框，由用户确认后发送，当前未接入服务端结构化引用协议。

- 消息显示支持将 `[点赞]`、`[咧嘴]`、`[微笑]` 等常见中文表情别名转换为 Unicode emoji；未知方括号文本保留原样。转换仅作用于显示，不改写消息原文，覆盖普通文本、富文本、HTML 文字和合并转发明细。

## 关闭窗口与退出应用

点击窗口关闭按钮会隐藏主窗口，应用继续在后台运行，保留消息连接、未读提醒和输入草稿。点击托盘图标或托盘菜单“显示主窗口”恢复窗口；macOS 也可点击 Dock 图标恢复。需要结束进程时，使用托盘菜单“退出应用”或 macOS 系统退出操作。开发模式同样适用，修改 Rust 代码后需重启应用生效。
