# TMSDK 组件化、跨平台构建与本地配置库设计

> 状态：**设计稿，未实施**。目标分支 `feat/tmsdk-component`（基于 `spike/wemeet-p0`）。
> 关联文档：`腾讯会议移植可行性评估.md`、`腾讯会议P0验证记录.md`、`官方零信任客户端架构与移植分析.md`。

## 0. 目标与范围

### 0.1 要解决的问题

| # | 问题 | 目标 |
|---|---|---|
| G1 | DMG 155 MB，改几个页面也要全量重下 | 安装包降到 **≈5 MB**；TMSDK 从"随包分发"改为"独立组件" |
| G2 | 组件只能靠重新发版获取 | 组件支持 **本地文件** 与 **网络 URL** 两条源，同一个压缩包、同一套校验 |
| G3 | 下载地址写死，换源要发版 | 默认地址入库（SQLite），运行时可改，改完立即生效 |
| G4 | 没有 CI，只能手工打包 | GitHub Actions 出 macOS / Windows 安装包；先出 macOS 组件包，Windows 后续 |
| G5 | Rust 里混着 macOS 专用路径与命令 | 平台相关代码显式 gate，平台相关**配置**进 SQLite，数据库放系统默认目录 |
| G6 | macOS 现有能力 | IM / 云盘 / 会议 / 零信任 **不退化** |

### 0.2 明确不做

- Windows 端的腾讯会议与零信任（无对应 SDK / 客户端，见 §4.5）。
- 自动更新器（`tauri-plugin-updater`）：包已经只有 ~5 MB，全量更新可接受，本次不引入。
- 把登录态、token、记住的密码搬进 SQLite——仍留在 localStorage（换库会牵连会话状态，另立议题）。
- TMSDK 的裁剪、降级、替换（保留腾讯原包，改一个字节都可能影响其自校验）。

---

## 1. 现状梳理

### 1.1 体积构成（实测，v0.1.26）

| 项 | 大小 | 说明 |
|---|---|---|
| `YX_0.1.26_aarch64.dmg` | 155 MB | 现在的分发物 |
| `YX.app` | 365 MB | 解包后 |
| └ `Contents/Frameworks/TMSDK.framework` | **355 MB** | 腾讯会议 SDK，**本项目从不改动** |
| └ `Contents/MacOS/YX` | 9.0 MB | 主程序，`dist` 内嵌在里面 |
| └ `Contents/Resources` | 0.2 MB | 图标等 |
| `dist/`（前端产物） | 3.5 MB | gzip 后 1.2 MB |

TMSDK 压缩后：`tar.gz` 150 MB，`tar.zst -19` **118 MB**（`zstd -T0 -19`，约 10 秒）。

结论：DMG 里 **97% 的字节是 TMSDK**，业务代码只有 9 MB。把 TMSDK 摘出去，包就是 5 MB 量级。

**拆分后实测（PR1，`pnpm tauri build`）**：

| 项 | 拆分前 | 拆分后 |
|---|---|---|
| `YX_0.1.26_aarch64.dmg` | 155 MB | **5.16 MB** |
| `YX.app` | 365 MB | 9.21 MB |
| `otool -L Contents/MacOS/YX` | 含 `@rpath/tmsdk_wemeet_sdk…` | 无 tmsdk 依赖 |

### 1.2 TMSDK 的加载方式与硬约束（已实测）

**（1）当前是链接期强依赖。** `otool -L YX` 里有：

```
@rpath/tmsdk_wemeet_sdk.framework/Versions/A/tmsdk_wemeet_sdk
```

框架目录不存在时，进程在 dyld 阶段就起不来。这是"组件化"必须先解决的第一个问题。

**（2）shim 只用到 2 个符号。** `wemeet_shim.cc` 对 TMSDK 的全部外部引用：

- `GetWemeetSDKInstance()`（`wemeet_shim.cc:191`）
- `ReleaseWemeetSDKInstance()`（`wemeet_shim.cc:328`）

其余都是头文件里的纯虚接口（`IWemeetSDK` / 各 `I*Callback`），vtable 在我们自己编译的 .o 里。**改成 `dlsym` 只需两个函数指针，业务代码零改动**。

**（3）腾讯把包内相对路径写死在二进制里。** 树里共有 124 处 `LC_RPATH` 带：

```
@executable_path/../Frameworks
@executable_path/../Frameworks/TMSDK.framework/Versions/A/Frameworks/tmsdk_wemeet_sdk.framework/...
```

`@executable_path` = `YX.app/Contents/MacOS`，所以框架**必须最终位于 `YX.app/Contents/Frameworks/TMSDK.framework`**。三种摆法实测：

| 摆法 | dyld 加载 | `codesign` |
|---|---|---|
| 框架在 bundle 内（现状） | ✅ | ✅ |
| 框架在 `/tmp` + 主程序加 43 条绝对 rpath（树里所有含 framework 的目录） | ✅ | ✅ |
| `Contents/Frameworks/TMSDK.framework` 换成指向外部的符号链接 | ✅ | ❌ `invalid destination for symbolic link in bundle` |

**（4）会议 UI 实际跑在独立进程里。** P0 记录：框架初始化时用 `NSTask` 拉起 `TMSDKHelper.app`（bundle id `com.tencent.TMSDKHelper`，`LSUIElement=true`），相机/麦克风/屏幕录制的 TCC 授权落在 **TMSDKHelper** 上，不在 YX 上。

**（5）版本与架构。** `TMSDK.framework` `CFBundleShortVersionString = 3.21.303`，**arm64-only**，`LSMinimumSystemVersion 10.11`（观测自官方 5.2.97 客户端）。构建必须 `aarch64-apple-darwin`。

**（6）签名现状。** 当前产物是 **ad-hoc、且没有 bundle seal**：`codesign -dv` 显示 `Signature=adhoc`、`flags=0x20002(adhoc,linker-signed)`、`Info.plist=not bound`——即 Tauri 只让链接器给 Mach-O 打了 ad-hoc 签名，**没有对 .app 做 codesign**（配置里的 `hardenedRuntime` 默认 `true`，但因为没签名所以没生效）。

由此有两条结论：

- 现在往 `Contents/Frameworks` 里放东西**不会破坏任何签名**，组件安装天然可行；
- 一旦 CI 里真的跑了 `codesign`（或将来换成 Developer ID），bundle seal 就存在了，安装组件后**必须重签**。所以设计统一为"安装完就重签"。

实测：`codesign --force --sign - --entitlements src-tauri/Entitlements.plist YX.app` 后 `--verify --deep --strict` 通过，嵌套框架的腾讯签名（`TeamIdentifier=5PMRFKHZTP`）保持不变。

### 1.3 平台相关代码清单（不能跨平台的部分）

| 文件 | 平台相关点 | 现状 | 本次处理 |
|---|---|---|---|
| `wemeet/wemeet_shim.cc` | C++，链接 macOS framework | macOS | 目录拆成 `wemeet/macos/`，Windows 未来 `wemeet/windows/` |
| `build.rs` | `-Wl,-rpath`、`std::os::unix::fs::symlink` | 无 cfg，`ready` 分支只在 macOS 有意义 | 全部进 `#[cfg(target_os = "macos")]` |
| `src/wemeet.rs` | 强依赖 TMSDK；`.app/Contents/MacOS` 检查 | macOS | dlsym + 组件状态 + `cfg` gate |
| `src/zt_sdk.rs` | `/Applications/TrustAgentLauncher.app`、`/usr/bin/open`、`/bin/launchctl`、`/usr/bin/pgrep`、`/usr/bin/pkill`、`/usr/bin/id` | macOS 概念，但在 Windows 上也"能编译"只是必错 | `cfg(target_os="macos")` gate，非 macOS 返回"不支持"；路径/端口入 SQLite |
| `src/lib.rs` | `/usr/bin/afplay /System/Library/Sounds/Glass.aiff` | macOS 分支 | 抽 `platform::play_message_sound()` |
| `src/lib.rs` | `RunEvent::Reopen`（Dock 图标恢复窗口） | macOS 分支 | 保持 `cfg`，Windows 无对应 |
| `src/store_download.rs` | `/opt/homebrew/bin/ffmpeg`、`/usr/local/bin/ffmpeg` 兜底 | 已部分跨平台 | 额外搜索路径改为平台表，存 SQLite |
| `src/store_upload.rs` | `std::env::temp_dir()/YX/upload` | 可跑但不该写死 | 路径入 SQLite |
| `src/store_download.rs` | `app.path().download_dir()/YX` | 已跨平台 | 默认值入 SQLite，允许覆盖 |
| `src/media_stream.rs` | 纯 tokio/TCP | 跨平台 | 不动 |
| `src/window_state.rs` | `app_config_dir()/window-state.json` | 跨平台 | 保持 JSON（每次 resize 都写，塞进 SQLite 没有收益） |
| `tauri.conf.json` | `bundle.macOS.frameworks` / entitlements / infoPlist | macOS | 移除 `frameworks`，其余保留（Windows 下自动忽略） |
| `tauri.conf.json` | `titleBarStyle: Overlay` / `hiddenTitle` / `trafficLightPosition` | macOS 语义 | Windows 下退化为普通标题栏，可接受 |
| `capabilities/default.json` | `http:default` 白名单 | 跨平台 | 组件下载走 **Rust reqwest**，不进白名单（用户可填任意 URL，白名单写不死） |

### 1.4 平台相关配置 / 路径清单（本次要搬进 SQLite 的）

| Key | 现在的形态 | 默认值 |
|---|---|---|
| `component.url` | 硬编码（待新增） | `https://github.com/<owner>/<repo>/releases/download/tmsdk-v<ver>/TMSDK-<ver>-macos-arm64.tar.zst` |
| `component.cache_dir` | 无 | `app_cache_dir()/components` |
| `paths.download_dir` | `app.path().download_dir()/YX`（写死） | 同上 |
| `paths.spool_dir` | `std::env::temp_dir()/YX/upload`（写死） | `app_cache_dir()/upload` |
| `paths.ffmpeg` | 自动探测 + 两处 homebrew 写死 | `null`（自动探测），配了就优先用配置值 |
| `ui.message_sound` | 无（永远播） | `1` |

> 零信任的客户端路径与端口（`/Applications/TrustAgentLauncher.app`、`35440-35443`）**不进库**：这两个值由腾讯/品高官方客户端安装器决定，
> 改了也用不了；PR5 只把它们收进 `cfg(target_os = "macos")`。真需要换路径时再加 key，避免现在就多一个没人改的开关。

> 原则：**默认值仍由 Rust 按平台计算**，SQLite 只存"用户覆盖值"。这样升级后默认路径随平台 API 变化，不会被历史数据钉死。

### 1.5 打包与 CI 现状

- 无 `.github/workflows`，全部手工 `pnpm tauri build`。
- `bundle.targets: "all"`；macOS 侧 `frameworks` + `entitlements` + `infoPlist`。
- `src-tauri/vendor/TMSDK.framework/` 已在 `.gitignore`（355 MB，不入库），靠 `scripts/sync-wemeet.sh` 从官方 DMG 拷入。
- 许可证：腾讯 SDK 为公开可获取的组件，**已确认无二次分发合规风险**（2026-11 决策）。`vendor/README.md` 里"不分发"的旧措辞随 PR6 一并修正。
- 当前分支状态：`spike/wemeet-p0` 比 `main` 领先 14 个提交（会议 P0–P3 都在此分支）。

---

## 2. 组件包设计

### 2.1 命名与内容

```
TMSDK-3.21.303-macos-arm64.tar.zst        # 唯一分发形态，本地/网络同一份
├── component.json
└── payload/
    └── TMSDK.framework/…                 # 原样，保留符号链接/可执行位/嵌套层级
```

`component.json`：

```json
{
  "schema": 1,
  "component": "tmsdk",
  "version": "3.21.303",
  "platform": "macos",
  "arch": "arm64",
  "payload": "payload/TMSDK.framework",
  "min_app": "0.1.27",
  "notes": "From 云上越秀 5.2.97-arm64"
}
```

- `version` 取 `TMSDK.framework/Versions/A/Resources/Info.plist` 的 `CFBundleShortVersionString`。
- `min_app`：老版本 app 拒绝"太新"的组件，避免 dlsym 头文件与实现 ABI 不匹配。
- 打包脚本：`scripts/pack-tmsdk.sh`，用 `bsdtar --no-xattrs --no-mac-metadata` + `zstd -19`，产出 `.tar.zst` 与 `.sha256`（sidecar）。

### 2.2 安装流水线（两源合一）

```
来源A: 用户选本地文件（NSOpenPanel / 拖到页面）  ─┐
来源B: HTTP(S) 下载（reqwest，含进度、Range 续传）─┴→ 落到临时文件
        ↓ ① 解压到 staging（cache/components/staging-<ts>/）
        ↓ ② 校验（见 2.3）
        ↓ ③ 原子安装：ditto/rename 到 Contents/Frameworks/TMSDK.framework
        ↓ ④ 重签外层 app（代码签名修复 bundle seal）
        ↓ ⑤ dlopen，状态 ready（无需重启）
```

- 失败一律清理 staging，保留上一次可用状态（若有），错误原文回传前端。
- 安装前检查：`Contents/Frameworks` 可写；若 app 在只读卷（DMG 未拖入"应用程序"）→ 直接给出可操作提示。
- 版本相同则跳过安装（幂等），版本不同则替换并记录到 `components` 表。

### 2.3 校验（安全边界）

| 校验 | 本地文件 | 网络下载 | 说明 |
|---|---|---|---|
| 压缩包 sha256 | 不校验 | 不校验 | 只防「半截包」，而截断的包解压后 `codesign --deep --strict` 必然失败；`shasum` 计算只用于记录到库，不作为门槛 |
| `component.json` 结构 | 强制 | 强制 | 拒绝未知 schema / platform / arch |
| `min_app` ≤ 当前版本 | 强制 | 强制 | 防 ABI 错配 |
| **Tencent 代码签名** | **强制** | **强制** | `codesign --verify --deep --strict` + `TeamIdentifier == 5PMRFKHZTP` |
| 关键文件存在性 | 强制 | 强制 | `Versions/A/Frameworks/tmsdk_wemeet_sdk.framework/Versions/A/tmsdk_wemeet_sdk` |

签名校验是唯一"来源可信"的锚点：**用户可以把 URL 改成任意地址，但伪造不了腾讯的签名**。sha256 只用于完整性。

### 2.4 存放位置（决策）

**选定：装进 `YX.app/Contents/Frameworks/TMSDK.framework`。**

理由：腾讯写死了 `@executable_path` 相对路径，只有这个位置能做到 **rpath 零改动、TCC 归属不变、helper 路径不变**。

被否的两个方案：

| 方案 | 为什么否 |
|---|---|
| 外部固定路径 + 43 条绝对 rpath（实测可行） | 路径编译期写死；要 `/Library/...` 管理员权限；TMSDKHelper 换路径后 TCC 要重新授权；收益为零 |
| 独立进程 / 独立 app | 会议 UI 本来就自己开窗口，但登录、入会、置顶、响铃、事件回调要全改 IPC；工作量翻几倍，不解决体积 |

代价与缓解：

- 需要 app 包可写 → 安装前探测；失败提示"请先把 YX 拖进「应用程序」"。
- 改包必然破坏 bundle seal → 安装后 `codesign --force --sign - --options runtime --entitlements Entitlements.plist YX.app` 修复（已实测通过）。

### 2.5 加载方式：dlopen + dlsym

- `build.rs` 不再 `-framework tmsdk_wemeet_sdk`，只保留头文件路径用于编译 shim。
- shim 内首次使用时 `dlopen("<app>/Contents/Frameworks/TMSDK.framework/…/tmsdk_wemeet_sdk", RTLD_NOW|RTLD_LOCAL)`，再 `dlsym` 三个符号（`GetWemeetSDKInstance` / `ReleaseWemeetSDKInstance` / `GetWemeetSDKVersion`）；失败返回 `-100 "会议组件未安装"`。
- 未安装时行为与现有 stub 一致（前端已有"会议组件不可用"的提示路径），不再因缺框架而无法启动。
- 组件装好后 `dlopen` 立即生效，不需要重启进程。

**实测补充（PR1）**：框架内部的嵌套层级比表面更深——`tmsdk_wemeet_sdk` 依赖的 `wemeet_base.framework` 实际位于
`TMSDK.framework/Versions/A/Frameworks/tmsdk_wemeet_sdk.framework/Versions/A/Frameworks/TMSDKFramework.framework/Versions/A/Frameworks/wemeet_base.framework`，
而它自己的 `LC_RPATH` 只有 `@executable_path/../Frameworks`、`@loader_path/Frameworks` 和那条超长的 `@executable_path` 链。也就是说，
**dlopen 的成功依赖 `@executable_path` 正好是 `YX.app/Contents/MacOS`**——这从另一侧再次证明"组件必须装回 bundle 内"。
把框架放在临时目录、用一个裸可执行文件 dlopen 会报 `Library not loaded: @rpath/wemeet_base.framework…`；放进
`Test.app/Contents/{MacOS,Frameworks}` 的临时 .app 里再 dlopen，返回 `rc=0`，`GetWemeetSDKVersion` 读出 `3.21.303.110`。

### 2.6 与 app 更新的关系（**关键**）

用新 DMG 覆盖安装时，`Contents/Frameworks` 会被整个替换 → **组件会丢**。若不处理，每次更新 app 都要重下 118 MB，"瘦身"就白做了。

对策：**组件压缩包留在本地缓存**。

```
app_cache_dir/components/
├── TMSDK-3.21.303-macos-arm64.tar.zst      # 118 MB，安装过的包
└── TMSDK-3.21.303-macos-arm64.tar.zst.sha256
```

- 安装（无论本地还是网络）成功后把包留档。
- 启动/进入会议页时：bundle 内没有组件但缓存有 → **静默本地安装**（约 2–4 秒，无网络）。
- 缓存只保留最近 1 个版本，升级版本时清理旧的。
- 缓存目录可被系统清理工具删除，所以只当加速，不当唯一来源。

---

## 3. 配置库（SQLite）

### 3.1 选型

| 方案 | 结论 |
|---|---|
| **`rusqlite`（`bundled`）** | **采用**。Rust 侧直接读写，无 IPC；`bundled` 自带 SQLite，Windows 不需要系统库；同步 API 配 `Mutex<Connection>` 足够 |
| `tauri-plugin-sql` | 否。前端友好，但 Rust 侧拿不到好用的句柄，而"安装器要读 URL"恰恰在 Rust |
| JSON 文件 | 否。需要原子写、并发、迁移；且用户明确要求 SQLite |

前端不直接碰数据库：所有读写经 `settings_*` / `component_*` 命令，避免前端拿到 SQL 执行能力。

### 3.2 数据库位置

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/com.tom.YX/yx.db` |
| Windows | `%APPDATA%\com.tom.YX\yx.db` |
| Linux（不承诺） | `~/.local/share/com.tom.YX/yx.db` |

- 由 `app.path().app_data_dir()` 得到，**不在 app 包内**，更新/重装不丢。
- 启用 WAL：同目录会多出 `yx.db-wal`、`yx.db-shm`；备份即复制这三个文件。
- **数据库自身的路径不能存在数据库里**（鸡生蛋），这是唯一保留在代码里的路径常量，且用平台 API 而非硬编码。

### 3.3 Schema v1

```sql
PRAGMA journal_mode = WAL;
PRAGMA user_version = 1;

-- 用户覆盖值；value 为 NULL 表示"用平台默认"
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  INTEGER NOT NULL
);

-- 已安装组件记录（同一时刻只应有一条 id='tmsdk'）
CREATE TABLE components (
  id           TEXT PRIMARY KEY,      -- 'tmsdk'
  version      TEXT NOT NULL,
  platform     TEXT NOT NULL,         -- 'macos' | 'windows'
  arch         TEXT NOT NULL,         -- 'arm64' | 'x64'
  sha256       TEXT NOT NULL,
  install_path TEXT NOT NULL,
  source       TEXT NOT NULL,         -- 'local' | 'url' | 'cache'
  source_ref   TEXT,                  -- 本地路径或 URL
  installed_at INTEGER NOT NULL
);

-- 迁移元数据（user_version 之外的可读记录）
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

迁移：启动时读 `user_version`，按序执行 `migrations/v1.sql…`，每步在事务里 `PRAGMA user_version = n`。不引入 ORM。

### 3.4 读写模型

```
effective(key) = settings.value ?? platform_default(key)
```

- `platform_default` 是 Rust 函数，按 `cfg`/`app.path()` 计算，**不进库**。
- `settings_set(key, NULL)` = 恢复默认（删覆盖）。
- 所有写入走单连接 + 事务；读可用同一连接（命令都很快，不做连接池）。
- 启动时 `settings_get_all` 一次性给前端，前端只缓存展示。

### 3.5 进库 / 不进库

| 进 SQLite | 不进（保持 localStorage / 文件） |
|---|---|
| 组件 URL、缓存目录、下载目录、spool 目录、ffmpeg 路径 | AccessToken / refreshToken / 账号密码 |
| 零信任客户端路径与端口 | 窗口尺寸（`window-state.json`，PR2 可选迁移） |
| 组件安装记录 | 最近会话、草稿、免打扰等业务状态 |
| 提示音开关等平台开关 | 服务地址覆盖（`serverPaths`，登录态强相关） |

---

## 4. 跨平台改造

### 4.1 原则：能力探测优先于平台判断

不要到处写 `if cfg!(windows)`。定义一个能力视图，前端按它显隐入口：

```rust
pub struct Capabilities {
    pub meeting: bool,      // 本平台是否有可用组件（macos=true, windows=false 直到有 Windows 组件）
    pub zero_trust: bool,   // macOS only
    pub message_sound: bool,
}
```

`component_status()` 在 `meeting == false` 的平台返回 `unsupported`，而不是"缺失可下载"——否则 Windows 用户会点到一个注定失败的下载。

### 4.2 Rust 模块 gate 策略

| 模块 | 策略 |
|---|---|
| `wemeet.rs` | 命令始终注册；内部按 `capabilities.meeting` 分流。`dlopen` 实现仅 macOS，Windows 用 stub 返回"本平台暂不支持腾讯会议" |
| `zt_sdk.rs` | 整个模块 `#[cfg(target_os = "macos")]`；非 macOS 提供同名 `status/login/logout` stub，前端按 `zero_trust=false` 隐藏 |
| `platform.rs`（新增） | `play_message_sound()`（macOS `afplay`；Windows 先 no-op，后续 `MessageBeep`）、`open_path()`（统一走 `tauri-plugin-opener`）、`reveal_in_file_manager()` |
| `build.rs` | `ready` 分支、rpath、dev symlink 全部 `cfg(target_os="macos")`；Windows 直接编 `wemeet_stub` |
| `wemeet/` | `macos/wemeet_shim.{h,cc}`、`stub/wemeet_stub.cc`，将来 `windows/`。`build.rs` 按 `target_os` 选源文件 |

### 4.3 `tauri.conf.json` 按平台拆

- `bundle.macOS.frameworks` 删除（组件化后不再随包）。
- 新增加载器需要的 capability：`dialog:default`（选本地组件包）、`fs` 不开放（写文件在 Rust 里做）。
- Windows 预留 `bundle.windows`（nsis/wix 目标、图标）；第一阶段用默认值即可。

### 4.4 Windows 第一阶段能力矩阵

| 功能 | Windows 状态 |
|---|---|
| 登录 / IM / 通讯录 / 群管理 | ✅ 目标可用（纯 Rust + HTTP/WS，需 CI 验证） |
| 云盘（列表/上传/下载/预览） | ✅ 目标可用；`ffmpeg` 转码探测 `ffmpeg.exe` |
| 腾讯会议 | ❌ 无组件（等 Windows 版 TMSDK 验证） |
| 零信任 | ❌ 只支持 macOS 官方客户端 |
| 托盘、未读角标、窗口记忆 | ✅（`set_title` 在 Windows 上表现不同，需实测） |
| 提示音 | ⚠️ 第一阶段 no-op，后续接系统提示音 |

---

## 5. 构建与分发

### 5.1 组件包谁来生产

**GitHub 托管 runner 造不出来**：产物源头是官方 `云上越秀.app`（私有 DMG，且不入库、不分发）。所以：

- 组件包由**开发机**用 `scripts/pack-tmsdk.sh` 生成（118 MB），
- 用 `gh release create tmsdk-v3.21.303` + `gh release upload` 发布；
- 仓库里只提交 `src-tauri/components.json`（版本、sha256、URL、size），作为默认地址的**唯一事实来源**，首次启动 seed 进 SQLite。

CI 里需要 TMSDK **头文件**才能编译 shim：workflow 从已发布的组件包里只解出 `payload/TMSDK.framework/Versions/A/Headers`（约 60 KB）到 `src-tauri/vendor/`。这样仓库不存腾讯代码，CI 也不用开发者本机。

> 引导（bootstrap）问题：第一次发布前没有资产可解。做法是先在本机打一次包、发布、再让 CI 跑；或者用自托管 runner（把官方 DMG 放在固定路径），后者可把"生产组件包"也纳入 CI（`workflow_dispatch`）。

### 5.2 托管位置

**GitHub Releases**，理由：

| 通道 | 适用性 |
|---|---|
| Releases 资产 | ✅ 单文件上限 2 GB，118 MB 合适；支持 `latest` 与固定 tag 两种稳定 URL |
| Git LFS | ❌ 带宽/存储计费，克隆即拉 |
| Actions artifacts | ❌ 90 天过期，下载需鉴权 |
| `raw.githubusercontent.com` | ❌ 单文件 100 MB 上限，118 MB 超限 |
| 内网静态服务器 | ✅ 可用；把 `component.url` 指过去即可（这正是"运行时改 URL"的价值） |

**仓库已转为公共仓库**，因此默认 URL 可直接指向 Releases 资产匿名下载；若将来改回私有或换内网源，只需改 `component.url`（设计已解耦）。

### 5.3 Workflow 设计

**`release.yml`**（tag 触发，`v*`）

```
matrix:
  - macos-14        (aarch64-apple-darwin; TMSDK 只有 arm64)
  - windows-latest  (x86_64-pc-windows-msvc; stub shim)
steps:
  1. checkout / pnpm install / rust toolchain + target
  2. (macOS) curl 组件包 → tar 解出 Headers → src-tauri/vendor/TMSDK.framework/Versions/A/Headers
  3. pnpm build（vue-tsc + vite）
  4. pnpm tauri build
  5. (macOS) 校验产物里没有 TMSDK.framework（防止回退）
  6. 上传 artifact；tag 时 gh release upload
```

要点：

- macOS 用 `macos-14`（arm64）。`macos-13` 是 x86_64，交叉编译 arm64 会因 framework 缺失失败。
- 签名：无 Developer ID，`bundle.macOS.signingIdentity: "-"`（ad-hoc；Tauri CLI 是否接受该值需在 PR5 用一次真实构建确认，退路是显式不配置签名）。`hardenedRuntime` 保持默认 `true`，entitlements 继续放行库校验。
- 缓存：`~/.cargo/registry`、`target`、pnpm store；组件头文件也可 cache（key 用版本号）。
- Windows 首次跑通需要修 `build.rs`/`cfg`（见 §4.2），与"能否编译"这一步绑定。

**`publish-component.yml`**（可选，自托管 runner）：把 `pack-tmsdk.sh` 搬上 CI，输入官方客户端路径，产出资产。托管 runner 上不可用。

### 5.4 默认地址与运行时覆盖

- `src-tauri/components.json`：
  ```json
  {
    "tmsdk": {
      "version": "3.21.303",
      "platforms": {
        "macos-arm64": {
          "url": "https://github.com/tomkrus007/yue/releases/download/tmsdk-v3.21.303/TMSDK-3.21.303-macos-arm64.tar.zst",
          "sha256": "…",
          "size": 123456789
        }
      }
    }
  }
  ```
- 首次启动（或该 key 为空时）seed 成 `settings['component.url']`。
- 会议页提供"组件来源"输入框：校验 URL 合法性 → 写入 SQLite → 后续下载立即用新地址；提供"恢复默认"。

---

## 6. 命令与事件契约（已实现）

```rust
settings_get_all() -> [{ key, value, default, effective }, …]
settings_set(key, value: Option<String>) -> ()          // 空值 = 删除覆盖
component_status() -> {
  state: "ready" | "absent" | "unsupported" | "installing",
  version?, path?, error?, installed_bytes, cached_archive?, cached_bytes
}
component_install_local(path) -> ComponentStatus        // 选本地 tar.zst
component_install_url(url: Option<String>) -> ComponentStatus  // None = 用库里的地址
component_cancel() -> ()
component_clear_cache() -> u64                          // 返回释放字节数
component_reload() -> ComponentStatus                   // 手工替换后重新 dlopen

// 事件（所有安装入口共用）
"component-progress" { phase: "download"|"extract"|"verify"|"install"|"sign"|"cache"|"load"|"done",
                       received?, total?, message? }
```

前端落点：`src/views/WemeetView.vue` 的「会议组件」卡片（状态/版本/占用、选择本地包、URL 下载、
保存地址、从缓存恢复、清理缓存、取消安装）；`src/services/component.ts` 是 invoke 与事件封装。
组件没装好时「发起/加入会议」按钮直接禁用，避免点了才报错。

---

## 7. 实施拆分

| PR | 内容 | 验收 |
|---|---|---|
| PR1 | `build.rs` 改 dlsym、移除 `bundle.macOS.frameworks`、`wemeet/` 按平台分目录、`component_status`（仅探测） | `pnpm tauri build` 后 DMG ≈5 MB；无组件时 app 能启动，会议页报"未安装"；装上 vendor 的框架后功能如常 |
| PR2 | `db.rs`（rusqlite + 迁移）、`settings_*`、路径改造（下载目录/spool/ffmpeg） | `~/Library/Application Support/com.tom.YX/yx.db` 生成；改下载目录后下载落到新目录；重装 app 不丢设置 |
| PR3 | 安装器：本地文件 + URL 下载 + 校验 + 重签 + dlopen；缓存留档与自动回装 | 两条源都能装；装完立即能开会；重装 app 后首启自动从缓存恢复 |
| PR4 | 前端：组件面板、URL 设置、进度、失败提示、"清理组件缓存"（含占用大小） | 断网/坏包/只读卷都有可读错误 |
| PR5 | `platform.rs`、`cfg` gate、`capabilities()`、Windows 编译打通 | Windows 出安装包，IM 可用，会议/零信任入口隐藏 |
| PR6 | `scripts/pack-tmsdk.sh`、`release.yml`、首个组件 Release、文档更新 | tag 推上去自动出 macOS/Windows 包并挂 Release |

每步都必须过 `pnpm build`（`vue-tsc --noEmit && vite build`）与 Rust `cargo check`；PR1/PR3/PR4 需要真实账号在 `.app` 里验一次（不能用 `pnpm tauri dev`，见 P0 记录）。

### 7.1 进展

**PR1 已完成（`feat/tmsdk-component`）**

| 改动 | 文件 |
|---|---|
| 去掉链接期依赖，改运行时 `dlopen` + `dlsym`，新增 `yx_wemeet_load_library/library_error/version` | `wemeet/wemeet_shim.{h,cc}` |
| shim 按平台分目录：`wemeet/macos/`、`wemeet/stub/`；`build.rs` 只保留头文件路径，不再加 `-framework` / `-rpath` / dev 软链 | `build.rs`、`wemeet/` |
| 移除 `bundle.macOS.frameworks` | `tauri.conf.json` |
| `wemeet_component_status`（`ready` / `absent` / `unsupported`）、初始化前先加载组件 | `src/wemeet.rs`、`src/lib.rs` |
| 会议页显示组件状态与缺失提示；store 增加 `component` / `refreshComponent()` | `src/services/wemeet.ts`、`src/stores/wemeet.ts`、`src/views/WemeetView.vue` |
| 开发态安装脚本（`ditto` + 重签），临时替代尚未接入的安装器 | `scripts/install-wemeet.sh` |

验收结果：`pnpm tauri build` 产出 **5.16 MB** DMG，`otool -L` 无 tmsdk；`ditto` 装回框架并重签后 `codesign --verify --deep --strict` 通过、app 正常启动；
临时 .app 里 dlopen 返回 0 且读出版本 `3.21.303.110`。

本地验证方式：

```bash
pnpm tauri build --debug
./scripts/install-wemeet.sh src-tauri/target/debug/bundle/macos/YX.app
open src-tauri/target/debug/bundle/macos/YX.app
```

> 应用内安装器已接入（见下），`install-wemeet.sh` 现在只保留给开发者。

**PR3 + PR4 已完成：组件安装器与界面**

| 改动 | 文件 |
|---|---|
| 组件路径 / `dlopen` / 状态查询 / 安装 / 取消 / 清理缓存 / 重新加载 | `src/component.rs` |
| 解压（`/usr/bin/tar`，自动识别 zstd）→ 结构校验 → 腾讯签名校验 → `ditto` 落位（同级 incoming + 备份换入）→ `codesign --force --sign -` + `--verify --deep --strict` → `dlopen` | 同上 |
| 组件包留档到 `app_cache_dir/components/`，只保留 1 份；覆盖安装 app 后启动时**后台静默回装**（已实测） | 同上 |
| `components.json` 提供默认下载地址，启动时种子进 `settings`（`schema_meta` 记住种子值：用户没改过就跟随新版本，改过就永久保留） | `components.json`、`db.rs` |
| 前端「会议组件」卡片：状态/版本/占用、选本地包、URL 下载、保存/恢复默认、从缓存恢复、清理缓存、进度 | `services/component.ts`、`stores/wemeet.ts`、`views/WemeetView.vue` |
| 选文件用 `tauri-plugin-dialog`（HTML file input 拿不到真实路径） | `Cargo.toml`、`capabilities/default.json` |
| 打包脚本：`ditto` → `component.json` → `tar --no-xattrs` → `zstd -19`，产物 118 MiB + `.sha256` | `scripts/pack-tmsdk.sh` |

实测（debug 包）：把 118 MiB 包放进 `~/Library/Caches/com.tom.YX/components/` 后启动 app，
自动完成解压/校验/落位/重签/加载，日志 `组件回装完成：Some("3.21.303.110")`，
`codesign --verify --deep --strict` 通过，`components` 表写入 `source=cache`。
`schema_meta` 里记录了种子地址；`user_version` 从 1 迁到 2。

未做：断点续传（`Range`）。弱网重下的代价是 118 MiB，等有人反馈再加。

**PR5 已完成：跨平台 gate 与能力视图**

| 改动 | 文件 |
|---|---|
| `capabilities()` → `{ meeting, zero_trust, message_sound }`，前端按它显隐入口 | `lib.rs`、`services/platform.ts`、`SideNav.vue` |
| `zt_sdk` 整个模块仅 macOS 编译；其它平台同名命令返回「零信任只支持 macOS」 | `lib.rs` |
| `wemeet_init` 的 `.app/Contents/MacOS` 前置检查只在 macOS 生效 | `wemeet.rs` |
| `build.rs` 只在 macOS 且头文件就绪时编真 shim，其余编 stub | `build.rs` |
| ffmpeg 的 homebrew 兜底路径仅 macOS | `store_download.rs` |

> Windows 本机没有验证环境（需要 MSVC），以 CI 首次跑通为准。设计上 Windows 出包即「IM/云盘可用，
> 会议与零信任入口隐藏」，不承诺会议功能。

**PR6 已完成：CI 与发布**

- `.github/workflows/release.yml`：tag `v*` 或手动触发，矩阵 `macos-14`（dmg）+ `windows-latest`（nsis）；
  macOS 先从组件 Release 里只解出 `payload/TMSDK.framework/Versions/A/Headers` 再编译 shim；
  构建后断言产物里**没有** `TMSDK.framework`、`otool -L` 里**没有** tmsdk；tag 时用 `softprops/action-gh-release` 挂 Release。
- `package.json` 加 `"packageManager": "pnpm@12.23.0"`，CI 用 `corepack enable`。

**首次引导（必须做一次，否则 CI 的 macOS 构建取不到头文件）**

```bash
./scripts/pack-tmsdk.sh                       # 产出 dist-components/TMSDK-3.21.303-macos-arm64.tar.zst（118 MiB）
gh release create tmsdk-v3.21.303 \
  --title "TMSDK 3.21.303" \
  --notes "腾讯会议组件包（macOS arm64）" \
  dist-components/TMSDK-3.21.303-macos-arm64.tar.zst \
  dist-components/TMSDK-3.21.303-macos-arm64.tar.zst.sha256
```

- 这一步之后，`src-tauri/components.json` 里的默认地址才真的能下载，CI 也才能编 macOS 包。
- 换腾讯框架版本时：重新打包 → 新建 `tmsdk-v<ver>` Release → 更新 `components.json` 的 url 与 package.json 版本。
- 组件包**不需要**每次发版重打：地址固定即可。


**PR2 已完成：本地配置库**

| 改动 | 文件 |
|---|---|
| `rusqlite`（bundled）+ WAL，库在 `app_data_dir()/yx.db`；`user_version` 迁移建立 `settings` / `components` | `src/db.rs` |
| `settings_get_all` / `settings_set`（未知 key 直接拒绝，空值=恢复默认） | `src/db.rs`、`src/lib.rs` |
| 下载目录、上传 spool 目录、ffmpeg 路径、提示音开关改为读生效值 | `store_download.rs`、`store_upload.rs`、`lib.rs` |
| 前端封装 | `src/services/settings.ts` |

验收：启动后生成 `~/Library/Application Support/com.tom.YX/yx.db`（含 `-wal`/`-shm`），`PRAGMA user_version = 1`，
表 `settings` / `components` 就位；下载/上传仍能正常写入（默认值未变，行为无差异）。

---

## 8. 风险与未决问题

1. ~~合规~~ **已解决**：腾讯 SDK 公开可用，组件包可放 GitHub Releases。
2. ~~私有仓库~~ **已解决**：仓库已转公共，Releases 匿名可下。
3. **未公证 + 自改包**：ad-hoc 签名 + 运行时重签后，首次运行仍需"右键 → 打开"；若企业策略强制 Gatekeeper，可能报"已损坏"。这是当前分发方式的既有代价，组件化只是多了一次重签。
4. **TCC 归属**：相机/麦克风/屏幕录制仍然记在 `com.tencent.TMSDKHelper` 上（路径不变，不会因此重新授权，这是选"装回 bundle"的额外好处）。
5. **Windows 组件来源未验证**：官方 Windows 客户端是否内嵌同款 SDK、能否提取、API 是否同构，都还没看过。PR5 只保证"app 能编译能跑，会议不可用"。
6. **下载健壮性**：118 MB 无断点续传时，弱网体验差 → 建议用 `Range` + `.part` 临时文件（设计已预留，可放 PR3 或后续）。
7. **磁盘占用**：组件缓存 118 MB + 安装后 355 MB，共约 473 MB。**已确认需要**"清理组件缓存"入口，落在 PR3（命令 `component_clear_cache`）+ PR4（按钮与用量展示）。
8. **arm64-only**：Intel Mac 用不了会议（现状如此），CI 也只出 arm64 包；若将来要支持 Intel，需要腾讯提供 x86_64 slice，属于外部依赖。

---

## 9. 附：实测命令留档

```bash
# 体积
du -sh YX.app/Contents/Frameworks/TMSDK.framework      # 355M
ls -l  YX_0.1.26_aarch64.dmg                           # 155M

# 依赖
otool -L YX.app/Contents/MacOS/YX | grep tmsdk         # @rpath/tmsdk_wemeet_sdk.framework/…
otool -L vendor/…/tmsdk_wemeet_sdk | grep rpath        # 全部 @rpath/*，无绝对路径依赖

# 写死的 rpath（124 个二进制）
otool -l <bin> | awk '/LC_RPATH/{getline;getline;print $2}'

# 重签（组件安装后修复 bundle seal）
codesign --force --sign - --options runtime \
  --entitlements src-tauri/Entitlements.plist YX.app
codesign --verify --deep --strict YX.app                # 通过
codesign -dv …/TMSDK.framework                          # TeamIdentifier=5PMRFKHZTP 保持不变

# 符号链接方案被拒（记录，避免再试）
ln -s /path/TMSDK.framework YX.app/Contents/Frameworks/TMSDK.framework
codesign --force --sign - YX.app
# → invalid destination for symbolic link in bundle

# 压缩
tar --no-xattrs --no-mac-metadata -cf - TMSDK.framework | zstd -T0 -19 -o TMSDK.tar.zst   # 118M
```
