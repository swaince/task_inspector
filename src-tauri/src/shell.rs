use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::timeout;

/// 命令执行的硬上限。给模型的 trace 还会再截一次，这里只防止进程把内存打爆。
const MAX_OUTPUT_CHARS: usize = 100_000;
const MAX_LINE_CHARS: usize = 4_000;
const MAX_LINE_BYTES: usize = MAX_LINE_CHARS * 4;
const MAX_STREAM_LINES: usize = 2_000;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MIN_TIMEOUT_MS: u64 = 5_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ShellLine {
    Stdout { text: String },
    Stderr { text: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellRunResult {
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub truncated: bool,
    pub cancelled: bool,
    pub timed_out: bool,
    pub output: String,
}

struct RunControl {
    cancelled: AtomicBool,
    pid: Mutex<Option<u32>>,
}

impl RunControl {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            pid: Mutex::new(None),
        }
    }

    /// 返回 attach 之前是否已经收到取消请求
    fn attach(&self, pid: u32) -> bool {
        *self.pid.lock().unwrap() = Some(pid);
        self.cancelled.load(Ordering::SeqCst)
    }

    fn pid(&self) -> Option<u32> {
        *self.pid.lock().unwrap()
    }
}

/// 正在执行的命令。shell_cancel 需要按 run id 找到进程树并杀掉。
#[derive(Default)]
pub struct ShellRegistry {
    runs: Mutex<HashMap<String, Arc<RunControl>>>,
}

impl ShellRegistry {
    fn register(&self, run_id: &str) -> Result<Arc<RunControl>, String> {
        let mut runs = self.runs.lock().unwrap();
        if runs.contains_key(run_id) {
            return Err("同一个命令正在执行，请稍后再试".to_string());
        }
        let control = Arc::new(RunControl::new());
        runs.insert(run_id.to_string(), control.clone());
        Ok(control)
    }

    fn release(&self, run_id: &str) {
        self.runs.lock().unwrap().remove(run_id);
    }

    async fn cancel(&self, run_id: &str) {
        let control = {
            let runs = self.runs.lock().unwrap();
            runs.get(run_id).cloned()
        };
        let Some(control) = control else {
            return;
        };
        control.cancelled.store(true, Ordering::SeqCst);
        let pid = control.pid();
        kill_tree(pid).await;
    }
}

#[derive(Default)]
struct SinkState {
    text: String,
    chars: usize,
    truncated: bool,
    stream_lines: usize,
}

impl SinkState {
    /// 追加一行；返回需要推给前端的文本（超过流式上限时为 None）
    fn push(&mut self, line: &str, is_stderr: bool) -> Option<String> {
        let text = if is_stderr {
            format!("[stderr] {line}")
        } else {
            line.to_string()
        };

        if self.chars + 1 > MAX_OUTPUT_CHARS {
            self.truncated = true;
            return None;
        }

        let remaining = MAX_OUTPUT_CHARS - self.chars - 1;
        let (piece, cut) = take_chars(&text, remaining);
        if cut {
            self.truncated = true;
        }
        self.chars += piece.chars().count() + 1;
        self.text.push_str(&piece);
        self.text.push('\n');

        if self.stream_lines >= MAX_STREAM_LINES {
            return None;
        }
        self.stream_lines += 1;
        Some(piece)
    }
}

struct OutputSink {
    state: Mutex<SinkState>,
    channel: Channel<ShellLine>,
}

impl OutputSink {
    fn new(channel: Channel<ShellLine>) -> Self {
        Self {
            state: Mutex::new(SinkState::default()),
            channel,
        }
    }

    fn emit(&self, line: &str, is_stderr: bool) {
        let text = {
            let mut state = self.state.lock().unwrap();
            state.push(line, is_stderr)
        };
        if let Some(text) = text {
            let event = if is_stderr {
                ShellLine::Stderr { text }
            } else {
                ShellLine::Stdout { text }
            };
            let _ = self.channel.send(event);
        }
    }

    fn snapshot(&self) -> (String, bool) {
        let state = self.state.lock().unwrap();
        (state.text.clone(), state.truncated)
    }
}

fn take_chars(value: &str, max: usize) -> (String, bool) {
    if max == 0 {
        return (String::new(), !value.is_empty());
    }
    let mut out = String::new();
    for (count, ch) in value.chars().enumerate() {
        if count >= max {
            return (out, true);
        }
        out.push(ch);
    }
    (out, false)
}

fn truncate_line(value: &str) -> String {
    let (text, cut) = take_chars(value, MAX_LINE_CHARS);
    if cut {
        format!("{text}…")
    } else {
        text
    }
}

async fn pump<R: AsyncRead + Unpin>(
    mut reader: R,
    is_stderr: bool,
    sink: Arc<OutputSink>,
) {
    let mut buffer = vec![0u8; 8_192];
    let mut line: Vec<u8> = Vec::new();
    let mut line_truncated = false;

    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };

        for &byte in &buffer[..read] {
            if byte == b'\n' {
                let text = line_text(&line, line_truncated);
                sink.emit(&text, is_stderr);
                line.clear();
                line_truncated = false;
            } else if byte == b'\r' {
                // 行尾的 \r 在 line_text 里统一去掉
            } else if line.len() < MAX_LINE_BYTES {
                line.push(byte);
            } else {
                line_truncated = true;
            }
        }
    }

    if !line.is_empty() || line_truncated {
        let text = line_text(&line, line_truncated);
        sink.emit(&text, is_stderr);
    }
}

fn line_text(line: &[u8], truncated: bool) -> String {
    let raw = String::from_utf8_lossy(line);
    let trimmed = raw.trim_end_matches('\r');
    let text = truncate_line(trimmed);
    if truncated && !text.ends_with('…') {
        format!("{text}…")
    } else {
        text
    }
}

fn clamp_timeout(value: Option<u64>) -> u64 {
    value
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

fn paths_equal(a: &PathBuf, b: &PathBuf) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// cwd 必须是调用方给出的允许目录之一，且必须真实存在。
/// 使用精确相等而不是「在目录下」：模型编造子目录时直接拒绝，避免在错误仓库里执行。
fn validate_cwd(requested: &str, allowed: &[String]) -> Result<PathBuf, String> {
    if allowed.is_empty() {
        return Err("没有允许执行命令的项目目录".to_string());
    }
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("命令没有指定工作目录".to_string());
    }
    let canonical = fs::canonicalize(requested)
        .map_err(|_| format!("工作目录不存在或无法访问：{requested}"))?;
    if !canonical.is_dir() {
        return Err(format!("工作目录不是目录：{requested}"));
    }

    for path in allowed {
        let Ok(candidate) = fs::canonicalize(path.trim()) else {
            continue;
        };
        if paths_equal(&candidate, &canonical) {
            return Ok(canonical);
        }
    }

    Err("命令的工作目录不在项目本地仓库列表中，已拒绝执行".to_string())
}

fn build_command(command: &str, cwd: &PathBuf) -> Command {
    #[cfg(windows)]
    {
        // PowerShell 5.1 会按控制台代码页解码子进程输出；不先设成 UTF-8，
        // 中文文件名和提交信息会在 Rust 读到之前就变成乱码。
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
             $OutputEncoding = [Console]::OutputEncoding; \
             $ProgressPreference = 'SilentlyContinue'; \
             {command}\n\
             if ($null -ne $LASTEXITCODE) {{ exit $LASTEXITCODE }}"
        );
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-Command",
            &script,
        ]);
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x08000000);
        cmd.current_dir(cwd);
        cmd
    }

    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-lc").arg(command);
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
        cmd.current_dir(cwd);
        cmd
    }
}

async fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };

    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x08000000);
        let _ = cmd.status().await;
    }

    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

async fn run_command(
    command: String,
    cwd: String,
    allowed_cwds: Vec<String>,
    timeout_ms: Option<u64>,
    control: Arc<RunControl>,
    channel: Channel<ShellLine>,
) -> Result<ShellRunResult, String> {
    if command.trim().is_empty() {
        return Err("命令为空".to_string());
    }
    if command.chars().count() > 8_000 {
        return Err("命令过长（上限 8000 字符）".to_string());
    }
    if command.contains('\0') {
        return Err("命令包含非法字符".to_string());
    }

    let cwd = validate_cwd(&cwd, &allowed_cwds)?;
    let timeout_ms = clamp_timeout(timeout_ms);
    let started = Instant::now();

    let mut cmd = build_command(&command, &cwd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");

    // 命令正文可能包含 token、密码或连接串，日志里只记第一个词和长度
    let head = command.split_whitespace().next().unwrap_or("(空)");
    log::info!(
        "→ shell {}… · 长度={} · cwd={} · timeout={}ms",
        head,
        command.chars().count(),
        cwd.display(),
        timeout_ms
    );

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("启动命令失败：{err}"))?;
    let pid = child.id();
    let already_cancelled = pid.map(|pid| control.attach(pid)).unwrap_or(false);
    if already_cancelled {
        kill_tree(pid).await;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "命令没有 stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "命令没有 stderr".to_string())?;

    let sink = Arc::new(OutputSink::new(channel));
    let mut stdout_task = tokio::spawn(pump(stdout, false, sink.clone()));
    let mut stderr_task = tokio::spawn(pump(stderr, true, sink.clone()));

    let mut timed_out = false;
    let status = match timeout(Duration::from_millis(timeout_ms), child.wait()).await {
        Ok(result) => Some(result.map_err(|err| format!("等待命令退出失败：{err}"))?),
        Err(_) => {
            timed_out = true;
            kill_tree(pid).await;
            match timeout(Duration::from_secs(5), child.wait()).await {
                Ok(Ok(status)) => Some(status),
                _ => {
                    let _ = child.kill().await;
                    None
                }
            }
        }
    };

    // 孙进程可能继承并占着管道；父进程退出后 reader 未必结束。
    if timeout(Duration::from_secs(2), &mut stdout_task).await.is_err() {
        stdout_task.abort();
    }
    if timeout(Duration::from_secs(2), &mut stderr_task).await.is_err() {
        stderr_task.abort();
    }

    let (output, truncated) = sink.snapshot();
    let cancelled = control.cancelled.load(Ordering::SeqCst);
    let exit_code = status.and_then(|status| status.code());
    let duration_ms = started.elapsed().as_millis() as u64;

    log::info!(
        "← shell 退出码={:?} · {}ms · 取消={} 超时={} 截断={}",
        exit_code,
        duration_ms,
        cancelled,
        timed_out,
        truncated
    );

    Ok(ShellRunResult {
        exit_code,
        duration_ms,
        truncated,
        cancelled,
        timed_out,
        output,
    })
}

#[tauri::command]
pub async fn shell_run(
    command: String,
    cwd: String,
    allowed_cwds: Vec<String>,
    timeout_ms: Option<u64>,
    run_id: String,
    on_event: Channel<ShellLine>,
    registry: tauri::State<'_, ShellRegistry>,
) -> Result<ShellRunResult, String> {
    let control = registry.register(&run_id)?;
    let result = run_command(command, cwd, allowed_cwds, timeout_ms, control, on_event).await;
    registry.release(&run_id);
    result
}

#[tauri::command]
pub async fn shell_cancel(
    run_id: String,
    registry: tauri::State<'_, ShellRegistry>,
) -> Result<(), String> {
    registry.cancel(&run_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(name: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "task-inspector-shell-{name}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn cwd_must_match_allowlist_exactly() {
        let root = temp_dir("root");
        let child = root.join("sub");
        fs::create_dir_all(&child).unwrap();
        let allowed = vec![root.to_string_lossy().to_string()];

        assert!(validate_cwd(&root.to_string_lossy(), &allowed).is_ok());
        assert!(validate_cwd(&child.to_string_lossy(), &allowed).is_err());
        assert!(validate_cwd(&root.join("missing").to_string_lossy(), &allowed).is_err());
        assert!(validate_cwd(&root.to_string_lossy(), &[]).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_parent_of_allowed_directory() {
        let root = temp_dir("parent");
        let child = root.join("sub");
        fs::create_dir_all(&child).unwrap();
        let allowed = vec![child.to_string_lossy().to_string()];

        assert!(validate_cwd(&root.to_string_lossy(), &allowed).is_err());
        assert!(validate_cwd(&child.to_string_lossy(), &allowed).is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn output_is_capped_and_flags_truncation() {
        let mut state = SinkState::default();
        for _ in 0..(MAX_OUTPUT_CHARS / 10 + 10) {
            state.push("0123456789", false);
        }
        assert!(state.truncated);
        assert!(state.chars <= MAX_OUTPUT_CHARS);
        assert_eq!(state.stream_lines, MAX_STREAM_LINES);
    }

    #[test]
    fn truncation_counts_chinese_characters_not_bytes() {
        let (text, cut) = take_chars("中文内容", 2);
        assert_eq!(text, "中文");
        assert!(cut);

        let (text, cut) = take_chars("abc", 10);
        assert_eq!(text, "abc");
        assert!(!cut);
    }

    #[test]
    fn timeout_is_clamped() {
        assert_eq!(clamp_timeout(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(1)), MIN_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(999_999)), MAX_TIMEOUT_MS);
    }

    #[test]
    fn executes_a_simple_command_and_captures_output() {
        let root = temp_dir("run");
        let cwd = root.to_string_lossy().to_string();
        #[cfg(windows)]
        let command = "Write-Output hello-shell";
        #[cfg(not(windows))]
        let command = "echo hello-shell";

        let channel = Channel::new(|_| Ok(()));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime
            .block_on(run_command(
                command.to_string(),
                cwd.clone(),
                vec![cwd],
                Some(10_000),
                Arc::new(RunControl::new()),
                channel,
            ))
            .unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert!(result.output.contains("hello-shell"));
        assert!(!result.timed_out);
        assert!(!result.cancelled);

        let _ = fs::remove_dir_all(&root);
    }
}
