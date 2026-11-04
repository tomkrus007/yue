# 越秀 Link

云上越秀（品高 BingoLink）桌面端的 IM 通信 + 云盘功能复刻客户端。

- **技术栈**：Tauri v2 + Vue 3 + TypeScript + Pinia + Vue Router
- **目标服务端**：直连真实越秀生产环境（纯客户端，不自建服务端）
  - IM：`ws://msg.bingolink.biz:10083`
  - 网盘：`https://streamapi.bingolink.biz/openapi`
  - 登录：`https://www.bingolink.biz/sso/oauth/token`（OAuth2 password 模式 + RSA 密码加密）
- **不复刻**：视频会议、日程、零信任、应用商店等

## 功能范围

### IM 通信
- OAuth2 登录 → WebSocket 连接 → 鉴权（Cmd.uAuth=11）
- 心跳保活（Cmd.uBeats=6 / dBeats=16，30 秒间隔，3 次丢失重连）
- 收发文本消息（Cmd.uSendMsg=3 / dRecMsg=3）
- 离线消息拉取（Cmd.uOfflineStart=102 / dEOFoffline=97 / dEOFonline=101）
- 会话已读回执（Cmd.uReadedSession=19）
- Token 刷新通知（Cmd.dRefreshToken=99）
- 自定义二进制帧协议（非 protobuf）
- 内容"加密"：按位取反 + Base64（伪加密，已还原）

### 云盘
- 列目录 / 进入 / 返回 / 刷新
- 创建目录 / 删除 / 搜索
- 文件下载 URL 生成
- 文件上传（HTTP 直传，简化版）
- 在线编辑 WS URL 构造（WPS 协同）

## 目录结构

```
yue-link/
├── src/
│   ├── services/
│   │   ├── im/
│   │   │   ├── cmd.ts          # IM 命令码表
│   │   │   ├── types.ts        # 消息类型/会话类型
│   │   │   ├── protocol.ts     # 帧编解码 + 内容编解码
│   │   │   └── im-client.ts    # WebSocket 客户端
│   │   ├── auth.ts             # OAuth2 + RSA 登录
│   │   ├── config.ts           # 服务端点配置
│   │   └── disk-client.ts      # 网盘 REST 客户端
│   ├── stores/
│   │   ├── auth.ts             # 登录态
│   │   ├── im.ts               # 会话/消息
│   │   └── disk.ts             # 文件列表
│   ├── views/
│   │   ├── LoginView.vue       # 登录页
│   │   ├── ChatView.vue        # 聊天页（会话列表 + 消息 + 协议日志）
│   │   └── DiskView.vue        # 网盘页
│   ├── assets/styles.css
│   ├── App.vue
│   └── main.ts
└── src-tauri/
    ├── tauri.conf.json         # CSP 允许 ws/wss/http/https
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

详见同目录的 `../云上越秀_技术规格_深挖版.md`。

## 已知限制

- 网盘上传走 HTTP 直传（原版走 WS 分片），大文件可能受限
- 文件类消息（图片/文件/语音等）的发送流程未实现（接收可解码显示）
- 在线编辑、视频通话等高级功能未实现
- 设备序列号用随机 UUID 替代（原版用 serial-number 模块）
