//! Always-on diagnostics recorder (`Settings.Diagnostics`).
//!
//! Every structured event (the `--debug-expert` events plus the extra
//! latency/timing events) and every log line is appended, already redacted,
//! to `<dir>/events-YYYY-MM-DD.txt` (one JSON object per line, UTC dates). A
//! background thread keeps per-day aggregates and rewrites
//! `<dir>/summary-YYYY-MM-DD.md` every `SummaryMinutes` with latency
//! percentiles per feed/channel and hints on what dominates the delay from
//! publication to Discord.
//!
//! Recording never blocks the worker: events go through a bounded queue and
//! are dropped (and counted) if the writer falls behind.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};

use crate::js;

const QUEUE: usize = 50_000;
const MAX_SAMPLES: usize = 20_000;
/// Entries first seen more than this after publication are backlog (first
/// run, long outage), not polling latency; they are reported separately.
const STALE_MS: f64 = 24.0 * 3_600_000.0;

#[derive(Clone, Debug)]
pub struct Options {
    pub dir: PathBuf,
    pub retention_days: u64,
    pub max_file_bytes: u64,
    pub summary_every: Duration,
}

impl Options {
    /// `Settings.Diagnostics`: `true` or `{ Enabled, Dir, RetentionDays,
    /// MaxFileMB, SummaryMinutes }`; `XFEEDER_DIAGNOSTICS=1` also enables it.
    pub fn from_settings(settings: &Value, base: &Path, env_on: bool) -> Option<Self> {
        let raw = js::get(settings, "Diagnostics");
        let enabled = match raw {
            Value::Bool(b) => *b,
            Value::Object(_) => js::get(raw, "Enabled") != &Value::Bool(false),
            _ => false,
        } || env_on;
        if !enabled {
            return None;
        }
        let dir = js::trimmed_str(js::get(raw, "Dir")).map_or_else(
            || base.join("diagnostics"),
            |d| {
                let p = PathBuf::from(d);
                if p.is_absolute() { p } else { base.join(p) }
            },
        );
        let num = |key: &str, default: u64, min: u64, max: u64| {
            js::get(raw, key)
                .as_u64()
                .unwrap_or(default)
                .clamp(min, max)
        };
        Some(Self {
            dir,
            retention_days: num("RetentionDays", 14, 1, 365),
            // 0 = no limit (old days are still removed after RetentionDays).
            max_file_bytes: match num("MaxFileMB", 256, 0, 10_240) {
                0 => u64::MAX,
                mb => mb * 1024 * 1024,
            },
            summary_every: Duration::from_secs(num("SummaryMinutes", 15, 1, 1440) * 60),
        })
    }
}

struct Record {
    at: DateTime<Utc>,
    event: String,
    payload: Value,
    flush: bool,
}

struct Recorder {
    tx: SyncSender<Record>,
    dropped: AtomicU64,
}

static RECORDER: OnceLock<Recorder> = OnceLock::new();

pub fn enabled() -> bool {
    RECORDER.get().is_some()
}

/// Start the writer thread (once per process).
pub fn init(options: Options) -> Result<(), String> {
    fs::create_dir_all(&options.dir)
        .map_err(|e| format!("cannot create {}: {e}", options.dir.display()))?;
    let (tx, rx) = mpsc::sync_channel(QUEUE);
    if RECORDER
        .set(Recorder {
            tx,
            dropped: AtomicU64::new(0),
        })
        .is_err()
    {
        return Ok(());
    }
    let dir = options.dir.clone();
    std::thread::Builder::new()
        .name("xfeeder-diagnostics".into())
        .spawn(move || Writer::new(options).run(&rx))
        .map_err(|e| format!("cannot start diagnostics thread: {e}"))?;
    install_panic_hook();
    crate::info!("Diagnostics", "Recording to {}", dir.display());
    record(
        "diagnostics.started",
        json!({ "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION") }),
    );
    Ok(())
}

/// Record an event; `payload` must already be redacted.
pub fn record(event: &str, payload: Value) {
    push(event, payload, false);
}

fn push(event: &str, payload: Value, flush: bool) {
    let Some(recorder) = RECORDER.get() else {
        return;
    };
    let record = Record {
        at: Utc::now(),
        event: event.to_string(),
        payload,
        flush,
    };
    if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) = recorder.tx.try_send(record)
    {
        recorder.dropped.fetch_add(1, Ordering::Relaxed);
    }
}

/// Ask the writer to flush (shutdown); waits briefly.
pub fn flush() {
    if enabled() {
        push("diagnostics.flush", json!({}), true);
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        push(
            "panic",
            json!({ "message": crate::diag::sanitize_text(&message), "location": location,
                    "thread": std::thread::current().name().unwrap_or("?") }),
            true,
        );
        std::thread::sleep(Duration::from_millis(300));
        previous(info);
    }));
}

/// Periodic process/host sample (call from a tokio task).
pub fn sample_process() {
    if !enabled() {
        return;
    }
    let mut payload = Map::new();
    let pid = std::process::id();
    if let Some((rss, threads)) = proc_status(pid) {
        payload.insert("rssKb".into(), json!(rss));
        payload.insert("threads".into(), json!(threads));
    }
    if let Some((user, system)) = proc_cpu_ms(pid) {
        payload.insert("cpuUserMs".into(), json!(user));
        payload.insert("cpuSysMs".into(), json!(system));
    }
    if let Ok(entries) = fs::read_dir("/proc/self/fd") {
        payload.insert("fds".into(), json!(entries.count()));
    }
    let (children, children_rss, children_pss) = descendants_memory(pid);
    payload.insert("childProcesses".into(), json!(children));
    payload.insert("childRssKb".into(), json!(children_rss));
    payload.insert("childPssKb".into(), json!(children_pss));
    if let Ok(load) = fs::read_to_string("/proc/loadavg")
        && let Some(first) = load.split_whitespace().next()
    {
        payload.insert("load1".into(), json!(first.parse::<f64>().unwrap_or(0.0)));
    }
    if let Some(recorder) = RECORDER.get() {
        payload.insert(
            "droppedEvents".into(),
            json!(recorder.dropped.load(Ordering::Relaxed)),
        );
    }
    record("process.sample", Value::Object(payload));
}

fn proc_status(pid: u32) -> Option<(u64, u64)> {
    let text = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let field = |name: &str| {
        text.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
    };
    Some((field("VmRSS:")?, field("Threads:").unwrap_or(0)))
}

fn proc_stat(pid: u32) -> Option<Vec<String>> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name may contain spaces; fields start after ") ".
    let rest = &text[text.rfind(')')? + 2..];
    Some(rest.split_whitespace().map(str::to_string).collect())
}

fn proc_cpu_ms(pid: u32) -> Option<(u64, u64)> {
    let fields = proc_stat(pid)?;
    // utime/stime are fields 14/15 (index 11/12 after the comm field).
    let ticks = 100.0; // USER_HZ on Linux
    let user = fields.get(11)?.parse::<f64>().ok()?;
    let system = fields.get(12)?.parse::<f64>().ok()?;
    Some((
        (user / ticks * 1000.0) as u64,
        (system / ticks * 1000.0) as u64,
    ))
}

/// Proportional set size: shared pages are split between the processes
/// using them, so the PSS of a process tree adds up correctly (RSS does not).
fn proc_pss(pid: u32) -> Option<u64> {
    fs::read_to_string(format!("/proc/{pid}/smaps_rollup"))
        .ok()?
        .lines()
        .find(|l| l.starts_with("Pss:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// Number, summed RSS and summed PSS of all descendant processes
/// (Scrapling/Chromium). Summed RSS counts shared memory once per process.
fn descendants_memory(root: u32) -> (u64, u64, u64) {
    let Ok(entries) = fs::read_dir("/proc") else {
        return (0, 0, 0);
    };
    let mut parent: HashMap<u32, u32> = HashMap::new();
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if let Some(ppid) = proc_stat(pid)
            .and_then(|f| f.get(1).cloned())
            .and_then(|p| p.parse::<u32>().ok())
        {
            parent.insert(pid, ppid);
        }
    }
    let mut count = 0;
    let mut rss = 0;
    let mut pss = 0;
    for &pid in parent.keys() {
        let mut current = pid;
        let mut depth = 0;
        while let Some(&up) = parent.get(&current) {
            if up == root {
                count += 1;
                let own = proc_status(pid).map_or(0, |(r, _)| r);
                rss += own;
                pss += proc_pss(pid).unwrap_or(own);
                break;
            }
            current = up;
            depth += 1;
            if depth > 64 || up <= 1 {
                break;
            }
        }
    }
    (count, rss, pss)
}

// ------------------------------------------------------------------ writer --

struct Writer {
    options: Options,
    day: String,
    file: Option<BufWriter<File>>,
    written: u64,
    capped: bool,
    agg: Aggregates,
    last_summary: Instant,
    started: DateTime<Utc>,
}

impl Writer {
    fn new(options: Options) -> Self {
        Self {
            options,
            day: String::new(),
            file: None,
            written: 0,
            capped: false,
            agg: Aggregates::default(),
            last_summary: Instant::now(),
            started: Utc::now(),
        }
    }

    fn run(mut self, rx: &Receiver<Record>) {
        loop {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(record) => {
                    let mut flush = record.flush;
                    self.handle(record);
                    // Drain what is queued before flushing.
                    while let Ok(next) = rx.try_recv() {
                        flush |= next.flush;
                        self.handle(next);
                    }
                    if flush {
                        self.flush_file();
                        self.write_summary();
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.flush_file();
                    self.write_summary();
                    return;
                }
            }
            self.flush_file();
            if self.last_summary.elapsed() >= self.options.summary_every {
                self.write_summary();
            }
        }
    }

    fn handle(&mut self, record: Record) {
        let day = record.at.format("%Y-%m-%d").to_string();
        if day != self.day {
            if !self.day.is_empty() {
                self.write_summary();
            }
            self.rotate(&day);
        }
        self.agg.observe(&record);
        if self.capped {
            return;
        }
        let mut line = Map::new();
        line.insert(
            "t".into(),
            json!(
                record
                    .at
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            ),
        );
        line.insert("e".into(), json!(record.event));
        if let Value::Object(map) = record.payload {
            for (key, value) in map {
                if key != "t" && key != "e" {
                    line.insert(key, value);
                }
            }
        }
        let mut text = Value::Object(line).to_string();
        text.push('\n');
        if self.written + text.len() as u64 > self.options.max_file_bytes {
            self.capped = true;
            text = format!(
                "{}\n",
                json!({ "t": record.at.to_rfc3339(), "e": "diagnostics.capped",
                        "message": "MaxFileMB reached; further events today are only aggregated" })
            );
        }
        if let Some(file) = self.file.as_mut()
            && file.write_all(text.as_bytes()).is_ok()
        {
            self.written += text.len() as u64;
        }
    }

    fn flush_file(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
    }

    fn rotate(&mut self, day: &str) {
        self.flush_file();
        self.day = day.to_string();
        self.agg = Aggregates::default();
        self.capped = false;
        let path = self.options.dir.join(format!("events-{day}.txt"));
        self.written = fs::metadata(&path).map_or(0, |m| m.len());
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()
            .map(BufWriter::new);
        self.cleanup();
    }

    fn cleanup(&self) {
        let cutoff = Utc::now() - chrono::Duration::days(self.options.retention_days as i64);
        let cutoff = cutoff.format("%Y-%m-%d").to_string();
        let Ok(entries) = fs::read_dir(&self.options.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let day = name
                .strip_prefix("events-")
                .or_else(|| name.strip_prefix("summary-"))
                .and_then(|rest| rest.get(..10));
            if let Some(day) = day
                && day < cutoff.as_str()
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    fn write_summary(&mut self) {
        self.last_summary = Instant::now();
        if self.day.is_empty() {
            return;
        }
        let dropped = RECORDER
            .get()
            .map_or(0, |r| r.dropped.load(Ordering::Relaxed));
        let text = self
            .agg
            .render(&self.day, self.started, dropped, self.capped);
        let path = self.options.dir.join(format!("summary-{}.md", self.day));
        let tmp = path.with_extension("md.tmp");
        if fs::write(&tmp, text).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

// -------------------------------------------------------------- aggregates --

#[derive(Default)]
struct Samples(Vec<f64>);

impl Samples {
    fn push(&mut self, value: f64) {
        if value.is_finite() {
            if self.0.len() >= MAX_SAMPLES {
                self.0.remove(0);
            }
            self.0.push(value);
        }
    }
    fn stats(&self) -> Option<Stats> {
        if self.0.is_empty() {
            return None;
        }
        let mut sorted = self.0.clone();
        sorted.sort_by(f64::total_cmp);
        let pick = |q: f64| sorted[((sorted.len() - 1) as f64 * q).round() as usize];
        Some(Stats {
            n: sorted.len(),
            p50: pick(0.5),
            p90: pick(0.9),
            p99: pick(0.99),
            max: *sorted.last().unwrap_or(&0.0),
            mean: sorted.iter().sum::<f64>() / sorted.len() as f64,
        })
    }
}

struct Stats {
    n: usize,
    p50: f64,
    p90: f64,
    p99: f64,
    max: f64,
    mean: f64,
}

#[derive(Default)]
struct FeedAgg {
    fetch_ms: Samples,
    ok: u64,
    not_modified: u64,
    failed: u64,
    scrapling: u64,
    bytes: Samples,
    parse_ms: Samples,
    publish_to_seen: Samples,
    stale_seen: u64,
    median_gap_ms: Option<f64>,
    newest_age_ms: Option<f64>,
    cache_control: Option<String>,
    validators: Option<bool>,
}

#[derive(Default)]
struct ChannelAgg {
    runs: u64,
    run_ms: Samples,
    late_ms: Samples,
    interval_min: Option<f64>,
    publish_to_sent: Samples,
    seen_to_sent: Samples,
    sent: u64,
    stale_sent: u64,
}

#[derive(Default)]
struct Aggregates {
    events: BTreeMap<String, u64>,
    feeds: BTreeMap<String, FeedAgg>,
    channels: BTreeMap<String, ChannelAgg>,
    hosts_ttfb: BTreeMap<String, Samples>,
    hosts_body: BTreeMap<String, Samples>,
    http_queue: Samples,
    send_ms: Samples,
    send_failed: u64,
    rate_limited: u64,
    rate_wait_ms: Samples,
    scrapling: BTreeMap<String, Samples>,
    scrapling_blocked: u64,
    scrapling_failed: u64,
    rss_kb: Samples,
    child_rss_kb: Samples,
    cpu: Option<(DateTime<Utc>, u64, DateTime<Utc>, u64)>,
    anomalies: BTreeMap<String, (u64, Vec<String>)>,
    logs: BTreeMap<String, (u64, String)>,
    panics: Vec<String>,
    publish_to_sent: Samples,
}

fn num(payload: &Value, key: &str) -> Option<f64> {
    payload.get(key).and_then(Value::as_f64)
}

fn text(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .map(js::to_string_or_empty)
        .unwrap_or_default()
}

impl Aggregates {
    fn feed(&mut self, payload: &Value) -> &mut FeedAgg {
        self.feeds.entry(text(payload, "url")).or_default()
    }
    fn channel(&mut self, payload: &Value) -> &mut ChannelAgg {
        self.channels.entry(text(payload, "channel")).or_default()
    }

    fn observe(&mut self, record: &Record) {
        let p = &record.payload;
        *self.events.entry(record.event.clone()).or_default() += 1;
        match record.event.as_str() {
            "feed.download.complete" => {
                let f = self.feed(p);
                if let Some(ms) = num(p, "elapsedMs") {
                    f.fetch_ms.push(ms);
                }
                if p.get("notModified") == Some(&Value::Bool(true)) {
                    f.not_modified += 1;
                } else if p.get("ok") == Some(&Value::Bool(true)) {
                    f.ok += 1;
                    if let Some(b) = num(p, "bodyBytes") {
                        f.bytes.push(b);
                    }
                } else {
                    f.failed += 1;
                }
                if p.get("scrapling") == Some(&Value::Bool(true)) {
                    f.scrapling += 1;
                }
                if let Some(cc) = p.get("cacheControl").and_then(Value::as_str)
                    && !cc.is_empty()
                {
                    f.cache_control = Some(cc.to_string());
                }
                if let Some(v) = p.get("hasValidators").and_then(Value::as_bool) {
                    f.validators = Some(v);
                }
            }
            "feed.parsed" => {
                if let Some(ms) = num(p, "parseMs") {
                    self.feed(p).parse_ms.push(ms);
                }
            }
            "feed.freshness" => {
                let f = self.feed(p);
                f.median_gap_ms = num(p, "medianGapMs").or(f.median_gap_ms);
                f.newest_age_ms = num(p, "newestAgeMs").or(f.newest_age_ms);
            }
            "latency.entry" => {
                let seen = num(p, "publishToSeenMs");
                let stale = seen.is_some_and(|ms| ms > STALE_MS);
                if let Some(ms) = seen {
                    let f = self.feed(p);
                    if stale {
                        f.stale_seen += 1;
                    } else {
                        f.publish_to_seen.push(ms);
                    }
                }
                let total = num(p, "publishToSentMs");
                let queue = num(p, "seenToSentMs");
                let c = self.channel(p);
                c.sent += 1;
                if stale {
                    c.stale_sent += 1;
                } else if let Some(ms) = total {
                    c.publish_to_sent.push(ms);
                }
                if let Some(ms) = queue {
                    c.seen_to_sent.push(ms);
                }
                if !stale && let Some(ms) = total {
                    self.publish_to_sent.push(ms);
                }
            }
            "queue.channel.selected" => {
                let c = self.channel(p);
                c.runs += 1;
                if let Some(ms) = num(p, "lateMs") {
                    c.late_ms.push(ms);
                }
                c.interval_min = num(p, "intervalMin").or(c.interval_min);
            }
            "channel.process.complete" => {
                if let Some(ms) = num(p, "durationMs") {
                    self.channel(p).run_ms.push(ms);
                }
            }
            "http.timing" => {
                let host = text(p, "host");
                if let Some(ms) = num(p, "ttfbMs") {
                    self.hosts_ttfb.entry(host.clone()).or_default().push(ms);
                }
                if let Some(ms) = num(p, "bodyMs") {
                    self.hosts_body.entry(host).or_default().push(ms);
                }
                if let Some(ms) = num(p, "queueMs") {
                    self.http_queue.push(ms);
                }
            }
            "delivery.complete" => {
                if let Some(ms) = num(p, "durationMs") {
                    self.send_ms.push(ms);
                }
            }
            "delivery.failed" => self.send_failed += 1,
            "discord.rate_limited" => {
                self.rate_limited += 1;
                if let Some(ms) = num(p, "waitMs") {
                    self.rate_wait_ms.push(ms);
                }
            }
            "scrapling.attempt.complete" => {
                if let Some(ms) = num(p, "durationMs") {
                    self.scrapling.entry(text(p, "mode")).or_default().push(ms);
                }
            }
            "scrapling.attempt.blocked" => self.scrapling_blocked += 1,
            "scrapling.attempt.failed" => self.scrapling_failed += 1,
            "process.sample" => {
                if let Some(kb) = num(p, "rssKb") {
                    self.rss_kb.push(kb);
                }
                if let Some(kb) = num(p, "childPssKb").or_else(|| num(p, "childRssKb")) {
                    self.child_rss_kb.push(kb);
                }
                if let (Some(u), Some(s)) = (num(p, "cpuUserMs"), num(p, "cpuSysMs")) {
                    let cpu = (u + s) as u64;
                    self.cpu = Some(match self.cpu {
                        Some((t0, c0, _, _)) => (t0, c0, record.at, cpu),
                        None => (record.at, cpu, record.at, cpu),
                    });
                }
            }
            "anomaly" => {
                let entry = self.anomalies.entry(text(p, "kind")).or_default();
                entry.0 += 1;
                if entry.1.len() < 5 {
                    let mut example = p.clone();
                    if let Value::Object(map) = &mut example {
                        map.remove("kind");
                    }
                    entry
                        .1
                        .push(example.to_string().chars().take(300).collect());
                }
            }
            "log" => {
                let level = text(p, "level");
                if level == "warn" || level == "error" {
                    let message = text(p, "message");
                    // Group by scope + message prefix (numbers vary).
                    let key: String = format!("{level} [{}] {message}", text(p, "scope"))
                        .chars()
                        .filter(|c| !c.is_ascii_digit())
                        .take(140)
                        .collect();
                    let entry = self.logs.entry(key).or_insert((0, String::new()));
                    entry.0 += 1;
                    entry.1 = message.chars().take(300).collect();
                }
            }
            "panic" => {
                self.panics
                    .push(format!("{} at {}", text(p, "message"), text(p, "location")))
            }
            _ => {}
        }
    }

    #[allow(clippy::too_many_lines)]
    fn render(&self, day: &str, started: DateTime<Utc>, dropped: u64, capped: bool) -> String {
        let mut out = String::new();
        let ms = |v: f64| -> String {
            if v >= 3_600_000.0 {
                format!("{:.1} h", v / 3_600_000.0)
            } else if v >= 60_000.0 {
                format!("{:.1} min", v / 60_000.0)
            } else if v >= 1000.0 {
                format!("{:.1} s", v / 1000.0)
            } else {
                format!("{v:.0} ms")
            }
        };
        let row = |s: Option<Stats>| -> String {
            s.map_or_else(
                || "– | – | – | – | 0".to_string(),
                |s| {
                    format!(
                        "{} | {} | {} | {} | {}",
                        ms(s.p50),
                        ms(s.p90),
                        ms(s.p99),
                        ms(s.max),
                        s.n
                    )
                },
            )
        };
        let _ = writeln!(out, "# XFeeder diagnostics — {day} (UTC)\n");
        let _ = writeln!(
            out,
            "Generated {} · recorder running since {} · events today: {} · dropped: {dropped}{}\n",
            Utc::now().format("%Y-%m-%d %H:%M:%S UTC"),
            started.format("%Y-%m-%d %H:%M UTC"),
            self.events.values().sum::<u64>(),
            if capped {
                " · **file size cap reached (events still aggregated)**"
            } else {
                ""
            }
        );

        let _ = writeln!(out, "## End-to-end latency (publication → Discord)\n");
        let _ = writeln!(
            out,
            "Only entries first seen less than 24 h after publication; older ones (first run, outages) are counted as backlog.\n"
        );
        let _ = writeln!(
            out,
            "| Scope | p50 | p90 | p99 | max | n |\n|---|---|---|---|---|---|"
        );
        let _ = writeln!(
            out,
            "| **All channels** | {} |",
            row(self.publish_to_sent.stats())
        );
        for (name, c) in &self.channels {
            if c.sent > 0 {
                let _ = writeln!(out, "| {name} | {} |", row(c.publish_to_sent.stats()));
            }
        }
        let _ = writeln!(out);

        let _ = writeln!(out, "### Where the time goes\n");
        let detect = self
            .feeds
            .values()
            .flat_map(|f| f.publish_to_seen.0.iter().copied())
            .fold(Samples::default(), |mut s, v| {
                s.push(v);
                s
            });
        let queue = self
            .channels
            .values()
            .flat_map(|c| c.seen_to_sent.0.iter().copied())
            .fold(Samples::default(), |mut s, v| {
                s.push(v);
                s
            });
        let _ = writeln!(
            out,
            "| Stage | p50 | p90 | p99 | max | n |\n|---|---|---|---|---|---|"
        );
        let _ = writeln!(
            out,
            "| Detection (published → first fetched by XFeeder) | {} |",
            row(detect.stats())
        );
        let _ = writeln!(
            out,
            "| Queue (first fetched → sent) | {} |",
            row(queue.stats())
        );
        let _ = writeln!(
            out,
            "| Discord send (HTTP) | {} |",
            row(self.send_ms.stats())
        );
        let _ = writeln!(
            out,
            "| Discord 429 waits | {} |",
            row(self.rate_wait_ms.stats())
        );
        let _ = writeln!(
            out,
            "| HTTP connection-pool/permit wait | {} |\n",
            row(self.http_queue.stats())
        );

        let _ = writeln!(out, "## Hints\n");
        let hints = self.hints(&detect, &queue);
        if hints.is_empty() {
            let _ = writeln!(out, "- Not enough data yet.\n");
        } else {
            for hint in hints {
                let _ = writeln!(out, "- {hint}");
            }
            let _ = writeln!(out);
        }

        let _ = writeln!(out, "## Channels\n");
        let _ = writeln!(
            out,
            "| Channel | interval | runs | run p50 | run p90 | scheduler late p90 | sent | backlog sent | queue p90 |\n|---|---|---|---|---|---|---|---|---|"
        );
        for (name, c) in &self.channels {
            let run = c.run_ms.stats();
            let late = c.late_ms.stats();
            let q = c.seen_to_sent.stats();
            let _ = writeln!(
                out,
                "| {name} | {} | {} | {} | {} | {} | {} | {} | {} |",
                c.interval_min.map_or("–".into(), |m| format!("{m:.0} min")),
                c.runs,
                run.as_ref().map_or("–".into(), |s| ms(s.p50)),
                run.as_ref().map_or("–".into(), |s| ms(s.p90)),
                late.as_ref().map_or("–".into(), |s| ms(s.p90)),
                c.sent,
                c.stale_sent,
                q.as_ref().map_or("–".into(), |s| ms(s.p90)),
            );
        }
        let _ = writeln!(out);

        let _ = writeln!(out, "## Feeds\n");
        let _ = writeln!(
            out,
            "| Feed | fetch p50 | fetch p90 | ok | 304 | failed | browser | avg KB | parse p50 | detect p50 | publishes every (median) | newest entry age | Cache-Control | ETag/Last-Modified |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
        );
        for (url, f) in &self.feeds {
            let fetch = f.fetch_ms.stats();
            let _ = writeln!(
                out,
                "| {url} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
                fetch.as_ref().map_or("–".into(), |s| ms(s.p50)),
                fetch.as_ref().map_or("–".into(), |s| ms(s.p90)),
                f.ok,
                f.not_modified,
                f.failed,
                f.scrapling,
                f.bytes
                    .stats()
                    .map_or("–".into(), |s| format!("{:.0}", s.mean / 1024.0)),
                f.parse_ms.stats().map_or("–".into(), |s| ms(s.p50)),
                f.publish_to_seen.stats().map_or("–".into(), |s| ms(s.p50)),
                f.median_gap_ms.map_or("–".into(), ms),
                f.newest_age_ms.map_or("–".into(), ms),
                f.cache_control
                    .clone()
                    .unwrap_or_else(|| "–".into())
                    .replace('|', "/"),
                f.validators.map_or("–", |v| if v { "yes" } else { "no" }),
            );
        }
        let _ = writeln!(out);

        let _ = writeln!(out, "## HTTP by host\n");
        let _ = writeln!(
            out,
            "| Host | time to first byte p50 | p90 | body download p50 | p90 | requests |\n|---|---|---|---|---|---|"
        );
        for (host, ttfb) in &self.hosts_ttfb {
            let t = ttfb.stats();
            let b = self.hosts_body.get(host).and_then(Samples::stats);
            let _ = writeln!(
                out,
                "| {host} | {} | {} | {} | {} | {} |",
                t.as_ref().map_or("–".into(), |s| ms(s.p50)),
                t.as_ref().map_or("–".into(), |s| ms(s.p90)),
                b.as_ref().map_or("–".into(), |s| ms(s.p50)),
                b.as_ref().map_or("–".into(), |s| ms(s.p90)),
                t.as_ref().map_or(0, |s| s.n),
            );
        }
        let _ = writeln!(out);

        let _ = writeln!(out, "## Discord\n");
        let _ = writeln!(
            out,
            "- Sends: {} (failed {}), send p50 {}, p90 {}\n- Rate limited (429): {} times, waited p50 {}, total {}\n",
            self.send_ms.0.len(),
            self.send_failed,
            self.send_ms.stats().map_or("–".into(), |s| ms(s.p50)),
            self.send_ms.stats().map_or("–".into(), |s| ms(s.p90)),
            self.rate_limited,
            self.rate_wait_ms.stats().map_or("–".into(), |s| ms(s.p50)),
            if self.rate_wait_ms.0.is_empty() {
                "–".to_string()
            } else {
                ms(self.rate_wait_ms.0.iter().sum())
            },
        );

        let _ = writeln!(out, "## Browser (Scrapling)\n");
        if self.scrapling.is_empty() {
            let _ = writeln!(out, "- No browser fetches.\n");
        } else {
            for (mode, s) in &self.scrapling {
                if let Some(s) = s.stats() {
                    let _ = writeln!(
                        out,
                        "- `{mode}`: {} fetches, p50 {}, p90 {}, max {}",
                        s.n,
                        ms(s.p50),
                        ms(s.p90),
                        ms(s.max)
                    );
                }
            }
            let _ = writeln!(
                out,
                "- blocked attempts: {}, failed attempts: {}\n",
                self.scrapling_blocked, self.scrapling_failed
            );
        }

        let _ = writeln!(out, "## Resources\n");
        let cpu = self.cpu.and_then(|(t0, c0, t1, c1)| {
            let wall = (t1 - t0).num_milliseconds();
            (wall > 0).then(|| (c1.saturating_sub(c0)) as f64 / wall as f64 * 100.0)
        });
        let _ = writeln!(
            out,
            "- XFeeder RSS: p50 {} MB, max {} MB\n- Child processes (Scrapling/Chromium), PSS: p50 {} MB, max {} MB\n- Average CPU of XFeeder today: {}\n",
            self.rss_kb
                .stats()
                .map_or("–".into(), |s| format!("{:.1}", s.p50 / 1024.0)),
            self.rss_kb
                .stats()
                .map_or("–".into(), |s| format!("{:.1}", s.max / 1024.0)),
            self.child_rss_kb
                .stats()
                .map_or("–".into(), |s| format!("{:.0}", s.p50 / 1024.0)),
            self.child_rss_kb
                .stats()
                .map_or("–".into(), |s| format!("{:.0}", s.max / 1024.0)),
            cpu.map_or("–".into(), |c| format!("{c:.2} %")),
        );

        let _ = writeln!(out, "## Anomalies\n");
        if self.anomalies.is_empty() && self.panics.is_empty() {
            let _ = writeln!(out, "- None.\n");
        } else {
            for panic in &self.panics {
                let _ = writeln!(out, "- **panic**: {panic}");
            }
            for (kind, (count, examples)) in &self.anomalies {
                let _ = writeln!(out, "- `{kind}` × {count}");
                for example in examples {
                    let _ = writeln!(out, "  - `{}`", example.replace('`', "'"));
                }
            }
            let _ = writeln!(out);
        }

        let _ = writeln!(out, "## Warnings and errors\n");
        if self.logs.is_empty() {
            let _ = writeln!(out, "- None.\n");
        } else {
            let mut logs: Vec<_> = self.logs.iter().collect();
            logs.sort_by_key(|entry| std::cmp::Reverse(entry.1.0));
            for (_, (count, last)) in logs.into_iter().take(25) {
                let _ = writeln!(out, "- × {count}: {}", last.replace('|', "/"));
            }
            let _ = writeln!(out);
        }

        let _ = writeln!(out, "## Event counts\n");
        for (event, count) in &self.events {
            let _ = writeln!(out, "- `{event}`: {count}");
        }
        out
    }

    fn hints(&self, detect: &Samples, queue: &Samples) -> Vec<String> {
        let mut hints = Vec::new();
        let (Some(d), q) = (detect.stats(), queue.stats()) else {
            return hints;
        };
        let q50 = q.as_ref().map_or(0.0, |s| s.p50);
        let share = d.p50 / (d.p50 + q50).max(1.0) * 100.0;
        hints.push(format!(
            "Detection is {share:.0}% of the median delay (p50 {:.1} min). It is driven by `TimeChecker`: an entry waits on average half an interval before the next check.",
            d.p50 / 60_000.0
        ));
        for (name, c) in &self.channels {
            if let (Some(interval), Some(seen)) = (c.interval_min, c.publish_to_sent.stats())
                && interval >= 10.0
            {
                hints.push(format!(
                    "{name}: interval {interval:.0} min, median publication → Discord {:.1} min. Lowering `TimeChecker` reduces this roughly to half the new interval.",
                    seen.p50 / 60_000.0
                ));
            }
        }
        for (url, f) in &self.feeds {
            let total = f.ok + f.not_modified;
            if total >= 3 && f.not_modified * 2 >= total {
                hints.push(format!(
                    "{url} answers 304 Not Modified to {:.0}% of checks: polling it more often is cheap.",
                    f.not_modified as f64 / total as f64 * 100.0
                ));
            }
            if f.validators == Some(false) && f.ok >= 3 {
                hints.push(format!(
                    "{url} sends no ETag/Last-Modified: every check downloads the whole feed."
                ));
            }
            if let Some(s) = f.fetch_ms.stats()
                && s.p50 > 10_000.0
            {
                hints.push(format!(
                    "{url} takes {:.1} s per fetch (p50){}; it delays the rest of its channel.",
                    s.p50 / 1000.0,
                    if f.scrapling > 0 {
                        " through the browser"
                    } else {
                        ""
                    }
                ));
            }
        }
        if self.rate_limited > 0 {
            hints.push(format!(
                "Discord rate-limited {} sends (total wait {:.1} s); all channels share one webhook, so bursts queue behind each other.",
                self.rate_limited,
                self.rate_wait_ms.0.iter().sum::<f64>() / 1000.0
            ));
        }
        if let Some(q) = q
            && q.p90 > 60_000.0
        {
            hints.push(format!(
                "Queue p90 is {:.1} min: entries wait for `RequestSend` limits, backoff or 429s after being fetched.",
                q.p90 / 60_000.0
            ));
        }
        hints
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(event: &str, payload: Value) -> Record {
        Record {
            at: Utc::now(),
            event: event.into(),
            payload,
            flush: false,
        }
    }

    #[test]
    fn options() {
        let base = Path::new("/data");
        assert!(Options::from_settings(&json!({}), base, false).is_none());
        let on = Options::from_settings(&json!({ "Diagnostics": true }), base, false).unwrap();
        assert_eq!(on.dir, PathBuf::from("/data/diagnostics"));
        assert_eq!(on.summary_every, Duration::from_secs(900));
        let custom = Options::from_settings(
            &json!({ "Diagnostics": { "Dir": "/var/x", "SummaryMinutes": 5, "MaxFileMB": 1 } }),
            base,
            false,
        )
        .unwrap();
        assert_eq!(custom.dir, PathBuf::from("/var/x"));
        assert_eq!(custom.max_file_bytes, 1024 * 1024);
        let unlimited = Options::from_settings(
            &json!({ "Diagnostics": { "Dir": "/var/x", "MaxFileMB": 0 } }),
            base,
            false,
        )
        .unwrap();
        assert_eq!(unlimited.max_file_bytes, u64::MAX);
        assert!(
            Options::from_settings(&json!({ "Diagnostics": { "Enabled": false } }), base, false)
                .is_none()
        );
        assert!(Options::from_settings(&json!({}), base, true).is_some());
    }

    #[test]
    fn aggregates_and_summary() {
        let mut agg = Aggregates::default();
        for i in 0..10 {
            agg.observe(&rec("feed.download.complete", json!({ "url": "https://a/feed", "ok": true, "elapsedMs": 100 + i * 10, "bodyBytes": 2048, "notModified": i % 2 == 0, "hasValidators": true })));
            agg.observe(&rec("latency.entry", json!({ "url": "https://a/feed", "channel": "news", "publishToSeenMs": 600_000 + i * 1000, "seenToSentMs": 2000, "publishToSentMs": 602_000 + i * 1000 })));
        }
        agg.observe(&rec("latency.entry", json!({ "url": "https://a/feed", "channel": "news", "publishToSeenMs": 3.0 * STALE_MS, "seenToSentMs": 1000, "publishToSentMs": 3.0 * STALE_MS })));
        agg.observe(&rec(
            "queue.channel.selected",
            json!({ "channel": "news", "lateMs": 1200, "intervalMin": 60 }),
        ));
        agg.observe(&rec(
            "anomaly",
            json!({ "kind": "entry.undated", "url": "https://a/feed" }),
        ));
        agg.observe(&rec(
            "log",
            json!({ "level": "warn", "scope": "HTTP", "message": "Request failed 403" }),
        ));
        let md = agg.render("2026-11-17", Utc::now(), 0, false);
        assert!(md.contains("| **All channels** | 10.1 min"), "{md}");
        assert!(md.contains("| news | 60 min | 1 |"), "{md}");
        assert!(md.contains("`entry.undated` × 1"));
        assert!(md.contains("× 1: Request failed 403"));
        assert!(md.contains("answers 304 Not Modified"));
        assert_eq!(agg.channels["news"].stale_sent, 1);
    }

    #[test]
    fn writer_rotates_and_summarises() {
        let dir = std::env::temp_dir().join(format!("xfeeder-diag-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut writer = Writer::new(Options {
            dir: dir.clone(),
            retention_days: 14,
            max_file_bytes: 10_000,
            summary_every: Duration::from_secs(900),
        });
        for i in 0..200 {
            writer.handle(rec(
                "http.timing",
                json!({ "host": "a", "ttfbMs": i, "bodyMs": 1 }),
            ));
        }
        writer.flush_file();
        writer.write_summary();
        let day = Utc::now().format("%Y-%m-%d").to_string();
        let events = fs::read_to_string(dir.join(format!("events-{day}.txt"))).unwrap();
        assert!(
            events
                .lines()
                .next()
                .unwrap()
                .contains("\"e\":\"http.timing\"")
        );
        assert!(
            events.contains("diagnostics.capped"),
            "size cap is enforced"
        );
        assert!(events.len() < 10_200);
        let summary = fs::read_to_string(dir.join(format!("summary-{day}.md"))).unwrap();
        assert!(summary.contains("| a | 100 ms"), "{summary}");
        let _ = fs::remove_dir_all(&dir);
    }
}
