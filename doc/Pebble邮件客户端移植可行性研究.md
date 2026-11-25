# Pebble 邮件客户端移植可行性研究

研究日期：2026-11-25。源码基线：`ee291693bda113767b59bbd291288084801e4a50`（master 本次快照，包版本 0.1.6）。本报告检查源码、依赖与本仓接入点；未编译 Pebble，未使用生产凭证，未连接越秀邮箱，未验证真实收发。下文“已有实现”表示有实际源码链路，不表示已经通过本项目实测。

## 结论与前置条件

**技术上可移植，推荐复用 Rust 邮件核心和必要的调度逻辑，在 YX 内用 Vue 重写界面；不建议把整个 Pebble 应用嵌进来。** 两边都是 Tauri 2，原生运行时接近；Pebble 前端是 React 19、Zustand、TanStack Query，不能直接当 Vue 组件使用。其源码已包含 IMAP/SMTP、POP3、Gmail API、Microsoft Graph、本地同步、MIME 解析、附件、搜索和隐私清洗，具有实质复用价值。[依赖清单](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/package.json)、[Rust 工作区](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/Cargo.toml)、[邮件模块](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/lib.rs)。

“做一个通用邮箱客户端”与“接入越秀企业邮箱”是两个问题。前者已有较好的实现基础；后者尚有决定性缺口：本仓逆向资料只确认原版邮箱入口 `https://coremail.yuexiu.com/cmcuapi/yxsso/oauth2`，它是 Coremail 单点入口，不能据此推出 IMAP/SMTP 地址、开放状态或认证方式。**不能把 YX AccessToken 直接当邮箱密码，也不能承诺无感登录。** 依据：[本仓原版模块记录](../yx-cloud-kb/repo/analysis/report.md)（约第 549 行）。

先确认目标邮箱是否开放 IMAP/SMTP、TLS/STARTTLS、内外网可达性、邮箱用户名、独立密码/客户端授权码，以及是否必须走专用 Coremail 接口。若只能走 Webmail SSO，Pebble 的协议核心不能直接解决接入问题；可先保留外部浏览器入口，另做协议适配研究。

## 可复用实现及实际边界

| 能力 | 源码情况 | 移植判断 |
| --- | --- | --- |
| IMAP 收取和同步 | `imap.rs`、`sync.rs` 有连接、目录、UID 游标、UIDVALIDITY 变化恢复、旗标与删除对账、CONDSTORE 优化；另有实时触发与轮询调度 | 第一阶段最值得复用，不能只复制一个 Provider |
| SMTP 发信 | lettre 实现文本/HTML、多收件人、抄送密送、回复头和附件；由 compose 命令调用 | 可复用，但须验证服务端已发送目录策略和发信不确定状态 |
| MIME/附件 | mail-parser 解析，附件落盘，阅读时处理 CID 图片 | 可复用；与聊天对象存储上传是不同链路 |
| POP3 | 有实际协议与同步工作器，远程移动明确不支持，能力不等于 IMAP | 非越秀首期需要，不建议顺便引入 |
| Gmail/Outlook | 分别实现 Gmail API、Graph 以及增量同步；桌面 OAuth PKCE、刷新凭证逻辑在其他模块 | 通用多邮箱后续考虑；上游 README 将 Outlook 标为实验性，不视为企业 Exchange/Coremail 通用适配 |
| 草稿 | 有本地草稿及 Gmail/Outlook 远端草稿；IMAP 远端草稿明确返回不支持，含内联附件的草稿编辑也有限制 | 首期明确“本地草稿”，不要承诺跨设备草稿同步 |
| 搜索/规则 | Tantivy 全文索引、索引补偿队列、规则引擎 | 可后置，避免首期一次引入整个工作流 |
| 阅读隐私 | Rust ammonia 清洗/跟踪图片处理，前端 DOMPurify 再清洗，Shadow DOM 隔离样式 | 可借鉴清洗策略，但 Shadow DOM 不是安全沙箱 |

对应来源：[IMAP 同步](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/sync.rs)、[IMAP 协议](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/imap.rs)、[SMTP](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/smtp.rs)、[发送命令](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src-tauri/src/commands/compose.rs)、[解析器](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/parser.rs)、[POP3 Provider](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/provider/pop3_provider.rs)、[Gmail](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/provider/gmail.rs)、[Outlook](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/provider/outlook.rs)、[草稿](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src-tauri/src/commands/drafts.rs)、[索引补偿](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-store/src/search_pending.rs)、[隐私清洗](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-privacy/src/sanitizer.rs)。

一个容易低估的移植坑：`MailProvider` trait 看起来是统一接口，但 IMAP 的 `fetch_messages()` 拉取后仍返回空列表、`sync_changes()` 也返回空变更，发送和移动要求走专用实现；POP3 包装亦有空返回。**不能只拿 trait 和 Provider 就认为收发同步完成。** 真正工作链路包含 `SyncWorker`、`sync_cmd.rs`、`AppState`、事件和消息命令分发，需要一起理解后裁剪。[IMAP 包装实现](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/provider/imap_provider.rs)、[同步命令](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src-tauri/src/commands/sync_cmd.rs)、[应用状态](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src-tauri/src/state.rs)。

## 与 YX 的适配点

1. **原生核心复用，前端重写。** 建议独立 `mail` 原生模块管理账户、连接、同步、收发，暴露有 `mail_` 前缀的 Tauri 命令和事件；前端按现有 Vue/Pinia 组织邮箱服务、状态与页面。首期只做目录、列表、正文、写信、回复、附件与本地草稿，不带入看板、翻译、WebDAV 等旁支。YX 当前没有邮件实现，参考入口为 [路由](../YX/src/main.ts)、[Rust 注册](../YX/src-tauri/src/lib.rs)。
2. **数据库必须隔离迁移。** YX 的 [db.rs](../YX/src-tauri/src/db.rs) 已用 `PRAGMA user_version` 维护配置表；Pebble 也有自己的全库迁移编号。建议在 YX 数据目录创建独立邮件数据库及附件子目录，避免把 Pebble 的初始化/迁移直接跑到 YX 配置库里。Pebble Store 还依赖连接池，不是现有 Connection 的直接替换。[Store](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-store/src/lib.rs)、[迁移](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-store/src/migrations.rs)。
3. **先统一 SQLite 依赖。** YX 使用 `rusqlite 0.40 bundled`，Pebble 是 `0.39 bundled`、`r2d2_sqlite 0.33`，pebble-core 也可依赖 rusqlite。两个版本可能引入同一 `links=sqlite3` 的不同 libsqlite3-sys，不能假定 Cargo 可并存。需统一版本并联动调整连接池依赖，再以 Cargo 解析和编译验证；不是简单增加 path dependency。[YX 依赖](../YX/src-tauri/Cargo.toml)、[Pebble 工作区](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/Cargo.toml)、[Store 依赖](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-store/Cargo.toml)。tokio 1、reqwest 0.12、Tauri 2 的主版本则相近。
4. **HTTP 工程约定需显式处理。** YX 当前规定 HTTP 走 plugin-http（已有上传例外）；Pebble 的 Gmail/Graph/OAuth 在 Rust 使用 reqwest。若复用这些部分，应明确修改项目约定、建立仅用于邮件的后端网络边界，或改造传输接口，不能默默绕过规定。纯 IMAP/SMTP 是 TCP/TLS，不是 HTTP，不受这条 HTTP 规则约束。新增前端 HTTP 域名仍要同步 capability；不要因为后端 reqwest 不经过该白名单就忽略访问控制。[OAuth 实现](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-oauth/src/lib.rs)。
5. **账号、生命周期与通知归 YX 统一管理。** 邮箱账户要绑定发起时的 YX 用户身份；退出/切换账号先停止旧同步，阻止迟到事件写入新账号，邮件凭证、缓存和未读不可串号。YX 已有常驻窗口、托盘及 IM 未读，复用它们聚合邮件未读，不复制 Pebble 的整套应用启动/托盘/退出注册。Pebble 的同步停止句柄与 OAuth 账号锁可借鉴，但其独立邮箱多账户模型不能自动代替 YX 会话隔离。[同步状态](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src-tauri/src/state.rs)、[同步启停](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src-tauri/src/commands/sync_cmd.rs)、[YX 踩坑记录](../LESSONS.md)。

## 认证、存储与安全上的必要调整

- Pebble 普通 IMAP 配置是 username/password，在连接中调用 IMAP LOGIN；SMTP 使用单独配置的凭证。Google/Microsoft OAuth 是各自 API 接入，不证明已支持 Coremail 的 OAuth、IMAP XOAUTH2 或企业单点票据。若越秀要求其他机制，必须新增适配。桌面 OAuth 已有 PKCE、state 校验、回环回调和刷新流程，但需要项目自己的应用注册配置。[IMAP](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/imap.rs)、[SMTP](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/smtp.rs)、[OAuth 命令](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src-tauri/src/commands/oauth.rs)。
- 凭证使用 AES-GCM 加密，设备密钥存 OS keyring；移植时替换 `com.pebble.email` 服务名，不能与原版 Pebble 共用密钥槽。正文在 SQLite `body_html_raw/body_text`，搜索索引与附件也在本地：**凭证加密不等于整库或邮件内容加密**。需要明确本地缓存保留和退出后的可访问策略。[加密服务](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-crypto/src/lib.rs)、[密钥槽](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-crypto/src/keystore.rs)、[数据库结构](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-store/src/migrations.rs)。
- 上游正文组件使用开放 ShadowRoot 和清洗后的 `innerHTML`，不是 iframe。YX 主 WebView 有原生桥接且 CSP 允许内联脚本，不能将这套显示代码原样视作安全隔离。建议正文采用单独、无脚本权限的沙箱文档，验证无法读取宿主存储或调用 Tauri；外链由宿主校验后打开，远程图片默认阻断，并测试 CSS、SVG、事件属性、危险 URL 和跟踪请求。[正文组件](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src/components/ShadowDomEmail.tsx)、[前端清洗](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/src/lib/sanitizeHtml.ts)、[YX CSP](../YX/src-tauri/tauri.conf.json)。这里是移植设计要求，不是已经证明上游存在可利用漏洞。
- SMTP 构建附件使用 `std::fs::read` 全量读取再组 MIME，不能宣称恒定内存或天然支持大附件。优先传本地路径，WebView 选取文件则沿用原始字节分片暂存思路，避免大文件变 JS 数字数组；同时明确大小上限、测量 Rust 内存峰值，后续再决定是否改造 MIME/发送流式处理。原有聊天 `store_upload_*` 的 HTTP 提交并不能直接拿来发 SMTP。[SMTP 附件实现](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/smtp.rs)（约第 543 行）、[YX 上传记录](../LESSONS.md)。
- 上游允许无加密连接和忽略证书校验等兼容选项。YX 首期应默认严格 TLS，不复制不安全默认配置；企业自签证书应先确认信任链方案。[连接安全类型](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-mail/src/imap.rs)。

## 许可证边界

Pebble 根目录是 **AGPL-3.0**；本次检查的核心 crate 清单没有给出另一个宽松许可，不能把 Rust crate 当作 MIT/Apache 独立库使用。[许可证原文](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/LICENSE)、[核心 crate 清单](https://github.com/QingJ01/Pebble/blob/ee291693bda113767b59bbd291288084801e4a50/crates/pebble-core/Cargo.toml)。YX 根目录本次未找到 LICENSE/COPYING，不能假设已满足兼容条件。

直接复制、修改、链接上游代码前，应确定 YX 的分发对象、项目许可与源码交付安排。许可证第 5、6 条涉及修改版本和目标代码分发的条件，第 13 条涉及修改后程序的远程网络交互；不能简化成“只要桌面程序就没有义务”或“只连邮件服务器就必然要向服务器方公开所有代码”。具体组合是否构成受覆盖作品与合规范围，应按实际分发和组合方式确认；本报告不作确定法律判断。若不能接受适用条件，可只参考协议/行为独立实现，或联系权利人获取其他许可，而非通过拆出 crate 来规避。

## 推荐实施顺序与验收

| 阶段 | 工作范围 | 可观察验收标准 |
| --- | --- | --- |
| 0：接入验证 | 确认许可方案；经授权取得邮箱协议配置，以专用测试账户验证 IMAP/SMTP，或确定只能走 Coremail API | TLS 连接、目录枚举、读取一封测试邮件和收件箱确认一封测试发信；明确认证与已发送保存策略。未通过就不开始大规模移植 |
| 1：最小收发 | 整合版本与独立 Store、同步生命周期；Vue 目录/列表/正文/写信；严格 TLS、隔离正文和凭证存储 | YX 原有 `pnpm build` 通过，新增 Rust 模块编译通过；真实流程在 `pnpm tauri dev` 验证，重启可续读、退出切换不串号、一次发信只产生一封 |
| 2：可靠性 | 附件、CID、回复/转发、本地草稿、读未读/移动/删除、断线补偿、未读聚合 | 服务端与本机旗标/目录一致；断线、UIDVALIDITY 改变和发送结果未知不造成丢信或重复发送；大附件内存有可接受上限；恶意 HTML 无宿主权限 |
| 3：按需扩展 | 搜索、规则、多邮箱、Google/Microsoft、远端草稿等 | 各 Provider 单独实测，不将某一家成功推广为全部邮箱兼容 |

不在没有邮箱协议配置和可用测试账号时承诺工期；主要不确定性是 Coremail 接入与授权方式，其次是同步调度裁剪、原生依赖协调及正文隔离。就技术路径而言，值得做一个“先通企业邮箱协议，再裁剪核心、重写 Vue 界面”的小范围验证，暂不需要移植整个 Pebble。
