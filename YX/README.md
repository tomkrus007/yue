# YX

云上越秀（品高 BingoLink）桌面端的 IM 通信 + 云盘功能复刻客户端。

- **技术栈**：Tauri v2 + Vue 3 + TypeScript + Pinia + Vue Router
- **目标服务端**：直连真实越秀生产环境（纯客户端，不自建服务端）
  - IM：配置中心下发的 `embWebSocketUri`（生产为 `wss://…:443`）
  - 网盘：`https://streamapi.bingolink.biz/openapi`
  - 登录：`https://www.bingolink.biz/sso/oauth2/token`（OAuth2 password 模式 + RSA 密码加密）
- **不复刻**：日程、红包等重业务；视频会议直接复用官方腾讯会议 SDK（TMSDK）的原生窗口，不在本仓库重写会议 UI；零信任不自研隧道，只驱动本机官方零信任客户端的登录接口

## 功能范围

### IM 通信
- OAuth2 登录 → 配置中心 → WebSocket 连接 → 鉴权（Cmd.uAuth=11）
- 心跳保活（Cmd.uBeats=6 / dBeats=16，30 秒间隔，3 次丢失重连）
- 收发文本 / 图片 / 文件消息（Cmd.uSendMsg=3 / dRecMsg=3）
- 附件上传 `store/putFile`，支持多选、粘贴、拖拽；图片内联显示
- 大文件上传走 Rust 流式链路（前端 8MB 分片写临时文件，Rust 读文件发 multipart），600MB+ 文件不再撑爆 WebView 内存
- 离线消息拉取（Cmd.uOfflineStart=102 / dEOFoffline=97 / dEOFonline=101）
- 历史消息（`get/history/date`）与继续往前翻页
- REST 会话列表（`emb/sessions/latest`）、未读数、置顶（置顶/取消置顶、置顶优先排序）、折叠、免打扰
- 富文本 / 复杂消息（type 0/1）与合并转发的文本与 HTML 白名单渲染；普通文本消息按字面显示，标签不会被解析掉；正文中的 http/https 地址会变成可点击链接，点击交给系统浏览器打开（`src/services/im/autolink.ts`）
- 待办通知卡片展示标题、摘要与更多信息；点击「查看待办／待阅／已办」直接在系统浏览器打开对应详情
- 消息无直链时，后台按来源与完整标题查询待办／待阅／已办，唯一匹配后直接打开原始详情地址；同名歧义、缺少链接或仅移动端可办时在消息下提示原因，不执行快捷审批
- 直接使用系统默认浏览器打开待办原始链接，不尝试 AccessToken／CAS 自动登录，也不提前访问认证页；登录由浏览器和业务系统处理
- 会话已读回执（Cmd.uReadedSession=19）
- Token 刷新通知（Cmd.dRefreshToken=99）
- 自定义二进制帧协议（非 protobuf）
- 内容"加密"：按位取反 + Base64（伪加密，已还原）
- 记住密码 / 自动登录（Base64 混淆，不是加密）
- 通讯录创建群组（`v2/groups/create`，自己为群主）：建群成功后本地补会话并直接打开聊天，不发 IM 帧
- 群管理（对齐官方群设置面板）：群资料（改名/群介绍/公开设置/群内昵称）、成员管理（添加/移除/邀请入群/管理员/转让）、群公告（发布/编辑/置顶/删除）、全员禁言+禁言与白名单名单（配置中心 `IS_ENABLE_GROUP_SILENT` 开启且群主可见）、4 位入群码与群二维码、退出/解散；非成员与「自己被禁言」时输入区禁用。接口契约见 `doc/官方客户端群管理实现分析.md`，端点实现见 `src/services/group-client.ts`

### 扩展面板
- 我的应用（`appApiUri/es/authorized`，含图标）
- 团队任务（`taskUri`，团队群 → 分组 → 任务树）
- 团队文档（品高云盘目录、上传、下载、预览、在线编辑、删除）
- 仅 `templateCode = workGroupDefault` 的团队群显示任务/文档抽屉

待办通知通常只带 `[UnityTodo]` 入口，不带条目 ID 或详情地址。客户端优先在消息指定分类中跨页匹配来源与完整标题，唯一匹配后直接使用详情；没有匹配时才查询其他分类，避免无关接口故障阻断打开。卡片标题是「您有一条新的待办」时，用卡片摘要中的实际标题匹配。点击过程不弹出待办列表。待办列表接口依据 `doc/官方客户端待办与待阅实现分析.md` 实现，真实账号的接口响应仍需联调确认。`node scripts/check-todo.cjs` 可执行文档样例与模拟响应的离线回归，覆盖卡片字段、动作参数、来源过滤、详情定位、直接外部打开和失败处理；质量门禁仍为 `pnpm build`。

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
- 团队盘入口按 `taskUri /v1/group/formal/page` 列出全部正式团队群（分页拉全），进入后按 groupId 浏览；旧实现走 `/openapi/team/list?filter={"onlyMember":true}`，只返回单独创建的云盘团队，团队数量远少于原版
- 部门盘入口按 `panServerUri /v1/principals/departments` 列出用户可见的部门链；旧 `/openapi/org/list` 加 `fileNotEmpty` 会漏掉仍有文档的上级部门
- 公开文档入口按 `/openapi/public/list_class` 列出文档库分类
- 个人/团队/部门/公开四类盘的目录 id：`CurrentUserId` / groupId（团队群） / orgId / classId

### 会议（腾讯会议）
- 直接链接官方 `TMSDK.framework`（C++ 接口），没有 Electron/Node 中间层；`src-tauri/wemeet/` 是唯一的原生桥
- 入口在左侧导航「会议」：打开会前界面（设置／预约／历史都在这里）、快速会议、按会议号加入
- 账号配置走配置中心 `rtcUri` 的 `v1/tencent/meeting/config`（`sdkKey/sdkToken/ssoUrlPrefix/idToken`），登录态与 YX 登录绑定
- 首次操作才初始化（约 3–10 秒）；退出登录或退出应用时释放 SDK，避免 `TMSDKHelper` 残留
- `OnSDKTokenExpired` 时自动重新拉配置并 `RefreshSDKToken`
- 会议 UI 全部是腾讯原生窗口，不受 YX 主题影响；入会默认关麦克风、关摄像头（与官方一致）
- IM 联动：邀请消息（`msg_type 15`，以及官方「分享到聊天」的 `99/type 3`）在会话里显示为会议卡片，点「加入会议」直接入会；收到实时邀请还会弹一次全局「加入会议」窗口（离线补发的旧邀请、会议中都不弹）；卡片指令 `[JoinWeMeet]`、`[StartWeMeet]`、`[OpenApp appCode=linkMeeting]` 都走会议模块
- 聊天顶部「视频会议」：单聊直接邀请对方，群/部门会话先选人；先开快速会议，拿到 `OnJoinMeeting` 回调里的会议号后再逐个发邀请（与官方 `joinWeMeetCallback` 一致），会议页也能「邀请同事」
- 会议中关闭 YX 主窗口只会隐藏窗口，会议继续；从托盘恢复后可点「回到会议」把会中窗口置前

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
│   │   ├── MeetingInvitePrompt.vue # 会议邀请弹窗
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
│   │   │   ├── wemeet-invite.ts # 腾讯会议邀请消息解析/构造
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
│   │   ├── wemeet.ts            # 会议状态机/邀请/生命周期
│   │   └── disk.ts              # 文件列表
│   ├── views/
│   │   ├── LoginView.vue        # 登录页
│   │   ├── ChatView.vue         # 聊天页
│   │   ├── ContactsView.vue     # 通讯录
│   │   ├── DiskView.vue         # 网盘页
│   │   ├── WemeetView.vue       # 会议（会前/快速会议/入会/邀请）
│   │   └── ZtView.vue           # 零信任（登录/状态）
│   ├── assets/styles.css
│   ├── App.vue
│   └── main.ts
└── src-tauri/
    ├── src/zt_sdk.rs            # 零信任：驱动官方客户端 SDK 的 JSON-RPC
    ├── src/wemeet.rs            # 腾讯会议：Tauri 命令 + 主线程投递 + 事件
    ├── wemeet/                  # 腾讯会议 C++ 桥（框架缺失时走 stub）
    ├── src/store_upload.rs      # 附件上传：Rust 流式读临时文件发 multipart（大文件不占 WebView 内存）
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
- macOS Dock 图标同步显示同一份未读总数角标；未读清零（阅读、退出登录、移除会话等）后自动消失。
- 当前会话仅在消息窗口位于前台时自动已读；关闭隐藏窗口或切换到其他窗口后，新消息仍累计未读，返回消息窗口时仅清除当前会话未读。
- 托盘与 Dock 未读数仅统计同时未免打扰、未折叠的会话；阅读消息、修改会话设置或退出登录后自动更新。免打扰会话的 @ 消息也不计入数字。
- macOS 收到上述会话的他人实时未读消息时播放系统 Glass 提示音，当前打开的会话同样提醒；离线补发、历史加载、重复消息及本机发送的消息不响铃，连续消息最多每秒响一次。自聊（文件传输助手）里由其他设备发来的消息按“他人消息”处理，会响铃并累计未读。
- 当消息不在当前会话或窗口不在前台时，macOS 还会发送系统通知（标题为会话名，正文为发送人和消息预览）；免打扰、折叠和服务号不通知，@我 的消息即使免打扰也提醒。首次登录后申请一次通知权限，拒绝后不重复弹窗。受保护消息只显示“[受保护消息]”，通知内容不落盘。
- 数字展示、Dock 角标和原生提醒目前面向 macOS；Windows 托盘仅显示图标及未读数量悬浮提示，尚未实现声音提醒。声音受系统音量控制。

## 已知限制

- 网盘旧的 `/openapi/file/*` 写接口已被服务端以 `app.ex.666` 退役，目录与写操作统一走 `panServerUri /pan/v1`
- 上传走对象存储 `store/putFile` + `v2/{id}/share/document`（与聊天附件保存到云盘一致），写入文档服务；盘根会合并 `/openapi/file/list` 展示历史文件
- 回收站、分享、文件属性/版本/标签等入口尚未实现
- 群管理已实现（见上文「核心能力」）；已知边界：审批入群无 REST 列表接口（官方经 IM 系统消息卡片审批），群机器人的机器人/模板/工作区归档能力未做，公告附件（resources）未做
- 团队任务/文档依赖配置中心下发对应地址；部分账号可能没有权限
- 零信任需要本机已安装官方客户端（`/Applications/TrustAgentLauncher.app`），不需要它常驻；未登录时 SDK 报 `offline`
- 官方客户端升级会重写 launchd plist（恢复 `RunAtLoad`/`KeepAlive`），需要重新关闭才能保持按需启动
- 图片/附件下载走带 `access_token` 的 query，链接有时效性
- 设备序列号用随机 UUID 替代（原版用 serial-number 模块）
- 会议需要 `src-tauri/vendor/TMSDK.framework`（355 MB，从官方 DMG 用 `scripts/sync-wemeet.sh` 拷贝，不入库）；没有框架时构建走 stub，会议入口会提示不可用
- TMSDK 要求进程运行在 `.app` 内（依赖 `CFBundleIdentifier`），所以会议只能用 `pnpm tauri build --debug` 出的 `YX.app` 验证，`pnpm tauri dev` 下调用会被前置检查拦下
- 收到会议邀请时会弹全局「加入会议」窗口（离线补发的旧邀请不弹，会议中也不弹）；响铃邀请（`EnableRingInvitationView`）没接——官方客户端本身也没启用它，邀请统一走 IM 消息
- 会议只有 arm64；TMSDK 3.21.303 由腾讯提供，服务端升级后需同步换框架


## 消息与文件转发

- 聊天顶部点击“多选转发”，或点击消息旁的“…”后选择“更多”，勾选多条文本、图片、文件、富文本或聊天记录；可混选、全选。工具条的“转发”可直接转发单条消息。
- “逐一转发”按原消息时间顺序保留内容和类型；“合并转发”按原版大小限制拆成一条或多条聊天记录，保留原发送人、时间、附件及引用快照；已有明细默认展开，缺少明细时展开后补载。接收人弹窗中也可切换转发方式，开始发送后锁定。接收人可从已有会话、已加载通讯录及全员目录搜索并多选，支持未聊过的个人；多次搜索的选择持续保留在“已选”区域，可单独移除。个人同时展示子公司（address）与组织（orgName），缺失信息会自动查询补齐，接口未提供时明确标注。
- 文件转发复用原附件地址，不重新上传。原附件失效或接收人没有访问权限时，转发不能恢复其可访问性。
- 逐一和合并转发均逐个接收人发送；中途失败时，弹窗保留剩余发送任务，可重试，已提交的任务不会重复发送。开始发送后锁定接收人选择。已提交发送只代表写入 WebSocket，最终投递仍依赖服务端回执。
- 当前范围是聊天内已有的消息与文件消息；不包含从云盘文件列表直接转发。更多历史消息可先通过“历史”加载，再回聊天区多选。
- 合并转发先按原版协议向 `{embHttpUri}/emb/upload/forwardMsgDetail` 提交表单 `forwardMsgDetail=JSON.stringify(msgs)`，再携带 `forwardMsgDetailId` 发送；传输时去掉内嵌明细，本机仍保留明细。按原版限制，每条合并内容不得超过 20000 个字符；发送前自动按原顺序分批，单条超限会提示切换逐一转发。相同批次向多个接收人发送时复用已上传明细 ID。服务端是否向接收端补齐明细仍需生产账号验证；只有详情 ID 且未下发明细的消息可通过已核实的历史接口重新获取；服务端历史仍未返回明细时明确提示，不猜测独立详情接口。

## 消息展示、引用与回应

- 每条普通消息的“…”提供复制、转发、引用、删除、收藏、更多；自己的消息提供撤回，群管理员另有管理撤回。删除仅在本机隐藏；撤回等待服务端确认后替换原文。
- 他人发来的用户消息在“…”里提供“联系人”，直接打开该发送人的联系人详情；会话列表的“…”也提供“查看联系人详情”（单聊／群聊／服务号）。群聊和部门群中他人消息左侧显示发送人头像，双击头像打开或新建与他的单聊。
- 引用使用独立引用栏，发送携带 `reply_msg_id`，不再把原文拼进输入框。群聊回复他人自动插入带用户 ID 的 @；引用草稿按会话保存，切换会话不会串用。接收端显示原消息摘要，点击查看讨论；原消息缺失时可向前补载历史。打开回复详情后自动扫描当前时间上界前的会话历史，补齐原文与关联回复；显示进度，可暂停并继续。固定上界配合 skip 翻页，避免同一毫秒超过一页时漏消息；扫描未完成时不会冒充全量回复数。
- 别人 @ 自己或 @所有人的普通消息下方显示“收到／回复”。“收到”按官方 CTRL `1000/1001` 添加／取消表情回应，成功回执后显示表情与人员姓名；可以取消自己的回应，不可取消他人的回应。消息有突出边框和 @ 标识；会话有“有人@我”标识，侧栏“@”打开提醒中心，待处理状态独立于会话未读数。支持定位、上一条／下一条、去回复、手动处理及重新待处理；“收到”或结构化回复确认成功后自动处理，撤回不会被旧历史重新加回。
- 成功发送回执使用原版 `{success:true,content:消息ID,time}`，失败使用 `{success:false,msg_id,content,errorCode}`。普通消息等待确认 15 秒后复用原编号重试，含首次最多三次；断线挂起、重连离线同步后恢复，待确认状态可跨重启保存。明确拒绝不自动重发，迟到成功纠正超时失败且不会被旧失败反转。界面区分等待恢复、等待确认、重试中、已发送与发送失败；回应与撤回提交超时或拒绝会提示，不先伪造成功状态。
- 收藏通过用户中心 `/v1/favorites` 全量分页同步，完整成功后原子更新星标，部分失败不会误清未看到的收藏；窗口恢复焦点时重新同步。未知状态先同步再由用户选择收藏／取消。收藏弹窗支持搜索、分类、取消和定位原消息，同内容多次发送会列候选，不随意猜一条。历史版本本机收藏标记不自动上传，也不冒充服务端收藏。
- 消息和编辑器使用原版 133 个图片表情与别名；未知别名保留原文，旧有 Unicode 别名兼容保留。独立表情消息使用原版 v1 存储取图接口。
- 音频、语音、视频通过本机 Range 代理流式播放，支持拖动定位；外部 HTTP 仍由 `plugin-http.fetch` 的响应流读取，再以原始字节 IPC 回传，本机代理不向外部发 HTTP。附件支持分块下载、进度、取消、失败重试和打开成品，保存到系统“下载／YX”，同名不覆盖。WebView 不支持的编码可在本机已有 ffmpeg 时由用户选择转 AAC／H264 播放，否则明确提供系统播放器降级，不自动安装工具。图片查看器支持上一张／下一张、方向键、缩放和旋转，范围为当前已加载的非保护消息。
- 个人／群／服务号名片可打开对应详情页，服务号使用真实详情接口并以会话类型 5 发消息；分享与日程卡片显示标题、摘要及可用的 HTTP(S) 链接。完整日程管理不在本轮范围。
- 自适应／模板卡片（27、29、31）按需加载官方 SDK，支持标准文本、列、事实列表、图片、输入、模板数据展开、动态查询及 HTTP(S) 打开链接／提交；模板服务使用配置中心的 `cardUri`。网络图片转为 Blob，提交只在用户点击后执行，失败提示业务原因；刷新失败禁用旧动作。已接入核实的 `[]` 打开网页、授权应用、会话／名片、待办、请求、消息、收藏等指令及带明确 URL 的 Action.Link 兼容；执行仅由用户点击触发，保留原消息上下文。会议、动态、本机专有插件、缺少电脑端地址的目标及自定义皮肤仍有边界，会提示具体原因，不猜接口。
- 历史弹窗支持正文、发送人、附件名称及内嵌合并记录搜索，以及消息类型和 @我 筛选；搜索限当前已加载消息，可继续加载更早记录；回复补全后取得的历史也参与搜索。主聊天每次渲染最多 300 条，按消息 ID 锚定窗口；历史筛选结果分批显示，避免大群补全后一次渲染全部消息。阅读旧消息时，新消息不强制滚到底部，消息区右侧用上下双尖括号图标按钮回到最新消息或顶部（有新消息时角标提示条数）。
- 输入区支持文字消息要求回执或阅后即焚，两种模式互斥，暂不支持附带附件。收到的保护消息点击后发送原版 95 阅读确认，成功回执后才标已确认，未确认命令可靠重试并跨重启恢复；阅后即焚在 30 秒到期、关闭阅读框或离开聊天页时本机销毁。历史与回复详情共用保护组件，保护图片不进入独立画廊。已读名单及时间来自本端收到的阅读确认；单聊、群聊和已核实部门范围捕获接收人快照，完整性不足时说明原因，当前参考名单不覆盖历史快照。尚未收到回执不等于尚未阅读；未使用未知的全量服务端回执接口。打开过的焚毁消息重启后不会复活正文。
- Office/PDF 仍在系统浏览器打开服务端预览页；已按原版企业信息接口的 `indiviConfig` 应用 `ReplaceRequestUri`，页面地址与 `furl` 都按前缀映射（与原版 `openBrowserUrl → formatUrl` 一致），按账号与企业缓存；配置查询失败或超过 4 秒继续打开原预览地址。端到端互通、撤回时限／权限、阅读回执和收藏同步需在 `pnpm tauri dev` 使用生产账号验证。

离线回归脚本位于 `YX/scripts/check-*`，覆盖协议、状态、分页、收藏、卡片、转发及下载；运行真实实现并模拟账号、连接和服务响应，不访问生产服务。原生本机 Range／下载测试使用 `cargo test --lib`，生产零信任测试保持忽略；质量门禁仍为 `pnpm build`。本轮功能状态与统一 P0 验收步骤见 [消息 P1–P3 实现与统一验收](../doc/消息P1-P3实现与统一验收.md)。新增下载和媒体原生模块后需重启 Tauri 进程。

## 关闭窗口与退出应用

点击窗口关闭按钮会隐藏主窗口，应用继续在后台运行，保留消息连接、未读提醒和输入草稿。点击托盘图标或托盘菜单“显示主窗口”恢复窗口；macOS 也可点击 Dock 图标恢复。需要结束进程时，使用托盘菜单“退出应用”或 macOS 系统退出操作。开发模式同样适用，修改 Rust 代码后需重启应用生效。
