# IM 本地持久化改造设计（SQLite）

- 版本：v1（2026-11-26）
- 涉及仓库：`YX/`
- 目标版本：下一次发版
- 相关代码：`src/stores/im.ts`、`src/stores/receipts.ts`、`src/stores/mentions.ts`、`src-tauri/src/db.rs`、`src-tauri/src/lib.rs`

## 1. 背景与结论

当前 IM 的消息、未读、交互状态、回执名单全部存在 WebView 的 `localStorage` 中。问题不是“localStorage 一定慢”，而是**写入方式是全量覆盖**：

- 每收到一条消息，`persistMessages()` 会把内存中最多 5000 条消息整体 `JSON.stringify` 后同步写回 `localStorage`。
- 登录后服务端按批下发离线消息（单批可达 500 条），一批消息就会触发数百次全量序列化 + 同步写，主线程被占满，表现为“刚登录收不到消息 / 界面卡死 / token 过期”。
- `localStorage` 写入失败（配额、隐私模式）被 `try/catch` 静默吞掉，重启后消息、未读、待发送的阅读确认直接消失，只能重新向服务器拉取。
- 未读、交互、回执各自是一整块 JSON，任何一个小改动都要重写整块；随着使用时间增长，写入成本线性上升。

结论：**把 IM 数据切换到已有 SQLite 配置库 `yx.db`，并按“单条/小批 upsert”写入**。消息不再全量迁移，旧 `localStorage` 数据直接清理，需要时从服务端重新拉取；未读、交互、回执等状态写入 SQLite，使其在发版、重启后仍然存在。

## 2. 目标与非目标

### 2.1 目标

1. 收消息热路径不再做 O(总消息数) 的序列化与同步写。
2. 消息、未读、交互（回应/撤回/已读回执）、待发送阅读确认、回执名单、@我提醒全部落 SQLite。
3. 发版/重启后未读状态、阅读确认队列、回执名单不丢，不需要重新向服务器拉一遍。
4. 账号之间数据隔离；显式退出登录仍按现有语义清除本机该账号数据。
5. 数据库不可用（浏览器开发、磁盘异常）时自动降级为纯内存，不影响收发消息。
6. 冷启动不加载全部历史：启动只读最近窗口，打开会话时按需加载。

### 2.2 非目标

1. 不迁移现有 `localStorage` 中的 5000 条消息；升级后首次启动直接删除旧 key，历史从服务端按需重新拉取。
2. 不改变 IM 协议、REST 接口、消息字段。
3. 不把登录凭据、服务地址、窗口尺寸等非 IM 配置迁入 SQLite。
4. 不引入 `tauri-plugin-sql`；前端不获得执行任意 SQL 的能力，只调用固定命令。
5. 不实现跨设备同步；SQLite 只是本机缓存。

## 3. 现状盘点

### 3.1 已持久化的 IM 数据

| 位置 | key | 内容 | 现有写入方式 | 规模 |
| --- | --- | --- | --- | --- |
| `stores/im.ts` | `yl.im.messages` | 最多 5000 条消息（含 `__delivery` 待确认状态） | 每条新消息全量重写 | 数 MB |
| `stores/im.ts` | `yl.im.unread` / `imUnreadAt` / `imUnreadIds` | 会话未读、@我未读、已计入未读的消息 id | 未读变化时三块全量重写 | 数十 KB～数百 KB |
| `stores/im.ts` | `yl.im.interactions.<uid>` | 回应、撤回、已读人/已读时间、本地阅读确认、待发送阅读确认、焚毁截止时间 | 每次变化整块重写 | 数十 KB～数 MB |
| `stores/receipts.ts` | `yl.im.receipt-audiences.<uid>` | 最多 5000 份发送时接收人快照 | 每次捕获整块重写 | 数百 KB～数 MB |
| `stores/mentions.ts` | `yl.im.mentions.<uid>` | @我提醒及处理状态 | 每次变化整块重写 | 数十 KB |

会话列表、置顶/折叠/免打扰、群元数据也仍在 `localStorage`，但它们都能从服务端重新同步，本次不动。

### 3.2 关键问题

1. **写入放大**：5000 条消息 × 每条新消息一次全量序列化，是登录后卡顿的主因。
2. **同步阻塞**：`localStorage.setItem` 是同步 API，直接占住 WebView 主线程。
3. **静默失败**：`writeJson()` 的 `catch {}` 让配额错误不可见，用户只看到“状态丢了”。
4. **容量压力**：消息 + 回执 + 交互共用一个 origin 配额，互相挤占。
5. **冷启动成本**：一次性解析全部消息与交互 JSON，启动越久越慢。

## 4. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ Vue 组件 / Pinia store（内存读模型，响应式）                  │
│  messages / unread / interactions / receipts / mentions      │
└───────────────▲───────────────────────────┬─────────────────┘
                │ 同步读（只读内存）          │ 变更时标脏
┌───────────────┴───────────────────────────▼─────────────────┐
│ stores/im.ts 持久化队列                                       │
│  - dirtyMessages: Map<msg_id, ChatMessage>                    │
│  - dirtyUnread / dirtyInteractionIds / ...                    │
│  - 500ms 合并、首条立即、每批 ≤500 行                          │
└───────────────▲───────────────────────────┬─────────────────┘
                │ 启动 hydrate / 按会话加载   │ invoke（异步）
┌───────────────┴───────────────────────────▼─────────────────┐
│ services/im/store.ts 仓储层                                   │
│  - 统一 camelCase 参数、错误吞掉并上报日志                     │
│  - 写入串行链，保证“清账号”排在所有写之后                      │
└───────────────▲───────────────────────────┬─────────────────┘
                │                           │
┌───────────────┴───────────────────────────▼─────────────────┐
│ Rust im_store.rs（spawn_blocking）                            │
│  im_messages_* / im_state_* / im_account_clear                │
└───────────────▲─────────────────────────────────────────────┘
                │ rusqlite + WAL
┌───────────────┴─────────────────────────────────────────────┐
│ yx.db（app_data_dir）                                         │
│  im_messages / im_state（settings/components 保持不变）        │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 设计原则

1. **内存是读模型，SQLite 是写穿缓存**：UI 渲染只读 Pinia，不在渲染路径上查询数据库。
2. **只写变化的部分**：以 `msg_id` / `session_id` 为最小写入单位，不做整块重写。
3. **异步、批量、可丢弃**：持久化可以延迟、可以失败；失败只记日志，不阻断消息收发。
4. **账号显式隔离**：所有表都带 `account_id`，查询必须带账号。
5. **读按需**：启动只取最近窗口，其余在打开会话/定位消息时加载。

### 4.2 为什么不选其他方案

- **继续 localStorage，只做节流**：能缓解登录瞬间卡顿，但仍有同步阻塞、5MB 配额、静默丢数据，无法解决“发版后状态消失”。
- **IndexedDB**：配额和异步都不错，但没有 SQL 分页/索引，迁移和巡检麻烦；项目已有 SQLite 基建，统一到 `yx.db` 更合理。
- **`tauri-plugin-sql`**：会把任意 SQL 执行能力暴露给 WebView，与现有“前端只调固定命令”的约束冲突。
- **每条消息一次 `invoke`**：离线 500 条 = 500 次 IPC，反而更慢，必须批量。

## 5. 数据库设计

### 5.1 迁移

在 `src-tauri/src/db.rs` 的 `migrate()` 中新增 `user_version = 3`，沿用“每步一个事务”的写法：

```sql
CREATE TABLE IF NOT EXISTS im_messages (
  account_id   TEXT    NOT NULL,
  msg_id       TEXT    NOT NULL,
  session_id   TEXT    NOT NULL,
  session_type INTEGER NOT NULL,
  send_time    INTEGER NOT NULL,
  msg_type     INTEGER NOT NULL,
  from_id      TEXT    NOT NULL,
  is_read      INTEGER,
  body         TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, msg_id)
);

CREATE INDEX IF NOT EXISTS im_messages_session_time
  ON im_messages(account_id, session_id, send_time DESC, msg_id DESC);

CREATE INDEX IF NOT EXISTS im_messages_account_time
  ON im_messages(account_id, send_time DESC, msg_id DESC);

CREATE TABLE IF NOT EXISTS im_state (
  account_id TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, scope, key)
);

CREATE INDEX IF NOT EXISTS im_state_scope
  ON im_state(account_id, scope);
```

### 5.2 `im_messages`

- `body` 存整条消息的 JSON（即当前内存中的 `ChatMessage`，包含 `__sent` / `__delivery` / `__error`）。
  - 消息字段（回复、合并转发、卡片、回执、焚毁）仍在演进，全字段建列会导致频繁迁表；只把查询、排序、去重需要的字段单列。
  - `__delivery` 必须一起存：重启后待确认消息仍要恢复重发队列。
- `msg_id` 是服务端消息编号，同一账号内唯一；`(account_id, msg_id)` 主键天然去重。
- `send_time` 用毫秒整数；排序统一 `send_time DESC, msg_id DESC`，避免同一毫秒内顺序抖动。
- `session_type` 冗余存储，读取时可以不做协议字段推断。
- `is_read` 可空，保留原始 `undefined` 语义。
- 不设全局 5000 条上限：容量不再受 WebView 配额限制；需要回收时由后续“按会话保留最近 N 条”的维护任务处理（见 11.3）。

### 5.3 `im_state`

通用小状态表，按 `scope` 区分，值为 JSON 或纯文本。这样新增一类状态不需要再迁表，同时仍然做到“一条记录一次写入”。

| scope | key | value | 说明 |
| --- | --- | --- | --- |
| `unread` | sessionId | 数字字符串 | 会话未读条数 |
| `unread_at` | sessionId | 数字字符串 | @我未读条数 |
| `unread_id` | msgId | 时间戳字符串 | 已计未读的消息 id，用于离线重投去重 |
| `interaction` | msgId | JSON `{ reactions?, recall?, readers?, readTimes? }` | 一条消息的全部交互状态 |
| `read_confirmation` | msgId | `"1"` | 本机已确认的阅读回执，避免重复发送 |
| `read_command` | commandMsgId | JSON（完整 IM 消息） | 待发送/待确认的阅读确认命令，含 `__delivery` |
| `outbox` | msgId | JSON（完整 IM 消息） | 未确认/待重发的普通消息，避免滚出启动窗口后丢失重发入口 |
| `burn_deadline` | msgId | 截止时间戳 | 阅后即焚倒计时 |
| `receipt` | msgId | JSON `ReceiptAudience` | 发送时接收人快照 |
| `mention` | msgId | JSON `MentionNotice` | @我提醒 |
| `mention_removed` | msgId | 时间戳 | 用户手动移除的提醒，防止历史回填重新出现 |

`interaction` 采用“一条消息一行”而不是四个 map 各一张表：写入时只需重写这条消息的交互，读取时按消息 id 批量取，避免不同 map 的行数不一致。

### 5.4 账号隔离与清理

- 所有读写都必须传 `account_id`（当前登录用户 id）。
- 显式退出登录、鉴权失效回到登录页时，调用 `im_account_clear(account_id)` 删除该账号的 `im_messages` 与 `im_state`，保持现有“退出即清本机数据”的隐私语义。
- **应用升级、普通重启不清库**；只有用户主动退出才清。
- 换账号登录不会看到上一个账号的数据；即使旧账号数据因异常残留，也因 `account_id` 过滤不可见。

## 6. Rust 命令契约

新增 `src-tauri/src/im_store.rs`，所有命令通过 `spawn_blocking` 执行，避免同步命令占用主线程。`lib.rs` 注册命令。

### 6.1 消息

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
  pub msg_id: String,
  pub session_id: String,
  pub session_type: i64,
  pub send_time: i64,
  pub msg_type: i64,
  pub from_id: String,
  pub is_read: Option<i64>,
  pub body: String,
}
```

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `im_messages_upsert` | `accountId`, `rows: MessageRow[]` | 写入行数 | 单事务 `INSERT ... ON CONFLICT(account_id,msg_id) DO UPDATE` |
| `im_messages_recent` | `accountId`, `limit` | `string[]`（body，按时间升序） | 启动预热 |
| `im_messages_session` | `accountId`, `sessionId`, `limit` | `string[]`（升序） | 打开会话时加载最近窗口 |
| `im_messages_around` | `accountId`, `sessionId`, `msgId`, `before`, `after` | `string[]`（升序） | 定位历史消息时加载上下文 |
| `im_messages_get` | `accountId`, `msgId` | `string \| null` | 按 id 查单条 |
| `im_messages_delete` | `accountId`, `ids` | 删除行数 | 本地删除/清理 |
| `im_account_clear` | `accountId` | — | 删除该账号全部消息与状态 |

排序约定：

- `recent` / `session`：SQL 用 `ORDER BY send_time DESC, msg_id DESC LIMIT ?`，Rust 侧反转为升序返回。
- `around`：目标及之前取 `before` 条（降序取后反转），目标之后取 `after` 条（升序）。
- 同一毫秒内用 `msg_id` 兜底，保证重启前后顺序一致。

### 6.2 状态

```rust
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEntry {
  pub key: String,
  pub value: String,
}
```

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `im_state_upsert` | `accountId`, `scope`, `entries: StateEntry[]` | 写入行数 | 单事务批量 upsert |
| `im_state_query` | `accountId`, `scope`, `keys?: string[]` | `StateEntry[]` | 不传 keys 取全部；传 keys 按 500 个分块 `IN (...)` |
| `im_state_delete` | `accountId`, `scope`, `keys: string[]` | 删除行数 | 删除指定项 |
| `im_state_clear` | `accountId`, `scopes?: string[]` | 删除行数 | 清空某几类状态 |
| `im_state_trim` | `accountId`, `scope`, `keep` | 删除行数 | 只保留按 `updated_at` 最新的 N 条（回执、提醒用） |

所有命令返回 `Result<_, String>`；数据库错误返回中文错误文本，前端只记录日志。

## 7. 前端仓储层 `services/im/store.ts`

职责：把 `invoke`、参数命名、错误处理、写入串行化封装起来，`stores/im.ts` 不直接写 SQL 命令细节。

```ts
export interface PersistedMessage extends ImMessage {
  sessionId: string
  sessionType: number
}

export async function saveMessages(accountId: string, rows: PersistedMessage[]): Promise<void>
export async function loadRecentMessages(accountId: string, limit: number): Promise<PersistedMessage[]>
export async function loadSessionMessages(accountId: string, sessionId: string, limit: number): Promise<PersistedMessage[]>
export async function loadMessagesAround(accountId: string, sessionId: string, msgId: string, before: number, after: number): Promise<PersistedMessage[]>
export async function getMessage(accountId: string, msgId: string): Promise<PersistedMessage | null>
export async function clearAccount(accountId: string): Promise<void>

export async function putState(accountId: string, scope: string, entries: Array<{ key: string; value: string }>): Promise<void>
export async function getState(accountId: string, scope: string, keys?: string[]): Promise<Array<{ key: string; value: string }>>
export async function deleteState(accountId: string, scope: string, keys: string[]): Promise<void>
export async function clearState(accountId: string, scopes?: string[]): Promise<void>
```

实现约束：

1. 捕获所有 `invoke` 异常，调用注入的 `onError`（由 `stores/im.ts` 写入应用日志），**不向业务抛错**。
2. 维护模块级写入串行链：

   ```ts
   let chain: Promise<void> = Promise.resolve()
   function enqueue(task: () => Promise<void>): Promise<void> {
     chain = chain.then(task, task)
     return chain
   }
   ```

   所有写操作（消息、状态、清账号）都走 `enqueue`，保证退出登录时的 `clearAccount` 一定排在已发出的写入之后。
3. 非 Tauri 环境（浏览器 `pnpm dev`）第一次失败后设置 `unavailable = true`，后续直接跳过，避免每次消息都打一条错误日志。
4. 读取失败返回空数组，调用方按“本地没有缓存”处理。

## 8. 写入路径

### 8.1 消息

内存中的 `persistMessages()` 从“全量重写”改为“标脏 + 合并写”：

```ts
const pendingMessageWrites = new Map<string, ChatMessage>()
let writeTimer: ReturnType<typeof setTimeout> | null = null
let lastWriteAt = 0
let writing = false
```

- 所有变更点调用 `persistMessages(message)`，把该消息放入 `pendingMessageWrites`。
- 首条消息（距上次写入 ≥ 500ms）立即 flush；其余在 500ms 窗口内合并。
- 每次 flush 最多取 500 条，`saveMessages(account, rows)` 一次 IPC；超过 500 条时继续下一批。
- 失败时把该批放回队列，按 2s → 5s → 10s → 30s 退避重试；只记一次日志，避免刷屏。
- `__delivery` 变化（`pending` → `queued` → `failed` → `confirmed`）也走同一条队列；`MessageDelivery.changed` 回调需要带上消息对象。

必须标脏的位置（实施时逐一核对）：

| 场景 | 位置 |
| --- | --- |
| 新消息进本地 | `addMessage()` |
| 历史/回填/扫描合并 | `mergeHistoryMessage()` |
| 发送回执确认、`send_time` 被服务端校正 | `receipt` 事件分支 |
| 撤回/焚毁改变消息正文 | `consumeInteraction()` 中 `applyRecall` 的受影响消息 |
| 合并转发明细补全 | `loadForwardDetails()` |
| 阅后即焚 | `burnMessage()` |
| 投递状态变化 | `MessageDelivery.changed` |

不再需要“保留最近 5000 条 + 未确认消息额外保留”的裁剪逻辑；数据库本身没有 5MB 限制。

### 8.2 未读

- `unread` / `unreadAt`：按 `sessionId` 标脏，flush 时 upsert 当前值；被清空的会话改成 `deleteState(scope, [sessionId])`。
- `unreadIds`：新增 id 放入 `pendingUnreadIds`，flush 时批量 upsert；启动加载后如超过 5000 条，调用 `deleteState` 删除最旧的部分（保持现有上限语义）。
- 标脏点：`addMessage()` 计未读、`clearUnread()`、`applyMute()`、`markLeftGroup()`、`upsertSession()` 清理已退群会话。

### 8.3 交互与阅读确认

- 交互状态按 `msgId` 标脏：
  - `consumeInteraction()` 根据控制消息的 `interactionTarget()`、撤回 id、`readMsgIds` 标记。
  - `applyRecall()` 删除 reaction 时标记该消息。
  - `burnMessage()` 标记焚毁消息。
- `localReadConfirmations`：成功确认后按 `msgId` upsert `read_confirmation = "1"`。
- `pendingReadCommands`：新增/状态变化时 upsert 完整命令 JSON；确认或失效后 `deleteState('read_command', [id])`。
- `burnDeadlines`：设置/删除时 upsert/delete。
- 原来 `persistInteractions()` 整块写 `yl.im.interactions.<uid>` 的逻辑删除，改为 flush 上述几个脏集合。
- 启动时必须**全量**恢复 `read_command` 与 `burn_deadline`（数量小且影响重发/隐藏）；`interaction`、`read_confirmation` 按加载窗口批量恢复。

### 8.4 回执名单

`stores/receipts.ts`：

- 去掉 `localStorage` 读写。
- `capture()` 先从内存取；没有则 `await getState('receipt', [msgId])`，命中就放回内存；仍未命中才按原逻辑请求群成员/部门名单。
- 捕获成功后只把这一条快照写入 `pendingReceipts`，500ms 合并 upsert。
- `clear()` 删除该账号全部 `receipt` 状态。
- 内存中仍保留最多 5000 条（与原上限一致），数据库不强制裁剪；后续可用 `im_state_trim` 控制。

### 8.5 @我提醒（第二阶段）

`stores/mentions.ts` 与回执同理：

- `observe` / `handle` / `reopen` 按 `msgId` upsert `mention`。
- `remove` 删除 `mention` 并 upsert `mention_removed`。
- `handleAll` 批量 upsert 状态变化的提醒。
- 启动时加载全部 `mention` 与 `mention_removed`（提醒总量远小于消息）。

### 8.6 flush 时机

| 时机 | 行为 |
| --- | --- |
| 常规变化 | 500ms 合并后异步写 |
| 单条且距上次写入 ≥500ms | 立即写，保证实时性 |
| `visibilitychange` → hidden | 立即 flush |
| `pagehide` | 立即 flush |
| `stop()`（切账号/断线重连不触发） | 立即 flush |
| 退出登录 `resetLocal()` | 取消待写队列，串行链上追加 `im_account_clear` |
| 应用退出 | 依赖窗口“关闭即隐藏”，进程仍存活；真正退出最多丢失最近 500ms 的写入，可接受 |

## 9. 读取路径

### 9.1 启动 hydrate

`loadLocal()` 仍同步加载会话列表、置顶/折叠/免打扰、群元数据（这些继续放 `localStorage`，服务端可回填）。消息与 IM 状态改为异步：

1. `cleanupLegacyStorage()`：删除 `yl.im.messages`、`yl.im.unread*`、`yl.im.interactions.*`、`yl.im.receipt-audiences.*`、`yl.im.mentions.*`。不做数据迁移。
2. 并行读取：
   - `im_state_query('read_command')`、`im_state_query('outbox')`、`im_state_query('burn_deadline')`、`im_state_query('mention')`、`im_state_query('mention_removed')`、`im_state_query('unread')`、`im_state_query('unread_at')`、`im_state_query('unread_id')`。
   - `im_messages_recent(account, 1000)`。
3. 合并进内存时避免覆盖启动期间新到的数据：
   - 记录 hydrate 开始后被动过的 `unread`/`unreadAt` 会话，跳过这些 key。
   - 消息按 `msg_id` 去重，已存在的不覆盖。
   - 交互/确认按加载窗口批量读，合并时内存优先。
4. 对载入的消息执行一次 `applyRecall`（只改内存，不回写）。
5. `delivery.restore([...本账号消息, ...待发送阅读确认])`。
6. 完成后标记 `hydrated`，`start()` 的事件处理照常。

hydrate 不阻塞 WebSocket 建连：连接可以在 hydrate 完成前建立，新消息先进入内存，hydrate 合并时去重。用 `account + epoch` 防止切换账号后旧 hydrate 回填。

### 9.2 启动窗口与按会话加载

- 启动只加载最近 `1000` 条（跨会话），足以覆盖未读会话和最近聊天。
- `selectSession(id)` 先检查 `loadedWindows`：
  - 未加载过则异步 `im_messages_session(account, id, 300)`，把消息并入内存和索引。
  - 本地仍为空时才回退到 `loadHistory()` 请求服务端。
  - 加载完成后如用户已切走，丢弃结果。
- `currentMessages` 仍是“已加载消息中属于当前会话的部分”，排序改为 `(send_time, msg_id)`，与数据库一致。
- ChatView 仍只渲染最后 300 条；更早历史通过 `HistoryModal` 的 `loadOlderHistory()` 主动加载，行为不变。

### 9.3 定位与引用

- `loadUntilMessage()` 先查 `im_messages_get(account, msgId)`：
  - 命中则 `im_messages_around(sessionId, msgId, 150, 150)` 加载上下文并返回。
  - 未命中再按原逻辑扫描服务端历史。
- 引用的原消息不在窗口内时，`MessageBubble` 已有“引用的原消息尚未加载 · 点击查看”兜底，不新增 UI。
- 收藏定位：窗口内的消息保持原行为；超出窗口的旧消息可能定位不到，与旧版超过 5000 条后的行为一致。后续如需完善，可在定位时按收藏的 `sourceId + itemId` 做一次数据库模糊查询。

### 9.4 回执

- 打开回执面板时 `audience.get()` 先返回内存快照；没有则由 `capture()` 异步从 SQLite 取。
- 未命中缓存才回退到现有的群成员/部门接口采集，10 秒超时逻辑不变。

## 10. 清理与迁移

- **不迁移消息**：`yl.im.messages` 直接删除；升级后首次登录从离线消息和历史接口重新拉取。
- **不迁移未读/交互/回执**：同样删除旧 key，首启会短暂出现“未读清零/回执名单需重新采集”，之后不再发生。这样避免在首次启动时搬运数 MB JSON、再触发一次卡顿。
- 保留在 `localStorage` 的数据：会话列表、置顶/折叠/免打扰、群元数据、登录凭据、服务地址、窗口状态。它们要么服务端可回填，要么不属于 IM 业务数据。
- 清理函数幂等，每次启动执行；用 `localStorage` 扫描前缀即可，成本可忽略。

## 11. 失败、降级与维护

### 11.1 数据库不可用

- `store.ts` 捕获 `invoke` 异常，交由 `im.log()`/`logEvent` 记录一次“本地存储不可用，已降级为内存模式”。
- 后续写入直接跳过，消息仍正常收发、UI 仍正常显示，只是重启后丢失。
- 不弹窗、不阻断登录，避免数据库问题演变成“不能聊天”。

### 11.2 写入失败

- 失败批次保留在脏队列中，指数退避重试（上限 30s）。
- 连续失败超过 5 次后暂停自动重试，只记录一次错误；下一次用户操作或窗口隐藏时再尝试。

### 11.3 数据维护（后续）

本次不实现自动裁剪。预留 `im_state_trim` 与后续消息维护任务：

- 每个会话保留最近 N 条（建议 5000），删除更早的缓存；需要时从服务端重拉。
- `read_confirmation` 只保留最近 90 天，避免长期累积。
- 数据库体积异常时，可在设置中提供“清除本机聊天缓存”。

## 12. 性能预期

| 操作 | 现状 | 改造后 |
| --- | --- | --- |
| 单条消息落盘 | 序列化最多 5000 条 + 同步写 | 1 行 JSON + 异步 IPC（首条） |
| 500 条离线消息 | 最多 500 次全量序列化 | 1 次 ≤500 行事务（或 2 批） |
| 主线程阻塞 | 明显 | 基本无（Rust `spawn_blocking`） |
| 冷启动消息读取 | 同步解析数 MB JSON | 异步读 1000 行，按需再加载 |
| 未读/交互/回执写入 | 每次整块 JSON | 只写变化的 key |
| 容量 | ~5MB 配额，超限静默丢 | 磁盘可用空间 |

## 13. 测试与验收

### 13.1 自动化

1. `pnpm build`：`vue-tsc --noEmit && vite build` 通过。
2. `cd src-tauri && cargo check`：Rust 命令与迁移编译通过。
3. `scripts/check-auth-lifecycle.cjs`：现有登录续期回归不退化。
4. 更新 `scripts/check-message-store.cjs`：
   - 补齐 `@tauri-apps/plugin-notification`、`json5` 等 mock（脚本当前已因缺少 mock 失败）。
   - 用内存版 `services/im/store.ts` mock 替换 SQLite，断言：
     - 重启后消息只按脏消息恢复，不再读写 `yl.im.messages`；
     - 未读、待发送阅读确认、焚毁截止时间从状态表恢复；
     - 回执快照可懒加载；
     - 退出登录调用 `im_account_clear`；
     - 旧 localStorage key 被清理。
5. 新增 Rust 单元测试（`db.rs` 内）：内存 SQLite 建表 → upsert 去重 → 按会话分页 → 清账号。

### 13.2 手工验收

1. 登录后观察日志不再出现每条消息的持久化卡顿；离线消息批量到达时界面可操作。
2. 收到消息后立即强制退出并重开：消息、未读、待发送阅读确认仍在。
3. 打开一个久未打开的会话：先出现最近 300 条缓存，随后正常收发。
4. 断网 10 秒恢复：不触发重新登录，阅读确认在重连后补发。
5. 退出登录再登录：上一个账号的消息/未读不可见，数据库无该账号残留。

### 13.3 生产环境验证（2026-11-26）

环境：macOS，`pnpm tauri dev`（0.1.29），直连生产环境，账号彭志强；使用用户提供的 AccessToken（不写入仓库）。旧版安装包 / 旧数据目录均先备份。

| 项目 | 结果 |
| --- | --- |
| 迁移 | 已有 v2 库（`settings`/`components`/`schema_meta`）升级到 `user_version=3`，新增 `im_messages`、`im_state`，原表数据保留 |
| 首启写入 | 738 条真实消息约 7.5 秒内分 5 个事务落库；`im_state` 写入 `interaction` 169、`mention` 7、`mention_removed` 4、`unread_id` 3 |
| 旧数据清理 | `yl.im.messages`、`yl.im.unread*` 和当前/其它账号的 `yl.im.interactions.*`、`yl.im.mentions.*` 被删除；`yl.im.sessions`、`pinned`、`muted`、`folded` 等偏好保留 |
| 重启恢复 | 重启后消息总数不变；除服务端每次重连都会重投的 7 条控制/合并转发消息外，其它 731 条 `updated_at` 保持首次写入时间，说明启动窗口读的是本地库，没有把历史整包重新 upsert |
| 读路径实证 | 停库后插入一条只存在于本地 SQLite 的消息（真实群会话、`from_id` 用本人避免产生未读），重启并打开该会话后消息出现在聊天窗口；验证后已删除该行 |
| 登录/连接 | 给定 token 请求配置中心、`uamapi/v2/users/{uid}/details`、`emb/sessions/latest` 均返回 200；连接 WSS 后服务端轮换了 access_token（localStorage 随之更新），收发正常 |

未覆盖：退出登录清库（需要密码重新登录）、真实未读产生（需要第二账号或手机端向本账号发消息）。这两条由 `scripts/check-message-store.cjs` 与 Rust 单元测试覆盖。

验证技巧：dev 版的 WebKit 数据目录是 `~/Library/WebKit/YX`，打包版是 `~/Library/WebKit/com.tom.YX`，两者 localStorage 不互通；给 dev 版注入登录态要改前者。判断是否真的从 SQLite 恢复时，只看“没有重写”不够，最好向库里写一条只有本地才有的消息，重启后确认它能显示出来。

## 14. 实施步骤

- [x] **P0 数据库与仓储层**
  - `db.rs` 迁移 v3；新增 `im_store.rs` 与命令注册。
  - 新增 `services/im/store.ts`，实现读写 API 与串行写入链。
  - `cargo check`、`pnpm build` 通过。
- [x] **P1 消息写入与启动窗口**
  - `stores/im.ts` 删除 `yl.im.messages` 读写，改为脏消息队列。
  - 启动 hydrate 最近 1000 条；`selectSession` 按会话加载 300 条。
  - 旧 key 清理。
- [x] **P2 未读/交互/回执**
  - 未读、交互、阅读确认、焚毁截止时间迁移到 `im_state`。
  - `stores/receipts.ts` 懒加载 + 单条写入。
  - 退出登录清理账号数据。
- [x] **P3 提醒与收尾**
  - `stores/mentions.ts` 迁移到 `im_state`。
  - 更新 `README.md`、`LESSONS.md`（如有新踩坑）。
  - 更新回归脚本并跑通 `pnpm build` + 脚本。

实施备注（与初稿的差异）：

1. `im_store.rs` 的命令参数统一用 `camelCase`（`accountId`、`sessionId`、`msgId`），与前端 `invoke` 习惯一致。
2. `stores/im.ts` 额外暴露 `hydrate()` 与 `flush()`：前者等待启动恢复完成（重复调用复用同一 Promise），后者立即冲刷消息/未读/交互/回执/提醒队列，供页面隐藏、退出登录和回归脚本使用。
3. `scripts/check-message-store.cjs` 新增内存版 SQLite 命令模拟，真实运行 `services/im/store.ts`，不再依赖 `localStorage` 断言；同时补齐 Tauri 通知、窗口角标等 mock。

## 15. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| hydrate 与新消息竞态 | 新消息被旧数据覆盖/丢失 | 按 id 去重；记录启动后已修改的未读 key 并跳过；账号 epoch 校验 |
| Windows 首次加载变慢 | 会话切换时短暂空白 | 只读 300 条；UI 已有空态/加载态；失败回退服务端 |
| 数据库写放大 | 磁盘 IO 增加 | 批量事务 + WAL + 500ms 合并 |
| 退出清理与写入竞争 | 残留旧账号数据 | 所有写走串行链，`clearAccount` 排在最后 |
| 旧数据未迁移 | 首启未读/回执短暂丢失 | 设计已知取舍；消息可从服务端重拉，回执可重新采集 |

回滚方式：保留 `localStorage` 的会话/偏好数据；若需退回旧版，旧版会重新从服务端拉取消息，只是丢失 SQLite 中的新状态。数据库表可保留，不影响旧版运行。

## 16. 全文检索（v4）

### 16.1 目标与范围

消息落库后支持本地全局搜索：聊天正文、附件文件名、卡片标题、合并转发明细、发送人/会话名，以及会话与联系人。搜索完全在本地进行，不把关键词发给服务端。

不索引：附件内容本身、已撤回/焚毁消息（前端会把 `content` 置空后重新 upsert）、受保护消息。

### 16.2 表结构

迁移 v4 给 `im_messages` 增加 `search_text`（抽取后的纯文本），并建立 external content 模式的 FTS5 表：

```sql
ALTER TABLE im_messages ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
CREATE VIRTUAL TABLE im_messages_fts USING fts5(
  search_text,
  content='im_messages',
  content_rowid='rowid',
  tokenize='trigram'
);
```

`im_messages_fts_insert/delete/update` 三个触发器负责同步；`ON CONFLICT DO UPDATE` 的 upsert 会走 update 触发器（先 `delete` 旧行再插入新文本）。迁移结束时执行一次 `INSERT INTO im_messages_fts(im_messages_fts) VALUES('rebuild')`，让已有 rowid 先进入索引，避免首次回填时 `delete` 找不到行。

中文不依赖词典：trigram 把连续文本按 3 字符切片，任意 ≥3 字的子串都能命中；2 字及以下的查询走 `search_text LIKE '%词%'` 兜底。

### 16.3 抽取规则

`im_store::build_search_text()` 与前端 `services/im/content.ts` 的 `messageText()` 对齐：

| 消息 | 索引内容 |
| --- | --- |
| 1 文本 | 原文 |
| 96 富文本 | 文本块（去 HTML 标签）+ 图片/文件块的 `file_name`/`show_name` |
| 99 复合 | `brief` + `contents[].content`（type 0/1 去标签；其它尝试按文件卡片取文件名） |
| 24 合并转发 | `brief` + 内层每条消息的文本/文件名 + `from_name` |
| 2/3/4/5/6/14/23/25/30 | `file_name`/`show_name`/`name`/`title` |
| 8/12/15/21/31 | 标题/摘要 |
| 10/11/19/27/28/29 | 分享内容、摘要、名片名、表情说明 |
| 所有消息 | `from_name`、`to_name`（支持按人/按群检索） |

撤回/焚毁后 `content` 为空串，`search_text` 被重算为空，update 触发器同时清掉旧索引。

### 16.4 查询

`im_messages_search(accountId, keyword, sessionId?, limit?, offset?)`：

1. 关键词按空白拆词，逐词分流：字符数 ≥3 走 FTS `MATCH`，更短的走 `LIKE`；多词之间是 AND。
2. FTS 词用双引号包裹并转义内部 `"`，避免用户输入被当成 FTS 查询语法。
3. `account_id` 必带，可选 `session_id`；按 `send_time DESC, msg_id DESC` 排序，`limit + 1` 判断是否还有下一页。
4. 返回 `body` 列表，由前端复用 `messageText()` 生成摘要并高亮，避免后端再维护一套渲染规则。

### 16.5 升级与回填

v4 迁移只改结构；`Db::open` 后在后台线程执行 `im_store::search_backfill()`，按 `rowid > 上次游标` 分批 500 行补 `search_text`，不阻塞启动。补写会触发现有 update 触发器建索引。无文本可抽取的消息（语音、抖动等）跳过，但游标继续推进，不会重复扫描。

### 16.6 前端入口

`GlobalSearch.vue`（ChatView 内挂载）：

- `⌘K` / `Ctrl+K` 或左侧搜索框旁的放大镜按钮打开。
- 三组结果：会话（名称匹配）、聊天记录（SQLite 搜索）、联系人（复用 `contactService.searchEntries`）；↑↓ 选择，Enter 打开，Esc 关闭。
- 点击消息结果：`im.openChat()` 切到会话后调用现有的 `locateMessage()` → `loadUntilMessage()`（先查本地 `messages_around`，未命中再翻服务端历史）→ `scrollIntoView` + 高亮。

### 16.7 已知取舍

- 2 字以内的查询无法用 trigram，退化为 `LIKE` 全表扫描；在 10 万条量级仍可用，但明显大于 FTS 查询。
- HTML 去标签是轻量实现（状态机 + 常见实体解码），不追求与 `DOMParser` 逐字一致，索引足够用。
- 索引会额外占用约一份正文的存储（`search_text` + FTS 索引），需要时可后续加“按会话保留最近 N 条”的裁剪任务。
- `backfill` 每次启动都会扫一遍 `search_text = ''` 的行；这些行大多是无文本消息，数量少，成本可忽略。

### 16.8 拉取全部历史

本地索引只覆盖已落库的消息。搜索面板在“聊天记录”无结果时提供「拉取全部历史后重试」：

1. 先展开代价说明（逐会话翻页、耗时/请求量、磁盘与内存占用），用户确认后才开始。
2. 复用 `completeReplyHistory()` 按会话拉取：从最新往前的 `HistoryPager`（每页 100 条），消息照常经过 `mergeHistoryMessage()` 落库并触发 FTS 索引；`historyProgress[sessionId].complete` 为真的会话直接跳过，取消过的会话可从上次 offset 继续。
3. 会话按 `lastTime` 倒序处理，先补最近活跃的会话；`historyBackfill` 暴露会话级 `done/total/failed/cancelled`，`historyProgress` 提供当前会话已扫描条数。
4. 任务在 Pinia store 中运行，关闭搜索面板不会中断；再次打开面板可取消（`cancelBackfillAllHistory()`）。取消只停掉当前正在拉取的会话，避免误停楼层回复面板自己发起的补全。
5. 完成或取消后自动用当前关键词重跑搜索，已拉取的部分立即可用。

注意：这一步会把历史消息加载进 `im.messages` 内存，历史很多时内存会明显增长；这是一次性、用户主动触发的操作。服务端没有“按关键词搜索历史”的接口，要覆盖全部历史只能翻页。
