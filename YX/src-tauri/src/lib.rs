// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod zt;
use zt::ZtManager;
use tauri::{Manager, tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState}};

#[tauri::command]
fn set_tray_unread(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let tray = app.tray_by_id("main").ok_or("系统托盘尚未创建")?;
    tray.set_title(Some(if count > 0 { count.to_string() } else { String::new() }))
        .map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(if count > 0 {
        format!("YX · {} 条未读消息", count)
    } else {
        "YX".to_string()
    })).map_err(|e| e.to_string())
}

#[tauri::command]
fn play_message_sound() {
    // 由原生进程播放，避免 WebView 自动播放策略拦截后台提示音。
    #[cfg(target_os = "macos")]
    std::thread::spawn(|| {
        let _ = std::process::Command::new("/usr/bin/afplay")
            .arg("/System/Library/Sounds/Glass.aiff").status();
    });
}


#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ZtManager::default())
        .setup(|app| {
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("缺少应用图标").clone())
                .tooltip("YX")
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::Click {
                        button: MouseButton::Left, button_state: MouseButtonState::Up, ..
                    }) {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            set_tray_unread,
            play_message_sound,
            zt::zt_start,
            zt::zt_stop,
            zt::zt_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
