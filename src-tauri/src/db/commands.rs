use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use super::Db;

/// 数据库命令。
///
/// 入参统一用 JSON 字符串而不是把领域模型在 Rust 里再定义一遍：
/// 领域模型的形状由 TS 侧主导且会持续演进，在 Rust 里镜像一份必然慢慢跑偏。
/// 这里只解析**需要用到的列**，其余原样存进载荷，字段增减不影响这里。
mod parse {
    use super::*;

    /// 取字符串字段。名字刻意取短：下面几十处调用都用它，写全称会把列出的表达式挤到换行。
    pub fn s(v: &Value, key: &str) -> String {
        v.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    pub fn opt_str(v: &Value, key: &str) -> Option<String> {
        v.get(key).and_then(Value::as_str).map(str::to_string)
    }

    pub fn f64_field(v: &Value, key: &str) -> f64 {
        v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
    }

    pub fn i64_field(v: &Value, key: &str) -> i64 {
        v.get(key)
            .and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
            .unwrap_or(0)
    }

    pub fn string_list(v: &Value, key: &str) -> Option<String> {
        v.get(key)
            .and_then(Value::as_array)
            .map(|arr| {
                let items: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect();
                serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
            })
    }

    /// 从 CommitFileChange 数组里取出文件路径。
    ///
    /// 不能直接用 string_list：fileChanges 的元素是对象（{ path, isNew, ... }）而不是字符串，
    /// 走那条路会得到空数组，文件路径就永远进不了检索索引。
    /// 这里同时兼容纯字符串数组，方便测试和以后简化数据结构。
    pub fn file_paths(v: &Value, key: &str) -> Option<String> {
        v.get(key).and_then(Value::as_array).map(|arr| {
            let paths: Vec<String> = arr
                .iter()
                .filter_map(|f| {
                    f.as_str()
                        .map(str::to_string)
                        .or_else(|| f.get("path").and_then(Value::as_str).map(str::to_string))
                })
                .collect();
            serde_json::to_string(&paths).unwrap_or_else(|_| "[]".to_string())
        })
    }

    /// 取嵌套对象，取不到时返回 Null，让后续的字段读取退化成默认值。
    pub fn nested<'a>(v: &'a Value, key: &str) -> &'a Value {
        v.get(key).unwrap_or(&Value::Null)
    }
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn settings_get(db: State<'_, Db>) -> Result<Option<String>, String> {
    let conn = db.lock()?;
    let value = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|e| format!("读取配置失败：{e}"))?;

    // 启动时把「读到了多少字节」记一笔。配置是不是空的、有没有被别的地方覆盖，
    // 光看界面判断不了——界面上的值可能来自内存里的默认值，而不是库里的那份。
    match &value {
        Some(v) => {
            log::info!("读取配置（{} 字节）", v.len());
            log::info!("{}", describe_daily_report(v));
            log::info!("{}", describe_llm(v));
        }
        None => log::info!("库里还没有配置，按默认值启动"),
    }

    Ok(value)
}

/// 模型配置摘要。同样只报「有没有值」，不报 key 本身。
///
/// 排查「配了模型但跑不起来」时，第一步永远是确认进程实际加载到的是哪一套：
/// provider 选错、模型名写错、地址留空都是常见原因，而界面上看起来都「配过了」。
fn describe_llm(raw: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return "模型配置：（读到的不是合法 JSON）".into();
    };
    let l = &v["llm"];
    let has = |node: &serde_json::Value| {
        node.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false)
    };

    format!(
        "模型配置：provider={} model={} 接口地址={} 有 key={} 并发={} 超时={}ms",
        l["provider"],
        l["model"],
        if has(&l["baseUrl"]) { "自定义" } else { "默认" },
        has(&l["apiKey"]),
        l["concurrency"],
        l["timeoutMs"],
    )
}

/// 把日报配置里最容易出问题的那几项摘成一行日志。
///
/// **只报「有没有值」，不报值本身**——用户名和密码在这里只输出真假。
/// 排查「明明配了却说没配」这类问题时，需要的是「进程实际加载到了什么」，
/// 而不是界面上显示着什么。
fn describe_daily_report(raw: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return "日报配置：（读到的不是合法 JSON）".into();
    };
    let dr = &v["dailyReport"];
    let login = &dr["login"];
    let has = |node: &serde_json::Value| {
        node.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false)
    };

    format!(
        "日报配置：source={} baseUrl={} 路径={} method={} 每页={} 最多页={} 跳过证书={} \
         | 登录 enabled={} type={} 登录路径={} 有账号={} 有密码={} 探活路径={} \
         | 映射 itemsPath={} entriesPath={} 工时={} 内容={}",
        dr["source"],
        dr["baseUrl"],
        dr["listPathTemplate"],
        dr["method"],
        dr["pageSize"],
        dr["maxPages"],
        dr["allowInsecureTls"],
        login["enabled"],
        login["type"],
        login["path"],
        has(&login["username"]),
        has(&login["password"]),
        login["keepAlivePath"],
        dr["fieldMap"]["itemsPath"],
        dr["fieldMap"]["entriesPath"],
        dr["fieldMap"]["entryHoursPath"],
        dr["fieldMap"]["entryContentPath"],
    )
}

#[tauri::command]
pub fn settings_set(db: State<'_, Db>, value: String) -> Result<(), String> {
    // 记一行日志：配置没保存成功时，光看界面是发现不了的
    log::info!("保存配置（{} 字节）", value.len());
    let conn = db.lock()?;
    let affected = conn
        .execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![value, now()],
        )
        .map_err(|e| format!("保存配置失败：{e}"))?;

    // 把影响行数也记下来：写了但没生效（0 行）和压根没写进来，
    // 是两种完全不同的故障，不看这个数分不清
    log::info!("配置已保存，影响 {affected} 行");
    Ok(())
}

/* ------------------------------------------------------------------ *
 * 日报
 * ------------------------------------------------------------------ */

/// 整批写入某一天的日报。
///
/// 同一天的旧数据会被先删掉再写：日报是「以天为单位」被整体重取的，
/// 逐条 upsert 会留下当天已被删除的成员，反而更难排查。
#[tauri::command]
pub fn reports_upsert(db: State<'_, Db>, date: String, payload: String) -> Result<usize, String> {
    let mut conn = db.lock()?;
    insert_reports(&mut conn, &date, &payload)
}

/// 写入内核。拆出来是为了能在测试里直接对着一个临时库调用——
/// Tauri 的 State 在单元测试里构造不出来。
pub fn insert_reports(
    conn: &mut rusqlite::Connection,
    date: &str,
    payload: &str,
) -> Result<usize, String> {
    let reports: Vec<Value> =
        serde_json::from_str(payload).map_err(|e| format!("日报数据不是合法 JSON 数组：{e}"))?;

    let tx = conn.transaction().map_err(|e| format!("开启事务失败：{e}"))?;

    // 检索索引里的旧行要先清掉：它是独立表，不随 daily_reports 的级联删除走
    tx.execute(
        "DELETE FROM report_entries_fts WHERE report_id IN
           (SELECT id FROM daily_reports WHERE date = ?1)",
        params![date],
    )
    .map_err(|e| format!("清理检索索引失败：{e}"))?;

    tx.execute("DELETE FROM daily_reports WHERE date = ?1", params![date])
        .map_err(|e| format!("清理旧日报失败：{e}"))?;

    let mut count = 0usize;
    for report in &reports {
        let member_id = parse::s(report, "memberId");
        let id = {
            let given = parse::s(report, "id");
            if given.is_empty() {
                format!("{member_id}@{date}")
            } else {
                given
            }
        };

        tx.execute(
            "INSERT INTO daily_reports (id, date, member_id, member_name, total_hours, submitted_at, imported_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                parse::s(report, "date"),
                member_id,
                parse::s(report, "memberName"),
                parse::f64_field(report, "totalHours"),
                parse::opt_str(report, "submittedAt"),
                now(),
            ],
        )
        .map_err(|e| format!("写入日报失败：{e}"))?;

        if let Some(entries) = report.get("entries").and_then(Value::as_array) {
            for entry in entries {
                let entry_id = {
                    let given = parse::s(entry, "id");
                    if given.is_empty() {
                        format!("{id}-{}", tx.last_insert_rowid())
                    } else {
                        given
                    }
                };
                tx.execute(
                    "INSERT INTO report_entries (id, report_id, project_name, project_code, hours, content, task_refs)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        entry_id,
                        id,
                        parse::s(entry, "projectName"),
                        parse::opt_str(entry, "projectCode"),
                        parse::f64_field(entry, "hours"),
                        parse::s(entry, "content"),
                        parse::string_list(entry, "taskRefs"),
                    ],
                )
                .map_err(|e| format!("写入日报条目失败：{e}"))?;

                tx.execute(
                    "INSERT INTO report_entries_fts (entry_id, report_id, project_name, content)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        entry_id,
                        id,
                        parse::s(entry, "projectName"),
                        parse::s(entry, "content"),
                    ],
                )
                .map_err(|e| format!("写入检索索引失败：{e}"))?;
            }
        }
        count += 1;
    }

    tx.commit().map_err(|e| format!("提交日报写入失败：{e}"))?;
    Ok(count)
}

pub fn load_reports(conn: &rusqlite::Connection, dates: &[String]) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();

    for date in dates {
        let mut stmt = conn
            .prepare(
                "SELECT id, member_id, member_name, total_hours, submitted_at
                 FROM daily_reports WHERE date = ?1 ORDER BY member_name",
            )
            .map_err(|e| format!("准备查询失败：{e}"))?;

        let rows = stmt
            .query_map(params![date], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| format!("查询日报失败：{e}"))?;

        let base: Vec<_> = rows.collect::<Result<_, _>>().map_err(|e| format!("读取行失败：{e}"))?;

        for (id, member_id, member_name, total_hours, submitted_at) in base {
            let mut entry_stmt = conn
                .prepare(
                    "SELECT id, project_name, project_code, hours, content, task_refs
                     FROM report_entries WHERE report_id = ?1 ORDER BY rowid",
                )
                .map_err(|e| format!("准备条目查询失败：{e}"))?;

            let entries = entry_stmt
                .query_map(params![id], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "projectName": row.get::<_, String>(1)?,
                        "projectCode": row.get::<_, Option<String>>(2)?,
                        "hours": row.get::<_, f64>(3)?,
                        "content": row.get::<_, String>(4)?,
                        "taskRefs": row.get::<_, Option<String>>(5)?
                            .and_then(|s| serde_json::from_str::<Value>(&s).ok()),
                    }))
                })
                .map_err(|e| format!("查询条目失败：{e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("读取条目失败：{e}"))?;

            out.push(serde_json::json!({
                "id": id,
                "date": date,
                "memberId": member_id,
                "memberName": member_name,
                "entries": entries,
                "totalHours": total_hours,
                "submittedAt": submitted_at,
            }));
        }
    }

    Ok(out)
}

#[tauri::command]
pub fn reports_by_date(db: State<'_, Db>, date: String) -> Result<String, String> {
    let conn = db.lock()?;
    let reports = load_reports(&conn, &[date])?;
    serde_json::to_string(&reports).map_err(|e| format!("序列化失败：{e}"))
}

#[tauri::command]
pub fn reports_dates(db: State<'_, Db>) -> Result<Vec<String>, String> {
    let conn = db.lock()?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT date FROM daily_reports ORDER BY date DESC")
        .map_err(|e| format!("准备查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询日期失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取日期失败：{e}"))
}

#[tauri::command]
pub fn reports_clear(db: State<'_, Db>) -> Result<(), String> {
    let conn = db.lock()?;
    // entries 有 ON DELETE CASCADE，会跟着一起清掉
    conn.execute("DELETE FROM daily_reports", [])
        .map_err(|e| format!("清空日报失败：{e}"))?;
    Ok(())
}

/* ------------------------------------------------------------------ *
 * 检查结果
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn inspections_upsert(db: State<'_, Db>, payload: String) -> Result<(), String> {
    let conn = db.lock()?;
    insert_inspection(&conn, &payload)
}

/// 写入一条检查结果。抽出来是为了让旧存储的迁移能复用它，
/// 保证迁移和正常写入走的是同一套列映射。
pub fn insert_inspection(conn: &rusqlite::Connection, payload: &str) -> Result<(), String> {
    let result: Value =
        serde_json::from_str(payload).map_err(|e| format!("检查结果不是合法 JSON：{e}"))?;

    let summary = parse::nested(&result, "summary");
    let meta = parse::nested(&result, "meta");

    conn.execute(
        "INSERT INTO inspections
           (date, member_id, member_name, score, checked_hours, total_hours,
            orphan_count, model, created_at, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(date, member_id) DO UPDATE SET
           member_name   = excluded.member_name,
           score         = excluded.score,
           checked_hours = excluded.checked_hours,
           total_hours   = excluded.total_hours,
           orphan_count  = excluded.orphan_count,
           model         = excluded.model,
           created_at    = excluded.created_at,
           payload       = excluded.payload",
        params![
            parse::s(&result, "date"),
            parse::s(&result, "memberId"),
            parse::s(&result, "memberName"),
            parse::f64_field(summary, "score"),
            parse::f64_field(summary, "checkedHours"),
            parse::f64_field(summary, "totalHours"),
            parse::i64_field(summary, "orphanCommitCount"),
            parse::s(meta, "model"),
            parse::s(meta, "createdAt"),
            payload,
        ],
    )
    .map_err(|e| format!("保存检查结果失败：{e}"))?;
    Ok(())
}

/// 按条件列出检查结果。
///
/// 载荷里存的是完整结果，历史列表只需要摘要，但一次检查的记录量不大
/// （一天几十条、每条几十 KB），直接整条取出来比再建一张摘要表简单。
/// 真到需要分页几千条时再拆。
#[tauri::command]
pub fn inspections_list(
    db: State<'_, Db>,
    from: Option<String>,
    to: Option<String>,
    member_id: Option<String>,
) -> Result<String, String> {
    let conn = db.lock()?;
    let mut stmt = conn
        .prepare(
            "SELECT payload FROM inspections
             WHERE (?1 IS NULL OR date >= ?1)
               AND (?2 IS NULL OR date <= ?2)
               AND (?3 IS NULL OR member_id = ?3)
             ORDER BY date DESC, member_name",
        )
        .map_err(|e| format!("准备查询失败：{e}"))?;

    let rows = stmt
        .query_map(params![from, to, member_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询检查历史失败：{e}"))?;

    let items: Vec<String> = rows
        .collect::<Result<_, _>>()
        .map_err(|e| format!("读取检查历史失败：{e}"))?;

    Ok(format!("[{}]", items.join(",")))
}

#[tauri::command]
pub fn inspections_by_key(
    db: State<'_, Db>,
    date: String,
    member_id: String,
) -> Result<Option<String>, String> {
    let conn = db.lock()?;
    conn.query_row(
        "SELECT payload FROM inspections WHERE date = ?1 AND member_id = ?2",
        params![date, member_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("读取检查结果失败：{e}"))
}

#[tauri::command]
pub fn inspections_delete(db: State<'_, Db>, date: String, member_id: String) -> Result<(), String> {
    let conn = db.lock()?;
    conn.execute(
        "DELETE FROM inspections WHERE date = ?1 AND member_id = ?2",
        params![date, member_id],
    )
    .map_err(|e| format!("删除检查结果失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub fn inspections_clear(db: State<'_, Db>) -> Result<(), String> {
    let conn = db.lock()?;
    conn.execute("DELETE FROM inspections", [])
        .map_err(|e| format!("清空检查历史失败：{e}"))?;
    Ok(())
}

/// 清空本地数据。
///
/// - `mode = "business"`：只清业务数据（日报、检查历史、提交缓存、项目、人员），保留配置
/// - `mode = "all"`：连配置一起清，等于回到首次安装的状态
///
/// 整体放在一个事务里：清到一半失败会把库留在半空的状态，那比不清更糟。
/// FTS 索引由 DELETE 触发器维护，删基表就会一起清掉。
#[tauri::command]
pub fn data_reset(db: State<'_, Db>, mode: String) -> Result<(), String> {
    let conn = db.lock()?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启事务失败：{e}"))?;

    tx.execute_batch(
        "DELETE FROM report_entries;
         DELETE FROM daily_reports;
         DELETE FROM inspections;
         DELETE FROM commits;
         DELETE FROM embeddings;
         DELETE FROM project_profiles;
         DELETE FROM projects;
         DELETE FROM members;",
    )
    .map_err(|e| format!("清空业务数据失败：{e}"))?;

    if mode == "all" {
        tx.execute("DELETE FROM settings", [])
            .map_err(|e| format!("清空配置失败：{e}"))?;
    }

    tx.commit().map_err(|e| format!("提交清空事务失败：{e}"))?;
    log::warn!("本地数据已清空（mode={mode}）");
    Ok(())
}

/// 清理超过保留期的历史，返回删除条数。keepDays <= 0 表示永久保留。
#[tauri::command]
pub fn inspections_prune(db: State<'_, Db>, keep_days: i64) -> Result<usize, String> {
    let conn = db.lock()?;
    prune_inspections(&conn, keep_days)
}

pub fn prune_inspections(conn: &rusqlite::Connection, keep_days: i64) -> Result<usize, String> {
    if keep_days <= 0 {
        return Ok(0);
    }
    // date 是 YYYY-MM-DD，字典序即时间序，可以直接比字符串
    let cutoff = date_days_ago(keep_days);
    conn.execute("DELETE FROM inspections WHERE date < ?1", params![cutoff])
        .map_err(|e| format!("清理历史失败：{e}"))
}

/* ------------------------------------------------------------------ *
 * 提交：写入缓存 + 全文检索
 * ------------------------------------------------------------------ */

/// 把抓到的提交写进本地库。
///
/// 两个用途：一是留一份审计痕迹（检查结论引用了哪些提交，事后可查），
/// 二是作为全文检索的语料，让「找找谁做过支付回调」这类问题有地方问。
/// 写入是幂等的（按 sha 覆盖），重复检查同一天不会产生重复行。
#[tauri::command]
pub fn commits_upsert(db: State<'_, Db>, payload: String) -> Result<usize, String> {
    let mut conn = db.lock()?;
    insert_commits(&mut conn, &payload)
}

/// 写入内核，理由同 insert_reports。
pub fn insert_commits(conn: &mut rusqlite::Connection, payload: &str) -> Result<usize, String> {
    let commits: Vec<Value> =
        serde_json::from_str(payload).map_err(|e| format!("提交数据不是合法 JSON 数组：{e}"))?;

    let tx = conn.transaction().map_err(|e| format!("开启事务失败：{e}"))?;

    for c in &commits {
        let stats = parse::nested(c, "stats");
        tx.execute(
            "INSERT INTO commits
               (id, project_id, project_path, title, message, author_name, author_email,
                authored_date, committed_date, web_url, additions, deletions, files, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
               title         = excluded.title,
               message       = excluded.message,
               authored_date = excluded.authored_date,
               additions     = excluded.additions,
               deletions     = excluded.deletions,
               files         = excluded.files,
               fetched_at    = excluded.fetched_at",
            params![
                parse::s(c, "id"),
                parse::i64_field(c, "projectId"),
                parse::s(c, "projectPath"),
                parse::s(c, "title"),
                parse::s(c, "message"),
                parse::s(c, "authorName"),
                parse::s(c, "authorEmail"),
                parse::s(c, "authoredDate"),
                parse::s(c, "committedDate"),
                parse::s(c, "webUrl"),
                stats.get("additions").and_then(Value::as_i64),
                stats.get("deletions").and_then(Value::as_i64),
                parse::file_paths(c, "fileChanges"),
                now(),
            ],
        )
        .map_err(|e| format!("写入提交失败：{e}"))?;
    }

    tx.commit().map_err(|e| format!("提交写入失败：{e}"))?;
    Ok(commits.len())
}

/* ------------------------------------------------------------------ *
 * 向量：存取与检索
 * ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingRow {
    pub owner_type: String,
    pub owner_id: String,
    pub model: String,
    pub vec: Vec<f32>,
}

/// 写入向量。按 (owner_type, owner_id, model) 幂等覆盖。
#[tauri::command]
pub fn embeddings_upsert(db: State<'_, Db>, payload: String) -> Result<usize, String> {
    let rows: Vec<EmbeddingRow> =
        serde_json::from_str(&payload).map_err(|e| format!("向量数据不是合法 JSON 数组：{e}"))?;
    let conn = db.lock()?;
    insert_embeddings(&conn, rows)
}

pub fn insert_embeddings(
    conn: &rusqlite::Connection,
    rows: Vec<EmbeddingRow>,
) -> Result<usize, String> {
    let ts = now();
    let mut stmt = conn
        .prepare(
            "INSERT INTO embeddings (owner_type, owner_id, model, dim, vec, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(owner_type, owner_id, model) DO UPDATE SET
               dim = excluded.dim, vec = excluded.vec, created_at = excluded.created_at",
        )
        .map_err(|e| format!("准备写入失败：{e}"))?;

    for row in &rows {
        stmt.execute(params![
            row.owner_type,
            row.owner_id,
            row.model,
            row.vec.len() as i64,
            f32_to_blob(&row.vec),
            ts,
        ])
        .map_err(|e| format!("写入向量失败：{e}"))?;
    }
    Ok(rows.len())
}

/// 按余弦相似度取 top-k。
///
/// 这里是在 Rust 里暴力算的，没有用 sqlite-vec——它目前还是 alpha 版本，
/// 为一个「万级向量、毫秒级返回」的场景引入 alpha 依赖不划算。
/// 检索接口就这一个函数，等 sqlite-vec 出正式版、或数据量涨到十万级以上时，
/// 把这里的实现换成 vec0 虚拟表即可，调用方和融合逻辑都不用动。
fn vec_top_k(
    conn: &rusqlite::Connection,
    owner_type: &str,
    model: &str,
    query: &[f32],
    k: usize,
) -> Result<Vec<(String, f64)>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare("SELECT owner_id, vec FROM embeddings WHERE owner_type = ?1 AND model = ?2")
        .map_err(|e| format!("准备向量查询失败：{e}"))?;

    let rows = stmt
        .query_map(params![owner_type, model], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|e| format!("查询向量失败：{e}"))?;

    let query_norm = norm(query);
    let mut scored: Vec<(String, f64)> = Vec::new();

    for row in rows {
        let (id, blob) = row.map_err(|e| format!("读取向量失败：{e}"))?;
        let vec = blob_to_f32(&blob);
        if vec.len() != query.len() {
            // 换了 embedding 模型后维度会变，旧向量直接跳过而不是算出一个错误分数
            continue;
        }
        let denom = query_norm * norm(&vec);
        if denom == 0.0 {
            continue;
        }
        let dot: f32 = query.iter().zip(&vec).map(|(a, b)| a * b).sum();
        scored.push((id, (dot / denom) as f64));
    }

    // 相似度降序；分数相同的按 id 排，保证结果稳定可复现
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.0.cmp(&b.0)));
    scored.truncate(k);
    Ok(scored)
}

fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

fn f32_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn blob_to_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/* ------------------------------------------------------------------ *
 * 混合检索：BM25 + 向量，RRF 融合
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridHit {
    pub id: String,
    pub project_path: String,
    pub title: String,
    pub author_name: String,
    pub authored_date: String,
    pub web_url: String,
    /// 融合后的得分（越大越相关）
    pub score: f64,
    /// 命中来自哪几路，便于排查「为什么这条排前面」
    pub sources: Vec<String>,
}

/// 倒数排名融合（RRF）的平滑常数，业界惯用 60。
/// 只取排名不取原始分数，因为 BM25 分数和余弦相似度的量纲完全不同，
/// 直接加权求和需要为每种组合调参，而 RRF 不需要。
const RRF_K: f64 = 60.0;

/// 混合检索提交。
///
/// - BM25（FTS5）负责字面命中：中文词组、代码标识符、文件名
/// - 向量负责语义命中：换个说法描述同一件事也能召回
///
/// query_vector 为空时自动退化成纯 BM25——没配 embedding 服务、
/// 或索引还没建起来时，检索仍然可用，不会整个功能失效。
#[tauri::command]
pub fn search_hybrid(
    db: State<'_, Db>,
    query: String,
    query_vector: Option<Vec<f32>>,
    model: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<HybridHit>, String> {
    let conn = db.lock()?;
    search_hybrid_in(&conn, &query, query_vector.as_deref(), model.as_deref(), limit.unwrap_or(20).clamp(1, 200))
}

pub fn search_hybrid_in(
    conn: &rusqlite::Connection,
    query: &str,
    query_vector: Option<&[f32]>,
    model: Option<&str>,
    limit: i64,
) -> Result<Vec<HybridHit>, String> {
    let q = query.trim();

    // 每路多取一些候选再融合：只取 limit 条的话，某一路排名靠后但另一路靠前的
    // 结果会在融合前就被丢掉，失去了融合的意义。
    let pool = (limit as usize) * 4;
    let mut fused_scores: std::collections::HashMap<String, (f64, Vec<String>)> =
        std::collections::HashMap::new();

    let mut add = |id: String, rank: usize, source: &str| {
        let entry = fused_scores.entry(id).or_insert((0.0, Vec::new()));
        entry.0 += 1.0 / (RRF_K + (rank + 1) as f64);
        if !entry.1.iter().any(|s| s == source) {
            entry.1.push(source.to_string());
        }
    };

    // 第一路：BM25
    if !q.is_empty() {
        for (rank, hit) in search_commits_pool(conn, q, pool as i64)?.into_iter().enumerate() {
            add(hit, rank, "bm25");
        }
    }

    // 第二路：向量
    if let (Some(vector), Some(model)) = (query_vector, model) {
        for (rank, (id, _)) in vec_top_k(conn, "commit", model, vector, pool)?.into_iter().enumerate() {
            add(id, rank, "vector");
        }
    }

    let mut ranked: Vec<(String, f64, Vec<String>)> = fused_scores
        .into_iter()
        .map(|(id, (score, sources))| (id, score, sources))
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(limit as usize);

    hydrate(conn, ranked)
}

/// BM25 只取 id 顺序，交给融合环节统一装配明细。
fn search_commits_pool(
    conn: &rusqlite::Connection,
    q: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    // trigram 要求查询词至少 3 个字符，短词退回 LIKE
    if q.chars().count() < 3 {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM commits
                 WHERE title LIKE ?1 OR message LIKE ?1 OR project_path LIKE ?1
                 ORDER BY authored_date DESC LIMIT ?2",
            )
            .map_err(|e| format!("准备查询失败：{e}"))?;
        let rows = stmt
            .query_map(params![format!("%{q}%"), limit], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询失败：{e}"))?;
        return rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取失败：{e}"));
    }

    // FTS5 把 - . : ( ) 当查询语法，用双引号包成字面短语
    let phrase = format!("\"{}\"", q.replace('"', "\"\""));
    let mut stmt = conn
        .prepare(
            "SELECT c.id FROM commits_fts
             JOIN commits c ON c.rowid = commits_fts.rowid
             WHERE commits_fts MATCH ?1
             ORDER BY bm25(commits_fts, 6.0, 3.0, 2.0, 1.0)
             LIMIT ?2",
        )
        .map_err(|e| format!("准备检索失败：{e}"))?;
    let rows = stmt
        .query_map(params![phrase, limit], |row| row.get::<_, String>(0))
        .map_err(|e| format!("检索失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取检索结果失败：{e}"))
}

fn hydrate(
    conn: &rusqlite::Connection,
    ranked: Vec<(String, f64, Vec<String>)>,
) -> Result<Vec<HybridHit>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_path, title, author_name, authored_date, web_url
             FROM commits WHERE id = ?1",
        )
        .map_err(|e| format!("准备查询失败：{e}"))?;

    let mut out = Vec::new();
    for (id, score, sources) in ranked {
        let hit = stmt
            .query_row(params![id], |row| {
                Ok(HybridHit {
                    id: row.get(0)?,
                    project_path: row.get(1)?,
                    title: row.get(2)?,
                    author_name: row.get(3)?,
                    authored_date: row.get(4)?,
                    web_url: row.get(5)?,
                    score,
                    sources: sources.clone(),
                })
            })
            .optional()
            .map_err(|e| format!("读取提交失败：{e}"))?;
        if let Some(hit) = hit {
            out.push(hit);
        }
    }
    Ok(out)
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/// 按日期聚合，供概览页使用。
///
/// 放在 SQL 里算而不是把全部历史拉到前端再 reduce：
/// 这是数据库存在的意义之一，也让概览页的成本与历史总量无关。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub date: String,
    pub members: i64,
    pub scored_members: i64,
    pub avg_score: Option<f64>,
    pub total_hours: f64,
    pub orphan_count: i64,
}

#[tauri::command]
pub fn stats_by_date(db: State<'_, Db>, from: Option<String>, to: Option<String>) -> Result<Vec<DayStat>, String> {
    let conn = db.lock()?;
    stats_by_date_in(&conn, from.as_deref(), to.as_deref())
}

pub fn stats_by_date_in(
    conn: &rusqlite::Connection,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<DayStat>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT date,
                    COUNT(*)                                   AS members,
                    SUM(checked_hours > 0)                     AS scored_members,
                    AVG(CASE WHEN checked_hours > 0 THEN score END) AS avg_score,
                    SUM(total_hours)                           AS total_hours,
                    SUM(orphan_count)                          AS orphan_count
             FROM inspections
             WHERE (?1 IS NULL OR date >= ?1) AND (?2 IS NULL OR date <= ?2)
             GROUP BY date
             ORDER BY date DESC",
        )
        .map_err(|e| format!("准备统计查询失败：{e}"))?;

    let rows = stmt
        .query_map(params![from, to], |row| {
            Ok(DayStat {
                date: row.get(0)?,
                members: row.get(1)?,
                scored_members: row.get(2)?,
                avg_score: row.get(3)?,
                total_hours: row.get(4)?,
                orphan_count: row.get(5)?,
            })
        })
        .map_err(|e| format!("统计查询失败：{e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取统计结果失败：{e}"))
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/// 当前时间，形如 2026-10-16T13:45:00.000Z。
///
/// 没有引入 chrono：这里只需要「当前时刻」和「N 天前的日期」两种，
/// 用标准库 + 一点算术就够，不值得为此多一个依赖。
fn now() -> String {
    now_iso()
}

/// 供 db 模块外使用（旧存储迁移需要写入 imported_at）。
pub fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    iso_from_ms(ms as i64)
}

/// N 天前的 UTC 日期，形如 2026-10-16。date 列就是这个形状，可以直接比字符串。
fn date_days_ago(days: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs / 86_400 - days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 把「自 1970-01-01 起的天数」换成公历年月日（Howard Hinnant 的算法）。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_epoch_as_iso() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_792_108_800_000), "2026-10-16T00:00:00.000Z");
    }

    #[test]
    fn civil_from_days_handles_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 20742 天 = 2026-10-16，与上面 formats_epoch_as_iso 用的时间戳互相印证
        assert_eq!(civil_from_days(20_742), (2026, 10, 16));
    }

    #[test]
    fn days_ago_is_a_date_key() {
        let d = date_days_ago(30);
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }
}
