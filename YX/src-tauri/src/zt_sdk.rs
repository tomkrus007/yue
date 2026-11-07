//! 本机零信任 SDK 的 JSON-RPC 客户端（对齐官方客户端与 `yx-cloud-kb/repo/win` 的做法）。
//!
//! 官方 macOS 客户端会在 `127.0.0.1:35440..35443` 起一个 SDK 服务（`trustagentsdk`），
//! 提供极简 JSON-RPC：
//!
//! ```text
//! POST /trustagent  {"method":"get_config","params":{"host":"zt.yuexiu.com","port":"443"}}
//!   → {"result":{"authlist":[{"type":"YX_TOKEN",...},{"type":"AD"},{"type":"LOCAL_UP"}]}}
//! POST /trustagent  {"method":"login","params":{"host":"zt.yuexiu.com","port":"443","user_token":"<越秀 AccessToken>"}}
//! POST /trustagent  {"method":"logout","params":{}}
//! POST /trustagent  {"method":"status","params":{"type":"user_info"}}  → {"result":{"code":0,"message":"online"}}
//! ```
//!
//! 方法名全小写、`port` 必须是字符串、字段名是 `user_token`（这些是实测结论，
//! 与 Windows 版 `win/tools/zt-login.ps1` 一致）。
//!
//! 说明：这一步等价于官方「云上越秀」在用户登录后做的事——把 IM 的 AccessToken
//! 交给本机零信任 SDK，由 SDK 去网关换会话。它不替代隧道本身。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::Value;

pub const APP_DIR: &str = "/Applications/TrustAgentLauncher.app";

const SDK_PORTS: [u16; 4] = [35443, 35440, 35441, 35442];
pub const DEFAULT_HOST: &str = "zt.yuexiu.com";
pub const DEFAULT_PORT: u16 = 443;

const TIMEOUT: Duration = Duration::from_secs(2);
/// `get_config` 要经网关往返，离线时会慢，单独给长超时
const SLOW_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug)]
pub enum SdkError {
    NotRunning,
    Http(String),
    Json(String),
    Gateway(String),
}

impl std::fmt::Display for SdkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SdkError::NotRunning => write!(
                f,
                "本机零信任 SDK 未响应（35440-35443）：请确认已安装 /Applications/TrustAgentLauncher.app；已尝试自动拉起但仍未就绪"
            ),
            SdkError::Http(e) => write!(f, "调用本机 SDK 失败：{e}"),
            SdkError::Json(e) => write!(f, "SDK 应答解析失败：{e}"),
            SdkError::Gateway(e) => write!(f, "{e}"),
        }
    }
}

/// 极简 HTTP/1.1 POST（只用于 127.0.0.1）。
fn http_post_timeout(port: u16, path: &str, body: &[u8], timeout: Duration) -> Result<Value, SdkError> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| SdkError::Http(e.to_string()))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(req.as_bytes()).map_err(|e| SdkError::Http(e.to_string()))?;
    stream.write_all(body).map_err(|e| SdkError::Http(e.to_string()))?;
    stream.flush().ok();

    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > 1 << 20 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(|| {
        SdkError::Http(format!(
            "SDK 应答不完整（收到 {} 字节，{} 秒超时）",
            buf.len(),
            timeout.as_secs()
        ))
    })?;
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    if status == 0 {
        return Err(SdkError::Http("无 HTTP 状态".into()));
    }
    if body.trim().is_empty() {
        return Err(SdkError::Http(format!("HTTP {status} 空应答")));
    }
    serde_json::from_str(body.trim()).map_err(|e| SdkError::Json(e.to_string()))
}

fn rpc(port: u16, method: &str, params: Value) -> Result<Value, SdkError> {
    rpc_timeout(port, method, params, TIMEOUT)
}

fn rpc_timeout(port: u16, method: &str, params: Value, timeout: Duration) -> Result<Value, SdkError> {
    let body = serde_json::to_vec(&serde_json::json!({ "method": method, "params": params }))
        .map_err(|e| SdkError::Json(e.to_string()))?;
    http_post_timeout(port, "/trustagent", &body, timeout)
}

/// 找一个可用的 SDK 端口（会顺带确认服务在线）。
pub fn find_port() -> Option<u16> {
    // SDK 登录/注销后的短时间内可能"端口接受连接但不回包"，多试两轮。
    // 四个端口属于同一个进程：某个端口开着却不回包，本轮直接结束。
    for round in 0..2 {
        for port in SDK_PORTS {
            let addr: SocketAddr = ([127, 0, 0, 1], port).into();
            if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err() {
                continue;
            }
            match rpc_timeout(port, "status", serde_json::json!({"type": "user_info"}), Duration::from_millis(1200)) {
                Ok(v) if v.get("jsonrpc").is_some() => return Some(port),
                _ => break,
            }
        }
        if round == 0 {
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    None
}

fn any_port_open() -> bool {
    SDK_PORTS.iter().any(|port| {
        let addr: SocketAddr = ([127, 0, 0, 1], *port).into();
        TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
    })
}

fn uid_string() -> String {
    std::process::Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "501".to_string())
}

fn launcher_running() -> bool {
    running("MacOS/TrustAgentLauncher")
}

/// 按需唤醒官方客户端：先让 App 把环境准备好，再按需拉起 SDK 与服务。
///
/// 官方客户端会把 `trustagentservice` / `trustdservice` 的 plist 改回 `KeepAlive=true`，
/// 且会 bootout 掉自己不认的 launchd 任务，所以 kickstart 不可靠：
/// 先在真正需要时才拉起，起不来就直接 spawn 二进制兜底。
pub fn agent_start() {
    if !launcher_running() {
        let _ = std::process::Command::new("/usr/bin/open")
            .args(["-a", APP_DIR])
            .status();
        std::thread::sleep(Duration::from_millis(800));
    }
    let uid = uid_string();
    for (label, bin) in [
        ("trustagentservice", "trustagentservice"),
        ("trustagentsdk", "trustagentsdk"),
    ] {
        if running(&format!("MacOS/{bin}")) {
            continue;
        }
        let target = format!("gui/{uid}/{label}");
        let _ = std::process::Command::new("/bin/launchctl")
            .args(["kickstart", "-k", &target])
            .output();
        for _ in 0..6 {
            std::thread::sleep(Duration::from_millis(250));
            if running(&format!("MacOS/{bin}")) {
                break;
            }
        }
        if !running(&format!("MacOS/{bin}")) {
            spawn_bin(bin);
        }
    }
}

fn spawn_bin(bin: &str) -> bool {
    let path = format!("{APP_DIR}/Contents/MacOS/{bin}");
    if !std::path::Path::new(&path).exists() {
        return false;
    }
    std::process::Command::new(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

fn running(pattern: &str) -> bool {
    std::process::Command::new("/usr/bin/pgrep")
        .args(["-f", pattern])
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

/// 用完就退：先 bootout 两个用户级 agent（解除 KeepAlive 守护，否则杀了会被立刻拉起），
/// 再终止 SDK/服务进程和隧道宿主。
pub fn agent_stop() {
    let uid = uid_string();
    for label in ["trustagentsdk", "trustagentservice"] {
        let target = format!("gui/{uid}/{label}");
        let _ = std::process::Command::new("/bin/launchctl")
            .args(["bootout", &target])
            .output();
    }
    for pat in [
        "MacOS/trustagentsdk",
        "MacOS/trustagentservice",
        "MacOS/TrustAgentLauncher",
        "MacOS/TrustAgent",
    ] {
        let _ = std::process::Command::new("/usr/bin/pkill")
            .args(["-f", pat])
            .status();
    }
}

/// 注销后还活着的进程（用于给出准确提示）。
pub fn agent_leftovers() -> Vec<String> {
    [
        ("trustagentsdk", "MacOS/trustagentsdk"),
        ("trustagentservice", "MacOS/trustagentservice"),
        ("TrustAgentLauncher", "MacOS/TrustAgentLauncher"),
        ("trustdservice", "MacOS/trustdservice"),
    ]
    .iter()
    .filter(|(_, pat)| running(pat))
    .map(|(name, _)| (*name).to_string())
    .collect()
}

/// 杀掉卡死的 SDK 进程；它由 launchd（KeepAlive）拉起，不需要 root。
fn restart_sdk_daemon() {
    if let Ok(out) = std::process::Command::new("/usr/bin/pgrep")
        .args(["-f", "MacOS/trustagentsdk"])
        .output()
    {
        for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-9", pid])
                .status();
        }
    }
    std::thread::sleep(Duration::from_millis(300));
}

/// 找不到时尝试拉起官方客户端，再等它把 SDK 服务起起来。
fn ensure_sdk() -> Result<u16, SdkError> {
    if let Some(port) = find_port() {
        return Ok(port);
    }
    if std::path::Path::new(APP_DIR).exists() {
        if any_port_open() {
            // 端口开着却不回包：SDK 进程卡死，重启它
            restart_sdk_daemon();
        }
        // 进程没起来（或刚被杀）：按需唤醒，起不来则直接 spawn
        agent_start();
    }
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(port) = find_port() {
            return Ok(port);
        }
    }
    Err(SdkError::NotRunning)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkStatus {
    pub port: u16,
    /// online / offline / unknown
    pub state: String,
}

pub fn status() -> Result<SdkStatus, SdkError> {
    let port = find_port().ok_or(SdkError::NotRunning)?;
    let v = rpc(port, "status", serde_json::json!({"type": "user_info"}))?;
    // offline 是正常状态，不是错误
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("");
        if msg != "offline" {
            if let Some(e) = gateway_error(&v) {
                return Err(SdkError::Gateway(e));
            }
        }
    }
    let message = v
        .get("result")
        .and_then(|r| r.get("message"))
        .and_then(|m| m.as_str())
        .or_else(|| v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()))
        .unwrap_or("unknown")
        .to_string();
    Ok(SdkStatus {
        port,
        state: message,
    })
}

/// 用云上越秀的 AccessToken 登录（等价于官方 App 登录后的动作）。
pub fn login(gateway_host: &str, gateway_port: u16, user_token: &str) -> Result<String, SdkError> {
    // 预检：网关必须能解析且真的连得上，否则 SDK 的 login 会一直挂到超时
    preflight_gateway(gateway_host, gateway_port)?;
    let port = ensure_sdk()?;
    let payload = serde_json::json!({
        "host": gateway_host,
        "port": gateway_port.to_string(),
        "user_token": user_token,
    });
    // 登录要走网关（SPA + TLS + 认证），给足 30 秒
    let login_timeout = Duration::from_secs(30);
    match rpc_timeout(port, "login", payload, login_timeout) {
        Ok(v) => {
            if let Some(err) = gateway_error(&v) {
                return Err(SdkError::Gateway(err));
            }
        }
        Err(e) => {
            // 应答丢了不代表失败：SDK 可能已经在后台登录成功，用 status 兜底
            let mut online = false;
            for _ in 0..40 {
                std::thread::sleep(Duration::from_millis(500));
                if let Ok(v) = rpc(port, "status", serde_json::json!({"type": "user_info"})) {
                    if v.get("result").and_then(|r| r.get("message")).and_then(|m| m.as_str())
                        == Some("online")
                    {
                        online = true;
                        break;
                    }
                }
            }
            if !online {
                return Err(SdkError::Http(format!(
                    "{e}；随后 20 秒内状态仍未变为 online"
                )));
            }
        }
    }
    Ok(format!("已通过本机 SDK（:{port}）登录 {gateway_host}:{gateway_port}"))
}

pub fn logout() -> Result<String, SdkError> {
    let port = ensure_sdk()?;
    let v = rpc(port, "logout", serde_json::json!({}))?;
    if let Some(err) = gateway_error(&v) {
        return Err(SdkError::Gateway(err));
    }
    Ok("已注销本机零信任会话".to_string())
}

fn gateway_error(v: &Value) -> Option<String> {
    let err = v.get("error")?;
    if err.is_null() {
        return None;
    }
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("unknown");
    Some(format!("SDK 返回错误：{msg}"))
}

/// 解析 + 2 秒 TCP 预检。解析到错误地址（常见于 /etc/hosts 写坏）时给出明确提示，
/// 避免 SDK 内部干等 30 秒。
fn preflight_gateway(host: &str, port: u16) -> Result<(), SdkError> {
    use std::net::{IpAddr, ToSocketAddrs};
    if let Ok(ip) = host.parse::<IpAddr>() {
        return probe(ip, port, host);
    }
    let addrs: Vec<std::net::SocketAddr> = (host, port).to_socket_addrs()
        .map_err(|_| {
            SdkError::Gateway(format!(
                "网关 {host} 解析失败（Clash 的 DNS 解析不到该域名）：可在 /etc/hosts 加 `210.21.123.7 {host}`，或在 Clash 里给 {host} 配 nameserver-policy"
            ))
        })?
        .collect();
    if addrs.is_empty() {
        return Err(SdkError::Gateway(format!("网关 {host} 解析不到地址")));
    }
    let mut last = String::new();
    for addr in &addrs {
        match probe(addr.ip(), port, host) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(SdkError::Gateway(last))
}

fn probe(ip: std::net::IpAddr, port: u16, host: &str) -> Result<(), SdkError> {
    let addr = std::net::SocketAddr::new(ip, port);
    if TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok() {
        return Ok(());
    }
    let hint = if ip.is_loopback() || is_private(ip) {
        "（解析到内网地址，多半是 /etc/hosts 里有粘连/错误的条目）"
    } else {
        ""
    };
    Err(SdkError::Gateway(format!(
        "网关 {host} 解析到 {ip}:{port} 但连接不通（2 秒超时）{hint}"
    )))
}

fn is_private(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_private(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// 网关支持哪些认证方式（`get_config`，无需登录）。
pub fn auth_types(gateway_host: &str, gateway_port: u16) -> Result<Vec<String>, SdkError> {
    let port = ensure_sdk()?;
    let v = rpc_timeout(
        port,
        "get_config",
        serde_json::json!({ "host": gateway_host, "port": gateway_port.to_string() }),
        SLOW_TIMEOUT,
    )?;
    if let Some(err) = gateway_error(&v) {
        return Err(SdkError::Gateway(err));
    }
    let list = v
        .get("result")
        .and_then(|r| r.get("authlist"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(list
        .iter()
        .map(|item| {
            format!(
                "{} ({})",
                item.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                item.get("type").and_then(|t| t.as_str()).unwrap_or("")
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn mock_server(reply: Value) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for _ in 0..8 {
                let (mut s, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let body = serde_json::to_vec(&reply).unwrap();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    String::from_utf8_lossy(&body)
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        port
    }

    #[test]
    fn status_online() {
        let port = mock_server(serde_json::json!({
            "jsonrpc":"2.0","method":"status","result":{"code":0,"message":"online"}
        }));
        let v = rpc(port, "status", serde_json::json!({"type":"user_info"})).unwrap();
        assert_eq!(v["result"]["message"], "online");
    }

    #[test]
    fn login_error_is_reported() {
        let port = mock_server(serde_json::json!({
            "jsonrpc":"2.0","method":"login","error":{"code":-1,"message":"token invalid"}
        }));
        let v = rpc(port, "login", serde_json::json!({"host":"h","port":"443","user_token":"t"})).unwrap();
        assert_eq!(gateway_error(&v).as_deref(), Some("SDK 返回错误：token invalid"));
    }

    #[test]
    #[ignore]
    fn live_login_dummy() {
        match login(DEFAULT_HOST, DEFAULT_PORT, "dummy-token") {
            Ok(m) => println!("login ok: {m}"),
            Err(e) => println!("login err: {e}"),
        }
    }

    #[test]
    #[ignore]
    fn live_ensure() {
        let port = ensure_sdk().expect("SDK 无法拉起");
        println!("ensure_sdk ok: port={port}");
    }

    /// 按需启动的完整循环：注销 → 进程应退出 → 再次登录应能拉起。
    #[test]
    #[ignore]
    fn live_on_demand() {
        agent_stop();
        thread::sleep(Duration::from_millis(1500));
        println!("left after stop: {:?}", agent_leftovers());
        let port = ensure_sdk().expect("SDK 无法拉起");
        println!("ensure_sdk ok: port={port}");
        println!("left after start: {:?}", agent_leftovers());
    }

    #[test]
    fn auth_types_parsed() {
        let port = mock_server(serde_json::json!({
            "jsonrpc":"2.0","method":"get_config","result":{"authlist":[
                {"name":"越秀集团token认证","type":"YX_TOKEN"},
                {"name":"默认本地认证","type":"LOCAL_UP"}
            ]}
        }));
        let v = rpc(port, "get_config", serde_json::json!({"host":"h","port":"443"})).unwrap();
        let list = v["result"]["authlist"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["type"], "YX_TOKEN");
    }

    /// 需要本机正在运行官方零信任客户端（`cargo test --lib -- --ignored live_sdk`）。
    #[test]
    #[ignore]
    fn live_sdk() {
        let st = status().expect("SDK 未运行");
        println!("live status: port={} state={}", st.port, st.state);
        match auth_types(DEFAULT_HOST, DEFAULT_PORT) {
            Ok(types) => println!("live auth types: {types:?}"),
            // 离线时 get_config 会失败，这是正常的
            Err(e) => println!("live auth types unavailable: {e}"),
        }
    }
}
