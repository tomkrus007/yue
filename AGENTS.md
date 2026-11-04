# AGENTS.md

云上越秀（品高 BingoLink）桌面端的逆向资料 + 复刻客户端。仓库分两部分：

- `YX/`：Tauri v2 + Vue 3 + TS 客户端，直连生产服务端。
- `doc/`：逆向报告与协议规格；`LESSONS.md`：踩坑记录，开工前先看。
- 使用web技术复刻的版本见`/Users/tom/Downloads/yx-cloud-kb`，请主要参考此项目。

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
- Rust 侧 (`src-tauri/src/`)：`lib.rs` 只做插件与命令注册，`zt.rs` 是零信任分流代理（HTTP CONNECT / 普通 HTTP / SOCKS5）；IM 业务仍全在前端；`greet` 是脚手架残留。

## 参考实现与移植约定

- **主要参考 `/Users/tom/Downloads/yx-cloud-kb`**：前端看 `repo/web/index.html`，轻客户端看 `repo/kit/src`，协议与实测结论看其 `kb/`、`repo/analysis/`。移植时适配 `YX` 的 Vue 3 + Pinia + Tauri 形态，不要照搬参考库的 Node 进程或单文件网页结构。
- 已按参考实现移植：附件收发（图片/文件/粘贴/拖拽）、历史消息与分页、REST 会话列表、未读数、token 续期、记住密码/自动登录、免打扰、置顶、折叠、消息富文本与合并转发、应用面板、团队任务、团队文档、零信任分流。
- 附件上传地址是 `{storeUri}/store/putFile`（`storeUri` 本身以 `/store` 结尾，所以会出现 `/store/store/putFile`，与参考一致）；图片后缀只认 `jpg/jpeg/png/gif/bmp`，其余走文件消息。
- 存储服务返回 `application/octet-stream` + `nosniff`，图片必须取字节后转 `Blob` URL，不能直接给 `<img src>`；图标走 v1 `store/getFile`。
- IM 离线游标用已收离线消息的 `max(send_time)`；鉴权成功后主动发 `uOfflineStart`；`101` 表示还有下一批，`97` 才是结束；收到 `99` 刷新 token 后重连。
- 会话归属：`to_type ∈ {2,4,8}` 或自己发的归到 `to_*`，否则归到 `from_*`；未读以 `is_read === 0` 为准，排除本设备发送，免打扰会话只计 `at_user_ids` 里的 `ALL`/自己，服务号不计数。
- 免打扰/折叠/置顶接口按会话类型分流，且多数只收表单参数；细节见 `src/services/im/prefs.ts`。
- 应用面板 `appApiUri`、团队任务 `taskUri`、团队文档 `panServerUri`/`panDocUri` 都来自配置中心；云盘/任务接口只认 query `access_token`。
- 零信任代理是**白名单分流**，不是官方零信任隧道：规则在 `src/services/zt.ts` 编辑，实际转发在 `src-tauri/src/zt.rs`；未命中规则默认直连，配置错误时不会自动全断。

## 关键约束

- 所有 HTTP 必须用 `@tauri-apps/plugin-http` 的 `fetch`，不要用浏览器 `fetch`；只有附件上传为了进度用 XHR，并在失败时回退到 plugin-http。
- 新增域名必须同步 `src-tauri/capabilities/default.json` 的 http 白名单；CSP 在 `src-tauri/tauri.conf.json`。
- 服务地址默认写死在 `src/services/config.ts`；登录时会先拉配置中心并写入 localStorage（`serverPaths`），运行时用 `getServerPaths()` 取真实地址。调试仍可用 localStorage 覆盖 `ssoUrl`、`microServiceUrl`、`embWebSocketUri`、`uamApiUri`、`diskOpenApiUrl`、`diskSiteUrl`、`diskStreamUrl`。
- 登录是两步 OAuth2（v2 token 换 v3）+ RSA 加密密码。登录主流程只等 token；`getCurrentUser()` 必须保持异步/带超时，否则会卡住跳转（见 `LESSONS.md`）。
- IM 是自定义二进制帧，不是 JSON/protobuf；`content` 的“加密”只是按位取反 + Base64。帧中“有无负载”看 byte 3（`operation`），不是 byte 2——注释已说明原版字段名写反，不要“修正”。
- 网盘个人盘根路径是 `/Private`，传 `/` 会 500。
- 联系人过滤自己依赖 localStorage 的 `CurrentECode`。

## 文档与验证

- 协议以 `doc/云上越秀_技术规格_深挖版.md` 为准，功能范围/已知限制见 `YX/README.md`。
- 端到端验证需要可用的越秀生产账号；仓库没有测试账号或假服务端。
- 零信任代理需要手动把系统/浏览器代理指向 `127.0.0.1:8899` 验证；配置保存在 localStorage `yl.zt.config`。
- `dist/`、`src-tauri/target/`、`src-tauri/gen/schemas/` 是生成物，不要手改。