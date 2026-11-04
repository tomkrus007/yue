# 云上越秀 TrustAgent Mock

用 mock HTTP 服务代替真实 `TrustAgentLauncher`（深信服 aTrust / legendsec 零信任客户端），让"云上越秀"在不打通零信任隧道的情况下通过登录流程。

## 一、分析结论

### 1.1 应用身份

| 项 | 值 |
|---|---|
| 应用 | `/Applications/云上越秀.app`（com.bingo.linkyuexiu） |
| 类型 | Electron（解包式，无 asar） |
| 版本 | 5.2.97 (161) |
| 业务域 | `*.bingolink.biz`（SSO/UAM/IM/会议） |
| 零信任组件 | `/Applications/TrustAgentLauncher.app`（legendsec TrustAgent SDK 3.3.1.34005） |

### 1.2 登录流程中的 TrustAgent 卡点

云上越秀前端 `web/html/static/js/login.*.js` 的 webpack 模块 31（零信任助手）在**登录成功、进入主界面前**插入了一段强制校验：

```
SSO/UAM 密码登录成功 → 拿到 localStorage.AccessToken
  ↓
enableTrustAgent == 1 ?
  ├─ 是 → verifyServiceAvailable() ──失败──→ toast 报错，登录失败
  │        ↓ 成功(pong)
  │      isOnlineStatus(user_info)
  │        ↓ 返回 "online" → 直接进入主界面
  │        ↓ 返回非 online → loginTrustAgent(user_token) ──失败──→ 登录失败
  │                              ↓ 成功
  │                            延时 3s → 进入主界面 I(e,t)
  └─ 否 → 直接进入主界面
```

四个本地 HTTP 接口（`http://127.0.0.1:3544x`）决定了登录能否通过：

| 前端调用 | HTTP | 期望响应 | 前端判定 |
|---|---|---|---|
| `verifyServiceAvailable` | `POST /ping` body `{}` | `{"message":"pong"}` | `n.message=="pong"` |
| `isOnlineStatus` | `POST /trustagent` `{method:"status",params:{type:"user_info"}}` | `{"result":{"code":0,"message":"online"}}` | 无 `error` 且 `result.code==0 && result.message=="online"` |
| `loginTrustAgent` | `POST /trustagent` `{method:"login",params:{host,port,user_token}}` | `{"result":{...}}` 无 `error` | 无 `error` 即成功 |
| `isConnectedStatus`（业务页/安全浏览器） | `POST /trustagent` `{method:"status",params:{type:"nc_status"}}` | `{"result":{"code":0,"message":"connected"}}` | 同上 |
| `topic` register/unregister | `POST /trustagent` `{method:"topic",params:{type, callback:[...]}}` | `{"result":{"code":0,"message":"success"}}` | 同上 |
| `logoutTrustAgent` | `POST /trustagent` `{method:"logout",params:{}}` | 同上 | 同上 |

**端口回退逻辑**：前端先打 `35443`，失败后按 `35440→35441→35442→35443→35444…` 递增重试。mock 同时监听 35440-35443 四个端口。

**Mac 安装检查**：`checkMacAgentInstall()` 在登录页 `created()` 里检查 `/Applications/TrustAgentLauncher.app` 是否存在，不存在就弹"请按照指引安装【越秀越秀】"对话框循环。这台机器上真实 TrustAgent 已安装，所以此项已满足。

### 1.3 真实 TrustAgent 的故障表现

REA 分析 + curl 探活确认，本机真实 TrustAgent（trustagentsdk，Go+gin 服务）虽然进程在跑，但：

| 接口 | 真实响应 | 问题 |
|---|---|---|
| `/ping` | `301 → https://127.0.0.1:35443/ping` | HTTP 重定向到 HTTPS（自签证书），前端可能因证书/协议问题拿不到 `pong` |
| `user_info` | `{"error":{"code":-1,"message":"offline"}}` | 零信任用户未在线 |
| `nc_status` | `{"error":{"code":-1,"message":"disconnected"}}` | NC 隧道未连接 |
| `login` | `{"error":{"code":11126,"message":"认证服务器错误"}}` | 向 `zt.yuexiu.com:443` 认证失败（token/SPA/网络问题） |

因此云上越秀登录卡在 `verifyServiceAvailable` / `loginTrustAgent` 环节。

### 1.4 REA 取证要点

- **REA open_binary + inspect_artifact**：对 `TrustAgent_yuexiu_*.sdk.pkg`（xar 归档）做身份与清单确认（SHA-256 `0d921b77…`，PKG 根哈希）。
- **pkgutil --expand-full** 解出 `TrustAgentLauncher.app`（264 个条目，无完整性矛盾）。
- **REA inspect_macho**：`trustagentsdk` 为 universal Mach-O（arm64 切片 UUID `448E2BF7-…`，6 段、21 条 load command）。
- **字符串佐证**：Go+gin 框架，路由 `/ping`、`/trustagent`、`/proxyserver/check`；JSON-RPC 方法 `login/logout/status/topic`；字段 `user_token/nc_status`；错误码 `[0105005]`（Unauthorized）、`[0305002]`（File not found）；日志路径 `~/.TrustAgent/log/trustagentsdk_srv.log`。
- **postinstall 脚本**：确认 `product_mode=type=1`（SDK 模式）、LaunchAgent `com.legendsec.trustagentsdk.plist`（KeepAlive=true）、代理服务端口 36440-36443。

## 二、文件清单

```
mock-trustagent.js   # mock 服务主体（纯 Node.js http，无依赖）
setup.sh             # 一键部署：停真实 TrustAgent → 起 mock → 自检
restore.sh           # 恢复真实 TrustAgent
README.md            # 本文档
mock-trustagent.log  # 运行日志（部署后生成）
mock-trustagent.pid  # PID 文件
```

## 三、使用方法

```bash
# 部署（停真实 TrustAgent + 启 mock）
./setup.sh

# 启动"云上越秀"，正常登录即可

# 用完恢复真实 TrustAgent
./restore.sh
```

手动控制：
```bash
# 查看 mock 日志
tail -f mock-trustagent.log

# 停止 mock
pkill -f mock-trustagent.js

# 单独前台运行（调试）
node mock-trustagent.js
```

## 四、局限性

1. **只满足应用层校验，不提供网络隧道**。mock 让前端"以为"零信任已在线，但不创建真实的 NC/VPN 隧道。若 `*.bingolink.biz` 业务流量必须经 aTrust 隧道才能到达（即不在内网/VPN 环境），登录后的业务请求仍会网络不通。
2. **不模拟 NC 代理端口（3644x）**。安全浏览器（safeBrowser）在 `ENABLE_ZTE_TRUST==1` 时会把流量代理到 `127.0.0.1:zteServerPort`，mock 不提供该代理。登录本身不需要它。
3. **trustdservice 根守护进程未停**。它不占 3544x 端口，不影响 mock；如需彻底停掉：`sudo launchctl unload /Library/LaunchDaemons/com.legendsec.trustdservice.plist`。
4. **响应格式简化**。mock 返回精简 JSON（`result/error/message`），未回显 `jsonrpc:"2.0"` 和 `method` 字段——前端解析逻辑只检查 `error/result.code/result.message/message`，不依赖 JSON-RPC 元字段，已验证可用。
