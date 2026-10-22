use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

pub mod commands;
pub mod entities;
pub mod profiles;
pub use commands::*;
pub use entities::*;
pub use profiles::*;

/// 数据库连接。
///
/// 单连接 + Mutex 而不是连接池：这是个单用户的桌面应用，
/// 并发来源只有前端零星的读写和一次检查里的顺序写入，池化只会增加复杂度。
/// 真出现慢查询再换成池也不迟。
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let path = db_path(app)?;
        // 把解析出来的路径打出来。「数据库看起来是空的」这类问题，
        // 十有八九是打开的文件和预期的不是同一个（比如被环境重定向了），
        // 有这一行就不用再猜。
        log::info!("数据库位置：{}", path.display());
        Self::open_at(path)
    }

    /// 从指定路径打开。单独拆出来是为了让测试能开一个临时库，
    /// 完整跑一遍建表、迁移和查询。
    pub fn open_at(path: PathBuf) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
        }
        let conn = Connection::open(&path).map_err(|e| format!("打开数据库失败：{e}"))?;
        Self::from_connection(conn)
    }

    /// 内存库。测试与命令行诊断工具用，不落盘。
    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("创建内存库失败：{e}"))?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> Result<Self, String> {
        // WAL 让读写不互相阻塞；外键约束默认是关的，必须显式打开，
        // 否则 ON DELETE CASCADE 不会生效。
        // 内存库不支持 WAL，报错忽略即可。
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("开启外键约束失败：{e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("设置同步模式失败：{e}"))?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "数据库连接被占用（上一次操作可能已崩溃）".to_string())
    }

    /// 按 SCHEMA 里的版本号逐版升级。
    ///
    /// 每个版本一个事务，中途失败会整体回滚，不会留下升级到一半的库。
    fn migrate(&self) -> Result<(), String> {
        let mut conn = self.lock()?;

        conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .map_err(|e| format!("初始化 meta 表失败：{e}"))?;

        let current: i64 = conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| {
                row.get::<_, String>(0)
            })
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        for (version, sql) in MIGRATIONS {
            if *version <= current {
                continue;
            }
            let tx = conn.transaction().map_err(|e| format!("开启迁移事务失败：{e}"))?;
            tx.execute_batch(sql)
                .map_err(|e| format!("迁移到 v{version} 失败：{e}"))?;
            tx.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [version.to_string()],
            )
            .map_err(|e| format!("记录 schema 版本失败：{e}"))?;
            tx.commit().map_err(|e| format!("提交迁移失败：{e}"))?;
            log::info!("数据库已迁移到 v{version}");
        }

        Ok(())
    }
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    Ok(dir.join("task-inspector.db"))
}

/// 迁移脚本。**只追加，不修改已发布的版本**——已经升级过的库不会重跑旧版本，
/// 改旧脚本只会让新旧安装出现不一致的 schema。
///
/// v1 一次建齐所有表，包括暂时不写入的 commits / embeddings：
/// 后面加向量检索时就不用再动迁移，而且这两张表的形状现在就能定下来。
const MIGRATIONS: &[(i64, &str)] = &[(
    1,
    r#"
    -- 配置：整体存 JSON。配置项增删频繁，拆成列会让每次加字段都要迁移，
    -- 而它只有一行、永远整读整写，没有查询需求。
    CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 日报。entries 拆成独立的表，因为后续要做「按项目/按人跨日期检索」，
    -- 塞在 JSON 里就只能全表扫出来在内存里过滤。
    CREATE TABLE daily_reports (
      id           TEXT PRIMARY KEY,
      date         TEXT NOT NULL,
      member_id    TEXT NOT NULL,
      member_name  TEXT NOT NULL,
      total_hours  REAL NOT NULL DEFAULT 0,
      submitted_at TEXT,
      imported_at  TEXT NOT NULL,
      UNIQUE (date, member_id)
    );
    CREATE INDEX idx_reports_date   ON daily_reports (date);
    CREATE INDEX idx_reports_member ON daily_reports (member_id, date);

    CREATE TABLE report_entries (
      id           TEXT PRIMARY KEY,
      report_id    TEXT NOT NULL REFERENCES daily_reports (id) ON DELETE CASCADE,
      project_name TEXT NOT NULL,
      project_code TEXT,
      hours        REAL NOT NULL DEFAULT 0,
      content      TEXT NOT NULL,
      task_refs    TEXT
    );
    CREATE INDEX idx_entries_report  ON report_entries (report_id);
    CREATE INDEX idx_entries_project ON report_entries (project_name);

    -- 检查结果。摘要列单独出来供历史列表和统计查询，
    -- 完整结果（逐条判定、证据、漏报、结论文本）整体存 JSON 载荷。
    CREATE TABLE inspections (
      date          TEXT NOT NULL,
      member_id     TEXT NOT NULL,
      member_name   TEXT NOT NULL,
      score         REAL NOT NULL,
      checked_hours REAL NOT NULL,
      total_hours   REAL NOT NULL,
      orphan_count  INTEGER NOT NULL,
      model         TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      payload       TEXT NOT NULL,
      PRIMARY KEY (date, member_id)
    );
    CREATE INDEX idx_inspections_date   ON inspections (date);
    CREATE INDEX idx_inspections_member ON inspections (member_id, date);

    -- 提交缓存：同一时间窗重复检查时不再打 GitLab，
    -- 也是后面做向量检索的语料来源。
    CREATE TABLE commits (
      id             TEXT PRIMARY KEY,
      project_id     INTEGER NOT NULL,
      project_path   TEXT NOT NULL,
      title          TEXT NOT NULL,
      message        TEXT NOT NULL,
      author_name    TEXT NOT NULL,
      author_email   TEXT NOT NULL,
      authored_date  TEXT NOT NULL,
      committed_date TEXT NOT NULL,
      web_url        TEXT NOT NULL,
      additions      INTEGER,
      deletions      INTEGER,
      files          TEXT,
      fetched_at     TEXT NOT NULL
    );
    CREATE INDEX idx_commits_window  ON commits (authored_date);
    CREATE INDEX idx_commits_project ON commits (project_id, authored_date);
    CREATE INDEX idx_commits_email   ON commits (author_email, authored_date);

    -- 向量表。保留但暂未启用：见下方 FTS5 的说明。
    -- vec 存 f32 小端字节序列，按 (owner_type, model) 分组做暴力余弦。
    CREATE TABLE embeddings (
      owner_type TEXT NOT NULL,
      owner_id   TEXT NOT NULL,
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vec        BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_type, owner_id, model)
    );
    CREATE INDEX idx_embeddings_owner ON embeddings (owner_type, model);

    -- ------------------------------------------------------------------
    -- 全文检索。用 FTS5 + BM25，而不是向量。
    --
    -- 原因是向量检索需要额外的 embedding 服务（内网不一定有），
    -- 而 FTS5 是 SQLite 内置的，零依赖、离线可用，BM25 本身就是个
    -- 足够好的相关性排序。真需要语义召回时再启用上面的 embeddings 表，
    -- 用 RRF 之类的方式把两路结果融合，检索接口不用变。
    --
    -- 分词器必须用 trigram：默认的 unicode61 按空格/标点切词，
    -- 中文整句会被当成一个词，等于搜不到。trigram 对任意三字符组合建索引，
    -- 中文子串（「支付回调」）和驼峰标识符（payCallback）都能命中。
    -- 代价是查询词至少要 3 个字符，短查询得在应用层退回 LIKE。
    -- ------------------------------------------------------------------

    CREATE VIRTUAL TABLE commits_fts USING fts5(
      title, message, files, project_path,
      content = 'commits',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    );

    CREATE TRIGGER commits_fts_ai AFTER INSERT ON commits BEGIN
      INSERT INTO commits_fts (rowid, title, message, files, project_path)
      VALUES (new.rowid, new.title, new.message, new.files, new.project_path);
    END;

    CREATE TRIGGER commits_fts_ad AFTER DELETE ON commits BEGIN
      INSERT INTO commits_fts (commits_fts, rowid, title, message, files, project_path)
      VALUES ('delete', old.rowid, old.title, old.message, old.files, old.project_path);
    END;

    CREATE TRIGGER commits_fts_au AFTER UPDATE ON commits BEGIN
      INSERT INTO commits_fts (commits_fts, rowid, title, message, files, project_path)
      VALUES ('delete', old.rowid, old.title, old.message, old.files, old.project_path);
      INSERT INTO commits_fts (rowid, title, message, files, project_path)
      VALUES (new.rowid, new.title, new.message, new.files, new.project_path);
    END;

    -- 日报条目的检索索引。用「项目名 + 工作内容」作为检索文本，
    -- 用于「这个提交像不像某条日报描述」以及跨日期的历史检索。
    --
    -- 没有用 external content：日报是整批重写的（见 reports_upsert），
    -- 独立索引比维护同步触发器简单；entry_id / report_id 标成 UNINDEXED，
    -- 只做关联用，不进倒排表。
    CREATE VIRTUAL TABLE report_entries_fts USING fts5(
      entry_id UNINDEXED,
      report_id UNINDEXED,
      project_name,
      content,
      tokenize = 'trigram'
    );
    "#,
   ),
   (
    2,
    r#"
    -- ------------------------------------------------------------------
    -- 项目与人员升级为一等实体。
    --
    -- 原先它们只是 settings 里的一组映射规则（日报名 → GitLab 路径），
    -- 项目本身没有实体。但日报里本来就带 projectCode，说明「项目」这个概念
    -- 在两端都被引用，应该有自己的身份和生命周期（可能被删除、可能归档）。
    --
    -- 映射关系并入实体：日报里写的名字/编码/别名就是项目自己的匹配键，
    -- 不再单独维护一份「映射表」，避免同一件事要在两个地方改。
    -- ------------------------------------------------------------------

    CREATE TABLE projects (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      code                TEXT,
      description         TEXT,
      gitlab_project_id   INTEGER,
      path_with_namespace TEXT,
      web_url             TEXT,
      clone_url           TEXT,
      default_branch      TEXT,
      visibility          TEXT,
      namespace           TEXT,
      archived            INTEGER NOT NULL DEFAULT 0,
      -- 日报里可能用别的叫法写这个项目，存 JSON 数组
      aliases             TEXT,
      match_mode          TEXT NOT NULL DEFAULT 'exact',
      enabled             INTEGER NOT NULL DEFAULT 1,
      -- manual = 手工建的，synced = 从 GitLab 同步进来的
      origin              TEXT NOT NULL DEFAULT 'manual',
      -- unsynced 还没同步过 | synced 正常 | missing GitLab 上已找不到（被删或改名）
      -- | error 同步时请求失败
      sync_status         TEXT NOT NULL DEFAULT 'unsynced',
      sync_error          TEXT,
      synced_at           TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX idx_projects_gitlab ON projects (gitlab_project_id);
    CREATE INDEX idx_projects_path   ON projects (path_with_namespace);
    CREATE INDEX idx_projects_name   ON projects (name);

    CREATE TABLE members (
      id               TEXT PRIMARY KEY,
      -- 日报系统里的用户 ID，是跟日报对上的关键
      report_member_id TEXT,
      name             TEXT NOT NULL,
      employee_no      TEXT,
      team             TEXT,
      role             TEXT,
      gitlab_user_id   INTEGER,
      gitlab_username  TEXT,
      -- 用于匹配提交 author_email，存 JSON 数组
      emails           TEXT,
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_members_name      ON members (name);
    CREATE INDEX idx_members_report_id ON members (report_member_id);
    CREATE INDEX idx_members_username  ON members (gitlab_username);
    "#,
   ),
   (
    3,
    r#"
    -- 记录「上一次同步从 LDAP 拿到的那批邮箱」。
    --
    -- 原先同步是往 emails 里合并，目的是不覆盖手工加的别名邮箱，
    -- 但副作用是 LDAP 里改掉或删掉的邮箱永远不会被清走——
    -- 目录侧把重复邮箱改好了，本地却还挂着冲突提示。
    --
    -- 有了这一列就能区分来源：同步时先移除上次 LDAP 给的那批，再加上这次的，
    -- 手工维护的邮箱（从没出现在这一列里的）原样保留。
    ALTER TABLE members ADD COLUMN ldap_emails TEXT;

    -- 升级前没有这一列，无法区分来源。这批数据都是刚同步进来的，
    -- 全部按 LDAP 来源处理，之后的同步才能正确清理。
    UPDATE members SET ldap_emails = emails;
    "#,
   ),
   (
    4,
    r#"
    -- 关注标记。
    --
    -- 和 enabled（是否参与检查）是两回事：这里是「平时关不关心它」，
    -- 只影响列表默认显不显示。所以可以关注一个暂时停用的项目，
    -- 也可以让一个仍在参与检查但已经交接出去的项目从视野里淡出。
    --
    -- 默认全部关注：新装的人不会一上来看到空列表。
    ALTER TABLE projects ADD COLUMN followed INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE members  ADD COLUMN followed INTEGER NOT NULL DEFAULT 1;
    "#,
   ),
   (
    5,
    r#"
    -- 一个人可能对应多个 Git 提交身份。
    --
    -- 现实里同一个人会在不同机器、不同仓库里用不同的用户名提交：本机 git config
    -- 没配、换过账号、用了中文名。只认一个名字必然漏提交，而漏提交会被判成
    -- 「日报写了但没提交」，方向完全反了。
    --
    -- 这里存完整的用户名列表（JSON 数组）。gitlab_username 保留为列表的第一个元素，
    -- 因为按用户名查 GitLab 用户、LDAP 对账这些地方只需要一个值。
    -- 老数据不回填：读取时数组为空会退回 gitlab_username 那一个值。
    ALTER TABLE members ADD COLUMN gitlab_usernames TEXT;
    "#,
   ),
   (
    6,
    r#"
    -- 项目改成以日志中心为准。
    --
    -- 之前一个项目就是一个 GitLab 仓库；现在项目是业务实体（来自日志中心），
    -- 一个项目可以关联多个仓库，也可以整组关联（扫描子组）。
    --
    -- links 存关联方式，repos 存展开后的仓库缓存——展开要调 GitLab，
    -- 不该每次检查都做一遍。旧数据不回填：读取时如果两者都为空、
    -- 而 path_with_namespace 有值，会自动拼出一条「单仓库」链接。
    ALTER TABLE projects ADD COLUMN log_project_id TEXT;
    ALTER TABLE projects ADD COLUMN links TEXT;
    ALTER TABLE projects ADD COLUMN repos TEXT;
    "#,
   ),
   (
    // 版本号从 7 开始而不是接在 6 后面：v7 曾被一个后来撤掉的需求占用过，
    // 已经升级过的库把 schema_version 记成了 7。迁移只追加不修改，
    // 所以这里直接跳到 8，免得这批库把画像建表跳过。
    8,
    r#"
    -- 项目画像。
    --
    -- 一个业务项目可能对应多个仓库，所以按 (项目, 仓库) 存一条。
    -- payload 是完整的画像 JSON（模块划分、每个模块的职责、热点、整体叙述），
    -- 生成一次成本不低（要读代码 + 调模型），按 head_commit 判断是否需要重算。
    CREATE TABLE project_profiles (
      project_id   TEXT    NOT NULL,
      repo_id      INTEGER NOT NULL,
      generated_at TEXT    NOT NULL,
      head_commit  TEXT,
      payload      TEXT    NOT NULL,
      PRIMARY KEY (project_id, repo_id)
    );
    "#,
   ),
   (
    9,
    r#"
    -- 项目开发模式：manual / ai-assisted / ai-driven。
    --
    -- 只影响「有效工时」估算里代码量的修正权重：AI 开发的项目一天几千行是常态，
    -- 按行数线性折算会把人推到十几小时。默认 manual，由人按项目标注。
    ALTER TABLE projects ADD COLUMN dev_mode TEXT;
    "#,
   ),
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn db() -> Db {
        Db::open_memory().expect("打开内存库失败")
    }

    /// 返回 Value 而不是 String：调用方要用 json!([...]) 组数组，
    /// 如果这里返回字符串，数组里装的就会是字符串而不是对象。
    fn commit_json(id: &str, title: &str, message: &str, project_path: &str, files: &[&str]) -> Value {
        serde_json::json!({
            "id": id,
            "projectId": 101,
            "projectPath": project_path,
            "title": title,
            "message": message,
            "authorName": "张伟",
            "authorEmail": "zhangwei@corp.com",
            "authoredDate": "2026-10-16T10:23:00+08:00",
            "committedDate": "2026-10-16T10:23:00+08:00",
            "webUrl": format!("https://gitlab.example.com/c/{id}"),
            "stats": { "additions": 10, "deletions": 2, "total": 12 },
            "fileChanges": files.iter().map(|f| serde_json::json!({ "path": f })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn migration_creates_all_tables() {
        let database = db();
        let conn = database.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        for expected in [
            "settings",
            "daily_reports",
            "report_entries",
            "inspections",
            "commits",
            "embeddings",
            "commits_fts",
            "report_entries_fts",
            "meta",
        ] {
            assert!(names.iter().any(|n| n == expected), "缺少表 {expected}，实际有 {names:?}");
        }
    }

    #[test]
    fn reports_round_trip_preserves_chinese_and_entries() {
        let database = db();
        let mut conn = database.lock().unwrap();

        let payload = serde_json::json!([{
            "id": "u1001@2026-10-16",
            "date": "2026-10-16",
            "memberId": "u1001",
            "memberName": "张伟",
            "totalHours": 8,
            "entries": [
                { "id": "e1", "projectName": "统一支付平台", "hours": 5,
                  "content": "重构支付回调重试逻辑，修复超时导致的重复扣款问题", "taskRefs": ["PAY-1"] },
                { "id": "e2", "projectName": "内部管理后台", "hours": 3,
                  "content": "新增对账报表页面" }
            ]
        }])
        .to_string();

        assert_eq!(insert_reports(&mut conn, "2026-10-16", &payload).unwrap(), 1);

        let reports = load_reports(&conn, &["2026-10-16".to_string()]).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["memberName"], "张伟");
        assert_eq!(reports[0]["entries"].as_array().unwrap().len(), 2);
        assert_eq!(reports[0]["entries"][0]["projectName"], "统一支付平台");
        assert_eq!(reports[0]["entries"][0]["taskRefs"][0], "PAY-1");

        // 同一天重写应当替换而不是追加
        insert_reports(&mut conn, "2026-10-16", &payload).unwrap();
        let again = load_reports(&conn, &["2026-10-16".to_string()]).unwrap();
        assert_eq!(again.len(), 1, "重复写入同一天不应产生重复日报");

        let dates = {
            let mut stmt = conn
                .prepare("SELECT DISTINCT date FROM daily_reports")
                .unwrap();
            let v: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            v
        };
        assert_eq!(dates, vec!["2026-10-16"]);
    }

    #[test]
    fn bm25_matches_chinese_phrase_and_code_identifier() {
        let database = db();
        let mut conn = database.lock().unwrap();

        let payload = serde_json::json!([
            commit_json("sha1", "修复支付回调超时导致的重复扣款", "引入幂等表", "pay", &["src/pay/callback.ts"]),
            commit_json("sha2", "更新 CI 流水线缓存策略", "", "ci", &[".gitlab-ci.yml"]),
            commit_json("sha3", "调整第三方通道超时配置", "", "cfg", &["config/channel.yaml"]),
        ])
        .to_string();
        insert_commits(&mut conn, &payload).unwrap();

        // 中文词组命中（trigram 分词器的关键用途：默认分词器搜不到中文）
        let hits = search_hybrid_in(&conn, "支付回调", None, None, 10).unwrap();
        assert_eq!(hits.len(), 1, "中文查询应命中一条，实际 {:?}", hits);
        assert_eq!(hits[0].id, "sha1");
        assert!(hits[0].sources.contains(&"bm25".to_string()));

        // 文件名里的标识符命中（files 也在索引里）
        let hits = search_hybrid_in(&conn, "callback.ts", None, None, 10).unwrap();
        assert_eq!(hits[0].id, "sha1");

        // 无关键词查询返回空，而不是报错
        assert!(search_hybrid_in(&conn, "   ", None, None, 10).unwrap().is_empty());

        // 短查询（< 3 字符，trigram 不支持）应退回 LIKE 而不是静默返回空
        let hits = search_hybrid_in(&conn, "CI", None, None, 10).unwrap();
        assert_eq!(hits.len(), 1, "两字查询应走 LIKE 回退，实际 {:?}", hits);
        assert_eq!(hits[0].id, "sha2");
    }

    #[test]
    fn hybrid_fuses_vector_hits_that_bm25_misses() {
        let database = db();
        let mut conn = database.lock().unwrap();

        // sha1 的用词与查询毫无字面重叠，BM25 一定召回不到
        let payload = serde_json::json!([
            commit_json("sha1", "修复超时问题", "补充退避", "pay", &["src/pay/retry.ts"]),
            commit_json("sha2", "更新 CI 流水线", "", "ci", &[".gitlab-ci.yml"]),
        ])
        .to_string();
        insert_commits(&mut conn, &payload).unwrap();

        insert_embeddings(
            &conn,
            vec![
                EmbeddingRow {
                    owner_type: "commit".into(),
                    owner_id: "sha1".into(),
                    model: "test-model".into(),
                    vec: vec![1.0, 0.0, 0.0, 0.0],
                },
                EmbeddingRow {
                    owner_type: "commit".into(),
                    owner_id: "sha2".into(),
                    model: "test-model".into(),
                    vec: vec![0.0, 1.0, 0.0, 0.0],
                },
            ],
        )
        .unwrap();

        // 查询词只和 sha1 的向量接近，字面上毫无重叠
        let query_vec = vec![0.99f32, 0.01, 0.0, 0.0];
        let hits = search_hybrid_in(&conn, "订单重复扣款", Some(&query_vec), Some("test-model"), 10).unwrap();

        assert!(!hits.is_empty(), "向量路应召回 sha1");
        assert_eq!(hits[0].id, "sha1");
        assert!(
            hits[0].sources.contains(&"vector".to_string()),
            "命中来源应包含 vector，实际 {:?}",
            hits[0].sources
        );
        assert!(
            !hits[0].sources.contains(&"bm25".to_string()),
            "该查询不该有字面命中，实际 {:?}",
            hits[0].sources
        );

        // 维度不匹配的旧向量应被跳过而不是算出错误分数
        insert_embeddings(
            &conn,
            vec![EmbeddingRow {
                owner_type: "commit".into(),
                owner_id: "sha2".into(),
                model: "other-model".into(),
                vec: vec![1.0, 0.0],
            }],
        )
        .unwrap();
        let hits = search_hybrid_in(&conn, "订单重复扣款", Some(&query_vec), Some("other-model"), 10).unwrap();
        assert!(hits.is_empty(), "维度不匹配时应跳过，实际 {:?}", hits);
    }

    #[test]
    fn inspections_stats_and_prune() {
        let database = db();
        let conn = database.lock().unwrap();

        let insert = |date: &str, member: &str, score: f64, checked: f64, orphans: i64| {
            let payload = serde_json::json!({
                "id": format!("{member}@{date}"),
                "date": date,
                "memberId": member,
                "memberName": member,
                "summary": {
                    "score": score, "checkedHours": checked, "totalHours": 8,
                    "orphanCommitCount": orphans
                },
                "meta": { "model": "test", "createdAt": format!("{date}T10:00:00.000Z") }
            })
            .to_string();
            insert_inspection(&conn, &payload).unwrap();
        };

        insert("2020-01-02", "u1001", 100.0, 8.0, 1);
        insert("2020-01-02", "u1002", 0.0, 0.0, 0);
        insert("2020-01-01", "u1001", 50.0, 8.0, 0);

        let stats = stats_by_date_in(&conn, None, None).unwrap();
        assert_eq!(stats.len(), 2);

        let day = stats.iter().find(|s| s.date == "2020-01-02").unwrap();
        assert_eq!(day.members, 2);
        // u1002 的 checked_hours 为 0（当日只有会议类工作），不该拉低平均分
        assert_eq!(day.scored_members, 1);
        assert_eq!(day.avg_score, Some(100.0));
        assert_eq!(day.orphan_count, 1);

        // 只查某一天
        let stats = stats_by_date_in(&conn, Some("2020-01-02"), Some("2020-01-02")).unwrap();
        assert_eq!(stats.len(), 1);

        // keep_days = 0 表示永久保留，不做任何删除
        assert_eq!(prune_inspections(&conn, 0).unwrap(), 0);
        assert_eq!(stats_by_date_in(&conn, None, None).unwrap().len(), 2);

        // 保留 30 天：测试数据是 2020 年的，会被全部清掉
        assert_eq!(prune_inspections(&conn, 30).unwrap(), 3);
        assert!(stats_by_date_in(&conn, None, None).unwrap().is_empty());
    }

    #[test]
    fn project_sync_reconciles_new_updated_and_missing() {
        let database = db();
        let conn = database.lock().unwrap();

        let make = |id: &str, name: &str, gl: Option<i64>, path: Option<&str>| ProjectRow {
            id: id.into(),
            name: name.into(),
            code: None,
            description: None,
            log_project_id: None,
            links: vec![],
            repos: vec![],
            dev_mode: "manual".into(),
            gitlab_project_id: gl,
            path_with_namespace: path.map(str::to_string),
            web_url: None,
            clone_url: None,
            default_branch: None,
            visibility: None,
            namespace: None,
            archived: false,
            aliases: vec![],
            match_mode: "exact".into(),
            enabled: true,
            followed: true,
            origin: "manual".into(),
            sync_status: "unsynced".into(),
            sync_error: None,
            synced_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        // 已有：一个已经关联了 GitLab 仓库的项目
        upsert_project(&conn, &make("p1", "统一支付平台", Some(101), Some("rd/pay")), false).unwrap();
        // 已有：一个只在 GitLab 上被删掉的项目
        upsert_project(&conn, &make("p2", "已删除的项目", Some(999), Some("rd/gone")), false).unwrap();
        // 已有：纯手工建、还没关联仓库的项目，不该被标 missing
        upsert_project(&conn, &make("p3", "待关联", None, None), false).unwrap();

        let incoming = vec![
            // 已存在，路径被改名
            GitLabProjectInput {
                id: 101,
                path_with_namespace: "rd-platform/pay".into(),
                name: "payment-gateway".into(),
                web_url: Some("https://gl/rd-platform/pay".into()),
                description: Some("支付网关".into()),
                default_branch: Some("main".into()),
                visibility: Some("private".into()),
                archived: false,
                ssh_url: Some("git@gl:rd-platform/pay.git".into()),
                http_url: None,
            },
            // 新仓库
            GitLabProjectInput {
                id: 202,
                path_with_namespace: "rd-platform/risk".into(),
                name: "risk-engine".into(),
                web_url: Some("https://gl/rd-platform/risk".into()),
                description: None,
                default_branch: Some("master".into()),
                visibility: None,
                archived: true,
                ssh_url: None,
                http_url: Some("https://gl/rd-platform/risk.git".into()),
            },
        ];

        let outcome = reconcile_projects(&conn, &incoming).unwrap();
        assert_eq!(outcome.added, 1, "应新增 1 个仓库");
        assert_eq!(outcome.updated, 1, "应更新 1 个已有仓库");
        assert_eq!(outcome.missing, 1, "应有 1 个项目在 GitLab 上找不到");

        let projects = list_projects(&conn).unwrap();
        let by_id = |id: &str| projects.iter().find(|p| p.id == id).unwrap();

        // 已有项目：GitLab 侧的元数据被刷新，但本地名称没有被冲掉
        let p1 = by_id("p1");
        assert_eq!(p1.name, "统一支付平台", "同步不应覆盖用户手工填的名称");
        assert_eq!(p1.path_with_namespace.as_deref(), Some("rd-platform/pay"));
        assert_eq!(p1.namespace.as_deref(), Some("rd-platform"));
        assert_eq!(p1.sync_status, "synced");
        assert_eq!(p1.clone_url.as_deref(), Some("git@gl:rd-platform/pay.git"));

        // 被删除的项目
        let p2 = by_id("p2");
        assert_eq!(p2.sync_status, "missing");
        assert!(p2.sync_error.is_some());

        // 纯手工项目不受影响
        assert_eq!(by_id("p3").sync_status, "unsynced");

        // 新仓库入库，并带上归档标记
        let added = projects.iter().find(|p| p.gitlab_project_id == Some(202)).unwrap();
        assert_eq!(added.origin, "synced");
        assert!(added.archived);
        assert_eq!(added.clone_url.as_deref(), Some("https://gl/rd-platform/risk.git"));

        // 再同步一次不应重复新增
        let again = reconcile_projects(&conn, &incoming).unwrap();
        assert_eq!(again.added, 0, "重复同步不应产生重复项目");
        assert_eq!(list_projects(&conn).unwrap().len(), 4);
    }

    #[test]
    fn member_usage_and_last_report_date() {
        let database = db();
        let mut conn = database.lock().unwrap();

        let payload = serde_json::json!([{
            "id": "u1@2026-10-16", "date": "2026-10-16", "memberId": "u1",
            "memberName": "张伟", "totalHours": 8,
            "entries": [{ "id": "e1", "projectName": "支付平台", "hours": 8, "content": "a" }]
        }])
        .to_string();
        insert_reports(&mut conn, "2026-10-16", &payload).unwrap();

        let base = MemberRow {
            id: "m1".into(),
            report_member_id: Some("u1".into()),
            name: "张伟".into(),
            employee_no: None,
            team: None,
            role: None,
            gitlab_user_id: None,
            gitlab_username: Some("zhangwei".into()),
            // 故意留空：验证「只填了单值」的老调用方仍然能用
            gitlab_usernames: vec![],
            emails: vec!["zhangwei@corp.com".into()],
            enabled: true,
            followed: true,
            created_at: String::new(),
            updated_at: String::new(),
            last_report_date: None,
            usage_count: None,
        };
        upsert_member(&conn, &base).unwrap();

        let mut unbound = base.clone();
        unbound.id = "m2".into();
        unbound.report_member_id = Some("u2".into());
        unbound.name = "李娜".into();
        unbound.emails = vec![];
        upsert_member(&conn, &unbound).unwrap();

        let members = list_members(&conn).unwrap();
        let zw = members.iter().find(|m| m.id == "m1").unwrap();
        assert_eq!(zw.usage_count, Some(1));
        assert_eq!(zw.last_report_date.as_deref(), Some("2026-10-16"));
        assert_eq!(zw.emails, vec!["zhangwei@corp.com".to_string()]);

        let ln = members.iter().find(|m| m.id == "m2").unwrap();
        assert_eq!(ln.usage_count, None, "没有日报的人不该有引用次数");
    }

    #[test]
    fn followed_flag_survives_sync_and_round_trips() {
        let database = db();
        let conn = database.lock().unwrap();

        let project = ProjectRow {
            id: "p1".into(),
            name: "已交接出去的项目".into(),
            code: None,
            description: None,
            log_project_id: None,
            links: vec![],
            repos: vec![],
            dev_mode: "ai-assisted".into(),
            gitlab_project_id: Some(101),
            path_with_namespace: Some("rd/legacy".into()),
            web_url: None,
            clone_url: None,
            default_branch: None,
            visibility: None,
            namespace: None,
            archived: false,
            aliases: vec![],
            match_mode: "exact".into(),
            enabled: true,
            followed: false,
            origin: "manual".into(),
            sync_status: "unsynced".into(),
            sync_error: None,
            synced_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        upsert_project(&conn, &project, false).unwrap();
        assert!(!list_projects(&conn).unwrap()[0].followed, "取消关注应被持久化");
        assert_eq!(
            list_projects(&conn).unwrap()[0].dev_mode,
            "ai-assisted",
            "开发模式应被持久化"
        );

        // 从 GitLab 同步不应把用户的关注选择冲掉：同步只补齐仓库信息
        reconcile_projects(
            &conn,
            &[GitLabProjectInput {
                id: 101,
                path_with_namespace: "rd/legacy".into(),
                name: "legacy".into(),
                web_url: None,
                description: None,
                default_branch: None,
                visibility: None,
                archived: false,
                ssh_url: None,
                http_url: None,
            }],
        )
        .unwrap();
        assert!(
            !list_projects(&conn).unwrap()[0].followed,
            "同步不该改变关注状态"
        );
        assert_eq!(
            list_projects(&conn).unwrap()[0].dev_mode,
            "ai-assisted",
            "GitLab 同步不该改变开发模式"
        );

        // 新同步进来的仓库默认关注
        reconcile_projects(
            &conn,
            &[GitLabProjectInput {
                id: 202,
                path_with_namespace: "rd/brand-new".into(),
                name: "brand-new".into(),
                web_url: None,
                description: None,
                default_branch: None,
                visibility: None,
                archived: false,
                ssh_url: None,
                http_url: None,
            }],
        )
        .unwrap();
        let newbie = list_projects(&conn)
            .unwrap()
            .into_iter()
            .find(|p| p.gitlab_project_id == Some(202))
            .unwrap();
        assert!(newbie.followed, "新项目应默认关注");

        // 人员同理
        let member = MemberRow {
            id: "m1".into(),
            report_member_id: None,
            name: "张三".into(),
            employee_no: None,
            team: None,
            role: None,
            gitlab_user_id: None,
            gitlab_username: Some("zhangsan".into()),
            gitlab_usernames: vec![],
            emails: vec![],
            enabled: true,
            followed: false,
            created_at: String::new(),
            updated_at: String::new(),
            last_report_date: None,
            usage_count: None,
        };
        upsert_member(&conn, &member).unwrap();
        assert!(
            !list_members(&conn).unwrap()[0].followed,
            "人员的关注状态也要能持久化"
        );
    }

    #[test]
    fn deleting_a_report_cascades_to_entries_and_index() {
        let database = db();
        let mut conn = database.lock().unwrap();

        let payload = serde_json::json!([{
            "id": "u1001@2026-10-16", "date": "2026-10-16",
            "memberId": "u1001", "memberName": "张伟", "totalHours": 5,
            "entries": [{ "id": "e1", "projectName": "统一支付平台", "hours": 5, "content": "支付回调重构" }]
        }])
        .to_string();
        insert_reports(&mut conn, "2026-10-16", &payload).unwrap();

        let count = |conn: &rusqlite::Connection, table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(count(&conn, "report_entries"), 1);
        assert_eq!(count(&conn, "report_entries_fts"), 1);

        // 重写同一天：条目表靠外键级联清掉，检索索引是独立表，由 insert_reports 显式清理
        insert_reports(&mut conn, "2026-10-16", &payload).unwrap();
        assert_eq!(count(&conn, "report_entries"), 1, "重写不应累积条目");
        assert_eq!(count(&conn, "report_entries_fts"), 1, "检索索引不应累积");
    }
}
