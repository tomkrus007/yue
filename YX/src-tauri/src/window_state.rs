// 记住主窗口大小：关闭/退出时写入 app_config_dir 下的 window-state.json，下次启动恢复。
// 只记尺寸不记位置，避免外接屏拔掉后窗口跑到屏幕外。
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, LogicalSize, Manager};

/// 最小可缩放尺寸，与 tauri.conf.json 的 minWidth/minHeight 保持一致。
pub const MIN_WIDTH: u32 = 900;
pub const MIN_HEIGHT: u32 = 600;

/// 拖拽缩放时的写盘节流；最终尺寸仍由关闭窗口/退出时的保存兜底。
const SAVE_INTERVAL: Duration = Duration::from_millis(400);

static LAST_SAVE: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(serde::Serialize, serde::Deserialize)]
struct WindowSize {
    width: u32,
    height: u32,
}

fn state_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("window-state.json"))
}

/// 恢复上次保存的窗口尺寸，并限制在最小尺寸与当前屏幕之间。
pub fn restore(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let Some(path) = state_file(app) else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(saved) = serde_json::from_str::<WindowSize>(&text) else { return };
    let mut width = saved.width.max(MIN_WIDTH);
    let mut height = saved.height.max(MIN_HEIGHT);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let max_w = (monitor.size().width as f64 / scale) as u32;
        let max_h = (monitor.size().height as f64 / scale) as u32;
        width = width.min(max_w.max(MIN_WIDTH));
        height = height.min(max_h.max(MIN_HEIGHT));
    }
    let _ = window.set_size(LogicalSize::new(width, height));
}

/// 按逻辑像素记录主窗口尺寸（跨不同缩放比例的屏幕也一致）。force=false 时按间隔节流。
pub fn save(app: &AppHandle, force: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    if !force {
        let Ok(mut last) = LAST_SAVE.lock() else { return };
        if last.is_some_and(|t| t.elapsed() < SAVE_INTERVAL) {
            return;
        }
        *last = Some(Instant::now());
    }
    let Ok(size) = window.inner_size() else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let window_size = WindowSize {
        width: (size.width as f64 / scale).round() as u32,
        height: (size.height as f64 / scale).round() as u32,
    };
    let Some(path) = state_file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(&window_size) {
        let _ = std::fs::write(path, text);
    }
}
