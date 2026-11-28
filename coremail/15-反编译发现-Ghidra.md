# Ghidra 反编译发现（第二版补充）

> 第一版（`01`~`14`）只有符号、字符串、资源级证据，涉及函数内部逻辑的结论一律标注"推断"。
> 本文是配好 Ghidra 12.1.4 后**实际反编译函数体**得到的结论，用于**替换**第一版中对应的"推断/未确认"条目。
> 每条结论都给出函数地址与 REA 证据 ID，可自行复核。

---

## 0. 反编译条件（为什么第一版做不到）

| 项 | 值 |
|---|---|
| provider | Ghidra 12.1.4（`analysis_profile.provider.version`） |
| 导入模式 | `ephemeral-source-immutable`（不改原文件） |
| 架构 | arm64，Mach-O，image base `0x100000000` |
| 启动耗时 | 首次导入 114 MB 主二进制 **超过默认 330 秒**，需把 `ghidra.startup_timeout_ms` 调到 1,800,000 |
| 反编译超时 | `ghidra.decompile_timeout_seconds` 调到 180 |

**这点本身是个结论**：主二进制大到 Ghidra 默认预算跑不完，说明第一版"无法反编译"不只是工具缺失，也有体量因素。

---

## 1. 最重要的一条：SDK 与 MCP 是**同一个本地 HTTP 服务**

第一版把"本地 HTTP SDK"和"本地 MCP"写成两个并列的服务（`09` 第 5 节、`10` 第 1 节）。反编译后这条被推翻。

### 1.1 调用链（`Plugin_CommandServer_Http::start`，`0x1009ad63c`）

```
Plugin_CommandServer::start()                       0x1009b1204
  └─ if (http == null || !http->running || server == null) && port != 0
       Plugin_CommandServer_Http::start(port, 2, 0x1e)   0x1009ad63c
          ├─ HttpSvrAuthManager::loadAuthSetting()        // 实际是空函数
          ├─ CoremailEngineSDK_Disptach::init()           // 注册 15 个 SDK 函数
          ├─ async_server::add("/auth", ...)              // 密钥管理端点
          ├─ Plugin::initMCPSvr()                         // 注册 3 个 MCP 工具
          ├─ MCPSvr::start("mcp", server)                 // 挂到同一个 server
          ├─ async_server::add("/", ...)                  // SDK 兜底路由
          └─ async_server::add_port(port, "127.0.0.1", 0x40) → start()
```

证据：

- `ev_78088c6e8b5f8944a9a484621f3ea898be33f8e49a55ec4270f30034b9cbbeae`（`CommandServer_Http::start`）
- `ev_6935d73ca32b0fc20ed13810ee9616011243aa084bf6e682b04fe25396be0bfa`（`MCPSvr::start`，其中 `procedure_callers` 唯一父节点就是 `0x1009ad63c`）

### 1.2 路由表（实测）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/auth` | 任意 | API Key 管理（`HttpSvrAuthManager`） |
| `/sse` | GET | **MCP SSE 长连接**（`SSESvr::init` 里是 `/sse` 常量，长度 4） |
| `/mcp` | POST | **MCP JSON-RPC 消息**（`MCPSvr::start` 用 `"mcp"` 注册进 `MCPData` 的 map，`SSESvr::init` 再拼成 `/` + key） |
| `/` | POST | SDK：解析 query 里的 `func=` |

- 绑定地址：`0x2e302e302e373231` → **`127.0.0.1`**（9 字节，非 `0.0.0.0`）。
- `add_port(..., 0x40)` 的第 4 个参数是 64（backlog）。
- `start(port, 2, 0x1e)`：`2` 与 `0x1e`(30) 分别写入 `this+0x228` 与（隐含）线程池/超时参数；`this+0x230 = 0x100000`（1 MB，请求体上限，**推断**）。

### 1.3 端口来源（第一版最想要的答案）

`Plugin::Plugin_CommandServer::initPort(int)`（`0x1009b1180`，证据 `ev_1a222bb488e307fc7976fec32273c86d9212471101a09cf4bf89a240cf3af950`）只是把参数写进单例：

```cpp
void Plugin::Plugin_CommandServer::initPort(int param_1) {
  *piVar2 = param_1;              // PluginSvrCmdData 的第一个字段
}
```

而 `Plugin::PluginSvrCmdData::PluginSvrCmdData()`（`0x1009d4ea0`）里 **`*(undefined4 *)this = 0;`**——默认端口是 0，不是 11328。

真正的默认值有两处：

| 位置 | 值 | 含义 |
|---|---|---|
| `SysSettingManage::onBindFields` 的 `AIMCPPort` | **`0x2c40` = 11328** | 设置项默认值 |
| `CMClientApp` 启动段 | `if (AIMCPPort != 0) initPort(AIMCPPort); if (EnableAIMCP == 1) start();` | 启动条件 |
| 另一调用点 `0x100465dac` | `if (getPort() == 0) { initPort(0x2c40); }` | 兜底默认 |

**结论**：

1. **11328 是二进制里的真实默认端口**（`0x2c40` 立即数），第一版"二进制里没有该常量"的结论**错误**——`grep 11328` 找不到是因为它是整数不是字符串。
2. **`AIMCPPort` 就是本地服务的端口**，`EnableAIMCP` 就是总开关。第一版认为 MCP 有独立端口、SDK 有独立开关，**错误**。
3. `AISettingPanel::save()`（`0x1000abc3c`）里能直接看到 UI 行为：改端口 → `stop()` + `initPort(新端口)` + `start()`；关开关 → `stop()`。

---

## 2. 鉴权（第一版"未见鉴权"需要修正）

`CoremailEngine::HttpSvrAuthManager` 是完整实现，不是占位：

| 方法 | 地址 | 实际行为 |
|---|---|---|
| `checkKey(std::string const&)` | `0x1010d02a8` | 若 map 为空 → **返回 true（放行）**；否则 key 必须精确命中 |
| `checkAuth(request, respond)` | `0x1010d0334` | 从 header 取 `Authorization`，去掉 7 字符前缀后交给 `checkKey`；失败回 **401**（`0x191`），body `Unauthorized...` |
| `AuthSetting::onBindFields` | `0x1010d65d0` | 持久化字段：`Name` / `Key` / `CreateTime` |
| `loadAuthSetting()` | `0x1010d019c` | **函数体只有 `return;`——空实现** |
| `getAuthSetting` / `setAuthSetting` | `0x1010d01a4` / `0x1010d0200` | 读写内存 vector |

证据：`ev_38844c6a13fc092c9451d652872a757f46bf6e250858fa522821ed390bab3626`（`checkKey`）。

**推论链**：

1. 服务启动时调用 `loadAuthSetting()`，但它是空函数 → **启动后 key 表必然为空**；
2. 表为空时 `checkKey` 恒返回 `true` → **默认不校验**；
3. 于是 `/`、`/mcp`、`/sse` 在默认状态下**对同机任意进程完全开放**；
4. `/auth` 端点可以在运行时把 key 塞进内存表，但**不会持久化**（`saveAuthSetting()` 也是空壳），重启即失效。

**所以第一版"未见鉴权 token"应改成**：*有鉴权框架（`Authorization` + key 表 + 401），但出厂状态下 key 表为空、加载与保存都是空实现，实际等同于不鉴权。* 这是**代码级证据**，不再是推断。

**仍然未知**：`/auth` 端点本身是否需要 key（因为表默认为空，理论上也不需要）；7 字符前缀具体是什么（`Bearer ` 是最合理的解释，但与代码里的分隔符扫描逻辑不能完全对齐）。

---

## 3. SDK 的 15 个函数是注册进 `JSApiCallManager` 的

第一版认为 SDK 是"独立的 HTTP 分发层"。反编译显示它复用了**网页 JS 桥同一套函数注册表**：

```
Plugin::CoremailEngineSDK_Disptach::init()       0x1009ada80
  └─ JSApi::JSApiCallManager::registerFunc("listAccount", CoremailEngineSDK_listAccount)
     ... 共 15 次

Plugin::CoremailEngineSDK_Disptach::call(name, var, cb)   0x1009b1618
  └─ JSApi::JSApiCallManager::asyncCall(this, name, var, cb)
```

证据：`ev_774a825f8d580bfcee0d57be8a86281bd15feb6cf0f371bcf1194cd9077f0a07`（`init`，从中可精确提取 15 个 `pcStack_50 = CoremailEngineSDK_xxx`）。

**注册名（顺序即源码顺序，全部为驼峰、无 `sdk.` 前缀）**：

```
listAccount    listFolder     searchMail    readMail      listMails
listAddressBook searchAddressBook listCalendar startCompose moveMail
createFolder   deleteFolder   listTags      addTags       modifyMailTags
```

三个重要含义：

1. **`window.CM(func, json)` 与 `http://127.0.0.1:11328/?func=` 走同一个 `JSApiCallManager`** —— 网页桥和 SDK 的能力边界天然一致，也解释了为什么两者都有 `{code, var, msg}` 风格的信封。
2. 15 个名字里**没有** `listContacts` / `sendMail`，与 `10` 的接口表一致；`composeMail` 在 MCP 里叫 `compose_mail`，在 SDK 里叫 `startCompose`——**两套命名是刻意区分的**（MCP 面向 LLM，SDK 面向程序）。
3. 新增能力只要 `registerFunc` 一次，网页与 SDK **同时获得**——这是它"一套引擎、多种前端"的架构支点。

SDK 请求解析（`start(...)::$_1::operator()`，`0x1009c9934`，证据 `ev_09241e6340c9369380e611b0f25447df32e382f4f19c0ce547d44d7df7a1212c`）：

- 先调 `HttpSvrAuthManager::checkAuth`，失败直接 401 返回；
- 在 URL 里 `memchr` 找 `0x66`（`f`），命中 `"func="`（`*piVar18 == 0x636e7566 && piVar18[1] == '='`）后取剩余部分作为函数名；
- 日志格式：`"Got Command: func:%v name:%v body:%v"`；
- **未见 `Origin` / `Host` / `Referer` 校验**（`Access-Control-Allow-Origin` 只出现在 `wxCefResourceHandler::GetResponseHeaders`，是 CEF 本地资源处理器，不是这个服务）。

---

## 4. MCP 的真实端点与工具注册

`MCPSvr::start(path, server)`（`0x1010d0e60`，证据 `ev_6935d73ca32b0fc20ed13810ee9616011243aa084bf6e682b04fe25396be0bfa`）：

1. 取 `MCPData` 单例（`ara::singleton`）；
2. 把 `this` 的 lambda 注册到 `MCPData + 0x68` 的 map，键是传进来的 `"mcp"`；
3. 再构造 `"/sse"`（`0x6573732f`，长度 4）调 `SSESvr::init`。

`SSESvr::init`（`0x1010d0834`，证据 `ev_92c27076163846f4ee4ca10a6c8eb484da4843b8983c5f607d9f33655629b8b9`）的行为是：先 `add_dispatch(param_1)`，然后**遍历 map 里每个 key，拼成 `"/" + key` 再 `add_dispatch`**。

于是最终路由是：

```
GET  /sse    → 事件流（MCPSvr::start 直接注册）
POST /mcp    → JSON-RPC（map 的 key 是 "mcp"）
```

**修正第一版的两处表述**：

- `/messages` 不是客户端 POST 的端点名（`09` 第 3 节表格），实际端点是 **`/mcp`**；`/messages` 字符串在包里出现但未被这条链路使用。
- `/sse` 确实存在（第一版说"未直接出现"），只是以**整数常量** `0x6573732f` 的形式内联，`strings` 抓不到。

MCP 工具注册（`Plugin::initMCPSvr`，`0x1009ae5c4`）：

```
MCPSvr::init("CoremailAir", <静态串>)          // 服务名
AIMCPSetting::getAIMCPSetting("func_mail_search" 等键)
  → Tools::name / string_arg / number_arg / enum_arg / default_arg
MCPSvr::addTools(...)                          // 3 次
```

**服务名是 `CoremailAir`**（`0x69616d65726f43`+`0x7269416c`），再次印证 "Air" 产品线。工具的名称/描述**全部从 `AIMCPSetting` 读**，即来自 `locale/mcpdef.*.js`——**MCP 工具描述是可本地化的**，换语言会改变 AI 看到的 tool description。

---

## 5. 本地邮件文件格式（第一版"未确认"）

`MailFile::check_header`（`0x101915a34`，证据 `ev_a11b7901075307e3cc4d982ad81189793d84780f1c32d183d6748c137e7eb45c`）：

```cpp
iVar5 = MailStreamBase::loop_read(stream, &header, 0x40);   // 读 64 字节
if (iVar5 != 0x40) → "File %v read header fail"
if ((uint)header != 0x736d6d63) → "File %v Prefix mismatch: %v"
if (header._4_4_ != 1)          → "File %v Version mismatch: %v"
findKey(local_80 & 0xffffffff)  → "File %v Key mismatch in history: %v"
build_encoder(compressType, flag, encodeType, key)
```

### 5.1 头部布局（观测 + 偏移推断）

| 偏移 | 长度 | 含义 | 证据强度 |
|---|---|---|---|
| `0x00` | 4 | magic **`"cmms"`**（`0x736d6d63` 小端） | 强（直接比较） |
| `0x04` | 4 | version，**必须等于 1** | 强 |
| `0x08` | 4 | `EncodeType`（传给 `build_encoder`） | 中（形参位置） |
| `0x10` | 8 | 存入 `this+0x10`（可能原始长度） | 中 |
| `0x18` | 8 | 存入 `this+0x18`，且经过 `NEON_rev64` 字节反转 | 中 |
| `0x20` | 4 | **`keyId`**（`findKey` 的参数） | 强 |
| `0x24` | 4 | `CompressType`（传给 `build_encoder` 第一参） | 中 |
| `0x28` | 4 | 存入 `this+0x20` | 弱 |

**关键结论**：邮件文件不是 RFC822 原始文本，而是**自带 64 字节头 + 可换密钥/可换编码/可压缩的容器**。`keyId` 是 32 位整数，配合 `MailStorageKeyManagerImp::findKey(keyId, out)` 的 **红黑树（`std::map` 布局，按 keyId 排序）** 查找，说明**支持密钥轮换**——旧文件保留旧 keyId，新文件用新 key。

`MailStorageKeyManagerImp::findKey`（`0x10190b11c`）：树节点偏移 `+0x20` 是 `uint32 keyId`，`+0x28` 是 `std::string key`。这与第一版"三态 `.dat/.edat/.sdat`"是**两套独立机制**：扩展名表示"账号级"加密等级，文件头 keyId 表示"单文件"实际密钥。

### 5.2 SQLite 自定义 cipher

`Database::_registerCustomEncryptMethod(const void*, const void*, string const&, bool)`（`0x1019813fc`）：

```cpp
iVar4 = cmclient_sqlite3mc_register_cipher(param_1, param_2, 0);
...
Sqlite3Env::addEncMethod(name /*wstring*/, cipherName /*string*/, param_4);
```

- 调用的是 **sqlite3mc 的注册接口**（`cmclient_sqlite3mc_register_cipher`），说明数据库加密交给 sqlite3mc 的 cipher 框架，而不是自己写 VFS；
- `param_3`（`string`）被转成 `wstring` 后作为 **`addEncMethod` 的显示名**，`*param_1`（C 字符串）是 cipher 名；
- **具体算法仍未还原**：真实 codec 函数指针由 `param_1/param_2` 传入，在反编译视图里是外部地址，需要继续追调用点（目前 `procedure_callers` 返回空，说明是通过函数指针/虚表调用）。

---

## 6. Coremail 私有协议的真实 HTTP 头

`ProtocolContext_Coremail` 里有三个 Content-Type 初始化函数，反编译后是硬编码字符串：

| 函数 | 地址 | Content-Type |
|---|---|---|
| `initCoremailHttpClientHeaderNormal` | `0x1010e3f4c` | `application/json;charset=UTF-8` |
| `initCoremailHttpClientHeaderForPostJson` | `0x1010e3ec0` | `text/x-json;charset=UTF-8;tz=UTC;useTypeCastExtension=1` |
| `initCoremailHttpClientHeaderForPostJsonWithEnc` | `0x1010e3d54` | `application/x-cm-json;charset=UTF-8;tz=UTC` |

证据：`ev_a802a764cd73d35d67141a1c01ef1819a5d9f4d7312c8c68d1d65427b64cd7eb`。

要点：

1. **名字里的 `Enc` 不是加密**，是指 Coremail 私有 MIME 类型 `application/x-cm-json`。第一版把 `...WithEnc` 当成"加密 JSON"是误读。
2. `useTypeCastExtension=1` 是服务端开关：让服务端按客户端期望的类型做强制转换（字符串/数字/布尔），**推断**这是为了解决 Coremail 服务端返回类型不稳定的历史问题。
3. `tz=UTC` 写死在头里，说明**协议层统一用 UTC**，本地时区转换在客户端做——与包内 `tzdata/` + `windowsZones.xml` 的存在一致。

---

## 7. 配置项全表（从 `SysSettingManage::onBindFields` 直接读出）

`SysSettingManage::onBindFields`（`0x10006c4e0`，证据 `ev_7dac162168aa9ffbbeb22d8ece4fea71b84b9df3c36f7389590b87f146cd145d`）一次性绑定 **162 个设置项及其默认值**（第一版按 95 项描述，实测 162 项，全表见 `16`）。这是第一版只能从 `syssetting.js` 猜的部分，现在是精确值。

### 7.1 与 AI / 本地服务相关（重点）

| 键 | 默认值 | 说明 |
|---|---|---|
| `EnableAIMCP` | **0** | 本地 HTTP 服务总开关（SDK + MCP 同时生效） |
| `AIMCPPort` | **11328** | 本地 HTTP 服务端口 |
| `ShowAIGlobalEntryFrame` | 0 | 是否显示 AI 全局入口 |
| `HasAINotice` | 0 | 是否已展示 AI 提示 |

### 7.2 值得注意的默认值

| 键 | 默认 | 备注 |
|---|---|---|
| `UseRibbonBar` | 0 | 但 `conf/syssetting.js` 里写 `UseRibbonBar:true`——**两套配置优先级不同** |
| `EnableSpellCheck` | 0 | 拼写检查默认关（包内有词典） |
| `DetailLog` | 0 | 详细日志默认关 |
| `DebugMode` | 0 | |
| `TraceHttpProtocol` | 0 | 可用来抓协议 |
| `SearchTokenPolicyV2` | 1 | 搜索分词策略 V2 默认开 |
| `SearchFirstResultCountV2` | 100 | |
| `MailListScrollItemCount` | 1 | |
| `LogKeepDays` | 30 | |
| `ReceiveLetterTiming` | 5 | 分钟 |
| `GloablScheduleRemindTimeInMinutes` | 15 | 拼写原文如此（`Gloabl`） |
| `ComposeFontSize` | 120 | 单位应是 1/10 pt |
| `AddressAutoMatchShowCount` | 100 | |
| `FirstWeekDayIsSunday` | 0 | |
| `HideMailImage` | 0 | **默认加载远程图片** |

**备注**：`MailListScrollItemCount` 默认 1、`UseRibbonBar` 默认 0 与 `conf/syssetting.js` 的 `UseRibbonBar:true` 冲突，说明**存在"出厂默认（C++）"与"发行配置（JS）"两层覆盖**，第一版对配置四层的划分需要补上这一层。

---

## 8. 升级与硬编码端点（补第一版）

### 8.1 `UpgradeContext::checkVersion`（`0x101558d00`）

函数里硬编码了：

```cpp
"https://pcmail.coremail.cn/lunkr/s/json?func=cim.common:checkVersion"
```

即**升级检查会向 Lunkr 的 SaaS 端点请求 `cim.common:checkVersion`**。函数体内**未见任何签名/哈希校验**调用（无 `EVP_*`、无 `SM2_*`、无 hash 比较），只有 HTTP 请求与 JSON 解析。

### 8.2 `Protocol::upgradeApp`（xref `0x1015587b8` → `/coremailclient/clientVersionCheck.jsp`）

只负责组装版本检查请求（`Event_UpgradeApp`），**没有验签逻辑**。

**结论**：从静态证据看，**升级链路只做版本比较，未见安装包签名校验**；下载与执行在 `UpgradeCoremailDlg`（GUI 侧）与外部 `curl`/`open` 命令，未在本次反编译范围内完全覆盖。若要下"可被中间人替换安装包"的结论，还需要运行时抓包 + 替换测试。

### 8.3 IMAP IDLE

字符串 `"IDLE"` 存在于 `0x10492363f`，但 **Ghidra 的 xrefs 返回空数组**——没有任何代码引用它。

**推断**：IMAP 客户端**未实现 IDLE**（推送依赖 Coremail 私有协议的 Socket.IO / EWS Push），`"IDLE"` 字符串是死代码或来自第三方库。第一版把"IMAP IDLE 是否使用"列为未确认，现在可以标注为"**静态证据倾向于未使用**"。

---

## 9. 反编译**没有**解决的问题（更新版清单）

| 问题 | 现状 |
|---|---|
| sqlite3mc 自定义 cipher 的算法 | 仍未知（函数指针传递，调用点未解析） |
| 私有协议的业务 JSON 结构 | 仍未知（需要抓包） |
| Socket.IO 事件名与鉴权 | 仍未知 |
| `/auth` 端点的完整语义（增删 key 的报文格式） | 部分（只知字段 `Name`/`Key`/`CreateTime`） |
| 升级包是否验签 | 倾向"未验签"，但下载/执行路径未覆盖 |
| `EnableAIMCP` 之外的启用路径（是否有命令行/skills 触发 `start()`） | 已知 `0x100465dac` 会在 port==0 时兜底 11328 并 start，触发者未定位 |
| AI provider 请求的真实 header / 鉴权 | 未展开 |

---

## 10. 证据索引（本文新增）

| 证据 ID | 内容 |
|---|---|
| `ev_78088c6e8b5f8944a9a484621f3ea898be33f8e49a55ec4270f30034b9cbbeae` | `Plugin_CommandServer_Http::start`：路由、绑定地址、MCP 挂载 |
| `ev_6935d73ca32b0fc20ed13810ee9616011243aa084bf6e682b04fe25396be0bfa` | `MCPSvr::start`：`/sse`、`"mcp"`、与 SDK 共用 server |
| `ev_92c27076163846f4ee4ca10a6c8eb484da4843b8983c5f607d9f33655629b8b9` | `SSESvr::init`：base path + `"/"+key` 注册 |
| `ev_7a56e3b992d27505387436905363f174f293d70ac8abf1ab0a293a5c56d65d4c` | `SSESvr::onRequest`：按 path 存 handler |
| `ev_09241e6340c9369380e611b0f25447df32e382f4f19c0ce547d44d7df7a1212c` | SDK 请求处理：`checkAuth` → `func=` → 分发 |
| `ev_774a825f8d580bfcee0d57be8a86281bd15feb6cf0f371bcf1194cd9077f0a07` | `CoremailEngineSDK_Disptach::init`：15 个注册名 |
| `ev_38844c6a13fc092c9451d652872a757f46bf6e250858fa522821ed390bab3626` | `HttpSvrAuthManager::checkKey` |
| `ev_1a222bb488e307fc7976fec32273c86d9212471101a09cf4bf89a240cf3af950` | `Plugin_CommandServer::initPort` |
| `ev_7dac162168aa9ffbbeb22d8ece4fea71b84b9df3c36f7389590b87f146cd145d` | `SysSettingManage::onBindFields`（162 项） |
| `ev_a11b7901075307e3cc4d982ad81189793d84780f1c32d183d6748c137e7eb45c` | `MailFile::check_header`（`cmms` / version 1 / keyId） |
| `ev_a802a764cd73d35d67141a1c01ef1819a5d9f4d7312c8c68d1d65427b64cd7eb` | `...WithEnc`：`application/x-cm-json` |
| `ev_47763e07feeeafe3929db4c0a907477cc947a277bae428dae3963591e3d8c6b6` | `start(...)::$_1` 的 `__func` 包装（转调真身） |

---

## 11. 增补：第二轮反编译（MCP 分发器 / 工具实现 / SQLite cipher / 协议头）

### 11.1 MCP 的 JSON-RPC 分发器是 `MCPData::sseRequest`

`0x1010d20c4`，152 KB 伪代码，证据 `ev_a3f24bcc1a3662d36c9356d4fc7ea329dc4ea63ada856036fcebc56c72ce4e12`。

- `protocolVersion` 写死 **`"2024-11-05"`**；
- 支持的方法：`ping`、`initialize`、`tools/list`、`tools/call`、`notifications/initialized`、`notifications/cancelled`；
- `initialize` 返回 `capabilities.tools`；`tools/call` 结果包成 `content:[{type:"text",...}]`；
- **应用锁会拦截**：错误文本 `"App locked, accessing forbidden."`；
- 无 `prompts/*`、`resources/*`、`sampling/*`、`roots/*`。

详见 `09` 第 3.0 节。

### 11.2 三个 MCP 工具的真实实现（不走 HTTP）

| 工具 | 地址 | 关键调用 |
|---|---|---|
| `mail_search` | `0x1009e8520` | `MailEngine::getSearchEngine` → `SearchEngine::searchDoc` / `MailSearchBuilder` → `MailIndex::searchMail` → `searchByMID` |
| `get_mail` | `0x1009eae08` | `AccountManager::findMailEngineByAccountID` → `MailIndex::findMailByMailID` |
| `compose_mail` | `0x1009ed93c` | 仅构造 GUI 派发 lambda |

证据：`ev_46d3dde652d83bafa56c059f76e95b938aff506b1b42c38130374bfb1ca9dbcb`（searchMail）、`ev_deac6cd46927fbe0d0e95630bee92317ced9302bad05d484b7437b0c0a95db75`（readMail）、`ev_f7065713d0c766eef34b2fded36c711c6c6cc235262ab3e347e8ff9393b50a56`（composeMail）。

**结论**：MCP 工具直接读写**本地索引与本地存储**，与 `CoremailEngineSDK_*`（走 `JSApiCallManager`、可能触发网络）是两条不同路径。这推翻了 `09` 第一版"工具调用 GUI 相同引擎方法因此行为一致"的笼统说法——**搜索与读信只覆盖本地已同步数据**。

### 11.3 SQLite 加密：`.edb` 用 ChaCha20

| 函数 | 地址 | 作用 |
|---|---|---|
| `Database::openImp` | `0x10197ebb8` | `sqlite3_open16` → `initEncMethod` → `sqlite3_key` |
| `Database::_setkey` | `0x101980da8` | `rekey`，失败则 `PRAGMA page_size=4096` + `VACUUM` + 再 `rekey` |
| `Database::_rekey` | `0x101980ae4` | 同构 |
| `Database::initEncMethod` | `0x1019810cc` | **按扩展名选 cipher** |

`initEncMethod` 的核心（证据 `ev_dc8b94a24ae371ed1c8bd9269fbfa729f97effd952d2a13c03fa62e849106604`）：

```cpp
if (ext == L".edb")
    sqlite3mc_config(db, "cipher", sqlite3mc_cipher_index("chacha20"));
else
    // 遍历 Sqlite3Env 的 ext -> cipher 表
```

即 **`.edb` 数据库确定使用 ChaCha20**（sqlite3mc 内置 cipher），这一条从"推断"升级为"确认"。自定义扩展名可经 `_registerCustomEncryptMethod` 注册（`sqlite3mc_register_cipher` + `addEncMethod`），其函数指针仍未解析。

### 11.4 私有协议的默认 HTTP 头

`ProtocolContext_Coremail::initCoremailHttpClientDefaultHeader`（`0x1010e3a88`，证据 `ev_b4f7955c3fcae60a06719abfa16e439f5ccf6a3682a48a63670f50c10e26896c`）：

| 头 | 值 |
|---|---|
| `Accept` | `text/x-json,application/x-cm-json,application/json` |
| `X-CM-SERVICE` | `L-CMClient` |
| `X-CM-CONTROL-AGENT` | 全局配置值（可选） |
| `X-CM-AIR-VERSION` | 全局版本串 `DAT_104dcff10` |
| `X-CM-AIR-FEATURES` | `tz` |

`make_request`（`0x1010e628c`）另行写入 **`X-CM-AUTH-SID`**、`Range: bytes=%d-`，并出现 `"/lunkr-plugins"` 路径常量。详见 `03` 第 6.1 节。

### 11.5 AIHub 请求复用会话 Cookie

`Protocol::coremailAIHubCall`（`0x10123eb60`，证据 `ev_5dd66e332e501829e84979bcac4e8eaca04a6c59b4417a0844780e3476698d27`）：

- 仅对 `MailEngine::isCoremailProtocol` 为真的账号生效；
- 取 `getCoremailSessionID()` / `getCoremailCookie()`，把 Cookie 写入请求头；
- **把整个 header map 再复制进 JSON body 的 `header` 字段**；
- `Accept: text/event-stream,text/x-json,application/x-cm-json,application/json`（支持流式）；
- 路径常量 `/aihub/`（`AIHubSetting::makeRequest`，证据 `ev_d24ab005d122f98300dacaeb6896ca9e1c510a78b0786ad47256994e94f901a2`）。

直连 provider 走 OpenAI 兼容端点：`/v1/chat/completions`、`/v1/models`、`/api/embeddings`（Ollama）。

### 11.6 登录请求的真实字段

`CoremailClient::_loginImp`（`0x1010f6824`）只做空值校验，真正的 `user:login` 组装在 `0x101112d9c`（109 KB，证据 `ev_33ad542eecf817bb8e99a191eb44138b109936816f801fb0acde3be82de49a4b`）：

- 提交字段：`dynPwd`、`cell`、`img`、`logincontextmcid`、`dev`、`fn`、`os`、`time`、`token`、`nonce`、`sign`；
- `token/nonce/sign` = 设备证书（SM2）签名三元组，由 `user:generateDeviceCertToken` 下发 token 后本地生成；
- 设备证书能力可被服务端关闭（`supportAuthDeviceCert=false`）；
- 另有 `global:verify` 预校验（`Login globalVerify failed ...`）；
- 已有 session 时走 `login via session mode`，不再提交口令。

### 11.7 第二轮新增证据（第一批）

| ID | 内容 |
|---|---|
| `ev_a3f24bcc1a3662d36c9356d4fc7ea329dc4ea63ada856036fcebc56c72ce4e12` | `MCPData::sseRequest`：JSON-RPC 分发、`2024-11-05` |
| `ev_46d3dde652d83bafa56c059f76e95b938aff506b1b42c38130374bfb1ca9dbcb` | `CoremailEngineMCP_searchMail`：本地 Xapian 搜索 |
| `ev_deac6cd46927fbe0d0e95630bee92317ced9302bad05d484b7437b0c0a95db75` | `CoremailEngineMCP_readMail`：本地索引读信 |
| `ev_f7065713d0c766eef34b2fded36c711c6c6cc235262ab3e347e8ff9393b50a56` | `CoremailEngineMCP_composeMail`：仅唤起 GUI |
| `ev_63326ddf6868a1da255fcb4d04abad67a5885299ca357cf521aa7df829005e87` | `Plugin::initMCPSvr`：3 个工具名与参数 |
| `ev_dc8b94a24ae371ed1c8bd9269fbfa729f97effd952d2a13c03fa62e849106604` | `initEncMethod`：`.edb` → chacha20 |
| `ev_a44cb16983bf9ba4c139bc157920f0aa7454805f67173a229ba7d35ff5e25056` | `Database::_setkey`：rekey + page_size + VACUUM |
| `ev_4bc41feed7ec6ed4d2ce89052b2b8260b6ff08eb33a4e0ef44772982c00cbf5b` | `Database::openImp`：open16 → initEncMethod → key |
| `ev_b4f7955c3fcae60a06719abfa16e439f5ccf6a3682a48a63670f50c10e26896c` | `initCoremailHttpClientDefaultHeader` |
| `ev_27ae655ebffcb4fb4feff16be76d11f852a0aa38388f276a110ba1ac92512e56` | `make_request`：`X-CM-AUTH-SID`、Range |
| `ev_f1620dbb01a25740b9a9720c115d89748c7ebc6addec1b58c60380cefba5038a` | `Database::detectDBExtName`：扩展名探测顺序 |
| `ev_69c18dbeac10d80f0c51df41ce5337bc8a6698f424fc96a49adecfbab8dd97bf` | `Database::setDefaultEncMethodByExtName` |
| `ev_5dd66e332e501829e84979bcac4e8eaca04a6c59b4417a0844780e3476698d27` | `Protocol::coremailAIHubCall`：复用 Cookie、header 入 body、SSE |
| `ev_d24ab005d122f98300dacaeb6896ca9e1c510a78b0786ad47256994e94f901a2` | `AIHubSetting::makeRequest`：`/aihub/` |
| `ev_33ad542eecf817bb8e99a191eb44138b109936816f801fb0acde3be82de49a4b` | `user:login` 组装：dynPwd/cell/img/token/nonce/sign |
| `ev_9ab2a9f92918cec9cf76276b4b50bacdac673a814bc2e8ad3f540b46d1ef15c0` | `CoremailClient::_loginImp`：空口令直接拒绝 |
| `ev_dd06ebe93739a02be682cba2a4c70bcb809ad35803ddc7c0bf1ea74d9e7efcb7` | `LoginContext::call`：`/s/json?func=` 通用调用 |

### 11.8 本地邮件库的编码链与 keyId

`MailFile::build_encoder`（`0x101914574`，证据 `ev_636af176e361709146c295eb43e9a37972d5a4055d1f3a387d73f5ec83cf6adb`）把落盘分成**压缩层 + 编码层**两级：

| 压缩 | 取值 |
|---|---|
| 不压缩 / Zlib / ZStd | 0 / 1 / 2 |

| 编码 | 取值 |
|---|---|
| `PlainEncode` | 0 |
| `XorEncode` | 1 |
| `AesPaddingEncrypt`（OpenSSL AES） | 2 |
| `SM4PaddingEncrypt`（GmSSL SM4） | 3 |
| `FastXorPaddingEncrypt`（滚动异或） | 4 |
| `Injection` 外挂（`ExternalPaddingEncryptEncode`） | 5..15 |

- SM4 构造（`0x1019220b8`，证据 `ev_d7ba668556d200ecf0e1f01079e0de98afe150471d7058b12548fa8404338972`）：密钥直接 `memcpy` → `sm4_setkey_enc` / `sm4_setkey_dec`，无 KDF。
- FastXor 构造（`0x10191ba44`，证据 `ev_c4d740238396f7c1e80ec0ba55d795613fd91739e9af655a39af3cf4f460a0eb`）：`k[i] = (i<len ? key[i] : 0x1c) ^ 0x1c`，16 字节周期。

`Encode::AES::setKey(string const& key, bool, string const& iv, string const& mode)`（`0x100f00f18`，证据 `ev_948ab5b3fe058f3b8878b7027b88f518ac518409fbf2ec776890b49d133e6fb7`）：

- 密钥 16/24/32 → `EVP_aes_128/192/256`；
- `mode` 只认 3 字节 `ecb` / `gcm`；`ecb` 走 `set_flags(0x100)` + `set_padding(0)`，IV = NULL；`gcm` 用传入 IV；
- 布尔参数决定 `EncryptInit_ex` 还是 `DecryptInit_ex`。

`MailStorageKeyManagerImp::addKey`（`0x10190b1e8`，证据 `ev_7fc71c1a8ce3356e15eaefd81c7f504c3ac4724e2369bf226a65337b8b10d7d3`）：

```cpp
keyId = TextProcess::cmx_string_hash_value(keyString);  // 32 位哈希
```

即**文件头的 keyId 是密钥串哈希**，不是随机 UUID；`MailStorage::addKeyHistory(list<string>)`（`0x10190b54c`）按列表灌入历史密钥，`findKey(keyId, out)` 反查。这解释了"改密码后旧邮件仍可读"。

**默认档位是 4**：`MailEngine::_initEnginePackeType`（`0x100ffdfbc`，证据 `ev_d684cff211e3d2b5c80579d8fda09c8bc77c01c211c77040ceaa235418f3bab1`）是 `setEncodeType` 的唯一调用者，固定 `setEncodeType(4, getEncodeKey())`，并把 `+0xc4` 写成 `{compress=3, encode=4}`。AES/SM4 档位的启用点尚未定位。

| 新增证据 | 内容 |
|---|---|
| `ev_636af176e361709146c295eb43e9a37972d5a4055d1f3a387d73f5ec83cf6adb` | `MailFile::build_encoder`：压缩/编码两级 |
| `ev_948ab5b3fe058f3b8878b7027b88f518ac518409fbf2ec776890b49d133e6fb7` | `Encode::AES::setKey`：AES-128/192/256 + ecb/gcm |
| `ev_b57f99db60a132c243967dc716cbc0a5660d851fe951612b901a089a8f65f95f` | `AesPaddingEncrypt` 构造：转 `Encode::AES::setKey` |
| `ev_7fc71c1a8ce3356e15eaefd81c7f504c3ac4724e2369bf226a65337b8b10d7d3` | `addKey`：keyId = `cmx_string_hash_value` |
| `ev_394a074e26981853a5cea54f1c456a0e7c2ffff2fb3bc15629a6256349a285da` | `findKey`：按 keyId 反查密钥 |
| `ev_23e744580976095d1d65aa61969417ff6626dccc176b643c50c86ca5b04919ce` | `MailStorage::addKeyHistory`：列表灌入 |
| `ev_d7ba668556d200ecf0e1f01079e0de98afe150471d7058b12548fa8404338972` | `SM4PaddingEncrypt` 构造：GmSSL `sm4_setkey_enc/dec` |
| `ev_c4d740238396f7c1e80ec0ba55d795613fd91739e9af655a39af3cf4f460a0eb` | `FastXorPaddingEncrypt` 构造：16 字节滚动异或 |
| `ev_d684cff211e3d2b5c80579d8fda09c8bc77c01c211c77040ceaa235418f3bab1` | `MailEngine::_initEnginePackeType`：固定 `setEncodeType(4, …)` |
| `ev_ef18502eb08f42fb31c397839fe2c357ed35f084d7539ff26a21910f96de61aa` | `MailStorage::setEncodeType`：写 `+0xb8` + `addKey(key,true)` |
