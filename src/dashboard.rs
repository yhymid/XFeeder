//! Web dashboard (`xfeeder dashboard`): authenticated UI/API for editing the
//! config, `.env` secrets and network settings, viewing activity, metrics and
//! diagnostics, and controlling a dashboard-owned worker. The UI is rendered
//! on the server (`ui.rs`) as plain HTML forms: no JavaScript.

#![allow(clippy::result_large_err)]

mod i18n;
mod ui;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use axum::response::Response;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::config::{self, Env};
use crate::diag::sanitize_text;
use crate::js;
use crate::telemetry::{self, COUNTERS, DURATIONS};

const MAX_BODY: usize = 2 * 1024 * 1024;
const COOKIE: &str = "xfeeder_session";
const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct Options {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub public_origin: String,
    pub password: String,
    pub session_ttl_hours: Option<f64>,
}

struct Paths {
    config: PathBuf,
    env: PathBuf,
    cache: PathBuf,
}

struct Auth {
    password: String,
    ttl: Duration,
    secure: bool,
    sessions: Mutex<HashMap<String, Instant>>,
    window: Mutex<(Instant, u32)>,
}

struct Worker {
    child: Option<tokio::process::Child>,
    busy: bool,
}

struct Server {
    host: String,
    port: u16,
    public_origin: String,
    paths: Paths,
    auth: Auth,
    worker: tokio::sync::Mutex<Worker>,
}

fn is_loopback(host: &str) -> bool {
    matches!(
        host.trim().to_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

pub fn revision(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&read_text(path)).unwrap_or_else(|_| json!({}))
}

fn reply(status: StatusCode, body: &Value, extra: &[(&str, String)]) -> Response {
    let mut response = Response::new(Body::from(
        serde_json::to_string_pretty(body).unwrap_or_default(),
    ));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    for (name, value) in extra {
        if let (Ok(name), Ok(value)) = (
            header::HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.insert(name, value);
        }
    }
    response
}

fn err(status: StatusCode, message: &str) -> Response {
    reply(status, &json!({ "error": message }), &[])
}

fn etag(rev: &str) -> (&'static str, String) {
    ("ETag", format!("\"{rev}\""))
}

impl Auth {
    fn new(
        public_origin: &str,
        host: &str,
        password: String,
        ttl_hours: Option<f64>,
    ) -> Result<Self, String> {
        let public_host = url::Url::parse(public_origin)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.trim_matches(['[', ']']).to_string()))
            .unwrap_or_default();
        if !is_loopback(host) && password.is_empty() {
            return Err("Dashboard is binding to a non-loopback host. Set XFEEDER_DASHBOARD_PASSWORD before exposing it outside localhost.".into());
        }
        if !public_host.is_empty() && !is_loopback(&public_host) && password.is_empty() {
            return Err("Dashboard public origin is non-loopback. Set XFEEDER_DASHBOARD_PASSWORD before exposing it through a reverse proxy.".into());
        }
        let hours = ttl_hours
            .filter(|h| h.is_finite() && *h > 0.0)
            .unwrap_or(12.0);
        Ok(Self {
            password,
            ttl: Duration::from_secs_f64(hours * 3600.0),
            secure: public_origin.starts_with("https://"),
            sessions: Mutex::new(HashMap::new()),
            window: Mutex::new((Instant::now(), 0)),
        })
    }

    fn required(&self) -> bool {
        !self.password.is_empty()
    }

    fn session_id(headers: &HeaderMap) -> String {
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|c| c.split_once('='))
            .find(|(k, _)| k.trim() == COOKIE)
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default()
    }

    fn state(&self, headers: &HeaderMap) -> Value {
        if !self.required() {
            return json!({ "required": false, "authenticated": true, "mode": "local-open" });
        }
        let mut sessions = self.sessions.lock().expect("lock");
        let now = Instant::now();
        sessions.retain(|_, expires| *expires > now);
        let id = Self::session_id(headers);
        let authenticated = match sessions.get_mut(&id) {
            Some(expires) => {
                *expires = now + self.ttl;
                true
            }
            None => false,
        };
        json!({ "required": true, "authenticated": authenticated, "mode": "password" })
    }

    fn reserve_login(&self) -> u64 {
        let mut window = self.window.lock().expect("lock");
        if window.0.elapsed() >= Duration::from_secs(60) {
            *window = (Instant::now(), 0);
        }
        if !self.required() {
            return 0;
        }
        if window.1 >= 10 {
            return (60 - window.0.elapsed().as_secs()).max(1);
        }
        window.1 += 1;
        0
    }

    fn cookie(&self, value: &str, max_age: u64) -> String {
        let mut parts = vec![
            format!("{COOKIE}={value}"),
            "Path=/".into(),
            "HttpOnly".into(),
            "SameSite=Strict".into(),
        ];
        if self.secure {
            parts.push("Secure".into());
        }
        parts.push(format!("Max-Age={max_age}"));
        parts.join("; ")
    }

    fn login(&self, candidate: &str) -> Option<Option<String>> {
        if !self.required() {
            return Some(None);
        }
        let a = Sha256::digest(candidate.as_bytes());
        let b = Sha256::digest(self.password.as_bytes());
        let equal = candidate.len() == self.password.len()
            && a.iter()
                .zip(b.iter())
                .fold(0u8, |acc, (x, y)| acc | (x ^ y))
                == 0;
        if !equal {
            return None;
        }
        let mut sessions = self.sessions.lock().expect("lock");
        if sessions.len() >= 256
            && let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, e)| **e)
                .map(|(k, _)| k.clone())
        {
            sessions.remove(&oldest);
        }
        let id = hex::encode(rand::random::<[u8; 16]>());
        sessions.insert(id.clone(), Instant::now() + self.ttl);
        Some(Some(self.cookie(&id, self.ttl.as_secs())))
    }

    fn logout(&self, headers: &HeaderMap) -> String {
        self.sessions
            .lock()
            .expect("lock")
            .remove(&Self::session_id(headers));
        self.cookie("", 0)
    }
}

fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
    crate::state::write_atomic(path, content.as_bytes(), 0o600)
}

fn validation(config: &Value, env_path: &Path) -> Value {
    let mut env: Env = config::load_dotenv(env_path);
    env.extend(std::env::vars());
    let version = config::schema_version(config).ok();
    let (errors, warnings, issues) = config::validate(config, &env);
    json!({
        "errors": errors, "warnings": warnings, "issues": issues,
        "schemaVersion": version, "runtimeSupported": issues.is_empty(),
    })
}

fn env_refs(config: &Value) -> Vec<String> {
    let mut refs = HashSet::new();
    config::collect_env_refs(config, &mut refs);
    let mut list: Vec<String> = refs.into_iter().collect();
    list.sort();
    list
}

fn cache_summary(cache: &Value) -> Value {
    let mut preview = Vec::new();
    let (mut buckets, mut items) = (0usize, 0usize);
    for (channel, bucket) in cache.as_object().into_iter().flatten() {
        for (name, values) in bucket.as_object().into_iter().flatten() {
            if let Some(list) = values.as_array() {
                buckets += 1;
                items += list.len();
                preview.push(json!({ "channel": channel, "bucket": name, "count": list.len() }));
            }
        }
    }
    preview.sort_by_key(|p| std::cmp::Reverse(p["count"].as_u64().unwrap_or(0)));
    preview.truncate(24);
    json!({ "channelBuckets": cache.as_object().map_or(0, Map::len), "totalBuckets": buckets, "totalItems": items, "preview": preview })
}

fn runtime_channels(config: &Value) -> Vec<config::Channel> {
    config::runtime_shape(config)
        .map(|shape| config::collect_channels(&shape))
        .unwrap_or_default()
}

fn secret_status(config: &Value, env_text: &str) -> Map<String, Value> {
    let parsed = config::parse_dotenv(env_text);
    let mut names: Vec<String> = env_refs(config)
        .into_iter()
        .chain(parsed.keys().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let set = std::env::var(&name)
                .ok()
                .or_else(|| parsed.get(&name).cloned())
                .is_some_and(|v| !v.is_empty());
            let status = if set { "Configured" } else { "Missing" };
            (name, json!(status))
        })
        .collect()
}

fn reserved_secret(name: &str) -> bool {
    let upper = name.to_uppercase();
    ["NODE_", "LD_", "DYLD_", "XFEEDER_DASHBOARD_", "NPM_"]
        .iter()
        .any(|p| upper.starts_with(p))
        || matches!(
            upper.as_str(),
            "BASH_ENV" | "ENV" | "PATH" | "HOME" | "SHELL"
        )
}

fn replace_secret(env_text: &str, name: &str, value: &str) -> Result<String, &'static str> {
    if value.is_empty()
        || value.len() > 8192
        || value.chars().any(|c| c.is_control())
        || value.trim() != value
        || ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        return Err("Secret value must be a nonempty single line");
    }
    let ending = if env_text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = env_text
        .split('\n')
        .map(|l| l.trim_end_matches('\r').to_string())
        .collect();
    let mut matches = 0;
    for line in &mut lines {
        let trimmed = line.trim_start();
        if let Some((key, _)) = trimmed.split_once('=')
            && key.trim_end() == name
        {
            let prefix_len = line.len() - trimmed.len() + trimmed.find('=').unwrap_or(0) + 1;
            let spaces = line[prefix_len..].len() - line[prefix_len..].trim_start().len();
            *line = format!("{}{value}", &line[..prefix_len + spaces]);
            matches += 1;
        }
    }
    if matches > 1 {
        return Err("Duplicate environment key must be resolved first");
    }
    if matches == 0 {
        if lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        lines.push(format!("{name}={value}"));
    }
    Ok(format!(
        "{}{ending}",
        lines.join(ending).trim_end_matches(['\r', '\n'])
    ))
}

fn network_runtime(config_path: &Path, network: &Value) -> Value {
    let stale = |reason: &str| json!({ "available": false, "applied": false, "reason": reason });
    let path = telemetry::runtime_path(config_path);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return stale("Worker metrics unavailable");
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return stale("Worker metrics unavailable");
    };
    let updated = value["updatedAt"]
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
    let Some(updated) =
        updated.filter(|_| value["schemaVersion"] == json!(1) && value["metrics"].is_object())
    else {
        return stale("Worker metrics unavailable");
    };
    let age = chrono::Utc::now().timestamp_millis() - updated.timestamp_millis();
    if !(-1000..=6500).contains(&age) {
        return json!({ "available": false, "applied": false, "reason": "Worker metrics are stale", "updatedAt": value["updatedAt"] });
    }
    let applied = config::normalize_network(network)
        .map(|n| telemetry::network_signature(&n))
        .ok()
        == value["configSignature"].as_str().map(str::to_string);
    json!({ "available": true, "applied": applied, "updatedAt": value["updatedAt"], "metrics": value["metrics"], "workerReady": value["workerReady"] == json!(true) })
}

fn worker_ready(config_path: &Path) -> bool {
    let config = read_json(config_path);
    if config::normalize_network(js::get(&config, "network")).is_err() {
        return false;
    }
    let runtime = network_runtime(config_path, js::get(&config, "network"));
    runtime["available"] == json!(true)
        && runtime["applied"] == json!(true)
        && runtime["workerReady"] == json!(true)
        && runtime["metrics"]["stopping"] == json!(false)
}

fn network_settings(config_path: &Path) -> (Value, Value) {
    let text = read_text(config_path);
    let config: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let raw = js::get(&config, "network");
    let payload = match config::normalize_network(raw) {
        Ok(net) => json!({
            "settings": {
                "bandwidthProfile": net.bandwidth_profile,
                "downloadLimitMbps": js::get(raw, "downloadLimitMbps"),
                "uploadLimitMbps": js::get(raw, "uploadLimitMbps"),
                "networkFriendlyMode": net.network_friendly_mode,
                "maxConcurrentRequests": net.max_concurrent_requests,
                "maxConcurrentScraplingRequests": net.max_concurrent_scrapling_requests,
                "scraplingResourceSaving": net.scrapling_resource_saving,
                "setupTimeoutMs": net.setup_timeout_ms,
                "idleTimeoutMs": net.idle_timeout_ms,
                "requestDeadlineMs": net.request_deadline_ms,
                "shutdownGraceMs": net.shutdown_grace_ms,
            },
            "revision": revision(&text),
            "errors": [],
            "effective": {
                "downloadLimitBytesPerSecond": net.download_bytes_per_second,
                "uploadLimitBytesPerSecond": net.upload_bytes_per_second,
                "httpConcurrency": net.http_concurrency(),
                "scraplingConcurrency": net.scrapling_concurrency(),
            },
            "runtime": network_runtime(config_path, raw),
        }),
        Err(errors) => json!({
            "settings": null, "revision": revision(&text), "errors": errors, "effective": null,
            "runtime": { "available": false, "applied": false, "reason": "Invalid network configuration" },
        }),
    };
    (config, payload)
}

fn channel_projection(config: &Value) -> Vec<Value> {
    runtime_channels(config)
        .iter()
        .enumerate()
        .map(|(index, channel)| {
            let id_input = json!([channel.source_key, channel.name.as_ref().map_or(json!(index), |n| json!(n))]).to_string();
            json!({
                "id": &revision(&id_input)[..24],
                "label": channel.display.as_ref().or(channel.name.as_ref()).map_or_else(|| format!("Channel {}", index + 1), |n| js::prefix16(&sanitize_text(n), 80).to_string()),
                "intervalMinutes": channel.time_checker,
                "maxEntriesPerCycle": channel.request_send,
                "sources": { "feedCount": channel.feeds.len(), "discord": channel.discord.is_some() },
                "destinations": { "webhook": channel.has_webhook(), "telegram": channel.has_telegram() },
            })
        })
        .collect()
}

fn settings_projection(config: &Value, network: Value) -> Value {
    let v2 = config["schemaVersion"] == json!(2);
    let settings = if v2 {
        js::get(config, "settings")
    } else {
        js::get(config, "Settings")
    };
    let ints = js::get(config, "integrations");
    let pick = |v2_key: &str, v1_key: &str| {
        if v2 {
            js::get(settings, v2_key)
        } else {
            js::get(settings, v1_key)
        }
    };
    json!({
        "schemaVersion": if v2 { 2 } else { 1 },
        "general": {
            "logs": pick("logs", "Logs") == &json!(true),
            "expertDiagnostics": pick("debugExpert", "DebugExpert") == &json!(true),
            "maxConcurrentChannels": js::or_else(&[pick("maxConcurrentChannels", "MaxConcurrentChannels")], json!(1)),
        },
        "integrations": {
            "proxyEnabled": if v2 { js::path(ints, &["proxy", "enabled"]) } else { js::path(config, &["Proxy", "Enabled"]) } == &json!(true),
            "scraplingEnabled": if v2 { js::path(ints, &["scrapling", "enabled"]) } else { js::path(config, &["Scrapling", "Enabled"]) } == &json!(true),
        },
        "network": network,
    })
}

fn public_event(raw: &Value) -> Option<Value> {
    const TYPES: [&str; 16] = [
        "worker.started",
        "worker.stopped",
        "channel.started",
        "channel.completed",
        "channel.failed",
        "feed.fetch.started",
        "feed.fetch.completed",
        "feed.not_modified",
        "feed.parse.completed",
        "feed.failed",
        "feed.processing.failed",
        "delivery.sent",
        "delivery.failed",
        "retry.scheduled",
        "scrapling.used",
        "config.reloaded",
    ];
    let kind = raw["type"].as_str().filter(|t| TYPES.contains(t))?;
    let time = raw["time"]
        .as_str()
        .filter(|t| chrono::DateTime::parse_from_rfc3339(t).is_ok())?;
    let fail = kind.ends_with(".failed") || raw["level"] == json!("error");
    let warn = kind == "scrapling.used";
    let source = if kind.starts_with("delivery.") {
        "delivery"
    } else if kind.starts_with("feed.") || warn {
        "fetch"
    } else {
        "worker"
    };
    let channel = raw["channelId"]
        .as_str()
        .filter(|c| c.len() == 16 && c.bytes().all(|b| b.is_ascii_hexdigit()))
        .map_or(String::new(), |c| format!("channel:{c}"));
    Some(json!({
        "id": raw["id"].as_u64().unwrap_or(0), "time": time, "event": kind, "type": source,
        "status": if fail { "error" } else if warn { "warning" } else { "success" },
        "channel": channel,
        "source": raw["sourceId"].as_str().filter(|c| c.len() == 16 && c.bytes().all(|b| b.is_ascii_hexdigit())).map_or(String::new(), |c| format!("feed:{c}")),
        "target": raw["destination"].as_str().unwrap_or(""),
        "durationMs": raw["durationMs"].as_u64(), "message": kind.replace('.', " "), "dryRun": raw["dryRun"] == json!(true),
        "details": { "event": kind, "httpStatus": raw["httpStatus"].as_u64(), "itemCount": raw["itemCount"].as_u64(), "errorCode": raw["errorCode"] },
    }))
}

fn read_activity(config_path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(telemetry::activity_path(config_path))
        .ok()
        .filter(|t| t.len() <= 2 * 1024 * 1024)?;
    let data: Value = serde_json::from_str(&text).ok()?;
    if data["schemaVersion"] != json!(1) || !data["events"].is_array() {
        return None;
    }
    Some(data)
}

fn structured_activity(config_path: &Path, limit: usize) -> Value {
    let Some(data) = read_activity(config_path) else {
        return json!({ "available": false, "items": [], "channels": {}, "summary": { "lastActivityAt": null, "deliveries24h": null, "errors24h": null, "health": "unknown", "observedSince": null, "truncated": false, "partialWindow": true } });
    };
    let items: Vec<Value> = data["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(public_event)
        .collect();
    let now = chrono::Utc::now().timestamp_millis();
    let at = |item: &Value| {
        item["time"]
            .as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map_or(0, |d| d.timestamp_millis())
    };
    let mut channels = Map::new();
    let mut last = Value::Null;
    for item in items.iter().filter(|i| i["dryRun"] != json!(true)) {
        last = item["time"].clone();
        if let Some(channel) = item["channel"].as_str().filter(|c| !c.is_empty()) {
            let state = channels.entry(channel.to_string()).or_insert_with(
                || json!({ "status": "unknown", "lastCheck": null, "deliveries": 0 }),
            );
            if item["status"] == json!("error") {
                state["status"] = json!("error");
            } else if state["status"] == json!("unknown") {
                state["status"] = json!("healthy");
            }
            let event = item["event"].as_str().unwrap_or("");
            if event.starts_with("channel.")
                && (event.ends_with(".completed") || event.ends_with(".failed"))
            {
                state["lastCheck"] = item["time"].clone();
            }
            if event == "delivery.sent" {
                state["deliveries"] = json!(state["deliveries"].as_u64().unwrap_or(0) + 1);
            }
        }
    }
    let recent: Vec<&Value> = items
        .iter()
        .filter(|i| i["dryRun"] != json!(true) && now - at(i) <= 86_400_000)
        .collect();
    let errors = recent
        .iter()
        .filter(|i| i["status"] == json!("error"))
        .count();
    let stale = last
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .is_none_or(|t| now - t.timestamp_millis() > 180_000);
    let count = data["events"].as_array().map_or(0, Vec::len);
    let observed = items.first().map_or(Value::Null, |i| i["time"].clone());
    let partial = items.is_empty()
        || items.first().is_some_and(|i| now - at(i) < 86_400_000)
        || count >= 2000;
    let shown: Vec<Value> = items
        .iter()
        .rev()
        .take(limit.clamp(1, 2000))
        .cloned()
        .collect();
    json!({
        "available": true, "items": shown, "channels": channels,
        "summary": {
            "lastActivityAt": last,
            "deliveries24h": recent.iter().filter(|i| i["event"] == json!("delivery.sent")).count(),
            "errors24h": errors,
            "health": if errors > 0 { "warning" } else if stale { "unknown" } else { "healthy" },
            "observedSince": observed, "truncated": count >= 2000, "partialWindow": partial,
        },
        "source": "structured",
    })
}

fn public_metrics(input: &Value) -> Value {
    let num = |v: &Value| {
        v.as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map_or(json!(0), js::number)
    };
    let counters: Map<String, Value> = COUNTERS
        .iter()
        .map(|n| (n.to_string(), num(&input["counters"][n])))
        .collect();
    let mut counters = counters;
    counters.insert("delivery_total".into(), json!({
        "webhook": { "success": num(&input["counters"]["delivery_total"]["webhook"]["success"]), "error": num(&input["counters"]["delivery_total"]["webhook"]["error"]) },
        "telegram": { "success": num(&input["counters"]["delivery_total"]["telegram"]["success"]), "error": num(&input["counters"]["delivery_total"]["telegram"]["error"]) },
    }));
    let durations: Map<String, Value> = DURATIONS
        .iter()
        .map(|n| {
            let s = &input["durations"][n];
            let buckets: Map<String, Value> = ["100", "500", "1000", "5000", "30000", "+Inf"].iter().map(|b| (b.to_string(), num(&s["buckets"][b]))).collect();
            (n.to_string(), json!({ "count": num(&s["count"]), "sum": num(&s["sum"]), "min": if s["min"].is_null() { Value::Null } else { num(&s["min"]) }, "max": if s["max"].is_null() { Value::Null } else { num(&s["max"]) }, "buckets": buckets }))
        })
        .collect();
    json!({
        "counters": counters,
        "network": if input["network"]["available"] == json!(true) { input["network"].clone() } else { json!({ "available": false }) },
        "gauges": { "active_jobs": num(&input["gauges"]["active_jobs"]), "failing_feeds": num(&input["gauges"]["failing_feeds"]), "queue_due_channels": num(&input["gauges"]["queue_due_channels"]) },
        "durations": durations,
    })
}

impl Server {
    fn state_payload(&self, auth: Value) -> Value {
        let text = read_text(&self.paths.config);
        let config: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
        let cache = read_json(&self.paths.cache);
        let env_values = config::load_dotenv(&self.paths.env);
        let validation = validation(&config, &self.paths.env);
        let shape = config::runtime_shape(&config).unwrap_or_else(|_| json!({}));
        let groups: Vec<Value> = config::channel_groups(&shape)
            .into_iter()
            .map(|(key, value)| json!({ "key": key, "mode": if value.is_array() { "array" } else { "object" }, "count": value.as_array().map_or_else(|| value.as_object().map_or(0, Map::len), Vec::len) }))
            .collect();
        let channels = runtime_channels(&config);
        let refs = env_refs(&config);
        let mut names: Vec<String> = env_values
            .keys()
            .cloned()
            .chain(refs.iter().cloned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        names.sort();
        let env_status: Map<String, Value> = names
            .into_iter()
            .map(|name| {
                let set = std::env::var(&name)
                    .ok()
                    .or_else(|| env_values.get(&name).cloned())
                    .is_some_and(|v| !v.is_empty());
                let status = if set { "configured" } else { "missing" };
                (name, json!(status))
            })
            .collect();
        json!({
            "config": config,
            "revision": revision(&text),
            "warnings": validation["warnings"],
            "errors": validation["errors"],
            "envStatus": env_status,
            "envExample": read_text(&self.paths.config.with_file_name(".env.example")),
            "cacheSummary": cache_summary(&cache),
            "stats": {
                "groups": groups, "totalChannelGroups": groups.len(), "totalChannels": channels.len(),
                "totalFeeds": channels.iter().map(|c| c.feeds.len()).sum::<usize>(), "envRefs": refs,
            },
            "auth": auth,
            "meta": {
                "host": self.host, "port": self.port,
                "configPath": self.paths.config, "envPath": self.paths.env, "cachePath": self.paths.cache,
                "appVersion": VERSION,
                "configReload": "worker picks up config and .env changes from disk on the next cycle",
                "security": { "authMode": auth["mode"], "passwordRequired": auth["required"] == json!(true) },
            },
        })
    }

    fn external_worker(&self) -> bool {
        let config = read_json(&self.paths.config);
        if network_runtime(&self.paths.config, js::get(&config, "network"))["available"]
            == json!(true)
        {
            return true;
        }
        let record = read_json(&telemetry::runtime_path(&self.paths.config));
        match record["pid"].as_i64().filter(|p| *p > 1) {
            Some(pid) => {
                let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
                alive || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
            }
            None => false,
        }
    }

    async fn worker_status(&self, worker: &mut Worker) -> Value {
        if let Some(child) = worker.child.as_mut()
            && child.try_wait().ok().flatten().is_some()
        {
            worker.child = None;
        }
        let managed = worker.child.is_some();
        json!({ "running": managed, "externalWorker": !managed && self.external_worker(), "busy": worker.busy, "managed": managed })
    }

    async fn worker_action(&self, action: &str) -> Response {
        match self.worker_run(action).await {
            Ok(status) => reply(StatusCode::OK, &status, &[]),
            Err((status, message)) => err(status, &message),
        }
    }

    async fn worker_run(&self, action: &str) -> Result<Value, (StatusCode, String)> {
        let mut worker = self.worker.lock().await;
        if worker.busy {
            return Err((StatusCode::CONFLICT, "Worker operation in progress".into()));
        }
        let _ = self.worker_status(&mut worker).await;
        if matches!(action, "stop" | "restart") {
            let Some(mut child) = worker.child.take() else {
                return Err((
                    StatusCode::CONFLICT,
                    "Only dashboard-managed workers can be stopped here".into(),
                ));
            };
            worker.busy = true;
            if let Some(pid) = child.id() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
            let stopped = tokio::time::timeout(Duration::from_secs(15), child.wait())
                .await
                .is_ok();
            worker.busy = false;
            if !stopped {
                worker.child = Some(child);
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Worker shutdown still in progress; do not start another worker".into(),
                ));
            }
            if action == "stop" {
                let mut status = self.worker_status(&mut worker).await;
                status["action"] = json!("stop");
                return Ok(status);
            }
        }
        if worker.child.is_some() || self.external_worker() {
            return Err((
                StatusCode::CONFLICT,
                "Worker is already running or managed externally".into(),
            ));
        }
        let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("xfeeder"));
        let spawned = tokio::process::Command::new(exe)
            .args(["run", "--config"])
            .arg(&self.paths.config)
            .arg("--cache")
            .arg(&self.paths.cache)
            .current_dir(self.paths.config.parent().unwrap_or(Path::new(".")))
            .env("XFEEDER_RUN_ONCE", "0")
            .env("XFEEDER_DRY_RUN", "0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        match spawned {
            Ok(child) => {
                worker.child = Some(child);
                let mut status = self.worker_status(&mut worker).await;
                status["action"] = json!(action);
                Ok(status)
            }
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Worker control failed: {e}"),
            )),
        }
    }

    async fn handle(self: Arc<Self>, request: Request<Body>) -> Response {
        let mut response = self.route(request).await;
        let headers = response.headers_mut();
        headers.insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
        // same-origin (not no-referrer): browsers then send a real Origin
        // header on form posts, which the CSRF check relies on.
        headers.insert("referrer-policy", HeaderValue::from_static("same-origin"));
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"),
        );
        response
    }

    async fn route(&self, request: Request<Body>) -> Response {
        let (parts, body) = request.into_parts();
        let method = parts.method.clone();
        let headers = parts.headers;
        let path = parts.uri.path().to_string();
        let query: HashMap<String, String> = parts
            .uri
            .query()
            .map(|q| {
                url::form_urlencoded::parse(q.as_bytes())
                    .into_owned()
                    .collect()
            })
            .unwrap_or_default();
        let host_header = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        let locals: Vec<String> = if is_loopback(&self.host) {
            vec!["127.0.0.1".into(), "localhost".into(), "[::1]".into()]
        } else if self.host.contains(':') {
            vec![format!("[{}]", self.host)]
        } else {
            vec![self.host.clone()]
        };
        let mut authorities: Vec<String> = locals
            .iter()
            .map(|h| format!("{h}:{}", self.port).to_lowercase())
            .collect();
        let public = url::Url::parse(&self.public_origin).ok();
        if let Some(public) = &public {
            authorities.push(
                public
                    .host_str()
                    .map(|h| match public.port() {
                        Some(p) => format!("{h}:{p}"),
                        None => h.to_string(),
                    })
                    .unwrap_or_default()
                    .to_lowercase(),
            );
        }
        // Bound to loopback, a loopback name with another port is an SSH
        // tunnel (local port ≠ server port). Only literal loopback names are
        // accepted, so DNS rebinding through a foreign host name still fails.
        if is_loopback(&self.host)
            && !authorities.contains(&host_header)
            && host_header
                .rsplit_once(':')
                .is_some_and(|(h, p)| locals.iter().any(|l| l == h) && p.parse::<u16>().is_ok())
        {
            authorities.push(host_header.clone());
        }
        let expected_origin: Vec<String> = if self.public_origin.is_empty() {
            authorities.iter().map(|a| format!("http://{a}")).collect()
        } else {
            vec![self.public_origin.clone()]
        };
        if !authorities.contains(&host_header) {
            return err(StatusCode::FORBIDDEN, "Untrusted Host.");
        }
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|o| o.to_str().ok())
            .map(str::trim)
            .filter(|o| *o != "null")
            .unwrap_or("")
            .to_string();
        let same_origin = !origin.is_empty() && expected_origin.contains(&origin);
        let fetch_same_origin =
            headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("same-origin");
        if !origin.is_empty() && !same_origin {
            return err(StatusCode::FORBIDDEN, "Origin mismatch.");
        }
        let auth = self.auth.state(&headers);
        let authorized = auth["authenticated"] == json!(true);
        let denied = || {
            reply(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": "Dashboard password required.", "auth": auth }),
                &[],
            )
        };
        let mutating = !matches!(method, Method::GET | Method::HEAD);
        if mutating && !same_origin && path.starts_with("/api/") {
            return err(StatusCode::FORBIDDEN, "Origin mismatch.");
        }
        let body = match to_bytes(body, MAX_BODY).await {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => return err(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large"),
        };
        let parse = |text: &str| -> Result<Value, Response> {
            let text = if text.trim().is_empty() { "{}" } else { text };
            serde_json::from_str(text).map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid JSON."))
        };
        let if_match = headers
            .get(header::IF_MATCH)
            .and_then(|h| h.to_str().ok())
            .map(str::to_string);
        let accept_warnings = headers
            .get("x-xfeeder-accept-warnings")
            .and_then(|h| h.to_str().ok())
            == Some("true");
        let config_text = read_text(&self.paths.config);
        let current_rev = revision(&config_text);

        match (method.clone(), path.as_str()) {
            (Method::GET, "/api/live" | "/api/health/live") => reply(
                StatusCode::OK,
                &json!({ "ok": true, "service": "xfeeder-dashboard", "status": "live" }),
                &[],
            ),
            (Method::GET, "/api/ready" | "/api/health/ready") => {
                let ready = worker_ready(&self.paths.config);
                reply(
                    if ready {
                        StatusCode::OK
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                    &json!({ "ok": ready, "service": "xfeeder-worker", "status": if ready { "ready" } else { "not-ready" } }),
                    &[],
                )
            }
            (Method::GET, "/api/health") => reply(
                StatusCode::OK,
                &json!({ "ok": true, "name": "xfeeder-dashboard", "version": VERSION, "authRequired": self.auth.required(), "time": crate::text::now_iso() }),
                &[],
            ),
            (Method::GET, "/api/auth-state") => {
                reply(StatusCode::OK, &json!({ "auth": auth }), &[])
            }
            (Method::POST, "/api/login") => {
                let retry = self.auth.reserve_login();
                if retry > 0 {
                    return reply(
                        StatusCode::TOO_MANY_REQUESTS,
                        &json!({ "error": "Too many login attempts. Try again later." }),
                        &[("Retry-After", retry.to_string())],
                    );
                }
                let payload = match parse(&body) {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                match self.auth.login(payload["password"].as_str().unwrap_or("")) {
                    None => reply(
                        StatusCode::UNAUTHORIZED,
                        &json!({ "error": "Invalid dashboard password.", "auth": auth }),
                        &[],
                    ),
                    Some(cookie) => {
                        let extra: Vec<(&str, String)> =
                            cookie.map(|c| ("Set-Cookie", c)).into_iter().collect();
                        let mode = if self.auth.required() {
                            "password"
                        } else {
                            "local-open"
                        };
                        reply(
                            StatusCode::OK,
                            &json!({ "ok": true, "auth": { "required": self.auth.required(), "authenticated": true, "mode": mode } }),
                            &extra,
                        )
                    }
                }
            }
            (Method::POST, "/api/logout") => reply(
                StatusCode::OK,
                &json!({ "ok": true }),
                &[("Set-Cookie", self.auth.logout(&headers))],
            ),
            (_, p) if p.starts_with("/api/") && !authorized => denied(),
            (Method::GET, "/api/worker/control") => {
                let mut worker = self.worker.lock().await;
                let status = self.worker_status(&mut worker).await;
                reply(StatusCode::OK, &status, &[])
            }
            (Method::POST, "/api/worker/control") => {
                let payload = match parse(&body) {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                match payload["action"].as_str() {
                    Some(action @ ("start" | "stop" | "restart")) => {
                        self.worker_action(action).await
                    }
                    _ => err(StatusCode::BAD_REQUEST, "Invalid worker action."),
                }
            }
            (Method::GET, "/api/state") => reply(
                StatusCode::OK,
                &self.state_payload(auth),
                &[
                    ("Deprecation", "true".into()),
                    (
                        "Link",
                        "</api/advanced/config>; rel=\"successor-version\"".into(),
                    ),
                ],
            ),
            (Method::POST, "/api/validate") => match parse(&body) {
                Ok(config) => reply(StatusCode::OK, &validation(&config, &self.paths.env), &[]),
                Err(r) => r,
            },
            (Method::PUT, "/api/config") => {
                let config = match parse(&body) {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                if !config.is_object() {
                    return err(
                        StatusCode::BAD_REQUEST,
                        "Config root must be a JSON object.",
                    );
                }
                let Some(tag) = if_match else {
                    return err(
                        StatusCode::PRECONDITION_REQUIRED,
                        "Configuration revision required. Reload settings first.",
                    );
                };
                if tag != format!("\"{current_rev}\"") {
                    return err(
                        StatusCode::PRECONDITION_FAILED,
                        "Configuration changed elsewhere. Refresh before saving.",
                    );
                }
                let mut result = validation(&config, &self.paths.env);
                if result["schemaVersion"] == json!(2)
                    && result["errors"].as_array().is_some_and(Vec::is_empty)
                {
                    return reply(
                        StatusCode::CONFLICT,
                        &json!({ "error": "Schema v2 runs in the worker but cannot yet be saved by the legacy dashboard editor.", "code": "CONFIG_EDITOR_V2_UNSUPPORTED" }),
                        &[],
                    );
                }
                if result["errors"].as_array().is_some_and(|e| !e.is_empty()) {
                    result["error"] = json!("Configuration validation failed.");
                    return reply(StatusCode::BAD_REQUEST, &result, &[]);
                }
                if result["warnings"].as_array().is_some_and(|w| !w.is_empty()) && !accept_warnings
                {
                    result["error"] = json!("Review configuration warnings before saving.");
                    return reply(StatusCode::UNPROCESSABLE_ENTITY, &result, &[]);
                }
                if let Err(e) = write_private(
                    &self.paths.config,
                    &format!(
                        "{}\n",
                        serde_json::to_string_pretty(&config).unwrap_or_default()
                    ),
                ) {
                    return err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &sanitize_text(&e.to_string()),
                    );
                }
                reply(StatusCode::OK, &self.state_payload(auth), &[])
            }
            (Method::PUT, "/api/env") => {
                let payload = match parse(&body) {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                let Some(content) = payload["content"].as_str() else {
                    return err(
                        StatusCode::BAD_REQUEST,
                        "Environment content must be a string.",
                    );
                };
                let content = if content.ends_with('\n') {
                    content.to_string()
                } else {
                    format!("{content}\n")
                };
                if let Err(e) = write_private(&self.paths.env, &content) {
                    return err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &sanitize_text(&e.to_string()),
                    );
                }
                reply(StatusCode::OK, &self.state_payload(auth), &[])
            }
            (Method::GET, "/api/secrets/status") => {
                let env_text = read_text(&self.paths.env);
                reply(
                    StatusCode::OK,
                    &json!({ "secrets": secret_status(&read_json(&self.paths.config), &env_text), "revision": revision(&env_text) }),
                    &[],
                )
            }
            (Method::PUT, p) if p.starts_with("/api/secrets/") => {
                let name = percent_decode(&p["/api/secrets/".len()..]).unwrap_or_default();
                let valid = !name.is_empty()
                    && name.len() <= 128
                    && name
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
                if !valid || reserved_secret(&name) {
                    return err(StatusCode::BAD_REQUEST, "Invalid or reserved secret name");
                }
                let config = read_json(&self.paths.config);
                let existing = read_text(&self.paths.env);
                if !secret_status(&config, &existing).contains_key(&name) {
                    return err(
                        StatusCode::NOT_FOUND,
                        "Secret must be referenced by config or declared in .env",
                    );
                }
                let Some(tag) = if_match else {
                    return err(
                        StatusCode::PRECONDITION_REQUIRED,
                        "Environment revision required",
                    );
                };
                if tag != format!("\"{}\"", revision(&existing)) {
                    return err(
                        StatusCode::PRECONDITION_FAILED,
                        "Environment changed since last refresh",
                    );
                }
                let payload = match parse(&body) {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                let Some(value) = payload["value"].as_str() else {
                    return err(
                        StatusCode::BAD_REQUEST,
                        "Replacement secret must be a string",
                    );
                };
                let Ok(updated) = replace_secret(&existing, &name, value) else {
                    return err(StatusCode::BAD_REQUEST, "Unsafe or invalid secret value");
                };
                if let Err(e) = write_private(&self.paths.env, &updated) {
                    return err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &sanitize_text(&e.to_string()),
                    );
                }
                reply(
                    StatusCode::OK,
                    &json!({ "ok": true, "secrets": secret_status(&config, &updated), "revision": revision(&updated) }),
                    &[],
                )
            }
            (Method::GET, "/api/settings/network" | "/api/network/metrics") => {
                let (_, payload) = network_settings(&self.paths.config);
                let body = if path == "/api/network/metrics" {
                    payload["runtime"].clone()
                } else {
                    payload.clone()
                };
                reply(
                    StatusCode::OK,
                    &body,
                    &[(
                        "ETag",
                        format!("\"{}\"", js::to_string(&payload["revision"])),
                    )],
                )
            }
            (Method::PUT, "/api/settings/network") => {
                let settings = match parse(&body) {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                if let Err(errors) = config::normalize_network(&settings) {
                    return reply(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": "Invalid network settings.", "errors": errors }),
                        &[],
                    );
                }
                let (mut config, payload) = network_settings(&self.paths.config);
                let Some(tag) = if_match else {
                    return err(
                        StatusCode::PRECONDITION_REQUIRED,
                        "Configuration revision required. Reload settings first.",
                    );
                };
                if tag != format!("\"{}\"", js::to_string(&payload["revision"])) {
                    return err(
                        StatusCode::PRECONDITION_FAILED,
                        "Configuration changed elsewhere. Refresh before saving.",
                    );
                }
                config["network"] = settings;
                if let Err(e) = write_private(
                    &self.paths.config,
                    &format!(
                        "{}\n",
                        serde_json::to_string_pretty(&config).unwrap_or_default()
                    ),
                ) {
                    return err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &sanitize_text(&e.to_string()),
                    );
                }
                let (_, payload) = network_settings(&self.paths.config);
                reply(
                    StatusCode::OK,
                    &payload,
                    &[(
                        "ETag",
                        format!("\"{}\"", js::to_string(&payload["revision"])),
                    )],
                )
            }
            (Method::GET, "/api/activity") => {
                let limit = query
                    .get("limit")
                    .and_then(|l| l.parse().ok())
                    .unwrap_or(100);
                reply(
                    StatusCode::OK,
                    &structured_activity(&self.paths.config, limit),
                    &[],
                )
            }
            (Method::GET, "/api/metrics") => {
                let data = read_activity(&self.paths.config);
                let fresh = data
                    .as_ref()
                    .and_then(|d| d["updatedAt"].as_str())
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .is_some_and(|t| {
                        let age = chrono::Utc::now().timestamp_millis() - t.timestamp_millis();
                        (-1000..=6500).contains(&age)
                    });
                match data.filter(|_| fresh) {
                    Some(data) => reply(
                        StatusCode::OK,
                        &json!({ "available": true, "updatedAt": data["updatedAt"], "metrics": public_metrics(&data["metrics"]) }),
                        &[],
                    ),
                    None => reply(
                        StatusCode::SERVICE_UNAVAILABLE,
                        &json!({ "available": false, "error": "Worker metrics unavailable or stale" }),
                        &[],
                    ),
                }
            }
            (_, p)
                if p.starts_with("/api/channels/")
                    || matches!(
                        p,
                        "/api/overview"
                            | "/api/channels"
                            | "/api/settings"
                            | "/api/system/info"
                            | "/api/advanced/config"
                    ) =>
            {
                self.projections(
                    &method,
                    p,
                    &body,
                    &config_text,
                    &current_rev,
                    if_match,
                    accept_warnings,
                )
            }
            (Method::GET | Method::POST, p) if !p.starts_with("/api/") => {
                let request = ui::Req {
                    method: &method,
                    path: p,
                    query: &query,
                    form: if method == Method::POST {
                        ui::parse_form(&body)
                    } else {
                        HashMap::new()
                    },
                    headers: &headers,
                    authorized,
                    auth_required: self.auth.required(),
                    can_post: same_origin || (origin.is_empty() && fetch_same_origin),
                };
                ui::handle(self, &request).await
            }
            _ => err(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed."),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn projections(
        &self,
        method: &Method,
        path: &str,
        body: &str,
        text: &str,
        rev: &str,
        if_match: Option<String>,
        accept_warnings: bool,
    ) -> Response {
        let writable =
            *method == Method::PUT && matches!(path, "/api/advanced/config" | "/api/settings");
        if *method != Method::GET && !writable {
            return err(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.");
        }
        let Ok(mut config) = serde_json::from_str::<Value>(text) else {
            return err(StatusCode::INTERNAL_SERVER_ERROR, "Invalid config.json");
        };
        let tag = etag(rev);
        let save = |next: &Value| -> Result<String, Response> {
            let result = validation(next, &self.paths.env);
            if result["errors"].as_array().is_some_and(|e| !e.is_empty())
                || result["runtimeSupported"] == json!(false)
            {
                return Err(reply(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Configuration validation failed.", "issues": result["issues"], "errorCount": result["errors"].as_array().map_or(0, Vec::len) }),
                    &[],
                ));
            }
            if result["warnings"].as_array().is_some_and(|w| !w.is_empty()) && !accept_warnings {
                return Err(reply(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    &json!({ "error": "Review configuration warnings before saving.", "warningCount": result["warnings"].as_array().map_or(0, Vec::len) }),
                    &[],
                ));
            }
            write_private(
                &self.paths.config,
                &format!(
                    "{}\n",
                    serde_json::to_string_pretty(next).unwrap_or_default()
                ),
            )
            .map_err(|e| {
                err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &sanitize_text(&e.to_string()),
                )
            })?;
            Ok(revision(&read_text(&self.paths.config)))
        };
        if writable {
            let Some(given) = if_match else {
                return err(
                    StatusCode::PRECONDITION_REQUIRED,
                    "Configuration revision required.",
                );
            };
            if given != format!("\"{rev}\"") {
                return err(
                    StatusCode::PRECONDITION_FAILED,
                    "Configuration changed elsewhere. Refresh before saving.",
                );
            }
        }
        match (method.clone(), path) {
            (Method::GET, "/api/advanced/config") => reply(
                StatusCode::OK,
                &json!({ "config": config, "revision": rev, "warning": "Advanced config may contain inline secrets. Keep this response private." }),
                &[tag],
            ),
            (Method::PUT, "/api/advanced/config") => {
                let next: Value =
                    match serde_json::from_str(if body.trim().is_empty() { "{}" } else { body }) {
                        Ok(v) => v,
                        Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON."),
                    };
                if !next.is_object() {
                    return err(StatusCode::BAD_REQUEST, "Config root must be an object.");
                }
                match save(&next) {
                    Ok(written) => reply(
                        StatusCode::OK,
                        &json!({ "ok": true, "revision": written }),
                        &[etag(&written)],
                    ),
                    Err(response) => response,
                }
            }
            (Method::PUT, "/api/settings") => {
                let patch: Value =
                    serde_json::from_str(if body.trim().is_empty() { "{}" } else { body })
                        .unwrap_or(Value::Null);
                let general = &patch["general"];
                let valid = patch.as_object().is_some_and(|m| m.len() == 1)
                    && general.as_object().is_some_and(|g| {
                        !g.is_empty()
                            && g.keys().all(|k| {
                                matches!(
                                    k.as_str(),
                                    "logs" | "expertDiagnostics" | "maxConcurrentChannels"
                                )
                            })
                    })
                    && (general["logs"].is_null() || general["logs"].is_boolean())
                    && (general["expertDiagnostics"].is_null()
                        || general["expertDiagnostics"].is_boolean())
                    && (general["maxConcurrentChannels"].is_null()
                        || general["maxConcurrentChannels"]
                            .as_u64()
                            .is_some_and(|n| (1..=8).contains(&n)));
                if !valid {
                    return err(StatusCode::BAD_REQUEST, "Invalid settings patch.");
                }
                let v2 = config["schemaVersion"] == json!(2);
                let section = if v2 { "settings" } else { "Settings" };
                if !config[section].is_object() {
                    config[section] = json!({});
                }
                for (key, value) in general.as_object().into_iter().flatten() {
                    let field = match (v2, key.as_str()) {
                        (true, "expertDiagnostics") => "debugExpert",
                        (false, "logs") => "Logs",
                        (false, "expertDiagnostics") => "DebugExpert",
                        (false, "maxConcurrentChannels") => "MaxConcurrentChannels",
                        (_, other) => other,
                    };
                    config[section][field] = value.clone();
                }
                match save(&config) {
                    Ok(written) => {
                        let (_, network) = network_settings(&self.paths.config);
                        let mut body = settings_projection(&config, network["settings"].clone());
                        body["revision"] = json!(written);
                        reply(StatusCode::OK, &body, &[etag(&written)])
                    }
                    Err(response) => response,
                }
            }
            (_, "/api/overview") => {
                let channels = channel_projection(&config);
                reply(
                    StatusCode::OK,
                    &json!({
                        "workerReady": worker_ready(&self.paths.config),
                        "totalChannels": channels.len(),
                        "totalFeeds": channels.iter().map(|c| c["sources"]["feedCount"].as_u64().unwrap_or(0)).sum::<u64>(),
                        "destinations": {
                            "webhook": channels.iter().filter(|c| c["destinations"]["webhook"] == json!(true)).count(),
                            "telegram": channels.iter().filter(|c| c["destinations"]["telegram"] == json!(true)).count(),
                        },
                        "revision": rev,
                    }),
                    &[tag],
                )
            }
            (_, "/api/channels") => reply(
                StatusCode::OK,
                &json!({ "channels": channel_projection(&config), "revision": rev }),
                &[tag],
            ),
            (_, "/api/settings") => {
                let (_, network) = network_settings(&self.paths.config);
                let mut body = settings_projection(&config, network["settings"].clone());
                body["revision"] = json!(rev);
                reply(StatusCode::OK, &body, &[tag])
            }
            (_, "/api/system/info") => reply(
                StatusCode::OK,
                &json!({ "version": VERSION, "schemaVersion": if config["schemaVersion"] == json!(2) { 2 } else { 1 }, "workerReady": worker_ready(&self.paths.config), "revision": rev }),
                &[tag],
            ),
            (_, p) => {
                let id = &p["/api/channels/".len()..];
                if id.len() != 24
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return err(StatusCode::BAD_REQUEST, "Invalid channel ID.");
                }
                match channel_projection(&config)
                    .into_iter()
                    .find(|c| c["id"] == json!(id))
                {
                    Some(channel) => reply(
                        StatusCode::OK,
                        &json!({ "channel": channel, "revision": rev }),
                        &[tag],
                    ),
                    None => err(StatusCode::NOT_FOUND, "Channel not found."),
                }
            }
        }
    }
}

fn percent_decode(text: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(text.len());
    let raw = text.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            let hex = std::str::from_utf8(raw.get(i + 1..i + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

pub async fn serve(options: Options) -> Result<(), String> {
    if !options.public_origin.is_empty() {
        let parsed = url::Url::parse(&options.public_origin).map_err(|e| e.to_string())?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.origin().ascii_serialization() != options.public_origin
        {
            return Err("XFEEDER_DASHBOARD_PUBLIC_ORIGIN must be an exact http(s) origin without a path or trailing slash.".into());
        }
    }
    let auth = Auth::new(
        &options.public_origin,
        &options.host,
        options.password.clone(),
        options.session_ttl_hours,
    )?;
    let addr: SocketAddr = format!(
        "{}:{}",
        if options.host.contains(':') {
            format!("[{}]", options.host)
        } else {
            options.host.clone()
        },
        options.port
    )
    .parse()
    .map_err(|e| format!("Invalid dashboard address: {e}"))?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Cannot bind {addr}: {e}"))?;
    let port = listener.local_addr().map_or(options.port, |a| a.port());
    let server = Arc::new(Server {
        host: options.host.clone(),
        port,
        public_origin: options.public_origin,
        paths: Paths {
            config: options.data_dir.join("config.json"),
            env: options.data_dir.join(".env"),
            cache: options.data_dir.join("cache.json"),
        },
        auth,
        worker: tokio::sync::Mutex::new(Worker {
            child: None,
            busy: false,
        }),
    });
    println!(
        "[Dashboard] XFeeder dashboard running at http://{}:{port} ({})",
        options.host,
        if server.auth.required() {
            "password"
        } else {
            "local-open"
        }
    );
    let app = axum::Router::new().fallback(move |request: Request<Body>| {
        let server = server.clone();
        async move { server.handle(request).await }
    });
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = crate::shutdown_signal().await;
        })
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_replacement() {
        let updated = replace_secret("A=1\nB = old\n", "B", "new").unwrap();
        assert_eq!(updated, "A=1\nB = new\n");
        assert_eq!(replace_secret("A=1\n", "C", "x").unwrap(), "A=1\nC=x\n");
        assert!(replace_secret("", "C", "bad\nvalue").is_err());
        assert!(
            reserved_secret("PATH")
                && reserved_secret("XFEEDER_DASHBOARD_PASSWORD")
                && !reserved_secret("DISCORD_TOKEN")
        );
    }

    fn test_server(dir: &Path, password: &str) -> Arc<Server> {
        Arc::new(Server {
            host: "127.0.0.1".into(),
            port: 3000,
            public_origin: String::new(),
            paths: Paths {
                config: dir.join("config.json"),
                env: dir.join(".env"),
                cache: dir.join("cache.json"),
            },
            auth: Auth::new("", "127.0.0.1", password.into(), None).unwrap(),
            worker: tokio::sync::Mutex::new(Worker {
                child: None,
                busy: false,
            }),
        })
    }

    async fn call(
        server: &Arc<Server>,
        method: Method,
        path: &str,
        body: &str,
        extra: &[(&str, &str)],
    ) -> (StatusCode, HeaderMap, String) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(
                header::HOST,
                extra
                    .iter()
                    .find(|(k, _)| *k == "host")
                    .map_or("127.0.0.1:3000", |(_, v)| *v),
            )
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
        for (k, v) in extra.iter().filter(|(k, _)| *k != "host") {
            builder = builder.header(*k, *v);
        }
        let response = server
            .clone()
            .handle(builder.body(Body::from(body.to_string())).unwrap())
            .await;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), MAX_BODY).await.unwrap();
        (
            status,
            headers,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    #[tokio::test]
    async fn html_ui_end_to_end() {
        let dir = std::env::temp_dir().join(format!("xfeeder-ui-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let config = "{\r\n  \"Settings\": {},\r\n  \"channels\": [\r\n    {\r\n      \"Webhook\": \"${HOOK}\",\r\n      \"RSS\": [\"https://a.example/feed\"]\r\n    }\r\n  ]\r\n}\r\n";
        std::fs::write(dir.join("config.json"), config).unwrap();
        std::fs::write(
            dir.join(".env"),
            "HOOK=https://discord.com/api/webhooks/1/S3cr3tXYZ\n",
        )
        .unwrap();
        let server = test_server(&dir, "pw");
        let origin = [("origin", "http://127.0.0.1:3000")];

        // Unauthenticated pages redirect to the login form; assets are public.
        let (status, headers, _) = call(&server, Method::GET, "/channels", "", &[]).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(headers[header::LOCATION], "/login");
        let (status, headers, _) = call(&server, Method::GET, "/styles.css", "", &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            headers["content-security-policy"]
                .to_str()
                .unwrap()
                .starts_with("default-src 'none'")
        );

        // Cross-site and header-less posts are refused.
        let (status, _, _) = call(
            &server,
            Method::POST,
            "/login",
            "password=pw",
            &[("origin", "https://evil.example")],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = call(&server, Method::POST, "/login", "password=pw", &[]).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, body) =
            call(&server, Method::POST, "/login", "password=bad", &origin).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("Invalid dashboard password"));
        // Origin: null (privacy mode) is accepted with Sec-Fetch-Site.
        let (status, headers, _) = call(
            &server,
            Method::POST,
            "/login",
            "password=pw",
            &[("origin", "null"), ("sec-fetch-site", "same-origin")],
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        let cookie = headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let auth = [
            ("cookie", cookie.as_str()),
            ("origin", "http://127.0.0.1:3000"),
        ];

        for page in [
            "/",
            "/channels",
            "/activity",
            "/diagnostics",
            "/settings",
            "/advanced",
            "/channels/edit?group=channels&key=0",
            "/posts",
            "/feed?url=https%3A%2F%2Fa.example%2Ffeed",
        ] {
            let (status, _, body) = call(&server, Method::GET, page, "", &auth).await;
            assert_eq!(status, StatusCode::OK, "{page}");
            assert!(!body.contains("<script"), "{page}");
        }
        let (_, _, body) = call(&server, Method::GET, "/settings", "", &auth).await;
        assert!(
            body.contains("HOOK") && !body.contains("S3cr3tXYZ"),
            "secret values are never rendered"
        );

        // Through an SSH tunnel on another local port: loopback names only.
        let tunnel = [
            ("cookie", auth[0].1),
            ("host", "localhost:3930"),
            ("origin", "http://localhost:3930"),
        ];
        let (status, _, _) = call(&server, Method::GET, "/", "", &tunnel).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = call(&server, Method::POST, "/lang", "to=pl", &tunnel).await;
        assert_ne!(status, StatusCode::FORBIDDEN);
        for (host, origin) in [
            ("evil.example:3930", "http://evil.example:3930"),
            (
                "127.0.0.1.evil.example:3000",
                "http://127.0.0.1.evil.example:3000",
            ),
            ("localhost:3930", "http://localhost:3931"),
        ] {
            let (status, _, _) = call(
                &server,
                Method::POST,
                "/settings/general",
                "rev=x",
                &[("cookie", auth[0].1), ("host", host), ("origin", origin)],
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{host} {origin}");
        }

        // .env in Advanced: reserved lines stay hidden and untouched.
        std::fs::write(
            dir.join(".env"),
            "HOOK=https://discord.com/api/webhooks/1/S3cr3tXYZ\nXFEEDER_DASHBOARD_PASSWORD=pw\n",
        )
        .unwrap();
        let (_, _, body) = call(&server, Method::GET, "/advanced", "", &auth).await;
        assert!(body.contains("HOOK=") && !body.contains("XFEEDER_DASHBOARD_PASSWORD=pw"));
        let env_rev = revision(&std::fs::read_to_string(dir.join(".env")).unwrap());
        let (status, _, body) = call(
            &server,
            Method::POST,
            "/advanced/env",
            &format!("env_rev={env_rev}&env=XFEEDER_DASHBOARD_PASSWORD%3Dx"),
            &auth,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body.contains("reserved"));
        let (status, _, body) = call(
            &server,
            Method::POST,
            "/advanced/env",
            &format!("env_rev={env_rev}&env=not+a+line"),
            &auth,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        let (status, _, _) = call(
            &server,
            Method::POST,
            "/advanced/env",
            &format!("env_rev={env_rev}&env=HOOK%3Dhttps%3A%2F%2Fdiscord.com%2Fapi%2Fwebhooks%2F1%2FS3cr3tXYZ%0D%0A%23+note%0D%0ANEW_ONE%3D1"),
            &auth,
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(
            std::fs::read_to_string(dir.join(".env")).unwrap(),
            "HOOK=https://discord.com/api/webhooks/1/S3cr3tXYZ\n# note\nNEW_ONE=1\n\nXFEEDER_DASHBOARD_PASSWORD=pw\n"
        );
        assert!(
            !std::fs::read_to_string(dir.join(".env.bak"))
                .unwrap()
                .contains("NEW_ONE")
        );

        // Saved clearances: listed without the cookie, forgotten one by one.
        std::fs::write(
            dir.join("clearance.json"),
            r#"{"boop.pl":{"userAgent":"UA","cookie":"cf_clearance=S3cr3tCookie","expires":0,"savedAt":1},"x.example":{"userAgent":"UA","cookie":"c=1","expires":0,"savedAt":1}}"#,
        )
        .unwrap();
        let (_, _, body) = call(&server, Method::GET, "/settings", "", &auth).await;
        assert!(body.contains("boop.pl") && !body.contains("S3cr3tCookie"));
        let (status, _, _) = call(
            &server,
            Method::POST,
            "/settings/clearance-forget",
            "host=boop.pl",
            &auth,
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        let left = crate::clearance::list(&dir.join("clearance.json"));
        assert_eq!(left.keys().collect::<Vec<_>>(), ["x.example"]);
        call(
            &server,
            Method::POST,
            "/settings/clearance-forget",
            "host=%2A",
            &auth,
        )
        .await;
        assert!(crate::clearance::list(&dir.join("clearance.json")).is_empty());

        // Every page renders in Polish too.
        let polish = format!("{}; xf_lang=pl", auth[0].1);
        for page in [
            "/",
            "/channels",
            "/activity",
            "/settings",
            "/channels/edit?group=channels&key=0",
        ] {
            let (status, _, body) = call(
                &server,
                Method::GET,
                page,
                "",
                &[("cookie", polish.as_str())],
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{page}");
            assert!(
                body.starts_with("<!doctype html><html lang=\"pl\">"),
                "{page}"
            );
        }

        // Edit a channel: interval + second source, keeping CRLF line endings.
        let key_before = crate::config::load(&dir.join("config.json"))
            .unwrap()
            .channels[0]
            .cache_key
            .clone();
        let original = std::fs::read_to_string(dir.join("config.json")).unwrap();
        let rev = revision(&original);
        let form = format!(
            "rev={rev}&orig_group=channels&orig_key=0&group=channels&name=&webhook=%24%7BHOOK%7D&thread=&sources=https%3A%2F%2Fa.example%2Ffeed%0D%0Ahttps%3A%2F%2Fb.example%2Frss&time_checker=10&request_send=&first_run_send=&include=&exclude=&fields=&max_age=&extra="
        );
        let (status, headers, body) =
            call(&server, Method::POST, "/channels/save", &form, &auth).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        assert!(headers[header::LOCATION].to_str().unwrap().contains("ok="));
        let written = std::fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(
            written.contains("\r\n")
                && written.contains("https://b.example/rss")
                && written.contains("\"TimeChecker\": 10")
        );
        // The list channel keeps its delivery history: the old key is pinned.
        assert!(
            written.contains(&format!("\"CacheKey\": \"{key_before}\"")),
            "{written}"
        );
        assert_eq!(
            crate::config::load(&dir.join("config.json"))
                .unwrap()
                .channels[0]
                .cache_key,
            key_before
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("config.json.bak")).unwrap(),
            original
        );
        // The same (now stale) revision is rejected.
        let (status, _, body) = call(&server, Method::POST, "/channels/save", &form, &auth).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("changed on disk"));

        // Feature switches: on with values, then off keeping the values.
        let rev = revision(&written);
        let (status, _, body) = call(
            &server,
            Method::POST,
            "/settings/features",
            &format!("rev={rev}&adaptive=on&adaptive_min=4&adaptive_burst=&adaptive_divisor=8&merge=on&merge_hours=2.5&reuse_clearance=on&tg_token=&tg_chat=&tg_thread=&tg_timeout="),
            &auth,
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(
            saved["Settings"]["AdaptivePolling"],
            json!({ "Enabled": true, "MinMinutes": 4, "Divisor": 8 })
        );
        assert_eq!(
            saved["Settings"]["SteamMerge"],
            json!({ "Enabled": true, "WindowHours": 2.5 })
        );
        assert_eq!(saved["Scrapling"]["ReuseClearance"], json!(true));
        assert!(
            saved.get("Telegram").is_none(),
            "Telegram not added when off"
        );
        let rev = revision(&std::fs::read_to_string(dir.join("config.json")).unwrap());
        let (status, _, _) = call(
            &server,
            Method::POST,
            "/settings/features",
            &format!("rev={rev}&adaptive_min=4&adaptive_burst=&adaptive_divisor=8&merge_hours=2.5&tg_token=&tg_chat=&tg_thread=&tg_timeout="),
            &auth,
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(
            saved["Settings"]["AdaptivePolling"]["Enabled"],
            json!(false)
        );
        assert_eq!(saved["Settings"]["AdaptivePolling"]["MinMinutes"], json!(4));
        assert!(crate::adaptive::from_config(&json!({}), &saved).is_none());
        assert!(crate::steam_merge::from_config(&saved).is_none());
        assert_eq!(saved["Scrapling"]["ReuseClearance"], json!(false));
        let written = std::fs::read_to_string(dir.join("config.json")).unwrap();

        // Advanced editor rejects invalid JSON without touching the file.
        let rev = revision(&written);
        let (status, _, body) = call(
            &server,
            Method::POST,
            "/advanced",
            &format!("rev={rev}&config=%7Bnope"),
            &auth,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body.contains("Invalid JSON"));
        assert_eq!(
            std::fs::read_to_string(dir.join("config.json")).unwrap(),
            written
        );

        // Delete it.
        let (status, _, _) = call(
            &server,
            Method::POST,
            "/channels/delete",
            &format!("rev={rev}&group=channels&key=0"),
            &auth,
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(after["channels"], json!([]));

        // Log out ends the session.
        let (status, _, _) = call(&server, Method::POST, "/logout", "", &auth).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        let (status, _, _) = call(&server, Method::GET, "/", "", &auth).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
