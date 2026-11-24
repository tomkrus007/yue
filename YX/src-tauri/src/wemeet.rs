//! 腾讯会议原生桥（P0 验证）。
//!
//! 前端通过 `invoke` 调用这些命令；所有原生调用都投递到主线程（TMSDK 的 Qt/AppKit
//! 窗口需要主 run loop）。SDK 的回调用 C 函数指针回到 Rust，再 emit 为
//! `wemeet-event`。
//!
//! P0 只覆盖：初始化 / 登录 / 会前主页 / 入会 / 快速会议 / 置顶 / 登出 / 释放。
//! 邀请、响铃、会中邀请等放到 P2。

use std::ffi::{c_char, CStr, CString};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

type EventCb = extern "C" fn(*const c_char);

unsafe extern "C" {
    fn yx_wemeet_set_event_callback(cb: Option<EventCb>);
    fn yx_wemeet_init(
        sdk_id: *const c_char,
        sdk_token: *const c_char,
        data_path: *const c_char,
        app_name: *const c_char,
        server_host: *const c_char,
    ) -> i32;
    fn yx_wemeet_is_initialized() -> i32;
    fn yx_wemeet_refresh_token(sdk_token: *const c_char) -> i32;
    fn yx_wemeet_login(sso_url: *const c_char) -> i32;
    fn yx_wemeet_join(
        meeting_code: *const c_char,
        display_name: *const c_char,
        password: *const c_char,
        mic_on: bool,
        camera_on: bool,
        face_beauty_on: bool,
    ) -> i32;
    fn yx_wemeet_quick(window_title: *const c_char) -> i32;
    fn yx_wemeet_show_home() -> i32;
    fn yx_wemeet_bring_top() -> i32;
    fn yx_wemeet_logout() -> i32;
    fn yx_wemeet_release();
}

static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C" fn on_wemeet_event(json: *const c_char) {
    if json.is_null() {
        return;
    }
    let Ok(text) = (unsafe { CStr::from_ptr(json) }).to_str() else {
        return;
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("wemeet-event", text.to_string());
    }
}

fn ensure_app(app: &AppHandle) {
    if APP.get().is_none() {
        let _ = APP.set(app.clone());
    }
}

fn cstring(value: &str) -> CString {
    CString::new(value).unwrap_or_else(|_| CString::new("").unwrap())
}

fn on_main<F>(app: &AppHandle, f: F) -> Result<(), String>
where
    F: FnOnce() + Send + 'static,
{
    app.run_on_main_thread(f).map_err(|e| e.to_string())
}

/// 初始化并（由调用方随后）登录。`data_path` 为空时落到 app cache。
#[tauri::command]
pub async fn wemeet_init(
    app: AppHandle,
    sdk_id: String,
    sdk_token: String,
    data_path: Option<String>,
    app_name: Option<String>,
    server_host: Option<String>,
) -> Result<(), String> {
    ensure_app(&app);
    unsafe { yx_wemeet_set_event_callback(Some(on_wemeet_event)) };

    // TMSDK 依赖 CFBundleIdentifier 与 .app 内的资源目录：裸二进制（tauri dev 的
    // target/debug/YX）调用 Initialize 会直接 SIGSEGV。这里提前挡住并给出可读提示。
    let exe = std::env::current_exe().unwrap_or_default();
    if !exe.to_string_lossy().contains(".app/Contents/MacOS/") {
        return Err(
            "TMSDK 只能在 .app 包内初始化（需要 CFBundleIdentifier）。\
             请改用 `pnpm tauri build --debug` 生成并运行 YX.app，不要用 `pnpm tauri dev`。"
                .into(),
        );
    }

    let dir = data_path
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            app.path()
                .app_cache_dir()
                .ok()
                .map(|p| p.join("wemeet_cache").to_string_lossy().to_string())
        })
        .unwrap_or_default();

    let sdk_id = cstring(&sdk_id);
    let sdk_token = cstring(&sdk_token);
    let dir = cstring(&dir);
    let name = cstring(app_name.as_deref().unwrap_or("网络会议"));
    let host = cstring(server_host.as_deref().unwrap_or(""));

    on_main(&app, move || {
        unsafe {
            yx_wemeet_init(
                sdk_id.as_ptr(),
                sdk_token.as_ptr(),
                dir.as_ptr(),
                name.as_ptr(),
                host.as_ptr(),
            );
        }
    })
}

#[tauri::command]
pub async fn wemeet_status(app: AppHandle) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    on_main(&app, move || {
        let initialized = unsafe { yx_wemeet_is_initialized() } == 1;
        let _ = tx.send(initialized);
    })?;
    Ok(rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false))
}

#[tauri::command]
pub async fn wemeet_refresh_token(app: AppHandle, sdk_token: String) -> Result<(), String> {
    let token = cstring(&sdk_token);
    on_main(&app, move || {
        unsafe {
            yx_wemeet_refresh_token(token.as_ptr());
        }
    })
}

#[tauri::command]
pub async fn wemeet_login(app: AppHandle, sso_url: String) -> Result<(), String> {
    let sso_url = cstring(&sso_url);
    on_main(&app, move || {
        unsafe {
            yx_wemeet_login(sso_url.as_ptr());
        }
    })
}

#[tauri::command]
pub async fn wemeet_join(
    app: AppHandle,
    meeting_code: String,
    display_name: Option<String>,
    password: Option<String>,
    mic_on: Option<bool>,
    camera_on: Option<bool>,
    face_beauty_on: Option<bool>,
) -> Result<(), String> {
    let code = cstring(&meeting_code);
    let name = cstring(display_name.as_deref().unwrap_or(""));
    let pwd = cstring(password.as_deref().unwrap_or(""));
    let mic = mic_on.unwrap_or(false);
    let cam = camera_on.unwrap_or(true);
    let beauty = face_beauty_on.unwrap_or(false);
    on_main(&app, move || {
        unsafe {
            yx_wemeet_join(code.as_ptr(), name.as_ptr(), pwd.as_ptr(), mic, cam, beauty);
        }
    })
}

#[tauri::command]
pub async fn wemeet_quick(app: AppHandle, window_title: Option<String>) -> Result<(), String> {
    let title = cstring(window_title.as_deref().unwrap_or(""));
    on_main(&app, move || {
        unsafe {
            yx_wemeet_quick(title.as_ptr());
        }
    })
}

#[tauri::command]
pub async fn wemeet_show_home(app: AppHandle) -> Result<(), String> {
    on_main(&app, || unsafe {
        yx_wemeet_show_home();
    })
}

#[tauri::command]
pub async fn wemeet_bring_top(app: AppHandle) -> Result<(), String> {
    on_main(&app, || unsafe {
        yx_wemeet_bring_top();
    })
}

#[tauri::command]
pub async fn wemeet_logout(app: AppHandle) -> Result<(), String> {
    on_main(&app, || unsafe {
        yx_wemeet_logout();
    })
}

#[tauri::command]
pub async fn wemeet_release(app: AppHandle) -> Result<(), String> {
    on_main(&app, || unsafe {
        yx_wemeet_release();
    })
}
