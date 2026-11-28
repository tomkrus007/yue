# 集团 CAS 应用免登录打通记录（扫码桥）

实测日期：2026-11-28。账号：本机真实账号（`eCode=NwQeOY`）。结论均可复现，命令见文末。

## 结论

E-HR、主数据这类应用走集团 CAS（`sso1.yuexiu.com`），linksso 的 `create_session` Cookie 对它们无效。原版桌面端也没有 CAS 处理代码，会停在 CAS 登录页。

但 linksso 与 CAS 已经打通、共用同一套扫码会话：**把桌面端 `loginTicket` 当作「扫码人」**，就能静默走完 CAS 的扫码登录，拿到 TGT（`CASTGC`），再写进 WebView。实测 E-HR、主数据都不再需要输入密码。

`YX/src/services/app-desk.ts` 的 `casTgt()` 实现的就是这条链路，`src-tauri/src/app_window.rs` 负责把 `CASTGC` 写进窗口。

## 链路

| 步骤 | 请求 | 关键点 |
| --- | --- | --- |
| 1 | `GET https://ssoser.yuexiu.com/casSessionManager/qrcode/GetQRCodeUUID?t=<ms>` | 返回纯文本 32 位 key，不是 JSON |
| 2 | `POST https://linksso.yuexiu.com/qrcode/create`，表单 `key` + `loginTicket` | `loginTicket` 来自 `{sso}/oauth2/logintoken`；返回 `nonce` |
| 3 | `POST https://linksso.yuexiu.com/qrcode/confirm?key=&nonce=` | 用 nonce 代替手机端确认，返回 `{"status":1}` |
| 4 | `GET https://ssoser.yuexiu.com/casSessionManager/qrcode/Await?key=` | 返回 CAS 的 `loginTicket`；异步落库，可能要轮询 1～3 次 |
| 5 | `GET .../qrcode/LoginAuthorize?redirect_uri=<sso1/cas/login>&response_type=id_token&login_token=<步骤4>` | 返回单引号 JS 对象字面量 `{idToken, username}`，idToken 约 5 分钟过期 |
| 6 | `POST https://sso1.yuexiu.com/cas/v1/tickets`，表单 `username=<username>&password=#QRCODE#<idToken>` | `201` + `Location: .../cas/v1/tickets/TGT-xxx`，正文 `form action` 里也有同一地址 |
| 7 | 把 `TGT-...` 作为 `CASTGC`（domain `sso1.yuexiu.com`、path `/cas/`、Secure、HttpOnly）写入应用窗口 | 应用跳 CAS 时直接 302 回 `service?ticket=ST` |

## 与「待办 CAS 复用」研究的关系

[待办外部浏览器与CAS登录复用研究](/Users/tom/Documents/code/old/yue/doc/待办外部浏览器与CAS登录复用研究.md) 的结论是「拿不到 ST，只能人工登录」。那份结论仍适用于**系统浏览器**（浏览器里写不了 Cookie），但它没有找到扫码桥，所以「客户端凭证换不到 CAS 会话」这一条现在可以说得更准确：

- 用 OAuth JWT 当密码调 `/cas/v1/tickets`：`400`；
- 用 `#QRCODE#<idToken>` 当密码调 `/cas/v1/tickets`：`201`，返回 TGT；
- 有 TGT（`CASTGC`）时 `GET /cas/login?service=` 直接 302 出 ST。

## 关键坑

- `#QRCODE#` 前缀是 CAS 登录 webflow 的约定，REST 接口同样认；密码位不能传 JWT / AccessToken。
- `CASTGC` 的 `path` 按 CAS 自己下发的属性写：`sso1.yuexiu.com` + `/cas/` + Secure + HttpOnly。
- `LoginAuthorize` 的响应不是合法 JSON（单引号），只能按正则取值，`JSON.parse` 会抛异常。
- `Await` 一次拿不到 `loginTicket` 是正常的，CAS 侧确认是异步的。
- TGT 有有效期，客户端按 30 分钟缓存；过期后应用会回到 CAS 登录页，重新打开窗口会重新换一次。
- 系统浏览器（`openUrl`）无法写 Cookie，只能人工登录；这是打开方式的固有限制，不是链路问题。

## 复现命令

```bash
AT=$(cat yx_at.txt)
B64=$(printf 'link_desktop:bGlua19jbGllbnRfc2VjcmV1' | base64)
LT=$(curl -s "https://www.bingolink.biz:443/sso/oauth2/logintoken?access_token=$AT" \
  -H "Authorization: Basic $B64" -H "X-Requested-With: XMLHttpRequest" -H "ClientType: pc" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['login_token'])")

KEY=$(curl -s "https://ssoser.yuexiu.com/casSessionManager/qrcode/GetQRCodeUUID?t=$(date +%s)000")
RESP=$(curl -s -X POST "https://linksso.yuexiu.com/qrcode/create" \
  -H "Content-Type: application/x-www-form-urlencoded" -d "key=$KEY&loginTicket=$LT")
NONCE=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['nonce'])")
curl -s -X POST "https://linksso.yuexiu.com/qrcode/confirm?key=$KEY&nonce=$NONCE"

QLT=$(curl -s "https://ssoser.yuexiu.com/casSessionManager/qrcode/Await?key=$KEY" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('loginTicket',''))")

AUTH=$(curl -s "https://ssoser.yuexiu.com/casSessionManager/qrcode/LoginAuthorize?redirect_uri=$(python3 -c "import urllib.parse;print(urllib.parse.quote('https://sso1.yuexiu.com/cas/login',safe=''))")&response_type=id_token&login_token=$QLT")
IDT=$(echo "$AUTH" | python3 -c "import sys,re;print(re.search(r\"idToken'\s*:\s*'([^']+)'\",sys.stdin.read()).group(1))")

curl -s -D - -o /dev/null -X POST "https://sso1.yuexiu.com/cas/v1/tickets" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=peng.zhiqiang" --data-urlencode "password=#QRCODE#$IDT" \
  | grep -i '^location'
```

拿到 `TGT-...` 后验证：

```bash
curl -s -o /dev/null -D - \
  "https://sso1.yuexiu.com/cas/login?service=https%3A%2F%2Fehr.yuexiu.com%2FehrAuthService%2Fsso" \
  -H "Cookie: CASTGC=TGT-..."
```

应返回 `302`，`Location` 带 `?ticket=ST-...`。
