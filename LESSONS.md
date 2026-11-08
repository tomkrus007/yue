# LESSONS

记录在本项目中反复出现、值得复用的问题与结论。

## 关闭窗口与退出应用应分开处理

- **旧行为**：未拦截关闭事件时，关闭最后一个窗口会让应用和 `tauri dev` 进程正常退出，不代表崩溃。
- **当前行为**：主窗口通过 `CloseRequested` 隐藏并阻止销毁，保留 WebView、IM 连接及后台服务；开发模式和打包版本均适用。
- **恢复与退出**：托盘点击或“显示主窗口”菜单恢复窗口；macOS 点击 Dock 图标也能恢复。托盘“退出应用”和 macOS 的系统退出操作用于真正结束进程，不拦截应用退出事件。
- **验证**：Rust 改动需要重启原生进程后生效。关闭窗口后应仍有进程，恢复后会话和草稿应保留；明确退出后进程才结束。

## 登录后在"用户信息接口"上阻塞导致不跳转

- **现象**：登录成功但页面不跳转。
- **原因**：store 中 `await authService.getCurrentUser()` 阻塞；当该接口慢或挂起时登录 Promise 永不 resolve。
- **应对**：登录主流程只依赖 token 获取，用户信息等附加请求一律异步/带超时，不得阻塞路由跳转。

## 登录成功后被弹回登录页（自动登录时无限循环）

- **现象**：账号密码验证通过、token 已写入，但页面立刻回到登录页；勾选“自动登录”时登录页反复闪现。
- **原因**：`useAuthStore` 里 `isLoggedIn = computed(() => authService.isLoggedIn())`，computed 内部只读 localStorage、没有任何响应式依赖。`App.vue` 启动时先读了一次（此时未登录）→ 结果被永久缓存为 `false`；登录成功后 `ChatView`/`DiskView` 再读仍是 `false`，于是 `router.replace('/login')`，自动登录又发起下一次登录，形成死循环。
- **应对**：登录态必须存成 `ref`（见 `stores/auth.ts` 的 `token`/`expiresAt` + `syncSession()`），登录、退出、刷新 token 后同步；不要在 computed 里直接读 localStorage。另：`expires_in` 缺失时 `expires_at` 要写 0（视为未知），不能写 `Date.now()`，否则会被当成已过期。
## 应用图标设计与开发模式验证

- 用户提供明确的 SVG 参考时，以该 SVG 为源文件，仅修改指定图形；字母标识使用路径，避免字体依赖。
- 应用图标源文件为 `YX/app-icon.svg`，通过 `pnpm tauri icon` 导出 PNG、ICNS、ICO；系统托盘使用默认窗口图标，也应同步更新。
- macOS 开发模式将 ICNS 嵌入可执行文件。仅更新图片、运行 `cargo check` 或前端构建不足以确认生效；`build.rs` 必须追踪 `icons` 目录，并通过 `cargo build` 验证新 ICNS 已嵌入程序。

## 云盘写操作必须走 panServerUri（`/pan/v1`）

- **现象**：`/openapi/file/delete`、`/file/mkdirs`、`/file/move`、`/file/copy` 返回 `400 app.ex.666`「您当前使用的客户端版本需要升级」，而 `file/list`、`file/info` 等读接口正常。
- **原因**：旧 openapi 写接口已退役；改 `appVersion`/`Pan-Version`/`appId`/UA/IP 等请求头均无效，不是参数问题。
- **做法**：目录与写操作改走 `panServerUri`（`https://pan.bingolink.biz/pan`）的 `/v1/directories/*`、`/v1/files/*`；`access_token` 放 query。个人/团队/部门/公开文档的 `dirId` 分别是 `CurrentUserId` / teamId / orgId / classId。该接口与「群聊 → 任务与文档 → 团队文档」相同。
- **参数坑**：文件与目录的写接口参数不统一——删除目录是 query `dirId`，删除文件是 JSON `{ids:[fileId]}`；重命名目录 `{dirId,name}`，重命名文件 `{id,name}`；移动目录 `{dirId,targetParentId}`，移动文件 `{ids:[fileId],targetParentId}`。文件接口传错字段会报 `Parameter parsing failed` 或 430004。

## 云盘上传走对象存储 + share/document

- 官方磁盘上传走本地 Go 服务或 `/v1/sign/upload`，签名 URL 指向 `zs3.yuexiu.com`（内网域名，当前网络不可解析）。
- 复刻版改用与聊天附件相同的存储链路：`POST {storeUri}/store/putFile?module=message&security=0` 拿 `r.fileId`，再 `POST {storeUri}/v2/{fileId}/share/document` 表单提交 `id` + `dirId`，文件即出现在目标文档目录。
- `share/document` 必须用 `application/x-www-form-urlencoded`；JSON 会返回 `api.params.invalid`（HTTP 仍是 200，需解析 body 的 `code`）。

## 执行命令前固定工作目录

- 仓库根目录与 `YX/` 的相对路径不可混用：在 `YX/` 执行命令时，文件路径应为 `src/...`、`scripts/...`，不要再加 `YX/` 前缀。
- 编辑与验证分开执行，并给每次命令显式指定工作目录；`pnpm build` 和前端回归脚本统一在 `YX/` 运行，避免生成嵌套目录或在根目录找不到脚本。

## 待办动作解析与禁用状态

- 消息中的「查看待办」按用户要求直接打开该条详情，不照搬官方的列表入口。没有直链或条目 ID 时，在后台按来源与完整标题唯一匹配；同名歧义时明确提示，不能随意打开第一条。
- 官方待办的 `action` 解析兼容 JSON 和对象字面量，不能仅用 `JSON.parse`；接口已返回对象时也应直接解析其 `pc` / `android`。对象字面量使用 JSON5 数据解析，不复制官方的 `eval` 回退。
- 仅以标准 JSON 字符串作为模拟响应，会漏掉「列表加载成功、打开按钮却被禁用」的问题。离线回归需覆盖对象、JSON、对象字面量、真实及字面量换行，并检查列表项最终能生成地址。
- 缺少可用链接时显示原因；不要只把按钮置灰，让用户无法判断是数据缺失还是功能故障。离线回归通过不代表生产 CAS 链路已验证。
- 待办查询与 SSO 建会话的 query 凭证需在每次请求时生成；401 刷新后同时更新请求头和 `access_token` 参数，不能重用带旧 token 的 URL。失败提示应区分详情查询、登录票据兑换和浏览器打开阶段，并隐藏请求地址中的凭证。
- `plugin-opener.openUrl` 已调用系统默认浏览器；浏览器没出现也可能是前置 CAS 请求失败。已解析出详情地址时，自动登录失败应降级为外部打开原始详情，并提示可能需要登录，不能让票据错误阻断打开页面。
- 通知指定分类中已唯一匹配时立即使用该详情，不再强制查询其他分类；仅在找不到时回退到待阅／已办。离线回归应覆盖「待办已找到、后续无关接口返回 HTTP 500」的阻断场景，接口错误需标明具体路径。

## 待办 CAS 免登录在本部署不可行

- 现象：按官方 `create_session → TGT → POST {casTicketUrl}{TGT} → login?token=ST` 实现后，点击「查看待办」只弹「自动登录未完成」。
- 实测：`oauth2/authorize` 只有用 `Basic clientId:clientSecret` 才成功（Bearer 必 401）；但返回的 token 域固定是 `www.bingolink.biz` 与 `linksso.yuexiu.com`，与 `/jump/cache` 给的 `casUrl`（`sso1.yuexiu.com` / `sso1.yuexiuproperty.cn`）不一致，官方 `getAppCookies(casHost)` 同样取不到值。
- 实测：两套 `casTicketUrl` 拿 JWT 当 TGT POST 都是 401；直接 `POST https://sso1.yuexiu.com/cas/v1/tickets` 返回 `Restlet-Framework` 的 400（未按 Apereo 默认方式开放 REST）；`{casUrl}/login?token=<JWT>` 的 `#STAUTHENTICATE#` 只认真实 ST，JWT / `oauth2/logintoken` 全部回「验证ST票据失败」。
- 做法：只在 token 域与 `casUrl` 主机匹配时才尝试兑换，避免发注定 401 的请求；否则直接打开该租户的 `{casUrl}/login?service=<详情>`，由浏览器复用已有 CAS 会话。整段自动登录最多等 4 秒，失败不阻止打开，也不要再复现 TGT 方案。

## 待办直接外部打开优先

- 用户已明确放弃客户端 AccessToken／CAS 免登录。解析出详情地址后立即用系统浏览器打开原始链接；不再查询 CAS 配置、创建 SSO 会话、兑换票据或预先跳转认证页。此前免登录与降级策略仅为历史记录，不应恢复。
