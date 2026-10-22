use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::Db;
use super::commands::now_iso;

/// 项目与人员的增删改查，以及项目与 GitLab 的对账。
///
/// GitLab 的拉取不在这里做：那部分在 TS 侧的适配器里（只此一处访问 GitLab），
/// Rust 只负责把拉回来的结果和本地表对上，避免两处各写一份 GitLab 访问逻辑。

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

/// 项目与 GitLab 的关联方式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLink {
    /// repo = 具体仓库；group = 组（展开时扫描子组）
    pub kind: String,
    pub path: String,
}

/// 关联链接展开后的具体仓库。
///
/// 展开要调 GitLab，所以解析一次就存下来，检查时直接用；
/// 组里新增仓库需要重新解析才会出现。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepo {
    pub id: i64,
    pub path_with_namespace: String,
    pub name: String,
    #[serde(default)]
    pub web_url: String,
    /// 仓库默认分支。统计提交时按它取，也用来在界面上标明「算的是哪条线」。
    /// 老数据没有这个字段，缺失时由 GitLab 按自己的默认分支返回。
    #[serde(default)]
    pub default_branch: Option<String>,
    pub link_kind: String,
    pub link_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// 日志中心的项目 ID。项目以日志中心为准，这个字段是它的身份。
    #[serde(default)]
    pub log_project_id: Option<String>,
    /// 关联的仓库/组
    #[serde(default)]
    pub links: Vec<ProjectLink>,
    /// 展开后的仓库缓存
    #[serde(default)]
    pub repos: Vec<ProjectRepo>,
    #[serde(default)]
    pub gitlab_project_id: Option<i64>,
    #[serde(default)]
    pub path_with_namespace: Option<String>,
    #[serde(default)]
    pub web_url: Option<String>,
    #[serde(default)]
    pub clone_url: Option<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    /// 开发模式：manual / ai-assisted / ai-driven。只影响有效工时的代码量修正
    #[serde(default = "default_dev_mode")]
    pub dev_mode: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_match_mode")]
    pub match_mode: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 关注标记，只影响列表默认显示，不参与检查逻辑
    #[serde(default = "default_true")]
    pub followed: bool,
    #[serde(default = "default_origin")]
    pub origin: String,
    #[serde(default = "default_sync_status")]
    pub sync_status: String,
    #[serde(default)]
    pub sync_error: Option<String>,
    #[serde(default)]
    pub synced_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_match_mode() -> String { "exact".into() }
fn default_dev_mode() -> String { "manual".into() }
fn default_origin() -> String { "manual".into() }
fn default_sync_status() -> String { "unsynced".into() }
fn default_true() -> bool { true }

const PROJECT_COLUMNS: &str = "id, name, code, description, gitlab_project_id, path_with_namespace,
     web_url, clone_url, default_branch, visibility, namespace, archived, aliases,
     match_mode, enabled, followed, origin, sync_status, sync_error, synced_at, created_at, updated_at,
     log_project_id, links, repos, dev_mode";

fn row_to_project(row: &rusqlite::Row) -> rusqlite::Result<ProjectRow> {
    let name: String = row.get(1)?;
    let gitlab_project_id: Option<i64> = row.get(4)?;
    let path_with_namespace: Option<String> = row.get(5)?;
    let web_url: Option<String> = row.get(6)?;

    let mut links: Vec<ProjectLink> = row
        .get::<_, Option<String>>(23)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut repos: Vec<ProjectRepo> = row
        .get::<_, Option<String>>(24)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    /*
     * 旧模型回退：项目改成「以日志中心为准」之前，一个项目就是一个 GitLab 仓库，
     * 身份存在 path_with_namespace 里。数组为空时用这些单值字段拼一条链接，
     * 否则升级后所有老项目都会变成「没有任何关联仓库」，检查直接失效。
     */
    if links.is_empty() {
        if let Some(path) = path_with_namespace.clone().filter(|p| !p.trim().is_empty()) {
            links.push(ProjectLink {
                kind: "repo".into(),
                path: path.clone(),
            });
            if let Some(id) = gitlab_project_id {
                repos.push(ProjectRepo {
                    id,
                    path_with_namespace: path.clone(),
                    name: name.clone(),
                    web_url: web_url.clone().unwrap_or_default(),
                    default_branch: None,
                    link_kind: "repo".into(),
                    link_path: path,
                });
            }
        }
    }

    Ok(ProjectRow {
        id: row.get(0)?,
        name,
        code: row.get(2)?,
        description: row.get(3)?,
        log_project_id: row.get(22)?,
        links,
        repos,
        dev_mode: row
            .get::<_, Option<String>>(25)?
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(default_dev_mode),
        gitlab_project_id,
        path_with_namespace,
        web_url,
        clone_url: row.get(7)?,
        default_branch: row.get(8)?,
        visibility: row.get(9)?,
        namespace: row.get(10)?,
        archived: row.get::<_, i64>(11)? != 0,
        aliases: row
            .get::<_, Option<String>>(12)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        match_mode: row.get(13)?,
        enabled: row.get::<_, i64>(14)? != 0,
        followed: row.get::<_, i64>(15)? != 0,
        origin: row.get(16)?,
        sync_status: row.get(17)?,
        sync_error: row.get(18)?,
        synced_at: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
    })
}

/// 列出项目。
///
/// 「引用次数」不在这里算：那条规则（名称 / 编码 / 别名 + matchMode）在检查引擎里，
/// 挪到前端复用同一份实现，避免两处各写一套、随着规则演进而悄悄分叉。
#[tauri::command]
pub fn projects_list(db: State<'_, Db>) -> Result<Vec<ProjectRow>, String> {
    let conn = db.lock()?;
    list_projects(&conn)
}

pub fn list_projects(conn: &rusqlite::Connection) -> Result<Vec<ProjectRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PROJECT_COLUMNS} FROM projects ORDER BY name COLLATE NOCASE"
        ))
        .map_err(|e| format!("准备查询失败：{e}"))?;

    let projects = stmt
        .query_map([], row_to_project)
        .map_err(|e| format!("查询项目失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取项目失败：{e}"))?;

    Ok(projects)
}

#[tauri::command]
pub fn projects_upsert(db: State<'_, Db>, payload: String) -> Result<String, String> {
    let project: ProjectRow =
        serde_json::from_str(&payload).map_err(|e| format!("项目数据不合法：{e}"))?;
    let conn = db.lock()?;
    upsert_project(&conn, &project, false)?;
    Ok(project.id)
}

/// 写入项目。
///
/// `from_gitlab = true` 时不动用户在界面上编辑过的字段（名称、编码、别名、启用状态）：
/// 同步是「补齐 GitLab 侧的信息」，不该把用户手工填的东西冲掉。
pub fn upsert_project(
    conn: &rusqlite::Connection,
    project: &ProjectRow,
    from_gitlab: bool,
) -> Result<(), String> {
    let ts = now_iso();
    let aliases = serde_json::to_string(&project.aliases).unwrap_or_else(|_| "[]".into());
    let links = serde_json::to_string(&project.links).unwrap_or_else(|_| "[]".into());
    let repos = serde_json::to_string(&project.repos).unwrap_or_else(|_| "[]".into());
    let created = if project.created_at.is_empty() {
        ts.clone()
    } else {
        project.created_at.clone()
    };

    let sql = if from_gitlab {
        // 名称、编码、别名、启用状态保持本地值（不存在时才用同步来的）。
        // log_project_id / links / repos 是用户配置的业务身份和关联，GitLab 同步不该碰。
        "INSERT INTO projects
           (id, name, code, description, gitlab_project_id, path_with_namespace, web_url,
            clone_url, default_branch, visibility, namespace, archived, aliases, match_mode,
            enabled, followed, origin, sync_status, sync_error, synced_at, created_at, updated_at,
            log_project_id, links, repos, dev_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
         ON CONFLICT(id) DO UPDATE SET
           description         = COALESCE(excluded.description, projects.description),
           gitlab_project_id   = excluded.gitlab_project_id,
           path_with_namespace = excluded.path_with_namespace,
           web_url             = excluded.web_url,
           clone_url           = excluded.clone_url,
           default_branch      = excluded.default_branch,
           visibility          = excluded.visibility,
           namespace           = excluded.namespace,
           archived            = excluded.archived,
           sync_status         = excluded.sync_status,
           sync_error          = excluded.sync_error,
           synced_at           = excluded.synced_at,
           updated_at          = excluded.updated_at"
    }
    else {
        "INSERT INTO projects
           (id, name, code, description, gitlab_project_id, path_with_namespace, web_url,
            clone_url, default_branch, visibility, namespace, archived, aliases, match_mode,
            enabled, followed, origin, sync_status, sync_error, synced_at, created_at, updated_at,
            log_project_id, links, repos, dev_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
         ON CONFLICT(id) DO UPDATE SET
           name                = excluded.name,
           code                = excluded.code,
           description         = excluded.description,
           gitlab_project_id   = excluded.gitlab_project_id,
           path_with_namespace = excluded.path_with_namespace,
           web_url             = excluded.web_url,
           clone_url           = excluded.clone_url,
           default_branch      = excluded.default_branch,
           visibility          = excluded.visibility,
           namespace           = excluded.namespace,
           archived            = excluded.archived,
           aliases             = excluded.aliases,
           match_mode          = excluded.match_mode,
           enabled             = excluded.enabled,
           followed            = excluded.followed,
           origin              = excluded.origin,
           sync_status         = excluded.sync_status,
           sync_error          = excluded.sync_error,
           synced_at           = excluded.synced_at,
           log_project_id      = excluded.log_project_id,
           links               = excluded.links,
           repos               = excluded.repos,
           dev_mode            = excluded.dev_mode,
           updated_at          = excluded.updated_at"
    };

    conn.execute(
        sql,
        params![
            project.id,
            project.name,
            project.code,
            project.description,
            project.gitlab_project_id,
            project.path_with_namespace,
            project.web_url,
            project.clone_url,
            project.default_branch,
            project.visibility,
            project.namespace,
            project.archived as i64,
            aliases,
            project.match_mode,
            project.enabled as i64,
            project.followed as i64,
            project.origin,
            project.sync_status,
            project.sync_error,
            project.synced_at,
            created,
            ts,
            project.log_project_id,
            links,
            repos,
            project.dev_mode,
        ],
    )
    .map_err(|e| format!("保存项目失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub fn projects_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.lock()?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| format!("删除项目失败：{e}"))?;
    Ok(())
}

/* ------------------------------------------------------------------ *
 * 与 GitLab 对账
 * ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabProjectInput {
    pub id: i64,
    pub path_with_namespace: String,
    pub name: String,
    #[serde(default)]
    pub web_url: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub ssh_url: Option<String>,
    #[serde(default)]
    pub http_url: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// 新发现并加入的项目数
    pub added: usize,
    /// 已存在、刷新了 GitLab 信息的项目数
    pub updated: usize,
    /// GitLab 上已找不到、被标记为 missing 的项目数
    pub missing: usize,
}

/// 用 GitLab 的仓库清单与本地项目表对账。
///
/// 三件事：新仓库入库、已有仓库刷新元数据、本地记录在 GitLab 上找不到的标为 missing。
/// 最后一条是关键——项目被删除或改名后检查会拉不到提交，
/// 不标出来就会被误读成「这个人当天没提交」。
#[tauri::command]
pub fn projects_sync_from_gitlab(
    db: State<'_, Db>,
    payload: String,
) -> Result<SyncOutcome, String> {
    let incoming: Vec<GitLabProjectInput> =
        serde_json::from_str(&payload).map_err(|e| format!("GitLab 项目列表不合法：{e}"))?;
    let conn = db.lock()?;
    reconcile_projects(&conn, &incoming)
}

pub fn reconcile_projects(
    conn: &rusqlite::Connection,
    incoming: &[GitLabProjectInput],
) -> Result<SyncOutcome, String> {
    let ts = now_iso();
    let mut outcome = SyncOutcome::default();

    let existing = {
        let mut stmt = conn
            .prepare(&format!("SELECT {PROJECT_COLUMNS} FROM projects"))
            .map_err(|e| format!("准备查询失败：{e}"))?;
        stmt.query_map([], row_to_project)
            .map_err(|e| format!("查询项目失败：{e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取项目失败：{e}"))?
    };

    // 用 GitLab 的项目 id 和路径两个键来认领已有记录：
    // 只按 id 匹配会漏掉「手工填了路径、还没同步过」的情况。
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();

    for remote in incoming {
        let matched = existing.iter().find(|p| {
            p.gitlab_project_id == Some(remote.id)
                || p.path_with_namespace.as_deref() == Some(remote.path_with_namespace.as_str())
        });

        let project = match matched {
            Some(local) => {
                claimed.insert(local.id.clone());
                ProjectRow {
                    gitlab_project_id: Some(remote.id),
                    path_with_namespace: Some(remote.path_with_namespace.clone()),
                    web_url: remote.web_url.clone(),
                    clone_url: remote.ssh_url.clone().or(remote.http_url.clone()),
                    default_branch: remote.default_branch.clone(),
                    visibility: remote.visibility.clone(),
                    namespace: Some(namespace_of(&remote.path_with_namespace)),
                    archived: remote.archived,
                    description: remote.description.clone(),
                    sync_status: "synced".into(),
                    sync_error: None,
                    synced_at: Some(ts.clone()),
                    ..local.clone()
                }
            }
            None => ProjectRow {
                id: format!("gl-{}", remote.id),
                name: remote.name.clone(),
                code: None,
                description: remote.description.clone(),
                // 由 GitLab 对账生成的项目没有业务身份和关联配置，
                // 读取时会按 path_with_namespace 自动拼出一条单仓库链接
                log_project_id: None,
                links: Vec::new(),
                repos: Vec::new(),
                dev_mode: default_dev_mode(),
                gitlab_project_id: Some(remote.id),
                path_with_namespace: Some(remote.path_with_namespace.clone()),
                web_url: remote.web_url.clone(),
                clone_url: remote.ssh_url.clone().or(remote.http_url.clone()),
                default_branch: remote.default_branch.clone(),
                visibility: remote.visibility.clone(),
                namespace: Some(namespace_of(&remote.path_with_namespace)),
                archived: remote.archived,
                aliases: Vec::new(),
                match_mode: default_match_mode(),
                enabled: true,
                // 新同步进来的仓库默认关注：默认全部关注是既定行为
                followed: true,
                origin: "synced".into(),
                sync_status: "synced".into(),
                sync_error: None,
                synced_at: Some(ts.clone()),
                created_at: ts.clone(),
                updated_at: ts.clone(),
            },
        };

        upsert_project(conn, &project, true)?;
        if matched.is_some() {
            outcome.updated += 1;
        } else {
            outcome.added += 1;
        }
    }

    // 有 GitLab 关联、但这次没被认领的 → 在 GitLab 上已经找不到了
    for local in &existing {
        if claimed.contains(&local.id) {
            continue;
        }
        if local.gitlab_project_id.is_none() && local.path_with_namespace.is_none() {
            continue; // 纯手工建、还没关联仓库的项目不该被标 missing
        }
        conn.execute(
            "UPDATE projects SET sync_status = 'missing',
               sync_error = '在 GitLab 上未找到（可能已被删除或改名）', updated_at = ?1
             WHERE id = ?2",
            params![ts, local.id],
        )
        .map_err(|e| format!("更新同步状态失败：{e}"))?;
        outcome.missing += 1;
    }

    Ok(outcome)
}

fn namespace_of(path_with_namespace: &str) -> String {
    path_with_namespace
        .rsplit_once('/')
        .map(|(ns, _)| ns.to_string())
        .unwrap_or_default()
}

/* ------------------------------------------------------------------ *
 * 人员
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRow {
    pub id: String,
    #[serde(default)]
    pub report_member_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub employee_no: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub gitlab_user_id: Option<i64>,
    /// 主用户名：等于 `gitlab_usernames` 的第一个元素。
    /// 保留单值字段是因为按用户名查 GitLab 用户、LDAP 对账这些地方只需要一个值。
    #[serde(default)]
    pub gitlab_username: Option<String>,
    /// 完整的 Git 提交身份列表 —— 判定「这条提交是不是他的」的依据。
    #[serde(default)]
    pub gitlab_usernames: Vec<String>,
    #[serde(default)]
    pub emails: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 关注标记，只影响列表默认显示
    #[serde(default = "default_true")]
    pub followed: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_deserializing)]
    pub usage_count: Option<i64>,
    #[serde(default, skip_deserializing)]
    pub last_report_date: Option<String>,
}

const MEMBER_COLUMNS: &str = "id, report_member_id, name, employee_no, team, role, gitlab_user_id,
     gitlab_username, emails, enabled, followed, created_at, updated_at, gitlab_usernames";

fn row_to_member(row: &rusqlite::Row) -> rusqlite::Result<MemberRow> {
    let gitlab_username: Option<String> = row.get(7)?;
    let mut gitlab_usernames: Vec<String> = row
        .get::<_, Option<String>>(13)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // 老数据没有数组列（迁移不回填），退回单值字段——
    // 否则升级后所有人的身份列表都是空的，检查会一条提交都匹配不上
    if gitlab_usernames.is_empty() {
        if let Some(primary) = gitlab_username.clone() {
            if !primary.trim().is_empty() {
                gitlab_usernames.push(primary);
            }
        }
    }

    Ok(MemberRow {
        id: row.get(0)?,
        report_member_id: row.get(1)?,
        name: row.get(2)?,
        employee_no: row.get(3)?,
        team: row.get(4)?,
        role: row.get(5)?,
        gitlab_user_id: row.get(6)?,
        gitlab_username,
        gitlab_usernames,
        emails: row
            .get::<_, Option<String>>(8)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        enabled: row.get::<_, i64>(9)? != 0,
        followed: row.get::<_, i64>(10)? != 0,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        usage_count: None,
        last_report_date: None,
    })
}

/// 列出人员，附带日报出现次数和最近日报日期。
///
/// 后者用来发现「配了人但一直没日报」或「有日报但没配」的两类错配。
#[tauri::command]
pub fn members_list(db: State<'_, Db>) -> Result<Vec<MemberRow>, String> {
    let conn = db.lock()?;
    list_members(&conn)
}

pub fn list_members(conn: &rusqlite::Connection) -> Result<Vec<MemberRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MEMBER_COLUMNS} FROM members ORDER BY name COLLATE NOCASE"
        ))
        .map_err(|e| format!("准备查询失败：{e}"))?;

    let mut members = stmt
        .query_map([], row_to_member)
        .map_err(|e| format!("查询人员失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取人员失败：{e}"))?;

    // member_id → (出现次数, 最近日期)
    let mut stats: std::collections::HashMap<String, (i64, String)> = std::collections::HashMap::new();
    let mut stmt = conn
        .prepare("SELECT member_id, COUNT(*), MAX(date) FROM daily_reports GROUP BY member_id")
        .map_err(|e| format!("准备统计失败：{e}"))?;
    for row in stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?))
        })
        .map_err(|e| format!("统计失败：{e}"))?
    {
        let (id, count, last) = row.map_err(|e| format!("读取统计失败：{e}"))?;
        stats.insert(id, (count, last.unwrap_or_default()));
    }

    for member in &mut members {
        // 日报里用的是 report_member_id，兜底再按姓名对一次
        let by_id = member
            .report_member_id
            .as_deref()
            .and_then(|id| stats.get(id));
        let by_name = stats.get(&member.name);
        if let Some((count, last)) = by_id.or(by_name) {
            member.usage_count = Some(*count);
            member.last_report_date = Some(last.clone());
        }
    }

    Ok(members)
}

#[tauri::command]
pub fn members_upsert(db: State<'_, Db>, payload: String) -> Result<String, String> {
    let member: MemberRow =
        serde_json::from_str(&payload).map_err(|e| format!("人员数据不合法：{e}"))?;
    let conn = db.lock()?;
    upsert_member(&conn, &member)?;
    Ok(member.id)
}

pub fn upsert_member(conn: &rusqlite::Connection, member: &MemberRow) -> Result<(), String> {
    let ts = now_iso();
    let emails = serde_json::to_string(&member.emails).unwrap_or_else(|_| "[]".into());
    let created = if member.created_at.is_empty() {
        ts.clone()
    } else {
        member.created_at.clone()
    };

    // 单值字段是数组的镜像。数组为空时用传进来的单值兜底——
    // 有些调用方（旧前端、导入流程）只填了单值。
    let mut usernames: Vec<String> = member
        .gitlab_usernames
        .iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    if usernames.is_empty() {
        if let Some(primary) = member
            .gitlab_username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            usernames.push(primary.to_string());
        }
    }
    let primary = usernames.first().cloned();
    let usernames_json = serde_json::to_string(&usernames).unwrap_or_else(|_| "[]".into());

    conn.execute(
        "INSERT INTO members
           (id, report_member_id, name, employee_no, team, role, gitlab_user_id,
            gitlab_username, emails, enabled, followed, created_at, updated_at, gitlab_usernames)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
           report_member_id = excluded.report_member_id,
           name             = excluded.name,
           employee_no      = excluded.employee_no,
           team             = excluded.team,
           role             = excluded.role,
           gitlab_user_id   = excluded.gitlab_user_id,
           gitlab_username  = excluded.gitlab_username,
           gitlab_usernames = excluded.gitlab_usernames,
           emails           = excluded.emails,
           enabled          = excluded.enabled,
           followed         = excluded.followed,
           updated_at       = excluded.updated_at",
        params![
            member.id,
            member.report_member_id,
            member.name,
            member.employee_no,
            member.team,
            member.role,
            member.gitlab_user_id,
            primary,
            emails,
            member.enabled as i64,
            member.followed as i64,
            created,
            ts,
            usernames_json,
        ],
    )
    .map_err(|e| format!("保存人员失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub fn members_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.lock()?;
    conn.execute("DELETE FROM members WHERE id = ?1", params![id])
        .map_err(|e| format!("删除人员失败：{e}"))?;
    Ok(())
}

/// 批量写入人员（从日报里导入用）。返回写入条数。
#[tauri::command]
pub fn members_import(db: State<'_, Db>, payload: String) -> Result<usize, String> {
    let members: Vec<MemberRow> =
        serde_json::from_str(&payload).map_err(|e| format!("人员列表不合法：{e}"))?;
    let conn = db.lock()?;
    let mut n = 0;
    for member in &members {
        upsert_member(&conn, member)?;
        n += 1;
    }
    Ok(n)
}
