//! 附件 / 云盘文件上传。
//!
//! 为什么不用 WebView 直传：
//! - `@tauri-apps/plugin-http` 的 fetch 会把整个请求体 `Array.from(new Uint8Array(buf))`
//!   后经 IPC 交给 Rust；600MB 文件就是 6 亿个数字的数组，WebView 进程会 100% CPU 卡死。
//! - WebView 里的 XHR 直传又依赖存储服务的 CORS，实测拿不到进度。
//!
//! 所以这里把整条链路放到 Rust：前端按 8MB 分片把字节写进临时文件，
//! 再由 Rust 流式读这个文件发 multipart 请求，内存占用与文件大小无关。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::State;

use crate::db::{self, Db};
use tokio::io::AsyncWriteExt;

/// 上传进度，前端换算成 0-100。
#[derive(Clone, Serialize)]
pub struct UploadProgress {
    pub sent: u64,
    pub total: u64,
}

/// 存储服务原始响应，由前端复用原有的 401 / 状态码处理。
#[derive(Clone, Serialize)]
pub struct UploadResponse {
    pub status: u16,
    pub text: String,
}

#[derive(Default)]
pub struct UploadSpool {
    files: Mutex<HashMap<String, PathBuf>>,
}

/// 上传分片目录：默认在应用缓存目录下（见 `db::SPOOL_DIR`），可在配置库里覆盖。
fn spool_dir(app: &tauri::AppHandle, db: &Db) -> PathBuf {
    db.effective_path(app, db::SPOOL_DIR)
        .unwrap_or_else(|| std::env::temp_dir().join("YX").join("upload"))
}

fn spool_path(app: &tauri::AppHandle, db: &Db, id: &str) -> Result<PathBuf, String> {
    // id 由前端生成，只允许字母数字和横线，避免路径穿越。
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if safe.is_empty() {
        return Err("上传 id 无效".into());
    }
    Ok(spool_dir(app, db).join(format!("{safe}.part")))
}

fn header_str(headers: &tauri::http::HeaderMap, name: &str) -> Result<String, String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("缺少请求头 {name}"))
}

fn lookup(state: &State<'_, UploadSpool>, id: &str) -> Result<PathBuf, String> {
    state
        .files
        .lock()
        .map_err(|_| "上传状态已损坏".to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "上传会话不存在（可能已取消）".to_string())
}

/// 应用启动时清掉上次崩溃残留的分片文件。
pub fn cleanup_stale(app: &tauri::AppHandle, db: &Db) {
    let _ = std::fs::remove_dir_all(spool_dir(app, db));
}

/// 流式读本地文件，按 `file / fileName / size` 三个字段发 multipart 请求。
/// `on_sent` 在上传过程中被调用，参数是（已发送字节，总字节）。
async fn post_multipart(
    path: &Path,
    url: &str,
    token: &str,
    file_name: &str,
    on_sent: Arc<dyn Fn(u64, u64) + Send + Sync>,
) -> Result<UploadResponse, String> {
    let total = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("读取临时文件失败：{e}"))?
        .len();
    if total == 0 {
        return Err("不能发送空文件".into());
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("读取临时文件失败：{e}"))?;

    let counter = Arc::new(AtomicU64::new(0));
    let last_pct = Arc::new(AtomicU64::new(0));
    let pct_seen = last_pct.clone();
    let body = tokio_util::io::ReaderStream::with_capacity(file, 512 * 1024).map(move |chunk| {
        let chunk = chunk?;
        let done = counter.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
        let pct = done * 100 / total;
        if pct > pct_seen.load(Ordering::Relaxed) {
            pct_seen.store(pct, Ordering::Relaxed);
            on_sent(done, total);
        }
        Ok::<_, std::io::Error>(chunk)
    });

    // 已知总长度，reqwest 才能算出 Content-Length 而不是发 chunked。
    let part = reqwest::multipart::Part::stream_with_length(
        reqwest::Body::wrap_stream(body),
        total,
    )
    .file_name(file_name.to_string())
    .mime_str("application/octet-stream")
    .map_err(|e| format!("构造上传请求失败：{e}"))?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("fileName", file_name.to_string())
        .text("size", total.to_string());

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("初始化上传失败：{e}"))?;
    let mut req = client.post(url).multipart(form);
    if !token.is_empty() {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let resp = req.send().await.map_err(|e| format!("上传失败：{e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok(UploadResponse { status, text })
}

/// 开始一次上传：创建空的临时文件占位。
#[tauri::command]
pub fn store_upload_begin(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    id: String,
    state: State<'_, UploadSpool>,
) -> Result<(), String> {
    let path = spool_path(&app, &db, &id)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    }
    std::fs::File::create(&path).map_err(|e| format!("创建临时文件失败：{e}"))?;
    state
        .files
        .lock()
        .map_err(|_| "上传状态已损坏".to_string())?
        .insert(id, path);
    Ok(())
}

/// 追加一个分片。前端用 `invoke(cmd, uint8) + headers` 的原始字节通道调用，
/// 单次只占一个分片的内存（普通对象参数会被 JSON 化成数字数组，不能这样用）。
#[tauri::command]
pub async fn store_upload_chunk(
    request: Request<'_>,
    state: State<'_, UploadSpool>,
) -> Result<(), String> {
    let id = header_str(request.headers(), "x-upload-id")?;
    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("上传分片必须是原始字节".into()),
    };
    let path = lookup(&state, &id)?;
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("写入临时文件失败：{e}"))?;
    file.write_all(&data)
        .await
        .map_err(|e| format!("写入临时文件失败：{e}"))?;
    file.flush()
        .await
        .map_err(|e| format!("写入临时文件失败：{e}"))?;
    Ok(())
}

/// 从临时文件流式上传到存储服务，返回原始响应。
/// 临时文件保留到 `store_upload_cancel`，便于换地址重试。
#[tauri::command]
pub async fn store_upload_commit(
    id: String,
    url: String,
    token: String,
    file_name: String,
    on_progress: Channel<UploadProgress>,
    state: State<'_, UploadSpool>,
) -> Result<UploadResponse, String> {
    let path = lookup(&state, &id)?;
    let progress = on_progress.clone();
    let notify = Arc::new(move |sent: u64, total: u64| {
        let _ = progress.send(UploadProgress { sent, total });
    });
    post_multipart(&path, &url, &token, &file_name, notify).await
}

/// 结束上传（成功或失败都调用）：删除临时文件。
#[tauri::command]
pub async fn store_upload_cancel(
    id: String,
    state: State<'_, UploadSpool>,
) -> Result<(), String> {
    let path = state
        .files
        .lock()
        .map_err(|_| "上传状态已损坏".to_string())?
        .remove(&id);
    if let Some(path) = path {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// 极简 HTTP 服务端：读满 Content-Length 后回固定 JSON，用于校验上传报文。
    async fn mock_store(body_tx: mpsc::Sender<Vec<u8>>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 64 * 1024];
            loop {
                let n = tokio::io::AsyncReadExt::read(&mut socket, &mut chunk)
                    .await
                    .unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map(|v| v.trim().parse().unwrap())
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            body_tx.send(buf).unwrap();
            let body = "{\"r\":{\"fileId\":\"mock-file-id\"}}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = tokio::io::AsyncWriteExt::write_all(&mut socket, resp.as_bytes()).await;
        });
        (format!("http://{addr}/store/store/putFile?module=message&security=0"), handle)
    }

    #[tokio::test]
    async fn uploads_file_as_multipart_with_content_length() {
        // 1.2MB：跨多个 512KB 读块，验证流式分块无误。
        let payload: Vec<u8> = (0..1_200_000u32).map(|i| (i % 251) as u8).collect();
        let path = std::env::temp_dir().join(format!("yx-upload-test-{}.part", std::process::id()));
        std::fs::write(&path, &payload).unwrap();

        let (body_tx, body_rx) = mpsc::channel();
        let (url, server) = mock_store(body_tx).await;

        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_cb = seen.clone();
        let res = post_multipart(
            &path,
            &url,
            "test-token",
            "大文件测试.bin",
            Arc::new(move |sent, total| seen_cb.lock().unwrap().push((sent, total))),
        )
        .await
        .unwrap();

        let raw = body_rx.recv().unwrap();
        server.await.unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(res.status, 200);
        assert!(res.text.contains("mock-file-id"));

        let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
        let body = &raw[head_end + 4..];

        assert!(head.starts_with("POST /store/store/putFile?module=message&security=0"));
        assert!(head.contains("authorization: Bearer test-token"));
        assert!(head.contains("content-type: multipart/form-data; boundary="));
        assert!(head.contains(&format!("content-length: {}", body.len())));
        let text = String::from_utf8_lossy(body).to_string();
        assert!(text.contains("name=\"file\"; filename=\"大文件测试.bin\""));
        assert!(text.contains("name=\"fileName\""));
        assert!(text.contains("name=\"size\""));
        assert!(text.contains(&format!("{}", payload.len())));
        // 文件正文必须完整落在 multipart 里，且顺序与源文件一致。
        let start = body
            .windows(8)
            .position(|w| w == &payload[..8])
            .expect("响应里找不到文件正文");
        assert_eq!(&body[start..start + payload.len()], &payload[..]);

        let seen = seen.lock().unwrap();
        assert_eq!(seen.last().unwrap().0, payload.len() as u64);
        assert_eq!(seen.last().unwrap().1, payload.len() as u64);
    }
}