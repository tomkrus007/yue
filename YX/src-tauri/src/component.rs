//! 会议组件（`TMSDK.framework`）的安装、校验与加载。
//!
//! 组件包是一份 `TMSDK-<ver>-<platform>-<arch>.tar.zst`，本地文件与网络下载共用同一份：
//! 解压 → 校验 → 落位 → 重签 → dlopen。为什么必须装回 `Contents/Frameworks`、
//! 为什么缺组件也要能启动，见 `doc/TMSDK组件化与跨平台设计.md`。

use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, ComponentRecord, Db};

const COMPONENT_ID: &str = "tmsdk";
const FRAMEWORK: &str = "TMSDK.framework";
/// 腾讯的 TeamIdentifier：组件包可以来自任何地方，但只有它能签出合法的框架。
const TENCENT_TEAM: &str = "5PMRFKHZTP";
/// 装组件后要重签外层 app；entitlements 必须与构建时一致，否则库校验会拦下腾讯框架。
const ENTITLEMENTS: &str = include_str!("../Entitlements.plist");

const DYLIB_RELATIVE: &str =
    "Versions/A/Frameworks/tmsdk_wemeet_sdk.framework/Versions/A/tmsdk_wemeet_sdk";

unsafe extern "C" {
    fn yx_wemeet_load_library(dylib_path: *const c_char) -> i32;
    fn yx_wemeet_library_error() -> *const c_char;
    fn yx_wemeet_version() -> *const c_char;
}

/// 组件状态。`unsupported` 与 `absent` 要分开：前者不该提示用户下载。
#[derive(Serialize)]
pub struct ComponentStatus {
    /// `ready` | `absent` | `unsupported` | `installing`
    pub state: &'static str,
    pub version: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
    /// 已安装框架占用的字节数（未安装为 0）
    pub installed_bytes: u64,
    /// 本地缓存的组件包（重装 app 后可离线恢复）
    pub cached_archive: Option<String>,
    pub cached_bytes: u64,
}

/// 安装进度，前端按 `phase` 显示不同文案。
#[derive(Clone, Serialize)]
struct Progress {
    phase: &'static str,
    received: Option<u64>,
    total: Option<u64>,
    message: Option<String>,
}

/// 正在进行的安装：用于拒绝并发安装，并支持取消下载/解压。
#[derive(Default)]
pub struct InstallState {
    running: Mutex<Option<Arc<AtomicBool>>>,
}

impl InstallState {
    fn begin(&self) -> Result<Arc<AtomicBool>, String> {
        let mut slot = self.running.lock().map_err(|_| "安装状态不可用")?;
        if slot.is_some() {
            return Err("已有安装任务在进行".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        *slot = Some(flag.clone());
        Ok(flag)
    }

    fn finish(&self) {
        if let Ok(mut slot) = self.running.lock() {
            *slot = None;
        }
    }

    fn busy(&self) -> bool {
        self.running.lock().map(|s| s.is_some()).unwrap_or(false)
    }
}

/// app 包内的 `Contents` 目录。裸二进制（`pnpm tauri dev`）没有这个结构。
fn bundle_contents() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("取可执行文件路径失败：{e}"))?;
    let macos = exe.parent().ok_or("可执行文件没有父目录")?;
    if macos.file_name().and_then(|n| n.to_str()) != Some("MacOS") {
        return Err("组件安装只在打包后的 YX.app 内可用（不要用 pnpm tauri dev）".into());
    }
    macos
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "可执行文件不在 .app/Contents/MacOS 内".into())
}

fn framework_path() -> Result<PathBuf, String> {
    Ok(bundle_contents()?.join("Frameworks").join(FRAMEWORK))
}

fn dylib_path() -> Result<PathBuf, String> {
    Ok(framework_path()?.join(DYLIB_RELATIVE))
}

fn cstring(value: &str) -> CString {
    CString::new(value).unwrap_or_else(|_| CString::new("").unwrap())
}

/// 确保框架已 `dlopen`。返回 `Ok(None)` 表示组件没装，`Ok(Some(version))` 表示可用。
///
/// `dlopen` 走主线程：TMSDK 的静态初始化会碰 AppKit，命令线程上做不保险。
pub fn ensure_loaded(app: &AppHandle) -> Result<Option<String>, String> {
    if !cfg!(target_os = "macos") {
        return Err("当前平台没有可用的会议组件".into());
    }
    let dylib = dylib_path()?;
    if !dylib.exists() {
        return Ok(None);
    }
    let path = cstring(&dylib.to_string_lossy());
    let rc = crate::wemeet::call_main(app, Duration::from_secs(10), move || unsafe {
        yx_wemeet_load_library(path.as_ptr())
    })?;
    if rc != 0 {
        let err = unsafe { CStr::from_ptr(yx_wemeet_library_error()) }
            .to_string_lossy()
            .to_string();
        return Err(if err.is_empty() {
            format!("加载会议组件失败（code={rc}）")
        } else {
            err
        });
    }
    Ok(Some(
        unsafe { CStr::from_ptr(yx_wemeet_version()) }
            .to_string_lossy()
            .to_string(),
    ))
}

fn cache_dir(app: &AppHandle, db: &Db) -> PathBuf {
    db.effective_path(app, db::COMPONENT_CACHE_DIR)
        .or_else(|| app.path().app_cache_dir().ok().map(|d| d.join("components")))
        .unwrap_or_else(|| std::env::temp_dir().join("YX/components"))
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_bytes(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// 缓存目录里最新的组件包（同目录只保留一份）。
fn cached_archive(app: &AppHandle, db: &Db) -> Option<PathBuf> {
    let dir = cache_dir(app, db);
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|e| e.to_str()) == Some("zst")
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("TMSDK-"))
        })
        .max_by_key(|path| std::fs::metadata(path).and_then(|m| m.modified()).ok())
}

pub fn status(app: &AppHandle, db: &Db, installing: bool) -> ComponentStatus {
    let unsupported = |error: Option<String>| ComponentStatus {
        state: if cfg!(target_os = "macos") {
            "absent"
        } else {
            "unsupported"
        },
        version: None,
        path: None,
        error,
        installed_bytes: 0,
        cached_archive: None,
        cached_bytes: 0,
    };
    let cache = cached_archive(app, db);
    let mut base = ComponentStatus {
        state: "absent",
        version: None,
        path: None,
        error: None,
        installed_bytes: 0,
        cached_archive: cache
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        cached_bytes: cache
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0),
    };
    if !cfg!(target_os = "macos") {
        let mut status = unsupported(None);
        status.cached_archive = base.cached_archive;
        status.cached_bytes = base.cached_bytes;
        return status;
    }
    if installing {
        base.state = "installing";
        return base;
    }
    let Ok(framework) = framework_path() else {
        return unsupported(Some("组件安装只在打包后的 YX.app 内可用".into()));
    };
    base.path = Some(framework.to_string_lossy().into_owned());
    if !framework.exists() {
        // 覆盖安装 app 会把 Frameworks 整个换掉：记录还在、实体没了，顺手清掉避免误报。
        if db.component().is_some() {
            let _ = db.clear_component();
        }
        return base;
    }
    base.installed_bytes = dir_bytes(&framework);
    match ensure_loaded(app) {
        Ok(Some(version)) => {
            base.state = "ready";
            base.version = Some(version);
            base
        }
        Ok(None) => base,
        Err(error) => {
            base.error = Some(error);
            base
        }
    }
}

#[tauri::command]
pub fn component_status(
    app: AppHandle,
    db: State<'_, Db>,
    installing: State<'_, InstallState>,
) -> ComponentStatus {
    status(&app, &db, installing.busy())
}

// ------------------------------- 组件包解析 -------------------------------

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    component: String,
    version: String,
    platform: String,
    arch: String,
    payload: String,
    #[serde(default)]
    min_app: Option<String>,
}

/// 简单的 `major.minor.patch` 比较：够用来挡「组件比 app 新」。
fn version_lt(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split(['.', '-', '+'])
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(a), parse(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    false
}

fn emit(app: &AppHandle, phase: &'static str, received: Option<u64>, total: Option<u64>, message: Option<&str>) {
    let _ = app.emit(
        "component-progress",
        Progress {
            phase,
            received,
            total,
            message: message.map(str::to_string),
        },
    );
}

fn run(command: &mut Command, what: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|e| format!("{what}失败：{e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    Err(format!("{what}失败：{detail}"))
}

/// 腾讯签名校验：只认 `TeamIdentifier`，这是「来源可信」的唯一锚点。
fn verify_tencent_signature(framework: &Path) -> Result<(), String> {
    run(
        Command::new("/usr/bin/codesign")
            .arg("--verify")
            .arg("--deep")
            .arg("--strict")
            .arg(framework),
        "校验组件签名",
    )?;
    let output = Command::new("/usr/bin/codesign")
        .arg("-dv")
        .arg("--verbose=4")
        .arg(framework)
        .output()
        .map_err(|e| format!("读取组件签名信息失败：{e}"))?;
    let text = String::from_utf8_lossy(&output.stderr);
    if !text.contains(&format!("TeamIdentifier={TENCENT_TEAM}")) {
        return Err(format!(
            "组件不是腾讯签名（期望 TeamIdentifier={TENCENT_TEAM}），已拒绝安装"
        ));
    }
    Ok(())
}

/// 解压并校验，返回清单。所有对包内容的信任都建立在这一步。
fn prepare(
    app: &AppHandle,
    archive: &Path,
    staging: &Path,
    app_version: &str,
    cancel: &AtomicBool,
) -> Result<Manifest, String> {
    emit(app, "extract", None, None, Some("正在解压组件包"));
    std::fs::create_dir_all(staging).map_err(|e| format!("创建临时目录失败：{e}"))?;
    run(
        Command::new("/usr/bin/tar")
            .arg("-xf")
            .arg(archive)
            .arg("-C")
            .arg(staging),
        "解压组件包",
    )?;
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".into());
    }

    let manifest_path = staging.join("component.json");
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|_| "组件包缺少 component.json".to_string())?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|e| format!("component.json 解析失败：{e}"))?;

    if manifest.schema != 1 {
        return Err(format!("不支持的组件包格式：schema={}", manifest.schema));
    }
    if manifest.component != COMPONENT_ID {
        return Err(format!("组件包类型不符：{}", manifest.component));
    }
    if manifest.platform != crate::db::current_platform() || manifest.arch != crate::db::current_arch() {
        return Err(format!(
            "组件包平台不符：包是 {}-{}，本机是 {}-{}",
            manifest.platform,
            manifest.arch,
            crate::db::current_platform(),
            crate::db::current_arch()
        ));
    }
    if let Some(min_app) = &manifest.min_app {
        if version_lt(app_version, min_app) {
            return Err(format!(
                "该组件要求 YX {min_app} 及以上（当前 {app_version}），请先更新应用"
            ));
        }
    }

    let payload = staging.join(&manifest.payload);
    if !payload.is_dir() {
        return Err(format!("组件包缺少 {} 目录", manifest.payload));
    }
    let dylib = payload.join(DYLIB_RELATIVE);
    if !dylib.is_file() {
        return Err(format!("组件包缺少核心库：{}", DYLIB_RELATIVE));
    }

    emit(app, "verify", None, None, Some("正在校验腾讯签名"));
    verify_tencent_signature(&payload)?;
    Ok(manifest)
}

/// 落位：先 `ditto` 到同级临时目录，再换入正式位置；失败时恢复旧组件。
fn place_framework(staged: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 Frameworks 目录失败：{e}"))?;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let parent = target.parent().ok_or("组件目标路径无效")?;
    let incoming = parent.join(format!(".TMSDK.incoming-{stamp}"));
    let backup = parent.join(format!(".TMSDK.backup-{stamp}"));

    run(
        Command::new("/usr/bin/ditto").arg(staged).arg(&incoming),
        "拷贝组件到 app 包",
    )?;

    let had_old = target.exists();
    if had_old {
        std::fs::rename(target, &backup).map_err(|e| format!("备份旧组件失败：{e}"))?;
    }
    if let Err(e) = std::fs::rename(&incoming, target) {
        let _ = std::fs::remove_dir_all(&incoming);
        if had_old {
            let _ = std::fs::rename(&backup, target);
        }
        return Err(format!("安装组件失败：{e}"));
    }
    if had_old {
        let _ = std::fs::remove_dir_all(&backup);
    }
    Ok(())
}

/// 改包必然破坏 bundle seal：重签外层 app（嵌套的腾讯签名保持不变）。
fn resign_app(contents: &Path) -> Result<(), String> {
    let app = contents.parent().ok_or("找不到 .app 目录")?;
    let entitlements = std::env::temp_dir().join(format!("YX-entitlements-{}.plist", std::process::id()));
    std::fs::write(&entitlements, ENTITLEMENTS).map_err(|e| format!("写入 entitlements 失败：{e}"))?;
    let result = run(
        Command::new("/usr/bin/codesign")
            .arg("--force")
            .arg("--sign")
            .arg("-")
            .arg("--options")
            .arg("runtime")
            .arg("--entitlements")
            .arg(&entitlements)
            .arg(app),
        "重新签名 YX.app",
    )
    .and_then(|_| {
        run(
            Command::new("/usr/bin/codesign")
                .arg("--verify")
                .arg("--deep")
                .arg("--strict")
                .arg(app),
            "校验签名",
        )
    });
    let _ = std::fs::remove_file(&entitlements);
    result
}

fn sha256(path: &Path) -> Option<String> {
    let output = Command::new("/usr/bin/shasum")
        .arg("-a")
        .arg("256")
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .map(str::to_string)
}

/// 安装一份已落盘的组件包（本地选择或刚下载的临时文件都走这里）。
fn install_archive(
    app: &AppHandle,
    db: &Db,
    archive: &Path,
    source: &str,
    source_ref: Option<String>,
    cancel: &AtomicBool,
) -> Result<ComponentStatus, String> {
    let contents = bundle_contents()?;
    let target = contents.join("Frameworks").join(FRAMEWORK);
    let cache = cache_dir(app, db);
    let staging = cache.join(format!(".staging-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);

    let app_version = app.package_info().version.to_string();
    let result = (|| -> Result<Manifest, String> {
        let manifest = prepare(app, archive, &staging, &app_version, cancel)?;
        emit(app, "install", None, None, Some("正在安装组件"));
        place_framework(&staging.join(&manifest.payload), &target)?;
        emit(app, "sign", None, None, Some("正在重新签名 YX.app"));
        resign_app(&contents)?;
        Ok(manifest)
    })();

    let manifest = match result {
        Ok(manifest) => manifest,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };

    // 安装成功后把包留档：覆盖安装 app 会把 Frameworks 换掉，缓存能离线恢复。
    let cached = cache.join(format!(
        "TMSDK-{}-{}-{}.tar.zst",
        manifest.version,
        crate::db::current_platform(),
        crate::db::current_arch()
    ));
    emit(app, "cache", None, None, Some("正在保留组件包"));
    if let Err(e) = std::fs::create_dir_all(&cache) {
        eprintln!("保留组件包失败（不影响安装）：{e}");
    } else {
        let same = std::fs::canonicalize(archive).ok() == std::fs::canonicalize(&cached).ok();
        if !same {
            if let Err(e) = std::fs::copy(archive, &cached) {
                eprintln!("保留组件包失败（不影响安装）：{e}");
            }
        }
        if !same {
            for entry in std::fs::read_dir(&cache).into_iter().flatten().flatten() {
                let path = entry.path();
                if path != cached
                    && path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("TMSDK-") && n.ends_with(".tar.zst"))
                {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }

    let _ = std::fs::remove_dir_all(&staging);

    emit(app, "load", None, None, Some("正在加载会议组件"));
    let version = ensure_loaded(app)?;

    let _ = db.save_component(&ComponentRecord {
        id: COMPONENT_ID.into(),
        version: manifest.version.clone(),
        platform: manifest.platform.clone(),
        arch: manifest.arch.clone(),
        sha256: sha256(&cached)
            .or_else(|| sha256(archive))
            .unwrap_or_default(),
        install_path: target.to_string_lossy().into_owned(),
        source: source.into(),
        source_ref,
        installed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default(),
    });

    emit(app, "done", None, None, Some("会议组件已就绪"));
    let mut status = status(app, db, false);
    status.version = version.or(status.version);
    Ok(status)
}

// ------------------------------- 命令入口 -------------------------------

#[tauri::command]
pub async fn component_install_local(
    app: AppHandle,
    db: State<'_, Db>,
    installs: State<'_, InstallState>,
    path: String,
) -> Result<ComponentStatus, String> {
    let cancel = installs.begin()?;
    let archive = PathBuf::from(&path);
    let outcome = if !archive.is_file() {
        Err(format!("组件包不存在：{path}"))
    } else {
        let db = db.inner().clone();
        let app_clone = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            install_archive(&app_clone, &db, &archive, "local", Some(path), &cancel)
        })
        .await
        .map_err(|e| format!("安装任务失败：{e}"))?
    };
    installs.finish();
    outcome
}

#[tauri::command]
pub async fn component_install_url(
    app: AppHandle,
    db: State<'_, Db>,
    installs: State<'_, InstallState>,
    url: Option<String>,
) -> Result<ComponentStatus, String> {
    let cancel = installs.begin()?;
    let target_url = match url.filter(|u| !u.trim().is_empty()) {
        Some(url) => url,
        None => db
            .effective(&app, db::COMPONENT_URL)
            .filter(|u| !u.trim().is_empty())
            .ok_or("还没有配置组件下载地址")?,
    };
    let cache = cache_dir(&app, &db);
    let outcome = (|| async {
        std::fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败：{e}"))?;
        let part = cache.join(format!(".download-{}.part", std::process::id()));
        let (app2, url2, part2, cancel2) = (
            app.clone(),
            target_url.clone(),
            part.clone(),
            cancel.clone(),
        );
        let download = tauri::async_runtime::spawn_blocking(move || {
            download(&url2, &part2, &cancel2, &|received, total| {
                emit(&app2, "download", Some(received), total, None)
            })
        });
        let archive = download.await.map_err(|e| format!("下载任务失败：{e}"))??;
        let download_path = archive.clone();
        let db = db.inner().clone();
        let app3 = app.clone();
        let cancel3 = cancel.clone();
        let install = tauri::async_runtime::spawn_blocking(move || {
            install_archive(
                &app3,
                &db,
                &archive,
                "url",
                Some(target_url),
                &cancel3,
            )
        })
        .await
        .map_err(|e| format!("安装任务失败：{e}"))??;
        let _ = std::fs::remove_file(&download_path);
        Ok::<ComponentStatus, String>(install)
    })()
    .await;
    installs.finish();
    outcome
}

/// 下载到缓存目录的临时文件；返回临时文件路径。
///
/// 进度通过回调上抛（而不是直接 emit），这样这段逻辑能脱离 `AppHandle` 测试。
fn download(
    url: &str,
    target: &Path,
    cancel: &AtomicBool,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Result<PathBuf, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(None)
        .build()
        .map_err(|e| format!("初始化下载失败：{e}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("下载组件失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载组件失败：HTTP {}", response.status().as_u16()));
    }
    let total = response.content_length();
    let mut file = std::fs::File::create(target).map_err(|e| format!("创建临时文件失败：{e}"))?;
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    on_progress(0, total);
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(target);
            return Err("已取消".into());
        }
        use std::io::Read;
        let n = response
            .read(&mut buffer)
            .map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        use std::io::Write;
        file.write_all(&buffer[..n])
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        received += n as u64;
        if received - last_emit >= 1024 * 1024 {
            last_emit = received;
            on_progress(received, total);
        }
    }
    if received == 0 {
        let _ = std::fs::remove_file(target);
        return Err("下载到的组件包为空".into());
    }
    on_progress(received, total);
    Ok(target.to_path_buf())
}

#[tauri::command]
pub fn component_cancel(installs: State<'_, InstallState>) {
    if let Ok(slot) = installs.running.lock() {
        if let Some(flag) = slot.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// 清掉组件包缓存（安装到 app 内的框架不动）。
#[tauri::command]
pub fn component_clear_cache(app: AppHandle, db: State<'_, Db>) -> Result<u64, String> {
    let dir = cache_dir(&app, &db);
    let before = dir_bytes(&dir);
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    let after = dir_bytes(&dir);
    Ok(before.saturating_sub(after))
}

/// 启动时的静默回装：覆盖安装 app 会换掉 `Contents/Frameworks`，但组件包缓存还在，
/// 于是本地重装一次（约 2–4 秒），不必再下 118 MB。
pub fn restore_from_cache(app: &AppHandle) {
    if !cfg!(target_os = "macos") || dylib_path().map(|p| p.exists()).unwrap_or(false) {
        return;
    }
    let db = app.state::<Db>().inner().clone();
    let Some(archive) = cached_archive(app, &db) else {
        return;
    };
    eprintln!("检测到组件缓存，正在本地回装：{}", archive.display());
    let cancel = AtomicBool::new(false);
    match install_archive(
        app,
        &db,
        &archive,
        "cache",
        Some(archive.to_string_lossy().into_owned()),
        &cancel,
    ) {
        Ok(status) => eprintln!("组件回装完成：{:?}", status.version),
        Err(e) => eprintln!("组件回装失败（会议暂不可用）：{e}"),
    }
}

/// 重新加载已安装的组件（例如用户手工替换后）。
#[tauri::command]
pub fn component_reload(app: AppHandle, db: State<'_, Db>) -> Result<ComponentStatus, String> {
    ensure_loaded(&app)?;
    Ok(status(&app, &db, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// 极简 HTTP 服务端：只回一个固定 body（或 404），够验证下载循环。
    fn serve(body: &'static [u8], status: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/TMSDK.tar.zst")
    }

    #[test]
    fn downloads_body_and_reports_progress() {
        let url = serve(b"fake-component", "200 OK");
        let dir = std::env::temp_dir().join(format!("yx-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("component.tar.zst");
        let seen = Mutex::new(Vec::new());
        let path = download(&url, &target, &AtomicBool::new(false), &|received, total| {
            seen.lock().unwrap().push((received, total));
        })
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"fake-component");
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.first().copied(), Some((0, Some(14))));
        assert_eq!(seen.last().copied(), Some((14, Some(14))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_http_error() {
        let url = serve(b"missing", "404 Not Found");
        let target = std::env::temp_dir().join(format!("yx-dl-404-{}.part", std::process::id()));
        let error = download(&url, &target, &AtomicBool::new(false), &|_, _| {}).unwrap_err();
        assert!(error.contains("404"), "unexpected error: {error}");
        assert!(!target.exists(), "失败的下载不该留下临时文件");
    }

    #[test]
    fn version_compare_handles_patch_levels() {
        assert!(version_lt("0.1.26", "0.1.27"));
        assert!(version_lt("0.1.9", "0.1.10"));
        assert!(!version_lt("0.1.27", "0.1.27"));
        assert!(!version_lt("0.2.0", "0.1.27"));
    }
}
