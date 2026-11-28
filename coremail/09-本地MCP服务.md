# 本地 MCP 服务（AI 能力扩展）

> **第二版更正**：配好 Ghidra 后已反编译 `Plugin_CommandServer_Http::start` / `MCPSvr::start` / `SSESvr::init`，确认 **MCP 与本地 HTTP SDK 是同一个服务、同一个端口、同一套鉴权**，路由为 `GET /sse` + `POST /mcp`。第 5、6、7 节据此重写，完整证据见 [`15-反编译发现-Ghidra.md`](./15-反编译发现-Ghidra.md)。

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
2. POST /mcp?sessionId=...  {method:"initialize", ...}
3. POST /mcp            {method:"notifications/initialized"}
4. POST /mcp            {method:"tools/list"}
5. POST /mcp            {method:"tools/call", params:{name, arguments}}
   结果通过第 1 步的 SSE 连接推送回来
```

**已确认**（反编译）：`MCPSvr::start("mcp", server)` 把 `"mcp"` 注册进 `MCPData` 的 handler map，`SSESvr::init(..., "/sse", server)` 单独注册事件流，`SSESvr::init` 再把 map 里每个 key 拼成 `"/" + key` 注册——所以 POST 端点是 **`/mcp`**，不是 `/messages`。`/messages` 字符串在包内存在，但不在这条链路上。

### 3.0 JSON-RPC 分发器（反编译确认）

`MCPData::sseRequest(std::string const&, std::function<void(std::string&&)>&&)`（`0x1010d20c4`，证据 `ev_a3f24bcc1a3662d36c9356d4fc7ea329dc4ea63ada856036fcebc56c72ce4e12`，伪代码 152 KB）是**唯一的 JSON-RPC 入口**，内部按 `method` 字符串 `memcmp` 分发：

| method | 行为 |
|---|---|
| `ping` | 回 `{"jsonrpc":"2.0","result":{}}`（含 `id`） |
| `initialize` | 回 **`protocolVersion: "2024-11-05"`** + `capabilities`（`tools`）+ `serverInfo` |
| `notifications/initialized` | 无响应（通知） |
| `notifications/cancelled` | 无响应（通知） |
| `tools/list` | 遍历 `MCPSvr` 的 `Tools` 数组，生成 `{name, description, inputSchema}` |
| `tools/call` | 按 `params.name` 找工具 → 调 `Plugin::CoremailEngineMCP_*` → 结果包成 `{content:[{type:"text", text:...}], isError}` |

补充观测：

- 协议版本写死 **`2024-11-05`**（MCP 的首个正式规范版本），不是 `2025-03-26` 之类的新版；
- 日志 `"Request sse: %v"`；
- JSON schema 里出现 `"object"` / `"array"` 字面量，说明 `inputSchema` 是运行时拼出来的；
- 错误响应里能看到 `"App locked, accessing forbidden."` —— **应用锁会直接拦截 MCP 调用**（这是一条未被第一版记录的安全控制）。

### 3.1 未发现 `prompts/list` / `resources/list`

二进制里只出现 `tools/list`、`tools/call`，**没有** `prompts/*` 或 `resources/*`。说明这是一个**纯 tools 型 MCP server**，不实现 MCP 的 prompt 模板与资源订阅能力。分发器里也没有 `sampling/*`、`roots/*`、`logging/*`。

---

## 4. 暴露的工具（3 个）

工具名从二进制（`Plugin::initMCPSvr` 里逐字节拼出的字符串）与 `locale/mcpdef.en.js` 双重确认：

| 工具 | 参数（已确认的最小集） | 说明 |
|---|---|---|
| `mail_search` | `pattern`、`start_time`、`end_time`、`limit`；内部还读 `Policy`、`FID`、`Limit`、`Offset`、`SearchSent`、`ConditionOr`、`SortDesc`、`Begin` | 搜索邮件 |
| `get_mail` | `mail_id`、`type`（html/text/json）、`offset`、`size`（默认 8K/32K，两处文案不一致） | 读邮件正文 |
| `compose_mail` | `to`、`cc`、`bcc`、`subject`、`body`、`body_type`（html/text） | 写信（唤起写信界面） |

工具名在反编译里是栈上拼的短字符串，逐字节还原为：`mail_search`（11）、`get_mail`（8）、`compose_mail`（12），与 locale 定义的描述键 `func_mail_serch` / `func_get_mail` / `func_compose_mail` 一一对应。**工具名本身不带 `func_` 前缀**，`func_*` 只用于取本地化描述。

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

### 4.2 工具的实现桥接（反编译确认）

```
Plugin::CoremailEngineMCP_searchMail   (0x1009e8520, 77 KB 伪代码)
Plugin::CoremailEngineMCP_readMail     (0x1009eae08, 38 KB)
Plugin::CoremailEngineMCP_composeMail  (0x1009ed93c, 41 KB)
```

**这三个工具都不走 HTTP，而是直接调用本地引擎**，且**不经过** `CoremailEngineSDK_*` 那 15 个函数：

| 工具 | 调用链 |
|---|---|
| `mail_search` | `MailEngine::isOfflineMode` → `MailEngine::getProtocolSetting` → `MailEngine::getSearchEngine` → `SearchEngine::searchDoc` / `MailSearchBuilder` → `MailIndex::searchMail` → `MailIndexBuilder::dockeyToId` → `MailIndex::SearchMail::searchByMID`；地址展示用 `Mime::MailAddress::getDisplayString` |
| `get_mail` | `AccountManager::findMailEngineByAccountID` → `MailEngine::getMailIndex` → `MailIndex::findMailByMailID`；只读邮件返回 `"Mail is read-only."` |
| `compose_mail` | 直接构造一个 `std::function<void()>` 派发到 GUI（唤起写信窗口），无存储/网络调用 |

**重要含义**：

1. **`mail_search` 查的是本地 Xapian 索引**（`SearchEngine::searchDoc`），所以**只能搜到已经同步到本地的邮件**；离线模式也照常可用。这与 `Locale` 文案里说的 "Coremail Air Search API" 有出入——实际实现是**本地搜索**，不是远端 Air Search（文案与实现不一致）。
2. `get_mail` 也走本地 `MailIndex`，**不请求服务端**；因此未下载正文的邮件读不到完整内容。
3. `compose_mail` **只唤起界面、不发送**，这是有意的安全缓冲（需人工点发送）。
4. `searchMail` 里出现 `Begin` 的两种时间格式解析：`"%Y-%m-%d %H:%M:%S"` 与 `"%Y%m%d%H%M%S"`（`_strptime`），即**同时支持人类可读与紧凑时间串**——与 `mcpdef` 里 `start_time` 的 `YYYYMMDDHHMMSS` 说明一致，但实现更宽松。

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

## 5. 与本地 SDK 的关系（已由反编译确认）

| 维度 | 本地 MCP | 本地 HTTP SDK |
|---|---|---|
| 协议 | MCP (JSON-RPC 2.0 over SSE) | 自定义 `POST /?func=` |
| **端口** | **同一个**（`AIMCPPort`，默认 **11328**） | 同 |
| **HTTP server** | 同一个 `ara::http::async_server` | 同 |
| **鉴权** | 同一个 `HttpSvrAuthManager` | 同 |
| 路由 | `GET /sse`、`POST /mcp` | `POST /`（读 query `func=`） |
| 工具/接口数 | 3 | 15 |
| 面向 | AI Agent（LLM 直接调用） | 脚本/程序（TypeScript、curl） |
| 开关 | `EnableAIMCP` | **同一个** `EnableAIMCP` |

### 5.1 启动顺序（`Plugin_CommandServer_Http::start`，`0x1009ad63c`）

```
HttpSvrAuthManager::loadAuthSetting();     // 空实现
CoremailEngineSDK_Disptach::init();        // 注册 15 个 SDK 函数
async_server::add("/auth", ...);           // key 管理
Plugin::initMCPSvr();                      // 注册 3 个 MCP 工具
MCPSvr::start("mcp", server);              // 挂 /sse + /mcp
async_server::add("/", ...);               // SDK 兜底
async_server::add_port(port, "127.0.0.1", 64); start();
```

**这解释了一个产品设计上的强绑定**：用户在设置里打开"AI 能力扩展"，同时打开了 MCP 和本地 HTTP SDK。**不存在"只开 MCP 不开 SDK"的配置**。反过来，任何给 SDK 用的脚本能力也自动暴露给 MCP 客户端。

### 5.2 端口与开关的真实来源

| 项 | 来源 | 默认 |
|---|---|---|
| 端口 | `SysSettingManage.AIMCPPort`（`0x168`） | **11328**（`0x2c40`） |
| 开关 | `SysSettingManage.EnableAIMCP`（`0x166`） | **0（关）** |

`AISettingPanel::save()`（`0x1000abc3c`）里可以直接看到 UI 行为：

- 关开关 → `Plugin_CommandServer::stop()`
- 改端口 → `stop()` → `initPort(新端口)` → `start()`
- 开开关 → `start()`

`CMClientApp` 启动段：`if (AIMCPPort != 0) initPort(AIMCPPort); if (EnableAIMCP == 1) start();`

### 5.3 绑定地址

`async_server::add_port(port, "127.0.0.1", 0x40)` —— **只绑回环地址**（`0x2e302e302e373231` = `127.0.0.1`），不是 `0.0.0.0`。这消解了第一版"是否只绑回环"的未确认项。

---

## 6. 安全评价（反编译后修订）

**正面**：

- 默认关闭（`EnableAIMCP` = 0）；
- 只绑 `127.0.0.1`；
- 使用时弹出明确的授权警告，逐项列出会被访问的数据类型；
- `compose_mail` 只唤起写信界面，不直接发送（人工确认缓冲）。

**风险（有代码依据）**：

1. **鉴权框架存在但出厂即空转**。`HttpSvrAuthManager` 实现了 `checkKey` / `checkAuth`（`Authorization` 头 + 401），但：
   - `loadAuthSetting()` **函数体只有 `return;`**；
   - `saveAuthSetting()` 同样为空；
   - `checkKey` 在 key 表为空时**直接返回 true**；
   - 所以**默认状态下 `/`、`/mcp`、`/sse` 对同机任意进程完全开放**，重启后任何运行时加的 key 也会丢失。
2. **无 `Origin` / `Host` 校验**。请求处理函数只做 `checkAuth` + 解析 `func=`。若浏览器能构造"简单请求"（`text/plain` 表单）打到 `127.0.0.1:11328`，跨站写入类调用（如 `startCompose`、`createFolder`、`moveMail`）**可能被触发**。
3. 由于响应不带 `Access-Control-Allow-Origin`（该头只出现在 CEF 本地资源处理器），**跨站读取**会被浏览器挡掉；但"能写不能读"仍足以造成骚扰/破坏。
4. `/auth` 端点本身也走同一个 `checkAuth`，而表为空时同样放行——**等于没有引导期保护**。

**未确认**：`/auth` 的报文格式与是否能持久化；`func=` 是否要求 `Content-Type: application/json`（若要求，则简单请求 CSRF 不成立）。

---

## 7. 仍未确认项

- `/auth` 端点的增删改报文结构（只知 `AuthSetting` 字段为 `Name`/`Key`/`CreateTime`）。
- 除 `EnableAIMCP` 外是否有第二条 `start()` 触发路径（`0x100465dac` 会在 `getPort()==0` 时兜底 `11328` 并 `start()`，触发者尚未定位）。
- `LANG_AI_SKILLS_DIRECTORY` 指向的 skills 目录**是给谁读的**——是给外部 agent 读，还是客户端自己启动 agent 时用（**推断**后者：客户端可能内置一个"AI Agent"面板，加载 skills 目录里的 skill 定义）。
- MCP 的 `initialize` 能力协商字段细节。
