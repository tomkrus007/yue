# AGENTS.md

云上越秀（品高 BingoLink）桌面端的逆向资料 + 复刻客户端。仓库分两部分：

- `YX/`：Tauri v2 + Vue 3 + TS 客户端，直连生产服务端。
- `doc/`：逆向报告与协议规格；`LESSONS.md`：踩坑记录，开工前先看。
- 使用web技术复刻的版本见`./yx-cloud-kb`，原版云上越秀安装包见`./yx-packages`。

## 命令（全部在 `YX/` 执行）

仓库根目录没有 `package.json`，不要找 workspace。

```bash
pnpm install
pnpm tauri dev     # 唯一能跑通真实流程的开发方式
pnpm build         # 唯一验证命令：vue-tsc --noEmit && vite build
pnpm tauri build   # 打包；需要关窗不退出的常驻版用 pnpm tauri build --debug
```

- 不要用 `pnpm dev` 验证业务：它只起 Vite，`@tauri-apps/plugin-http` 等 Tauri API 会失败。
- 没有测试、lint、formatter 配置；`pnpm build` 的 typecheck 就是当前质量门禁（strict + noUnusedLocals/Params）。
- `pnpm tauri dev` 下关闭窗口 = 进程正常退出，不是崩溃；重开需重新启动。详见 `LESSONS.md`。
- Vite 端口固定 1420 且 `strictPort: true`，被占用会直接失败。

## 代码结构

- 入口 `src/main.ts`：hash 路由；受保护路由只检查 localStorage 的 `AccessToken`。
- `src/services/` 放协议与 API（auth/im/disk/contact、config、http、app/task/pan/zt），`src/stores/` 放 Pinia 状态，`src/views/` 放页面，`src/components/` 放聊天消息/历史/抽屉/应用面板。
- Rust 侧 (`src-tauri/src/`)：`lib.rs` 只做插件与命令注册，`zt_sdk.rs` 驱动本机官方零信任客户端的 JSON-RPC（登录/注销/状态）；IM 业务仍全在前端；`greet` 是脚手架残留。

## 参考实现与移植约定

- **主要参考 `/Users/tom/Downloads/yx-cloud-kb`**：前端看 `repo/web/index.html`，轻客户端看 `repo/kit/src`，协议与实测结论看其 `kb/`、`repo/analysis/`。移植时适配 `YX` 的 Vue 3 + Pinia + Tauri 形态，不要照搬参考库的 Node 进程或单文件网页结构。
- 已按参考实现移植：附件收发（图片/文件/粘贴/拖拽）、历史消息与分页、REST 会话列表、未读数、token 续期、记住密码/自动登录、免打扰、置顶、折叠、消息富文本与合并转发、应用面板、团队任务、团队文档、零信任登录。
- 附件上传地址是 `{storeUri}/store/putFile`（`storeUri` 本身以 `/store` 结尾，所以会出现 `/store/store/putFile`，与参考一致）；图片后缀只认 `jpg/jpeg/png/gif/bmp`，其余走文件消息。
- 存储服务返回 `application/octet-stream` + `nosniff`，图片必须取字节后转 `Blob` URL，不能直接给 `<img src>`；图标走 v1 `store/getFile`。
- IM 离线游标用已收离线消息的 `max(send_time)`；鉴权成功后主动发 `uOfflineStart`；`101` 表示还有下一批，`97` 才是结束；收到 `99` 刷新 token 后重连。
- 会话归属：`to_type ∈ {2,4,8}` 或自己发的归到 `to_*`，否则归到 `from_*`；未读以 `is_read === 0` 为准，排除本设备发送，免打扰会话只计 `at_user_ids` 里的 `ALL`/自己，服务号不计数。
- 免打扰/折叠/置顶接口按会话类型分流，且多数只收表单参数；细节见 `src/services/im/prefs.ts`。
- 应用面板 `appApiUri`、团队任务 `taskUri`、团队文档 `panServerUri`/`panDocUri` 都来自配置中心；云盘/任务接口只认 query `access_token`。
- 零信任**不自研隧道**：`src-tauri/src/zt_sdk.rs` 调用本机官方客户端 `127.0.0.1:35440-35443/trustagent` 的 `login/logout/status/get_config`，把当前 AccessToken 交出去；隧道与内网路由由官方客户端负责（详见 `doc/官方零信任客户端架构与移植分析.md`）。
- 会议组件（`TMSDK.framework`，355 MB）**不随安装包分发**：shim 用 `dlopen` 加载，安装器把它装回 `YX.app/Contents/Frameworks/TMSDK.framework` 并重签整个 app（`src-tauri/src/component.rs`）。组件包用 `scripts/pack-tmsdk.sh` 打成 `TMSDK-<ver>-macos-arm64.tar.zst` 发 GitHub Release，默认地址在 `src-tauri/components.json`（启动时种子进 SQLite，用户可改）；组件缓存留在 `app_cache_dir/components/`，进会议时缺失就本地回装。设计见 `doc/TMSDK组件化与跨平台设计.md`。

## 关键约束

- 所有 HTTP 必须用 `@tauri-apps/plugin-http` 的 `fetch`，不要用浏览器 `fetch`；**上传是唯一例外**：plugin-http 的 `fetch` 会 `await req.arrayBuffer()` 后 `Array.from(new Uint8Array(...))` 把整个 body 变成 JS 数字数组走 IPC，600MB 文件直接把 WebView 进程顶到 100% CPU（界面卡死）。聊天附件与云盘上传一律走 `store_upload_begin/chunk/commit/cancel`：前端按 8MB 分片写临时文件，Rust 流式发 multipart（`src-tauri/src/store_upload.rs`）。分片必须用 `invoke(cmd, Uint8Array, { headers })` 的原始字节通道，不能塞进普通对象参数，否则同样退化成数字数组。
- 新增域名必须同步 `src-tauri/capabilities/default.json` 的 http 白名单；CSP 在 `src-tauri/tauri.conf.json`，`connect-src` 要保留 `ipc:`（原始字节 IPC 走 `ipc://localhost`，被 CSP 挡掉会退化成 JSON 数字数组）。
- 服务地址默认写死在 `src/services/config.ts`；登录时会先拉配置中心并写入 localStorage（`serverPaths`），运行时用 `getServerPaths()` 取真实地址。调试仍可用 localStorage 覆盖 `ssoUrl`、`microServiceUrl`、`embWebSocketUri`、`uamApiUri`、`diskOpenApiUrl`、`diskSiteUrl`、`diskStreamUrl`。
- 登录是两步 OAuth2（v2 token 换 v3）+ RSA 加密密码。登录主流程只等 token；`getCurrentUser()` 必须保持异步/带超时，否则会卡住跳转（见 `LESSONS.md`）。
- IM 是自定义二进制帧，不是 JSON/protobuf；`content` 的“加密”只是按位取反 + Base64。帧中“有无负载”看 byte 3（`operation`），不是 byte 2——注释已说明原版字段名写反，不要“修正”。
- 网盘个人盘根路径是 `/Private`，传 `/` 会 500。
- 「共享给我」（`/v1/share/2/list`，way=2）里的目录浏览/下载/预览必须带 `x-share-id: <分享 id>` 头；不带该头服务端按接收人自有权限过滤，返回空数组而不是 403（下载则是 45111001 Insufficient operation permission）。
- 联系人过滤自己依赖 localStorage 的 `CurrentECode`。

## 文档与验证

- 协议以 `doc/云上越秀_技术规格_深挖版.md` 为准，功能范围/已知限制见 `YX/README.md`。
- 端到端验证需要可用的越秀生产账号；仓库没有测试账号或假服务端。
- 零信任按需启动：`zt_sdk::agent_start` 先 `open -a` 客户端，再 `launchctl kickstart` 两个用户级 agent，进程没起来就直接 spawn 二进制兜底（launchd 任务会被客户端自己 bootout）；注销时 `agent_stop` 杀进程。
- 零信任验证：本机需安装官方客户端（不必常驻）；YX 登录后 `status` 应为 `online`，内网访问由官方客户端 utun 承担。若 Clash 与零信任抢默认路由，按 `ZtView` 页里的命令删除 utun 上的默认路由。
- `dist/`、`src-tauri/target/`、`src-tauri/gen/schemas/` 是生成物，不要手改。