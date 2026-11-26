//! IM 本地缓存（SQLite）。
//!
//! 设计要点见 `doc/IM本地持久化SQLite设计.md`：
//! - 消息按 `(account_id, msg_id)` 单条 upsert，正文整体存 JSON；
//! - 未读、交互、回执等小状态走 `im_state`，按 key 单条读写；
//! - 所有命令都在 `spawn_blocking` 里执行，避免阻塞主线程。

use rusqlite::{params, params_from_iter, types::Value, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub msg_id: String,
    pub session_id: String,
    pub session_type: i64,
    pub send_time: i64,
    pub msg_type: i64,
    pub from_id: String,
    pub is_read: Option<i64>,
    pub body: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEntry {
    pub key: String,
    pub value: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn upsert_messages(db: &Db, account_id: &str, rows: &[MessageRow]) -> Result<usize, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let mut conn = db.lock()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开始消息事务失败：{e}"))?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO im_messages
                   (account_id, msg_id, session_id, session_type, send_time, msg_type, from_id, is_read, body, search_text, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(account_id, msg_id) DO UPDATE SET
                   session_id = excluded.session_id,
                   session_type = excluded.session_type,
                   send_time = excluded.send_time,
                   msg_type = excluded.msg_type,
                   from_id = excluded.from_id,
                   is_read = excluded.is_read,
                   body = excluded.body,
                   search_text = excluded.search_text,
                   updated_at = excluded.updated_at",
            )
            .map_err(|e| format!("准备消息写入失败：{e}"))?;
        let updated_at = now_ms();
        for row in rows {
            stmt.execute(params![
                account_id,
                row.msg_id,
                row.session_id,
                row.session_type,
                row.send_time,
                row.msg_type,
                row.from_id,
                row.is_read,
                row.body,
                build_search_text(row.msg_type, &row.body),
                updated_at
            ])
            .map_err(|e| format!("写入消息失败：{e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("提交消息事务失败：{e}"))?;
    Ok(rows.len())
}

fn collect_bodies(
    db: &Db,
    sql: &str,
    args: Vec<Value>,
) -> Result<Vec<String>, String> {
    let conn = db.lock()?;
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("准备消息查询失败：{e}"))?;
    let rows = stmt
        .query_map(params_from_iter(args), |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询消息失败：{e}"))?;
    let mut list = Vec::new();
    for row in rows {
        list.push(row.map_err(|e| format!("读取消息失败：{e}"))?);
    }
    Ok(list)
}

fn recent_messages(db: &Db, account_id: &str, limit: i64) -> Result<Vec<String>, String> {
    let mut list = collect_bodies(
        db,
        "SELECT body FROM im_messages
         WHERE account_id = ?1
         ORDER BY send_time DESC, msg_id DESC
         LIMIT ?2",
        vec![Value::Text(account_id.to_string()), Value::Integer(limit)],
    )?;
    list.reverse();
    Ok(list)
}

fn session_messages(
    db: &Db,
    account_id: &str,
    session_id: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut list = collect_bodies(
        db,
        "SELECT body FROM im_messages
         WHERE account_id = ?1 AND session_id = ?2
         ORDER BY send_time DESC, msg_id DESC
         LIMIT ?3",
        vec![
            Value::Text(account_id.to_string()),
            Value::Text(session_id.to_string()),
            Value::Integer(limit),
        ],
    )?;
    list.reverse();
    Ok(list)
}

fn messages_around(
    db: &Db,
    account_id: &str,
    session_id: &str,
    msg_id: &str,
    before: i64,
    after: i64,
) -> Result<Vec<String>, String> {
    let target: Option<(i64,)> = {
        let conn = db.lock()?;
        conn.query_row(
            "SELECT send_time FROM im_messages WHERE account_id = ?1 AND session_id = ?2 AND msg_id = ?3",
            params![account_id, session_id, msg_id],
            |row| Ok((row.get(0)?,)),
        )
        .optional()
        .map_err(|e| format!("查询目标消息失败：{e}"))?
    };
    let Some((time,)) = target else {
        return Ok(Vec::new());
    };
    let mut older = collect_bodies(
        db,
        "SELECT body FROM im_messages
         WHERE account_id = ?1 AND session_id = ?2
           AND (send_time < ?3 OR (send_time = ?3 AND msg_id <= ?4))
         ORDER BY send_time DESC, msg_id DESC
         LIMIT ?5",
        vec![
            Value::Text(account_id.to_string()),
            Value::Text(session_id.to_string()),
            Value::Integer(time),
            Value::Text(msg_id.to_string()),
            Value::Integer(before),
        ],
    )?;
    older.reverse();
    let newer = collect_bodies(
        db,
        "SELECT body FROM im_messages
         WHERE account_id = ?1 AND session_id = ?2
           AND (send_time > ?3 OR (send_time = ?3 AND msg_id > ?4))
         ORDER BY send_time ASC, msg_id ASC
         LIMIT ?5",
        vec![
            Value::Text(account_id.to_string()),
            Value::Text(session_id.to_string()),
            Value::Integer(time),
            Value::Text(msg_id.to_string()),
            Value::Integer(after),
        ],
    )?;
    older.extend(newer);
    Ok(older)
}

fn get_message(db: &Db, account_id: &str, msg_id: &str) -> Result<Option<String>, String> {
    let conn = db.lock()?;
    conn.query_row(
        "SELECT body FROM im_messages WHERE account_id = ?1 AND msg_id = ?2",
        params![account_id, msg_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("查询消息失败：{e}"))
}

fn delete_messages(db: &Db, account_id: &str, ids: &[String]) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut conn = db.lock()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开始消息事务失败：{e}"))?;
    let mut removed = 0usize;
    for chunk in ids.chunks(500) {
        let placeholders = std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM im_messages WHERE account_id = ? AND msg_id IN ({placeholders})"
        );
        let mut args: Vec<Value> = vec![Value::Text(account_id.to_string())];
        args.extend(chunk.iter().map(|id| Value::Text(id.clone())));
        removed += tx
            .execute(&sql, params_from_iter(args))
            .map_err(|e| format!("删除消息失败：{e}"))?;
    }
    tx.commit().map_err(|e| format!("提交消息事务失败：{e}"))?;
    Ok(removed)
}

/* ---------------- 全文检索 ---------------- */

/// 与前端 `messageText()` 对齐的索引文本抽取。
///
/// 只保留用户可能搜索的内容：正文、文件名、卡片标题、合并转发明细和发送人。
/// 撤回/焚毁时前端会把 `content` 改成空串再 upsert，索引随之清空。
pub(crate) fn build_search_text(msg_type: i64, body: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return String::new();
    };
    let mut parts = Vec::new();
    if let Some(content) = value.get("content") {
        collect_text(msg_type, content, &mut parts, 0);
    }
    // 发送人/会话名也进索引：搜「张三」能列出他发过的消息。
    for key in ["from_name", "to_name"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            push_text(&mut parts, text, false);
        }
    }
    parts.join(" ")
}

fn collect_text(
    msg_type: i64,
    content: &serde_json::Value,
    out: &mut Vec<String>,
    depth: usize,
) {
    if depth > 3 {
        return;
    }
    // 文件、卡片等类型的 content 常是 JSON 字符串，先解开再按字段抽取。
    if let Some(text) = content.as_str() {
        if !matches!(msg_type, 1 | 2 | 3 | 4 | 5 | 6 | 10 | 11 | 12 | 14 | 15 | 19 | 21 | 23 | 25 | 28 | 30 | 31) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) {
                if parsed.is_object() || parsed.is_array() {
                    collect_text(msg_type, &parsed, out, depth);
                    return;
                }
            }
        }
        // 富文本里的文本块是 HTML；普通文本保持字面内容，避免误删 `<`。
        push_text(out, text, msg_type == 96);
        return;
    }
    match msg_type {
        96 => collect_rich_text(content, out),
        99 => collect_complex(content, out),
        24 => collect_combine(content, out, depth),
        2 | 3 | 4 | 5 | 6 | 14 | 23 | 25 | 30 => push_file_names(out, content),
        8 | 12 | 15 | 21 | 31 => push_named(out, content, &["title", "brief"]),
        10 => push_named(out, content, &["msg_content", "brief"]),
        11 | 27 | 29 => push_named(out, content, &["brief", "title"]),
        19 => push_named(out, content, &["name", "brief"]),
        28 => push_named(out, content, &["brief", "text"]),
        _ => {}
    }
}

fn collect_rich_text(content: &serde_json::Value, out: &mut Vec<String>) {
    let Some(blocks) = content.as_array() else { return };
    for block in blocks {
        let block_type = block.get("msg_type").and_then(|v| v.as_i64()).unwrap_or(0);
        let Some(value) = block.get("content") else { continue };
        match block_type {
            1 => {
                if let Some(text) = value.as_str() {
                    push_text(out, text, true);
                }
            }
            2 | 3 => push_file_names(out, value),
            _ => {
                if let Some(text) = value.as_str() {
                    push_text(out, text, false);
                } else {
                    push_file_names(out, value);
                }
            }
        }
    }
}

fn collect_complex(content: &serde_json::Value, out: &mut Vec<String>) {
    let Some(obj) = content.as_object() else { return };
    if let Some(brief) = obj.get("brief").and_then(|v| v.as_str()) {
        push_text(out, brief, false);
    }
    // 与前端 rendersHtml 一致：只有 type 0/1 才把 contents[].content 当 HTML。
    let html = obj
        .get("type")
        .and_then(|v| v.as_i64())
        .map(|value| value == 0 || value == 1)
        .unwrap_or(false);
    let Some(items) = obj.get("contents").and_then(|v| v.as_array()) else { return };
    for item in items {
        let Some(value) = item.get("content") else { continue };
        let Some(text) = value.as_str() else {
            push_file_names(out, value);
            continue;
        };
        if html {
            push_text(out, text, true);
            continue;
        }
        // 非 HTML 的内容可能是文件卡片 JSON，尽量把文件名抽出来。
        match serde_json::from_str::<serde_json::Value>(text) {
            Ok(parsed) if parsed.is_object() => push_file_names(out, &parsed),
            _ => push_text(out, text, false),
        }
    }
}

fn collect_combine(content: &serde_json::Value, out: &mut Vec<String>, depth: usize) {
    let Some(obj) = content.as_object() else { return };
    if let Some(brief) = obj.get("brief").and_then(|v| v.as_str()) {
        push_text(out, brief, false);
    }
    let Some(messages) = obj.get("msgs").and_then(|v| v.as_array()) else { return };
    for message in messages {
        let msg_type = message.get("msg_type").and_then(|v| v.as_i64()).unwrap_or(0);
        if let Some(value) = message.get("content") {
            collect_text(msg_type, value, out, depth + 1);
        }
        if let Some(name) = message.get("from_name").and_then(|v| v.as_str()) {
            push_text(out, name, false);
        }
    }
}

fn push_file_names(out: &mut Vec<String>, content: &serde_json::Value) {
    if let Some(text) = content.as_str() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) {
            if parsed.is_object() {
                push_file_names(out, &parsed);
            }
        }
        return;
    }
    let Some(obj) = content.as_object() else { return };
    for key in ["file_name", "show_name", "name", "title"] {
        if let Some(text) = obj.get(key).and_then(|v| v.as_str()) {
            push_text(out, text, false);
        }
    }
}

fn push_named(out: &mut Vec<String>, content: &serde_json::Value, keys: &[&str]) {
    let Some(obj) = content.as_object() else { return };
    for key in keys {
        if let Some(text) = obj.get(*key).and_then(|v| v.as_str()) {
            push_text(out, text, false);
        }
    }
}

fn push_text(out: &mut Vec<String>, text: &str, html: bool) {
    let text = if html { strip_html(text) } else { text.to_string() };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if !text.is_empty() && !out.contains(&text) {
        out.push(text);
    }
}

/// 只做最基本的去标签与实体解码；索引不需要和渲染结果逐字一致。
fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    let mut in_entity = false;
    let mut entity = String::new();
    for ch in input.chars() {
        if in_tag {
            if ch == '>' {
                in_tag = false;
            }
            continue;
        }
        if in_entity {
            if ch == ';' {
                match decode_entity(&entity) {
                    Some(replacement) => out.push_str(replacement),
                    None => {
                        out.push('&');
                        out.push_str(&entity);
                        out.push(';');
                    }
                }
                entity.clear();
                in_entity = false;
            } else if entity.len() >= 10 {
                // 不像实体，原样输出，避免吞掉正文里的 `&`。
                out.push('&');
                out.push_str(&entity);
                out.push(ch);
                entity.clear();
                in_entity = false;
            } else {
                entity.push(ch);
            }
            continue;
        }
        match ch {
            '<' => in_tag = true,
            '&' => in_entity = true,
            _ => out.push(ch),
        }
    }
    if in_entity {
        out.push('&');
        out.push_str(&entity);
    }
    out
}

fn decode_entity(entity: &str) -> Option<&'static str> {
    match entity {
        "nbsp" | "ensp" | "emsp" => Some(" "),
        "amp" => Some("&"),
        "lt" => Some("<"),
        "gt" => Some(">"),
        "quot" => Some("\""),
        "apos" => Some("'"),
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub bodies: Vec<String>,
    pub has_more: bool,
}

fn like_pattern(term: &str) -> String {
    let mut pattern = String::with_capacity(term.len() + 2);
    pattern.push('%');
    for ch in term.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

fn build_fts_query(terms: &[&str]) -> String {
    terms
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn search_messages(
    db: &Db,
    account_id: &str,
    keyword: &str,
    session_id: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<SearchPage, String> {
    let terms: Vec<&str> = keyword.split_whitespace().filter(|term| !term.is_empty()).collect();
    if terms.is_empty() {
        return Ok(SearchPage { bodies: Vec::new(), has_more: false });
    }
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let offset = offset.unwrap_or(0).max(0);
    let mut fts_terms = Vec::new();
    let mut like_terms = Vec::new();
    for term in terms {
        // FTS5 trigram 至少匹配 3 个字符；更短的词用 LIKE 兜底。
        if term.chars().count() >= 3 {
            fts_terms.push(term);
        } else {
            like_terms.push(term);
        }
    }

    let mut clauses: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();
    if !fts_terms.is_empty() {
        clauses.push("f.search_text MATCH ?".to_string());
        args.push(Value::Text(build_fts_query(&fts_terms)));
    }
    for term in &like_terms {
        clauses.push("m.search_text LIKE ? ESCAPE '\\'".to_string());
        args.push(Value::Text(like_pattern(term)));
    }
    clauses.push("m.account_id = ?".to_string());
    args.push(Value::Text(account_id.to_string()));
    if let Some(session_id) = session_id.filter(|id| !id.is_empty()) {
        clauses.push("m.session_id = ?".to_string());
        args.push(Value::Text(session_id.to_string()));
    }
    // 有 FTS 词时让 FTS 表驱动（先命中再回表）；只有短词时只能扫 im_messages。
    let from = if fts_terms.is_empty() {
        "im_messages m"
    } else {
        "im_messages_fts f JOIN im_messages m ON m.rowid = f.rowid"
    };
    let sql = format!(
        "SELECT m.body FROM {from} WHERE {} ORDER BY m.send_time DESC, m.msg_id DESC LIMIT ? OFFSET ?",
        clauses.join(" AND ")
    );
    args.push(Value::Integer(limit + 1));
    args.push(Value::Integer(offset));

    let conn = db.lock()?;
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备消息搜索失败：{e}"))?;
    let rows = stmt
        .query_map(params_from_iter(args), |row| row.get::<_, String>(0))
        .map_err(|e| format!("搜索消息失败：{e}"))?;
    let mut bodies = Vec::new();
    for row in rows {
        bodies.push(row.map_err(|e| format!("读取搜索结果失败：{e}"))?);
    }
    let has_more = bodies.len() as i64 > limit;
    bodies.truncate(limit as usize);
    Ok(SearchPage { bodies, has_more })
}

/// 迁移 v4 后为历史行补索引；按 rowid 分批，避免一次性把整个库读进内存。
/// 返回补写的行数（无文本可抽取的消息会跳过，但仍会推进游标）。
pub fn search_backfill(db: &Db) -> Result<usize, String> {
    const BATCH: i64 = 500;
    let mut last_rowid = 0i64;
    let mut updated = 0usize;
    loop {
        let pending: Vec<(i64, i64, String)> = {
            let conn = db.lock()?;
            let mut stmt = conn
                .prepare(
                    "SELECT rowid, msg_type, body FROM im_messages
                     WHERE search_text = '' AND rowid > ?1
                     ORDER BY rowid LIMIT ?2",
                )
                .map_err(|e| format!("准备搜索索引回填失败：{e}"))?;
            let rows = stmt
                .query_map(params![last_rowid, BATCH], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(|e| format!("读取待回填消息失败：{e}"))?;
            let mut list = Vec::new();
            for row in rows {
                list.push(row.map_err(|e| format!("读取待回填消息失败：{e}"))?);
            }
            list
        };
        let Some((max_rowid, _, _)) = pending.last() else { break };
        last_rowid = *max_rowid;
        let mut conn = db.lock()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始回填事务失败：{e}"))?;
        {
            let mut stmt = tx
                .prepare("UPDATE im_messages SET search_text = ?1 WHERE rowid = ?2")
                .map_err(|e| format!("准备回填索引失败：{e}"))?;
            for (rowid, msg_type, body) in pending {
                let text = build_search_text(msg_type, &body);
                if text.is_empty() {
                    continue;
                }
                stmt.execute(params![text, rowid])
                    .map_err(|e| format!("回填搜索索引失败：{e}"))?;
                updated += 1;
            }
        }
        tx.commit().map_err(|e| format!("提交回填事务失败：{e}"))?;
    }
    Ok(updated)
}

fn account_clear(db: &Db, account_id: &str) -> Result<(), String> {
    let mut conn = db.lock()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开始清理事务失败：{e}"))?;
    tx.execute("DELETE FROM im_messages WHERE account_id = ?1", params![account_id])
        .map_err(|e| format!("清理消息失败：{e}"))?;
    tx.execute("DELETE FROM im_state WHERE account_id = ?1", params![account_id])
        .map_err(|e| format!("清理状态失败：{e}"))?;
    tx.commit().map_err(|e| format!("提交清理事务失败：{e}"))?;
    Ok(())
}

fn state_upsert(
    db: &Db,
    account_id: &str,
    scope: &str,
    entries: &[StateEntry],
) -> Result<usize, String> {
    if entries.is_empty() {
        return Ok(0);
    }
    let mut conn = db.lock()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开始状态事务失败：{e}"))?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO im_state (account_id, scope, key, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(account_id, scope, key) DO UPDATE SET
                   value = excluded.value,
                   updated_at = excluded.updated_at",
            )
            .map_err(|e| format!("准备状态写入失败：{e}"))?;
        let updated_at = now_ms();
        for entry in entries {
            stmt.execute(params![account_id, scope, entry.key, entry.value, updated_at])
                .map_err(|e| format!("写入状态失败：{e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("提交状态事务失败：{e}"))?;
    Ok(entries.len())
}

fn state_query(
    db: &Db,
    account_id: &str,
    scope: &str,
    keys: Option<&[String]>,
) -> Result<Vec<StateEntry>, String> {
    let conn = db.lock()?;
    let mut result = Vec::new();
    match keys {
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT key, value FROM im_state
                     WHERE account_id = ?1 AND scope = ?2
                     ORDER BY updated_at ASC",
                )
                .map_err(|e| format!("准备状态查询失败：{e}"))?;
            let rows = stmt
                .query_map(params![account_id, scope], |row| {
                    Ok(StateEntry { key: row.get(0)?, value: row.get(1)? })
                })
                .map_err(|e| format!("查询状态失败：{e}"))?;
            for row in rows {
                result.push(row.map_err(|e| format!("读取状态失败：{e}"))?);
            }
        }
        Some(keys) => {
            for chunk in keys.chunks(500) {
                if chunk.is_empty() {
                    continue;
                }
                let placeholders = std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
                let sql = format!(
                    "SELECT key, value FROM im_state
                     WHERE account_id = ? AND scope = ? AND key IN ({placeholders})"
                );
                let mut args: Vec<Value> = vec![
                    Value::Text(account_id.to_string()),
                    Value::Text(scope.to_string()),
                ];
                args.extend(chunk.iter().map(|key| Value::Text(key.clone())));
                let mut stmt = conn
                    .prepare(&sql)
                    .map_err(|e| format!("准备状态查询失败：{e}"))?;
                let rows = stmt
                    .query_map(params_from_iter(args), |row| {
                        Ok(StateEntry { key: row.get(0)?, value: row.get(1)? })
                    })
                    .map_err(|e| format!("查询状态失败：{e}"))?;
                for row in rows {
                    result.push(row.map_err(|e| format!("读取状态失败：{e}"))?);
                }
            }
        }
    }
    Ok(result)
}

fn state_delete(db: &Db, account_id: &str, scope: &str, keys: &[String]) -> Result<usize, String> {
    if keys.is_empty() {
        return Ok(0);
    }
    let mut conn = db.lock()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开始状态事务失败：{e}"))?;
    let mut removed = 0usize;
    for chunk in keys.chunks(500) {
        let placeholders = std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM im_state
             WHERE account_id = ? AND scope = ? AND key IN ({placeholders})"
        );
        let mut args: Vec<Value> = vec![
            Value::Text(account_id.to_string()),
            Value::Text(scope.to_string()),
        ];
        args.extend(chunk.iter().map(|key| Value::Text(key.clone())));
        removed += tx
            .execute(&sql, params_from_iter(args))
            .map_err(|e| format!("删除状态失败：{e}"))?;
    }
    tx.commit().map_err(|e| format!("提交状态事务失败：{e}"))?;
    Ok(removed)
}

fn state_clear(db: &Db, account_id: &str, scopes: Option<&[String]>) -> Result<usize, String> {
    let mut conn = db.lock()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开始状态事务失败：{e}"))?;
    let mut removed = 0usize;
    match scopes {
        None => {
            removed += tx
                .execute("DELETE FROM im_state WHERE account_id = ?1", params![account_id])
                .map_err(|e| format!("清理状态失败：{e}"))?;
        }
        Some(scopes) => {
            for scope in scopes {
                removed += tx
                    .execute(
                        "DELETE FROM im_state WHERE account_id = ?1 AND scope = ?2",
                        params![account_id, scope],
                    )
                    .map_err(|e| format!("清理状态失败：{e}"))?;
            }
        }
    }
    tx.commit().map_err(|e| format!("提交状态事务失败：{e}"))?;
    Ok(removed)
}

fn state_trim(db: &Db, account_id: &str, scope: &str, keep: i64) -> Result<usize, String> {
    if keep <= 0 {
        return Ok(0);
    }
    let conn = db.lock()?;
    conn.execute(
        "DELETE FROM im_state
         WHERE account_id = ?1 AND scope = ?2
           AND key NOT IN (
             SELECT key FROM im_state
             WHERE account_id = ?1 AND scope = ?2
             ORDER BY updated_at DESC, key DESC
             LIMIT ?3
           )",
        params![account_id, scope, keep],
    )
    .map_err(|e| format!("清理状态失败：{e}"))
}

/* ---------------- Tauri commands ---------------- */

#[tauri::command]
pub async fn im_messages_upsert(
    db: State<'_, Db>,
    account_id: String,
    rows: Vec<MessageRow>,
) -> Result<usize, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || upsert_messages(&db, &account_id, &rows))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_messages_recent(
    db: State<'_, Db>,
    account_id: String,
    limit: i64,
) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || recent_messages(&db, &account_id, limit))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_messages_session(
    db: State<'_, Db>,
    account_id: String,
    session_id: String,
    limit: i64,
) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || session_messages(&db, &account_id, &session_id, limit))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_messages_around(
    db: State<'_, Db>,
    account_id: String,
    session_id: String,
    msg_id: String,
    before: i64,
    after: i64,
) -> Result<Vec<String>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        messages_around(&db, &account_id, &session_id, &msg_id, before, after)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_messages_get(
    db: State<'_, Db>,
    account_id: String,
    msg_id: String,
) -> Result<Option<String>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_message(&db, &account_id, &msg_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_messages_delete(
    db: State<'_, Db>,
    account_id: String,
    ids: Vec<String>,
) -> Result<usize, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || delete_messages(&db, &account_id, &ids))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_messages_search(
    db: State<'_, Db>,
    account_id: String,
    keyword: String,
    session_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<SearchPage, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        search_messages(
            &db,
            &account_id,
            &keyword,
            session_id.as_deref(),
            limit,
            offset,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_account_clear(db: State<'_, Db>, account_id: String) -> Result<(), String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || account_clear(&db, &account_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_state_upsert(
    db: State<'_, Db>,
    account_id: String,
    scope: String,
    entries: Vec<StateEntry>,
) -> Result<usize, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state_upsert(&db, &account_id, &scope, &entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_state_query(
    db: State<'_, Db>,
    account_id: String,
    scope: String,
    keys: Option<Vec<String>>,
) -> Result<Vec<StateEntry>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state_query(&db, &account_id, &scope, keys.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_state_delete(
    db: State<'_, Db>,
    account_id: String,
    scope: String,
    keys: Vec<String>,
) -> Result<usize, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state_delete(&db, &account_id, &scope, &keys)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_state_clear(
    db: State<'_, Db>,
    account_id: String,
    scopes: Option<Vec<String>>,
) -> Result<usize, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state_clear(&db, &account_id, scopes.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn im_state_trim(
    db: State<'_, Db>,
    account_id: String,
    scope: String,
    keep: i64,
) -> Result<usize, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state_trim(&db, &account_id, &scope, keep))
        .await
        .map_err(|e| e.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, session: &str, time: i64) -> MessageRow {
        MessageRow {
            msg_id: id.to_string(),
            session_id: session.to_string(),
            session_type: 2,
            send_time: time,
            msg_type: 1,
            from_id: "author".to_string(),
            is_read: Some(0),
            body: format!(r#"{{"msg_id":"{id}","sessionId":"{session}"}}"#),
        }
    }

    #[test]
    fn messages_dedupe_and_page() {
        let db = Db::in_memory().unwrap();
        upsert_messages(&db, "me", &[row("a", "g1", 100), row("b", "g1", 200)]).unwrap();
        upsert_messages(&db, "me", &[row("a", "g1", 150)]).unwrap();
        upsert_messages(&db, "me", &[row("c", "g2", 300)]).unwrap();
        upsert_messages(&db, "other", &[row("d", "g1", 400)]).unwrap();

        // 同 msg_id 覆盖而不是新增；账号隔离
        assert_eq!(recent_messages(&db, "me", 10).unwrap().len(), 3);
        assert_eq!(recent_messages(&db, "other", 10).unwrap().len(), 1);

        // 按时间升序返回
        let session = session_messages(&db, "me", "g1", 10).unwrap();
        assert_eq!(session.len(), 2);
        assert!(session[0].contains(r#""msg_id":"a""#));
        assert!(session[1].contains(r#""msg_id":"b""#));

        // 上下文包含目标本身
        let around = messages_around(&db, "me", "g1", "a", 10, 10).unwrap();
        assert_eq!(around.len(), 2);
        assert!(around[0].contains(r#""msg_id":"a""#));
        assert!(around[1].contains(r#""msg_id":"b""#));
    }

    #[test]
    fn state_upsert_query_delete_and_trim() {
        let db = Db::in_memory().unwrap();
        let entries = vec![
            StateEntry { key: "a".into(), value: "1".into() },
            StateEntry { key: "b".into(), value: "2".into() },
        ];
        state_upsert(&db, "me", "unread", &entries).unwrap();
        assert_eq!(state_query(&db, "me", "unread", None).unwrap().len(), 2);
        assert_eq!(
            state_query(&db, "me", "unread", Some(&["a".to_string()]))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(state_delete(&db, "me", "unread", &["a".to_string()]).unwrap(), 1);
        assert_eq!(state_trim(&db, "me", "unread", 0).unwrap(), 0);
        assert_eq!(state_clear(&db, "me", None).unwrap(), 1);
    }

    #[test]
    fn account_clear_removes_messages_and_state() {
        let db = Db::in_memory().unwrap();
        upsert_messages(&db, "me", &[row("a", "g1", 100)]).unwrap();
        state_upsert(
            &db,
            "me",
            "unread",
            &[StateEntry { key: "g1".into(), value: "1".into() }],
        )
        .unwrap();
        account_clear(&db, "me").unwrap();
        assert!(recent_messages(&db, "me", 10).unwrap().is_empty());
        assert!(state_query(&db, "me", "unread", None).unwrap().is_empty());
    }

    #[test]
    fn search_matches_content_file_names_and_account_scope() {
        let db = Db::in_memory().unwrap();
        let mut first = row("a", "g1", 100);
        first.body = r#"{"msg_id":"a","sessionId":"g1","msg_type":1,"content":"下周三开项目评审会","from_name":"张三"}"#.into();
        let mut file = row("b", "g1", 200);
        file.msg_type = 3;
        file.body = r#"{"msg_id":"b","sessionId":"g1","msg_type":3,"content":"{\"file_name\":\"年度报表.pdf\"}","from_name":"李四"}"#.into();
        let mut other = row("c", "g2", 300);
        other.body = r#"{"msg_id":"c","sessionId":"g2","msg_type":1,"content":"项目评审会改到周五"}"#.into();
        upsert_messages(&db, "me", &[first, file, other]).unwrap();

        let mut isolated = row("a", "g1", 100);
        isolated.body = r#"{"msg_id":"a","sessionId":"g1","msg_type":1,"content":"下周三开项目评审会"}"#.into();
        upsert_messages(&db, "other", &[isolated]).unwrap();

        // 4 字走 FTS
        let hits = search_messages(&db, "me", "项目评审", None, Some(20), Some(0)).unwrap();
        assert_eq!(hits.bodies.len(), 2);
        assert!(hits.bodies.iter().any(|body| body.contains("下周三")));

        // 2 字词走 LIKE 兜底
        let hits = search_messages(&db, "me", "报表", None, None, None).unwrap();
        assert_eq!(hits.bodies.len(), 1);
        assert!(hits.bodies[0].contains("年度报表.pdf"));

        // 文件名扩展名同样命中
        let hits = search_messages(&db, "me", "pdf", None, None, None).unwrap();
        assert_eq!(hits.bodies.len(), 1);

        // 会话过滤与账号隔离
        let hits = search_messages(&db, "me", "项目评审", Some("g1"), None, None).unwrap();
        assert_eq!(hits.bodies.len(), 1);
        let hits = search_messages(&db, "other", "项目评审", None, None, None).unwrap();
        assert_eq!(hits.bodies.len(), 1);
    }

    #[test]
    fn search_index_follows_upsert_and_clears_on_recall() {
        let db = Db::in_memory().unwrap();
        let mut rich = row("r", "g1", 100);
        rich.msg_type = 96;
        rich.body = r#"{"msg_id":"r","sessionId":"g1","msg_type":96,"content":[{"msg_type":1,"content":"<b>季度总结</b>"},{"msg_type":3,"content":"{\"file_name\":\"预算表.xlsx\"}"}]}"#.into();
        upsert_messages(&db, "me", &[rich]).unwrap();
        assert_eq!(
            search_messages(&db, "me", "季度总结", None, None, None).unwrap().bodies.len(),
            1
        );
        assert_eq!(
            search_messages(&db, "me", "预算表", None, None, None).unwrap().bodies.len(),
            1
        );

        // 撤回：前端把 content 置空后重新 upsert，旧正文不应再被搜到。
        let mut recalled = row("r", "g1", 100);
        recalled.msg_type = 66;
        recalled.body = r#"{"msg_id":"r","sessionId":"g1","msg_type":66,"content":""}"#.into();
        upsert_messages(&db, "me", &[recalled]).unwrap();
        assert!(search_messages(&db, "me", "季度总结", None, None, None).unwrap().bodies.is_empty());
        assert!(search_messages(&db, "me", "预算表", None, None, None).unwrap().bodies.is_empty());
    }

    #[test]
    fn backfill_rebuilds_legacy_index() {
        let db = Db::in_memory().unwrap();
        let mut message = row("a", "g1", 100);
        message.body = r#"{"msg_id":"a","sessionId":"g1","msg_type":1,"content":"历史消息关键字"}"#.into();
        upsert_messages(&db, "me", &[message]).unwrap();
        {
            let conn = db.lock().unwrap();
            conn.execute("UPDATE im_messages SET search_text = ''", []).unwrap();
        }
        assert!(
            search_messages(&db, "me", "历史消息", None, None, None)
                .unwrap()
                .bodies
                .is_empty()
        );
        assert_eq!(search_backfill(&db).unwrap(), 1);
        assert_eq!(
            search_messages(&db, "me", "历史消息", None, None, None).unwrap().bodies.len(),
            1
        );
    }
}
