//! 本地配置库（SQLite）。
//!
//! 为什么用 SQLite：需要原子写、并发读、可迁移；数据库放在系统应用数据目录，
//! 不随 `.app` 更新或覆盖安装而丢失。前端不直接执行 SQL，一律经 `settings_*` /
//! `component_*` 命令，避免 WebView 拿到任意 SQL 执行能力。

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// 可配置项。`settings_set` 只接受这些 key，避免把库写成任意键值堆。
pub const COMPONENT_URL: &str = "component.url";
pub const COMPONENT_CACHE_DIR: &str = "component.cache_dir";
pub const DOWNLOAD_DIR: &str = "paths.download_dir";
pub const SPOOL_DIR: &str = "paths.spool_dir";
pub const FFMPEG_PATH: &str = "paths.ffmpeg";
pub const MESSAGE_SOUND: &str = "ui.message_sound";

const KNOWN_KEYS: [&str; 6] = [
    COMPONENT_URL,
    COMPONENT_CACHE_DIR,
    DOWNLOAD_DIR,
    SPOOL_DIR,
    FFMPEG_PATH,
    MESSAGE_SOUND,
];

/// 数据库位置：系统应用数据目录，不在 `.app` 包内。
///
/// 这个路径是唯一保留在代码里的路径常量（库自己不能存在库里），且用平台 API 计算：
/// macOS `~/Library/Application Support/com.tom.YX/yx.db`，Windows `%APPDATA%\com.tom.YX\yx.db`。
fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败：{e}"))?;
    Ok(dir.join("yx.db"))
}

pub struct Db {
    conn: Mutex<Connection>,
}

/// 已安装组件的记录（同一时刻只应有一条 `id = "tmsdk"`）。
#[derive(Clone, Serialize)]
pub struct ComponentRecord {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub sha256: String,
    pub install_path: String,
    pub source: String,
    pub source_ref: Option<String>,
    pub installed_at: i64,
}

impl Db {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let path = database_path(app)?;
        let conn = Connection::open(&path).map_err(|e| format!("打开配置库失败：{e}"))?;
        // WAL：读写不互相阻塞；库文件旁会多出 -wal/-shm，备份时一起拷。
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("初始化配置库失败：{e}"))?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten()
    }

    pub fn set(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        if !KNOWN_KEYS.contains(&key) {
            return Err(format!("未知配置项：{key}"));
        }
        let conn = self.conn.lock().map_err(|_| "配置库不可用")?;
        match value.map(str::trim).filter(|v| !v.is_empty()) {
            Some(value) => conn
                .execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    params![key, value, now()],
                )
                .map(|_| ())
                .map_err(|e| format!("写入配置失败：{e}")),
            // 传空 = 恢复平台默认（删掉覆盖值）
            None => conn
                .execute("DELETE FROM settings WHERE key = ?1", params![key])
                .map(|_| ())
                .map_err(|e| format!("重置配置失败：{e}")),
        }
    }

    /// 生效值 = 用户覆盖值 ?? 平台默认值。
    ///
    /// 平台默认由 Rust 按当前系统 API 计算，**不进库**——否则升级后默认路径会被
    /// 历史数据钉死（例如 macOS 改下载目录规则、Windows 换了 AppData 位置）。
    pub fn effective(&self, app: &AppHandle, key: &str) -> Option<String> {
        self.get(key).or_else(|| platform_default(app, key))
    }

    pub fn effective_path(&self, app: &AppHandle, key: &str) -> Option<PathBuf> {
        self.effective(app, key).map(PathBuf::from)
    }

    pub fn component(&self) -> Option<ComponentRecord> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT id, version, platform, arch, sha256, install_path, source, source_ref, installed_at
             FROM components WHERE id = 'tmsdk'",
            [],
            |row| {
                Ok(ComponentRecord {
                    id: row.get(0)?,
                    version: row.get(1)?,
                    platform: row.get(2)?,
                    arch: row.get(3)?,
                    sha256: row.get(4)?,
                    install_path: row.get(5)?,
                    source: row.get(6)?,
                    source_ref: row.get(7)?,
                    installed_at: row.get(8)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn save_component(&self, record: &ComponentRecord) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "配置库不可用")?;
        conn.execute(
            "INSERT INTO components (id, version, platform, arch, sha256, install_path, source, source_ref, installed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               version = excluded.version, platform = excluded.platform, arch = excluded.arch,
               sha256 = excluded.sha256, install_path = excluded.install_path,
               source = excluded.source, source_ref = excluded.source_ref, installed_at = excluded.installed_at",
            params![
                record.id,
                record.version,
                record.platform,
                record.arch,
                record.sha256,
                record.install_path,
                record.source,
                record.source_ref,
                record.installed_at
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("记录组件信息失败：{e}"))
    }

    pub fn clear_component(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "配置库不可用")?;
        conn.execute("DELETE FROM components WHERE id = 'tmsdk'", [])
            .map(|_| ())
            .map_err(|e| format!("清除组件记录失败：{e}"))
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// 按 `user_version` 顺序迁移；每一步在自己的事务里完成并写版本号。
fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("读取配置库版本失败：{e}"))?;
    if version >= 1 {
        return Ok(());
    }
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS settings (
           key        TEXT PRIMARY KEY,
           value      TEXT,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS components (
           id           TEXT PRIMARY KEY,
           version      TEXT NOT NULL,
           platform     TEXT NOT NULL,
           arch         TEXT NOT NULL,
           sha256       TEXT NOT NULL,
           install_path TEXT NOT NULL,
           source       TEXT NOT NULL,
           source_ref   TEXT,
           installed_at INTEGER NOT NULL
         );
         PRAGMA user_version = 1;
         COMMIT;",
    )
    .map_err(|e| format!("迁移配置库失败：{e}"))
}

/// 平台默认值。Windows/Linux 走各自的目录 API，不写死路径。
fn platform_default(app: &AppHandle, key: &str) -> Option<String> {
    let cached = || app.path().app_cache_dir().ok();
    Some(match key {
        COMPONENT_CACHE_DIR => cached()?.join("components").to_string_lossy().into_owned(),
        SPOOL_DIR => cached()?.join("upload").to_string_lossy().into_owned(),
        DOWNLOAD_DIR => app
            .path()
            .download_dir()
            .ok()?
            .join("YX")
            .to_string_lossy()
            .into_owned(),
        MESSAGE_SOUND => "1".to_string(),
        // 组件地址由 components.json 提供默认值（见 component.rs）；这里不给兜底，
        // 免得两处默认值打架。
        _ => return None,
    })
}

/// 一条配置的三种视角：库里存了什么、平台默认是什么、实际生效什么。
#[derive(Serialize)]
pub struct SettingView {
    pub key: &'static str,
    pub value: Option<String>,
    pub default: Option<String>,
    pub effective: Option<String>,
}

#[tauri::command]
pub fn settings_get_all(app: AppHandle, db: State<'_, Db>) -> Result<Vec<SettingView>, String> {
    Ok(KNOWN_KEYS
        .iter()
        .map(|key| {
            let value = db.get(key);
            let default = platform_default(&app, key);
            SettingView {
                key,
                effective: value.clone().or_else(|| default.clone()),
                value,
                default,
            }
        })
        .collect())
}

/// 写入或清除（`value = null` / 空串）一个配置项。
#[tauri::command]
pub fn settings_set(db: State<'_, Db>, key: String, value: Option<String>) -> Result<(), String> {
    db.set(&key, value.as_deref())
}
