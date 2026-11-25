//! 下载只接收前端 plugin-http 响应流的原始字节，不从 Rust 发外部 HTTP。
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use serde::Serialize;
use tauri::{ipc::{InvokeBody, Request}, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::db::{self, Db};

const MAX_CHUNK: usize = 1024 * 1024;
pub struct Download {
    file: tokio::sync::Mutex<tokio::fs::File>,
    path: PathBuf,
    destination: PathBuf,
    total: Option<u64>,
    written: std::sync::atomic::AtomicU64,
}
#[derive(Default)]
pub struct Downloads {
    active: Mutex<HashMap<String, Arc<Download>>>,
    saved: Mutex<HashMap<String, PathBuf>>,
}
impl Downloads {
    pub fn saved_path(&self, id: &str) -> Result<PathBuf, String> {
        self.saved.lock().map_err(|_| "下载状态不可用")?.get(id).cloned().filter(|path| path.is_file()).ok_or("下载文件不存在".into())
    }
}
#[derive(Serialize)]
pub struct SavedDownload { pub id: String, pub path: String }

fn safe_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("下载标识无效".into()); }
    Ok(id)
}
pub fn safe_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("文件");
    let cleaned: String = leaf.chars().filter(|c| !c.is_control() && ![':', '*', '?', '"', '<', '>', '|'].contains(c)).take(180).collect();
    let cleaned = cleaned.trim().trim_matches('.');
    if cleaned.is_empty() { "文件".into() } else { cleaned.into() }
}
fn reserve_path(directory: &Path, name: &str) -> Result<PathBuf, String> {
    let name = safe_name(name);
    let original = Path::new(&name);
    let stem = original.file_stem().and_then(|s| s.to_str()).unwrap_or("文件");
    let extension = original.extension().and_then(|s| s.to_str()).map(|s| format!(".{s}")).unwrap_or_default();
    for index in 0..10000 {
        let filename = if index == 0 { name.clone() } else { format!("{stem} ({index}){extension}") };
        let target = directory.join(filename);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(_) => return Ok(target),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法在下载目录创建文件".into()),
        }
    }
    Err("同名下载文件过多".into())
}

pub fn cleanup_stale(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else { return; };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(remainder) = name.strip_prefix('.').and_then(|name| name.strip_suffix(".yx-part")) else { continue; };
        let Some((id, filename)) = remainder.split_once('.') else { continue; };
        if safe_id(id).is_err() || safe_name(filename) != filename { continue; }
        let destination = directory.join(filename);
        if std::fs::metadata(&destination).is_ok_and(|metadata| metadata.len() == 0) { let _ = std::fs::remove_file(destination); }
        let _ = std::fs::remove_file(entry.path());
    }
}

/// 下载落地目录：默认 `下载目录/YX`（见 `db::DOWNLOAD_DIR`），可在配置库里覆盖。
pub fn download_dir(app: &tauri::AppHandle, db: &Db) -> PathBuf {
    db.effective_path(app, db::DOWNLOAD_DIR)
        .or_else(|| app.path().download_dir().ok().map(|dir| dir.join("YX")))
        .unwrap_or_else(std::env::temp_dir)
}

#[tauri::command]
pub async fn attachment_download_begin(app: tauri::AppHandle, db: State<'_, Db>, state: State<'_, Downloads>, id: String, name: String, total: Option<u64>) -> Result<(), String> {
    let directory = download_dir(&app, &db);
    begin_download(&state, &directory, id, name, total).await
}
async fn begin_download(state: &Downloads, directory: &Path, id: String, name: String, total: Option<u64>) -> Result<(), String> {
    safe_id(&id)?;
    if state.active.lock().map_err(|_| "下载状态不可用")?.contains_key(&id) { return Err("下载已存在".into()); }
    tokio::fs::create_dir_all(directory).await.map_err(|_| "无法创建下载目录")?;
    let destination = reserve_path(&directory, &name)?;
    let path = directory.join(format!(".{id}.{}.yx-part", destination.file_name().unwrap_or_default().to_string_lossy()));
    let file = match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await {
        Ok(file) => file,
        Err(_) => { let _ = tokio::fs::remove_file(&destination).await; return Err("无法创建下载临时文件".into()); }
    };
    state.active.lock().map_err(|_| "下载状态不可用")?.insert(id, Arc::new(Download { file: tokio::sync::Mutex::new(file), path, destination, total, written: 0.into() }));
    Ok(())
}

#[tauri::command]
pub async fn attachment_download_chunk(state: State<'_, Downloads>, request: Request<'_>) -> Result<u64, String> {
    let id = request.headers().get("x-download-id").and_then(|v| v.to_str().ok()).ok_or("缺少下载标识")?;
    let offset = request.headers().get("x-download-offset").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).ok_or("缺少下载偏移")?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("下载分片必须使用原始字节通道".into()); };
    write_chunk(&state, id, offset, bytes).await
}
async fn write_chunk(state: &Downloads, id: &str, offset: u64, bytes: &[u8]) -> Result<u64, String> {
    if bytes.len() > MAX_CHUNK { return Err("下载分片过大".into()); }
    let job = state.active.lock().map_err(|_| "下载状态不可用")?.get(id).cloned().ok_or("下载已取消或不存在")?;
    let mut file = job.file.lock().await;
    let written = job.written.load(std::sync::atomic::Ordering::Relaxed);
    if offset != written { return Err("下载分片顺序不一致".into()); }
    if job.total.is_some_and(|total| written + bytes.len() as u64 > total) { return Err("下载正文超过声明长度".into()); }
    file.write_all(bytes).await.map_err(|_| "写入下载文件失败")?;
    let next = written + bytes.len() as u64;
    job.written.store(next, std::sync::atomic::Ordering::Relaxed);
    Ok(next)
}

#[tauri::command]
pub async fn attachment_download_commit(state: State<'_, Downloads>, id: String) -> Result<SavedDownload, String> {
    commit_download(&state, id).await
}
async fn commit_download(state: &Downloads, id: String) -> Result<SavedDownload, String> {
    let job = state.active.lock().map_err(|_| "下载状态不可用")?.get(&id).cloned().ok_or("下载已取消或不存在")?;
    let mut file = job.file.lock().await;
    if job.total.is_some_and(|total| job.written.load(std::sync::atomic::Ordering::Relaxed) != total) { return Err("下载未完整结束，请重试".into()); }
    file.flush().await.map_err(|_| "保存下载文件失败")?;
    file.sync_all().await.map_err(|_| "保存下载文件失败")?;
    tokio::fs::rename(&job.path, &job.destination).await.map_err(|_| "完成下载文件失败")?;
    state.active.lock().map_err(|_| "下载状态不可用")?.remove(&id);
    state.saved.lock().map_err(|_| "下载状态不可用")?.insert(id.clone(), job.destination.clone());
    Ok(SavedDownload { id, path: job.destination.to_string_lossy().into() })
}

#[tauri::command]
pub async fn attachment_download_cancel(state: State<'_, Downloads>, id: String) -> Result<(), String> {
    cancel_download(&state, id).await
}
async fn cancel_download(state: &Downloads, id: String) -> Result<(), String> {
    let job = state.active.lock().map_err(|_| "下载状态不可用")?.remove(&id);
    if let Some(job) = job {
        let _guard = job.file.lock().await;
        let _ = tokio::fs::remove_file(&job.path).await;
        let _ = tokio::fs::remove_file(&job.destination).await;
    }
    Ok(())
}

#[tauri::command]
pub fn attachment_download_open(app: tauri::AppHandle, state: State<'_, Downloads>, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = state.saved.lock().map_err(|_| "下载状态不可用")?.get(&id).cloned().ok_or("下载文件不存在，请重新下载")?;
    if !path.is_file() { return Err("下载文件已移动或删除".into()); }
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|_| "无法打开下载文件，请在下载目录手动打开".into())
}

#[tauri::command]
pub fn media_codec_support(app: tauri::AppHandle, db: State<'_, Db>) -> bool { ffmpeg_path(&app, &db).is_some() }
fn ffmpeg_path(app: &tauri::AppHandle, db: &Db) -> Option<PathBuf> {
    // 配置库里存了绝对路径就直接用（Windows 没有 homebrew 之类的约定目录）。
    if let Some(configured) = db.effective_path(app, db::FFMPEG_PATH) {
        if configured.is_file() {
            return Some(configured);
        }
    }
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut candidates: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|p| p.join(name)).collect();
    #[cfg(target_os = "macos")]
    candidates.extend([PathBuf::from("/opt/homebrew/bin/ffmpeg"), PathBuf::from("/usr/local/bin/ffmpeg")]);
    candidates.into_iter()
        .find(|path| {
            if !path.is_file() { return false; }
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; return path.metadata().is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0); }
            #[cfg(not(unix))] { true }
        })
}
#[tauri::command]
pub async fn attachment_transcode(app: tauri::AppHandle, db: State<'_, Db>, state: State<'_, Downloads>, id: String, video: bool) -> Result<SavedDownload, String> {
    let executable = ffmpeg_path(&app, &db).ok_or("未安装 ffmpeg，请使用系统播放器打开下载文件")?;
    let input = state.saved.lock().map_err(|_| "下载状态不可用")?.get(&id).cloned().ok_or("请先下载文件")?;
    let target = reserve_path(input.parent().ok_or("下载目录无效")?, if video { "转换后视频.mp4" } else { "转换后音频.m4a" })?;
    let mut command = tokio::process::Command::new(executable);
    command.arg("-nostdin").args(["-loglevel", "error", "-y", "-i"]).arg(&input);
    if video { command.args(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"]); }
    else { command.args(["-vn", "-c:a", "aac"]); }
    let output = match tokio::time::timeout(std::time::Duration::from_secs(600), command.arg(&target).kill_on_drop(true).output()).await {
        Ok(Ok(output)) => output,
        _ => { let _ = tokio::fs::remove_file(&target).await; return Err("本机转换失败或超时，请使用系统播放器打开原文件".into()); }
    };
    if !output.status.success() { let _ = tokio::fs::remove_file(&target).await; return Err("本机转换失败，请使用系统播放器打开原文件".into()); }
    let converted_id = format!("{id}-converted");
    state.saved.lock().map_err(|_| "下载状态不可用")?.insert(converted_id.clone(), target.clone());
    Ok(SavedDownload { id: converted_id, path: target.to_string_lossy().into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_names_and_collision_do_not_overwrite() {
        let dir = std::env::temp_dir().join(format!("yx-download-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(safe_name("../../a.txt"), "a.txt");
        assert_eq!(safe_name("..\\..\\b.txt"), "b.txt");
        assert!(safe_id("../escape").is_err());
        let first = reserve_path(&dir, "a.txt").unwrap();
        std::fs::write(&first, b"existing").unwrap();
        let second = reserve_path(&dir, "a.txt").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), b"existing");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn ordered_chunks_commit_and_cancel_cleanup() {
        let dir = std::env::temp_dir().join(format!("yx-download-chunks-{}", std::process::id()));
        let state = Downloads::default();
        begin_download(&state, &dir, "complete".into(), "测试.bin".into(), Some(6)).await.unwrap();
        assert!(write_chunk(&state, "complete", 1, b"wrong").await.is_err());
        assert_eq!(write_chunk(&state, "complete", 0, b"abc").await.unwrap(), 3);
        assert!(commit_download(&state, "complete".into()).await.is_err());
        assert_eq!(write_chunk(&state, "complete", 3, b"def").await.unwrap(), 6);
        assert!(write_chunk(&state, "complete", 6, b"overflow").await.is_err());
        let result = commit_download(&state, "complete".into()).await.unwrap();
        assert_eq!(tokio::fs::read(result.path).await.unwrap(), b"abcdef");
        begin_download(&state, &dir, "cancel".into(), "取消.bin".into(), None).await.unwrap();
        write_chunk(&state, "cancel", 0, b"partial").await.unwrap();
        cancel_download(&state, "cancel".into()).await.unwrap();
        assert!(write_chunk(&state, "cancel", 7, b"late").await.is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        begin_download(&state, &dir, "stale".into(), "残留.bin".into(), Some(10)).await.unwrap();
        cleanup_stale(&dir);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
