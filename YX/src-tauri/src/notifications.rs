//! 系统通知（macOS 原生后端）。
//!
//! 不用 tauri-plugin-notification：它的 macOS 实现会给每条通知挂一个等待线程，
//! 直到用户点击或清掉通知才释放，消息多时线程会无限堆积。这里换成自建的
//! NSUserNotificationCenter delegate（`native/notification_mac.m`）：展示即返回，
//! 点击回调把前端下发的 key 原样交回，再 emit 成 `notification-click`。
//!
//! 未打包的 dev 二进制没有 bundle id，通知中心不会投递，前端在 dev 下仍走插件
//! （见 `src/services/notifications.ts`）。两条链路不能混用：notify-rust 在第一次
//! 发通知时会把自己的 delegate 挂到 NSUserNotificationCenter 上，把这里的换掉。

use tauri::AppHandle;

/// 注册点击回调。必须在展示第一条通知之前调用，且要在主线程。
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    imp::init(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// 展示一条通知；`key` 是点击时要交回前端的标识（前端放的是目标的 JSON）。
pub fn show(app: &AppHandle, title: String, body: String, key: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // NSUserNotificationCenter 要求在主线程序列化，命令线程直接调用不可靠。
        app.run_on_main_thread(move || {
            if let Err(error) = imp::show(&title, &body, key.as_deref()) {
                eprintln!("[notify] 系统通知失败：{error}");
            }
        })
        .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title, body, key);
        Err("当前平台没有原生通知后端".into())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{c_char, CStr, CString};
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};

    unsafe extern "C" {
        fn yx_notify_init(callback: Option<extern "C" fn(*const c_char)>);
        fn yx_notify_show(title: *const c_char, body: *const c_char, key: *const c_char);
    }

    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// 点击通知（delegate 在主线程回调）：把 key 交给前端，窗口与跳转由前端处理。
    extern "C" fn on_click(key: *const c_char) {
        if key.is_null() {
            return;
        }
        let Ok(key) = unsafe { CStr::from_ptr(key) }.to_str() else {
            return;
        };
        if let Some(app) = APP.get() {
            let _ = app.emit("notification-click", key);
        }
    }

    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        unsafe { yx_notify_init(Some(on_click)) };
    }

    pub fn show(title: &str, body: &str, key: Option<&str>) -> Result<(), String> {
        let title = CString::new(title).map_err(|error| error.to_string())?;
        let body = CString::new(body).map_err(|error| error.to_string())?;
        let key = CString::new(key.unwrap_or_default()).map_err(|error| error.to_string())?;
        unsafe { yx_notify_show(title.as_ptr(), body.as_ptr(), key.as_ptr()) };
        Ok(())
    }
}
