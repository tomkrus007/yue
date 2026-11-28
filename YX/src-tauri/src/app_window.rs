//! 桌面应用的「客户端内打开」。
//!
//! 原版在客户端内打开应用前，会先用当前 AccessToken 调 SSO 的
//! `oauth2/authorize?response_type=create_session`，拿到各应用的会话 Cookie
//! （实测是 `www.bingolink.biz` 的 `auth_token_saaslink_sso_cookie` 与
//! `linksso.yuexiu.com` 的 `auth_token_yuexiu.linksso_cookie` 两条 HttpOnly Cookie），
//! 由原生层写进 WebView 的 Cookie 仓库，再加载应用地址。
//!
//! 只导航 `oauth2/authorize?...&login_token=` 是不够的：应用自己会去
//! `oauth2.serverUrl`（例如 `https://linksso.yuexiu.com`）校验会话，没有 Cookie
//! 就跳登录页。Tauri 的 WebView 没有 JS 写 Cookie 的能力，所以窗口创建、Cookie
//! 写入、导航都放在 Rust 侧完成；前端只负责取 token 并转交。

use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// SSO `create_session` 返回的一条 Cookie（字段名与接口一致）。
#[derive(serde::Deserialize)]
pub struct SessionCookie {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub path: String,
}

/// 窗口标签只允许 Tauri 认可的字符，避免传入奇怪的名字。
fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 64
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_'))
}

/// 打开（或聚焦）应用窗口，先把会话 Cookie 写进 WebView 再加载页面。
#[tauri::command]
pub async fn app_open_window(
    app: AppHandle,
    label: String,
    title: String,
    url: String,
    width: f64,
    height: f64,
    cookies: Vec<SessionCookie>,
) -> Result<(), String> {
    if !valid_label(&label) {
        return Err(format!("应用窗口标识不合法：{label}"));
    }
    // 同一应用重复点击只聚焦，不重复开窗
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let target = Url::parse(&url).map_err(|e| format!("应用地址不合法：{e}"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("只支持打开 http(s) 应用地址".into());
    }

    // 先挂一个空白页：应用页面必须在 Cookie 写好之后才开始加载，
    // 否则应用会先判定未登录并跳到登录页。
    let blank = Url::parse("about:blank").map_err(|e| e.to_string())?;
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(blank))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(720.0, 520.0)
        .center()
        .build()
        .map_err(|e| format!("创建应用窗口失败：{e}"))?;

    for item in cookies {
        if item.name.is_empty() || item.domain.is_empty() {
            continue;
        }
        // 会话 Cookie 都是 HttpOnly；企业应用地址都是 https，secure 固定打开。
        let cookie = Cookie::build((item.name, item.value))
            .domain(item.domain)
            .path(if item.path.is_empty() {
                "/".to_string()
            } else {
                item.path
            })
            .secure(true)
            .http_only(true)
            .build();
        // 单条写失败不影响开窗：应用最多退回自己的登录页，不至于完全打不开
        if let Err(error) = window.as_ref().set_cookie(cookie) {
            eprintln!("[app] 写入应用 Cookie 失败：{error}");
        }
    }

    window
        .as_ref()
        .navigate(target)
        .map_err(|e| format!("打开应用失败：{e}"))
}
