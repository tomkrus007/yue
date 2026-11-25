//! 会议组件（`TMSDK.framework`）的安装、校验与加载。
//!
//! 组件包是一份 `TMSDK-<ver>-<platform>-<arch>.tar.zst`，本地文件与网络下载共用同一份：
//! 解压 → 校验 → 落位 → 重签 → dlopen。为什么必须装回 `Contents/Frameworks`、
//! 为什么缺组件也要能启动，见 `doc/TMSDK组件化与跨平台设计.md`。

use std::ffi::{c_char, CStr, CString};
use std::io::{Read, Write};
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

/// 解压 `tar.zst`。
///
/// 不能用 `/usr/bin/tar -xf`：macOS 的 bsdtar 没有链接 libzstd，遇到 zstd 会去 `PATH`
/// 里找外部 `zstd` 命令。app 从 Finder/launchd 启动时 `PATH` 只有
/// `/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew 装的 zstd 根本不在里面，
/// 于是报「Can't initialize filter; unable to run program "zstd -d -qq"」。
/// 解码内置在二进制里，才不依赖用户装没装 zstd。
fn extract(archive: &Path, staging: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("打开组件包失败：{e}"))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|e| format!("组件包不是有效的 zstd 压缩包：{e}"))?;
    let mut tarball = tar::Archive::new(decoder);
    // 与 `tar -xf` 一致：保留包内权限位（框架里有些可执行文件靠它）。
    tarball.set_preserve_permissions(true);
    let entries = tarball
        .entries()
        .map_err(|e| format!("解压组件包失败：{e}"))?;
    for entry in entries {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let mut entry = entry.map_err(|e| format!("解压组件包失败：{e}"))?;
        let path = entry
            .path()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        if !entry
            .unpack_in(staging)
            .map_err(|e| format!("解压组件包失败：{e}"))?
        {
            return Err(format!("组件包内含越权路径：{path}"));
        }
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
    extract(archive, staging, cancel)?;
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
        // 上次没下完的半截包接着用：118 MB 重下太贵
        adopt_legacy_part(&cache);
        let part = part_path(&cache);
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
        .map_err(|e| format!("安装任务失败：{e}"))?;
        match install {
            Ok(status) => {
                discard_part(&part);
                Ok(status)
            }
            Err(e) => {
                // 解压失败说明这份包本身坏了，留着只会让下次照样失败；
                // 取消、签名不符、落位失败等情况包还是好的，留着省一次 118 MB。
                if archive_broken(&e) {
                    discard_part(&part);
                }
                Err(e)
            }
        }
    })()
    .await;
    installs.finish();
    outcome
}

/// reqwest 的 `Display` 只给「error sending request」，真正原因在 source 链里。
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(err) = source {
        let detail = err.to_string();
        if !text.contains(&detail) {
            text.push_str("：");
            text.push_str(&detail);
        }
        source = err.source();
    }
    text
}

// ------------------------------- 组件包下载 -------------------------------

/// 半截包在缓存目录里的固定名字：程序重启（pid 变了）也能接着续。
fn part_path(dir: &Path) -> PathBuf {
    dir.join(".download.part")
}

/// 半截包的来源信息放在同名 `.json` 里：换了下载地址（通常就是换版本）就不再续传。
fn part_meta_path(part: &Path) -> PathBuf {
    let mut name = part.file_name().unwrap_or_default().to_os_string();
    name.push(".json");
    part.with_file_name(name)
}

#[derive(Serialize, Deserialize)]
struct PartMeta {
    url: String,
    /// 服务器声明的总字节数
    total: Option<u64>,
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn discard_part(part: &Path) {
    let _ = std::fs::remove_file(part);
    let _ = std::fs::remove_file(part_meta_path(part));
}

/// 把老版本残留的 `.download-<pid>.part` 认领成固定名字，别让已经下好的字节白扔。
fn adopt_legacy_part(dir: &Path) {
    let part = part_path(dir);
    if part.exists() {
        return;
    }
    let legacy = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(".download-") && n.ends_with(".part"))
        })
        .max_by_key(|path| std::fs::metadata(path).and_then(|m| m.modified()).ok());
    if let Some(legacy) = legacy {
        let _ = std::fs::rename(legacy, part);
    }
}

/// 解压阶段的错误说明这份包本身不可用（zstd 校验失败或多份包拼在一起），重下才有意义。
fn archive_broken(message: &str) -> bool {
    message.starts_with("解压组件包失败") || message.starts_with("组件包不是有效的 zstd 压缩包")
}

/// 下载到缓存目录的临时文件；返回临时文件路径。
///
/// 半截包不再丢掉：缓存里已有的字节数就是续传起点（118 MB 重下太贵），
/// 用 `Range` 接着拉；中途断了还会自动再续几轮。
/// 进度通过回调上抛（而不是直接 emit），这样这段逻辑能脱离 `AppHandle` 测试。
fn download(
    url: &str,
    target: &Path,
    cancel: &AtomicBool,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Result<PathBuf, String> {
    match fetch_to(url, target, cancel, on_progress) {
        Ok(()) => Ok(target.to_path_buf()),
        Err(e) => {
            // 空文件没有续传价值，留着只会让下次白试一次
            if file_len(target) == 0 {
                discard_part(target);
            }
            Err(e)
        }
    }
}

/// 发请求并重试：GitHub 的 TLS 连接在国内网络下常被中途掐断（约两成概率），
/// 而失败发生在握手阶段，重试是唯一有效的处理方式。
fn send_with_retry(
    client: &reqwest::blocking::Client,
    url: &str,
    offset: u64,
    cancel: &AtomicBool,
) -> Result<reqwest::blocking::Response, String> {
    const ATTEMPTS: u32 = 3;
    let mut last = String::new();
    for attempt in 0..ATTEMPTS {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let mut request = client.get(url);
        if offset > 0 {
            // 续传：只要 offset 之后的字节
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        match request.send() {
            Ok(response) => return Ok(response),
            Err(e) => {
                last = error_chain(&e);
                if attempt + 1 < ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(
                        700 * u64::from(attempt + 1),
                    ));
                }
            }
        }
    }
    Err(format!("下载组件失败（已重试 {ATTEMPTS} 次）：{last}"))
}

/// 单次续传尝试的结果。
enum Fetch {
    /// 拿全了，附最终总长度
    Done(u64),
    /// 失败；`reset` 表示本地半截包与服务器对不上，丢掉后从头来
    Failed { message: String, reset: bool },
}

/// 解析 `Content-Range: bytes 100-199/200`（416 时是 `bytes */200`）。
fn parse_content_range(value: &str) -> Option<(Option<u64>, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let total = total.trim().parse::<u64>().ok();
    let start = range
        .split_once('-')
        .and_then(|(start, _)| start.trim().parse::<u64>().ok());
    Some((start, total))
}

/// 从 `offset` 之后接着拉一次。
fn fetch_range(
    client: &reqwest::blocking::Client,
    url: &str,
    target: &Path,
    offset: u64,
    cancel: &AtomicBool,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Fetch {
    let response = match send_with_retry(client, url, offset, cancel) {
        Ok(response) => response,
        Err(message) => {
            return Fetch::Failed {
                message,
                reset: false,
            };
        }
    };
    let status = response.status();
    let content_range = || {
        response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_content_range)
    };
    if status.as_u16() == 206 {
        let (start, declared) = content_range().unwrap_or((None, None));
        if start != Some(offset) {
            return Fetch::Failed {
                message: format!(
                    "服务器的分段响应与本地半截包不匹配（start={start:?}，本地 {offset} 字节）"
                ),
                reset: true,
            };
        }
        let file = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(target)
        {
            Ok(file) => file,
            Err(e) => {
                return Fetch::Failed {
                    message: format!("打开临时文件失败：{e}"),
                    reset: false,
                };
            }
        };
        on_progress(offset, declared);
        return copy_body(response, file, offset, declared, cancel, on_progress);
    }
    if status.is_success() {
        // 服务器没按 Range 回（或本来就没有半截包）：整包从头写
        let total = response.content_length();
        let file = match std::fs::File::create(target) {
            Ok(file) => file,
            Err(e) => {
                return Fetch::Failed {
                    message: format!("创建临时文件失败：{e}"),
                    reset: false,
                };
            }
        };
        on_progress(0, total);
        return copy_body(response, file, 0, total, cancel, on_progress);
    }
    if status.as_u16() == 416 {
        let declared = content_range().and_then(|(_, total)| total);
        if declared == Some(offset) && offset > 0 {
            // 本地这份已经是完整的：一个字节都不用再下
            on_progress(offset, declared);
            return Fetch::Done(offset);
        }
        return Fetch::Failed {
            message: format!(
                "服务器上的组件包与本地半截包不一致（本地 {offset} 字节，服务器 {declared:?}）"
            ),
            reset: true,
        };
    }
    Fetch::Failed {
        message: format!("下载组件失败：HTTP {}", status.as_u16()),
        reset: false,
    }
}

fn copy_body(
    mut response: reqwest::blocking::Response,
    mut file: std::fs::File,
    offset: u64,
    total: Option<u64>,
    cancel: &AtomicBool,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Fetch {
    let mut received = offset;
    let mut last_emit = received;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Fetch::Failed {
                message: "已取消".into(),
                reset: false,
            };
        }
        let n = match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                // 已经写进文件的字节留着：外层会从新的长度继续续传
                return Fetch::Failed {
                    message: format!("下载中断：{}", error_chain(&e)),
                    reset: false,
                };
            }
        };
        if let Err(e) = file.write_all(&buffer[..n]) {
            return Fetch::Failed {
                message: format!("写入临时文件失败：{e}"),
                reset: false,
            };
        }
        received += n as u64;
        if received - last_emit >= 1024 * 1024 {
            last_emit = received;
            on_progress(received, total);
        }
    }
    if received == 0 {
        return Fetch::Failed {
            message: "下载到的组件包为空".into(),
            reset: true,
        };
    }
    if let Some(total) = total {
        if received != total {
            return Fetch::Failed {
                message: format!("下载不完整：{received}/{total} 字节"),
                reset: received > total,
            };
        }
    }
    on_progress(received, total);
    Fetch::Done(received)
}

fn fetch_to(
    url: &str,
    target: &Path,
    cancel: &AtomicBool,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(None)
        .build()
        .map_err(|e| format!("初始化下载失败：{}", error_chain(&e)))?;

    let meta_path = part_meta_path(target);
    let stored: Option<PartMeta> = std::fs::read(&meta_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    if stored.as_ref().is_some_and(|meta| meta.url != url) {
        // 换了下载地址（通常是换版本）：旧半截包不能拼进新包
        let _ = std::fs::remove_file(target);
    }

    const ROUNDS: u32 = 3;
    let mut last = String::new();
    for round in 0..ROUNDS {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let before = file_len(target);
        match fetch_range(&client, url, target, before, cancel, on_progress) {
            Fetch::Done(total) => {
                if let Ok(bytes) = serde_json::to_vec(&PartMeta {
                    url: url.to_string(),
                    total: Some(total),
                }) {
                    let _ = std::fs::write(&meta_path, bytes);
                }
                return Ok(());
            }
            Fetch::Failed { message, reset } => {
                last = message;
                if reset {
                    let _ = std::fs::remove_file(target);
                    continue;
                }
                if file_len(target) <= before {
                    break; // 一字节没多，重试也是白试
                }
            }
        }
        if round + 1 < ROUNDS {
            std::thread::sleep(Duration::from_millis(700 * u64::from(round + 1)));
        }
    }
    Err(last)
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

    /// 真实 Release 地址的连通性检查（118 MiB，手动跑一次）：
    /// `cargo test -- --ignored real_release`
    #[test]
    #[ignore = "需要网络：从 GitHub Release 下载 118 MiB"]
    fn real_release_url_serves_zstd_archive() {
        let url = crate::db::default_component_url().expect("components.json 缺本平台默认地址");
        let dir = std::env::temp_dir().join(format!("yx-real-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("release.tar.zst");
        download(&url, &target, &AtomicBool::new(false), &|_, _| {}).unwrap();
        let bytes = std::fs::read(&target).unwrap();
        assert!(
            bytes.len() > 100 * 1024 * 1024,
            "包太小（{} 字节），可能被重定向到了错误页面",
            bytes.len()
        );
        assert_eq!(&bytes[..4], &[0x28, 0xB5, 0x2F, 0xFD], "不是 zstd 文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 极简 HTTP 服务端：认 `Range`（206/416），同时记录每次请求的 Range 头。
    fn serve_ranges(body: &'static [u8]) -> (String, Arc<Mutex<Vec<Option<String>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buffer = [0u8; 8192];
                let n = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..n]).to_string();
                let range = request.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("range")
                        .then(|| value.trim().to_string())
                });
                recorder.lock().unwrap().push(range.clone());
                let start = range
                    .as_deref()
                    .and_then(|value| value.strip_prefix("bytes="))
                    .and_then(|value| value.trim_end_matches('-').parse::<u64>().ok())
                    .unwrap_or(0);
                let total = body.len() as u64;
                if start > 0 && start >= total {
                    let head = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(head.as_bytes());
                    continue;
                }
                let rest = &body[start as usize..];
                let head = if start > 0 {
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        total - 1,
                        rest.len()
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        rest.len()
                    )
                };
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(rest);
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}/TMSDK.tar.zst"), seen)
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 半截包要接着下，不能把已有的 6 字节扔掉重来。
    #[test]
    fn resumes_partial_download_with_range() {
        let (url, seen) = serve_ranges(b"0123456789abcdef");
        let dir = temp_dir("resume");
        let target = part_path(&dir);
        std::fs::write(&target, &b"012345"[..]).unwrap();
        let progress = Mutex::new(Vec::new());
        download(&url, &target, &AtomicBool::new(false), &|received, total| {
            progress.lock().unwrap().push((received, total));
        })
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"0123456789abcdef");
        assert_eq!(
            seen.lock().unwrap().first().and_then(|r| r.as_deref()),
            Some("bytes=6-")
        );
        assert_eq!(
            progress.into_inner().unwrap().first().copied(),
            Some((6, Some(16)))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 服务器不认 Range 时只能从头写，不能把整包拼在半截包后面。
    #[test]
    fn restarts_when_server_ignores_range() {
        let url = serve(b"0123456789abcdef", "200 OK");
        let dir = temp_dir("no-range");
        let target = part_path(&dir);
        std::fs::write(&target, &b"012345"[..]).unwrap();
        download(&url, &target, &AtomicBool::new(false), &|_, _| {}).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"0123456789abcdef");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 上次其实已经下完（只是解压失败）：416 应被当成「已经完整」，一个字节都不再拉。
    #[test]
    fn reuses_complete_part_when_server_says_416() {
        let (url, _seen) = serve_ranges(b"0123456789abcdef");
        let dir = temp_dir("complete");
        let target = part_path(&dir);
        std::fs::write(&target, b"0123456789abcdef").unwrap();
        let progress = Mutex::new(Vec::new());
        download(&url, &target, &AtomicBool::new(false), &|received, total| {
            progress.lock().unwrap().push((received, total));
        })
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"0123456789abcdef");
        assert_eq!(
            progress.into_inner().unwrap().last().copied(),
            Some((16, Some(16)))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 换了下载地址（换版本）就不能续传旧半截包。
    #[test]
    fn ignores_part_downloaded_from_another_url() {
        let (url, seen) = serve_ranges(b"new");
        let dir = temp_dir("other-url");
        let target = part_path(&dir);
        std::fs::write(&target, b"oldextra").unwrap();
        std::fs::write(
            part_meta_path(&target),
            br#"{"url":"https://example.com/old.tar.zst","total":8}"#,
        )
        .unwrap();
        download(&url, &target, &AtomicBool::new(false), &|_, _| {}).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert!(
            seen.lock().unwrap().first().is_some_and(Option::is_none),
            "旧地址的半截包不该发 Range 续传"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 老版本残留的 `.download-<pid>.part` 要认领过来继续用。
    #[test]
    fn adopts_legacy_part_file_name() {
        let dir = temp_dir("legacy");
        let legacy = dir.join(".download-21951.part");
        std::fs::write(&legacy, b"half").unwrap();
        adopt_legacy_part(&dir);
        assert!(part_path(&dir).is_file());
        assert!(!legacy.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 组件包是 tar.zst：解码必须内置，不能依赖系统是否装了 `zstd` 命令。
    #[test]
    fn extracts_tar_zst_without_external_zstd() {
        let dir = std::env::temp_dir().join(format!("yx-extract-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let archive = dir.join("TMSDK-test-macos-arm64.tar.zst");
        {
            let encoder =
                zstd::stream::write::Encoder::new(std::fs::File::create(&archive).unwrap(), 3)
                    .unwrap();
            let mut builder = tar::Builder::new(encoder);
            let body = br#"{"schema":1}"#;
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "component.json", &body[..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let staging = dir.join("staging");
        std::fs::create_dir_all(&staging).unwrap();
        extract(&archive, &staging, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            std::fs::read(staging.join("component.json")).unwrap(),
            br#"{"schema":1}"#
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 包内出现 `..` 路径必须整体失败，不能写到暂存目录外面。
    #[test]
    fn rejects_archive_entry_escaping_staging() {
        let dir = std::env::temp_dir().join(format!("yx-extract-escape-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let archive = dir.join("evil.tar.zst");
        {
            let encoder =
                zstd::stream::write::Encoder::new(std::fs::File::create(&archive).unwrap(), 3)
                    .unwrap();
            let mut builder = tar::Builder::new(encoder);
            let body = b"pwned";
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            // Builder 的 append_data 会拒绝 `..`，只能直接写进 header 名来造恶意包。
            let name = b"../escaped.txt";
            header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
            header.set_cksum();
            builder.append(&header, &body[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let staging = dir.join("staging");
        std::fs::create_dir_all(&staging).unwrap();
        let error = extract(&archive, &staging, &AtomicBool::new(false)).unwrap_err();
        assert!(error.contains("越权"), "unexpected error: {error}");
        assert!(!dir.join("escaped.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_compare_handles_patch_levels() {
        assert!(version_lt("0.1.26", "0.1.27"));
        assert!(version_lt("0.1.9", "0.1.10"));
        assert!(!version_lt("0.1.27", "0.1.27"));
        assert!(!version_lt("0.2.0", "0.1.27"));
    }
}

