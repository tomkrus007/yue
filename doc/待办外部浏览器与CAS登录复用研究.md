# 待办外部浏览器与 CAS 登录复用研究

研究日期：2026-11-08。结论分为源码事实、协议事实与待实测推断；本文不声称生产免登录链路已跑通。

## 结论

可以把现有客户端登录态用于减少一次 CAS 登录，但应通过服务端支持的票据兑换桥接，不能仅给待办地址追加 `access_token` 就认为浏览器已登录。建议顺序是：客户端 AccessToken → BingoLink 的 `create_session` → CAS TGT → 目标业务的 ST → 系统浏览器打开官方客户端使用的 CAS 登录桥；桥接失败时，仍让用户在外部浏览器打开原始待办地址，复用该浏览器已有的业务或 CAS 会话，必要时由浏览器提示登录。前一条链路的存在有项目逆向证据，能否在当前租户免交互完成仍需实测。[项目逆向分析](/Users/tom/Documents/code/old/yue/doc/官方客户端待办与待阅实现分析.md)

## 当前故障与外部打开

研究开始时，`MessageContent.vue` 的 `openTodo()` 已经调用 `@tauri-apps/plugin-opener` 的 `openUrl(loginUrl)`，并没有在该路径创建 iframe 或 WebView。问题在于调用顺序：先 `await casTodoUrl(url)`，兑换失败就进入异常分支，尚未执行外部打开。因而「没有打开浏览器」不能作为「正在内嵌打开」的证据。这是修复前源码的直接事实。[消息组件](/Users/tom/Documents/code/old/yue/YX/src/components/MessageContent.vue)

Tauri 的 `openUrl(url)` 会把 URL 交给系统默认应用；HTTP(S) 地址通常交给默认浏览器。`openWith` 可指定应用，但此接口没有自定义 HTTP 请求头或写浏览器 cookie 的参数。故不必改用 `window.open` 或内部路由；应保证票据失败后仍执行外部打开，并区分「免登录桥失败」与「系统浏览器无法启动」。[Tauri Opener JavaScript 接口](https://v2.tauri.app/reference/javascript/opener/)

项目已配置 `opener:default`，其官方默认权限涵盖 HTTP(S) URL；打开浏览器本身不要求把业务域名加入 HTTP 请求白名单。只有客户端主动请求的 SSO/CAS 地址需要 HTTP 权限。[项目权限配置](/Users/tom/Documents/code/old/yue/YX/src-tauri/capabilities/default.json)、[Tauri Opener 权限说明](https://tauri.app/plugin/opener/)

## 为什么 AccessToken 不能直接替代浏览器登录

`plugin-http` 的请求由 Rust HTTP 客户端发出。本地使用的 `tauri-plugin-http 2.8.3` 源码独立维护应用缓存目录中的 `.cookies`，并把 cookie jar 传入 `reqwest::ClientBuilder`；这不是 Safari/Chrome 的 cookie 存储。由此可推知，客户端收到 `Set-Cookie` 不会自动让外部浏览器获得同一个会话。本文核对了本地版本，在线 `v2` 分支仅作为可访问的上游源码链接。[本地插件实现](/Users/tom/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-plugin-http-2.8.3/src/lib.rs)、[本地请求实现](/Users/tom/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-plugin-http-2.8.3/src/commands.rs)、[上游源码](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/http/src)

CAS 标准的浏览器 SSO 依赖浏览器提交 TGC cookie；客户端有 OAuth AccessToken 并不等于浏览器已有 TGC。只有业务明确提供「令牌换网页会话」接口，AccessToken 才能间接变成浏览器会话。项目里的 `response_type=create_session` 正是应核对的定制入口，不能把它当成所有 CAS 服务都支持的标准能力。[CAS 3.0 协议规范 §2.1](https://apereo.github.io/cas/7.3.x/protocol/CAS-Protocol-Specification.html)、[项目逆向分析第五节](/Users/tom/Documents/code/old/yue/doc/官方客户端待办与待阅实现分析.md)

## 可复用的票据流程

依据项目逆向报告，官方实现依次进行以下操作；这些是 BingoLink 实现的观测摘要，未在本次研究重新解包官方安装包。

1. 请求配置中心下发的 SSO `/oauth2/authorize`，设置 `response_type=create_session`、`responseJson=true`、客户端 ID、当前 `access_token`，必要时附加官方返回的 `cipher_token`，取得按域区分的 `tokens`。
2. 从 `{toDoUri}/jump/cache` 选择匹配业务来源的 CAS 地址与 `casTicketUrl`，按 CAS 主机名匹配 TGT；跨子域 token 应采用受约束的域后缀匹配。
3. 表单 `POST {casTicketUrl}{TGT}`，提交最终待办地址作为 `service`，获得短期 ST。该步骤与标准 CAS REST 获取 ST 的形式一致。[CAS REST 获取 ST](https://apereo.github.io/cas/7.3.x/protocol/REST-Protocol-Request-ServiceTicket.html)
4. 由系统浏览器打开官方的定制地址：`{casUrl}/login?token={ST}&service={待办地址}`。官方还会尝试集团／地产双票据，附加第二组 `token2` / `service2`。CAS 桥在浏览器内完成跳转，才有机会把相应 cookie 写入浏览器。[项目逆向分析第五节](/Users/tom/Documents/code/old/yue/doc/官方客户端待办与待阅实现分析.md)

这里需要严格区分两种 URL：标准 CAS 登录成功后的业务回调使用 `service?ticket=ST`；`cas/login?token=ST` 不是 CAS 3.0 规范所定义的通用免登录接口，而是项目官方客户端使用的扩展。不能仅凭 Apereo 文档就保证后者能用，也不能把 ST 当成长效 AccessToken。ST 绑定申请时的准确 `service`，且只能进行一次校验；地址参数改变或票据被提前消费，都可能导致失败。[CAS 3.0 协议规范 §2.2.4、§3.1](https://apereo.github.io/cas/7.3.x/protocol/CAS-Protocol-Specification.html)

仅在客户端用 REST 取 TGT/ST，不会自动创建外部浏览器的完整 SSO 会话。Apereo 明确说明 REST 调用是无状态的，调用方管理会话；浏览器 SSO 还需要浏览器端的交互与 cookie。这解释了为什么既要兑换票据，也要让浏览器访问服务端支持的登录桥。[CAS REST 获取 TGT](https://apereo.github.io/cas/7.3.x/protocol/REST-Protocol-Request-TicketGrantingTicket.html)

## 实施与验证边界

- 外部打开应始终使用 `openUrl`，免登录票据兑换失败可以降级打开原始待办链接；降级提示应说明仍可能需要在浏览器登录，不把「打开 URL 成功」当作「登录成功」。
- 长期 AccessToken 只送到受控的待办／SSO 接口，不随意附加到外部业务 URL。传给浏览器的应优先是官方协议定义的短期 ST；不要打印完整票据 URL。
- `create_session` 返回的 token 是不是可用 TGT、域名与租户匹配、票据交换返回格式、当前服务器是否接受 `token` 登录桥、是否设置浏览器 TGC、MFA 或强制重新认证策略，均需真实账号和浏览器验证。
- 当前代码中的 `cipher_token` 在登录响应类型中存在，但未见持久化使用；是否为当前服务器免登录所必需不能仅靠静态分析判定，不应凭空生成。
- 验收应先在未登录的浏览器配置中点击一条待办，确认能否不输密码进入准确详情；再测试票据获取失败时仍打开外部浏览器、浏览器已有 CAS 会话时是否复用、客户端 token 过期后能否刷新重试。测试结果不能包含真实 AccessToken、TGT 或 ST。

本次已核对 Tauri 与 Apereo 官方资料、当前项目调用链及本地 HTTP 插件源码；未请求生产 SSO/CAS 接口，未验证真实浏览器 cookie 建立过程。

## 实测复核（2026-11-08，本机真实账号）

补充一轮真实请求后的结论：**该部署无法用客户端凭证换到 ST，免登录链路到此为止**。

| 探测 | 结果 |
| --- | --- |
| `GET {sso}/oauth2/authorize` 用 `Bearer AccessToken` | 401 `access_denied`，`referral=refresh_token` |
| 同上，改用 `Basic clientId:clientSecret` + query `access_token` | 200，返回 2 个 token |
| 返回的 token 域 | `www.bingolink.biz`（`auth_token_saaslink_sso_cookie`）、`linksso.yuexiu.com`（`auth_token_yuexiu.linksso_cookie`），值均为 HS256 JWT |
| `{toDoUri}/jump/cache` | 集团：`casUrl=https://sso1.yuexiu.com/cas`、`casTicketUrl=https://gw.yuexiu.com/yuexiucas/cas`；地产：`sso1.yuexiuproperty.cn` + `gw.yuexiu.com/yuexiupropertycas/cas` |
| `POST {casTicketUrl}/v1/tickets/<JWT>`（两租户、加不加 Cookie/Bearer 都试过） | 401 |
| `POST https://sso1.yuexiu.com/cas/v1/tickets`（标准 CAS REST 建 TGT） | 400，`Server: Restlet-Framework/2.1.0`（REST 未按 Apereo 默认方式开放） |
| `GET {casUrl}/login?token=<JWT>` | 返回带 `#STAUTHENTICATE#` 的加载页；提交后统一回「验证ST票据失败，请重新登录！」 |
| `linksso` 侧 `openid.ex.get.jwt=y`（aud 试过 `jtcas`/`cas`/`link_desktop`） | 拿到的 RS256 JWT 同样过不了 `#STAUTHENTICATE#` |

关键点：`#STAUTHENTICATE#` 要求的是**真正的 CAS ST**，不是 OAuth/JWT 会话票据；而 `oauth2/authorize` 下发的 token 域与 `casUrl` 主机不一致，官方 `getCasSTTicket` 里的 `getAppCookies(casHost)` 也取不到值。也就是说官方桌面端在这个租户下同样换不到 ST，会走 `if (t) … else openMethod(e)` 的直开分支。

据此，`YX/src/services/im/todo.ts` 的最终策略是：

1. `/jump/cache` 选租户 → `oauth2/authorize`（Basic）取 tokens → 仅当 token 域与 `casUrl` 主机匹配时才尝试 `{casTicketUrl}/v1/tickets/{TGT}`，避免发注定 401 的请求；整段最多等 4 秒。
2. 换到 ST 就打开 `{casUrl}/login?token=&service=`（含 `token2`/`service2`），否则打开该租户的 `{casUrl}/login?service=<待办地址>`，由浏览器复用或建立 CAS 会话。
3. 提示语不再暴露 reqwest 原文，也不再声称「自动登录失败」，只说明首次可能需要统一认证登录。

> 补充（2026-11-28）：客户端侧已经找到可用的 CAS 会话换取方式——用桌面端 `loginTicket` 静默完成 CAS 扫码登录拿 TGT，再以 `CASTGC` Cookie 写进 WebView。本文「客户端凭证换不到 ST」的结论只对系统浏览器成立。详见 [集团CAS应用免登录打通记录](/Users/tom/Documents/code/old/yue/doc/集团CAS应用免登录打通记录.md)。
