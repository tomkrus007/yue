# 本地 HTTP SDK 与随包 Skills

## 1. 事实清单

| 项 | 值 | 来源 |
|---|---|---|
| 地址 | `http://127.0.0.1:11328/sdk?func=<name>` | `skills/src/cmclient.ts`、`skills/CLAUDE.md` |
| 方法 | `POST` | 同上 |
| 请求体 | JSON | 同上 |
| 响应信封 | `{ code: 0, var: <数据>, msg: "错误信息" }` | 同上 |
| 成功判定 | `code === 0`（**注意：与 AI 的 `"S_OK"` 不同**） | `cmclient.ts` |
| 接口数 | 15 | `cmclient.ts` 全量扫描 |
| 端口常量 | **二进制中未找到 `11328`** | `grep -a 11328 cmclient` 无结果 |

**重要结论**：11328 只出现在 `skills/` 的文档与代码里，二进制内没有该常量。因此 11328 **要么是 C++ 侧的常量未被字符串化（以整数形式存在于代码段），要么是配置默认值**。用户可通过设置改端口（参照 MCP 的 `AIMCPPort` 模式）。文档中应表述为"**随包 SDK 文档声明的默认端口**"。

---

## 2. 原生侧实现

```
Plugin::Plugin_CommandServer_Http
├── Plugin_CommandServer_Http()                       // 构造
├── start(int port, unsigned long, unsigned long)     // 启动（端口 + 两个策略参数）
├── isRunning() const
├── getErrorPort(int&)                                // 端口冲突时取实际端口
└── start(...)::$_1::operator()(async_server_request, async_respond)   // 请求处理
```

- 请求处理是 `ara::http` 的**异步回调**（`shared_ptr<async_server_request>` / `shared_ptr<async_respond>`），与引擎其他部分一致；
- `start` 的两个 `unsigned long` 参数很可能是"允许的方法位掩码"或"超时/大小限制"；
- `getErrorPort(int&)` 说明**端口被占用时会把冲突端口回传给 UI**（而不是静默失败）。

业务函数（`Plugin::CoremailEngineSDK_*`）：

| SDK 函数 | 符号数 | 说明 |
|---|---|---|
| `CoremailEngineSDK_readMail` | 29 | 读信（最复杂） |
| `CoremailEngineSDK_listAddressBook` | 20 | 通讯录列表 |
| `CoremailEngineSDK_searchMail` | 14 | 搜索 |
| `CoremailEngineSDK_startCompose` | 9 | 唤起写信 |
| `CoremailEngineSDK_listMails` | 9 | 列邮件 |
| `CoremailEngineSDK_searchAddressBook` | 8 | 通讯录搜索 |
| `CoremailEngineSDK_listTags` | 5 | 列标签 |
| `CoremailEngineSDK_addTags` | 4 | 加标签 |
| `CoremailEngineSDK_modifyMailTags` | 3 | 改邮件标签 |
| `CoremailEngineSDK_listCalendar` | 3 | 列日程 |
| `CoremailEngineSDK_createFolder` | 3 | 建文件夹 |

另有辅助：`saveAccountInfoToVar`(14)、`saveMailInfoToVar`(12)、`saveMailDetailToVar`(7)、`saveFolderInfoToVar` —— 一组 **"内部结构 → `ara::var`"** 的序列化函数，说明 SDK 的响应结构是显式构造的，不是反射。

---

## 3. 15 个接口全表

| `func` | 参数（主要） | 返回 |
|---|---|---|
| `listAccount` | 无 | `AccountInfo[]`（树形，含父子） |
| `listFolder` | `Account` 或 `AccountID` | `FolderInfo[]` |
| `listMails` | `Account`、`FID`、`Offset`、`Limit` | `MailInfo[]` |
| `searchMail` | `Account` + 条件（`Full`/`Sender`/`Rcpt`/`Subject`/`Body`/`Attach`）+ `Sort`/`Desc` | `{total, list}` |
| `readMail` | `Account`、`MID`、`BodyType`、`ExportAttach` | 邮件详情 |
| `startCompose` | `Account`、`To`、`Cc`、`Bcc`、`Subject`、`Body`… | 唤起写信界面 |
| `createFolder` | `Parent`、`Name` | 新文件夹 |
| `deleteFolder` | `Folder` | — |
| `moveMail` | `FID`、`MID`（可数组） | — |
| `addTags` | 标签定义 | — |
| `listTags` | `Account` | 标签列表 |
| `modifyMailTags` | `MID`、标签操作 | — |
| `listAddressBook` | `type`（personGroup/orgGroup/personContacts/orgContacts）+ 分页/递归 | 地址本 |
| `searchAddressBook` | `keyword` + 范围 | 地址本结果 |
| `listCalendar` | `Begin`、`End` | 日程列表 |

### 3.1 账号寻址约定

```ts
// 数字 或 纯数字字符串 → AccountID
// 其他字符串 → Account
// 未指定 → Account = '@@any'（第一个非离线账号）
```

`'@@any'` 是一个**哨兵值**，说明 SDK 设计者考虑了"用户不指定账号"的常见场景，避免让调用方先 `listAccount` 再取第一个。

### 3.2 搜索必须至少一个条件

```ts
const searchFields = ['Full', 'Sender', 'Rcpt', 'Subject', 'Body', 'Attach'];
let hasSearchCondition = false;
for (...) { if (value) hasSearchCondition = true; }
```

**推断**：服务端/引擎拒绝"无条件搜索"（防止全表扫描），客户端封装提前做了校验并给出友好错误。

### 3.3 排序

`searchMail` 支持 `Sort`（如 `RecTime`）+ `Desc`，说明底层排序字段是枚举。

---

## 4. 数据结构（来自 `skills/CLAUDE.md`）

### 4.1 AccountInfo

```
AccountID        账号唯一 ID
AccountName      通常是邮箱地址
DisplayName      账号描述名
ProtocolType     Pop3 / Imap / EWS / Proprietary
Offline          是否脱机
ParentID         父账号 ID（子账号）
PackageAccount / SharedAccount / ReferenceAccount   子账号类型
```

`PackageAccount` / `SharedAccount` / `ReferenceAccount` 三种子账号与 `coremail/06` 的多账号模型对应。

### 4.2 FolderInfo

```
FID        文件夹 ID
Name       名称
ParentID   父文件夹（0=根级）
Type       1=收件箱 2=草稿 3=已发送 4=已删除 5=垃圾 7=广告信 254=本地存档 255=自定义
Atts       标志位
```

`Type` 枚举值得注意的是 **`7=广告信`** 与 **`254=本地存档`**——后者与归档子系统（`coremail/04`）呼应。

`Atts` 标志位：

| 标志 | 值 | 含义 |
|---|---|---|
| LOCK | 0x01 | 锁定，不能看邮件 |
| REMOTE | 0x04 | 服务器上也存在 |
| SEND | 0x10 | 已发送文件夹 |
| SILENCE | 0x20 | 来信不提醒 |
| HIDDEN | 0x40 | 隐藏 |
| SHOWTOTAL | 0x80 | 显示邮件总数 |
| FETCHFULL | 0x100 | 收取所有邮件 |
| NOCALUNREAD | 0x400 | 不统计未读 |

### 4.3 MailInfo / MailFlags（64 位）

SDK 用 **BigInt 字符串** 表示 64 位标志（避免 JS number 精度丢失），这是正确的工程选择。

| 标志 | 位 | 含义 |
|---|---|---|
| READ | 0x01 | 已读 |
| SCHEDULE_DELIVERY | 1<<2 | 定时投递 |
| PRI_MASK | 1<<3 \| 1<<4 \| 1<<5 | 优先级掩码（3 bit） |
| IS_SYS_MSG | 1<<6 | 系统邮件 |
| HAS_ATTACHMENT | 1<<7 | 有附件 |
| SIGNED | 1<<8 | S/MIME 签名 |
| ENCRYPTED | 1<<9 | S/MIME 加密 |
| REPLIED | 1<<10 | 已回复 |
| DRAFT | 1<<14 | 草稿 |
| PUSHED | 1<<15 | 已推送 |
| FLAGGED | 1<<21 | 红旗 |
| LINK_ATTACHED | 1<<27 | 文件中转站附件 |
| CALENDAR | 1<<29 | 日程邮件 |
| VIP | 1<<36 | 重要邮件 |
| TOP | 1<<38 | 置顶 |
| AUTODEL | 1<<39 | 自销毁 |
| HAS_INLINE_ATTACH | 1<<41 | 内联附件 |
| HAS_TAG | 1<<50 | 有标签 |
| DEFER_HANDLE | 1<<56 | 待办邮件 |

**观察**：位分配不是连续的（14/15 后跳到 21，然后 27/29/36/38/39/41/50/56），中间空位是为未来/已废弃功能预留。`PRI_MASK` 用 3 个连续 bit 表示 8 级优先级。

---

## 5. 随包 Skills 工程

`Contents/MacOS/app/skills/` 是一个**完整的、可直接运行的 TypeScript 工程**：

```
skills/
├── skill.json          {name:"cmclient", description:"Control CMX Client via HTTP SDK", version:"0.1.0"}
├── package.json        {name:"cmclient-skill", type:"module", deps:{rrule}}
├── tsconfig.json
├── README.md           中文使用说明（12 个命令示例）
├── CLAUDE.md           项目说明 + 完整数据结构 + 标志位表
├── DISTRIBUTION.md     发布清单（说明可 git/npm/zip 分发）
├── api/                15 个 CLI 脚本
└── src/cmclient.ts     1,507 行 SDK 封装
```

### 5.1 这是"给 AI 用的 SDK"，不是"给开发者用的 SDK"

证据：
- 文件名叫 `CLAUDE.md`（Claude Code 的项目说明文件约定）；
- `DISTRIBUTION.md` 明确写"分享方式：git / npm / zip"；
- `README.md` 第一句："用于操控本地 CMX Client 邮件客户端的 **Claude Code Skill**"；
- `skill.json` 的 `name`/`description` 是 skill 元数据格式。

**推断**：Coremail 官方把这份工程**作为"AI 接入示例"随客户端分发**，鼓励用户把它放到自己的 AI 工具（如 Claude Code）的 skills 目录里，从而让 AI 通过本地 HTTP SDK 操作邮箱。这与 `LANG_AI_SKILLS_DIRECTORY=skills目录:` 设置项完全对应——**客户端设置里可以让用户指定 skills 目录，用于 AI 能力扩展**。

### 5.2 依赖

只有 `rrule`（循环日程解析，RFC 5545），说明 SDK 封装极简，不需要 HTTP 库（用 Node 内置 `fetch`）。

### 5.3 15 个 CLI

```
list-accounts  list-folders  list-mails  list-addressbook  list-calendar
search-mail    search-addressbook  read-mail  compose-mail
create-folder  delete-folder  move-mail
add-tag  list-tags  modify-mail-tags
```

`read-mail.ts` 支持 `--body-type Markdown`（推断：SDK 侧做 HTML→Markdown 转换，方便 LLM 读取）与 `--export-attach`。

### 5.4 一个细节：文档里的开发者邮箱

`skills/CLAUDE.md` 的示例命令中出现 `-a cyt@coremail.cn`（Coremail 内部员工邮箱）。这是一个**轻微的信息泄露**（内部人员标识），但不涉及凭据。

---

## 6. 安全面

| 事实 | 评价 |
|---|---|
| 绑定 `127.0.0.1` | 仅本机可访问（**推断**，文档如此声明） |
| 未发现鉴权 token | **风险**：同机进程可直连 |
| `readMail` 可读全文 | 高风险：可导出全部邮件 |
| `startCompose` 只唤起界面 | 低风险：不直接发信 |
| `moveMail` 到文件夹 4 = 删除 | 中风险：可批量删信（但仍在"已删除"） |
| 与 MCP 共用 `Plugin_CommandServer` | 授权策略可能统一 |

**对比 MCP**：SDK 有 15 个接口（含 `moveMail`、`deleteFolder`），**破坏性操作比 MCP 多**。如果两者共用"启用"开关，则打开 MCP 就等于打开了完整的 SDK 能力面。

---

## 7. 未确认项

- 11328 的真实来源（常量 vs 配置默认值）。
- SDK 是否也受 `EnableAIMCP` 控制，还是有独立开关。
- `start(int, unsigned long, unsigned long)` 的两个 `unsigned long` 语义。
- `readMail` 的 `BodyType` 完整取值（Text/Html/Markdown…）。
- 是否有请求大小/并发限制。
