//! Bounded, sanitized activity events and metrics. The worker publishes a
//! snapshot every two seconds next to the config file; the dashboard (a
//! separate process) only reads these files.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::http::net;

const CAPACITY: usize = 2000;
const BUCKETS: [u64; 5] = [100, 500, 1000, 5000, 30000];
pub const COUNTERS: [&str; 5] = [
    "feed_fetch_total",
    "feed_fetch_error_total",
    "feed_not_modified_total",
    "items_parsed_total",
    "scrapling_fallback_total",
];
pub const DURATIONS: [&str; 3] = [
    "feed_fetch_duration_ms",
    "channel_run_duration_ms",
    "delivery_duration_ms",
];

static ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct Series {
    count: u64,
    sum: u64,
    min: Option<u64>,
    max: Option<u64>,
    buckets: [u64; 6],
}

#[derive(Default)]
struct State {
    events: VecDeque<Value>,
    sequence: u64,
    counters: [u64; 5],
    delivery: [[u64; 2]; 2],
    durations: [Series; 3],
    failing: HashSet<String>,
    active_jobs: u64,
    due_channels: u64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

pub fn enable() {
    ENABLED.store(true, Ordering::Relaxed);
    *STATE.lock().expect("lock") = Some(State::default());
}

fn pseudonym(value: &Value) -> Value {
    match value.as_str().filter(|s| !s.is_empty()) {
        Some(text) => json!(hex::encode(Sha256::digest(text.as_bytes()))[..16].to_string()),
        None => Value::Null,
    }
}

fn mapped(name: &str, details: &Value) -> Option<&'static str> {
    if name == "feed.download.complete" && details.get("ok") == Some(&Value::Bool(false)) {
        return Some("feed.failed");
    }
    Some(match name {
        "app.start" => "worker.started",
        "app.shutdown" => "worker.stopped",
        "queue.channel.selected" | "channel.process.begin" => "channel.started",
        "queue.channel.complete" | "channel.process.complete" => "channel.completed",
        "queue.channel.failed" => "channel.failed",
        "channel.feed.failed" => "feed.processing.failed",
        "feed.begin" => "feed.fetch.started",
        "feed.download.complete" => "feed.fetch.completed",
        "feed.not_modified" => "feed.not_modified",
        "feed.parsed" => "feed.parse.completed",
        "delivery.complete" => "delivery.sent",
        "delivery.failed" => "delivery.failed",
        "scrapling.attempt.begin" => "scrapling.used",
        "config.loaded" => "config.reloaded",
        "retry.scheduled" => "retry.scheduled",
        _ => return None,
    })
}

fn observe_duration(series: &mut Series, value: Option<u64>) {
    let Some(ms) = value else { return };
    let ms = ms.min(86_400_000);
    series.count += 1;
    series.sum += ms;
    series.min = Some(series.min.map_or(ms, |m| m.min(ms)));
    series.max = Some(series.max.map_or(ms, |m| m.max(ms)));
    let index = BUCKETS.iter().position(|b| ms <= *b).unwrap_or(5);
    series.buckets[index] += 1;
}

/// Called for every expert diagnostic; never fails, never blocks delivery.
pub fn observe(name: &str, details: &Value) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(kind) = mapped(name, details) else {
        return;
    };
    let mut guard = STATE.lock().expect("lock");
    let Some(state) = guard.as_mut() else { return };
    state.sequence += 1;
    let duration = details
        .get("durationMs")
        .or_else(|| details.get("elapsedMs"))
        .and_then(Value::as_u64);
    let target = details
        .get("target")
        .and_then(Value::as_str)
        .filter(|t| matches!(*t, "webhook" | "telegram"));
    let status = details
        .get("status")
        .and_then(Value::as_u64)
        .filter(|s| (100..=599).contains(s));
    let source = pseudonym(
        details
            .get("url")
            .or_else(|| details.get("source"))
            .unwrap_or(&Value::Null),
    );
    let origin = if name.starts_with("queue.channel.") {
        "queue"
    } else if name.starts_with("channel.") {
        "channel"
    } else {
        ""
    };
    let level = if kind.ends_with(".failed") {
        "error"
    } else if kind == "scrapling.used" {
        "warn"
    } else {
        "info"
    };
    let event = json!({
        "id": state.sequence,
        "time": crate::text::now_iso(),
        "level": level,
        "type": kind,
        "channelId": pseudonym(details.get("channel").unwrap_or(&Value::Null)),
        "sourceId": source,
        "destination": target,
        "durationMs": duration,
        "httpStatus": status,
        "itemCount": details.get("itemCount").and_then(Value::as_u64),
        "errorCode": details.get("error").and_then(|e| e.get("code")).and_then(Value::as_str).filter(|c| c.len() <= 48 && c.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b'-')),
        "dryRun": details.get("dryRun") == Some(&Value::Bool(true)),
        "origin": if origin.is_empty() { Value::Null } else { json!(origin) },
    });
    if state.events.len() >= CAPACITY {
        state.events.pop_front();
    }
    state.events.push_back(event);
    let source_id = source.as_str().map(str::to_string);
    match kind {
        "feed.fetch.completed" => {
            state.counters[0] += 1;
            observe_duration(&mut state.durations[0], duration);
            if let Some(id) = source_id {
                state.failing.remove(&id);
            }
        }
        "feed.failed" => {
            state.counters[0] += 1;
            state.counters[1] += 1;
            observe_duration(&mut state.durations[0], duration);
            if let Some(id) = source_id
                && state.failing.len() < 256
            {
                state.failing.insert(id);
            }
        }
        "feed.not_modified" => state.counters[2] += 1,
        "feed.parse.completed" => {
            state.counters[3] += details
                .get("itemCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        }
        "scrapling.used" => state.counters[4] += 1,
        "delivery.sent" | "delivery.failed" => {
            if let Some(target) = target {
                let index = usize::from(target == "telegram");
                state.delivery[index][usize::from(kind == "delivery.failed")] += 1;
            }
            observe_duration(&mut state.durations[2], duration);
        }
        "channel.completed" | "channel.failed" if origin != "queue" => {
            observe_duration(&mut state.durations[1], duration)
        }
        _ => {}
    }
}

pub fn set_gauges(active_jobs: u64, due_channels: u64) {
    if let Some(state) = STATE.lock().expect("lock").as_mut() {
        state.active_jobs = active_jobs;
        state.due_channels = due_channels;
    }
}

pub fn network_metrics(stopping: bool) -> Value {
    let net = net();
    let config = net.config();
    let (down, up) = net.rates();
    let load = |a: &std::sync::atomic::AtomicU64| a.load(Ordering::Relaxed);
    json!({
        "downloadedBytes": load(&net.downloaded),
        "uploadedBytes": load(&net.uploaded),
        "unshapedUploadBytes": load(&net.uploaded),
        "downloadBytesPerSecond": down,
        "uploadBytesPerSecond": up,
        "rateWindowSeconds": 5,
        "activeHttpRequests": load(&net.active_http),
        "waitingHttpRequests": load(&net.waiting_http),
        "activeScraplingTasks": load(&net.active_scrapling),
        "waitingScraplingTasks": load(&net.waiting_scrapling),
        "waitingDownload": 0,
        "waitingUpload": 0,
        "profile": config.bandwidth_profile,
        "downloadLimitBytesPerSecond": config.download_bytes_per_second,
        "uploadLimitBytesPerSecond": config.upload_bytes_per_second,
        "friendlyMode": config.network_friendly_mode,
        "policy": { "httpConcurrency": config.http_concurrency(), "scraplingConcurrency": config.scrapling_concurrency() },
        "scraplingBytes": { "status": "unavailable", "downloadedBytes": null, "uploadedBytes": null },
        "accounting": "decoded HTTP body bytes read / request body bytes sent; excludes headers, TLS and redirects",
        "uploadEnforcement": "uploads are not shaped",
        "stopping": stopping,
    })
}

pub fn metrics_snapshot() -> Value {
    let guard = STATE.lock().expect("lock");
    let Some(state) = guard.as_ref() else {
        return Value::Null;
    };
    let mut counters: Map<String, Value> = COUNTERS
        .iter()
        .zip(state.counters)
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    counters.insert(
        "delivery_total".into(),
        json!({
            "webhook": { "success": state.delivery[0][0], "error": state.delivery[0][1] },
            "telegram": { "success": state.delivery[1][0], "error": state.delivery[1][1] },
        }),
    );
    let durations: Map<String, Value> = DURATIONS
        .iter()
        .zip(&state.durations)
        .map(|(name, s)| {
            let mut buckets: Map<String, Value> = BUCKETS.iter().zip(s.buckets).map(|(b, c)| (b.to_string(), json!(c))).collect();
            buckets.insert("+Inf".into(), json!(s.buckets[5]));
            (name.to_string(), json!({ "count": s.count, "sum": s.sum, "min": s.min, "max": s.max, "buckets": buckets }))
        })
        .collect();
    let mut network = network_metrics(false);
    network["available"] = json!(true);
    json!({
        "counters": counters,
        "gauges": { "active_jobs": state.active_jobs, "failing_feeds": state.failing.len(), "queue_due_channels": state.due_channels },
        "network": network,
        "durations": durations,
    })
}

fn events() -> Vec<Value> {
    STATE
        .lock()
        .expect("lock")
        .as_ref()
        .map(|s| s.events.iter().cloned().collect())
        .unwrap_or_default()
}

pub fn runtime_path(config_path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.network-runtime.json",
        crate::config::absolute(config_path).display()
    ))
}

pub fn activity_path(config_path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.activity-runtime.json",
        crate::config::absolute(config_path).display()
    ))
}

pub fn network_signature(config: &crate::config::NetworkConfig) -> String {
    let text = serde_json::to_string(config).unwrap_or_default();
    hex::encode(Sha256::digest(
        hex::encode(Sha256::digest(text.as_bytes())).as_bytes(),
    ))
}

pub struct Publisher {
    pub config_path: PathBuf,
    pub worker_id: String,
}

impl Publisher {
    pub fn publish(&self, ready: bool, stopping: bool) {
        let config = net().config();
        let snapshot = json!({
            "schemaVersion": 1,
            "workerId": self.worker_id,
            "pid": std::process::id(),
            "updatedAt": crate::text::now_iso(),
            "configSignature": network_signature(&config),
            "workerReady": ready,
            "metrics": network_metrics(stopping),
        });
        let _ = crate::state::write_atomic(
            &runtime_path(&self.config_path),
            snapshot.to_string().as_bytes(),
            0o600,
        );
        let activity = json!({ "schemaVersion": 1, "updatedAt": crate::text::now_iso(), "events": events(), "metrics": metrics_snapshot() });
        let payload = activity.to_string();
        if payload.len() <= 2 * 1024 * 1024 {
            let _ = crate::state::write_atomic(
                &activity_path(&self.config_path),
                payload.as_bytes(),
                0o600,
            );
        }
    }

    /// Remove our runtime record (only if it is still ours).
    pub fn retire(&self) {
        let path = runtime_path(&self.config_path);
        let ours = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .is_some_and(|v| v["workerId"] == json!(self.worker_id));
        if ours {
            let _ = std::fs::remove_file(path);
        }
    }
}
