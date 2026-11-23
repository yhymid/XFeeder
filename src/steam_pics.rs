//! Steam builds and branches straight from Steam (PICS): `steampics://APPID`.
//!
//! SteamDB's History tab shows what Steam's product info (PICS) says about an
//! app: the `public` build, beta and version branches, depot sizes. SteamDB
//! forbids scraping that page, and its patch notes RSS is `Disallow`ed in
//! robots.txt, so XFeeder asks Steam itself with anonymous SteamCMD:
//!
//! ```text
//! steamcmd +login anonymous +app_info_update 1 +app_info_print 730 … +quit
//! ```
//!
//! One SteamCMD run covers every `steampics://` URL of the config (about 9 s
//! for 10 apps) and runs at most once per `MinIntervalMinutes`. Each run is
//! compared with the previous one and turns into entries:
//!
//! - a new `public` build (`Build`): links to SteamDB's patch notes page, the
//!   same link as SteamDB's RSS, so switching from that RSS reposts nothing;
//! - a branch that appears or disappears (`Branch added` / `Branch removed`),
//!   such as CS2's `1.42.0.0` version pins;
//! - a new build on another branch (`Branch build`).
//!
//! The first run gives one entry, the current public build: the channel's
//! first check marks it as seen (or sends it with `FirstRunSend`), so the next
//! real change is sent. Branches matching
//! `IgnoreBranches` (default `^dprp?$`, Valve's internal ones) are skipped.
//! An AppID Steam does not know gives no data, never "removed".
//!
//! Some apps show anonymous Steam only `common` (Deadlock, Risk of Rain 2):
//! no depots, no branches, so no entries; their change number still moves and
//! is logged.
//!
//! Every change of an app's change number, noise included, is appended to
//! `steam_pics.changes.jsonl` next to `cache.json` (`RawLog`, on by default),
//! so a test channel collects the whole picture.
//!
//! ```json
//! "Settings": { "SteamPics": { "Command": "/usr/games/steamcmd",
//!   "MinIntervalMinutes": 10, "TimeoutSeconds": 180,
//!   "IgnoreBranches": "^dprp?$", "RawLog": true } }
//! ```
//! All keys are optional. `Command` defaults to `/usr/games/steamcmd` when it
//! exists (Debian/Ubuntu package), otherwise `steamcmd` from `PATH`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::js;

pub const SCHEME: &str = "steampics://";
const EVENTS_KEPT: usize = 20;
const RAW_LOG_MAX_BYTES: u64 = 20 * 1024 * 1024;
const RAW_CHANGES_MAX: usize = 5000;
const DEFAULT_IGNORE: &str = "^dprp?$";

/// The AppID of a `steampics://APPID` URL.
pub fn appid(url: &str) -> Option<u32> {
    let head = url.get(..SCHEME.len())?;
    if !head.eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    let rest = url[SCHEME.len()..].trim_end_matches('/');
    if rest.is_empty() || rest.len() > 10 || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok().filter(|n| *n > 0)
}

pub fn is_url(url: &str) -> bool {
    appid(url).is_some()
}

// ---------------------------------------------------------------- settings

struct Settings {
    command: String,
    min_interval: Duration,
    timeout: Duration,
    ignore: Option<Regex>,
    raw_log: bool,
}

fn settings(root: &Value) -> Settings {
    let section = js::get(js::get(root, "Settings"), "SteamPics");
    let number = |key: &str, default: f64, min: f64, max: f64| {
        section
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map_or(default, |n| n.clamp(min, max))
    };
    let command = js::trimmed_str(js::get(section, "Command"))
        .map(str::to_string)
        .unwrap_or_else(|| {
            if Path::new("/usr/games/steamcmd").exists() {
                "/usr/games/steamcmd".into()
            } else {
                "steamcmd".into()
            }
        });
    let pattern = match section.get("IgnoreBranches") {
        Some(Value::String(p)) => p.clone(),
        Some(Value::Null) | None => DEFAULT_IGNORE.into(),
        Some(_) => String::new(),
    };
    let ignore = if pattern.is_empty() {
        None
    } else {
        match Regex::new(&pattern) {
            Ok(re) => Some(re),
            Err(error) => {
                crate::warn!(
                    "SteamPics",
                    "IgnoreBranches is not a valid regex ({error}); using {DEFAULT_IGNORE}"
                );
                Regex::new(DEFAULT_IGNORE).ok()
            }
        }
    };
    Settings {
        command,
        min_interval: Duration::from_secs_f64(
            number("MinIntervalMinutes", 10.0, 1.0, 1440.0) * 60.0,
        ),
        timeout: Duration::from_secs_f64(number("TimeoutSeconds", 180.0, 10.0, 900.0)),
        ignore,
        raw_log: section.get("RawLog") != Some(&Value::Bool(false)),
    }
}

/// Every `steampics://` AppID in the config, in order of first appearance.
fn configured(root: &Value, out: &mut BTreeSet<u32>) {
    match root {
        Value::String(text) => {
            if let Some(id) = appid(text.trim()) {
                out.insert(id);
            }
        }
        Value::Array(items) => items.iter().for_each(|v| configured(v, out)),
        Value::Object(map) => map.values().for_each(|v| configured(v, out)),
        _ => {}
    }
}

// ------------------------------------------------------------------ parser

/// One app from `app_info_print`.
#[derive(Debug, Clone, PartialEq)]
pub struct App {
    pub appid: u32,
    pub change: u64,
    /// Steam knows the app (an unknown AppID prints an empty `{ }` dated 1970).
    pub known: bool,
    pub flat: BTreeMap<String, String>,
}

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap());
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^AppID : (\d+), change number : (\d+)/\d+, last change : ([^\r\n]*)").unwrap()
});

enum Token {
    Str(String),
    Open,
    Close,
}

fn tokens(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '{' => out.push(Token::Open),
            '}' => out.push(Token::Close),
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(other) => s.push(other),
                            None => s.push('\\'),
                        },
                        _ => s.push(c),
                    }
                }
                out.push(Token::Str(s));
            }
            _ => {}
        }
    }
    out
}

/// Flattens the first `"key" { … }` block of `text` into `a/b/c → value`.
fn flatten_vdf(text: &str) -> BTreeMap<String, String> {
    let mut flat = BTreeMap::new();
    let mut path: Vec<String> = Vec::new();
    let mut pending: Option<String> = None;
    let mut started = false;
    for token in tokens(text) {
        match token {
            Token::Str(s) => match pending.take() {
                Some(key) if started => {
                    let mut full = path.join("/");
                    if !full.is_empty() {
                        full.push('/');
                    }
                    full.push_str(&key);
                    flat.insert(full, s);
                }
                _ => pending = Some(s),
            },
            Token::Open => {
                let key = pending.take().unwrap_or_default();
                if started {
                    path.push(key);
                } else {
                    started = true;
                }
            }
            Token::Close => {
                if path.pop().is_none() {
                    break;
                }
            }
        }
    }
    flat
}

/// All apps in SteamCMD's output, ANSI colour codes ignored.
pub fn parse_output(text: &str) -> Vec<App> {
    let clean = ANSI.replace_all(text, "");
    let heads: Vec<_> = HEADER.captures_iter(&clean).collect();
    heads
        .iter()
        .enumerate()
        .filter_map(|(i, caps)| {
            let start = caps.get(0)?.end();
            let end = heads
                .get(i + 1)
                .and_then(|next| next.get(0))
                .map_or(clean.len(), |m| m.start());
            let flat = flatten_vdf(&clean[start..end]);
            let dated = !caps[3].contains(" 1970");
            Some(App {
                appid: caps[1].parse().ok()?,
                change: caps[2].parse().ok()?,
                known: dated && !flat.is_empty(),
                flat,
            })
        })
        .collect()
}

// ------------------------------------------------------------------- model

#[derive(Debug, Clone, PartialEq, Default)]
struct Branch {
    buildid: String,
    description: String,
    updated: i64,
}

fn branches(flat: &BTreeMap<String, String>) -> BTreeMap<String, Branch> {
    let mut out: BTreeMap<String, Branch> = BTreeMap::new();
    for (key, value) in flat.range("depots/branches/".to_string()..) {
        let Some(rest) = key.strip_prefix("depots/branches/") else {
            break;
        };
        let Some((name, field)) = rest.split_once('/') else {
            continue;
        };
        let branch = out.entry(name.to_string()).or_default();
        match field {
            "buildid" => branch.buildid = value.clone(),
            "description" => branch.description = value.trim().to_string(),
            "timeupdated" => branch.updated = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    out.retain(|_, b| !b.buildid.is_empty());
    out
}

/// Sum of the `public` manifest sizes of all depots, in bytes.
fn public_size(flat: &BTreeMap<String, String>) -> Option<u64> {
    let mut total = None;
    for (key, value) in flat {
        let Some(rest) = key.strip_prefix("depots/") else {
            continue;
        };
        let mut parts = rest.split('/');
        let (Some(depot), Some("manifests"), Some("public"), Some("size"), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            continue;
        };
        if depot.bytes().all(|b| b.is_ascii_digit())
            && let Ok(size) = value.parse::<u64>()
        {
            total = Some(total.unwrap_or(0) + size);
        }
    }
    total
}

fn app_name(flat: &BTreeMap<String, String>, appid: u32) -> String {
    flat.get("common/name")
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("App {appid}"))
}

/// The store header of the app (the real, possibly hashed path).
fn header_image(flat: &BTreeMap<String, String>, appid: u32) -> Option<String> {
    let file = flat.get("common/header_image/english")?.trim();
    let safe = !file.is_empty()
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'.'))
        && !file.contains("..");
    safe.then(|| {
        format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{appid}/{file}")
    })
}

fn human_delta(delta: i128) -> String {
    let sign = if delta < 0 { "-" } else { "+" };
    let bytes = delta.unsigned_abs() as f64;
    const KIB: f64 = 1024.0;
    let (value, unit) = if bytes >= KIB * KIB * KIB {
        (bytes / (KIB * KIB * KIB), "GiB")
    } else if bytes >= KIB * KIB {
        (bytes / (KIB * KIB), "MiB")
    } else if bytes >= KIB {
        (bytes / KIB, "KiB")
    } else {
        (bytes, "B")
    };
    if unit == "B" {
        format!("{sign}{value} B")
    } else {
        format!("{sign}{value:.2} {unit}")
    }
}

fn iso(seconds: i64) -> Value {
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|d| json!(d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null)
}

fn encode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// What changed between two runs of one app.
#[derive(Debug, Default)]
pub struct Diff {
    /// `(key, old, new)` for every flattened key that changed.
    pub raw: Vec<(String, Option<String>, Option<String>)>,
    /// Feed entries, newest last.
    pub events: Vec<Value>,
}

struct Ctx<'a> {
    appid: u32,
    name: &'a str,
    image: Option<String>,
    change: u64,
    now: i64,
}

impl Ctx<'_> {
    fn entry(
        &self,
        title: String,
        text: String,
        link: String,
        when: i64,
        labels: [&str; 2],
    ) -> Value {
        json!({
            "title": title,
            "link": link,
            "contentSnippet": text,
            "isoDate": iso(if when > 0 { when } else { self.now }),
            "enclosure": self.image.clone().map_or(Value::Null, Value::String),
            "author": Value::Null,
            "guid": link,
            "categories": [labels[0], format!("branch:{}", labels[1]), "SteamPICS"],
        })
    }

    fn history(&self) -> String {
        format!(
            "https://steamdb.info/app/{}/history/?changeid={}",
            self.appid, self.change
        )
    }
}

/// The current public build as an entry: the first run's baseline, so the
/// channel's first check (`FirstRunSend`) has something to mark as seen and
/// the next real change is sent.
fn current_build(
    appid: u32,
    change: u64,
    flat: &BTreeMap<String, String>,
    now: i64,
) -> Option<Value> {
    let public = branches(flat).remove("public")?;
    let name = app_name(flat, appid);
    let ctx = Ctx {
        appid,
        name: &name,
        image: header_image(flat, appid),
        change,
        now,
    };
    Some(ctx.entry(
        format!("{} update (build {})", ctx.name, public.buildid),
        format!(
            "Current public build {}. Steam change #{}: {}",
            public.buildid,
            change,
            ctx.history()
        ),
        format!("https://steamdb.info/patchnotes/{}/", public.buildid),
        public.updated,
        ["Build", "public"],
    ))
}

pub fn diff(
    appid: u32,
    change: u64,
    old: &BTreeMap<String, String>,
    new: &BTreeMap<String, String>,
    ignore: Option<&Regex>,
    now: i64,
) -> Diff {
    let mut out = Diff::default();
    let keys: BTreeSet<&String> = old.keys().chain(new.keys()).collect();
    for key in keys {
        let (a, b) = (old.get(key), new.get(key));
        if a != b {
            out.raw.push((key.clone(), a.cloned(), b.cloned()));
        }
    }
    if out.raw.is_empty() {
        return out;
    }
    let name = app_name(new, appid);
    let ctx = Ctx {
        appid,
        name: &name,
        image: header_image(new, appid),
        change,
        now,
    };
    let (before, after) = (branches(old), branches(new));
    let skip = |b: &str| ignore.is_some_and(|re| re.is_match(b));

    if let (Some(was), Some(now_public)) = (before.get("public"), after.get("public"))
        && was.buildid != now_public.buildid
    {
        let size = match (public_size(old), public_size(new)) {
            (Some(a), Some(b)) if a != b => {
                format!(
                    " Public depots {}.",
                    human_delta(i128::from(b) - i128::from(a))
                )
            }
            _ => String::new(),
        };
        let link = format!("https://steamdb.info/patchnotes/{}/", now_public.buildid);
        out.events.push(ctx.entry(
            format!("{} update (build {})", ctx.name, now_public.buildid),
            format!(
                "New public build {} → {}.{size} Steam change #{}: {}",
                was.buildid,
                now_public.buildid,
                change,
                ctx.history()
            ),
            link,
            now_public.updated,
            ["Build", "public"],
        ));
    }
    for (branch, info) in &after {
        if branch == "public" || skip(branch) {
            continue;
        }
        let link = format!(
            "https://steamdb.info/app/{appid}/depots/?branch={}",
            encode(branch)
        );
        let described = if info.description.is_empty() {
            String::new()
        } else {
            format!(" \"{}\"", info.description)
        };
        let mut entry = match before.get(branch) {
            None => ctx.entry(
                format!("{}: new branch {branch}", ctx.name),
                format!(
                    "Branch {branch}{described} was added with build {}. Steam change #{}: {}",
                    info.buildid,
                    change,
                    ctx.history()
                ),
                link,
                info.updated,
                ["Branch added", branch],
            ),
            Some(was) if was.buildid != info.buildid => ctx.entry(
                format!("{}: branch {branch} build {}", ctx.name, info.buildid),
                format!(
                    "Branch {branch}{described} moved from build {} to {}. Steam change #{}: {}",
                    was.buildid,
                    info.buildid,
                    change,
                    ctx.history()
                ),
                link,
                info.updated,
                ["Branch build", branch],
            ),
            Some(_) => continue,
        };
        entry["identityKey"] = json!(format!("steampics:{appid}:{branch}:{}", info.buildid));
        out.events.push(entry);
    }
    for (branch, info) in &before {
        if branch == "public" || skip(branch) || after.contains_key(branch) {
            continue;
        }
        let described = if info.description.is_empty() {
            String::new()
        } else {
            format!(" \"{}\"", info.description)
        };
        let mut entry = ctx.entry(
            format!("{}: branch {branch} removed", ctx.name),
            format!(
                "Branch {branch}{described} (build {}) was removed. Steam change #{}: {}",
                info.buildid,
                change,
                ctx.history()
            ),
            ctx.history(),
            now,
            ["Branch removed", branch],
        );
        entry["identityKey"] = json!(format!(
            "steampics:{appid}:{branch}:removed:{}",
            info.buildid
        ));
        out.events.push(entry);
    }
    out
}

// ------------------------------------------------------------------ runner

#[derive(Default)]
struct Runner {
    path: Option<PathBuf>,
    apps: Map<String, Value>,
    last_run: Option<Instant>,
    covered: BTreeSet<u32>,
    last_error: Option<String>,
}

static RUNNER: LazyLock<Mutex<Runner>> = LazyLock::new(|| Mutex::new(Runner::default()));

pub fn state_path(base: &Path) -> PathBuf {
    base.join("steam_pics.json")
}

fn raw_log_path(base: &Path) -> PathBuf {
    base.join("steam_pics.changes.jsonl")
}

impl Runner {
    fn load(&mut self, path: &Path) {
        if self.path.as_deref() == Some(path) {
            return;
        }
        let data: Value = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        self.apps = match data.get("apps") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        self.path = Some(path.to_path_buf());
        self.last_run = None;
        self.covered.clear();
        self.last_error = None;
    }

    fn save(&self) -> std::io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let body = serde_json::to_vec(&json!({ "version": 1, "apps": self.apps }))
            .map_err(std::io::Error::other)?;
        crate::state::write_atomic(path, &body, 0o600)
    }

    /// Applies one SteamCMD run; returns the raw-log lines.
    fn apply(&mut self, apps: Vec<App>, ignore: Option<&Regex>, now: i64) -> Vec<Value> {
        let mut log = Vec::new();
        for app in apps.into_iter().filter(|a| a.known) {
            let key = app.appid.to_string();
            let entry = self
                .apps
                .entry(key)
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .map(std::mem::take)
                .unwrap_or_default();
            let old_change = entry.get("change").and_then(Value::as_u64);
            let old_flat: Option<BTreeMap<String, String>> = entry
                .get("flat")
                .and_then(|f| serde_json::from_value(f.clone()).ok());
            let mut events: Vec<Value> = match entry.get("events") {
                Some(Value::Array(list)) => list.clone(),
                _ => Vec::new(),
            };
            if let Some(old) = &old_flat
                && old_change != Some(app.change)
            {
                let d = diff(app.appid, app.change, old, &app.flat, ignore, now);
                // Logged even with no visible change: for apps whose depots
                // anonymous Steam hides (only `common`), a bare change number
                // bump may be the only trace of a new build.
                log.push(json!({
                    "t": iso(now),
                    "appid": app.appid,
                    "name": app_name(&app.flat, app.appid),
                    "changeOld": old_change,
                    "changeNew": app.change,
                    "depotsVisible": app.flat.keys().any(|k| k.starts_with("depots/")),
                    "events": d.events.iter().map(|e| e["categories"][0].clone()).collect::<Vec<_>>(),
                    "changedKeys": d.raw.len(),
                    "changes": d.raw.iter().take(RAW_CHANGES_MAX)
                        .map(|(k, a, b)| json!({ "k": k, "old": a, "new": b }))
                        .collect::<Vec<_>>(),
                }));
                events.extend(d.events);
                if events.len() > EVENTS_KEPT {
                    events.drain(..events.len() - EVENTS_KEPT);
                }
            } else if old_flat.is_none()
                && let Some(baseline) = current_build(app.appid, app.change, &app.flat, now)
            {
                events.push(baseline);
            }
            let slot = self
                .apps
                .get_mut(&app.appid.to_string())
                .expect("inserted above");
            *slot = json!({
                "change": app.change,
                "name": app_name(&app.flat, app.appid),
                "flat": app.flat,
                "events": events,
            });
        }
        log
    }

    fn items(&self, appid: u32) -> Vec<Value> {
        match self
            .apps
            .get(&appid.to_string())
            .and_then(|a| a.get("events"))
        {
            Some(Value::Array(list)) => list.iter().rev().cloned().collect(),
            _ => Vec::new(),
        }
    }
}

fn append_raw_log(path: &Path, lines: &[Value]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    if lines.is_empty() {
        return Ok(());
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > RAW_LOG_MAX_BYTES) {
        let mut old = path.as_os_str().to_owned();
        old.push(".1");
        std::fs::rename(path, PathBuf::from(old))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    let mut out = Vec::new();
    for line in lines {
        serde_json::to_writer(&mut out, line).map_err(std::io::Error::other)?;
        out.push(b'\n');
    }
    file.write_all(&out)
}

enum RunError {
    Cancelled,
    Failed(String),
}

async fn run_steamcmd(
    command: &str,
    apps: &BTreeSet<u32>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<String, RunError> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(["+login", "anonymous", "+app_info_update", "1"]);
    for app in apps {
        cmd.arg("+app_info_print").arg(app.to_string());
    }
    cmd.arg("+quit")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| RunError::Failed(format!("cannot start {command}: {e}")))?;
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(RunError::Cancelled),
        result = tokio::time::timeout(timeout, child.wait_with_output()) => match result {
            Err(_) => return Err(RunError::Failed(format!("SteamCMD did not finish within {} s", timeout.as_secs()))),
            Ok(Err(e)) => return Err(RunError::Failed(format!("SteamCMD failed: {e}"))),
            Ok(Ok(output)) => output,
        },
    };
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if !HEADER.is_match(&ANSI.replace_all(&text, "")) {
        let tail: String = ANSI
            .replace_all(&text, "")
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(RunError::Failed(format!(
            "SteamCMD printed no app info (exit {:?}): {}",
            output.status.code(),
            crate::diag::sanitize_text(&tail)
        )));
    }
    Ok(text)
}

pub struct Fetched {
    pub items: Vec<Value>,
    pub failure: Option<String>,
    pub cancelled: bool,
}

/// Entries of one `steampics://APPID` URL. Runs SteamCMD for every
/// configured AppID when the last run is older than `MinIntervalMinutes`.
pub async fn fetch(
    root: &Value,
    base: &Path,
    url: &str,
    persist: bool,
    cancel: &CancellationToken,
) -> Fetched {
    let Some(id) = appid(url) else {
        return Fetched {
            items: Vec::new(),
            failure: Some(format!("not a steampics://APPID URL: {url}")),
            cancelled: false,
        };
    };
    let cfg = settings(root);
    let mut runner = RUNNER.lock().await;
    runner.load(&state_path(base));
    let stale = runner
        .last_run
        .is_none_or(|at| at.elapsed() >= cfg.min_interval);
    if stale || !runner.covered.contains(&id) {
        let mut wanted = BTreeSet::new();
        configured(root, &mut wanted);
        wanted.insert(id);
        let started = Instant::now();
        match run_steamcmd(&cfg.command, &wanted, cfg.timeout, cancel).await {
            Err(RunError::Cancelled) => {
                return Fetched {
                    items: runner.items(id),
                    failure: None,
                    cancelled: true,
                };
            }
            Err(RunError::Failed(message)) => {
                crate::warn!("SteamPics", "{message}");
                runner.last_error = Some(message);
            }
            Ok(text) => {
                let apps = parse_output(&text);
                let unknown: Vec<u32> = apps.iter().filter(|a| !a.known).map(|a| a.appid).collect();
                let now = chrono::Utc::now().timestamp();
                let log = runner.apply(apps, cfg.ignore.as_ref(), now);
                crate::diag::expert(
                    "steampics.run",
                    json!({ "apps": wanted.len(), "unknown": unknown, "changedApps": log.len(),
                            "elapsedMs": started.elapsed().as_millis() as u64 }),
                );
                if persist {
                    if let Err(error) = runner.save() {
                        crate::warn!(
                            "SteamPics",
                            "cannot save {}: {error}",
                            state_path(base).display()
                        );
                    }
                    if cfg.raw_log
                        && let Err(error) = append_raw_log(&raw_log_path(base), &log)
                    {
                        crate::warn!("SteamPics", "cannot write the change log: {error}");
                    }
                }
                runner.last_error = None;
            }
        }
        runner.last_run = Some(Instant::now());
        runner.covered = wanted;
    }
    let known = runner.apps.contains_key(&id.to_string());
    let failure = runner.last_error.clone().or_else(|| {
        (!known).then(|| format!("Steam has no app info for AppID {id} (wrong AppID?)"))
    });
    Fetched {
        items: runner.items(id),
        failure,
        cancelled: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/steam-pics/app_info_print.txt"
        ))
        .expect("fixture")
    }

    #[test]
    fn recognises_urls() {
        assert_eq!(appid("steampics://730"), Some(730));
        assert_eq!(appid("SteamPICS://1422450/"), Some(1422450));
        assert_eq!(appid("steampics://"), None);
        assert_eq!(appid("steampics://0"), None);
        assert_eq!(appid("steampics://73a"), None);
        assert_eq!(appid("https://steamdb.info/app/730/"), None);
    }

    #[test]
    fn parses_real_steamcmd_output() {
        let apps = parse_output(&fixture());
        let ids: Vec<u32> = apps.iter().map(|a| a.appid).collect();
        assert_eq!(ids, [730, 1675200, 593110, 999999999]);
        let cs2 = &apps[0];
        assert!(cs2.known);
        assert_eq!(cs2.change, 41339555);
        assert_eq!(app_name(&cs2.flat, 730), "Counter-Strike 2");
        let b = branches(&cs2.flat);
        assert_eq!(b["public"].buildid, "26798866");
        assert_eq!(b["csgo_legacy"].description, "Legacy Version of CS:GO");
        assert_eq!(
            b["1.41.2.9"].description,
            "Game version 1.41.2.9 (19-Jan-2026)"
        );
        assert!(b.contains_key("1.42.0.0"));
        assert!(public_size(&cs2.flat).is_some_and(|s| s > 10_000_000_000));
        assert_eq!(
            header_image(&cs2.flat, 730).as_deref(),
            Some(
                "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/730/162664aa5da85f418105350c5d67ca565f6c3713/header.jpg"
            )
        );
        // An AppID Steam does not know: exit 0, empty block, dated 1970.
        assert!(!apps[3].known);
    }

    fn cs2() -> BTreeMap<String, String> {
        parse_output(&fixture()).remove(0).flat
    }

    #[test]
    fn same_state_gives_nothing() {
        let flat = cs2();
        let d = diff(730, 2, &flat, &flat, None, 0);
        assert!(d.raw.is_empty() && d.events.is_empty());
    }

    #[test]
    fn new_public_build_links_like_steamdb_rss() {
        let new = cs2();
        let mut old = new.clone();
        old.insert("depots/branches/public/buildid".into(), "26772654".into());
        old.insert("depots/2347770/manifests/public/size".into(), "1".into());
        let d = diff(730, 41339555, &old, &new, None, 0);
        assert_eq!(d.events.len(), 1);
        let e = &d.events[0];
        assert_eq!(e["title"], "Counter-Strike 2 update (build 26798866)");
        assert_eq!(e["link"], "https://steamdb.info/patchnotes/26798866/");
        assert_eq!(e["categories"][0], "Build");
        let text = e["contentSnippet"].as_str().unwrap();
        assert!(text.contains("26772654 → 26798866"), "{text}");
        assert!(text.contains("Public depots +"), "{text}");
        assert!(text.contains("history/?changeid=41339555"), "{text}");
        // Same identity as SteamDB's RSS item, so switching sources reposts nothing.
        assert_eq!(
            crate::text::entry_identity(e, true),
            crate::text::entry_identity(
                &json!({ "link": "https://steamdb.info/patchnotes/26798866/?utm_source=rss" }),
                true
            )
        );
    }

    #[test]
    fn branches_added_removed_changed_and_ignored() {
        let mut old = cs2();
        let new_ = {
            let mut n = old.clone();
            n.insert("depots/branches/dpr/buildid".into(), "5".into());
            n.insert("depots/branches/1.41.2.9/buildid".into(), "99".into());
            n
        };
        old.retain(|k, _| !k.starts_with("depots/branches/1.42.0.0/"));
        old.insert("depots/branches/1.30.0.0/buildid".into(), "7".into());
        old.insert(
            "depots/branches/1.30.0.0/description".into(),
            "old pin".into(),
        );
        let ignore = Regex::new(DEFAULT_IGNORE).unwrap();
        let d = diff(730, 3, &old, &new_, Some(&ignore), 100);
        let kinds: Vec<(String, String)> = d
            .events
            .iter()
            .map(|e| {
                (
                    e["categories"][0].as_str().unwrap().into(),
                    e["categories"][1].as_str().unwrap().into(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [
                ("Branch build".into(), "branch:1.41.2.9".into()),
                ("Branch added".into(), "branch:1.42.0.0".into()),
                ("Branch removed".into(), "branch:1.30.0.0".into()),
            ]
        );
        assert_eq!(
            d.events[1]["identityKey"],
            "steampics:730:1.42.0.0:26798866"
        );
        assert_eq!(
            d.events[1]["link"],
            "https://steamdb.info/app/730/depots/?branch=1.42.0.0"
        );
        assert!(
            d.events[2]["contentSnippet"]
                .as_str()
                .unwrap()
                .contains("\"old pin\"")
        );
        // The ignored branch still shows up in the raw changes.
        assert!(
            d.raw
                .iter()
                .any(|(k, _, _)| k == "depots/branches/dpr/buildid")
        );
    }

    #[test]
    fn runner_remembers_first_then_reports_and_keeps_unknown_apps_out() {
        let mut runner = Runner::default();
        let apps = parse_output(&fixture());
        assert!(runner.apply(apps.clone(), None, 10).is_empty());
        // First sight: the current build only, as the baseline.
        let base = runner.items(730);
        assert_eq!(base.len(), 1);
        assert_eq!(base[0]["link"], "https://steamdb.info/patchnotes/26798866/");
        assert!(
            base[0]["contentSnippet"]
                .as_str()
                .unwrap()
                .starts_with("Current public build 26798866.")
        );
        assert!(!runner.apps.contains_key("999999999"));

        let mut next = apps;
        next[0].change += 1;
        next[0]
            .flat
            .insert("depots/branches/public/buildid".into(), "26900000".into());
        next[0]
            .flat
            .insert("common/review_percentage".into(), "1".into());
        let log = runner.apply(next.clone(), None, 20);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0]["events"], json!(["Build"]));
        assert_eq!(log[0]["changedKeys"], 2);
        let items = runner.items(730);
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0]["link"],
            "https://steamdb.info/patchnotes/26900000/"
        );
        // Same change number again: nothing new.
        assert!(runner.apply(next.clone(), None, 30).is_empty());
        assert_eq!(runner.items(730).len(), 2);
        // A bare change number bump (hidden depots) is still logged.
        let mut bump = next;
        bump[0].change += 1;
        let log = runner.apply(bump, None, 40);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0]["changedKeys"], 0);
        assert_eq!(log[0]["depotsVisible"], true);
        assert_eq!(runner.items(730).len(), 2);
    }

    #[test]
    fn settings_defaults_and_overrides() {
        let s = settings(&json!({}));
        assert_eq!(s.min_interval, Duration::from_secs(600));
        assert!(s.raw_log);
        assert!(
            s.ignore
                .as_ref()
                .is_some_and(|r| r.is_match("dprp") && !r.is_match("beta"))
        );
        let s = settings(&json!({ "Settings": { "SteamPics": {
            "Command": "/opt/steamcmd.sh", "MinIntervalMinutes": 0.1, "IgnoreBranches": "", "RawLog": false } } }));
        assert_eq!(s.command, "/opt/steamcmd.sh");
        assert_eq!(s.min_interval, Duration::from_secs(60));
        assert!(s.ignore.is_none() && !s.raw_log);
    }

    #[tokio::test]
    async fn fetch_runs_once_per_interval_and_reports_changes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("xf-steampics-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("out.txt");
        let calls = dir.join("calls");
        std::fs::write(&output, fixture()).unwrap();
        let script = dir.join("steamcmd");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\ncat '{}'\n",
                calls.display(),
                output.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = json!({
            "Settings": { "SteamPics": { "Command": script.to_str().unwrap() } },
            "channels12": [{ "RSS": ["steampics://730", "steampics://999999999"] }],
        });
        let cancel = CancellationToken::new();

        let first = fetch(&root, &dir, "steampics://730", true, &cancel).await;
        assert_eq!(first.items.len(), 1);
        assert!(first.failure.is_none());
        let unknown = fetch(&root, &dir, "steampics://999999999", true, &cancel).await;
        assert!(unknown.failure.unwrap().contains("no app info"));
        // One SteamCMD run for both URLs.
        let runs = std::fs::read_to_string(&calls).unwrap();
        assert_eq!(runs.lines().count(), 1);
        assert!(
            runs.contains("+app_info_print 730 +app_info_print 999999999 +quit"),
            "{runs}"
        );

        // A new build: force the next run and change the output.
        std::fs::write(
            &output,
            fixture()
                .replace(
                    "change number : 41339555/41339555",
                    "change number : 41339556/41339556",
                )
                .replace(
                    "\"buildid\"\t\t\"26798866\"\n\t\t\t\t\"timeupdated\"\t\t\"1795136249\"",
                    "\"buildid\"\t\t\"26900000\"\n\t\t\t\t\"timeupdated\"\t\t\"1795136249\"",
                ),
        )
        .unwrap();
        RUNNER.lock().await.last_run = None;
        let second = fetch(&root, &dir, "steampics://730", true, &cancel).await;
        assert_eq!(second.items.len(), 2, "{:?}", second.items);
        assert_eq!(
            second.items[0]["link"],
            "https://steamdb.info/patchnotes/26900000/"
        );
        let log = std::fs::read_to_string(raw_log_path(&dir)).unwrap();
        assert!(log.contains("\"changeNew\":41339556"), "{log}");
        let saved: Value =
            serde_json::from_slice(&std::fs::read(state_path(&dir)).unwrap()).unwrap();
        assert_eq!(saved["apps"]["730"]["change"], 41339556);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collects_configured_appids() {
        let mut out = BTreeSet::new();
        configured(
            &json!({ "channels12": [{ "RSS": ["steampics://730", "https://x/", " steampics://550 "] }] }),
            &mut out,
        );
        assert_eq!(out.into_iter().collect::<Vec<_>>(), [550, 730]);
    }
}
