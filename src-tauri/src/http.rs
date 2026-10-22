use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 前端发来的请求描述。字段用 camelCase，和 TS 侧的结构体一一对应。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestInput {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
    /// 内网自签名证书时跳过校验。只在设置里显式打开才生效。
    pub allow_insecure_tls: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseOutput {
    pub status: u16,
    pub ok: bool,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub duration_ms: u64,
}

/// 复用两个 client：跳过 TLS 校验的 client 单独一份，避免为每个请求重建连接池。
fn client(insecure: bool) -> &'static reqwest::Client {
    static SECURE: OnceLock<reqwest::Client> = OnceLock::new();
    static INSECURE: OnceLock<reqwest::Client> = OnceLock::new();

    if insecure {
        INSECURE.get_or_init(|| build_client(true))
    } else {
        SECURE.get_or_init(|| build_client(false))
    }
}

fn build_client(insecure: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(insecure)
        .danger_accept_invalid_hostnames(insecure)
        // 超时由每个请求单独设置，这里只兜底连接阶段
        .connect_timeout(Duration::from_secs(20))
        .build()
        .expect("构建 HTTP 客户端失败")
}

fn method_of(name: Option<&str>) -> Result<reqwest::Method, String> {
    match name.unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        "HEAD" => Ok(reqwest::Method::HEAD),
        other => Err(format!("不支持的请求方法：{other}")),
    }
}

/// 通用 HTTP 代理。
///
/// 存在的意义有两个：绕开 webview 的同源策略（内网 GitLab 不会给 CORS 头），
/// 以及让 Token 不落在页面上下文里。
#[tauri::command]
pub async fn http_request(req: HttpRequestInput) -> Result<HttpResponseOutput, String> {
    let method = method_of(req.method.as_deref())?;
    let insecure = req.allow_insecure_tls.unwrap_or(false);
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(30_000));
    let body_bytes = req.body.as_ref().map_or(0, |b| b.len());

    let mut builder = client(insecure)
        .request(method.clone(), &req.url)
        .timeout(timeout);

    // 请求头只记**名字**，值一律不记——X-Token 就挂在里面。
    // 唯一的例外是 content-type：它是「服务端说读不了请求体」这件事的头号嫌疑，
    // 而它不含任何凭据。
    let header_names: Vec<String> = req
        .headers
        .as_ref()
        .map(|h| h.keys().cloned().collect())
        .unwrap_or_default();
    let content_type = req
        .headers
        .as_ref()
        .and_then(|h| {
            h.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                .map(|(_, v)| v.clone())
        })
        .unwrap_or_else(|| "（无）".into());

    if let Some(headers) = req.headers {
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
    }

    // 请求体同理：登录请求体里装着 loginInfo（用户名密码的 Base64），
    // 那种一律不记；查询类的请求体只有日期和分页，是排查「服务端说读不了」的唯一线索。
    if let Some(body) = &req.body {
        if !body.contains("loginInfo") {
            log::info!(
                "  请求头：{}（content-type: {}）",
                header_names.join(", "),
                content_type
            );
            log::info!("  请求体：{}", body.chars().take(600).collect::<String>());
        }
    }

    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let started = Instant::now();

    // 走向和结果都记一笔。界面上的提示要照顾普通用户，说不细；
    // 排查时需要的「打了哪个地址、服务端回了什么」，只有日志里有。
    //
    // **不记请求体内容**：登录请求体里装着 loginInfo（用户名密码的 Base64）和验证码字段，
    // 落进日志等于把凭据写到了磁盘上。记长度足够判断「发出去了没有、发了多少」。
    log::info!("→ {} {}（请求体 {} 字节）", method, req.url, body_bytes);

    let res = match builder.send().await {
        Ok(res) => res,
        Err(e) => {
            let message = describe_reqwest_error(&req.url, &e);
            log::warn!("← 请求失败：{message}");
            return Err(message);
        }
    };

    let status = res.status();
    let response_headers = res
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                v.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();

    let body = res
        .text()
        .await
        .map_err(|e| format!("读取响应内容失败：{e}"))?;

    if status.is_success() {
        log::info!(
            "← {} {}（{} 字节，{}ms）",
            status.as_u16(),
            req.url,
            body.len(),
            started.elapsed().as_millis()
        );
        // 小响应基本是「空页」或「业务错误信封」——正好是排查字段映射时要看的东西。
        // 大的才是业务数据本身，不记。
        //
        // 但有两种响应又小又敏感，按**内容**排除而不是按体积：
        // 登录响应带 accessToken，日志中心的用户清单会连带返回 loginPwd（密码）。
        // 凭据一旦落进日志就等于写在磁盘上了。
        if body.len() < 400 && !body.contains("accessToken") && !body.contains("loginPwd") {
            log::info!("  正文：{}", body);
        }
    } else {
        // 失败时才记响应正文——成功响应里可能带 accessToken
        log::warn!(
            "← {} {}：{}",
            status.as_u16(),
            req.url,
            body.chars().take(300).collect::<String>()
        );
    }

    Ok(HttpResponseOutput {
        status: status.as_u16(),
        ok: status.is_success(),
        headers: response_headers,
        body,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 顺着 source 链找关键字。
///
/// reqwest 的 Display 只给最外层那句话，证书问题藏在 source 链里，
/// 不挖出来就会被归成「连不上」——而这两件事的处置方式完全相反。
fn chain_mentions(err: &(dyn std::error::Error + 'static), needle: &str) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if e.to_string().to_lowercase().contains(needle) {
            return true;
        }
        cur = e.source();
    }
    false
}

/// 是不是「证书不被信任」这一类失败。
fn looks_like_tls_failure(err: &reqwest::Error) -> bool {
    [
        "certificate",
        "unknown issuer",
        "self-signed",
        "self signed",
        "invalid peer",
        "handshake",
    ]
    .iter()
    .any(|needle| chain_mentions(err, needle))
}

/// 把 reqwest 的错误翻译成能直接展示给用户的中文提示。
/// 默认的 Display 输出是一长串链路信息，界面上没法看。
pub fn describe_reqwest_error(url: &str, err: &reqwest::Error) -> String {
    let host = url
        .split("//")
        .nth(1)
        .and_then(|s| s.split('/').next())
        .unwrap_or(url);

    if err.is_timeout() {
        return format!("请求超时：{host} 在超时时间内没有响应");
    }
    // 证书问题必须排在 is_connect 前面：reqwest 把它归为连接失败，
    // 直接按「无法连接」报出去，用户会去查网络和防火墙，方向全错
    if looks_like_tls_failure(err) {
        return format!(
            "无法与 {host} 建立安全连接：服务端证书不被信任（内网自签名证书很常见）。\
             到对应的设置分区打开「跳过 TLS 证书校验」；\
             如果确认证书本身没问题，那就是本机缺了签发它的根证书"
        );
    }
    if err.is_connect() {
        return format!(
            "无法连接到 {host}。请检查地址是否正确、本机能否访问该网络，\
             以及是否被代理或防火墙拦截"
        );
    }
    if err.is_redirect() {
        return format!("{host} 返回了过多重定向，请检查地址是否写错");
    }
    if err.is_body() || err.is_decode() {
        return format!("读取 {host} 的响应失败：{err}");
    }
    format!("请求 {host} 失败：{err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一条「外层看不出、里层才有」的错误链，形状和 reqwest 给出的那种一样
    #[derive(Debug)]
    struct Layer(String, Option<Box<Layer>>);

    impl std::fmt::Display for Layer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{}", self.0)
        }
    }

    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1
                .as_deref()
                .map(|e| e as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn finds_keyword_buried_in_the_error_chain() {
        // reqwest 只在最外层挂自己的话，证书那层藏在 source 里——
        // 不往下挖就会把证书问题报成「连不上」，方向完全反
        let err = Layer(
            "error sending request".into(),
            Some(Box::new(Layer(
                "client error (Connect)".into(),
                Some(Box::new(Layer(
                    "invalid peer certificate: UnknownIssuer".into(),
                    None,
                ))),
            ))),
        );

        assert!(chain_mentions(&err, "certificate"));
        assert!(chain_mentions(&err, "unknownissuer"));
        assert!(!chain_mentions(&err, "timeout"));
    }
}
