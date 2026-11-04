//! 白名单式零信任代理（对齐 yx-cloud-kb 的 kit/src/zt）。
//!
//! 单端口同时支持：
//! - HTTP CONNECT（HTTPS 隧道）
//! - 普通 HTTP 代理（绝对 URI）
//! - SOCKS5（无认证）
//!
//! 路由决策是白名单式：只有显式命中规则的连接才走上游隧道，
//! 其余按 defaultAction（direct / proxy / block）处理。

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_LOGS: usize = 500;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const RELAY_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/* ============================ 配置 ============================ */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ListenConfig {
    pub host: String,
    pub port: u16,
}

impl Default for ListenConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 8899,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct UpstreamConfig {
    /// direct | http | socks5
    pub r#type: String,
    pub host: String,
    pub port: u16,
}

impl Default for UpstreamConfig {
    fn default() -> Self {
        Self {
            r#type: "http".into(),
            host: "127.0.0.1".into(),
            port: 1080,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuleMatch {
    pub host_exact: Vec<String>,
    pub host_suffix: Vec<String>,
    pub host_regex: Vec<String>,
    pub cidr: Vec<String>,
    /// number | string | array；编译时统一成端口区间
    pub port: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuleConfig {
    pub id: String,
    /// direct | proxy | block
    pub action: String,
    pub note: String,
    #[serde(rename = "match")]
    pub matcher: RuleMatch,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ZtConfig {
    pub enabled: bool,
    pub listen: ListenConfig,
    pub default_action: String,
    /// 总开关关闭时的动作：direct | block
    pub fallback: String,
    pub upstream: UpstreamConfig,
    pub rules: Vec<RuleConfig>,
}

impl Default for ZtConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            listen: ListenConfig::default(),
            default_action: "direct".into(),
            fallback: "direct".into(),
            upstream: UpstreamConfig::default(),
            rules: Vec::new(),
        }
    }
}

fn normalize_config(mut cfg: ZtConfig) -> ZtConfig {
    if !["direct", "proxy", "block"].contains(&cfg.default_action.as_str()) {
        cfg.default_action = "direct".into();
    }
    if !["direct", "block"].contains(&cfg.fallback.as_str()) {
        cfg.fallback = "direct".into();
    }
    if !["direct", "http", "socks5"].contains(&cfg.upstream.r#type.as_str()) {
        cfg.upstream.r#type = "direct".into();
    }
    for (i, rule) in cfg.rules.iter_mut().enumerate() {
        if rule.id.is_empty() {
            rule.id = format!("rule-{}", i);
        }
        if !["direct", "proxy", "block"].contains(&rule.action.as_str()) {
            rule.action = "proxy".into();
        }
    }
    cfg
}

/* ============================ 规则编译 ============================ */

struct Cidr {
    net: u32,
    mask: u32,
}

struct CompiledRule {
    id: String,
    action: String,
    host_exact: Vec<String>,
    host_suffix: Vec<String>,
    host_regex: Vec<Regex>,
    cidr: Vec<Cidr>,
    ports: Option<Vec<(u16, u16)>>,
}

struct Compiled {
    cfg: ZtConfig,
    rules: Vec<CompiledRule>,
    has_cidr: bool,
}

fn parse_cidr(text: &str) -> Option<Cidr> {
    let (ip, bits_raw) = match text.split_once('/') {
        Some((a, b)) => (a, Some(b)),
        None => (text, None),
    };
    let bits: u32 = match bits_raw {
        Some(b) => b.parse().ok()?,
        None => 32,
    };
    if bits > 32 {
        return None;
    }
    let value = ipv4_to_u32(ip)?;
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits)
    };
    Some(Cidr {
        net: value & mask,
        mask,
    })
}

fn ipv4_to_u32(ip: &str) -> Option<u32> {
    let addr = std::net::Ipv4Addr::from_str(ip).ok()?;
    Some(u32::from(addr))
}

fn parse_ports(value: &Value) -> Option<Vec<(u16, u16)>> {
    let items: Vec<&Value> = match value {
        Value::Array(list) => list.iter().collect(),
        other => vec![other],
    };
    let mut out = Vec::new();
    for item in items {
        match item {
            Value::Number(n) => {
                if let Some(p) = n.as_u64() {
                    if p <= 65535 {
                        out.push((p as u16, p as u16));
                    }
                }
            }
            Value::String(s) => {
                if let Some((a, b)) = s.split_once('-') {
                    if let (Ok(a), Ok(b)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                        out.push((a, b));
                    }
                } else if let Ok(p) = s.trim().parse::<u16>() {
                    out.push((p, p));
                }
            }
            _ => {}
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn compile(cfg: ZtConfig) -> Compiled {
    let mut rules = Vec::new();
    let mut has_cidr = false;
    for rule in &cfg.rules {
        let mut host_regex = Vec::new();
        for pattern in &rule.matcher.host_regex {
            if let Ok(re) = Regex::new(&format!("(?i){}", pattern)) {
                host_regex.push(re);
            }
        }
        let cidr: Vec<Cidr> = rule
            .matcher
            .cidr
            .iter()
            .filter_map(|c| parse_cidr(c))
            .collect();
        if !cidr.is_empty() {
            has_cidr = true;
        }
        rules.push(CompiledRule {
            id: rule.id.clone(),
            action: rule.action.clone(),
            host_exact: rule
                .matcher
                .host_exact
                .iter()
                .map(|h| h.to_lowercase())
                .collect(),
            host_suffix: rule
                .matcher
                .host_suffix
                .iter()
                .map(|h| h.to_lowercase())
                .collect(),
            host_regex,
            cidr,
            ports: rule.matcher.port.as_ref().and_then(parse_ports),
        });
    }
    Compiled {
        cfg,
        rules,
        has_cidr,
    }
}

enum Verdict {
    Allow {
        action: String,
        rule: Option<String>,
        reason: String,
    },
    Block {
        rule: Option<String>,
        reason: String,
    },
}

fn decide(compiled: &Compiled, host: &str, port: u16, ip: Option<IpAddr>) -> Verdict {
    let cfg = &compiled.cfg;
    if !cfg.enabled {
        if cfg.fallback == "block" {
            return Verdict::Block {
                rule: None,
                reason: "总开关关闭，按 fallback 阻断".into(),
            };
        }
        return Verdict::Allow {
            action: "direct".into(),
            rule: None,
            reason: "总开关关闭，按 fallback 直连".into(),
        };
    }

    let lower = host.to_lowercase();
    let ip_u32 = match ip {
        Some(IpAddr::V4(v4)) => Some(u32::from(v4)),
        Some(IpAddr::V6(_)) => None,
        None => None,
    };

    for rule in &compiled.rules {
        if let Some(ranges) = &rule.ports {
            if !ranges.iter().any(|(a, b)| port >= *a && port <= *b) {
                continue;
            }
        }
        let mut hit = false;
        if rule.host_exact.iter().any(|h| h == &lower) {
            hit = true;
        }
        if !hit
            && rule
                .host_suffix
                .iter()
                .any(|s| lower == *s || lower.ends_with(&format!(".{}", s)))
        {
            hit = true;
        }
        if !hit && rule.host_regex.iter().any(|re| re.is_match(&lower)) {
            hit = true;
        }
        let mut by_ip = false;
        if !hit {
            if let (Some(value), false) = (ip_u32, rule.cidr.is_empty()) {
                if rule.cidr.iter().any(|c| value & c.mask == c.net) {
                    hit = true;
                    by_ip = true;
                }
            }
        }
        if hit {
            let reason = if by_ip { "ip 命中" } else { "host 命中" };
            return if rule.action == "block" {
                Verdict::Block {
                    rule: Some(rule.id.clone()),
                    reason: reason.into(),
                }
            } else {
                Verdict::Allow {
                    action: rule.action.clone(),
                    rule: Some(rule.id.clone()),
                    reason: reason.into(),
                }
            };
        }
    }

    if cfg.default_action == "block" {
        Verdict::Block {
            rule: None,
            reason: "未命中任何规则".into(),
        }
    } else {
        Verdict::Allow {
            action: cfg.default_action.clone(),
            rule: None,
            reason: "未命中任何规则".into(),
        }
    }
}

fn resolve_ip(host: &str) -> Option<IpAddr> {
    if let Ok(ip) = IpAddr::from_str(host) {
        return Some(ip);
    }
    (host, 0).to_socket_addrs().ok()?.next().map(|a| a.ip())
}

/* ============================ 共享状态 ============================ */

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ZtStats {
    pub total: u64,
    pub direct: u64,
    pub proxy: u64,
    pub block: u64,
    pub failed: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ZtLogEntry {
    pub seq: u64,
    pub ts: u64,
    pub proto: String,
    pub host: String,
    pub port: u16,
    pub rule: Option<String>,
    pub action: String,
    pub reason: String,
    pub up: u64,
    pub down: u64,
    pub ok: bool,
    pub err: Option<String>,
    pub ms: Option<u64>,
}

struct Shared {
    running: AtomicBool,
    logs: Mutex<VecDeque<ZtLogEntry>>,
    stats: Mutex<ZtStats>,
    seq: Mutex<u64>,
}

impl Shared {
    fn new() -> Self {
        Self {
            running: AtomicBool::new(true),
            logs: Mutex::new(VecDeque::new()),
            stats: Mutex::new(ZtStats::default()),
            seq: Mutex::new(0),
        }
    }

    fn log_start(
        &self,
        proto: &str,
        host: &str,
        port: u16,
        verdict: &Verdict,
    ) -> u64 {
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        let seq_value = *seq;
        let (rule, action, reason) = match verdict {
            Verdict::Allow {
                action,
                rule,
                reason,
            } => (rule.clone(), action.clone(), reason.clone()),
            Verdict::Block { rule, reason } => {
                (rule.clone(), "block".to_string(), reason.clone())
            }
        };
        let entry = ZtLogEntry {
            seq: seq_value,
            ts: now_ms(),
            proto: proto.into(),
            host: host.into(),
            port,
            rule,
            action,
            reason,
            up: 0,
            down: 0,
            ok: false,
            err: None,
            ms: None,
        };
        let mut logs = self.logs.lock().unwrap();
        logs.push_back(entry);
        while logs.len() > MAX_LOGS {
            logs.pop_front();
        }
        seq_value
    }

    fn log_finish(&self, seq: u64, up: u64, down: u64, ok: bool, err: Option<String>) {
        let mut logs = self.logs.lock().unwrap();
        if let Some(entry) = logs.iter_mut().find(|e| e.seq == seq) {
            entry.up = up;
            entry.down = down;
            entry.ok = ok;
            entry.err = err;
            entry.ms = Some(now_ms().saturating_sub(entry.ts));
        }
    }

    fn bump(&self, action: &str) {
        let mut stats = self.stats.lock().unwrap();
        stats.total += 1;
        match action {
            "direct" => stats.direct += 1,
            "proxy" => stats.proxy += 1,
            "block" => stats.block += 1,
            _ => {}
        }
    }

    fn bump_failed(&self) {
        let mut stats = self.stats.lock().unwrap();
        stats.failed += 1;
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ============================ 代理运行时 ============================ */

struct ZtRuntime {
    shared: Arc<Shared>,
    handle: thread::JoinHandle<()>,
    host: String,
    port: u16,
    started_at: u64,
    config: ZtConfig,
}

#[derive(Default)]
pub struct ZtManager {
    inner: Mutex<Option<ZtRuntime>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZtStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub started_at: u64,
    pub stats: ZtStats,
    pub logs: Vec<ZtLogEntry>,
    pub config: Option<ZtConfig>,
}

impl ZtManager {
    fn status(&self) -> ZtStatus {
        let guard = self.inner.lock().unwrap();
        match guard.as_ref() {
            Some(rt) => ZtStatus {
                running: rt.shared.running.load(Ordering::Relaxed),
                host: rt.host.clone(),
                port: rt.port,
                started_at: rt.started_at,
                stats: rt.shared.stats.lock().unwrap().clone(),
                logs: rt.shared.logs.lock().unwrap().iter().cloned().collect(),
                config: Some(rt.config.clone()),
            },
            None => ZtStatus {
                running: false,
                host: String::new(),
                port: 0,
                started_at: 0,
                stats: ZtStats::default(),
                logs: Vec::new(),
                config: None,
            },
        }
    }

    fn stop(&self) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(rt) = guard.take() {
            rt.shared.running.store(false, Ordering::Relaxed);
            let _ = rt.handle.join();
        }
    }
}

#[tauri::command]
pub fn zt_start(config: Value, manager: tauri::State<'_, ZtManager>) -> Result<ZtStatus, String> {
    let cfg: ZtConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let cfg = normalize_config(cfg);
    manager.stop();
    let compiled = Arc::new(compile(cfg.clone()));
    let shared = Arc::new(Shared::new());

    let wanted = cfg.listen.port;
    let candidates: Vec<u16> = if wanted == 0 {
        vec![0]
    } else {
        let mut list = vec![wanted];
        for i in 1..10u16 {
            list.push(wanted.saturating_add(i));
        }
        list.push(0);
        list
    };

    let mut listener: Option<(TcpListener, u16)> = None;
    let mut last_err = String::from("代理端口全部不可用");
    for port in candidates {
        match TcpListener::bind((cfg.listen.host.as_str(), port)) {
            Ok(l) => {
                let actual = l.local_addr().map(|a| a.port()).unwrap_or(port);
                listener = Some((l, actual));
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    let (listener, actual_port) = listener.ok_or(last_err)?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let shared_for_thread = Arc::clone(&shared);
    let compiled_for_thread = Arc::clone(&compiled);
    let handle = thread::spawn(move || accept_loop(listener, shared_for_thread, compiled_for_thread));

    let started_at = now_ms();
    {
        let mut guard = manager.inner.lock().unwrap();
        *guard = Some(ZtRuntime {
            shared,
            handle,
            host: cfg.listen.host.clone(),
            port: actual_port,
            started_at,
            config: cfg,
        });
    }
    Ok(manager.status())
}

#[tauri::command]
pub fn zt_stop(manager: tauri::State<'_, ZtManager>) -> Result<(), String> {
    manager.stop();
    Ok(())
}

#[tauri::command]
pub fn zt_status(manager: tauri::State<'_, ZtManager>) -> Result<ZtStatus, String> {
    Ok(manager.status())
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>, compiled: Arc<Compiled>) {
    while shared.running.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                stream.set_nonblocking(false).ok();
                stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).ok();
                let shared = Arc::clone(&shared);
                let compiled = Arc::clone(&compiled);
                thread::spawn(move || handle_connection(stream, shared, compiled));
            }
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
}

fn handle_connection(stream: TcpStream, shared: Arc<Shared>, compiled: Arc<Compiled>) {
    let mut first = [0u8; 1];
    match stream.peek(&mut first) {
        Ok(0) => return,
        Ok(_) => {}
        Err(_) => return,
    }
    if first[0] == 0x05 {
        handle_socks5(stream, shared, compiled);
    } else {
        handle_http(stream, shared, compiled);
    }
}

/* ============================ HTTP 代理 ============================ */

fn handle_http(mut client: TcpStream, shared: Arc<Shared>, compiled: Arc<Compiled>) {
    let (head, rest) = match read_headers(&mut client) {
        Ok(v) => v,
        Err(_) => return,
    };
    if head.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(&head).to_string();
    let mut lines = text.split("\r\n").filter(|l| !l.is_empty());
    let request_line = match lines.next() {
        Some(l) => l.to_string(),
        None => return,
    };
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
        return;
    }
    let method = parts[0].to_string();
    let target = parts[1].to_string();
    let header_lines: Vec<String> = lines.map(|s| s.to_string()).collect();
    let host_header = header_lines
        .iter()
        .find_map(|l| {
            let (name, value) = l.split_once(':')?;
            if name.eq_ignore_ascii_case("host") {
                Some(value.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default();

    let (host, port, path) = if method.eq_ignore_ascii_case("CONNECT") {
        let (h, p) = split_host_port(&target, 443);
        (h, p, String::new())
    } else if target.starts_with("http://") {
        match parse_absolute_url(&target) {
            Some(v) => v,
            None => {
                let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
                return;
            }
        }
    } else {
        let (h, p) = split_host_port(&host_header, 80);
        (h, p, target.clone())
    };

    if host.is_empty() {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
        return;
    }

    let ip = if compiled.has_cidr {
        resolve_ip(&host)
    } else {
        None
    };
    let verdict = decide(&compiled, &host, port, ip);
    let proto = if method.eq_ignore_ascii_case("CONNECT") {
        "CONNECT".to_string()
    } else {
        method.clone()
    };
    let seq = shared.log_start(&proto, &host, port, &verdict);

    let action = match &verdict {
        Verdict::Block { .. } => {
            shared.bump("block");
            shared.log_finish(seq, 0, 0, false, Some("已阻断".into()));
            let _ = client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        Verdict::Allow { action, .. } => action.clone(),
    };

    if method.eq_ignore_ascii_case("CONNECT") {
        match open_via(&compiled.cfg.upstream, &host, port) {
            Ok(mut remote) => {
                shared.bump(&action);
                if !rest.is_empty() {
                    let _ = remote.write_all(&rest);
                }
                if client
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .is_err()
                {
                    shared.bump_failed();
                    shared.log_finish(seq, 0, 0, false, Some("写响应失败".into()));
                    return;
                }
                client.set_read_timeout(None).ok();
                let (up, down, err) = relay(client, remote);
                shared.log_finish(seq, up, down, err.is_none(), err);
            }
            Err(e) => {
                shared.bump_failed();
                shared.log_finish(seq, 0, 0, false, Some(e.clone()));
                let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
            }
        }
        return;
    }

    // 普通 HTTP：重写成 origin-form 再转发
    match open_via(&compiled.cfg.upstream, &host, port) {
        Ok(mut remote) => {
            shared.bump(&action);
            let mut out = String::new();
            out.push_str(&format!("{} {} HTTP/1.1\r\n", method, path));
            for line in &header_lines {
                let lower = line.to_lowercase();
                if lower.starts_with("proxy-connection:")
                    || lower.starts_with("proxy-authorization:")
                {
                    continue;
                }
                out.push_str(line);
                out.push_str("\r\n");
            }
            out.push_str("\r\n");
            if remote.write_all(out.as_bytes()).is_err() || (!rest.is_empty() && remote.write_all(&rest).is_err()) {
                shared.bump_failed();
                shared.log_finish(seq, 0, 0, false, Some("写请求失败".into()));
                return;
            }
            client.set_read_timeout(None).ok();
            let (up, down, err) = relay(client, remote);
            shared.log_finish(seq, up, down, err.is_none(), err);
        }
        Err(e) => {
            shared.bump_failed();
            shared.log_finish(seq, 0, 0, false, Some(e.clone()));
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        }
    }
}

fn parse_absolute_url(target: &str) -> Option<(String, u16, String)> {
    let rest = target.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], rest[idx..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = split_host_port(authority, 80);
    if host.is_empty() {
        return None;
    }
    Some((host, port, path))
}

fn split_host_port(value: &str, default_port: u16) -> (String, u16) {
    let value = value.trim();
    if value.is_empty() {
        return (String::new(), default_port);
    }
    if let Some(stripped) = value.strip_prefix('[') {
        if let Some((host, tail)) = stripped.split_once(']') {
            let port = tail
                .strip_prefix(':')
                .and_then(|p| p.parse().ok())
                .unwrap_or(default_port);
            return (host.to_string(), port);
        }
    }
    match value.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), port.parse().unwrap_or(default_port))
        }
        _ => (value.to_string(), default_port),
    }
}

fn read_headers(stream: &mut TcpStream) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Ok((buf, Vec::new()));
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            let head = buf[..pos + 4].to_vec();
            let rest = buf[pos + 4..].to_vec();
            return Ok((head, rest));
        }
        if buf.len() > 128 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "请求头过大"));
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/* ============================ 上游连接 ============================ */

fn open_via(upstream: &UpstreamConfig, host: &str, port: u16) -> Result<TcpStream, String> {
    match upstream.r#type.as_str() {
        "direct" | "none" => connect_direct(host, port),
        "http" => connect_http_proxy(upstream, host, port),
        "socks5" => connect_socks5(upstream, host, port),
        other => Err(format!("未知的 upstream.type：{}", other)),
    }
}

fn connect_direct(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .collect();
    let mut last = String::from("解析不到地址");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, HANDSHAKE_TIMEOUT) {
            Ok(s) => {
                s.set_nodelay(true).ok();
                s.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).ok();
                return Ok(s);
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

fn connect_http_proxy(
    upstream: &UpstreamConfig,
    host: &str,
    port: u16,
) -> Result<TcpStream, String> {
    let mut stream = connect_direct(&upstream.host, upstream.port)?;
    let req = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Connection: keep-alive\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    let (head, _rest) = read_headers(&mut stream).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&head);
    let status = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    if status != 200 {
        let _ = stream.shutdown(Shutdown::Both);
        return Err(format!("上游代理 CONNECT 返回 {}", status));
    }
    Ok(stream)
}

fn connect_socks5(
    upstream: &UpstreamConfig,
    host: &str,
    port: u16,
) -> Result<TcpStream, String> {
    let mut stream = connect_direct(&upstream.host, upstream.port)?;
    stream
        .write_all(&[0x05, 0x01, 0x00])
        .map_err(|e| e.to_string())?;
    let mut resp = [0u8; 2];
    stream.read_exact(&mut resp).map_err(|e| e.to_string())?;
    if resp[0] != 0x05 {
        return Err("上游不是 SOCKS5".into());
    }
    if resp[1] != 0x00 {
        return Err("SOCKS5 上游要求认证（暂不支持）".into());
    }
    let host_bytes = host.as_bytes();
    if host_bytes.len() > 255 {
        return Err("主机名过长".into());
    }
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host_bytes.len() as u8];
    req.extend_from_slice(host_bytes);
    req.push((port >> 8) as u8);
    req.push((port & 0xff) as u8);
    stream.write_all(&req).map_err(|e| e.to_string())?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).map_err(|e| e.to_string())?;
    if head[0] != 0x05 {
        return Err("SOCKS5 响应格式错误".into());
    }
    if head[1] != 0x00 {
        return Err(format!("SOCKS5 上游返回错误码 {}", head[1]));
    }
    match head[3] {
        0x01 => {
            let mut skip = [0u8; 6];
            stream.read_exact(&mut skip).map_err(|e| e.to_string())?;
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).map_err(|e| e.to_string())?;
            let mut skip = vec![0u8; len[0] as usize + 2];
            stream.read_exact(&mut skip).map_err(|e| e.to_string())?;
        }
        0x04 => {
            let mut skip = [0u8; 18];
            stream.read_exact(&mut skip).map_err(|e| e.to_string())?;
        }
        _ => return Err("SOCKS5 未知地址类型".into()),
    }
    Ok(stream)
}

/* ============================ 双向转发 ============================ */

fn relay(client: TcpStream, remote: TcpStream) -> (u64, u64, Option<String>) {
    client.set_read_timeout(Some(RELAY_IDLE_TIMEOUT)).ok();
    remote.set_read_timeout(Some(RELAY_IDLE_TIMEOUT)).ok();
    let mut client_r = match client.try_clone() {
        Ok(s) => s,
        Err(e) => return (0, 0, Some(e.to_string())),
    };
    let mut client_w = client;
    let mut remote_r = match remote.try_clone() {
        Ok(s) => s,
        Err(e) => return (0, 0, Some(e.to_string())),
    };
    let mut remote_w = remote;

    let up_handle = thread::spawn(move || {
        let n = io::copy(&mut client_r, &mut remote_w).unwrap_or(0);
        let _ = remote_w.shutdown(Shutdown::Write);
        n
    });
    let down = io::copy(&mut remote_r, &mut client_w).unwrap_or(0);
    let _ = client_w.shutdown(Shutdown::Write);
    let up = up_handle.join().unwrap_or(0);
    (up, down, None)
}

/* ============================ SOCKS5 服务端 ============================ */

fn handle_socks5(mut client: TcpStream, shared: Arc<Shared>, compiled: Arc<Compiled>) {
    let mut greeting = [0u8; 2];
    if client.read_exact(&mut greeting).is_err() {
        return;
    }
    if greeting[0] != 0x05 {
        return;
    }
    let n = greeting[1] as usize;
    let mut methods = vec![0u8; n];
    if client.read_exact(&mut methods).is_err() {
        return;
    }
    if client.write_all(&[0x05, 0x00]).is_err() {
        return;
    }

    let mut head = [0u8; 4];
    if client.read_exact(&mut head).is_err() {
        return;
    }
    if head[0] != 0x05 {
        return;
    }
    let (host, port) = match head[3] {
        0x01 => {
            let mut addr = [0u8; 4];
            if client.read_exact(&mut addr).is_err() {
                return;
            }
            let mut p = [0u8; 2];
            if client.read_exact(&mut p).is_err() {
                return;
            }
            (
                format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3]),
                u16::from_be_bytes(p),
            )
        }
        0x03 => {
            let mut len = [0u8; 1];
            if client.read_exact(&mut len).is_err() {
                return;
            }
            let mut name = vec![0u8; len[0] as usize];
            if client.read_exact(&mut name).is_err() {
                return;
            }
            let mut p = [0u8; 2];
            if client.read_exact(&mut p).is_err() {
                return;
            }
            (
                String::from_utf8_lossy(&name).to_string(),
                u16::from_be_bytes(p),
            )
        }
        0x04 => {
            let mut addr = [0u8; 16];
            if client.read_exact(&mut addr).is_err() {
                return;
            }
            let mut p = [0u8; 2];
            if client.read_exact(&mut p).is_err() {
                return;
            }
            let ip = std::net::Ipv6Addr::from(addr);
            (ip.to_string(), u16::from_be_bytes(p))
        }
        _ => {
            let _ = client.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            return;
        }
    };

    let ip = if compiled.has_cidr {
        resolve_ip(&host)
    } else {
        None
    };
    let verdict = decide(&compiled, &host, port, ip);
    let seq = shared.log_start("SOCKS5", &host, port, &verdict);

    let action = match &verdict {
        Verdict::Block { .. } => {
            shared.bump("block");
            shared.log_finish(seq, 0, 0, false, Some("已阻断".into()));
            let _ = client.write_all(&[0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            return;
        }
        Verdict::Allow { action, .. } => action.clone(),
    };

    match open_via(&compiled.cfg.upstream, &host, port) {
        Ok(remote) => {
            shared.bump(&action);
            if client
                .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .is_err()
            {
                shared.bump_failed();
                shared.log_finish(seq, 0, 0, false, Some("写响应失败".into()));
                return;
            }
            let (up, down, err) = relay(client, remote);
            shared.log_finish(seq, up, down, err.is_none(), err);
        }
        Err(e) => {
            shared.bump_failed();
            shared.log_finish(seq, 0, 0, false, Some(e));
            let _ = client.write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
        }
    }
}