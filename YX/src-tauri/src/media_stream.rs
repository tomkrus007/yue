//! 本机播放器代理。外部 HTTP 由 WebView 中 plugin-http 拉取；此模块只处理本机 socket 与原始字节 IPC。
use std::{collections::HashMap, hash::{BuildHasher, Hash, Hasher}, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}};
use serde::{Deserialize, Serialize};
use tauri::{ipc::{Channel, InvokeBody, Request}, State};
use tokio::{io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::{mpsc, Notify, OnceCell}};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn unique_id() -> String {
    let mut hash = std::collections::hash_map::RandomState::new().build_hasher();
    NEXT_ID.fetch_add(1, Ordering::Relaxed).hash(&mut hash);
    std::time::SystemTime::now().hash(&mut hash);
    format!("{:016x}{:016x}", hash.finish(), NEXT_ID.fetch_add(1, Ordering::Relaxed))
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MediaEvent {
    Request { id: String, method: String, range: Option<String> },
    Abort { id: String },
}
#[derive(Deserialize)]
pub struct MediaHead { status: u16, headers: HashMap<String, String> }
enum Part { Head(MediaHead), Bytes(Vec<u8>), End }
#[derive(Clone)]
enum Origin { Frontend(Channel<MediaEvent>), Local(PathBuf) }
#[derive(Clone)]
struct Source { origin: Origin, mime: String, closed: Arc<Notify> }
#[derive(Clone)]
struct Gateway {
    address: String,
    sources: Arc<Mutex<HashMap<String, Source>>>,
    requests: Arc<Mutex<HashMap<String, mpsc::Sender<Part>>>>,
}
#[derive(Default)]
pub struct MediaStreams { gateway: OnceCell<Gateway> }
#[derive(Serialize)]
pub struct MediaLease { pub id: String, pub url: String }

impl MediaStreams {
    async fn gateway(&self) -> Result<&Gateway, String> {
        self.gateway.get_or_try_init(|| async {
            let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| "无法启动本机媒体服务")?;
            let gateway = Gateway { address: listener.local_addr().map_err(|_| "无法取得媒体端口")?.to_string(), sources: Arc::default(), requests: Arc::default() };
            let shared = gateway.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok((socket, _)) = listener.accept().await {
                    let gateway = shared.clone();
                    tauri::async_runtime::spawn(async move { let _ = serve(socket, gateway).await; });
                }
            });
            Ok::<Gateway, String>(gateway)
        }).await
    }
}
fn mime_type(mime: &str) -> String {
    match mime { "audio/mpeg" | "audio/wav" | "audio/ogg" | "audio/mp4" | "audio/aac" | "audio/amr" | "audio/flac" | "video/mp4" | "video/webm" | "video/quicktime" | "video/ogg" => mime.into(), _ => "application/octet-stream".into() }
}
fn add_source(gateway: &Gateway, origin: Origin, mime: &str) -> Result<MediaLease, String> {
    let id = unique_id();
    let mut sources = gateway.sources.lock().map_err(|_| "媒体服务不可用")?;
    if sources.len() >= 128 { return Err("打开的媒体过多，请关闭部分播放器后重试".into()); }
    sources.insert(id.clone(), Source { origin, mime: mime_type(mime), closed: Arc::new(Notify::new()) });
    Ok(MediaLease { url: format!("http://{}/{id}", gateway.address), id })
}
#[tauri::command]
pub async fn media_stream_open(state: State<'_, MediaStreams>, mime: String, on_request: Channel<MediaEvent>) -> Result<MediaLease, String> {
    add_source(state.gateway().await?, Origin::Frontend(on_request), &mime)
}
#[tauri::command]
pub async fn media_local_open(state: State<'_, MediaStreams>, downloads: State<'_, crate::store_download::Downloads>, id: String, mime: String) -> Result<MediaLease, String> {
    add_source(state.gateway().await?, Origin::Local(downloads.saved_path(&id)?), &mime)
}
#[tauri::command]
pub fn media_stream_close(state: State<'_, MediaStreams>, id: String) -> Result<(), String> {
    if let Some(gateway) = state.gateway.get() {
        if let Some(source) = gateway.sources.lock().map_err(|_| "媒体服务不可用")?.remove(&id) { source.closed.notify_waiters(); }
    }
    Ok(())
}
async fn send_part(state: &MediaStreams, id: &str, part: Part) -> Result<(), String> {
    let gateway = state.gateway.get().ok_or("媒体服务尚未启动")?;
    let sender = gateway.requests.lock().map_err(|_| "媒体请求不可用")?.get(id).cloned().ok_or("媒体请求已结束")?;
    sender.send(part).await.map_err(|_| "播放器已关闭".into())
}
#[tauri::command]
pub async fn media_response_head(state: State<'_, MediaStreams>, id: String, head: MediaHead) -> Result<(), String> { send_part(&state, &id, Part::Head(head)).await }
#[tauri::command]
pub async fn media_response_chunk(state: State<'_, MediaStreams>, request: Request<'_>) -> Result<(), String> {
    let id = request.headers().get("x-media-request").and_then(|v| v.to_str().ok()).ok_or("缺少媒体请求标识")?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("媒体必须使用原始字节通道".into()); };
    if bytes.len() > 1024 * 1024 { return Err("媒体分片过大".into()); }
    send_part(&state, id, Part::Bytes(bytes.clone())).await
}
#[tauri::command]
pub async fn media_response_end(state: State<'_, MediaStreams>, id: String) -> Result<(), String> { send_part(&state, &id, Part::End).await }

async fn serve(mut socket: TcpStream, gateway: Gateway) -> Result<(), String> {
    let mut buffer = Vec::new();
    let mut chunk = [0; 1024];
    while !buffer.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        let count = tokio::time::timeout(std::time::Duration::from_secs(10), socket.read(&mut chunk)).await.map_err(|_| "读取播放器请求超时")?.map_err(|_| "读取播放器请求失败")?;
        if count == 0 || buffer.len() + count > 8192 { return Err("播放器请求无效".into()); }
        buffer.extend_from_slice(&chunk[..count]);
    }
    let request = std::str::from_utf8(&buffer).map_err(|_| "播放器请求无效")?;
    let first: Vec<_> = request.lines().next().unwrap_or("").split_whitespace().collect();
    if first.len() != 3 || !["GET", "HEAD"].contains(&first[0]) { return simple_response(&mut socket, 405).await; }
    let id = first[1].trim_start_matches('/');
    let source = gateway.sources.lock().map_err(|_| "媒体服务不可用")?.get(id).cloned();
    let Some(source) = source else { return simple_response(&mut socket, 404).await; };
    let method = first[0].to_string();
    let range = request.lines().skip(1).find_map(|line| { let (name, value) = line.split_once(':')?; name.eq_ignore_ascii_case("range").then(|| value.trim().to_string()) });
    let result = match &source.origin {
        Origin::Local(path) => tokio::select! { result = serve_local(&mut socket, path, &source.mime, &method, range.as_deref()) => result, _ = source.closed.notified() => Ok(()) },
        Origin::Frontend(channel) => {
            let request_id = unique_id();
            let (sender, receiver) = mpsc::channel(2);
            gateway.requests.lock().map_err(|_| "媒体请求不可用")?.insert(request_id.clone(), sender);
            let event = MediaEvent::Request { id: request_id.clone(), method: method.clone(), range };
            let result = if channel.send(event).is_ok() {
                tokio::select! { result = serve_frontend(&mut socket, receiver, &source.mime, method == "HEAD") => result, _ = source.closed.notified() => Ok(()) }
            } else { simple_response(&mut socket, 502).await };
            gateway.requests.lock().map_err(|_| "媒体请求不可用")?.remove(&request_id);
            let _ = channel.send(MediaEvent::Abort { id: request_id });
            result
        }
    };
    let _ = socket.shutdown().await;
    result
}
async fn simple_response(socket: &mut TcpStream, status: u16) -> Result<(), String> {
    socket.write_all(format!("HTTP/1.1 {status} Error\r\nContent-Length: 0\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").as_bytes()).await.map_err(|_| "播放器已关闭".into())
}
async fn serve_frontend(socket: &mut TcpStream, mut receiver: mpsc::Receiver<Part>, mime: &str, head_only: bool) -> Result<(), String> {
    let first = tokio::time::timeout(std::time::Duration::from_secs(30), receiver.recv()).await.map_err(|_| "媒体响应超时")?;
    let Some(Part::Head(head)) = first else { return simple_response(socket, 502).await; };
    if ![200, 206, 304, 416].contains(&head.status) { return simple_response(socket, head.status).await; }
    let actual_mime = if mime == "application/octet-stream" { mime_type(head.headers.get("content-type").map(|value| value.split(';').next().unwrap_or("")).unwrap_or(mime)) } else { mime.to_string() };
    let mut response = format!("HTTP/1.1 {} OK\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: {actual_mime}\r\nAccept-Ranges: bytes\r\n", head.status);
    let mut length = None;
    for (name, value) in &head.headers {
        let name = name.to_ascii_lowercase();
        if value.contains(['\r', '\n']) { continue; }
        if name == "content-length" { length = value.parse::<u64>().ok(); if length.is_none() { continue; } }
        if ["content-length", "content-range", "etag", "last-modified"].contains(&name.as_str()) { response.push_str(&format!("{name}: {value}\r\n")); }
    }
    let chunked = length.is_none() && !head_only;
    if chunked { response.push_str("Transfer-Encoding: chunked\r\n"); }
    response.push_str("\r\n");
    socket.write_all(response.as_bytes()).await.map_err(|_| "播放器已关闭")?;
    if head_only { return Ok(()); }
    while let Some(part) = receiver.recv().await {
        match part {
            Part::Bytes(bytes) => {
                if chunked { socket.write_all(format!("{:x}\r\n", bytes.len()).as_bytes()).await.map_err(|_| "播放器已关闭")?; }
                socket.write_all(&bytes).await.map_err(|_| "播放器已关闭")?;
                if chunked { socket.write_all(b"\r\n").await.map_err(|_| "播放器已关闭")?; }
            },
            Part::End => { if chunked { socket.write_all(b"0\r\n\r\n").await.map_err(|_| "播放器已关闭")?; } return Ok(()); },
            Part::Head(_) => return Err("媒体响应重复".into()),
        }
    }
    Err("媒体连接中断".into())
}
fn byte_range(total: u64, value: Option<&str>) -> Option<(u64, u64, u16)> {
    if total == 0 { return None; }
    let Some(value) = value else { return Some((0, total - 1, 200)); };
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if end.contains(',') { return None; }
    if start.is_empty() { let length = end.parse::<u64>().ok()?; return (length > 0).then(|| (total.saturating_sub(length), total - 1, 206)); }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() { total - 1 } else { end.parse::<u64>().ok()?.min(total - 1) };
    (start < total && end >= start).then_some((start, end, 206))
}
async fn serve_local(socket: &mut TcpStream, path: &PathBuf, mime: &str, method: &str, range: Option<&str>) -> Result<(), String> {
    let mut file = tokio::fs::File::open(path).await.map_err(|_| "转换后的媒体已不存在")?;
    let total = file.metadata().await.map_err(|_| "无法读取媒体长度")?.len();
    let Some((start, end, status)) = byte_range(total, range) else { return simple_response(socket, 416).await; };
    let mut headers = format!("HTTP/1.1 {status} OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n", end - start + 1);
    if status == 206 { headers.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n")); }
    headers.push_str("\r\n");
    socket.write_all(headers.as_bytes()).await.map_err(|_| "播放器已关闭")?;
    if method == "HEAD" { return Ok(()); }
    file.seek(std::io::SeekFrom::Start(start)).await.map_err(|_| "媒体定位失败")?;
    let mut remaining = end - start + 1;
    let mut buffer = vec![0; 64 * 1024];
    while remaining > 0 {
        let limit = (remaining as usize).min(buffer.len());
        let read = file.read(&mut buffer[..limit]).await.map_err(|_| "读取媒体失败")?;
        if read == 0 { return Err("媒体内容不完整".into()); }
        socket.write_all(&buffer[..read]).await.map_err(|_| "播放器已关闭")?;
        remaining -= read as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seek_ranges() {
        assert_eq!(byte_range(100, Some("bytes=20-29")), Some((20,29,206)));
        assert_eq!(byte_range(100, Some("bytes=90-")), Some((90,99,206)));
        assert_eq!(byte_range(100, Some("bytes=-10")), Some((90,99,206)));
        assert_eq!(byte_range(100, Some("bytes=100-")), None);
        assert_eq!(byte_range(100, Some("bytes=0-1,3-4")), None);
    }
    #[tokio::test]
    async fn local_proxy_delivers_only_requested_range() {
        let state = MediaStreams::default();
        let gateway = state.gateway().await.unwrap();
        let path = std::env::temp_dir().join(format!("yx-media-test-{}", unique_id()));
        tokio::fs::write(&path, b"0123456789").await.unwrap();
        let lease = add_source(gateway, Origin::Local(path.clone()), "audio/wav").unwrap();
        let mut socket = TcpStream::connect(&gateway.address).await.unwrap();
        socket.write_all(format!("GET /{} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=3-5\r\n\r\n",lease.id).as_bytes()).await.unwrap();
        let mut data = Vec::new(); socket.read_to_end(&mut data).await.unwrap();
        let response = String::from_utf8(data).unwrap();
        assert!(response.starts_with("HTTP/1.1 206"));
        assert!(response.contains("Content-Range: bytes 3-5/10"));
        assert!(response.ends_with("345"));
        tokio::fs::remove_file(path).await.unwrap();
    }
    #[tokio::test]
    async fn channel_proxy_preserves_range_and_stream_headers() {
        let state = MediaStreams::default();
        let gateway = state.gateway().await.unwrap().clone();
        let shared = gateway.clone();
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let channel = Channel::<MediaEvent>::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else { panic!("事件必须是元数据"); };
            let event: serde_json::Value = serde_json::from_str(&json).unwrap();
            if event["kind"] == "request" {
                let _ = events.send(event.clone());
                let sender = shared.requests.lock().unwrap().get(event["id"].as_str().unwrap()).unwrap().clone();
                tauri::async_runtime::spawn(async move {
                    sender.send(Part::Head(MediaHead { status: 206, headers: HashMap::from([("content-range".into(), "bytes 4-6/10".into()), ("content-length".into(), "3".into())]) })).await.unwrap();
                    sender.send(Part::Bytes(b"456".to_vec())).await.unwrap();
                    let _ = sender.send(Part::End).await;
                });
            }
            Ok(())
        });
        let lease = add_source(&gateway, Origin::Frontend(channel), "audio/wav").unwrap();
        let mut socket = TcpStream::connect(&gateway.address).await.unwrap();
        socket.write_all(format!("GET /{} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=4-6\r\n\r\n", lease.id).as_bytes()).await.unwrap();
        let mut bytes = Vec::new(); socket.read_to_end(&mut bytes).await.unwrap();
        let request = received.recv().await.unwrap();
        assert_eq!(request["range"], "bytes=4-6");
        let response = String::from_utf8(bytes).unwrap();
        assert!(response.starts_with("HTTP/1.1 206"));
        assert!(response.contains("content-range: bytes 4-6/10"));
        assert!(response.ends_with("456"));
    }
}
