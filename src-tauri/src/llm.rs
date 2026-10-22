use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::http::describe_reqwest_error;

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Deserialize)]
pub struct LlmChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatRequest {
    /// "anthropic" 或 "openai-compatible"
    pub provider: String,
    pub base_url: Option<String>,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<LlmChatMessage>,
    pub temperature: f32,
    pub max_tokens: u32,
    pub timeout_ms: u64,
    pub json_mode: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// 通过 Tauri Channel 推给前端的事件，形状要和 ts 侧的 LlmStreamEvent 对齐。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LlmStreamEvent {
    Delta { text: String },
    Done { usage: Option<LlmUsage> },
    Error { message: String },
}

/// 正在进行的流，用于支持取消。
#[derive(Default)]
pub struct StreamRegistry {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl StreamRegistry {
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.flags.lock() {
            map.insert(id.to_string(), flag.clone());
        }
        flag
    }

    fn release(&self, id: &str) {
        if let Ok(mut map) = self.flags.lock() {
            map.remove(id);
        }
    }

    fn cancel(&self, id: &str) {
        if let Ok(map) = self.flags.lock()
            && let Some(flag) = map.get(id)
        {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn join_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

/// 组装请求体。这段逻辑必须和 ts 侧 bridge/protocol.ts 保持一致，
/// 改协议时两边要一起改。
fn build_body(req: &LlmChatRequest) -> serde_json::Value {
    if req.provider == "anthropic" {
        let system: Vec<&str> = req
            .messages
            .iter()
            .filter(|m| m.role == "system")
            .map(|m| m.content.as_str())
            .collect();

        let turns: Vec<serde_json::Value> = req
            .messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect();

        let mut body = serde_json::json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "stream": true,
            "messages": turns,
        });
        if !system.is_empty() {
            body["system"] = serde_json::json!(system.join("\n\n"));
        }
        return body;
    }

    let mut body = serde_json::json!({
        "model": req.model,
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": req
            .messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
    });
    if req.json_mode.unwrap_or(false) {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    body
}

fn build_request(req: &LlmChatRequest) -> (String, reqwest::Client, reqwest::header::HeaderMap) {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );

    let url = if req.provider == "anthropic" {
        headers.insert(
            "x-api-key",
            reqwest::header::HeaderValue::from_str(&req.api_key)
                .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")),
        );
        headers.insert(
            "anthropic-version",
            reqwest::header::HeaderValue::from_static(ANTHROPIC_VERSION),
        );
        let base = req
            .base_url
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());
        join_url(&base, "/v1/messages")
    } else {
        let auth = format!("Bearer {}", req.api_key);
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&auth) {
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
        let base = req
            .base_url
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://api.openai.com".to_string());
        join_url(&base, "/v1/chat/completions")
    };

    (url, reqwest::Client::new(), headers)
}

/// 只取「协议 + 主机 + 端口」用于日志。
///
/// 路径和查询串里可能带凭据（有的网关把 key 拼在 URL 上），所以整条地址不能进日志；
/// 而排查模型配置时最需要知道的恰恰是「到底打到了哪个主机」——地址写错是最常见的失败原因。
fn describe_endpoint(provider: &str, base_url: Option<&str>) -> String {
    let fallback = if provider == "anthropic" {
        "api.anthropic.com"
    } else {
        "（未配置地址）"
    };
    let raw = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);

    let after_scheme = raw.split_once("//").map_or(raw, |(_, rest)| rest);
    after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme)
        .to_string()
}

/// 流式对话。事件通过 Channel 推给前端，命令返回即代表流已结束，
/// 因此前端把 invoke 的 resolve 当作结束信号。
#[tauri::command]
pub async fn llm_stream(
    req: LlmChatRequest,
    stream_id: String,
    on_event: Channel<LlmStreamEvent>,
    registry: tauri::State<'_, StreamRegistry>,
) -> Result<(), String> {
    let cancelled = registry.register(&stream_id);

    /*
     * 记一笔走向。只记模型、消息数、提示词规模，**不记消息内容和 api_key**——
     * 消息里有日报正文和人员姓名，key 更不用说。
     * 但「打到了哪个主机、哪个模型、耗时多久、失败原因是什么」必须在日志里，
     * 否则模型调不通时界面上只有一句错误，排查全靠猜。
     */
    let prompt_chars: usize = req.messages.iter().map(|m| m.content.chars().count()).sum();
    log::info!(
        "→ LLM {} · {} · {}（{} 条消息，提示词 {} 字）",
        req.provider,
        req.model,
        describe_endpoint(&req.provider, req.base_url.as_deref()),
        req.messages.len(),
        prompt_chars
    );
    let started = std::time::Instant::now();

    // 无论走哪条分支返回，都要把取消标记从表里摘掉，避免长期运行后表无限增长
    let result = run_stream(&req, &on_event, &cancelled).await;
    registry.release(&stream_id);

    match result {
        Ok(()) => {
            log::info!("← LLM 完成（{}ms）", started.elapsed().as_millis());
            Ok(())
        }
        Err(message) => {
            if !cancelled.load(Ordering::SeqCst) {
                log::warn!(
                    "← LLM 失败（{}ms）：{message}",
                    started.elapsed().as_millis()
                );
                let _ = on_event.send(LlmStreamEvent::Error {
                    message: message.clone(),
                });
            }
            Err(message)
        }
    }
}

#[tauri::command]
pub fn llm_cancel(stream_id: String, registry: tauri::State<'_, StreamRegistry>) {
    registry.cancel(&stream_id);
}

async fn run_stream(
    req: &LlmChatRequest,
    on_event: &Channel<LlmStreamEvent>,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    if req.model.trim().is_empty() {
        return Err("未配置模型名".to_string());
    }

    let (url, client, headers) = build_request(req);

    let res = client
        .post(&url)
        .headers(headers)
        .timeout(Duration::from_millis(req.timeout_ms.max(5_000)))
        .json(&build_body(req))
        .send()
        .await
        .map_err(|e| describe_reqwest_error(&url, &e))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe_llm_error(status.as_u16(), &body));
    }

    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    let mut usage = LlmUsage::default();
    let mut received_any = false;

    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }

        let bytes = chunk.map_err(|e| format!("读取响应流失败：{e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // SSE 事件之间用空行分隔，\r\n\r\n 也要认
        while let Some((block, rest)) = take_event(&buffer) {
            buffer = rest;
            handle_block(&block, req, on_event, &mut usage, &mut received_any);
        }
    }

    if !buffer.trim().is_empty() {
        handle_block(&buffer, req, on_event, &mut usage, &mut received_any);
    }

    if !received_any {
        return Err(
            "模型没有返回任何内容。请确认模型名是否正确、该模型是否支持流式输出".to_string(),
        );
    }

    let _ = on_event.send(LlmStreamEvent::Done {
        usage: if usage.input_tokens.is_none() && usage.output_tokens.is_none() {
            None
        } else {
            Some(usage)
        },
    });

    Ok(())
}

/// 从缓冲区里切出一个完整事件，返回（事件内容, 剩余缓冲）。
fn take_event(buffer: &str) -> Option<(String, String)> {
    let bytes = buffer.as_bytes();
    // 优先找更早出现的那个分隔符
    let lf = find(bytes, b"\n\n");
    let crlf = find(bytes, b"\r\n\r\n");

    match (lf, crlf) {
        (Some(l), Some(c)) if c < l => Some((
            buffer[..c].to_string(),
            buffer[c + 4..].to_string(),
        )),
        (Some(l), _) => Some((buffer[..l].to_string(), buffer[l + 2..].to_string())),
        (None, Some(c)) => Some((buffer[..c].to_string(), buffer[c + 4..].to_string())),
        (None, None) => None,
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn handle_block(
    block: &str,
    req: &LlmChatRequest,
    on_event: &Channel<LlmStreamEvent>,
    usage: &mut LlmUsage,
    received_any: &mut bool,
) {
    for line in block.lines() {
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }

        let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
            continue;
        };

        if req.provider == "anthropic" {
            match json["type"].as_str().unwrap_or_default() {
                "content_block_delta" => {
                    if let Some(text) = json["delta"]["text"].as_str()
                        && !text.is_empty()
                    {
                        *received_any = true;
                        let _ = on_event.send(LlmStreamEvent::Delta {
                            text: text.to_string(),
                        });
                    }
                }
                "message_start" => {
                    if let Some(n) = json["message"]["usage"]["input_tokens"].as_u64() {
                        usage.input_tokens = Some(n);
                    }
                }
                "message_delta" => {
                    if let Some(n) = json["usage"]["output_tokens"].as_u64() {
                        usage.output_tokens = Some(n);
                    }
                }
                _ => {}
            }
            continue;
        }

        if let Some(text) = json["choices"][0]["delta"]["content"].as_str()
            && !text.is_empty()
        {
            *received_any = true;
            let _ = on_event.send(LlmStreamEvent::Delta {
                text: text.to_string(),
            });
        }
        if let Some(n) = json["usage"]["prompt_tokens"].as_u64() {
            usage.input_tokens = Some(n);
        }
        if let Some(n) = json["usage"]["completion_tokens"].as_u64() {
            usage.output_tokens = Some(n);
        }
    }
}

/// 把厂商返回的错误体翻译成人能看懂的一句话。
/// 内网推理服务的报错格式五花八门，这里只挑最常见的几种。
fn describe_llm_error(status: u16, body: &str) -> String {
    let trimmed = body.trim();
    let detail = if trimmed.len() > 400 {
        &trimmed[..400]
    } else {
        trimmed
    };

    let prefix = match status {
        401 => "API Key 无效或未授权",
        403 => "没有访问该模型的权限",
        404 => "接口地址或模型名不存在",
        429 => "触发限流或额度不足",
        500..=599 => "模型服务端错误",
        _ => "模型调用失败",
    };

    // 尽量把厂商的 error.message 抽出来，比整段 JSON 有用
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed)
        && let Some(msg) = json["error"]["message"].as_str()
    {
        return format!("{prefix}：{msg}");
    }

    format!("{prefix}（HTTP {status}）：{detail}")
}
