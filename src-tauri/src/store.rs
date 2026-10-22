use std::fs;
use std::path::PathBuf;

use rusqlite::{OptionalExtension, params};
use tauri::{AppHandle, Manager};

use crate::Db;

/// 旧版「一条记录一个 JSON 文件」存储的读取与一次性搬迁。
///
/// 新版本用 SQLite（见 db 模块），但已经在用的机器上有旧数据。
/// 这个模块只在升级后的第一次启动跑一次，把旧文件灌进数据库，
/// 之后写一个标记，不再重复导入。旧文件本身不删——万一迁移有问题还留着可查。
const LEGACY_DIR: &str = "store";
const IMPORTED_FLAG: &str = "legacy_store_imported";

fn legacy_dir(app: &AppHandle, ns: &str) -> Option<PathBuf> {
    let base = app.path().app_data_dir().ok()?;
    let dir = base.join(LEGACY_DIR).join(ns);
    dir.is_dir().then_some(dir)
}

fn already_imported(db: &Db) -> Result<bool, String> {
    let conn = db.lock()?;
    let flag: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![IMPORTED_FLAG],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("读取迁移标记失败：{e}"))?;
    Ok(flag.is_some())
}

fn mark_imported(db: &Db) -> Result<(), String> {
    let conn = db.lock()?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
        params![IMPORTED_FLAG],
    )
    .map_err(|e| format!("写入迁移标记失败：{e}"))?;
    Ok(())
}

/// 把旧的 JSON 文件存储搬进数据库。没有旧数据时什么都不做。
pub fn migrate_into(db: &Db, app: &AppHandle) -> Result<(), String> {
    if already_imported(db)? {
        return Ok(());
    }

    let mut imported = 0usize;

    // 配置
    if let Some(dir) = legacy_dir(app, "app") {
        let file = dir.join("settings.json");
        if let Ok(raw) = fs::read_to_string(&file) {
            let conn = db.lock()?;
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?1, ?2)
                 ON CONFLICT(key) DO NOTHING",
                params![raw, crate::db::commands::now_iso()],
            )
            .map_err(|e| format!("迁移配置失败：{e}"))?;
            imported += 1;
        }
    }

    // 检查历史
    if let Some(dir) = legacy_dir(app, "inspections") {
        let conn = db.lock()?;
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            if let Err(err) = crate::db::commands::insert_inspection(&conn, &raw) {
                log::warn!("跳过无法迁移的检查记录 {}：{err}", path.display());
                continue;
            }
            imported += 1;
        }
    }

    mark_imported(db)?;
    if imported > 0 {
        log::info!("已从旧的 JSON 存储迁移 {imported} 条数据");
    }
    Ok(())
}
