# 账号登录与 SSO

## 1. 账号模型

`AccountManager`（`CMClient/base/accountmanager.cpp`）是账号层入口，核心方法：

```cpp
AccountManager::loadAllLocalAccount(wstring const&)      // 启动时加载全部本地账号
AccountManager::initAccountEngine(shared_ptr<MailEngine>, bool)
AccountManager::shutdownAndStopAll()                      // 退出时统一关停
AccountManager::addAccount
AccountManager::AccountLock                                // 账号级互斥锁
```

**关键设计**：

- **一个账号 = 一个 `MailEngine` 实例**，由 `shared_ptr` 管理；
- `shutdownAndStopAll` 用独立线程（`ara::make_thread`）执行，说明退出时要**并行关停多个引擎**，不能阻塞主线程；
- `AccountLock` 意味着同一账号的并发操作（比如同步与发信同时进行）要串行化；
- 账号持久化文件三态：`account.dat` / `account.edat` / `account.sdat`（明文 / 加密 / 强加密），见 `coremail/04`。

`AddAccountDlg` 是"添加账号"对话框，方法包括：

```cpp
AddAccountDlg::testAccountBySetting    // 用当前填的服务器参数试连
AddAccountDlg::finishAndAddAccount
AddAccountDlg::guestAccountSetting     // 访客账号
AddAccountDlg::OnHandleExternalAuth
```

`guestAccountSetting` 说明支持**访客/临时账号**（可能对应 `user:getTempSession`）。

---

## 2. 登录流程（可还原的骨架）

### 2.1 能力探测

```
Protocol::temporaryVerify
Protocol::releaseDoLogin
temporaryVerify → SSLSocket::async_connect → async_switch_ssl
```

**推断**：登录前先做一次"临时验证"——建立连接、协商 TLS、探测服务端类型/版本/支持的认证方式，再决定走哪条登录路径。这正是多协议（proprietary / IMAP / POP3 / EWS）共存的必要前置步骤。

### 2.2 私有协议登录

```
/s/json?func=user:getPasswordKey     ← 取口令加密公钥
/s/json?func=user:login              ← 提交登录
/s/json?func=user:getTempSession     ← 临时会话
```

配合 `checkPasswordEncryptType`（见 `coremail/05`），链路推断为：

1. `getPasswordKey` 拿到服务端公钥与算法标识；
2. 客户端用 RSA（或 SM2）加密口令；
3. `user:login` 提交 `{user, encryptedPassword, ...}`；
4. 成功返回 `sid`（会话 ID），后续所有接口带 `sid`。

#### 2.2.1 反编译确认（第二版）

`CoremailClient::_loginImp`（`0x1010f6824`）本身只做**入参校验**：用户名或口令为空时直接回调 `Login rejected: password is empty for user %v`，不发起任何请求。真正的登录在它派生的异步链里（`0x101112d9c`，109 KB 伪代码，证据 `ev_33ad542eecf817bb8e99a191eb44138b109936816f801fb0acde3be82de49a4b`）。

从 `user:login` 请求的组装代码可读出**提交字段**：

| 字段 | 含义 |
|---|---|
| `dynPwd` | 动态口令（2FA） |
| `cell` | 短信验证码 |
| `img` | 图形验证码 |
| `logincontextmcid` | 登录上下文 ID（多端/多会话） |
| `dev` | 设备标识 |
| `fn` | 登录方式/函数名 |
| `os` | 操作系统标识 |
| `time` | 时间戳 |
| `token` / `nonce` / `sign` | **设备证书登录的 SM2 签名三元组** |

同时确认了两条分支：

1. **会话模式**：日志 `User %v login via session mode`——已有有效 session 时不再走口令登录。
2. **设备证书（SM2）**：日志 `DeviceCert: supportAuthDeviceCert=false, skip SM2 keypair` 说明这是**可被服务端关闭的能力**；`generateDeviceCertToken` 取 token 后本地生成 SM2 密钥对并签名（`token/nonce/sign`），即**登录阶段就能用证书替代口令**。

另有 `Login globalVerify failed for user %v, ec:%v(%v)`，说明登录前后还有一次 `global:verify` 校验（与 `03` 里 `global:verify` 接口对应）。

### 2.3 IMAP / POP3 登录

```
ImapClient::_login_imp
ImapClient::_login_ntlm_imp
ImapClient::_login_plain_imp
```

三种登录方式：普通（`LOGIN`）、**NTLM**、**PLAIN**。这与 `coremail/03` 中 SMTP 的 `AUTH LOGIN/NTLM/PLAIN` 对应，说明 IMAP/SMTP 的认证实现是成套的。

**推断**：`_login_ntlm_imp` 用于 Exchange/AD 环境，`_login_plain_imp` 用于 `AUTH PLAIN` 的服务器。

### 2.4 登录结果类型

二进制中有 `CoremailEngine::Login_RetCode` 枚举，作为回调参数出现：

```cpp
function<void(Login_RetCode, ara::var)>
```

**推断**：`Login_RetCode` 覆盖"成功 / 口令错 / 需要二次验证 / 需要图形码 / 需要改密 / 账号锁定 / 需外部认证"等分支——从 `LoginSecondAuthContext` 的存在可以确认二次验证是独立分支而非错误码。

---

## 3. 二次验证（2FA）

`LoginSecondAuthContext` 的方法完整覆盖了国内常见的多因子组合：

| 方法 | 含义 |
|---|---|
| `TriggerLoginSecondAuth` | 触发二次验证 |
| `SendSmsValidCode` | 发送短信验证码 |
| `SendVerifyCellCodeOnLogin` | 登录时发送手机验证码 |
| `GetLoginSecondAuthImageCode` | 获取图形验证码 |
| `FinishGetLoginSecondAuthImageCode` | 图形码获取完成回调 |
| `BackupLoginSecondAuthImgContext` / `RestoreLoginSecondAuthImgContext` | 图形码的备份/恢复上下文 |

**推断**："备份/恢复"这两个 Context 说明图形码的获取是**可中断、可恢复**的异步流程（网络慢时先存上下文，回来接着走），而不是简单的同步请求。

---

## 4. 外部认证与 CMS SOO

### 4.1 术语澄清

二进制里同时出现 `cmsso`、`CMS SOO`、`ExternalAuth`。从字符串看：

```
ExternalAuth cmsso
ExternalAuth cmssocallback
ExternalAuth handlecmssoresult
ExternalAuth followlogin
ExternalAuth getuseremail
ExternalAuth setauthuser
ExternalAuth checksupportclipass
ExternalAuth applyapppwd
ExternalAuth _cmsso
ExternalAuth afterssoauthcallback
```

这是一条**完整的认证状态机**，每一步都有独立日志：

1. `cmsso` — 发起 CMS SOO；
2. `cmssocallback` — 回调；
3. `handlecmssoresult` — 处理结果；
4. `getuseremail` — 取用户邮箱；
5. `setauthuser` — 设置已认证用户；
6. `followlogin` — 跟随登录（用 SSO 拿到的凭据换 `sid`）；
7. `checksupportclipass` — 检查是否支持"客户端口令"；
8. `applyapppwd` — 申请应用专用密码（供 IMAP/SMTP 用）。

### 4.2 协议与 URL

```
cmsso://fasoncm.rd.mt/coremail/ssologin.html?uid={{email}}
```

（这是一条**模板字符串**，`{{email}}` 是占位符。注意主机 `fasoncm.rd.mt` 是**研发环境域名**——`rd` = research & development，`mt` 是内部域。这说明这行模板是从测试配置里带进生产包的，或者生产环境也复用了这个 scheme 的形态。）

同时存在：

```
/sso/entry.jsp?to=arch&sso.sid=
/sso/entry.jsp?to=setting.delivery.ai&page=detach&sso.sid=
/sso/entry.jsp?to=setting.delivery.ai&page=d&sso.sid=
/ssologin.html?uid=
```

**推断**：
- **CMS SOO 是一个独立的认证服务**，通过 `cmsso://` scheme 与网页端 `ssologin.html` 交互；
- 客户端把 AccessToken/SessionID 作为 `sso.sid` 参数传给网页端，实现**"客户端登录后，点链接直接在浏览器里免登"**（对应 `to=arch` 归档、`to=setting.delivery.ai` AI 设置等深链）；
- 反向也成立：网页端可唤起 `cmsso://` 回到客户端（由 `CFBundleURLTypes` 的 `mailto`/`cmmailto` 之外的 scheme 注册承担，或依赖插件）。

### 4.3 与 `Plugin_CommandServer::onSSOAuthCallback` 的关系

```cpp
Plugin::Plugin_CommandServer::onSSOAuthCallback(
    GUIHandleEventBase*, function<bool(string, string, string)>)
```

**推断**：因为本地 HTTP 服务对外暴露 SDK，**必须防止任意网页调用 SDK 读取邮件**。所以 SDK 侧需要一个"SSO 授权回调"，用三方参数确认调用方身份。这是一个安全设计点，而非普通功能。

---

## 5. `CFBundleURLSchemes` 只注册了 `mailto` 与 `cmmailto`

实测 `Info.plist`：

```xml
<key>CFBundleURLSchemes</key>
<array>
  <string>mailto</string>
  <string>cmmailto</string>
</array>
```

但二进制里 `cmsso`、`lunkr`、`notes://`、`wxWork://` 都作为字符串存在：

```
notes://,lunkr://,mailto://,cmmailto://
```

**推断**：
- `cmsso://` / `lunkr://` / `notes://` 是**"被打开"**的外部 scheme（客户端作为 handler 去调起别的 App，而不是被别人调起）；
- `lunkr` 与 `notes` 在 `plugin/setting_im.js` 中作为 IM 的 `coremail_backend_local` / 本地应用路径使用。

即：**客户端自己只声明了邮件相关的两个 scheme**，其余是"调起第三方"的白名单。

---

## 6. 多账号 / 共享账号

| 证据 | 含义 |
|---|---|
| `LANG_SHAREDACCOUNT_AGENT` / `_AGENT_SENT` | 共享账号 + 代理发送 |
| `LANG_SMIME_SEND_SHARE_SENDER_NO_CERT` | 共享账号的证书隔离 |
| `LANG_SMIME_SEND_NONE_CONFACCOUNT_NO_CERT` | "非登录账号"（配置了但不作为主登录） |
| `AccountManager::AccountLock` | 账号级并发控制 |
| `LANG_SIGNATURE_CHOOSE_INFO=请选择共享账号` | 签名按账号区分 |

**推断**：支持三类身份：
1. **登录账号**（有 `sid`，可发信）；
2. **共享账号**（他人授权，可"代表发送"，`_AGENT_SENT`）；
3. **非登录账号**（仅配置用于收信/展示，不能发加密邮件）。

---

## 7. 代理

```
ShowNetworkProxySetting: true     // conf/syssetting.js
```

**推断**：设置里可配 HTTP/SOCKS 代理，作用于 `ara::http` 与 `SSLSocket`。macOS 侧是否读系统代理未确认。

---

## 8. 未确认项

- `Login_RetCode` 的完整枚举值。
- `temporaryVerify` 具体探测哪些端点（是否包含 `clientVersionCheck.jsp`）。
- `cmsso://` 在生产环境的主机名（包里只有 `fasoncm.rd.mt` 这个研发域名）。
- SSO 回调时 `onSSOAuthCallback` 的三个 `string` 参数分别是什么。
- 是否有 OAuth2/OIDC 标准支持（未发现 `openid` / `authorize` 端点字符串）。
- `user:login` 里 `token`/`nonce`/`sign` 的具体签名原文（拼接顺序与哈希算法未读到，只确认存在 SM2 三元组）。
- `logincontextmcid` 的生成规则（哪台机器/哪个上下文算同一个 ID）。
