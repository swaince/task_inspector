use std::time::Duration;

use ldap3::adapters::PagedResults;
use ldap3::{LdapConn, LdapConnSettings, Scope, SearchEntry};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::db::commands::now_iso;

/// LDAP 人员同步。
///
/// 人员的主数据源是目录服务，所以这里做的是「拉全量 + 与本地表对账」，
/// 而不是让人一条条手录。
///
/// 连接由 Rust 发起：LDAP 是二进制协议，浏览器连不了；
/// 而且服务账号密码留在 Rust 侧，不进 webview。

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LdapConfig {
    pub enabled: bool,
    pub url: String,
    pub bind_dn: String,
    pub bind_password: String,
    pub base_dn: String,
    pub user_filter: String,
    #[serde(default = "default_page_size")]
    pub page_size: i32,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub allow_insecure_tls: bool,
    pub attribute_map: AttributeMap,
}

fn default_page_size() -> i32 { 500 }
fn default_timeout() -> u64 { 30 }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeMap {
    pub username: String,
    pub name: String,
    pub email: String,
    pub employee_no: String,
    pub department: String,
    pub title: String,
}

#[derive(Debug, Clone, Default)]
pub struct LdapPerson {
    pub username: String,
    pub name: String,
    pub email: Option<String>,
    pub employee_no: Option<String>,
    pub department: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSyncOutcome {
    pub added: usize,
    pub updated: usize,
    /// 缺少必要属性（没有姓名或登录名）被跳过的条目
    pub skipped: usize,
}

/// 从 LDAP 拉取人员并与本地人员表对账。
#[tauri::command]
pub async fn ldap_sync(
    db: State<'_, Db>,
    payload: String,
) -> Result<MemberSyncOutcome, String> {
    let config: LdapConfig =
        serde_json::from_str(&payload).map_err(|e| format!("LDAP 配置不合法：{e}"))?;

    if !config.enabled {
        return Err("LDAP 未启用".to_string());
    }
    if config.url.trim().is_empty() || config.base_dn.trim().is_empty() {
        return Err("LDAP 地址和搜索起点不能为空".to_string());
    }

    // ldap3 的 blocking API 内部自己跑一个 tokio runtime，
    // 直接放在 async 命令里会和外层的 runtime 冲突，所以丢到阻塞线程池
    let people = tauri::async_runtime::spawn_blocking(move || fetch_people(&config))
        .await
        .map_err(|e| format!("LDAP 任务执行失败：{e}"))??;

    let conn = db.lock()?;
    reconcile_members(&conn, &people)
}

/// 取规范化后的连接参数并校验。
///
/// 规范化是为了吃掉从文档/表格复制时带进来的包裹字符和全角标点；
/// 校验是为了在发请求之前就把问题说清楚——让服务端回一个 rc=34，
/// 用户看到的只有 `dn: ""`，根本不知道哪个字符有问题。
fn resolve_dns(config: &LdapConfig) -> Result<(String, String), String> {
    let bind_dn = normalize_dn(&config.bind_dn);
    let base_dn = normalize_dn(&config.base_dn);

    if let Some(reason) = dn_reject_reason(&bind_dn) {
        return Err(format!("绑定账号格式不对：{reason}"));
    }
    if let Some(reason) = dn_reject_reason(&base_dn) {
        return Err(format!("搜索起点格式不对：{reason}"));
    }

    // 打一份实际要发出去的参数。rc=34 这类问题只有看到真实字符串才能定位，
    // 而界面上显示的 DN 可能和实际值不一致（不可见字符、自动更正等）。
    //
    // 同时把前两个字符的码位打出来：终端上的日志可能被进度条重绘弄乱（cn 显示成 oc
    // 这种），码位是数字，不会被显示层篡改。
    log::info!(
        "LDAP 连接参数：bindDn={} baseDn={} 首段属性码位={:?}",
        escape_invisible(&bind_dn),
        escape_invisible(&base_dn),
        bind_dn.chars().take(3).map(|c| c as u32).collect::<Vec<_>>()
    );

    Ok((bind_dn, base_dn))
}

fn fetch_people(config: &LdapConfig) -> Result<Vec<LdapPerson>, String> {
    let (bind_dn, base_dn) = resolve_dns(config)?;

    let settings = LdapConnSettings::new()
        .set_conn_timeout(Duration::from_secs(config.timeout_seconds))
        .set_no_tls_verify(config.allow_insecure_tls);

    let mut ldap = LdapConn::with_settings(settings, config.url.trim())
        .map_err(|e| describe_ldap_error(&config.url, &e))?;

    ldap.with_timeout(Duration::from_secs(config.timeout_seconds));

    ldap.simple_bind(&bind_dn, &config.bind_password)
        .map_err(|e| format!("绑定失败：{e}"))?
        .success()
        .map_err(|e| describe_bind_failure(&bind_dn, &base_dn, &e))?;

    let map = &config.attribute_map;
    // 只取真正用得到的属性：AD 的条目属性很多，全取会显著拖慢搜索
    let attrs: Vec<&str> = [
        map.username.as_str(),
        map.name.as_str(),
        map.email.as_str(),
        map.employee_no.as_str(),
        map.department.as_str(),
        map.title.as_str(),
    ]
    .into_iter()
    .filter(|a| !a.trim().is_empty())
    .collect();

    let mut people = Vec::new();
    let mut skipped = 0usize;
    let mut seen = 0usize;

    // 必须用分页：AD 默认单次最多返回 1000 条，超了会直接报 sizeLimitExceeded，
    // 表现成「同步成功但人少了一半」，比报错更难发现。
    let mut stream = ldap
        .streaming_search_with(
            PagedResults::new(config.page_size.max(1)),
            &base_dn,
            Scope::Subtree,
            &normalize_filter(&config.user_filter),
            attrs.as_slice(),
        )
        .map_err(|e| format!("搜索请求失败：{e}"))?;

    while let Some(entry) = stream.next().map_err(|e| format!("读取条目失败：{e}"))? {
        seen += 1;
        let entry = SearchEntry::construct(entry);
        let person = to_person(&entry, map);
        if person.username.is_empty() && person.name.is_empty() {
            skipped += 1;
            continue;
        }
        people.push(person);
    }

    stream.result().success().map_err(|e| format!("搜索未正常结束：{e}"))?;
    let _ = ldap.unbind();

    if people.is_empty() {
        // 「一条都没搜到」和「搜到了但属性取不到值」是两回事：
        // 前者是搜索范围/过滤器的问题，后者是属性映射的问题。
        // 混成一句话会把用户引到完全错误的方向去排查。
        log::warn!("LDAP 同步返回空：收到 {seen} 条条目，跳过 {skipped} 条");

        return Err(if seen == 0 {
            format!(
                "搜索没有返回任何条目。请检查搜索起点「{base_dn}」和过滤器「{}」",
                normalize_filter(&config.user_filter)
            )
        }
        else {
            format!(
                "搜到 {seen} 条条目，但没有一条能取到登录名或姓名——说明属性映射和目录的实际属性对不上。\
                 当前把登录名映射到「{}」、姓名映射到「{}」。\
                 点上面的「诊断属性映射」可以看到目录里实际有哪些属性。",
                map.username, map.name
            )
        });
    }

    log::info!("LDAP 同步：收到 {seen} 条，取到 {} 人，跳过 {skipped} 条", people.len());
    Ok(people)
}

fn to_person(entry: &SearchEntry, map: &AttributeMap) -> LdapPerson {
    let first = |key: &str| -> Option<String> {
        if key.trim().is_empty() {
            return None;
        }
        entry
            .attrs
            .get(key)
            .and_then(|v| v.first())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    LdapPerson {
        username: first(&map.username).unwrap_or_default(),
        name: first(&map.name).unwrap_or_default(),
        email: first(&map.email).map(|e| e.to_lowercase()),
        employee_no: first(&map.employee_no),
        department: first(&map.department),
        title: first(&map.title),
    }
}

/// 把 LDAP 的人与本地人员表对账。
///
/// 认人的顺序是「工号 → 登录名 → 姓名」：
/// 工号最稳定（改名、换账号都不影响），姓名最容易撞车只能兜底。
///
/// 同步只补齐 LDAP 侧的信息，不覆盖本地已有的日报成员 ID——
/// 那个字段来自日报系统，LDAP 里没有。
fn reconcile_members(
    conn: &rusqlite::Connection,
    people: &[LdapPerson],
) -> Result<MemberSyncOutcome, String> {
    let ts = now_iso();
    let mut outcome = MemberSyncOutcome::default();

    let existing = load_existing(conn)?;

    for person in people {
        let matched = existing
            .iter()
            .find(|m| {
                person.employee_no.is_some()
                    && m.employee_no.is_some()
                    && m.employee_no == person.employee_no
            })
            .or_else(|| {
                existing.iter().find(|m| {
                    !person.username.is_empty()
                        && m.gitlab_username.as_deref() == Some(person.username.as_str())
                })
            })
            .or_else(|| {
                existing
                    .iter()
                    .find(|m| !person.name.is_empty() && m.name == person.name)
            });

        match matched {
            Some(local) => {
                // 邮箱要按「来源」处理，不能简单地合并或替换：
                //
                // 合并会留下 LDAP 里已经改掉的旧邮箱——目录侧把重复邮箱修好了，
                // 本地却还挂着冲突提示；整体替换又会把手工维护的别名邮箱冲掉。
                //
                // 所以先移除上一次 LDAP 给的那批，再加上这次给的，手工的保留。
                let previous_ldap = local.ldap_emails.clone();
                let mut emails: Vec<String> = local
                    .emails
                    .iter()
                    .filter(|e| !previous_ldap.iter().any(|p| p.eq_ignore_ascii_case(e)))
                    .cloned()
                    .collect();

                let ldap_emails: Vec<String> = person.email.iter().cloned().collect();
                for email in &ldap_emails {
                    if !emails.iter().any(|e| e.eq_ignore_ascii_case(email)) {
                        emails.push(email.clone());
                    }
                }

                // LDAP 的登录名并进身份列表：手工加的其它用户名保留，
                // 目录说这是这个人的账号时也要留下。第一个作为单值镜像。
                let mut usernames = local.gitlab_usernames.clone();
                if !person.username.is_empty()
                    && !usernames.iter().any(|u| u.eq_ignore_ascii_case(&person.username))
                {
                    usernames.insert(0, person.username.clone());
                }
                let primary = usernames.first().cloned().or(local.gitlab_username.clone());

                conn.execute(
                    "UPDATE members SET
                       name = ?1, employee_no = ?2, team = ?3, role = ?4,
                       gitlab_username = ?5, gitlab_usernames = ?6, emails = ?7,
                       ldap_emails = ?8, updated_at = ?9
                     WHERE id = ?10",
                    params![
                        if person.name.is_empty() { local.name.clone() } else { person.name.clone() },
                        person.employee_no.clone().or(local.employee_no.clone()),
                        person.department.clone().or(local.team.clone()),
                        person.title.clone().or(local.role.clone()),
                        primary,
                        serde_json::to_string(&usernames).unwrap_or_else(|_| "[]".into()),
                        serde_json::to_string(&emails).unwrap_or_else(|_| "[]".into()),
                        serde_json::to_string(&ldap_emails).unwrap_or_else(|_| "[]".into()),
                        ts,
                        local.id,
                    ],
                )
                .map_err(|e| format!("更新人员失败：{e}"))?;
                outcome.updated += 1;
            }
            None => {
                // 新建。id 用登录名派生，保证同一账号重复同步不会产生重复记录
                let id = if person.username.is_empty() {
                    format!("ldap-{}", uuid_like(&person.name))
                }
                else {
                    format!("ldap-{}", person.username)
                };
                conn.execute(
                    "INSERT INTO members
                       (id, report_member_id, name, employee_no, team, role,
                        gitlab_user_id, gitlab_username, gitlab_usernames, emails, ldap_emails,
                        enabled, created_at, updated_at)
                     VALUES (?1, NULL, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?8, 1, ?9, ?9)
                     ON CONFLICT(id) DO NOTHING",
                    params![
                        id,
                        person.name,
                        person.employee_no,
                        person.department,
                        person.title,
                        if person.username.is_empty() { None } else { Some(person.username.clone()) },
                        // 新人的身份列表就是目录给的那一个
                        serde_json::to_string(
                            &if person.username.is_empty() {
                                Vec::new()
                            } else {
                                vec![person.username.clone()]
                            },
                        )
                        .unwrap_or_else(|_| "[]".into()),
                        // 新建时 emails 和 ldap_emails 是同一批：还没有手工维护的邮箱
                        serde_json::to_string(&person.email.clone().map(|e| vec![e]).unwrap_or_default())
                            .unwrap_or_else(|_| "[]".into()),
                        ts,
                    ],
                )
                .map_err(|e| format!("新增人员失败：{e}"))?;
                outcome.added += 1;
            }
        }
    }

    Ok(outcome)
}

struct ExistingMember {
    id: String,
    name: String,
    employee_no: Option<String>,
    team: Option<String>,
    role: Option<String>,
    gitlab_username: Option<String>,
    gitlab_usernames: Vec<String>,
    emails: Vec<String>,
    /// 上一次同步从 LDAP 拿到的那批邮箱，用于区分来源
    ldap_emails: Vec<String>,
}

fn load_existing(conn: &rusqlite::Connection) -> Result<Vec<ExistingMember>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, employee_no, team, role, gitlab_username, emails, ldap_emails,
                    gitlab_usernames
             FROM members",
        )
        .map_err(|e| format!("准备查询失败：{e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let parse = |idx: usize| -> Vec<String> {
                row.get::<_, Option<String>>(idx)
                    .ok()
                    .flatten()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default()
            };
            let gitlab_username: Option<String> = row.get(5)?;
            let mut gitlab_usernames = parse(8);
            // 老数据没有数组列，退回单值——否则升级后第一次同步会把人当成「没有身份」
            if gitlab_usernames.is_empty() {
                if let Some(primary) = gitlab_username.clone() {
                    if !primary.trim().is_empty() {
                        gitlab_usernames.push(primary);
                    }
                }
            }
            Ok(ExistingMember {
                id: row.get(0)?,
                name: row.get(1)?,
                employee_no: row.get(2)?,
                team: row.get(3)?,
                role: row.get(4)?,
                gitlab_username,
                gitlab_usernames,
                emails: parse(6),
                ldap_emails: parse(7),
            })
        })
        .map_err(|e| format!("查询人员失败：{e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取人员失败：{e}"))
}

/// 没有登录名时用姓名派生一个稳定 id。这里不引 uuid 依赖，
/// 只要在「同一批姓名」上稳定即可。
fn uuid_like(seed: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in seed.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 单个属性在目录里的覆盖情况
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeStat {
    pub name: String,
    /// 在抽样条目里出现的次数
    pub present: usize,
    /// 取到的第一个值，用于肉眼确认
    pub sample: Option<String>,
}

/// 配置里的某个字段映射到了哪个属性、该属性命中了多少条
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedAttribute {
    /// username / name / email / employeeNo / department / title
    pub field: String,
    /// 当前配置的 LDAP 属性名
    pub name: String,
    pub present: usize,
    pub sample: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleEntry {
    pub dn: String,
    pub attributes: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeSuggestion {
    /// 映射里的字段名：username / name / email / ...
    pub field: String,
    /// 当前配置的属性（在目录里一条都没命中）
    pub current: String,
    /// 建议改成这个
    pub suggested: String,
    /// 该属性在目录里的命中数
    pub suggested_present: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LdapProbeReport {
    pub base_dn: String,
    pub filter: String,
    /// 过滤器匹配到的条目总数
    pub total: usize,
    /// 抽样了多少条（属性统计基于抽样，不是全量）
    pub sampled: usize,
    /// 配置里那 6 个属性各自的覆盖情况
    pub mapped: Vec<MappedAttribute>,
    /// 目录里实际存在的属性，按覆盖数倒序
    pub available: Vec<AttributeStat>,
    pub samples: Vec<SampleEntry>,
    /// 配置里命中为 0、但存在明显替代属性的字段
    pub suggestions: Vec<AttributeSuggestion>,
    /// 目录返回了这些敏感属性（值已在报告里隐去）。
    /// 正常情况下目录的 ACL 应该挡住它们，出现即说明需要找运维确认。
    pub sensitive_attributes: Vec<String>,
}

/// 探测目录：搜一批真实条目，统计属性覆盖情况。
///
/// 存在的意义：AD 和 OpenLDAP 的属性名差别很大，靠猜会得到「同步成功但一个人都没建出来」
/// 这种结果，而且报错信息完全没有指向性。直接问目录它有什么属性，一次就能定位。
#[tauri::command]
pub async fn ldap_probe(payload: String) -> Result<LdapProbeReport, String> {
    tauri::async_runtime::spawn_blocking(move || probe_from_json(&payload))
        .await
        .map_err(|e| format!("LDAP 任务执行失败：{e}"))?
}

/// 从 JSON 配置跑一次探测。
///
/// 抽出来是为了让命令行诊断工具（examples/ldap_probe.rs）能复用同一条代码路径——
/// 排查真实目录时，用命令行迭代比每次重新编译整个应用快得多。
pub fn probe_from_json(payload: &str) -> Result<LdapProbeReport, String> {
    let config: LdapConfig =
        serde_json::from_str(payload).map_err(|e| format!("LDAP 配置不合法：{e}"))?;

    if config.url.trim().is_empty() || config.base_dn.trim().is_empty() {
        return Err("LDAP 地址和搜索起点不能为空".to_string());
    }

    probe_dir(&config)
}

/// 抽样上限。属性覆盖情况在几百条上已经足够稳定，没必要为诊断拉全量。
const PROBE_SAMPLE: usize = 200;

/// 各字段的常见属性名，按「越可能是主选」的顺序排列。
/// 用于在配置的属性一条都没命中时给出替代建议。
const ALTERNATIVES: &[(&str, &[&str])] = &[
    ("username", &["sAMAccountName", "uid", "cn", "employeeNumber"]),
    ("name", &["displayName", "cn", "givenName", "sn"]),
    ("email", &["mail", "userPrincipalName", "email"]),
    // 不放 uid：登录名和工号是两个概念，把 uid 当工号填进来会让对账逻辑
    // 按「登录名」认人却以为是按工号认，改名就会断。
    // uidNumber 是 POSIX 数值 ID，作为稳定标识比登录名更接近工号的用途。
    ("employeeNo", &["employeeNumber", "employeeID", "uidNumber"]),
    ("department", &["department", "departmentNumber", "ou", "businessCategory"]),
    ("title", &["title", "description", "businessCategory"]),
];

/// 探测时不该显示的属性。
///
/// 用 `*` 请求属性时，只要目录的 ACL 没挡住，口令散列也会一起返回。
/// 这个工具的用途是核对属性名，把散列打到终端或界面上既没有意义又平白制造泄漏面，
/// 所以只报告「这个属性存在」，不显示其值。
const SENSITIVE_ATTRIBUTES: &[&str] = &[
    "userpassword",
    "shadowlastchange",
    "shadowmax",
    "shadowmin",
    "shadowwarning",
    "shadowinactive",
    "shadowexpire",
    "shadowflag",
    "sambalmpassword",
    "sambantpassword",
    "krbprincipalkey",
    "objectguid",
];

fn is_sensitive(name: &str) -> bool {
    SENSITIVE_ATTRIBUTES.contains(&name.to_ascii_lowercase().as_str())
}

/// 敏感属性的值一律替换成这个，保留「它存在」这个信息
const MASKED: &str = "（已隐藏）";

fn probe_dir(config: &LdapConfig) -> Result<LdapProbeReport, String> {
    let (bind_dn, base_dn) = resolve_dns(config)?;

    let settings = LdapConnSettings::new()
        .set_conn_timeout(Duration::from_secs(config.timeout_seconds))
        .set_no_tls_verify(config.allow_insecure_tls);

    let mut ldap = LdapConn::with_settings(settings, config.url.trim())
        .map_err(|e| describe_ldap_error(&config.url, &e))?;
    ldap.with_timeout(Duration::from_secs(config.timeout_seconds));

    ldap.simple_bind(&bind_dn, &config.bind_password)
        .map_err(|e| format!("绑定请求失败：{e}"))?
        .success()
        .map_err(|e| describe_bind_failure(&bind_dn, &base_dn, &e))?;

    // 要 '*' 而不是只取配置里那几个属性：诊断的目的正是「看看目录到底有什么」，
    // 只请求配置的属性永远发现不了「该用的属性是另一个名字」。
    let mut stream = ldap
        .streaming_search_with(
            PagedResults::new(config.page_size.max(1)),
            &base_dn,
            Scope::Subtree,
            &normalize_filter(&config.user_filter),
            &["*"][..],
        )
        .map_err(|e| format!("搜索请求失败：{e}"))?;

    let mut total = 0usize;
    let mut coverage: std::collections::HashMap<String, (usize, Option<String>)> =
        std::collections::HashMap::new();
    let mut samples: Vec<SampleEntry> = Vec::new();
    let mut sensitive: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    while let Some(entry) = stream.next().map_err(|e| format!("读取条目失败：{e}"))? {
        let entry = SearchEntry::construct(entry);
        total += 1;
        if samples.len() >= PROBE_SAMPLE {
            continue;
        }

        if samples.len() < 3 {
            let mut attributes: Vec<(String, String)> = entry
                .attrs
                .iter()
                .filter_map(|(k, v)| {
                    v.first().map(|val| {
                        let shown = if is_sensitive(k) { MASKED.to_string() } else { val.clone() };
                        (k.clone(), shown)
                    })
                })
                .collect();
            attributes.sort();
            samples.push(SampleEntry {
                dn: entry.dn.clone(),
                attributes,
            });
        }

        for (name, values) in &entry.attrs {
            // 计数按条目数而不是值个数：多值属性（比如多个 mail）不该把覆盖数撑高
            let slot = coverage.entry(name.clone()).or_insert((0, None));
            slot.0 += 1;
            if is_sensitive(name) {
                sensitive.insert(name.clone());
                slot.1 = Some(MASKED.to_string());
            }
            else if slot.1.is_none() {
                slot.1 = values.first().cloned();
            }
        }
    }

    stream.result().success().map_err(|e| format!("搜索未正常结束：{e}"))?;
    let _ = ldap.unbind();

    if total == 0 {
        return Err(format!(
            "过滤器「{}」在「{}」下没有匹配到任何条目。\
             注意过滤器要带最外层括号，例如 (objectClass=person)",
            config.user_filter, config.base_dn
        ));
    }

    let sampled = samples.len().min(PROBE_SAMPLE);
    let lookup = |name: &str| -> AttributeStat {
        let hit = coverage.get(name);
        AttributeStat {
            name: name.to_string(),
            present: hit.map(|(n, _)| *n).unwrap_or(0),
            sample: hit.and_then(|(_, v)| v.clone()),
        }
    };

    let map = &config.attribute_map;
    let mapped = vec![
        ("username", map.username.clone()),
        ("name", map.name.clone()),
        ("email", map.email.clone()),
        ("employeeNo", map.employee_no.clone()),
        ("department", map.department.clone()),
        ("title", map.title.clone()),
    ]
    .into_iter()
    .map(|(field, attr)| {
        let stat = lookup(&attr);
        MappedAttribute {
            field: field.to_string(),
            name: stat.name,
            present: stat.present,
            sample: stat.sample,
        }
    })
    .collect::<Vec<_>>();

    let mut available: Vec<AttributeStat> = coverage
        .iter()
        .map(|(name, (present, sample))| AttributeStat {
            name: name.clone(),
            present: *present,
            sample: sample.clone(),
        })
        .collect();
    available.sort_by(|a, b| b.present.cmp(&a.present).then_with(|| a.name.cmp(&b.name)));
    available.truncate(25);

    let mut suggestions = Vec::new();
    for (field, alternatives) in ALTERNATIVES {
        let current = match *field {
            "username" => &map.username,
            "name" => &map.name,
            "email" => &map.email,
            "employeeNo" => &map.employee_no,
            "department" => &map.department,
            _ => &map.title,
        };
        if coverage.get(current).map(|(n, _)| *n).unwrap_or(0) > 0 {
            continue; // 当前配置能取到值，不需要建议
        }
        // 找一个确实存在、且不是当前值的替代
        let better = alternatives.iter().find(|alt| {
            !alt.eq_ignore_ascii_case(current)
                && coverage.get(**alt).map(|(n, _)| *n).unwrap_or(0) > 0
        });
        if let Some(alt) = better {
            suggestions.push(AttributeSuggestion {
                field: field.to_string(),
                current: current.clone(),
                suggested: alt.to_string(),
                suggested_present: coverage.get(*alt).map(|(n, _)| *n).unwrap_or(0),
            });
        }
    }

    Ok(LdapProbeReport {
        base_dn: config.base_dn.clone(),
        filter: config.user_filter.clone(),
        total,
        sampled,
        sensitive_attributes: sensitive.into_iter().collect(),
        mapped,
        available,
        samples,
        suggestions,
    })
}

/// 规范过滤器写法。
///
/// LDAP 过滤器必须带最外层括号，但手填时很容易漏（`objectClass=person` 而不是
/// `(objectClass=person)`）。漏了会得到一个语焉不详的服务端错误，
/// 与其让人去猜，不如在这里补上——补上永远是对的，因为 LDAP 过滤器必定以 `(` 开头。
fn normalize_filter(filter: &str) -> String {
    let f = filter.trim();
    if f.is_empty() {
        return "(objectClass=person)".to_string();
    }
    if f.starts_with('(') {
        f.to_string()
    }
    else {
        format!("({f})")
    }
}

/// 复制粘贴时经常混进来的不可见字符。
///
/// 从网页、聊天软件、文档里复制 DN 时，很容易带上零宽空格、方向标记、变体选择符
/// 这类东西。它们肉眼完全看不出来，但会让服务端返回 rc=34 invalidDN，
/// 而报错里只有一个 `dn: ""`——这是最难查的一类输入问题。
fn is_invisible(ch: char) -> bool {
    matches!(ch,
        // 不换行空格与各种宽度的空格
        '\u{00a0}' | '\u{2000}'..='\u{200a}' | '\u{205f}' | '\u{3000}'
        // 零宽空格 / 连接符 / 方向标记
        | '\u{200b}'..='\u{200f}'
        // 行分隔符与双向文本控制
        | '\u{2028}'..='\u{202e}'
        | '\u{2060}'..='\u{2064}'
        // BOM / 零宽不换行空格
        | '\u{feff}'
        // 变体选择符
        | '\u{fe00}'..='\u{fe0f}'
    ) || ch.is_control()
}

/// 把字符串渲染成「能看出问题字符」的形式：不可见字符显示成 \u{XXXX}，其余原样。
/// 用在错误提示和日志里——否则用户盯着一个看起来完全正常的 DN 无从下手。
fn escape_invisible(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ch == ' ' || !is_invisible(ch) {
            out.push(ch);
        }
        else {
            out.push_str(&format!("\\u{{{:04X}}}", ch as u32));
        }
    }
    out
}

/// 规范化 DN 写法。
///
/// 从文档、表格、聊天记录里复制 DN 时，很容易把包裹用的反引号或引号一起带上，
/// 全角逗号、全角等号、全角空格也很常见。这些字符会让 LDAP 返回
/// rc=34 invalidDNSyntax，而服务端的报错里只有一个 `dn: ""`，完全看不出问题在哪。
fn normalize_dn(raw: &str) -> String {
    // 先剥掉不可见字符：它们会让后面的成对匹配和分段判断全部失准
    let mut s: String = raw.chars().filter(|c| !is_invisible(*c)).collect();
    s = s.trim().to_string();

    // 成对的包裹字符：从 `cn=admin,dc=x` 这种带反引号的写法里复制时最常见
    const WRAPPERS: &[(char, char)] = &[
        ('`', '`'),
        ('"', '"'),
        ('\'', '\''),
        ('“', '”'),
        ('‘', '’'),
    ];
    for (open, close) in WRAPPERS {
        if s.starts_with(*open) && s.ends_with(*close) && s.chars().count() > 1 {
            let mut chars = s.chars();
            chars.next();
            chars.next_back();
            s = chars.as_str().trim().to_string();
        }
    }

    s = s
        .replace('，', ",")
        .replace('、', ",")
        .replace('＝', "=")
        .replace('　', "");

    s.trim().to_string()
}

/// 找出 DN 里会导致 rc=34 的残留内容，返回能直接照做的说明。
fn dn_reject_reason(dn: &str) -> Option<String> {
    if dn.trim().is_empty() {
        return Some("不能为空".to_string());
    }

    const BAD: &[(char, &str)] = &[
        ('`', "反引号"),
        ('"', "双引号"),
        ('\'', "单引号"),
        ('“', "全角引号"),
        ('”', "全角引号"),
        ('，', "全角逗号"),
        ('、', "顿号"),
        ('＝', "全角等号"),
        ('　', "全角空格"),
    ];
    if let Some((ch, name)) = BAD.iter().find(|(ch, _)| dn.contains(*ch)) {
        return Some(format!("含有{name}「{ch}」，多半是从文档或表格复制时带进来的"));
    }

    // 每个 RDN 都该是「属性=值」
    for part in dn.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Some("有多余的逗号".to_string());
        }
        if !part.contains('=') {
            return Some(format!("「{part}」不是「属性=值」的形式"));
        }
    }
    None
}

/// 绑定 DN 看起来像不像一个「能设密码的条目」。
///
/// `ou=` / `dc=` 开头的是容器，不是账号；`cn=` / `uid=` 开头才可能是人。
/// 用来识别「绑定账号和搜索起点填反了」这种很常见的手误——
/// 反了的话报错是「凭据无效」，完全不指向真正的原因。
fn looks_like_container(dn: &str) -> bool {
    let first = dn.trim().split(',').next().unwrap_or("").trim().to_ascii_lowercase();
    first.starts_with("ou=") || first.starts_with("dc=")
}

fn looks_like_account(dn: &str) -> bool {
    let first = dn.trim().split(',').next().unwrap_or("").trim().to_ascii_lowercase();
    first.starts_with("cn=") || first.starts_with("uid=") || first.starts_with("samaccountname=")
}

/// 绑定失败时给一条能直接照做的提示。
/// 绑定账号的第一段通常是账号类的属性。
///
/// 不是的话，绝大多数情况是把 `cn` 打成了 `oc` / `xn` 这类相邻字母。
/// 服务端对此只会回一句 invalid DN——它没法说「这个属性名我不认识」，
/// 因为属性类型是否已定义是 schema 层面的事。
fn suspicious_bind_attribute(bind_dn: &str) -> Option<String> {
    const ACCOUNT_ATTRS: &[&str] = &[
        "cn",
        "uid",
        "samaccountname",
        "userprincipalname",
        "mail",
        "displayname",
        "dn",
        "distinguishedname",
    ];

    let first = bind_dn.split(',').next()?.trim();
    let attr = first.split('=').next()?.trim().to_ascii_lowercase();
    if attr.is_empty() || ACCOUNT_ATTRS.contains(&attr.as_str()) {
        None
    }
    else {
        Some(attr)
    }
}

fn describe_bind_failure(bind_dn: &str, base_dn: &str, err: &ldap3::LdapError) -> String {
    let text = err.to_string();

    // 填反了的情况单独识别：这是最常见的手误，而默认报错完全不指向它
    if looks_like_container(bind_dn) && looks_like_account(base_dn) {
        return format!(
            "绑定失败：凭据无效。不过「绑定账号」填的是「{bind_dn}」——这看起来是一个组织单位而不是账号，\
             而「搜索起点」填的是「{base_dn}」——这看起来是一个账号。两者可能填反了：\
             绑定账号应为 cn=xxx,dc=...，搜索起点应为 ou=xxx,dc=..."
        );
    }

    if text.contains("49") {
        return format!(
            "绑定失败：账号或密码错误（LDAP 49 = Invalid credentials）。当前绑定账号：{bind_dn}"
        );
    }

    // rc=34：服务端只说「invalid DN」，不说是哪个字符。把实际发出去的字符串
    // 转成能看出隐藏字符的形式摆出来，否则用户盯着一个看起来正常的 DN 无从下手。
    if text.contains("invalidDNSyntax") || text.contains("rc=34") {
        let shown = escape_invisible(bind_dn);

        let hint = if shown != bind_dn {
            "上面的绑定账号里显示了 \\u{XXXX}，那就是混进来的不可见字符，删掉即可".to_string()
        }
        else if let Some(attr) = suspicious_bind_attribute(bind_dn) {
            // 最常见的一种：属性名拼错，服务端只会说 invalid DN
            format!(
                "绑定账号的第一段是「{attr}=」，而账号类属性通常是 cn / uid / sAMAccountName。\
                 多半是拼错了（比如 cn 打成了 oc），请逐字核对"
            )
        }
        else {
            "请逐字核对：常见问题是属性名拼错、多了逗号，或从网页复制时混进了看不见的字符。\
             把输入框清空重新手打一遍最稳妥"
                .to_string()
        };

        return format!("绑定失败：DN 语法非法（LDAP 34）。实际发送的绑定账号是「{shown}」。{hint}");
    }

    format!("绑定失败：{text}")
}

/// 把 ldap3 的连接错误翻译成能直接展示的提示。
/// 默认的 Display 是一串 [LDAP: error code N]，界面上没法看。
fn describe_ldap_error(url: &str, err: &ldap3::LdapError) -> String {
    let text = err.to_string();
    if text.contains("Connection refused") || text.contains("connection refused") {
        return format!("无法连接到 {url}，请确认地址与端口，以及本机能否访问该网络");
    }
    if text.contains("certificate") || text.contains("Cert") {
        return format!("{url} 的 TLS 证书校验失败。内网自签名证书可以在设置里开启「跳过证书校验」");
    }
    if text.contains("timed out") || text.contains("timeout") {
        return format!("连接 {url} 超时");
    }
    format!("连接 {url} 失败：{text}")
}

/// 把设置写入指定数据库，并把 LDAP 人员同步进去。
///
/// 供命令行工具用：LDAP 只能在桌面端跑，而桌面端的数据在自己的 SQLite 里，
/// 这个入口让「先离线把人员同步好、再启动应用」成为可能。
/// 写入的库和桌面端用同一套迁移，所以应用打开它不会有任何差异。
pub fn sync_into_db(
    db_path: &std::path::Path,
    settings_json: &str,
) -> Result<MemberSyncOutcome, String> {
    let full: serde_json::Value =
        serde_json::from_str(settings_json).map_err(|e| format!("设置不是合法 JSON：{e}"))?;
    let ldap_value = full.get("ldap").cloned().unwrap_or(serde_json::Value::Null);
    let config: LdapConfig = serde_json::from_value(ldap_value)
        .map_err(|e| format!("设置里缺少或无法解析 ldap 段：{e}"))?;

    let database = crate::db::Db::open_at(db_path.to_path_buf())?;

    // 先落配置：应用启动时就直接是配好的状态
    {
        let conn = database.lock()?;
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![settings_json, now_iso()],
        )
        .map_err(|e| format!("写入配置失败：{e}"))?;
    }

    let people = fetch_people(&config)?;
    let conn = database.lock()?;
    reconcile_members(&conn, &people)
}

/// 同步的「空跑」：拉取 + 对账到一个内存库，只报告结果。
///
/// 命令行诊断工具用。能在没有 GUI 的情况下验证整条链路——
/// 属性映射配错时会表现成「同步成功但建出来的全是空人」，
/// 只看探测的属性名覆盖还不够，得让数据真的走一遍对账。
pub struct SyncDryRun {
    pub outcome: MemberSyncOutcome,
    /// 前几条会建成的记录，用于肉眼核对映射结果
    pub sample: Vec<LdapPerson>,
    /// 被多个登录名共用的邮箱：会让「这条提交是谁的」判断不了
    pub duplicate_emails: Vec<(String, Vec<String>)>,
    /// 完全没有邮箱的账号：无法按作者匹配提交
    pub without_email: Vec<String>,
}

pub fn sync_dry_run(payload: &str) -> Result<SyncDryRun, String> {
    let config: LdapConfig =
        serde_json::from_str(payload).map_err(|e| format!("LDAP 配置不合法：{e}"))?;
    let people = fetch_people(&config)?;

    // 导入前先看两类会直接影响判定可信度的数据问题
    let mut by_email: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    let mut without_email = Vec::new();
    for p in &people {
        match &p.email {
            Some(email) => by_email.entry(email.clone()).or_default().push(p.username.clone()),
            None => without_email.push(p.username.clone()),
        }
    }
    let duplicate_emails: Vec<(String, Vec<String>)> = by_email
        .into_iter()
        .filter(|(_, users)| users.len() > 1)
        .collect();

    let database = crate::db::Db::open_memory()?;
    let conn = database.lock()?;
    let outcome = reconcile_members(&conn, &people)?;

    Ok(SyncDryRun {
        outcome,
        sample: people.into_iter().take(5).collect(),
        duplicate_emails,
        without_email,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn map() -> AttributeMap {
        AttributeMap {
            username: "sAMAccountName".into(),
            name: "displayName".into(),
            email: "mail".into(),
            employee_no: "employeeNumber".into(),
            department: "department".into(),
            title: "title".into(),
        }
    }

    fn entry(attrs: &[(&str, &str)]) -> SearchEntry {
        SearchEntry {
            dn: "CN=x,OU=y,DC=corp".into(),
            attrs: attrs
                .iter()
                .map(|(k, v)| (k.to_string(), vec![v.to_string()]))
                .collect(),
            bin_attrs: Default::default(),
        }
    }

    #[test]
    fn normalizes_filter_parentheses() {
        // 漏括号是最常见的手填错误，补上永远是对的
        assert_eq!(normalize_filter("objectClass=person"), "(objectClass=person)");
        assert_eq!(normalize_filter(" (objectClass=person) "), "(objectClass=person)");
        assert_eq!(normalize_filter("(&(a=1)(b=2))"), "(&(a=1)(b=2))");
        // 空过滤器兜底成「所有人」，总比对着空字符串报语法错好
        assert_eq!(normalize_filter("   "), "(objectClass=person)");
    }

    #[test]
    fn detects_swapped_bind_dn_and_base_dn() {
        // ou= 开头是容器，不可能是有密码的账号
        assert!(looks_like_container("ou=people,dc=dfec,dc=com,dc=cn"));
        assert!(looks_like_container("dc=dfec,dc=com"));
        assert!(!looks_like_container("cn=admin,dc=dfec,dc=com,dc=cn"));

        assert!(looks_like_account("cn=admin,dc=dfec,dc=com,dc=cn"));
        assert!(looks_like_account("uid=svc,ou=service,dc=x"));
        assert!(!looks_like_account("ou=people,dc=x"));
        assert!(!looks_like_account("dc=x"));
    }

    #[test]
    fn strips_invisible_characters_from_pasted_dn() {
        // 零宽空格是「看起来完全正常但服务端报 invalid DN」的头号原因
        assert_eq!(normalize_dn("cn=admin,\u{200b}dc=x"), "cn=admin,dc=x");
        // 不换行空格
        assert_eq!(normalize_dn("cn=admin,\u{00a0}dc=x"), "cn=admin,dc=x");
        // 双向文本控制符（从某些网页复制 RTL 内容时会带上）
        assert_eq!(normalize_dn("\u{202a}cn=admin,dc=x\u{202c}"), "cn=admin,dc=x");
        // 变体选择符
        assert_eq!(normalize_dn("cn=admin\u{fe0f},dc=x"), "cn=admin,dc=x");
        // 普通空格是 DN 里合法的，不能误删
        assert_eq!(normalize_dn("cn=svc inspector,dc=x"), "cn=svc inspector,dc=x");
    }

    #[test]
    fn escape_invisible_makes_hidden_characters_visible() {
        // 正常内容原样返回
        assert_eq!(escape_invisible("cn=admin,dc=x"), "cn=admin,dc=x");
        assert_eq!(escape_invisible("cn=svc inspector"), "cn=svc inspector");
        assert_eq!(escape_invisible("cn=张伟"), "cn=张伟");

        // 隐藏字符要能被看出来是哪个码位
        let shown = escape_invisible("cn=admin,\u{200b}dc=x");
        assert!(shown.contains("\\u{200B}"), "{shown}");
        assert!(shown.contains("cn=admin,"), "{shown}");
    }

    #[test]
    fn invalid_dn_error_shows_the_actual_string() {
        let err = ldap3::LdapError::LdapResult {
            result: ldap3::LdapResult {
                rc: 34,
                matched: String::new(),
                text: "invalid DN".into(),
                refs: vec![],
                ctrls: vec![],
            },
        };

        // 混进了不可见字符：要把它显示出来
        let message = describe_bind_failure("cn=admin,\u{200b}dc=x", "dc=x", &err);
        assert!(message.contains("LDAP 34"), "{message}");
        assert!(message.contains("\\u{200B}"), "应显示隐藏字符：{message}");

        // 看起来正常：要给出可执行的建议，而不是干瞪眼
        let message = describe_bind_failure("cn=admin,dc=x", "dc=x", &err);
        assert!(message.contains("重新手打"), "{message}");
    }

    #[test]
    fn invalid_dn_error_names_a_mistyped_attribute() {
        let err = ldap3::LdapError::LdapResult {
            result: ldap3::LdapResult {
                rc: 34,
                matched: String::new(),
                text: "invalid DN".into(),
                refs: vec![],
                ctrls: vec![],
            },
        };

        // cn 打成 oc：服务端只会说 invalid DN，得靠这里指出来
        assert_eq!(suspicious_bind_attribute("oc=admin,dc=x"), Some("oc".to_string()));
        assert_eq!(suspicious_bind_attribute("xn=admin,dc=x"), Some("xn".to_string()));
        assert_eq!(suspicious_bind_attribute("cm=admin,dc=x"), Some("cm".to_string()));

        // 常见写法不应被当成拼写错误
        for good in [
            "cn=admin,dc=x",
            "uid=svc,ou=service,dc=x",
            "sAMAccountName=svc,dc=x",
            "CN=Admin,DC=x",
        ] {
            assert!(suspicious_bind_attribute(good).is_none(), "{good} 不该被判为可疑");
        }

        let message = describe_bind_failure("oc=admin,dc=dfec,dc=com,dc=cn", "ou=people,dc=dfec,dc=com,dc=cn", &err);
        assert!(message.contains("oc="), "应指出可疑的属性名：{message}");
        assert!(message.contains("拼错"), "{message}");
        // 要如实显示实际发送的值，用户才能对照
        assert!(message.contains("oc=admin,dc=dfec,dc=com,dc=cn"), "{message}");
    }

    #[test]
    fn swapped_config_gets_an_actionable_message() {
        let err = ldap3::LdapError::LdapResult {
            result: ldap3::LdapResult {
                rc: 49,
                matched: String::new(),
                text: "Invalid credentials".into(),
                refs: vec![],
                ctrls: vec![],
            },
        };

        // 两个填反了
        let message = describe_bind_failure(
            "ou=people,dc=dfec,dc=com,dc=cn",
            "cn=admin,dc=dfec,dc=com,dc=cn",
            &err,
        );
        // 默认报错只会说「凭据无效」，完全指不出真正的原因
        assert!(message.contains("填反"), "应识别出填反：{message}");
        assert!(message.contains("绑定账号应为"));

        // 正常填法下不应误报
        let message = describe_bind_failure(
            "cn=admin,dc=dfec,dc=com,dc=cn",
            "ou=people,dc=dfec,dc=com,dc=cn",
            &err,
        );
        assert!(!message.contains("填反"), "不应误报：{message}");
        assert!(message.contains("账号或密码错误"));
    }

    #[test]
    fn normalizes_pasted_dn_artifacts() {
        // 从带反引号的文档里复制是 rc=34 的头号来源
        assert_eq!(normalize_dn("`cn=admin,dc=x`"), "cn=admin,dc=x");
        assert_eq!(normalize_dn("  \"cn=admin,dc=x\"  "), "cn=admin,dc=x");
        assert_eq!(normalize_dn("“cn=admin,dc=x”"), "cn=admin,dc=x");
        // 全角标点
        assert_eq!(normalize_dn("cn=admin，dc=x"), "cn=admin,dc=x");
        assert_eq!(normalize_dn("cn = admin"), "cn = admin");
        // 换行/制表符（从表格整格复制时会带上）
        assert_eq!(normalize_dn("cn=admin,\ndc=x\t"), "cn=admin,dc=x");
        // 正常的 DN 不该被改动
        assert_eq!(normalize_dn("cn=admin,dc=dfec,dc=com,dc=cn"), "cn=admin,dc=dfec,dc=com,dc=cn");
    }

    #[test]
    fn rejects_dn_that_would_cause_invalid_dn_syntax() {
        // 这些是规范化之后仍然会出问题的，必须报出来而不是丢给服务端
        let reason = dn_reject_reason("dn=admin,dc=x、dc=y").unwrap();
        assert!(reason.contains("顿号"), "{reason}");

        let reason = dn_reject_reason("cn=admin,dc=x，dc=y").unwrap();
        assert!(reason.contains("全角逗号"), "{reason}");

        let reason = dn_reject_reason("cn=admin,dc=x,").unwrap();
        assert!(reason.contains("多余的逗号"), "{reason}");

        // 「people」这一节没有等号，不是 attr=value
        let reason = dn_reject_reason("cn=admin,people,dc=x").unwrap();
        assert!(reason.contains("不是"), "{reason}");
        assert!(reason.contains("people"), "应指出是哪一节有问题：{reason}");

        assert!(dn_reject_reason("   ").unwrap().contains("不能为空"));

        // 合法的 DN 应该通过
        assert!(dn_reject_reason("cn=admin,dc=dfec,dc=com,dc=cn").is_none());
        assert!(dn_reject_reason("cn=svc inspector,ou=service,dc=x").is_none());
        assert!(dn_reject_reason("uid=zhangth,ou=people,dc=dfec,dc=com,dc=cn").is_none());
        // 两个 RDN 都符合 attr=value，虽然不常见但语法合法，不该拦
        assert!(dn_reject_reason("cn=admin,ou=people").is_none());
    }

    #[test]
    fn resolve_dns_normalizes_before_validating() {
        let config = LdapConfig {
            enabled: true,
            url: "ldap://x".into(),
            // 反引号 + 全角逗号，规范化后是合法的
            bind_dn: "`cn=admin，dc=dfec,dc=com,dc=cn`".into(),
            bind_password: "x".into(),
            base_dn: "ou=people,dc=dfec,dc=com,dc=cn".into(),
            user_filter: "objectClass=person".into(),
            page_size: 500,
            timeout_seconds: 30,
            allow_insecure_tls: false,
            attribute_map: map(),
        };

        let (bind, base) = resolve_dns(&config).unwrap();
        assert_eq!(bind, "cn=admin,dc=dfec,dc=com,dc=cn");
        assert_eq!(base, "ou=people,dc=dfec,dc=com,dc=cn");

        // 规范化之后仍然非法的，要在发请求前就报错
        let bad = LdapConfig { bind_dn: "cn=admin,dc=x,".into(), ..config };
        let message = resolve_dns(&bad).unwrap_err();
        assert!(message.contains("绑定账号格式不对"), "{message}");
    }

    #[test]
    fn sensitive_attributes_are_recognized_case_insensitively() {
        // 目录返回的属性名大小写不固定，判定不能只看一种写法
        assert!(is_sensitive("userPassword"));
        assert!(is_sensitive("userpassword"));
        assert!(is_sensitive("sambaNTPassword"));
        assert!(!is_sensitive("mail"));
        assert!(!is_sensitive("uid"));
        assert!(!is_sensitive("cn"));
    }

    #[test]
    fn maps_ldap_attributes_to_person() {
        let person = to_person(
            &entry(&[
                ("sAMAccountName", "zhangwei"),
                ("displayName", "张伟"),
                ("mail", "ZhangWei@Corp.com"),
                ("employeeNumber", "1001"),
                ("department", "支付研发组"),
                ("title", "后端工程师"),
            ]),
            &map(),
        );

        assert_eq!(person.username, "zhangwei");
        assert_eq!(person.name, "张伟");
        // 邮箱统一小写：GitLab 返回的 author_email 大小写不稳定，直接比较会漏
        assert_eq!(person.email.as_deref(), Some("zhangwei@corp.com"));
        assert_eq!(person.employee_no.as_deref(), Some("1001"));
        assert_eq!(person.department.as_deref(), Some("支付研发组"));
    }

    #[test]
    fn person_without_key_attributes_is_skipped() {
        // 改配了属性名但目录里没有该属性时，不应该产生一条空记录
        let person = to_person(&entry(&[("cn", "无名氏")]), &map());
        assert!(person.username.is_empty());
        assert!(person.name.is_empty());
        assert!(person.email.is_none());
    }

    #[test]
    fn changed_ldap_email_replaces_the_old_one_but_keeps_manual_ones() {
        let database = Db::open_memory().unwrap();
        let conn = database.lock().unwrap();

        // 本地已有：一个从 LDAP 同步来的邮箱，外加一个人工维护的别名邮箱
        conn.execute(
            "INSERT INTO members (id, report_member_id, name, employee_no, team, role,
                                  gitlab_user_id, gitlab_username, emails, ldap_emails,
                                  enabled, created_at, updated_at)
             VALUES ('m1', NULL, '管理员', '2005', NULL, NULL, NULL, 'jenkins-admin',
                     '[\"zhang513044@126.com\",\"ops@corp.com\"]', '[\"zhang513044@126.com\"]',
                     1, 'x', 'x')",
            [],
        )
        .unwrap();

        // 目录侧把那个重复邮箱改成了专用的
        let people = vec![LdapPerson {
            username: "jenkins-admin".into(),
            name: "管理员".into(),
            email: Some("jenkins@corp.com".into()),
            employee_no: Some("2005".into()),
            department: None,
            title: None,
        }];

        reconcile_members(&conn, &people).unwrap();

        let emails: String = conn
            .query_row("SELECT emails FROM members WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        let emails: Vec<String> = serde_json::from_str(&emails).unwrap();

        // 旧邮箱要清掉——否则目录侧改好了，本地还挂着重复邮箱的冲突提示
        assert!(
            !emails.iter().any(|e| e == "zhang513044@126.com"),
            "LDAP 侧改掉的邮箱应被移除，实际 {emails:?}"
        );
        assert!(emails.iter().any(|e| e == "jenkins@corp.com"), "新邮箱应写入：{emails:?}");

        // 手工维护的别名邮箱不能被误删
        assert!(
            emails.iter().any(|e| e == "ops@corp.com"),
            "手工维护的邮箱应保留，实际 {emails:?}"
        );
    }

    #[test]
    fn reconcile_matches_by_employee_no_then_username_then_name() {
        let database = Db::open_memory().unwrap();
        let conn = database.lock().unwrap();

        // 本地已有一条日报导入的人（有日报 ID，但没有 GitLab 身份）
        conn.execute(
            "INSERT INTO members (id, report_member_id, name, employee_no, team, role,
                                  gitlab_user_id, gitlab_username, emails, enabled, created_at, updated_at)
             VALUES ('m1', 'u1001', '张伟', '1001', NULL, NULL, NULL, NULL, '[\"old@corp.com\"]', 1, 'x', 'x')",
            [],
        )
        .unwrap();

        let people = vec![
            // 同一个人：工号一致，但姓名在 LDAP 里改成了带后缀的写法
            LdapPerson {
                username: "zhangwei".into(),
                name: "张伟(Zhang Wei)".into(),
                email: Some("zhangwei@corp.com".into()),
                employee_no: Some("1001".into()),
                department: Some("支付研发组".into()),
                title: Some("后端工程师".into()),
            },
            // 新人
            LdapPerson {
                username: "lina".into(),
                name: "李娜".into(),
                email: Some("lina@corp.com".into()),
                employee_no: Some("1002".into()),
                department: None,
                title: None,
            },
        ];

        let outcome = reconcile_members(&conn, &people).unwrap();
        assert_eq!(outcome.updated, 1);
        assert_eq!(outcome.added, 1);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM members", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "按工号认人，不应产生重复记录");

        let (report_id, emails, username): (Option<String>, String, Option<String>) = conn
            .query_row(
                "SELECT report_member_id, emails, gitlab_username FROM members WHERE id = 'm1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();

        // 日报成员 ID 是日报系统的东西，LDAP 里没有，同步不能把它冲掉
        assert_eq!(report_id.as_deref(), Some("u1001"));
        assert_eq!(username.as_deref(), Some("zhangwei"));
        // 邮箱是合并而不是替换：手工维护的旧邮箱要保留
        assert!(emails.contains("old@corp.com"));
        assert!(emails.contains("zhangwei@corp.com"));

        // 重复同步不应重复新增
        let again = reconcile_members(&conn, &people).unwrap();
        assert_eq!(again.added, 0);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM members", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }
}
