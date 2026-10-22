use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// 代码分析工具（codegraph / graphify）的检测，以及分析缓存目录的用量与清理。
///
/// 这里刻意不调 npm/pip 装包：安装要跑第三方脚本，属于用户明确同意的动作，
/// 这一层只负责「找到没有、在哪、什么版本」和「缓存占了多少、能不能安全删掉」。
/// 检测结果不落库——PATH 随时会变，每次打开设置页重新探测一次更可信。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisDefaults {
    /// 应用数据目录，用来向用户说明缓存默认落在哪里
    pub app_data_dir: String,
    /// 应用自建缓存目录（可删除）：克隆的仓库副本、索引、分析产物
    pub default_cache_dir: String,
    /// 建议的代码根目录（只读用途，应用不会删除其内容）
    pub default_code_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// configured = 用户在设置里指定；path = 从 PATH 里找到；bundled = 随应用分发
    pub source: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirUsage {
    pub exists: bool,
    pub bytes: u64,
    pub files: u64,
    /// 目录不存在时也能给出路径，界面照常展示
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub removed_bytes: u64,
    pub removed_entries: u64,
}

/// 缓存目录里可能出现的「不是缓存」的痕迹。
/// 命中就拒绝清空——把用户的仓库副本误删是不可恢复的事故。
const PROTECTED_ENTRIES: [&str; 1] = [".git"];

fn tool_names(kind: &str) -> Result<&'static str, String> {
    match kind {
        "codegraph" => Ok("codegraph"),
        "graphify" => Ok("graphify"),
        // git 不是「分析工具」，但克隆仓库、统计改动热点都依赖它，
        // 所以走同一套探测逻辑，缺失时能明确告诉用户
        "git" => Ok("git"),
        other => Err(format!("未知的分析工具：{other}")),
    }
}

/// PATH 里按顺序找可执行文件。
///
/// 自己扫而不是调 `where`：Windows 上还能顺带认 `.cmd`/`.bat`（npm 的全局命令
/// 通常就是这两种），且不受 shell 环境影响。
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat", ".ps1"]
    } else {
        &[""]
    };

    for dir in std::env::split_paths(&path) {
        for ext in exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn read_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr)
    } else {
        String::from_utf8_lossy(&output.stdout)
    };
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    let mut line = line.to_string();
    if line.len() > 120 {
        line.truncate(120);
    }
    Some(line)
}

/// 探测一个工具。
///
/// 顺序：用户指定 > PATH。指定了但不存在时**仍然回退**到 PATH——
/// 用户可能刚换了安装方式，旧路径还留在配置里；目标是要能配合上，
/// 而不是死守着一个失效的字符串。
#[tauri::command]
pub fn tool_status(kind: String, configured: Option<String>) -> Result<ToolStatus, String> {
    let name = tool_names(&kind)?;
    let configured = configured.unwrap_or_default();
    let configured = configured.trim();

    let mut error: Option<String> = None;

    if !configured.is_empty() {
        let p = PathBuf::from(configured);
        if p.is_file() {
            return Ok(ToolStatus {
                found: true,
                version: read_version(&p),
                path: Some(p.to_string_lossy().into_owned()),
                source: Some("configured".into()),
                error: None,
            });
        }
        error = Some(format!("设置里指定的路径不存在：{configured}"));
    }

    if let Some(p) = find_in_path(name) {
        return Ok(ToolStatus {
            found: true,
            version: read_version(&p),
            path: Some(p.to_string_lossy().into_owned()),
            source: Some("path".into()),
            error,
        });
    }

    Ok(ToolStatus {
        found: false,
        path: None,
        version: None,
        source: None,
        error: error.or_else(|| Some(format!("没有在 PATH 里找到 {name}"))),
    })
}

/// 应用数据目录与分析默认路径。
#[tauri::command]
pub fn analysis_defaults(app: AppHandle) -> Result<AnalysisDefaults, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let cache = app_data.join("analysis");
    // 目录先建出来：界面第一次打开就能显示 0 B，而不是「路径不存在」
    fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败：{e}"))?;

    let code_root = app_data.join("code");
    // 代码目录也给个默认位置并建出来：用户不必先自己造目录，把仓库放进去即可
    fs::create_dir_all(&code_root).map_err(|e| format!("创建代码目录失败：{e}"))?;
    Ok(AnalysisDefaults {
        app_data_dir: app_data.to_string_lossy().into_owned(),
        default_cache_dir: cache.to_string_lossy().into_owned(),
        default_code_root: code_root.to_string_lossy().into_owned(),
    })
}

/// 统计目录占用。
///
/// 递归遍历，但不跟随符号链接（防环），并设了条目上限：
/// 缓存目录理论上都是应用自己写的，可一旦用户把路径指到大盘上，
/// 没有上限的遍历会让设置页卡死。超出上限时返回已统计的部分，
/// 数字偏小总比界面转圈不动强——这里只用来判断「该不该清理」。
#[tauri::command]
pub fn dir_usage(path: String) -> Result<DirUsage, String> {
    const MAX_ENTRIES: u64 = 500_000;

    let root = PathBuf::from(path.trim());
    if !root.exists() {
        return Ok(DirUsage {
            exists: false,
            bytes: 0,
            files: 0,
            path: root.to_string_lossy().into_owned(),
        });
    }

    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut seen = 0u64;
    let mut stack = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                break;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                bytes += meta.len();
                files += 1;
            }
        }
    }

    Ok(DirUsage {
        exists: true,
        bytes,
        files,
        path: root.to_string_lossy().into_owned(),
    })
}

/// 清空缓存目录的**内容**，保留目录本身。
///
/// 安全约束（任何一条不满足都拒绝执行，而不是「尽力而为」）：
/// - 必须是已存在的目录，且路径至少有两层（挡住 `C:\` / `/`）；
/// - 不能是用户主目录；
/// - 顶层不能有 `.git`——那说明这里是一份仓库工作区，不是缓存；
/// - 不能和「代码目录」互相包含——缓存和用户的 checkout 必须是两个地方，
///   否则一次清理会把用户自己的仓库删掉。
#[tauri::command]
pub fn clear_cache(path: String, code_root: Option<String>) -> Result<ClearResult, String> {
    let root = PathBuf::from(path.trim());
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("路径不存在或无法访问：{e}"))?;

    if !canonical.is_dir() {
        return Err("这不是一个目录".into());
    }
    if canonical.components().count() < 2 {
        return Err("拒绝清空磁盘根目录".into());
    }

    if let Some(home) = home_dir() {
        if let (Ok(a), Ok(b)) = (canonical.canonicalize(), home.canonicalize()) {
            if a == b {
                return Err("拒绝清空用户主目录".into());
            }
        }
    }

    for protected in PROTECTED_ENTRIES {
        if canonical.join(protected).exists() {
            return Err(format!(
                "这个目录下有 {protected}，看起来是一份仓库工作区，不是缓存。已拒绝清空。"
            ));
        }
    }

    if let Some(code_root) = code_root {
        let code_root = code_root.trim();
        if !code_root.is_empty() {
            if let Ok(code) = PathBuf::from(code_root).canonicalize() {
                // 互相包含都不行：清缓存会连带删掉代码，反过来清代码目录也会被当成缓存
                if code.starts_with(&canonical) || canonical.starts_with(&code) {
                    return Err(
                        "缓存目录和代码目录重叠了。它们必须是两个互不包含的目录，否则会误删代码。"
                            .into(),
                    );
                }
            }
        }
    }

    let mut removed_bytes = 0u64;
    let mut removed_entries = 0u64;

    let entries = fs::read_dir(&canonical).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = if meta.is_dir() {
            size_of(&path)
        } else {
            meta.len()
        };

        let ok = if meta.is_dir() {
            fs::remove_dir_all(&path).is_ok()
        } else {
            fs::remove_file(&path).is_ok()
        };
        if ok {
            removed_bytes += size;
            removed_entries += 1;
        }
    }

    Ok(ClearResult {
        removed_bytes,
        removed_entries,
    })
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// 删除前统计体积：删除之后再算就算不出来了
fn size_of(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/* ------------------------------------------------------------------ *
 * 应用内安装
 * ------------------------------------------------------------------ */

/// 安装进度。最后一条 `done = true`，带成功与否和安装后的可执行文件路径。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallEvent {
    pub line: Option<String>,
    pub done: bool,
    pub ok: bool,
    pub path: Option<String>,
    pub message: Option<String>,
}

/// 正在安装的进程 pid，按工具名索引，供取消时使用。
fn install_pids() -> &'static Mutex<HashMap<String, u32>> {
    static PIDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tools_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("tools");
    fs::create_dir_all(&dir).map_err(|e| format!("创建工具目录失败：{e}"))?;
    Ok(dir)
}

fn emit(channel: &Channel<InstallEvent>, line: String) {
    let _ = channel.send(InstallEvent {
        line: Some(line),
        done: false,
        ok: false,
        path: None,
        message: None,
    });
}

/// 安装工具。
///
/// 命令**立刻返回**，真正的安装在后台线程里跑，过程通过 Channel 流式推给界面：
/// npm/pip 动辄几分钟，同步命令会把 IPC 卡住，界面连「正在装」都显示不出来。
#[tauri::command]
pub fn analysis_install(
    app: AppHandle,
    kind: String,
    channel: Channel<InstallEvent>,
) -> Result<(), String> {
    tool_names(&kind)?;
    if kind == "git" {
        return Err("Git 需要从系统安装（如 git-scm.com），应用内不提供安装".into());
    }
    let root = tools_root(&app)?;
    let ch = channel.clone();

    std::thread::spawn(move || {
        let result = run_install(&kind, &root, &ch);
        let (ok, path, message) = match result {
            Ok(path) => (true, Some(path), None),
            Err(err) => (false, None, Some(err)),
        };
        let _ = ch.send(InstallEvent {
            line: None,
            done: true,
            ok,
            path,
            message,
        });
    });

    Ok(())
}

/// 取消正在进行的安装。
#[tauri::command]
pub fn analysis_install_cancel(kind: String) -> Result<(), String> {
    let pid = install_pids()
        .lock()
        .map_err(|_| "状态锁不可用".to_string())?
        .remove(&kind);
    let Some(pid) = pid else { return Ok(()) };

    // 装上 npm 之后还会拉起子进程，所以要连子进程一起结束
    let result = if cfg!(windows) {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
    }
    else {
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
    };
    result.map_err(|e| format!("结束安装进程失败：{e}"))?;
    Ok(())
}

fn run_install(kind: &str, root: &Path, channel: &Channel<InstallEvent>) -> Result<String, String> {
    match kind {
        "codegraph" => {
            let dir = root.join("codegraph");
            fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
            let dir_str = dir.to_string_lossy().into_owned();
            let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };

            emit(channel, format!("$ {npm} install --prefix {dir_str} @colbymchenry/codegraph"));
            run_step(
                npm,
                &["install", "--prefix", dir_str.as_str(), "@colbymchenry/codegraph"],
                kind,
                channel,
            )?;

            let bin = dir
                .join("node_modules")
                .join(".bin")
                .join(if cfg!(windows) { "codegraph.cmd" } else { "codegraph" });
            if !bin.is_file() {
                return Err("安装命令执行完了，但没找到 codegraph 可执行文件".into());
            }
            Ok(bin.to_string_lossy().into_owned())
        }

        "graphify" => {
            let venv = root.join("graphify-venv");
            let venv_str = venv.to_string_lossy().into_owned();

            // 装进独立 venv：不污染用户环境，也不用管系统 Python 有没有装过别的版本
            emit(channel, format!("$ python -m venv {venv_str}"));
            run_step("python", &["-m", "venv", venv_str.as_str()], kind, channel)?;

            let pip = if cfg!(windows) {
                venv.join("Scripts").join("pip.exe")
            }
            else {
                venv.join("bin").join("pip")
            };
            if !pip.is_file() {
                return Err("venv 创建失败，没找到 pip".into());
            }
            let pip_str = pip.to_string_lossy().into_owned();
            emit(channel, format!("$ {pip_str} install graphifyy"));
            run_step(&pip_str, &["install", "graphifyy"], kind, channel)?;

            let bin = if cfg!(windows) {
                venv.join("Scripts").join("graphify.exe")
            }
            else {
                venv.join("bin").join("graphify")
            };
            if !bin.is_file() {
                return Err("pip 装完了，但没找到 graphify 可执行文件".into());
            }
            Ok(bin.to_string_lossy().into_owned())
        }

        other => Err(format!("未知的分析工具：{other}")),
    }
}

/// 跑一条命令，逐行把输出推给界面，并记录 pid 供取消。
fn run_step(
    program: &str,
    args: &[&str],
    kind: &str,
    channel: &Channel<InstallEvent>,
) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "无法启动 {program}：{e}。请确认它已经安装并且在 PATH 里"
            )
        })?;

    if let Ok(mut pids) = install_pids().lock() {
        pids.insert(kind.to_string(), child.id());
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // 两路分开读：只读一路的话，另一路写满管道会把子进程卡死
    let out_ch = channel.clone();
    let out_thread = stdout.map(|s| std::thread::spawn(move || pump(s, out_ch)));
    let err_ch = channel.clone();
    let err_thread = stderr.map(|s| std::thread::spawn(move || pump(s, err_ch)));

    let status = child.wait().map_err(|e| format!("等待 {program} 结束失败：{e}"))?;
    if let Some(t) = out_thread {
        let _ = t.join();
    }
    if let Some(t) = err_thread {
        let _ = t.join();
    }
    if let Ok(mut pids) = install_pids().lock() {
        pids.remove(kind);
    }

    if status.success() {
        Ok(())
    }
    else {
        Err(format!("{program} 执行失败（{status}）"))
    }
}

fn pump<R: std::io::Read>(reader: R, channel: Channel<InstallEvent>) {
    for line in BufReader::new(reader).lines().map_while(Result::ok) {
        let _ = channel.send(InstallEvent {
            line: Some(line),
            done: false,
            ok: false,
            path: None,
            message: None,
        });
    }
}

/* ------------------------------------------------------------------ *
 * 仓库扫描与热点
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFile {
    pub path: String,
    pub language: String,
    pub bytes: u64,
    /// 结构标记：从文件内容里认出来的入口类型（controller/service/job/vue-view…）
    pub flags: Vec<String>,
    /// 依赖声明：Java 的 import 全名、前端的模块说明符。
    /// 由前端映射成「模块 → 模块」的边，用来画依赖图。
    pub imports: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoScan {
    pub root: String,
    pub files: Vec<RepoFile>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotspot {
    pub path: String,
    pub changes: u64,
}

/// 这些目录里要么是依赖、要么是构建产物，对「项目做了什么」没有信息量。
const SKIP_DIRS: [&str; 14] = [
    ".git", "node_modules", "target", "dist", "build", "out", ".idea", ".vscode",
    ".codegraph", "graphify-out", ".gradle", ".mvn", "coverage", "vendor",
];

/// 单文件超过 1MB 就不读了：生成代码、压缩产物会淹没统计，也不适合喂给模型。
const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_FILES: usize = 20_000;

fn language_of(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "java" => Some("java"),
        "kt" => Some("kotlin"),
        "vue" => Some("vue"),
        "ts" | "tsx" => Some("typescript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "py" => Some("python"),
        "go" => Some("go"),
        "rs" => Some("rust"),
        "sql" => Some("sql"),
        "xml" | "gradle" | "pom" => Some("xml"),
        "yml" | "yaml" => Some("yaml"),
        "md" => Some("markdown"),
        _ => None,
    }
}

/// 从内容里判断「这是什么角色」。
///
/// 用的都是框架里稳定的关键字，不做语法分析——这里要的是给模块画像提供线索，
/// 不是编译。命中不了就留空，让模型依据文件名和目录判断。
fn flags_of(content: &str) -> Vec<String> {
    const MARKERS: [(&str, &str); 10] = [
        ("@RestController", "http-api"),
        ("@Controller", "http-api"),
        ("@RequestMapping", "http-api"),
        ("@Service", "service"),
        ("@Repository", "repository"),
        ("@Scheduled", "scheduled-job"),
        ("@KafkaListener", "message-consumer"),
        ("@RabbitListener", "message-consumer"),
        ("@FeignClient", "rpc-client"),
        ("public static void main", "entrypoint"),
    ];

    let mut flags: Vec<String> = Vec::new();
    for (marker, flag) in MARKERS {
        if content.contains(marker) && !flags.iter().any(|f| f == flag) {
            flags.push(flag.to_string());
        }
    }
    if content.contains("defineStore(") || content.contains("@/store/") {
        flags.push("state-store".into());
    }
    if content.contains("createRouter(") {
        flags.push("router".into());
    }
    if content.contains("<template") {
        flags.push("vue-view".into());
    }
    flags
}

/// 取一段文本里第一个引号字符串（' 或 "）。只用于从 import 语句里拿说明符。
fn first_quoted(text: &str) -> Option<String> {
    let text = text.trim_start();
    let quote = text.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let rest = &text[quote.len_utf8()..];
    let end = rest.find(quote)?;
    let spec = rest[..end].trim();
    if spec.is_empty() || spec.len() > 200 {
        return None;
    }
    Some(spec.to_string())
}

/// 提取依赖声明。
///
/// 只做「够画模块依赖图」的近似：Java 取 import 全名，前端取 from/import 的说明符。
/// 不追求解析器的准确度——注释里的 import、条件编译分支都会被误收，
/// 但一条边错收只影响图的完整度，不会影响模块划分本身。
fn imports_of(path: &str, text: &str) -> Vec<String> {
    const MAX_IMPORTS: usize = 60;
    let lower = path.to_ascii_lowercase();
    let mut out: Vec<String> = Vec::new();

    if lower.ends_with(".java") || lower.ends_with(".kt") {
        for line in text.lines() {
            let line = line.trim();
            let Some(rest) = line.strip_prefix("import ") else { continue };
            let rest = rest
                .trim_start_matches("static ")
                .trim_end_matches(';')
                .trim();
            // 标准库永远在项目外，收进来只是噪音
            if rest.is_empty()
                || rest.starts_with("java.")
                || rest.starts_with("javax.")
                || rest.starts_with("kotlin.")
            {
                continue;
            }
            out.push(rest.to_string());
            if out.len() >= MAX_IMPORTS {
                break;
            }
        }
        return out;
    }

    let is_frontend = lower.ends_with(".ts")
        || lower.ends_with(".tsx")
        || lower.ends_with(".js")
        || lower.ends_with(".jsx")
        || lower.ends_with(".vue");
    if !is_frontend {
        return out;
    }

    // match_indices 给的是字节位置，且落在这几个 ASCII 子串上，切片不会切坏 UTF-8
    let mut hits: Vec<usize> = text
        .match_indices("from ")
        .map(|(i, _)| i)
        .chain(text.match_indices("import").map(|(i, _)| i))
        .collect();
    hits.sort_unstable();
    hits.dedup();

    for idx in hits {
        if out.len() >= MAX_IMPORTS {
            break;
        }
        let rest = &text[idx..];
        let offset = if rest.starts_with("from ") {
            5
        }
        else if rest.starts_with("import(") {
            7
        }
        else {
            6
        };
        if let Some(spec) = first_quoted(&text[idx + offset..]) {
            out.push(spec);
        }
    }

    out
}

fn scan_blocking(root: PathBuf) -> Result<RepoScan, String> {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut stack = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if files.len() >= MAX_FILES {
                truncated = true;
                break;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };

            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                continue;
            }

            let rel = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let Some(language) = language_of(&rel) else { continue };

            // 只读前 64KB：入口标记和 import 都在文件头部附近，整文件读没必要
            let mut flags = Vec::new();
            let mut imports = Vec::new();
            if let Ok(bytes) = fs::read(&path) {
                let head = &bytes[..bytes.len().min(64 * 1024)];
                if let Ok(text) = std::str::from_utf8(head) {
                    flags = flags_of(text);
                    imports = imports_of(&rel, text);
                }
            }

            files.push(RepoFile {
                path: rel,
                language: language.into(),
                bytes: meta.len(),
                flags,
                imports,
            });
        }
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
    }

    Ok(RepoScan {
        root: root.to_string_lossy().into_owned(),
        files,
        truncated,
    })
}

/// 扫描本地仓库的文件清单。
///
/// 用 spawn_blocking 包住：Windows 上遍历上万个文件可能几秒钟，
/// 直接放在命令里会把界面卡住。
#[tauri::command]
pub async fn scan_repo(path: String) -> Result<RepoScan, String> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err(format!("目录不存在：{}", root.display()));
    }
    tauri::async_runtime::spawn_blocking(move || scan_blocking(root))
        .await
        .map_err(|e| format!("扫描任务失败：{e}"))?
}

/// 按仓库路径在代码根目录下递归创建目录。
///
/// 两个用途：默认代码目录先建出来；生成画像时某个仓库本地不存在，
/// 就把「应该放在哪」的目录结构造好，用户把代码放进去就能重跑。
/// 路径来自 GitLab 的 path_with_namespace，仍要挡住 `..`——否则会逃出根目录。
#[tauri::command]
pub fn ensure_dirs(root: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root.trim());
    if root.as_os_str().is_empty() {
        return Err("代码根目录为空".into());
    }
    fs::create_dir_all(&root).map_err(|e| format!("创建代码根目录失败：{e}"))?;

    let mut created = Vec::new();
    for rel in paths {
        let rel = rel.trim().replace('\\', "/");
        let rel = rel.trim_matches('/');
        if rel.is_empty() || rel.split('/').any(|seg| seg == "..") {
            continue;
        }
        let dir = root.join(rel);
        if !dir.exists() {
            fs::create_dir_all(&dir)
                .map_err(|e| format!("创建目录 {} 失败：{e}", dir.display()))?;
            created.push(dir.to_string_lossy().into_owned());
        }
    }
    Ok(created)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub path: String,
    /// 目录里已经有内容，跳过克隆
    pub skipped: bool,
}

/// 把 URL 里的凭据抹掉。
///
/// 克隆地址里带着 `oauth2:<token>@host`，git 失败时会把整条命令回显到 stderr，
/// 原样透给界面就等于把 Token 打印在屏幕上、写进日志。
fn redact_url(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find("://") {
        let (head, tail) = rest.split_at(idx + 3);
        out.push_str(head);
        match tail.find('@') {
            Some(at) if !tail[..at].contains('/') => {
                out.push_str("***@");
                rest = &tail[at + 1..];
            }
            _ => {
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 浅克隆一个仓库到指定目录。
///
/// 用 `--depth` + `--single-branch`：画像只需要结构和近期改动，
/// 完整历史会让 itms-vue 这种 260MB 的仓库克隆到十几分钟。
/// 默认分支由调用方给（就是统计提交用的那条），保证「分析的分支」和「检查的分支」一致。
#[tauri::command]
pub async fn git_clone(
    url: String,
    dest: String,
    branch: Option<String>,
    depth: u32,
) -> Result<CloneResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CloneResult, String> {
        let dest = PathBuf::from(dest.trim());
        if dest.join(".git").exists() {
            return Ok(CloneResult {
                path: dest.to_string_lossy().into_owned(),
                skipped: true,
            });
        }
        // 目录里已经有东西（用户自己放的代码）也不动它，避免覆盖
        if fs::read_dir(&dest).map(|mut it| it.next().is_some()).unwrap_or(false) {
            return Ok(CloneResult {
                path: dest.to_string_lossy().into_owned(),
                skipped: true,
            });
        }

        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败：{e}", parent.display()))?;
        }

        let mut cmd = Command::new("git");
        cmd.arg("clone");
        if depth > 0 {
            cmd.args(["--depth", &depth.to_string()]);
        }
        cmd.arg("--single-branch");
        let branch = branch.unwrap_or_default();
        if !branch.trim().is_empty() {
            cmd.args(["--branch", branch.trim()]);
        }
        cmd.arg(&url).arg(&dest);

        let output = cmd
            .output()
            .map_err(|e| format!("无法执行 git：{e}。请确认本机已安装 Git"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = redact_url(stderr.trim());
            return Err(format!("git clone 失败：{detail}"));
        }

        Ok(CloneResult {
            path: dest.to_string_lossy().into_owned(),
            skipped: false,
        })
    })
    .await
    .map_err(|e| format!("克隆任务失败：{e}"))?
}

/// 当前 HEAD 提交。画像用它判断「代码有没有变、要不要重算」。
#[tauri::command]
pub async fn git_head(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let root = PathBuf::from(path.trim());
        if !root.join(".git").exists() {
            return Ok(String::new());
        }
        let output = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&root)
            .output()
            .map_err(|e| format!("执行 git 失败：{e}"))?;
        if !output.status.success() {
            return Ok(String::new());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|e| format!("读取 HEAD 失败：{e}"))?
}

/// 读取一个文本文件（给 skill 用）。
///
/// 只读、限长：skill 是一段 markdown 指令，几十 KB 足够；
/// 万一路径指到大文件上，也不至于把内存读爆。
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 64 * 1024;

    let root = PathBuf::from(path.trim());
    let meta = fs::metadata(&root).map_err(|e| format!("读取文件失败：{e}"))?;
    if !meta.is_file() {
        return Err("这不是一个文件".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("文件超过 {} KB，不像是一段 skill 指令", MAX_BYTES / 1024));
    }

    fs::read_to_string(&root).map_err(|e| format!("读取文件失败：{e}"))
}

/// 近期改动热点：按文件统计提交次数。
///
/// 用本地 git 而不是 GitLab API：这里要的是「近期哪些文件在动」，
/// 一次 `git log --name-only` 就能拿到，比按提交逐个查仓库省得多。
#[tauri::command]
pub async fn git_hotspots(path: String, days: u32) -> Result<Vec<Hotspot>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Hotspot>, String> {
        let root = PathBuf::from(path.trim());
        if !root.join(".git").exists() {
            return Ok(Vec::new());
        }

        let since = format!("--since={days} days ago");
        let output = Command::new("git")
            .args(["log", since.as_str(), "--name-only", "--pretty=format:"])
            .current_dir(&root)
            .output()
            .map_err(|e| format!("执行 git 失败：{e}"))?;

        if !output.status.success() {
            return Ok(Vec::new());
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let mut counts: HashMap<String, u64> = HashMap::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            *counts.entry(line.to_string()).or_insert(0) += 1;
        }

        let mut hotspots: Vec<Hotspot> = counts
            .into_iter()
            .map(|(path, changes)| Hotspot { path, changes })
            .collect();
        hotspots.sort_by(|a, b| b.changes.cmp(&a.changes));
        hotspots.truncate(50);
        Ok(hotspots)
    })
    .await
    .map_err(|e| format!("热点统计失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ti-analysis-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn dir_usage_counts_nested_files() {
        let dir = temp_dir("usage");
        fs::write(dir.join("a.bin"), b"12345").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/b.bin"), b"678").unwrap();

        let usage = dir_usage(dir.to_string_lossy().into_owned()).unwrap();
        assert!(usage.exists);
        assert_eq!(usage.bytes, 8);
        assert_eq!(usage.files, 2);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dir_usage_reports_missing_directory() {
        let missing = std::env::temp_dir().join("ti-analysis-does-not-exist-xyz");
        let usage = dir_usage(missing.to_string_lossy().into_owned()).unwrap();
        assert!(!usage.exists);
        assert_eq!(usage.bytes, 0);
    }

    #[test]
    fn clear_cache_removes_contents_but_keeps_root() {
        let dir = temp_dir("clear");
        fs::write(dir.join("a.bin"), b"12345").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/b.bin"), b"678").unwrap();

        let result = clear_cache(dir.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(result.removed_bytes, 8);
        assert_eq!(result.removed_entries, 2);
        // 目录本身要留着：下次启动直接往里写，不至于要重新创建
        assert!(dir.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_cache_refuses_repository_workspace() {
        let dir = temp_dir("repo");
        fs::create_dir_all(dir.join(".git")).unwrap();

        let err = clear_cache(dir.to_string_lossy().into_owned(), None).unwrap_err();
        assert!(err.contains(".git"), "错误信息应说明拒绝原因：{err}");

        // 拒绝之后不能动里面的东西
        assert!(dir.join(".git").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_cache_refuses_overlapping_code_root() {
        let dir = temp_dir("overlap");
        let nested = dir.join("repo");
        fs::create_dir_all(&nested).unwrap();

        // 代码目录在缓存目录里面：清缓存会把代码一起删掉
        let err = clear_cache(
            dir.to_string_lossy().into_owned(),
            Some(nested.to_string_lossy().into_owned()),
        )
        .unwrap_err();
        assert!(err.contains("重叠"), "应说明原因：{err}");

        // 反过来（缓存目录在代码目录里面）同样拒绝
        let err = clear_cache(
            nested.to_string_lossy().into_owned(),
            Some(dir.to_string_lossy().into_owned()),
        )
        .unwrap_err();
        assert!(err.contains("重叠"), "应说明原因：{err}");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tool_status_falls_back_to_path_when_configured_path_is_broken() {
        // 指定的路径不存在时不该直接判死，用户可能换过安装方式
        let status = tool_status(
            "codegraph".into(),
            Some("C:/definitely/not/here/codegraph.exe".into()),
        )
        .unwrap();

        assert!(status.error.is_some(), "应保留「指定路径无效」的提示");
        if status.found {
            assert_eq!(status.source.as_deref(), Some("path"));
        }
    }

    #[test]
    fn ensure_dirs_creates_nested_paths_and_blocks_traversal() {
        let dir = temp_dir("ensure");
        let created = ensure_dirs(
            dir.to_string_lossy().into_owned(),
            vec![
                "ns/backend/service".into(),
                "../escape".into(),
                "".into(),
            ],
        )
        .unwrap();

        assert_eq!(created.len(), 1);
        assert!(dir.join("ns/backend/service").is_dir());
        // `..` 必须被挡住，不能跑到根目录外面去建目录
        assert!(!dir.parent().unwrap().join("escape").exists());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn extracts_imports_for_java_and_frontend() {
        let java = "package a.b;\nimport java.util.List;\nimport static org.junit.Assert.*;\nimport com.dfec.soft.phoenix.run.RunService;\n";
        let imports = imports_of("a/b/Foo.java", java);
        assert!(imports.iter().any(|i| i == "com.dfec.soft.phoenix.run.RunService"));
        assert!(!imports.iter().any(|i| i.starts_with("java.")), "标准库不该收进来");

        let vue = "import { ref } from 'vue'\nimport Row from '@/components/layout/Row.vue'\nexport { x } from \"./utils\"\nconst m = await import('./lazy')\n";
        let imports = imports_of("web/src/views/A.vue", vue);
        assert!(imports.iter().any(|i| i == "@/components/layout/Row.vue"));
        assert!(imports.iter().any(|i| i == "./utils"));
        assert!(imports.iter().any(|i| i == "./lazy"));
    }

    #[test]
    fn redacts_credentials_from_clone_output() {
        let raw = "fatal: unable to access 'https://oauth2:glpat-secret@gitlab.example.com/a/b.git/': 403";
        let clean = redact_url(raw);
        assert!(!clean.contains("glpat-secret"), "Token 必须被抹掉：{clean}");
        assert!(clean.contains("https://***@gitlab.example.com"));
        // 没有凭据的地址保持原样
        assert_eq!(redact_url("https://gitlab.example.com/a.git"), "https://gitlab.example.com/a.git");
    }

    #[test]
    fn tool_status_rejects_unknown_kind() {
        assert!(tool_status("unknown".into(), None).is_err());
    }

    #[test]
    fn scan_skips_dependencies_and_marks_entry_points() {
        let dir = temp_dir("scan");
        fs::create_dir_all(dir.join("src/main/java/io/demo/agent")).unwrap();
        fs::write(
            dir.join("src/main/java/io/demo/agent/AgentController.java"),
            "package io.demo.agent;\n@RestController\npublic class AgentController {}",
        )
        .unwrap();
        fs::write(
            dir.join("src/main/java/io/demo/Job.java"),
            "@Scheduled\npublic class Job {}",
        )
        .unwrap();
        fs::write(dir.join("README.md"), "# demo").unwrap();

        // 依赖目录必须被跳过，否则统计会被第三方代码淹没
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "x").unwrap();

        let scan = scan_blocking(dir.clone()).unwrap();
        let paths: Vec<&str> = scan.files.iter().map(|f| f.path.as_str()).collect();

        assert!(paths.contains(&"src/main/java/io/demo/agent/AgentController.java"));
        assert!(paths.contains(&"README.md"));
        assert!(!paths.iter().any(|p| p.starts_with("node_modules")));

        let controller = scan
            .files
            .iter()
            .find(|f| f.path.ends_with("AgentController.java"))
            .unwrap();
        assert!(controller.flags.iter().any(|f| f == "http-api"));

        let job = scan.files.iter().find(|f| f.path.ends_with("Job.java")).unwrap();
        assert!(job.flags.iter().any(|f| f == "scheduled-job"));

        fs::remove_dir_all(&dir).ok();
    }
}
