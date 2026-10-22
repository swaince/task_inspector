use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::commands::now_iso;
use super::Db;

/// 项目画像的持久化。
///
/// 生成一次画像要遍历代码、拉热点、逐模块调模型，成本不低；
/// 结果按 (项目, 仓库) 存下来，并用 head_commit 判断要不要重算。
/// payload 本身是前端定义的 JSON，Rust 侧不解析内容——画像字段还会变，
/// 在这里定一份结构只会让每次调整都多一次迁移。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRow {
    pub project_id: String,
    pub repo_id: i64,
    #[serde(default)]
    pub head_commit: Option<String>,
    #[serde(default)]
    pub generated_at: String,
    /// 画像 JSON（字符串形式，由前端序列化）
    pub payload: String,
}

#[tauri::command]
pub fn profiles_get(db: State<'_, Db>, project_id: String) -> Result<Vec<ProfileRow>, String> {
    let conn = db.lock()?;
    let mut stmt = conn
        .prepare(
            "SELECT project_id, repo_id, head_commit, generated_at, payload
             FROM project_profiles WHERE project_id = ?1 ORDER BY repo_id",
        )
        .map_err(|e| format!("准备查询失败：{e}"))?;

    let rows = stmt
        .query_map([project_id], |row| {
            Ok(ProfileRow {
                project_id: row.get(0)?,
                repo_id: row.get(1)?,
                head_commit: row.get(2)?,
                generated_at: row.get(3)?,
                payload: row.get(4)?,
            })
        })
        .map_err(|e| format!("查询项目画像失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取项目画像失败：{e}"))?;

    Ok(rows)
}

#[tauri::command]
pub fn profile_upsert(db: State<'_, Db>, payload: String) -> Result<(), String> {
    let row: ProfileRow =
        serde_json::from_str(&payload).map_err(|e| format!("画像数据不合法：{e}"))?;
    let generated_at = if row.generated_at.trim().is_empty() {
        now_iso()
    } else {
        row.generated_at
    };

    let conn = db.lock()?;
    conn.execute(
        "INSERT INTO project_profiles (project_id, repo_id, generated_at, head_commit, payload)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(project_id, repo_id) DO UPDATE SET
           generated_at = excluded.generated_at,
           head_commit  = excluded.head_commit,
           payload      = excluded.payload",
        params![row.project_id, row.repo_id, generated_at, row.head_commit, row.payload],
    )
    .map_err(|e| format!("保存项目画像失败：{e}"))?;

    Ok(())
}

#[tauri::command]
pub fn profiles_delete(db: State<'_, Db>, project_id: String) -> Result<(), String> {
    let conn = db.lock()?;
    conn.execute("DELETE FROM project_profiles WHERE project_id = ?1", [project_id])
        .map_err(|e| format!("删除项目画像失败：{e}"))?;
    Ok(())
}
