//! Managed HTTP: one shared reqwest client, bounded GET retries, setup/idle
//! timeouts, response size cap, optional bandwidth shaping, concurrency
//! limits, `public-only` SSRF policy and cooperative cancellation.

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Map, Value};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::config::NetworkConfig;
use crate::diag::{expert, sanitize_text, sanitize_url};

pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
pub const ACCEPT_AUTO: &str =
    "application/rss+xml,application/atom+xml,application/xml,application/json;q=0.9,*/*;q=0.8";
const RETRYABLE: [u16; 7] = [408, 425, 429, 500, 502, 503, 504];

#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    /// Lower-cased header names.
    pub headers: Map<String, Value>,
    pub body: String,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(Value::as_str)
    }
}

#[derive(Clone, Debug)]
pub enum HttpError {
    Status(Response),
    Timeout(String),
    Network { code: &'static str, message: String },
    Cancelled,
    Blocked(String),
    InvalidUrl(String),
    UnsupportedProtocol(String),
    TooLarge(u64),
}

impl HttpError {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status(r) => Some(r.status),
            _ => None,
        }
    }
    pub fn response(&self) -> Option<&Response> {
        match self {
            Self::Status(r) => Some(r),
            _ => None,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Status(_) => "ERR_BAD_RESPONSE",
            Self::Timeout(_) => "ECONNABORTED",
            Self::Network { code, .. } => code,
            Self::Cancelled => "ERR_CANCELED",
            Self::Blocked(_) => "OUTBOUND_TARGET_BLOCKED",
            Self::InvalidUrl(_) => "INVALID_URL",
            Self::UnsupportedProtocol(_) => "UNSUPPORTED_PROTOCOL",
            Self::TooLarge(_) => "ERR_RESPONSE_TOO_LARGE",
        }
    }
    fn retryable(&self) -> bool {
        match self {
            Self::Status(r) => RETRYABLE.contains(&r.status),
            Self::Timeout(_) => true,
            Self::Network { code, .. } => code != &"ENOTFOUND",
            _ => false,
        }
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status(r) => write!(f, "Request failed with status code {}", r.status),
            Self::Timeout(m)
            | Self::Blocked(m)
            | Self::InvalidUrl(m)
            | Self::UnsupportedProtocol(m) => f.write_str(m),
            Self::Network { message, .. } => f.write_str(message),
            Self::Cancelled => f.write_str("Request cancelled"),
            Self::TooLarge(max) => write!(f, "Response exceeded maxResponseBytes ({max})"),
        }
    }
}

// ------------------------------------------------------------ net state --

pub struct Net {
    config: Mutex<NetworkConfig>,
    signature: Mutex<String>,
    proxy: Mutex<Option<String>>,
    client: Mutex<Option<(String, reqwest::Client)>>,
    http_gate: Mutex<Option<Arc<Semaphore>>>,
    scrapling_gate: Mutex<Option<Arc<Semaphore>>>,
    shutdown: CancellationToken,
    bucket: tokio::sync::Mutex<(f64, Instant)>,
    pub downloaded: AtomicU64,
    pub uploaded: AtomicU64,
    pub active_http: AtomicU64,
    pub waiting_http: AtomicU64,
    pub active_scrapling: AtomicU64,
    pub waiting_scrapling: AtomicU64,
    window: Mutex<[(u64, u64, u64); 5]>,
    started: Instant,
}

pub fn net() -> &'static Net {
    static NET: OnceLock<Net> = OnceLock::new();
    NET.get_or_init(|| Net {
        config: Mutex::new(NetworkConfig::default()),
        signature: Mutex::new(String::new()),
        proxy: Mutex::new(None),
        client: Mutex::new(None),
        http_gate: Mutex::new(None),
        scrapling_gate: Mutex::new(None),
        shutdown: CancellationToken::new(),
        bucket: tokio::sync::Mutex::new((0.0, Instant::now())),
        downloaded: AtomicU64::new(0),
        uploaded: AtomicU64::new(0),
        active_http: AtomicU64::new(0),
        waiting_http: AtomicU64::new(0),
        active_scrapling: AtomicU64::new(0),
        waiting_scrapling: AtomicU64::new(0),
        window: Mutex::new([(u64::MAX, 0, 0); 5]),
        started: Instant::now(),
    })
}

fn gate(limit: Option<u64>) -> Option<Arc<Semaphore>> {
    limit.map(|n| Arc::new(Semaphore::new(n as usize)))
}

impl Net {
    pub fn configure(&self, config: &NetworkConfig, proxy: Option<String>) {
        let signature = serde_json::to_string(config).unwrap_or_default();
        {
            let mut current = self.signature.lock().expect("lock");
            if *current != signature {
                *current = signature;
                *self.http_gate.lock().expect("lock") = gate(config.http_concurrency());
                *self.scrapling_gate.lock().expect("lock") = gate(config.scrapling_concurrency());
                *self.config.lock().expect("lock") = config.clone();
            }
        }
        let mut current_proxy = self.proxy.lock().expect("lock");
        if *current_proxy != proxy {
            match &proxy {
                Some(url) => crate::info!("HTTP", "Proxy enabled: {}", sanitize_url(url)),
                None if current_proxy.is_some() => crate::info!("HTTP", "Proxy disabled."),
                None => {}
            }
            *current_proxy = proxy;
        }
    }

    pub fn config(&self) -> NetworkConfig {
        self.config.lock().expect("lock").clone()
    }

    pub fn begin_shutdown(&self) {
        self.shutdown.cancel();
    }

    fn client(&self) -> Result<reqwest::Client, HttpError> {
        let config = self.config();
        let proxy = if config.public_only() {
            None
        } else {
            self.proxy.lock().expect("lock").clone()
        };
        let key = format!(
            "{proxy:?}|{}|{}|{}",
            config.public_only(),
            config.setup_timeout_ms,
            config.idle_timeout_ms
        );
        let mut cache = self.client.lock().expect("lock");
        if let Some((cached, client)) = cache.as_ref()
            && *cached == key
        {
            return Ok(client.clone());
        }
        let mut builder = reqwest::Client::builder()
            .user_agent(UA)
            .redirect(if config.public_only() {
                reqwest::redirect::Policy::none()
            } else {
                reqwest::redirect::Policy::limited(21)
            })
            .pool_idle_timeout(Duration::from_secs(30));
        if config.setup_timeout_ms > 0 {
            builder = builder.connect_timeout(Duration::from_millis(config.setup_timeout_ms));
        }
        if config.idle_timeout_ms > 0 {
            builder = builder.read_timeout(Duration::from_millis(config.idle_timeout_ms));
        }
        if config.public_only() {
            builder = builder.no_proxy().dns_resolver(Arc::new(PublicResolver));
        } else if let Some(url) = &proxy {
            let proxy = reqwest::Proxy::all(url).map_err(|e| HttpError::Network {
                code: "ERR_PROXY",
                message: e.to_string(),
            })?;
            builder = builder.proxy(proxy);
        } else {
            builder = builder.no_proxy();
        }
        let client = builder.build().map_err(|e| HttpError::Network {
            code: "ERR_CLIENT",
            message: e.to_string(),
        })?;
        *cache = Some((key, client.clone()));
        Ok(client)
    }

    fn record(&self, download: u64, upload: u64) {
        self.downloaded.fetch_add(download, Ordering::Relaxed);
        self.uploaded.fetch_add(upload, Ordering::Relaxed);
        let second = self.started.elapsed().as_secs();
        let mut window = self.window.lock().expect("lock");
        let slot = &mut window[(second % 5) as usize];
        if slot.0 != second {
            *slot = (second, 0, 0);
        }
        slot.1 += download;
        slot.2 += upload;
    }

    /// Bytes per second over the last five seconds (download, upload).
    pub fn rates(&self) -> (f64, f64) {
        let second = self.started.elapsed().as_secs();
        let window = self.window.lock().expect("lock");
        let seconds = self.started.elapsed().as_secs_f64().clamp(1.0, 5.0);
        let (down, up) = window
            .iter()
            .filter(|(s, _, _)| *s != u64::MAX && second.saturating_sub(*s) < 5)
            .fold((0, 0), |acc, (_, d, u)| (acc.0 + d, acc.1 + u));
        (down as f64 / seconds, up as f64 / seconds)
    }

    async fn shape_download(
        &self,
        bytes: usize,
        cancel: &CancellationToken,
    ) -> Result<(), HttpError> {
        let Some(rate) = self.config().download_bytes_per_second else {
            return Ok(());
        };
        let wait = {
            let mut bucket = self.bucket.lock().await;
            let now = Instant::now();
            let refill = now.duration_since(bucket.1).as_secs_f64() * rate;
            bucket.0 = (bucket.0 + refill).min(rate);
            bucket.1 = now;
            bucket.0 -= bytes as f64;
            if bucket.0 < 0.0 {
                Duration::from_secs_f64(-bucket.0 / rate)
            } else {
                Duration::ZERO
            }
        };
        if wait.is_zero() {
            return Ok(());
        }
        tokio::select! {
            () = tokio::time::sleep(wait) => Ok(()),
            () = cancel.cancelled() => Err(HttpError::Cancelled),
        }
    }

    pub async fn acquire(
        &'static self,
        scrapling: bool,
        cancel: &CancellationToken,
    ) -> Result<Permit, HttpError> {
        let (gate, active, waiting) = if scrapling {
            (
                self.scrapling_gate.lock().expect("lock").clone(),
                &self.active_scrapling,
                &self.waiting_scrapling,
            )
        } else {
            (
                self.http_gate.lock().expect("lock").clone(),
                &self.active_http,
                &self.waiting_http,
            )
        };
        let permit = match gate {
            None => None,
            Some(gate) => {
                waiting.fetch_add(1, Ordering::Relaxed);
                let result = tokio::select! {
                    permit = gate.acquire_owned() => permit.map_err(|_| HttpError::Cancelled),
                    () = cancel.cancelled() => Err(HttpError::Cancelled),
                    () = self.shutdown.cancelled() => Err(HttpError::Cancelled),
                };
                waiting.fetch_sub(1, Ordering::Relaxed);
                Some(result?)
            }
        };
        active.fetch_add(1, Ordering::Relaxed);
        Ok(Permit {
            _permit: permit,
            counter: active,
        })
    }
}

pub struct Permit {
    _permit: Option<tokio::sync::OwnedSemaphorePermit>,
    counter: &'static AtomicU64,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::Relaxed);
    }
}

// --------------------------------------------------------- public-only --

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            let private = a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168
                        || (b == 0 && c == 0)
                        || (b == 0 && c == 2)
                        || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113);
            !private && (1..=223).contains(&a)
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            (0x2000..0x4000).contains(&seg[0])
                && seg[0] != 0x2002
                && !(seg[0] == 0x2001 && (seg[1] == 0 || seg[1] == 0x0db8))
        }
    }
}

pub fn validate_public_url(url: &url::Url) -> Result<(), HttpError> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(HttpError::Blocked(
            "Outbound URL must use HTTP(S) without userinfo".into(),
        ));
    }
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let internal = host.is_empty()
        || host == "localhost"
        || [
            ".localhost",
            ".local",
            ".internal",
            ".home.arpa",
            ".invalid",
        ]
        .iter()
        .any(|s| host.ends_with(s))
        || host.parse::<IpAddr>().is_ok_and(|ip| !is_public_ip(ip));
    if internal {
        Err(HttpError::Blocked(
            "Outbound destination is not public".into(),
        ))
    } else {
        Ok(())
    }
}

struct PublicResolver;

impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if addrs.is_empty() || addrs.iter().any(|a| !is_public_ip(a.ip())) {
                return Err("DNS resolved to an internal, mixed or non-public address".into());
            }
            let iter: reqwest::dns::Addrs = Box::new(addrs.into_iter());
            Ok(iter)
        })
    }
}

// ------------------------------------------------------------- requests --

fn parse_url(raw: &str) -> Result<url::Url, HttpError> {
    let url =
        url::Url::parse(raw).map_err(|_| HttpError::InvalidUrl(format!("Invalid URL: {raw}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(HttpError::UnsupportedProtocol(format!(
            "Unsupported protocol {}:",
            url.scheme()
        )));
    }
    if net().config().public_only() {
        validate_public_url(&url)?;
    }
    Ok(url)
}

fn header_map(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            map.insert(name, value);
        }
    }
    map
}

fn classify(error: &reqwest::Error) -> HttpError {
    let message = sanitize_text(&error.to_string());
    let chain = {
        let mut text = String::new();
        let mut source: Option<&dyn std::error::Error> = Some(error);
        while let Some(e) = source {
            text.push_str(&e.to_string().to_ascii_lowercase());
            text.push(' ');
            source = e.source();
        }
        text
    };
    if error.is_timeout() || chain.contains("timed out") {
        HttpError::Timeout(format!("timeout exceeded: {message}"))
    } else if chain.contains("non-public") {
        HttpError::Blocked(message)
    } else if chain.contains("dns error") || chain.contains("failed to lookup") {
        HttpError::Network {
            code: "ENOTFOUND",
            message,
        }
    } else if chain.contains("connection refused") {
        HttpError::Network {
            code: "ECONNREFUSED",
            message,
        }
    } else if chain.contains("reset") {
        HttpError::Network {
            code: "ECONNRESET",
            message,
        }
    } else {
        HttpError::Network {
            code: "ERR_NETWORK",
            message,
        }
    }
}

pub struct Get<'a> {
    pub url: &'a str,
    pub headers: Vec<(String, String)>,
    pub cancel: &'a CancellationToken,
    pub timeout_ms: Option<u64>,
}

/// Diagnostics: one `http.timing` event per request with its phases.
fn record_timing(
    method: &str,
    url: &url::Url,
    started: Instant,
    permitted: Instant,
    headers_at: Option<Instant>,
    result: &Result<Response, HttpError>,
) {
    if !crate::diagnostics::enabled() {
        return;
    }
    let done = Instant::now();
    let response = match result {
        Ok(r) => Some(r),
        Err(e) => e.response(),
    };
    let header = |name: &str| response.and_then(|r| r.header(name)).unwrap_or("");
    let skew = response
        .and_then(|r| r.header("date"))
        .and_then(|d| chrono::DateTime::parse_from_rfc2822(d).ok())
        .map(|d| d.timestamp_millis() - chrono::Utc::now().timestamp_millis());
    let mut payload = serde_json::json!({
        "method": method,
        "host": url.host_str().unwrap_or(""),
        "url": url.as_str(),
        "status": response.map(|r| r.status),
        "error": result.as_ref().err().map(HttpError::code),
        "queueMs": permitted.duration_since(started).as_millis() as u64,
        "ttfbMs": headers_at.map(|h| h.duration_since(permitted).as_millis() as u64),
        "bodyMs": headers_at.map(|h| done.duration_since(h).as_millis() as u64),
        "totalMs": done.duration_since(started).as_millis() as u64,
        "bytes": response.map_or(0, |r| r.body.len()),
        "cacheControl": header("cache-control"),
        "age": header("age"),
        "cfCacheStatus": header("cf-cache-status"),
        "rateLimitRemaining": header("x-ratelimit-remaining"),
        "rateLimitResetAfter": header("x-ratelimit-reset-after"),
        "rateLimitBucket": header("x-ratelimit-bucket"),
        "serverClockSkewMs": skew,
    });
    if let Value::Object(map) = &mut payload {
        map.retain(|_, v| !v.is_null() && v.as_str() != Some(""));
    }
    crate::diagnostics::record("http.timing", crate::diag::sanitize_value(&payload, "", 0));
    // Second-resolution Date header: only large differences are meaningful.
    if let Some(skew) = skew
        && skew.abs() > 5_000
    {
        crate::diagnostics::record(
            "anomaly",
            serde_json::json!({ "kind": "clock.skew", "host": url.host_str().unwrap_or(""), "serverClockSkewMs": skew }),
        );
    }
}

async fn once(get: &Get<'_>, url: &url::Url) -> Result<Response, HttpError> {
    let started = Instant::now();
    let mut headers_at = None;
    let result = once_inner(get, url, &mut headers_at).await;
    let permitted = headers_at.map_or(started, |(p, _)| p);
    record_timing(
        "GET",
        url,
        started,
        permitted,
        headers_at.map(|(_, h)| h),
        &result,
    );
    result
}

async fn once_inner(
    get: &Get<'_>,
    url: &url::Url,
    phases: &mut Option<(Instant, Instant)>,
) -> Result<Response, HttpError> {
    let net = net();
    let config = net.config();
    let _permit = net.acquire(false, get.cancel).await?;
    let permitted = Instant::now();
    let client = net.client()?;
    let mut request = client.get(url.clone()).headers(header_map(&get.headers));
    if let Some(timeout) = get.timeout_ms {
        request = request.timeout(Duration::from_millis(timeout));
    }
    let setup = Duration::from_millis(if config.setup_timeout_ms == 0 {
        86_400_000
    } else {
        config.setup_timeout_ms
    });
    let send = async {
        match tokio::time::timeout(setup, request.send()).await {
            Ok(result) => result.map_err(|e| classify(&e)),
            Err(_) => Err(HttpError::Timeout(format!(
                "setup timeout of {}ms exceeded",
                config.setup_timeout_ms
            ))),
        }
    };
    let response = tokio::select! {
        r = send => r?,
        () = get.cancel.cancelled() => return Err(HttpError::Cancelled),
        () = net.shutdown.cancelled() => return Err(HttpError::Cancelled),
    };
    *phases = Some((permitted, Instant::now()));
    read_body(response, &config, get.cancel).await
}

async fn read_body(
    response: reqwest::Response,
    config: &NetworkConfig,
    cancel: &CancellationToken,
) -> Result<Response, HttpError> {
    let net = net();
    let status = response.status().as_u16();
    let mut headers = Map::new();
    for (name, value) in response.headers() {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        match headers.get_mut(name.as_str()) {
            Some(Value::String(existing)) => {
                existing.push_str(", ");
                existing.push_str(&value);
            }
            _ => {
                headers.insert(name.as_str().to_string(), Value::String(value));
            }
        }
    }
    let charset = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|ct| {
            ct.split(';').find_map(|p| {
                p.trim()
                    .strip_prefix("charset=")
                    .map(|c| c.trim_matches('"').to_ascii_lowercase())
            })
        });
    let limit = config.max_response_bytes;
    let mut body: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            chunk = stream.next() => chunk,
            () = cancel.cancelled() => return Err(HttpError::Cancelled),
            () = net.shutdown.cancelled() => return Err(HttpError::Cancelled),
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|e| classify(&e))?;
        net.record(chunk.len() as u64, 0);
        net.shape_download(chunk.len(), cancel).await?;
        body.extend_from_slice(&chunk);
        if let Some(max) = limit
            && body.len() as u64 > max
        {
            return Err(HttpError::TooLarge(max));
        }
    }
    let text = decode_body(&body, charset.as_deref());
    let response = Response {
        status,
        headers,
        body: text,
    };
    if status == 304 || (200..300).contains(&status) {
        Ok(response)
    } else {
        Err(HttpError::Status(response))
    }
}

/// Charset declared inside the document: `<?xml … encoding="…"?>` or an
/// HTML `<meta charset>` / `http-equiv` tag within the first 2 KiB.
fn declared_charset(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    static DECL: std::sync::OnceLock<regex::bytes::Regex> = std::sync::OnceLock::new();
    let re = DECL.get_or_init(|| {
        regex::bytes::Regex::new(
            r#"(?i)(?:<\?xml[^>]*?\sencoding\s*=\s*["']|<meta[^>]*?charset\s*=\s*["']?)([A-Za-z0-9_.:-]{2,40})"#,
        )
        .expect("charset regex")
    });
    let head = &bytes[..bytes.len().min(2048)];
    let label = re.captures(head)?.get(1)?.as_bytes();
    encoding_rs::Encoding::for_label(label)
}

/// Decode a response body: a BOM wins; valid UTF-8 stays UTF-8 (servers
/// and documents often mislabel UTF-8 as ISO-8859-x); otherwise the
/// `Content-Type` charset, then the document's own declaration, then lossy
/// UTF-8.
fn decode_body(bytes: &[u8], charset: Option<&str>) -> String {
    use encoding_rs::{Encoding, UTF_8};
    if let Some((encoding, bom)) = Encoding::for_bom(bytes) {
        return encoding
            .decode_without_bom_handling(&bytes[bom..])
            .0
            .into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let usable = |e: &&'static Encoding| *e != UTF_8 && e.is_ascii_compatible();
    let encoding = charset
        .and_then(|c| Encoding::for_label(c.trim().as_bytes()))
        .filter(usable)
        .or_else(|| declared_charset(bytes).filter(usable))
        .unwrap_or(UTF_8);
    encoding.decode_without_bom_handling(bytes).0.into_owned()
}

pub fn retry_after_ms(headers: &Map<String, Value>) -> Option<u64> {
    let value = headers.get("retry-after")?.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<f64>() {
        return (seconds >= 0.0).then(|| (seconds * 1000.0).ceil() as u64);
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some((date.timestamp_millis() - chrono::Utc::now().timestamp_millis()).max(0) as u64)
}

async fn wait(ms: u64, cancel: &CancellationToken) -> Result<(), HttpError> {
    tokio::select! {
        () = tokio::time::sleep(Duration::from_millis(ms)) => Ok(()),
        () = cancel.cancelled() => Err(HttpError::Cancelled),
        () = net().shutdown.cancelled() => Err(HttpError::Cancelled),
    }
}

fn jitter() -> u64 {
    if net().config().network_friendly_mode {
        50 + rand::random_range(0..=100)
    } else {
        0
    }
}

/// GET with up to three attempts for transient failures (`getWithFallback`).
pub async fn get(get: Get<'_>) -> Result<Response, HttpError> {
    let url = parse_url(get.url)?;
    let max_attempts = 3;
    let deadline = net().config().request_deadline_ms;
    let run = async {
        let mut attempt = 0u32;
        loop {
            let started = Instant::now();
            expert(
                "http.request.begin",
                serde_json::json!({ "method": "GET", "url": get.url, "attempt": attempt + 1, "maxAttempts": max_attempts }),
            );
            match once(&get, &url).await {
                Ok(response) => {
                    expert(
                        "http.request.complete",
                        serde_json::json!({
                            "method": "GET", "url": get.url, "attempt": attempt + 1, "status": response.status,
                            "contentType": response.header("content-type").unwrap_or(""), "bodyBytes": response.body.len(),
                            "durationMs": started.elapsed().as_millis() as u64,
                        }),
                    );
                    return Ok(response);
                }
                Err(error) if error.retryable() && attempt + 1 < max_attempts => {
                    let status = error.status();
                    let delay = match error
                        .response()
                        .filter(|r| matches!(r.status, 429 | 503))
                        .and_then(|r| retry_after_ms(&r.headers))
                    {
                        Some(ms) => ms + jitter(),
                        None => {
                            let exponential = (500u64 << attempt).min(8_000) as f64;
                            (exponential * (0.8 + rand::random::<f64>() * 0.4)).round() as u64
                                + jitter()
                        }
                    };
                    crate::warn!(
                        "HTTP",
                        "Retrying {} in {delay}ms (attempt {}/{max_attempts}, status={}).",
                        sanitize_url(get.url),
                        attempt + 1,
                        status.map_or_else(|| "network".to_string(), |s| s.to_string())
                    );
                    wait(delay, get.cancel).await?;
                    attempt += 1;
                }
                Err(error) => {
                    if !matches!(error, HttpError::Cancelled) {
                        expert(
                            "http.request.failed",
                            serde_json::json!({ "method": "GET", "url": get.url, "attempt": attempt + 1, "status": error.status(), "durationMs": started.elapsed().as_millis() as u64, "error": { "code": error.code(), "message": error.to_string() } }),
                        );
                        crate::warn!(
                            "HTTP",
                            "Request failed for {}: {}",
                            sanitize_url(get.url),
                            error
                        );
                    }
                    return Err(error);
                }
            }
        }
    };
    match deadline {
        Some(ms) => tokio::time::timeout(Duration::from_millis(ms), run)
            .await
            .unwrap_or_else(|_| {
                Err(HttpError::Timeout(format!(
                    "deadline timeout of {ms}ms exceeded"
                )))
            }),
        None => run.await,
    }
}

/// POST JSON without automatic retries (a possibly accepted delivery must
/// never be replayed implicitly).
pub async fn post_json(
    url: &str,
    payload: &Value,
    timeout_ms: Option<u64>,
    cancel: &CancellationToken,
) -> Result<Response, HttpError> {
    let parsed = parse_url(url)?;
    let started = Instant::now();
    let mut phases = None;
    let result = post_inner(&parsed, payload, timeout_ms, cancel, &mut phases).await;
    let permitted = phases.map_or(started, |(p, _)| p);
    record_timing(
        "POST",
        &parsed,
        started,
        permitted,
        phases.map(|(_, h)| h),
        &result,
    );
    result
}

async fn post_inner(
    parsed: &url::Url,
    payload: &Value,
    timeout_ms: Option<u64>,
    cancel: &CancellationToken,
    phases: &mut Option<(Instant, Instant)>,
) -> Result<Response, HttpError> {
    let net = net();
    let config = net.config();
    let _permit = net.acquire(false, cancel).await?;
    let permitted = Instant::now();
    let client = net.client()?;
    let body = serde_json::to_vec(payload).unwrap_or_default();
    net.record(0, body.len() as u64);
    let mut request = client
        .post(parsed.clone())
        .header("content-type", "application/json")
        .body(body);
    if let Some(ms) = timeout_ms.filter(|ms| *ms > 0) {
        request = request.timeout(Duration::from_millis(ms));
    }
    let response = tokio::select! {
        r = request.send() => r.map_err(|e| classify(&e))?,
        () = cancel.cancelled() => return Err(HttpError::Cancelled),
        () = net.shutdown.cancelled() => return Err(HttpError::Cancelled),
    };
    *phases = Some((permitted, Instant::now()));
    read_body(response, &config, cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_ip_policy() {
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("10.1.2.3".parse().unwrap()));
        assert!(!is_public_ip("192.168.1.1".parse().unwrap()));
        assert!(!is_public_ip("::1".parse().unwrap()));
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700::1111".parse().unwrap()));
        assert!(validate_public_url(&url::Url::parse("http://localhost/x").unwrap()).is_err());
        assert!(validate_public_url(&url::Url::parse("https://example.com/x").unwrap()).is_ok());
    }

    #[test]
    fn retry_after_parsing() {
        let mut headers = Map::new();
        headers.insert("retry-after".into(), Value::String("2".into()));
        assert_eq!(retry_after_ms(&headers), Some(2000));
    }

    #[test]
    fn body_charsets() {
        // "Zażółć" in ISO-8859-2.
        let latin2 = b"<?xml version=\"1.0\" encoding=\"ISO-8859-2\"?><t>Za\xbf\xf3\xb3\xe6</t>";
        assert!(decode_body(latin2, None).contains("Zażółć"));
        assert!(decode_body(latin2, Some("iso-8859-2")).contains("Zażółć"));
        // Server claims UTF-8, bytes are not UTF-8: the declaration wins.
        assert!(decode_body(latin2, Some("utf-8")).contains("Zażółć"));
        // "śląski" in windows-1250 with an HTML meta declaration.
        let cp1250 = b"<html><head><meta charset=\"windows-1250\"></head>\x9cl\xb9ski</html>";
        assert!(decode_body(cp1250, None).contains("śląski"));
        // Valid UTF-8 mislabelled as ISO-8859-2 stays UTF-8.
        let utf8 = "<?xml version=\"1.0\" encoding=\"ISO-8859-2\"?><t>Zażółć</t>";
        assert!(decode_body(utf8.as_bytes(), Some("iso-8859-2")).contains("Zażółć"));
        // BOM, Latin-1 header, invalid bytes without any declaration.
        assert_eq!(decode_body(b"\xEF\xBB\xBFabc", Some("iso-8859-2")), "abc");
        assert_eq!(decode_body(b"caf\xe9", Some("latin1")), "café");
        assert_eq!(decode_body(b"caf\xe9", None), "caf\u{FFFD}");
    }
}
