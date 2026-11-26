# Coremail 邮箱客户端 V4.0（macOS）技术分析

> 对象：`/Applications/Coremail邮箱客户端软件V4.0.app`（v4.2.3，arm64）
> 方法：静态证据分析（Mach-O、符号表、字符串、bundle 资源、随包 TypeScript/JS 源码）。
> **未进行函数体反编译**，所有涉及内部逻辑的结论均标注为"推断"。
> 全部文档为中文，证据与局限见 [`14-证据与局限.md`](./14-证据与局限.md)。

---

## 一句话概览

一个**原生 C++ 邮件引擎（`CoremailEngine`）+ wxWidgets 外壳 + CEF 109 网页视图**的重型桌面邮件客户端。日历、通讯录、过滤器、归档的代码量不比邮件本体少；同时内置 **AI 助手**、**本地 MCP 服务**、**本地 HTTP SDK** 三个面向 AI Agent 的能力面。

**它不是 Electron 套壳**：Chromium 只负责读信/写信/日历等富内容视图，邮件列表是 wxWidgets 自绘控件。

---

## 身份速查

| 项 | 值 |
|---|---|
| 版本 | 4.2.3 |
| Bundle ID | `cn.coremail.cmclient.dmg` |
| 主类 | `wxNSApplication`（wxWidgets） |
| CEF / Chromium | 109.1.18.0 / 109.0.5414.x |
| 引擎 | `CoremailEngine`（`MailEngine` 符号 17,492） |
| 架构 | 仅 arm64，minOS 11.0，SDK 15.5 |
| 大小 | 374 MB（主二进制 114.8 MB） |
| SHA-256 | `6f746f263ba7ee1b7bdf53626640feb9b19383db0df02d88f75d96cb8ccf3c08` |
| 签名 | hardened runtime，Team `L9XSHVJ7KF` |
| 加密 | OpenSSL 3.4.1 + GmSSL 3.1（SM2/3/4）+ S/MIME |

---

## 十个最重要的发现

1. **CEF 是运行时 dlopen 的**，主二进制里的 2,940 个 `Cef*` 符号是 C++ wrapper，真正的 Chromium 是 `Frameworks/` 下 160 MB 的 framework（`otool -L` 里看不到 CEF 即可证明）。

2. **界面是混合的**：主窗/列表/树是 wxWidgets 原生（含自绘富文本标记 `<TEXT TYPE=3>`），读信/写信/日历/会议预约/AI 面板是 CEF 加载 `app/template/` 下的本地 HTML/JS。

3. **JS↔原生桥是 `window.CM(func, jsonString)`**，请求-响应用 `funcN` 动态回调配对，已在 `template/utils/callPC.js` 完整还原（见 `02` 章）。

4. **四套协议并存**，私有协议优先（符号量是 IMAP 的 3.3 倍）：`ProtocolContext_Coremail` / `Imap` / `Pop3` / `EWS`（含 Autodiscover 与 EWS Push），另有 **Socket.IO** 实时通道（`socketio_client.cpp` 调试路径出现 272 次，全工程最高）。

5. **本地存储三层**：sqlite3mc（多密码算法 + 自研 codec，`.dat/.edat/.sdat` 三态）+ 邮件文件级 SM4/AES 加密（`MailStorageEncode`）+ Xapian Glass 全文索引（cppjieba 中文分词）。

6. **国密与合规是主线**：GmSSL 3.1、SM2 设备证书登录、CM-SM"应用证书"自签体系、`signAsRed` 红头签名、"严禁处理国家秘密"提示、UOS/麒麟定制 CSS。

7. **AI 有 10 个 provider 子类**（OpenAI/Azure/DeepSeek/Moonshot/SiliconFlow/Qwen/Spark/Ollama/openailike/麒麟 Kart）+ 2 个官方托管（Coremail Assistant / Lunkr Assistant），并**按账号授权**、**按 token 计费埋点**。

8. **内置 MCP 服务器**（`MCPSvr`，SSE 传输），暴露 3 个工具 `mail_search` / `get_mail` / `compose_mail`，设置项为"启用 / 端口 / skills 目录"，并弹出明确的 AI 授权警告。

9. **本地 HTTP SDK 有 15 个接口**（`http://127.0.0.1:11328/sdk?func=`），随包附带一个**完整可运行的 TypeScript 工程** `app/skills/`（含 `CLAUDE.md`），定位就是"给 AI 用的 skill"。

10. **若干安全面值得注意**：`NSAllowsArbitraryLoads=true`；内置含明文 `imap://`/`smtp://` 预设；本地服务未见鉴权 token；Xapian（GPL-2.0+）静态链接进闭源商业软件。

---

## 文档索引

| 文件 | 内容 |
|---|---|
| [`01-总览与身份.md`](./01-总览与身份.md) | 版本、签名、包结构、构建来源（含 Jenkins 路径泄露） |
| [`02-运行时架构.md`](./02-运行时架构.md) | 进程模型、wx 与 CEF 分工、JS↔原生桥全解 |
| [`03-邮件引擎与协议栈.md`](./03-邮件引擎与协议栈.md) | 四套协议、推送通道、同步模型、服务端 `func=` 接口、内置服务商预设 |
| [`04-本地存储与索引.md`](./04-本地存储与索引.md) | sqlite3mc、邮件加密、Xapian Glass、分词、归档 |
| [`05-加密与安全.md`](./05-加密与安全.md) | SM2/3/4、S/MIME 三引擎、应用证书、设备证书、配置防篡改 |
| [`06-账号登录与SSO.md`](./06-账号登录与SSO.md) | 两步登录、2FA、CMS SOO 状态机、多账号模型 |
| [`07-业务功能面.md`](./07-业务功能面.md) | 日历、联系人、过滤器、群发、撤回、归档 |
| [`08-AI助手.md`](./08-AI助手.md) | AIHub、provider 矩阵、`aiCall` 协议、token 埋点 |
| [`09-本地MCP服务.md`](./09-本地MCP服务.md) | MCP 工具、SSE 握手、配置键、安全评价 |
| [`10-本地HTTP-SDK与Skills.md`](./10-本地HTTP-SDK与Skills.md) | 15 个接口全表、数据结构、64 位标志位、随包 TS 工程 |
| [`11-插件体系与IM.md`](./11-插件体系与IM.md) | `Plugin_*` 家族、CIM/Lunkr/企业微信、跨平台缺陷 |
| [`12-配置更新与遥测.md`](./12-配置更新与遥测.md) | 四层配置、升级链、崩溃上报、LA 埋点协议 |
| [`13-依赖与许可.md`](./13-依赖与许可.md) | 链接模型、OSS 清单、版本矩阵、合规风险 |
| [`14-证据与局限.md`](./14-证据与局限.md) | 证据 ID、方法论边界、推断分级、后续建议 |

---

## 阅读建议

- **想了解架构**：`01` → `02` → `03`
- **想做安全评估**：`05` → `06` → `09` → `10` → `12`
- **想接 AI / 做自动化**：`08` → `09` → `10`
- **想做复刻**：`02`（桥协议）→ `04`（存储）→ `10`（数据结构）是本项目最有复用价值的三章

---

## 重要提醒

本报告基于**静态证据**。凡标注为"推断"的结论（如私有协议帧格式、SQLite codec 算法、本地服务是否鉴权、MCP 默认端口）都**未经运行时验证**，引用时请保留该限定。详见 [`14`](./14-证据与局限.md) 第 4 节的分级清单。
