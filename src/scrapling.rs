//! Optional Scrapling (Python) fallback for anti-bot protected feeds. All
//! requests go through one persistent `browser_worker.py` child speaking
//! line-delimited JSON; it keeps browser sessions warm between fetches.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use scraper::{Html, Selector};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::js::{self, get, truthy};
use crate::text::now_iso;

const WORKER_SOURCE: &str = include_str!("../scrapling/browser_worker.py");
const MODES: [&str; 6] = ["get", "post", "put", "delete", "fetch", "stealthy-fetch"];

// -------------------------------------------------------------- detection --

#[derive(Clone, Debug)]
pub struct Runtime {
    pub python: PathBuf,
    pub worker: PathBuf,
}

static RUNTIME: OnceLock<Option<Runtime>> = OnceLock::new();

pub fn runtime_dir(base: &Path) -> PathBuf {
    base.join("scrapling")
}

/// Probe once per process: `<data>/scrapling/.venv/bin/python`, then python3.
pub fn detect(base: &Path) -> Option<&'static Runtime> {
    RUNTIME
        .get_or_init(|| {
            let dir = runtime_dir(base);
            let candidates = [dir.join(".venv/bin/python"), PathBuf::from("python3"), PathBuf::from("python")];
            let probe = "import sys\nfrom importlib.metadata import version\nfrom scrapling.fetchers import Fetcher, StealthySession\nassert sys.version_info >= (3, 10)\nprint(version('scrapling'))";
            for python in candidates {
                if python.is_absolute() && !python.exists() {
                    continue;
                }
                let output = std::process::Command::new(&python).args(["-c", probe]).stdin(Stdio::null()).stderr(Stdio::null()).output();
                let Ok(output) = output else { continue };
                if !output.status.success() {
                    continue;
                }
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let worker = dir.join("browser_worker.py");
                let current = std::fs::read_to_string(&worker).ok();
                if current.as_deref() != Some(WORKER_SOURCE) {
                    let _ = std::fs::create_dir_all(&dir);
                    if std::fs::write(&worker, WORKER_SOURCE).is_err() {
                        continue;
                    }
                }
                crate::info!("Scrapling", "Runtime available (scrapling {version})");
                return Some(Runtime { python, worker });
            }
            None
        })
        .as_ref()
}

// ----------------------------------------------------------------- config --

pub struct ScraplingConfig<'a> {
    pub raw: &'a Value,
}

#[derive(Clone, Debug)]
pub struct AntiBot {
    pub enabled: bool,
    pub log_decisions: bool,
    pub prefer_stealth: bool,
    pub mode_order: Vec<String>,
    pub status_codes: Vec<f64>,
    pub header_keys: Vec<String>,
    pub body_signatures: Vec<String>,
    pub title_signatures: Vec<String>,
    pub max_attempts: usize,
    pub min_body_bytes: usize,
    pub min_confidence: f64,
    pub cloudflare_signal: bool,
}

fn normalize_mode(value: &Value) -> Option<String> {
    let mode = js::to_string_or_empty(value)
        .trim()
        .to_lowercase()
        .replace('_', "-");
    let mode = if mode == "stealthy" {
        "stealthy-fetch".to_string()
    } else {
        mode
    };
    MODES.contains(&mode.as_str()).then_some(mode)
}

fn list(value: &Value) -> Vec<&Value> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

fn strings(value: &Value) -> Vec<String> {
    list(value)
        .into_iter()
        .map(|v| js::to_string_or_empty(v).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn numbers(value: &Value) -> Vec<f64> {
    list(value)
        .into_iter()
        .map(js::to_number)
        .filter(|n| n.is_finite())
        .collect()
}

fn mode_order(value: &Value, fallback: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for mode in list(value).into_iter().filter_map(normalize_mode) {
        if !out.contains(&mode) {
            out.push(mode);
        }
    }
    if out.is_empty() {
        fallback.to_vec()
    } else {
        out
    }
}

impl<'a> ScraplingConfig<'a> {
    pub fn new(root: &'a Value) -> Self {
        Self {
            raw: get(root, "Scrapling"),
        }
    }
    fn flag(&self, key: &str) -> bool {
        get(self.raw, key) != &Value::Bool(false)
    }
    pub fn enabled(&self) -> bool {
        self.flag("Enabled")
    }
    pub fn auto_fallback(&self) -> bool {
        self.flag("AutoFallback")
    }
    pub fn force_global(&self) -> bool {
        get(self.raw, "ForceGlobal") == &Value::Bool(true)
    }
    pub fn fallback_status_codes(&self) -> Vec<f64> {
        match get(self.raw, "FallbackStatusCodes") {
            v @ Value::Array(_) => numbers(v),
            _ => vec![403.0, 429.0, 503.0],
        }
    }
    pub fn default_options(&self) -> Map<String, Value> {
        get(self.raw, "DefaultOptions")
            .as_object()
            .cloned()
            .unwrap_or_default()
    }
    pub fn url_config(&self, url: &str) -> Map<String, Value> {
        get(get(self.raw, "PerUrlConfig"), url)
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    fn global_antibot(&self) -> AntiBot {
        let base = get(self.raw, "AntiBot");
        let defaults = ["get", "fetch", "stealthy-fetch"].map(String::from);
        let status = numbers(get(base, "StatusCodes"));
        let attempts = js::to_number(get(base, "MaxAttempts"));
        let min_body = js::to_number(get(base, "MinBodyBytes"));
        let confidence = js::to_number(get(base, "MinConfidence"));
        AntiBot {
            enabled: get(base, "Enabled") != &Value::Bool(false),
            log_decisions: get(base, "LogDecisions") == &Value::Bool(true),
            prefer_stealth: get(base, "PreferStealthOnSignals") != &Value::Bool(false),
            mode_order: mode_order(get(base, "ModeOrder"), &defaults),
            status_codes: if status.is_empty() {
                vec![403.0, 429.0, 503.0]
            } else {
                status
            },
            header_keys: strings(get(base, "HeaderKeys")),
            body_signatures: strings(get(base, "BodySignatures")),
            title_signatures: strings(get(base, "TitleSignatures")),
            max_attempts: if attempts.is_finite() && attempts > 0.0 {
                attempts.floor() as usize
            } else {
                3
            },
            min_body_bytes: if min_body.is_finite() && min_body > 0.0 {
                min_body.floor() as usize
            } else {
                0
            },
            min_confidence: if get(base, "MinConfidence").is_null() || !confidence.is_finite() {
                40.0
            } else {
                confidence.floor().clamp(0.0, 100.0)
            },
            cloudflare_signal: get(base, "TreatCloudflareAsSignal") != &Value::Bool(false),
        }
    }

    pub fn antibot(&self, url: &str) -> AntiBot {
        let global = self.global_antibot();
        let per = self.url_config(url);
        let per_anti = per
            .get("antiBot")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or(Value::Null);
        let pick = |camel: &str, pascal: &str| -> Option<&Value> {
            per_anti.get(camel).or_else(|| per_anti.get(pascal))
        };
        let mut result = global.clone();
        if let Some(v) = pick("modeOrder", "ModeOrder") {
            result.mode_order = mode_order(v, &global.mode_order);
        }
        if let Some(v) = pick("statusCodes", "StatusCodes") {
            let codes = numbers(v);
            if !codes.is_empty() {
                result.status_codes = codes;
            }
        }
        if let Some(v) = pick("headerKeys", "HeaderKeys") {
            result.header_keys = strings(v);
        }
        if let Some(v) = pick("bodySignatures", "BodySignatures") {
            result.body_signatures = strings(v);
        }
        if let Some(v) = pick("titleSignatures", "TitleSignatures") {
            result.title_signatures = strings(v);
        }
        if let Some(n) = pick("maxAttempts", "MaxAttempts")
            .map(js::to_number)
            .filter(|n| n.is_finite() && *n > 0.0)
        {
            result.max_attempts = n.floor() as usize;
        }
        if let Some(n) = pick("minBodyBytes", "MinBodyBytes")
            .map(js::to_number)
            .filter(|n| n.is_finite() && *n > 0.0)
        {
            result.min_body_bytes = n.floor() as usize;
        }
        if let Some(n) = pick("minConfidence", "MinConfidence")
            .map(js::to_number)
            .filter(|n| n.is_finite())
        {
            result.min_confidence = n.floor().clamp(0.0, 100.0);
        }
        if let Some(v) = pick("treatCloudflareAsSignal", "TreatCloudflareAsSignal") {
            result.cloudflare_signal = v != &Value::Bool(false);
        }
        if let Some(v) = pick("enabled", "Enabled") {
            result.enabled = v != &Value::Bool(false);
        }
        if let Some(v) = pick("logDecisions", "LogDecisions") {
            result.log_decisions = v == &Value::Bool(true);
        }
        if let Some(v) = pick("preferStealthOnSignals", "PreferStealthOnSignals") {
            result.prefer_stealth = v != &Value::Bool(false);
        }
        result
    }

    pub fn mode_sequence(&self, url: &str) -> Vec<String> {
        let anti = self.antibot(url);
        let defaults = Value::Object(self.default_options());
        let per = Value::Object(self.url_config(url));
        let mut resolved: Vec<String> = Vec::new();
        let mut push = |mode: Option<String>| {
            if let Some(mode) = mode
                && !resolved.contains(&mode)
            {
                resolved.push(mode);
            }
        };
        push(normalize_mode(js::or(&[
            get(&per, "extractMode"),
            get(&per, "mode"),
        ])));
        for mode in anti.mode_order {
            push(Some(mode));
        }
        push(normalize_mode(js::or(&[
            get(&defaults, "extractMode"),
            get(&defaults, "mode"),
        ])));
        if resolved.is_empty() {
            resolved.push("get".into());
        }
        resolved
    }

    /// Per-URL `enabled` overrides; `ForceGlobal` forces every request.
    pub fn should_use(&self, url: &str, status: Option<u16>) -> bool {
        if !self.enabled() {
            return false;
        }
        let per = self.url_config(url);
        match per.get("enabled") {
            Some(Value::Bool(false)) => return false,
            Some(Value::Bool(true)) => return true,
            _ => {}
        }
        if self.force_global() {
            return true;
        }
        (self.auto_fallback() || self.url_fallback(url))
            && status.is_some_and(|s| self.fallback_status_codes().contains(&f64::from(s)))
    }

    /// `PerUrlConfig.<url>.fallback: true`: plain HTTP first, the browser
    /// only when that is blocked (unlike `enabled: true`, which always uses
    /// the browser).
    pub fn url_fallback(&self, url: &str) -> bool {
        self.url_config(url).get("fallback") == Some(&Value::Bool(true))
    }
}

// ---------------------------------------------------------- anti-bot scan --

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Signals {
    pub blocked: bool,
    pub reasons: Vec<String>,
    pub score: u32,
    pub cloudflare: bool,
    pub status_blocked: bool,
    pub header_blocked: bool,
    pub body_blocked: bool,
    pub title_blocked: bool,
}

const HEADER_KEYS: [&str; 7] = [
    "cf-mitigated",
    "x-datadome",
    "x-akamai-transformed",
    "akamai-grn",
    "x-sucuri-id",
    "x-distil-captcha",
    "x-bot-score*",
];
const BODY_SIGNATURES: [&str; 15] = [
    "just a moment",
    "checking your browser",
    "attention required",
    "error 1020",
    "cf-chl",
    "turnstile",
    "datadome",
    "akamai bot manager",
    "captcha",
    "verify you are human",
    "are you human",
    "access denied",
    "request blocked",
    "challenge page",
    "bot manager",
];
const TITLE_SIGNATURES: [&str; 12] = [
    "just a moment",
    "attention required",
    "access denied",
    "error 1020",
    "404 |",
    "| 404",
    "not found",
    "verify you are human",
    "are you human",
    "challenge",
    "captcha",
    "datadome",
];

fn page_title(body: &str) -> String {
    static TITLE: OnceLock<regex::Regex> = OnceLock::new();
    TITLE
        .get_or_init(|| regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("regex"))
        .captures(body)
        .map(|c| js::trim(&js::collapse_ws(&c[1])).to_string())
        .unwrap_or_default()
}

pub fn analyze(
    status: Option<u16>,
    headers: &Map<String, Value>,
    body: &str,
    anti: &AntiBot,
) -> Signals {
    let lower_headers: Vec<String> = headers.keys().map(|k| k.to_lowercase()).collect();
    let mut matches = Vec::new();
    for key in HEADER_KEYS
        .iter()
        .map(|k| k.to_string())
        .chain(anti.header_keys.iter().map(|k| k.to_lowercase()))
    {
        let hit = match key.strip_suffix('*') {
            Some(prefix) => lower_headers.iter().any(|h| h.starts_with(prefix)),
            None => lower_headers.contains(&key),
        };
        if hit {
            matches.push(key);
        }
    }
    let header_value = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| js::to_string(v))
    };
    let cloudflare = anti.cloudflare_signal
        && (header_value("cf-ray").is_some()
            || header_value("cf-cache-status").is_some()
            || header_value("server").is_some_and(|s| s.to_lowercase().contains("cloudflare")));
    let text = body.to_lowercase();
    let body_blocked = !text.is_empty()
        && BODY_SIGNATURES
            .iter()
            .map(|s| s.to_string())
            .chain(anti.body_signatures.iter().map(|s| s.to_lowercase()))
            .any(|s| text.contains(&s));
    let title = page_title(body).to_lowercase();
    let title_blocked = !title.is_empty()
        && TITLE_SIGNATURES
            .iter()
            .map(|s| s.to_string())
            .chain(anti.title_signatures.iter().map(|s| s.to_lowercase()))
            .any(|s| title.contains(&s));
    let status_blocked = status.is_some_and(|s| anti.status_codes.contains(&f64::from(s)));
    let header_blocked = !matches.is_empty();
    let bytes = body.len();
    let too_small = anti.min_body_bytes > 0 && bytes > 0 && bytes < anti.min_body_bytes;
    let strong = status_blocked || header_blocked || body_blocked || title_blocked;
    let small_suspicious = too_small && (strong || cloudflare);
    let mut reasons = Vec::new();
    if status_blocked {
        reasons.push(format!("status:{}", status.unwrap_or_default()));
    }
    if cloudflare {
        reasons.push("header:cloudflare".into());
    }
    if header_blocked {
        reasons.push(format!("header:antibot:{}", matches.join("|")));
    }
    if body_blocked {
        reasons.push("body:challenge".into());
    }
    if title_blocked {
        reasons.push("title:challenge".into());
    }
    if too_small {
        reasons.push(format!("body:small:{bytes}"));
    }
    let mut score = 0u32;
    for (hit, weight) in [
        (status_blocked, 60),
        (header_blocked, 45),
        (body_blocked, 45),
        (title_blocked, 35),
        (too_small, 20),
        (cloudflare, 10),
        (small_suspicious, 20),
    ] {
        if hit {
            score += weight;
        }
    }
    let score = score.min(100);
    let confidence = f64::from(score.saturating_sub(if too_small { 20 } else { 0 }));
    let blocked =
        strong || small_suspicious || (confidence > 0.0 && confidence >= anti.min_confidence);
    Signals {
        blocked,
        reasons,
        score,
        cloudflare,
        status_blocked,
        header_blocked,
        body_blocked,
        title_blocked,
    }
}

// ----------------------------------------------------------------- worker --

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

static WORKER: Mutex<Option<Worker>> = Mutex::const_new(None);

#[derive(Clone, Debug)]
pub struct Fetched {
    pub html: String,
    pub status: Option<u16>,
    pub headers: Map<String, Value>,
}

async fn spawn(runtime: &Runtime) -> std::io::Result<Worker> {
    let mut child = Command::new(&runtime.python)
        .arg(&runtime.worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("no stdin"))?;
    let stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("no stdout"))?,
    );
    Ok(Worker {
        child,
        stdin,
        stdout,
        next_id: 1,
    })
}

fn kill_group(child: &Child) {
    if let Some(pid) = child.id() {
        // The worker leads its own process group; browsers live inside it.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

pub async fn fetch(
    runtime: &Runtime,
    url: &str,
    mode: &str,
    options: Map<String, Value>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Fetched, String> {
    let mut guard = tokio::select! {
        guard = WORKER.lock() => guard,
        () = cancel.cancelled() => return Err("Scrapling request cancelled".into()),
    };
    if guard.is_none() {
        *guard = Some(
            spawn(runtime)
                .await
                .map_err(|e| format!("Cannot start Scrapling worker: {e}"))?,
        );
    }
    let worker = guard.as_mut().expect("worker");
    let id = worker.next_id;
    worker.next_id += 1;
    let request = json!({ "id": id, "url": url, "mode": mode, "options": options });
    let exchange = async {
        worker
            .stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        worker.stdin.flush().await.map_err(|e| e.to_string())?;
        loop {
            let mut line = String::new();
            if worker
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|e| e.to_string())?
                == 0
            {
                return Err("Scrapling browser worker exited".to_string());
            }
            let Ok(response) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if response["id"] != json!(id) {
                continue;
            }
            if let Some(error) = response.get("error").filter(|e| !e.is_null()) {
                return Err(crate::diag::sanitize_text(&js::to_string(error)));
            }
            return Ok(Fetched {
                html: js::to_string_or_empty(&response["html"]),
                status: response["status"].as_u64().map(|s| s as u16),
                headers: response["headers"].as_object().cloned().unwrap_or_default(),
            });
        }
    };
    let outcome = tokio::select! {
        result = tokio::time::timeout(timeout, exchange) => result.unwrap_or_else(|_| Err(format!("Scrapling browser request timed out after {}ms", timeout.as_millis()))),
        () = cancel.cancelled() => Err("Scrapling request cancelled".into()),
    };
    if outcome.is_err() {
        // Desynchronized protocol or a hung browser: discard the worker.
        if let Some(worker) = guard.take() {
            kill_group(&worker.child);
        }
    }
    outcome
}

pub async fn close() {
    let Some(mut worker) = WORKER.lock().await.take() else {
        return;
    };
    let _ = worker
        .stdin
        .write_all(b"{\"id\":0,\"action\":\"shutdown\"}\n")
        .await;
    let _ = worker.stdin.flush().await;
    if tokio::time::timeout(Duration::from_secs(5), worker.child.wait())
        .await
        .is_err()
    {
        kill_group(&worker.child);
        let _ = worker.child.wait().await;
    }
}

// ------------------------------------------------------- HTML → entries --

pub fn detect_format(body: &str) -> &'static str {
    let s = body.trim().to_lowercase();
    if s.is_empty() {
        "unknown"
    } else if s.starts_with('{') || s.starts_with('[') {
        "json"
    } else if s.contains("<rss") || s.contains("<item") {
        "rss"
    } else if s.contains("<feed") || s.contains("<entry") {
        "atom"
    } else if s.contains("<html") || s.contains("<!doctype html") {
        "html"
    } else {
        "unknown"
    }
}

pub fn html_to_items(html: &str, options: &Value) -> Vec<Value> {
    if crate::parsers::is_blocked_page(html, 200, &Map::new()) {
        return Vec::new();
    }
    let doc = Html::parse_document(html);
    let option = |key: &str, fallback: &'static str| {
        js::trimmed_str(get(options, key)).map_or_else(|| fallback.to_string(), str::to_string)
    };
    let selector = |text: String| Selector::parse(&text).ok();
    let (
        Some(item_sel),
        Some(title_sel),
        Some(link_sel),
        Some(date_sel),
        Some(author_sel),
        Some(img_sel),
    ) = (
        selector(option("itemSelector", "article, .post, .entry, li")),
        selector(option("titleSelector", "h1, h2, h3, .title, .entry-title")),
        selector(option("linkSelector", "a[href]")),
        selector(option(
            "dateSelector",
            "time[datetime], time, .date, .published",
        )),
        selector(option("authorSelector", ".author, [rel='author']")),
        selector("img".into()),
    )
    else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for node in doc.select(&item_sel) {
        let title = node
            .select(&title_sel)
            .next()
            .map(|e| js::trim(&e.text().collect::<String>()).to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "No title".into());
        let link = node
            .select(&link_sel)
            .next()
            .and_then(|e| e.value().attr("href"))
            .map(str::to_string);
        let content = js::prefix16(
            js::trim(&js::collapse_ws(&node.text().collect::<String>())),
            500,
        )
        .to_string();
        let date = node
            .select(&date_sel)
            .next()
            .and_then(|e| e.value().attr("datetime"))
            .map_or_else(now_iso, str::to_string);
        let author = node
            .select(&author_sel)
            .next()
            .map(|e| js::trim(&e.text().collect::<String>()).to_string())
            .filter(|a| !a.is_empty());
        let image = node
            .select(&img_sel)
            .next()
            .and_then(|e| e.value().attr("src"))
            .map(str::to_string);
        let guid = link
            .clone()
            .unwrap_or_else(|| format!("{title}-{}", items.len()));
        items.push(json!({ "title": title, "link": link, "contentSnippet": content, "isoDate": date, "enclosure": image, "author": author, "guid": guid, "categories": [] }));
    }
    if !items.is_empty() {
        return items;
    }
    let meta = |sel: &str| {
        Selector::parse(sel).ok().and_then(|s| {
            doc.select(&s)
                .next()
                .and_then(|e| e.value().attr("content").map(str::to_string))
        })
    };
    let page_title = Selector::parse("title")
        .ok()
        .and_then(|s| {
            doc.select(&s)
                .next()
                .map(|e| js::trim(&e.text().collect::<String>()).to_string())
        })
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "No title".into());
    let og_url = meta("meta[property='og:url']");
    let description = meta("meta[name='description']").unwrap_or_default();
    vec![json!({
        "title": page_title, "link": og_url, "contentSnippet": js::prefix16(&description, 500), "isoDate": now_iso(),
        "enclosure": meta("meta[property='og:image']"), "author": null, "guid": og_url.clone().unwrap_or_else(|| page_title.clone()), "categories": ["html-fallback"],
    })]
}

/// Merge default, per-URL and request options; browser modes get the
/// resource-saving default (`disableResources`) unless explicitly set.
pub fn request_options(
    cfg: &ScraplingConfig<'_>,
    url: &str,
    mode: &str,
    network_saving: bool,
) -> Map<String, Value> {
    let mut merged = cfg.default_options();
    merged.extend(cfg.url_config(url));
    for (camel, snake) in [
        ("disableResources", "disable_resources"),
        ("blockAds", "block_ads"),
        ("blockedDomains", "blocked_domains"),
    ] {
        if !merged.contains_key(camel)
            && let Some(value) = merged.remove(snake)
        {
            merged.insert(camel.into(), value);
        }
    }
    if mode == "stealthy-fetch"
        && merged.get("solveCloudflare").is_none_or(Value::is_null)
        && merged.get("solveCaptcha").is_none_or(Value::is_null)
    {
        merged.insert("solveCloudflare".into(), Value::Bool(true));
    }
    if mode == "fetch" || mode == "stealthy-fetch" {
        let saving = merged
            .remove("scraplingResourceSaving")
            .and_then(|v| v.as_bool())
            .unwrap_or(network_saving);
        // The Turnstile widget cannot load with resources blocked, so a
        // Cloudflare solve keeps them unless `disableResources` is explicit.
        let solving = truthy(merged.get("solveCloudflare").unwrap_or(&Value::Null));
        if merged.get("disableResources").is_none_or(Value::is_null) {
            merged.insert("disableResources".into(), Value::Bool(saving && !solving));
        }
    }
    if truthy(merged.get("solveCloudflare").unwrap_or(&Value::Null)) {
        let timeout_ms = merged
            .get("timeoutMs")
            .map(js::to_number)
            .unwrap_or(f64::NAN);
        if timeout_ms.is_nan() || timeout_ms < 60_000.0 {
            merged.insert("timeoutMs".into(), json!(60_000));
        }
    }
    for key in [
        "htmlParseOptions",
        "antiBot",
        "enabled",
        "runtimeMode",
        "extractMode",
        "mode",
        "fetchMode",
        "transport",
    ] {
        merged.remove(key);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anti() -> AntiBot {
        ScraplingConfig::new(&json!({})).antibot("https://x")
    }

    #[test]
    fn per_url_fallback_only_on_blocked_status() {
        let cfg_root = json!({ "Scrapling": { "Enabled": true, "AutoFallback": false, "PerUrlConfig": {
            "https://f": { "fallback": true, "wait": 8000 },
            "https://e": { "enabled": true }
        } } });
        let cfg = ScraplingConfig::new(&cfg_root);
        assert!(cfg.url_fallback("https://f") && !cfg.url_fallback("https://e"));
        assert!(!cfg.should_use("https://f", Some(200)));
        assert!(cfg.should_use("https://f", Some(403)));
        assert!(
            !cfg.should_use("https://other", Some(403)),
            "AutoFallback stays off elsewhere"
        );
        assert!(cfg.should_use("https://e", Some(200)));
    }

    #[test]
    fn detects_challenge_signals() {
        let signals = analyze(
            Some(403),
            &Map::new(),
            "<title>Just a moment...</title>",
            &anti(),
        );
        assert!(signals.blocked && signals.status_blocked && signals.title_blocked);
        let mut headers = Map::new();
        headers.insert("cf-ray".into(), json!("abc"));
        let ok = analyze(Some(200), &headers, "<rss></rss>", &anti());
        assert!(!ok.blocked, "cloudflare alone stays below confidence floor");
    }

    #[test]
    fn cloudflare_solve_keeps_resources() {
        let root = json!({ "Scrapling": { "PerUrlConfig": { "https://p": { "wait": 8000 } } } });
        let cfg = ScraplingConfig::new(&root);
        let stealth = request_options(&cfg, "https://p", "stealthy-fetch", true);
        assert_eq!(stealth["solveCloudflare"], json!(true));
        assert_eq!(stealth["disableResources"], json!(false));
        let plain = request_options(&cfg, "https://p", "fetch", true);
        assert_eq!(plain["disableResources"], json!(true));
        let root = json!({ "Scrapling": { "DefaultOptions": { "disableResources": true } } });
        let explicit = request_options(
            &ScraplingConfig::new(&root),
            "https://p",
            "stealthy-fetch",
            false,
        );
        assert_eq!(explicit["disableResources"], json!(true));
    }

    #[test]
    fn mode_sequence_respects_per_url() {
        let root = json!({ "Scrapling": { "PerUrlConfig": { "https://p": { "mode": "stealthy-fetch" } } } });
        let cfg = ScraplingConfig::new(&root);
        assert_eq!(
            cfg.mode_sequence("https://p"),
            vec!["stealthy-fetch", "get", "fetch"]
        );
        assert!(cfg.should_use("https://x", Some(403)));
        assert!(!cfg.should_use("https://x", Some(404)));
    }

    #[test]
    fn html_items() {
        let items = html_to_items(
            "<html><body><article><h2>Hello</h2><a href='https://a/1'>x</a></article></body></html>",
            &Value::Null,
        );
        assert_eq!(items[0]["title"], json!("Hello"));
        assert_eq!(items[0]["link"], json!("https://a/1"));
    }
}
