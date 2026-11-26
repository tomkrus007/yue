# 本地 MCP 服务（AI 能力扩展）

## 1. 定位

客户端内置一个 **MCP（Model Context Protocol）服务器**，让外部 AI Agent（Claude Code、Cursor、自研 agent 等）通过标准 MCP 协议读写本地邮件数据。UI 文案直接暴露了这个定位：

```
LANG_AI_MCP_SETTING=AI能力扩展
LANG_AI_MCP_ENABLE=启用
LANG_AI_MCP_PORT=端口:
LANG_AI_SKILLS_DIRECTORY=skills目录:
LANG_AI_AGENT_USAGE_WARNING=使用此功能将允许 AI 访问以下内容：账号信息、文件夹、邮件正文、
    通讯录、日程及标签。请注意：授权属于您的个人决定，我们建议仅在信任该工具的前提下继续。
    数据使用风险由您自行承担。
```

三个设置项（**启用 / 端口 / skills 目录**）说明它是"**用户显式开启 + 自定义端口 + 挂载 skills 目录**"的设计——skills 目录就是 `Contents/MacOS/app/skills/`（或用户自己指过去）。

---

## 2. 实现组件

| 符号 | 职责 |
|---|---|
| `CoremailEngine::MCPSvr`（单例，`ara::singleton`） | MCP 服务主体 |
| `MCPSvr::init` / `MCPSvr::start` | 初始化与启动（带端口参数） |
| `MCPSvr::addTools(...)` | **注册工具** |
| `MCPSvr::Tools` | 工具描述（名称、参数 schema、结果名映射） |
| `MCPSvr::Tools::Argument` | 单个参数 |
| `CoremailEngine::MCPData`（单例） | 会话数据/请求上下文 |
| `MCPData::sseRequest(...)` | **SSE 请求处理** |
| `AIMCPSetting`（单例） | 配置：`EnableAIMCP` / `AIMCPPort` |
| `Plugin::initMCPSvr` | 由插件层挂载 |
| `CoremailEngine::_convertResult` | 结果转换（内部结构 → MCP 响应） |

### 2.1 工具描述 DSL

`MCPSvr::Tools` 有一套**参数构造辅助**，说明 schema 是程序化构建的：

```cpp
Tools::string_arg / number_arg / enum_arg
Tools::array_string_arg / array_number_arg / array_enum_arg
Tools::default_arg
Tools::_arg
Tools::changeArgNameToLocalName   // MCP 参数名 → 内部参数名
Tools::changeResultName           // 内部字段名 → MCP 结果名
Tools::setResultNameChange
```

`changeArgNameToLocalName` / `changeResultName` 这两组映射很关键：**MCP 对外暴露的是 AI 友好的蛇形命名（`mail_id`、`start_time`），内部是 C++ 的驼峰/业务命名**。两层命名解耦，避免把内部结构直接泄漏给 AI。

---

## 3. 协议实现（标准 MCP over SSE）

从字符串证据可确认实现了 MCP 的 **HTTP+SSE 传输**（这是 MCP 2024-11 规范里的 transport）：

| 字符串 | 出现次数 | 含义 |
|---|---|---|
| `text/event-stream` | 2 | SSE Content-Type |
| `/messages` | 3+ | SSE 模式下客户端 POST 消息的端点 |
| `notifications/initialized` | 1 | MCP 握手第三步 |
| `tools/list` | 1 | 列工具 |
| `tools/call` | 1 | 调工具 |
| `jsonrpc` | 1 | JSON-RPC 2.0 封装 |

**推断**的握手流程（标准 MCP SSE transport）：

```
1. GET  /sse            → 服务端保持长连接，先推 endpoint 事件告知 POST 地址
2. POST /messages?sessionId=...  {method:"initialize", ...}
3. POST /messages        {method:"notifications/initialized"}
4. POST /messages        {method:"tools/list"}
5. POST /messages        {method:"tools/call", params:{name, arguments}}
   结果通过第 1 步的 SSE 连接推送回来
```

**推断**：`MCPData::sseRequest` 就是第 5 步的"把结果写回 SSE 流"的方法。

### 3.1 未发现 `prompts/list` / `resources/list`

二进制里只出现 `tools/list`、`tools/call`，**没有** `prompts/*` 或 `resources/*`。说明这是一个**纯 tools 型 MCP server**，不实现 MCP 的 prompt 模板与资源订阅能力。

---

## 4. 暴露的工具（3 个）

工具名从二进制与 `locale/mcpdef.en.js` 双重确认：

| 工具 | 参数 | 说明 |
|---|---|---|
| `mail_search` | `pattern`、`start_time`、`end_time` | 搜索邮件 |
| `get_mail` | `mail_id`、`type`（html/text/json）、`offset`、`size`（默认 32K） | 读邮件正文 |
| `compose_mail` | `to`、`cc`、`bcc`、`subject`、`body`、`body_type`（html/text） | 写信（唤起写信界面） |

### 4.1 参数说明原文（`locale/mcpdef.en.js`）

```json
"func_mail_serch": "Performs a email search using the Coremail Air Search API,
    ideal for general queries, and email summary. ...",
"param_mail_serch_start_time": "search the email which is sent after this time.
    param format is YYYYMMDDHHMMSS ... default value is empty",
"func_get_mail": "Performs read a email html body content by the mail_id",
"param_get_mail_size": "Specify the size limit for reading message content, default is 32K",
"func_compose_mail": "Performs compose a mail",
"param_compose_mail_body_type": "Specify the email body type, html or text. default is text"
```

**注意拼写**：键名是 `func_mail_serch`（漏了 `a`），不是 `search`。这是原文如此，说明这套定义是**手写的**、且**已冻结**（改键名会破坏兼容）。

同时暴露了一个重要信息：搜索走的是 **"Coremail Air Search API"** ——`Air` 是 Coremail 的产品线代号（`privatization-setting.js` 里的 `key: "public-version-air"` 也印证）。

### 4.2 工具的实现桥接

```
Plugin::CoremailEngineMCP_searchMail   (28 符号)
Plugin::CoremailEngineMCP_readMail
Plugin::CoremailEngineMCP_composeMail
```

**推断**：MCP 工具不直接操作存储，而是**调用与 GUI 相同的引擎方法**，因此行为与客户端内操作一致（同样的权限、同样的加密解密、同样的索引）。

### 4.3 结果字段改名

`changeResultName` + `setResultNameChange` 说明返回给 AI 的 JSON 字段经过重命名。对照 `get_mail` 的 `json` 类型描述（"will contain more information of the mail, such as attachment list, sender info, recipient info"），**推断**结果结构大致为：

```json
{
  "mail_id": "...",
  "subject": "...",
  "from": {...},
  "to": [...],
  "attachments": [...],
  "body": "...",
  "flags": "1234567890123"   // 64 位，字符串形式避免精度丢失
}
```

---

## 5. 与本地 SDK 的关系

| 维度 | 本地 MCP | 本地 HTTP SDK |
|---|---|---|
| 协议 | MCP (JSON-RPC 2.0 over SSE) | 自定义 `POST /sdk?func=` |
| 端口 | 用户可配（`AIMCPPort`） | 文档写 11328（见 `coremail/10`） |
| 工具/接口数 | 3 | 15 |
| 面向 | AI Agent（LLM 直接调用） | 脚本/程序（TypeScript、curl） |
| 开关 | `EnableAIMCP` | 推测同一开关或独立开关 |
| 鉴权 | 未见 token 校验（**推断**绑 127.0.0.1 + 用户显式开启） | 同 |

**关键推断**：两者**共用 `Plugin_CommandServer_Http` 的 HTTP 服务栈**，只是路由不同（`/sdk` vs `/sse`+`/messages`）。`Plugin_CommandServer::onSSOAuthCallback` 的存在说明未来可能给两者加统一的授权层。

---

## 6. 安全评价（基于可观测事实）

**正面**：
- 默认关闭（`EnableAIMCP` 需用户手动开）；
- 使用时弹出明确的授权警告，**逐项列出**会被访问的数据类型；
- 端口可自定义（避免固定端口被扫描）。

**风险**：
- **未发现鉴权 token**。如果只绑 `127.0.0.1`，同机任意进程（含浏览器里的恶意网页，通过 DNS rebinding/CSRF）都可能调用；
- MCP 的 SSE 端点若未校验 `Origin`，浏览器可跨站发起 POST（SSE 是 GET，但 `/messages` 是 POST，需要 CORS 保护）；
- `compose_mail` 只"唤起写信界面"而非直接发送——这是一个**有意的安全缓冲**（需人工点发送）。

**未确认**：是否有 `Origin` 校验、是否有会话 token、是否只绑回环地址。

---

## 7. 未确认项

- MCP 服务默认端口（二进制里没有 `11328` 或类似常量；`AIMCPPort` 只能来自设置）。
- SSE 端点具体路径（`/sse` 未直接出现，只有 `/messages`）。
- 是否实现 `initialize` 之外的 MCP 能力协商字段。
- `LANG_AI_SKILLS_DIRECTORY` 指向的 skills 目录**是给谁读的**——是给外部 agent 读，还是客户端自己启动 agent 时用（**推断**后者：客户端可能内置一个"AI Agent"面板，加载 skills 目录里的 skill 定义）。
