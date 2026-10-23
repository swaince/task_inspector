use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

/// 一个本地 stdio MCP 服务器的配置。
///
/// 和前端 settings.analysis.mcpServers 对齐；`cwd` 是可选的，
/// 给 graphify 这种按目录找 graph.json 的服务器用。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: String,
    #[serde(default)]
    pub env: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

/// 暴露给前端的工具描述。qualified_name 是给模型看的名字，避免多个服务器重名。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    pub qualified_name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolsResult {
    pub tools: Vec<McpTool>,
    pub errors: Vec<String>,
}

struct McpSession {
    name: String,
    config_key: String,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    tools: Vec<McpTool>,
}

impl McpSession {
    async fn spawn(cfg: &McpServerConfig) -> Result<Self, String> {
        let args = split_args(&cfg.args);
        let mut command = build_command(cfg, &args);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(cwd) = cfg.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            command.current_dir(cwd);
        }
        for line in cfg.env.lines() {
            let line = line.trim();
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                if !key.is_empty() {
                    command.env(key, value.trim());
                }
            }
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 {} 失败：{e}", cfg.name))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("{} 没有 stdin", cfg.name))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("{} 没有 stdout", cfg.name))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("{} 没有 stderr", cfg.name))?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    // 通知（notifications/...）没有 id，忽略
                    continue;
                };
                let result = match message.get("error") {
                    Some(err) => Err(err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("MCP 调用失败")
                        .to_string()),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                if let Some(tx) = pending_reader.lock().await.remove(&id) {
                    let _ = tx.send(result);
                }
            }
            let mut map = pending_reader.lock().await;
            for (_, tx) in map.drain() {
                let _ = tx.send(Err("MCP 进程已退出".to_string()));
            }
        });

        let name = cfg.name.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[mcp:{name}] {line}");
            }
        });

        let mut session = Self {
            name: cfg.name.clone(),
            config_key: config_key(cfg),
            stdin: Mutex::new(stdin),
            pending,
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
            tools: Vec::new(),
        };
        session.initialize().await?;
        Ok(session)
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "task-inspector",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
            20,
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await?;

        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(value) => json!({ "cursor": value }),
                None => json!({}),
            };
            let result = self.request("tools/list", params, 30).await?;
            if let Some(list) = result.get("tools").and_then(Value::as_array) {
                for tool in list {
                    let Some(name) = tool.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let server_name = self.name.clone();
                    let server_id = self
                        .config_key
                        .split('|')
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    tools.push(McpTool {
                        server_id: server_id.clone(),
                        server_name: server_name.clone(),
                        name: name.to_string(),
                        qualified_name: format!("{server_name}__{name}"),
                        description: tool
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        input_schema: tool
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or_else(|| json!({ "type": "object" })),
                    });
                }
            }
            match result.get("nextCursor").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
                _ => break,
            }
        }

        self.tools = tools;
        Ok(())
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout_seconds: u64,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        line.push('\n');
        if let Err(err) = self.stdin.lock().await.write_all(line.as_bytes()).await {
            self.pending.lock().await.remove(&id);
            return Err(format!("写入 {} 失败：{err}", self.name));
        }

        match timeout(Duration::from_secs(timeout_seconds), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("{} 的连接已关闭", self.name)),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("{} 的 {method} 超时", self.name))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .lock()
            .await
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写入 {} 失败：{e}", self.name))
    }

    async fn kill(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}

fn config_key(cfg: &McpServerConfig) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        cfg.id,
        cfg.command,
        cfg.args,
        cfg.env,
        cfg.cwd.as_deref().unwrap_or_default()
    )
}

#[derive(Default)]
pub struct McpManager {
    sessions: Mutex<HashMap<String, Arc<McpSession>>>,
}

impl McpManager {
    async fn ensure(&self, cfg: &McpServerConfig) -> Result<Arc<McpSession>, String> {
        let key = config_key(cfg);
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(&cfg.id)
            && session.config_key == key
        {
            return Ok(session.clone());
        }
        if let Some(old) = sessions.remove(&cfg.id) {
            old.kill().await;
        }
        let session = Arc::new(McpSession::spawn(cfg).await?);
        sessions.insert(cfg.id.clone(), session.clone());
        Ok(session)
    }

    pub async fn list_tools(&self, servers: Vec<McpServerConfig>) -> McpToolsResult {
        let mut tools = Vec::new();
        let mut errors = Vec::new();
        for cfg in servers
            .into_iter()
            .filter(|s| s.enabled && !s.command.trim().is_empty())
        {
            match self.ensure(&cfg).await {
                Ok(session) => tools.extend(session.tools.clone()),
                Err(err) => errors.push(format!("{}：{err}", cfg.name)),
            }
        }
        McpToolsResult { tools, errors }
    }

    pub async fn call(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Value,
        servers: Vec<McpServerConfig>,
    ) -> Result<Value, String> {
        let cfg = servers
            .into_iter()
            .find(|s| s.id == server_id)
            .ok_or_else(|| format!("找不到 MCP 服务器 {server_id}"))?;
        let session = self.ensure(&cfg).await?;
        if !session.tools.iter().any(|t| t.name == tool_name) {
            return Err(format!("{} 没有工具 {tool_name}", cfg.name));
        }
        session
            .request(
                "tools/call",
                json!({ "name": tool_name, "arguments": arguments }),
                120,
            )
            .await
    }
}

#[tauri::command]
pub async fn mcp_list_tools(
    servers: Vec<McpServerConfig>,
    manager: tauri::State<'_, McpManager>,
) -> Result<McpToolsResult, String> {
    Ok(manager.list_tools(servers).await)
}

#[tauri::command]
pub async fn mcp_call_tool(
    server: String,
    tool: String,
    args: Value,
    servers: Vec<McpServerConfig>,
    manager: tauri::State<'_, McpManager>,
) -> Result<Value, String> {
    manager.call(&server, &tool, args, servers).await
}

fn split_args(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in raw.chars() {
        match ch {
            '"' | '\'' if quote.is_none() => quote = Some(ch),
            c if Some(c) == quote => quote = None,
            c if c.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

#[cfg(windows)]
fn quote_windows_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }
    if !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn build_command(cfg: &McpServerConfig, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        // .cmd / .bat 不是可执行文件，必须交给 cmd.exe；裸命令（npx/python）
        // 也走 cmd，保证 PATHEXT 能展开。
        let is_exe = cfg.command.to_ascii_lowercase().ends_with(".exe");
        if !is_exe {
            let mut line = quote_windows_arg(&cfg.command);
            for arg in args {
                line.push(' ');
                line.push_str(&quote_windows_arg(arg));
            }
            let mut command = Command::new("cmd");
            command.arg("/C").arg(line);
            use std::os::windows::process::CommandExt;
            command.as_std_mut().creation_flags(0x08000000);
            return command;
        }
    }

    let mut command = Command::new(&cfg.command);
    command.args(args);
    command
}
