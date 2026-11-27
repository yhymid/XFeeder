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
//!   "IgnoreBranches": "^dprp?$", "RawLog": true, "Changelists": false,
//!   "Login": "${STEAMCMD_LOGIN}", "Password": "${STEAMCMD_PASSWORD}" } }
//! ```
//!
//! `Login` (optional) uses a Steam account instead of anonymous, for apps
//! whose depots anonymous Steam hides (Deadlock). Runs use SteamCMD's saved
//! session; `Password` is used only when there is none, and Steam may ask to
//! approve that login in the Steam Mobile app. A failed login falls back to
//! anonymous for 6 hours.
//! Switching between the two compares nothing (no flood of "Branch added").
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
/// Events kept per app for the feed and for finding returning builds. With
/// `Changelists` every change number adds one, so 20 could rotate a build out
/// before a slow delivery sent it (most changes give 0–3 events: 3 days of
/// the 241-app test, 2026-11-26).
const EVENTS_KEPT: usize = 50;
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
    changelists: bool,
    login: Option<String>,
    password: Option<String>,
    live: bool,
    live_min_gap: Duration,
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
        changelists: section.get("Changelists") == Some(&Value::Bool(true)),
        login: login_name(section.get("Login")),
        password: login_password(section.get("Password")),
        live: section.get("Live") == Some(&Value::Bool(true)),
        live_min_gap: Duration::from_secs_f64(number("LiveMinSeconds", 120.0, 30.0, 3600.0)),
    }
}

/// A Steam account name for `Login`: letters, digits and `_` only (it goes on
/// SteamCMD's command line). An unresolved `${NAME}` or anything else is off.
fn login_name(value: Option<&Value>) -> Option<String> {
    let name = value.and_then(Value::as_str)?.trim();
    if name.is_empty() || name.eq_ignore_ascii_case("anonymous") {
        return None;
    }
    if (3..=64).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        Some(name.to_string())
    } else {
        crate::warn!(
            "SteamPics",
            "SteamPics.Login is not a Steam account name (letters, digits, _); using anonymous"
        );
        None
    }
}

/// The account password for `Password` (normally `${STEAMCMD_PASSWORD}`).
/// Never logged. Spaces, quotes and line breaks cannot go in a SteamCMD
/// script line, so such a password is refused (log in by hand instead).
fn login_password(value: Option<&Value>) -> Option<String> {
    let password = value.and_then(Value::as_str)?;
    if password.is_empty() || (password.starts_with("${") && password.ends_with('}')) {
        return None;
    }
    if password
        .chars()
        .any(|c| c.is_whitespace() || c == '"' || c.is_control())
    {
        crate::warn!(
            "SteamPics",
            "SteamPics.Password has spaces, quotes or line breaks, which SteamCMD scripts cannot take; not using it (log in once by hand: steamcmd +login NAME)"
        );
        return None;
    }
    Some(password.to_string())
}

// ---------------------------------------------------------------- live mode

/// What live mode (`pics_live`, feature `live-pics`) needs from the config,
/// refreshed on every `steampics://` check.
static LIVE: LazyLock<std::sync::Mutex<(bool, Duration, BTreeSet<u32>)>> =
    LazyLock::new(|| std::sync::Mutex::new((false, Duration::from_secs(60), BTreeSet::new())));
/// Apps live mode saw change, for the scheduler; and a forced SteamCMD run.
static WOKEN: LazyLock<std::sync::Mutex<BTreeSet<u32>>> = LazyLock::new(Default::default);
static FORCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// `Live` (on only in builds with the `live-pics` feature) and `LiveMinSeconds`.
#[cfg_attr(not(feature = "live-pics"), allow(dead_code))]
pub fn live_settings() -> (bool, Duration) {
    let live = LIVE.lock().unwrap_or_else(|e| e.into_inner());
    (live.0 && cfg!(feature = "live-pics"), live.1)
}

/// `Live` is on in the config, whatever this build supports.
#[cfg_attr(not(feature = "live-pics"), allow(dead_code))]
pub fn live_requested() -> bool {
    LIVE.lock().unwrap_or_else(|e| e.into_inner()).0
}

/// The configured `steampics://` apps.
#[cfg_attr(not(feature = "live-pics"), allow(dead_code))]
pub fn tracked() -> BTreeSet<u32> {
    LIVE.lock().unwrap_or_else(|e| e.into_inner()).2.clone()
}

/// Live mode saw these apps change: run SteamCMD at the next check and let the
/// scheduler check their channels now.
#[cfg_attr(not(feature = "live-pics"), allow(dead_code))]
pub fn wake(apps: &[u32]) {
    WOKEN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .extend(apps.iter().copied());
    FORCE.store(true, std::sync::atomic::Ordering::SeqCst);
    WAKE.notify_one();
}

/// Apps woken since the last call (for the scheduler).
pub fn take_woken() -> BTreeSet<u32> {
    std::mem::take(&mut *WOKEN.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Live mode's connection state, for the dashboard (saved with the state).
static LIVE_STATUS: LazyLock<std::sync::Mutex<Value>> =
    LazyLock::new(|| std::sync::Mutex::new(Value::Null));

#[cfg_attr(not(feature = "live-pics"), allow(dead_code))]
pub fn set_live_status(update: impl FnOnce(&mut Map<String, Value>)) {
    let mut status = LIVE_STATUS.lock().unwrap_or_else(|e| e.into_inner());
    if !status.is_object() {
        *status = json!({});
    }
    if let Some(map) = status.as_object_mut() {
        update(map);
    }
}

fn live_status() -> Value {
    LIVE_STATUS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Resolves when live mode wakes something.
pub async fn woken() {
    WAKE.notified().await;
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

/// The portrait library capsule (600×900), as on SteamDB's Discord posts.
fn capsule_image(flat: &BTreeMap<String, String>, appid: u32) -> Option<String> {
    let file = flat
        .get("common/library_assets_full/library_capsule/image/english")?
        .trim();
    let safe = !file.is_empty()
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'.'))
        && !file.contains("..");
    safe.then(|| {
        format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{appid}/{file}")
    })
}

/// The app's small community icon (32×32), for the post's author line.
fn icon_image(flat: &BTreeMap<String, String>, appid: u32) -> Option<String> {
    let hash = flat.get("common/icon")?.trim();
    (hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then(|| {
        format!(
            "https://shared.fastly.steamstatic.com/community_assets/images/apps/{appid}/{hash}.jpg"
        )
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
    capsule: Option<String>,
    icon: Option<String>,
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
        detail: Value,
    ) -> Value {
        // Structured copy for the compact Discord layout (`deliver.rs`).
        let mut pics = json!({
            "name": self.name,
            "appid": self.appid,
            "change": self.change,
            "changeLink": self.history(),
            "kind": labels[0],
            "branch": labels[1],
            "thumbnail": self.capsule.clone().or_else(|| self.image.clone()),
            "icon": self.icon,
        });
        if let (Value::Object(base), Value::Object(extra)) = (&mut pics, detail) {
            base.extend(extra);
        }
        json!({
            "steamPics": pics,
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
        capsule: capsule_image(flat, appid),
        icon: icon_image(flat, appid),
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
        json!({ "kind": "Current", "buildid": public.buildid, "buildLink": format!("https://steamdb.info/patchnotes/{}/", public.buildid) }),
    ))
}

/// A change number without a build or branch entry (`Changelists`), with the
/// names of the keys that changed, when anonymous Steam shows any.
fn changelist(
    appid: u32,
    change: u64,
    flat: &BTreeMap<String, String>,
    raw: &[(String, Option<String>, Option<String>)],
    now: i64,
) -> Value {
    let mut names: Vec<&str> = Vec::new();
    for (key, ..) in raw {
        let mut parts = key.split('/');
        let (section, field) = (parts.next().unwrap_or(""), parts.next());
        let name = match section {
            "common" | "extended" | "config" => field.unwrap_or(section),
            _ => section,
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let mut keys = names.iter().take(4).copied().collect::<Vec<_>>().join(", ");
    if names.len() > 4 {
        keys.push_str(&format!(" +{}", names.len() - 4));
    }
    let name = app_name(flat, appid);
    let ctx = Ctx {
        appid,
        name: &name,
        image: header_image(flat, appid),
        capsule: capsule_image(flat, appid),
        icon: icon_image(flat, appid),
        change,
        now,
    };
    let mut entry = ctx.entry(
        format!("{}: changelist {change}", ctx.name),
        if keys.is_empty() {
            format!("Steam change #{change}")
        } else {
            format!("Steam change #{change}. Changed: {keys}")
        },
        ctx.history(),
        now,
        ["Changelist", ""],
        json!({ "keys": keys }),
    );
    entry["identityKey"] = json!(format!("steampics:{appid}:change:{change}"));
    entry["categories"] = json!(["Changelist", "SteamPICS"]);
    entry
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
        capsule: capsule_image(new, appid),
        icon: icon_image(new, appid),
        change,
        now,
    };
    let (before, after) = (branches(old), branches(new));
    let skip = |b: &str| ignore.is_some_and(|re| re.is_match(b));

    if let (Some(was), Some(now_public)) = (before.get("public"), after.get("public"))
        && was.buildid != now_public.buildid
    {
        let delta = match (public_size(old), public_size(new)) {
            (Some(a), Some(b)) if a != b => Some(human_delta(i128::from(b) - i128::from(a))),
            _ => None,
        };
        let size = delta
            .as_ref()
            .map_or(String::new(), |d| format!(" Public depots {d}."));
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
            link.clone(),
            now_public.updated,
            ["Build", "public"],
            json!({ "buildid": now_public.buildid, "buildLink": link, "previous": was.buildid, "size": delta }),
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
        let detail = json!({
            "buildid": info.buildid,
            "buildLink": format!("https://steamdb.info/patchnotes/{}/", info.buildid),
            "description": info.description,
        });
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
                detail,
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
                detail,
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
            json!({ "buildid": info.buildid, "description": info.description }),
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
    /// `anonymous` or `login`, stored per app: a change of mode re-baselines.
    mode: String,
    login_blocked_until: Option<Instant>,
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
        // A failed login's pause survives a restart, so restarts do not
        // send Steam a new password login (a new approval request) each time.
        let now = chrono::Utc::now().timestamp();
        self.login_blocked_until = data["status"]["loginBlockedUntil"]
            .as_i64()
            .filter(|until| *until > now)
            .map(|until| Instant::now() + Duration::from_secs((until - now) as u64));
    }

    fn save(&self) -> std::io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let status = json!({
            "savedAt": iso(chrono::Utc::now().timestamp()),
            "mode": if self.mode.is_empty() { "anonymous" } else { self.mode.as_str() },
            "lastError": self.last_error,
            "loginBlockedUntil": self.login_blocked_until
                .and_then(|t| t.checked_duration_since(Instant::now()))
                .map(|left| chrono::Utc::now().timestamp() + left.as_secs() as i64),
            "loginBlockedForS": self.login_blocked_until
                .map(|t| t.saturating_duration_since(Instant::now()).as_secs())
                .filter(|s| *s > 0),
            "live": live_status(),
        });
        let body =
            serde_json::to_vec(&json!({ "version": 1, "status": status, "apps": self.apps }))
                .map_err(std::io::Error::other)?;
        crate::state::write_atomic(path, &body, 0o600)
    }

    /// Applies one SteamCMD run; returns the raw-log lines.
    fn apply(
        &mut self,
        apps: Vec<App>,
        ignore: Option<&Regex>,
        changelists: bool,
        now: i64,
    ) -> Vec<Value> {
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
            let mode = if self.mode.is_empty() {
                "anonymous"
            } else {
                self.mode.as_str()
            };
            let old_mode = entry
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("anonymous");
            // The other mode sees other depots and branches. Only keys both
            // answers have are compared, so a build both can see is still
            // posted, and what only one mode shows is not "added"/"removed"
            // (V10 F3: a switch used to drop every change since the last run).
            let switched = old_mode != mode && entry.get("flat").is_some();
            if switched {
                crate::info!(
                    "SteamPics",
                    "{} ({}): now read as {mode} (was {old_mode}); comparing only what both can see",
                    app_name(&app.flat, app.appid),
                    app.appid
                );
            }
            let old_change = entry.get("change").and_then(Value::as_u64);
            // Change numbers only go up; a lower one is stale cached info, and
            // an answer that lost every depot is partial. Diffing either would
            // post fake rollbacks or "Branch removed" for every branch.
            let had_depots = entry
                .get("flat")
                .and_then(Value::as_object)
                .is_some_and(|f| f.keys().any(|k| k.starts_with("depots/")));
            let lost_depots = had_depots && !app.flat.keys().any(|k| k.starts_with("depots/"));
            if old_change.is_some_and(|old| app.change < old) || lost_depots {
                crate::warn!(
                    "SteamPICS",
                    "{} ({}): ignoring a stale or partial answer (change {} after {}, depots {})",
                    app_name(&app.flat, app.appid),
                    app.appid,
                    app.change,
                    old_change.unwrap_or(0),
                    if lost_depots { "missing" } else { "present" }
                );
                self.apps
                    .insert(app.appid.to_string(), Value::Object(entry));
                continue;
            }
            let mut old_flat: Option<BTreeMap<String, String>> = entry
                .get("flat")
                .and_then(|f| serde_json::from_value(f.clone()).ok());
            let shared_new: Option<BTreeMap<String, String>> = if switched {
                let old = old_flat.take().unwrap_or_default();
                let new: BTreeMap<String, String> = app
                    .flat
                    .iter()
                    .filter(|(k, _)| old.contains_key(*k))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                old_flat = Some(
                    old.into_iter()
                        .filter(|(k, _)| app.flat.contains_key(k))
                        .collect(),
                );
                Some(new)
            } else {
                None
            };
            let compare_with = shared_new.as_ref().unwrap_or(&app.flat);
            let mut events: Vec<Value> = match entry.get("events") {
                Some(Value::Array(list)) => list.clone(),
                _ => Vec::new(),
            };
            if let Some(old) = &old_flat
                && old_change != Some(app.change)
            {
                let mut d = diff(app.appid, app.change, old, compare_with, ignore, now);
                let kinds: Vec<Value> = d
                    .events
                    .iter()
                    .map(|e| e["categories"][0].clone())
                    .collect();
                // A build that comes back (rollback) has the link of its first
                // post: give it its own identity or it would never be sent.
                for event in &mut d.events {
                    let identity = crate::text::entry_identity(event, true);
                    if events
                        .iter()
                        .any(|e| crate::text::entry_identity(e, true) == identity)
                    {
                        event["identityKey"] = json!(format!("{identity}#change:{}", app.change));
                    }
                }
                if changelists && d.events.is_empty() && !switched {
                    d.events
                        .push(changelist(app.appid, app.change, &app.flat, &d.raw, now));
                }
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
                    "events": kinds,
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
                "mode": mode,
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
    /// Steam wanted a password or Steam Guard code for `Login`.
    Login(String),
}

/// SteamCMD's line after a successful account login (seen 2026-11-27:
/// "Waiting for user info...Waiting for compat in post-logon took: 0.5sOK").
static LOGIN_OK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)Waiting for user info\.\.\..*OK").expect("static regex"));

/// SteamCMD output that means the saved session is gone (it would otherwise
/// wait for a password or a Steam Guard code).
static LOGIN_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)steam guard code|two-factor code|need two-factor|login failure|account logon denied|invalid password|rate limit exceeded|password:|cached credentials not found|no cached credentials|timed out waiting for confirmation|error \(timeout\)|logging in user .*failed")
        .expect("static regex")
});

/// Kills a whole process group when dropped (timeout, cancel, error), unless
/// the run finished and the id was cleared.
struct GroupKill(Option<u32>);

impl Drop for GroupKill {
    fn drop(&mut self) {
        if let Some(pid) = self
            .0
            .and_then(|p| i32::try_from(p).ok())
            .filter(|&p| p > 0)
        {
            // SAFETY: plain syscall; a negative pid addresses the group
            // created by `process_group(0)`, whose id is the child's pid.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

/// A 0600 SteamCMD script holding the password, deleted when dropped; the
/// password never goes on the command line (visible to every user).
struct Runscript(PathBuf);

impl Runscript {
    fn new(lines: &str) -> std::io::Result<Self> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let path = std::env::temp_dir().join(format!(
            "xfeeder-steamcmd-{}-{}.txt",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(lines.as_bytes())?;
        Ok(Self(path))
    }
}

impl Drop for Runscript {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// How SteamCMD logs in: anonymous, an account's saved session, or an
/// account with its password (Steam may ask to approve it in the app).
#[derive(Clone, Copy)]
enum Login<'a> {
    Anonymous,
    Saved(&'a str),
    Password(&'a str, &'a str),
}

async fn run_steamcmd(
    command: &str,
    login: Login<'_>,
    apps: &BTreeSet<u32>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<String, RunError> {
    let mut cmd = tokio::process::Command::new(command);
    let mut script = None;
    match login {
        // No password: SteamCMD's saved session, never a password prompt.
        Login::Saved(name) => {
            cmd.args(["+@NoPromptForPassword", "1", "+login", name]);
        }
        Login::Anonymous => {
            cmd.args(["+login", "anonymous"]);
        }
        Login::Password(name, password) => {
            let mut lines = format!("login {name} {password}\napp_info_update 1\n");
            for app in apps {
                lines.push_str(&format!("app_info_print {app}\n"));
            }
            lines.push_str("quit\n");
            let file = Runscript::new(&lines)
                .map_err(|e| RunError::Failed(format!("cannot write the SteamCMD script: {e}")))?;
            cmd.arg("+runscript").arg(&file.0);
            script = Some(file);
        }
    }
    if script.is_none() {
        cmd.args(["+app_info_update", "1"]);
        for app in apps {
            cmd.arg("+app_info_print").arg(app.to_string());
        }
        cmd.arg("+quit");
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own process group: /usr/games/steamcmd and steamcmd.sh are
        // shell scripts that start the real binary as a child, which
        // kill_on_drop alone would leave running after a timeout.
        .process_group(0)
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| RunError::Failed(format!("cannot start {command}: {e}")))?;
    let mut group = GroupKill(child.id());
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(RunError::Cancelled),
        result = tokio::time::timeout(timeout, child.wait_with_output()) => match result {
            Err(_) => return Err(RunError::Failed(format!("SteamCMD did not finish within {} s", timeout.as_secs()))),
            Ok(Err(e)) => return Err(RunError::Failed(format!("SteamCMD failed: {e}"))),
            Ok(Ok(output)) => output,
        },
    };
    group.0 = None;
    drop(script);
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if let Login::Password(_, password) = login {
        text = text.replace(password, "***");
    }
    let clean = ANSI.replace_all(&text, "");
    if !matches!(login, Login::Anonymous) {
        // What SteamCMD said about the login (the password is already
        // replaced): app_info_print also prints SteamCMD's cached app info
        // after a failed login, so app info alone proves nothing.
        // Only what comes before the app info: app data has words like
        // "error" in launch arguments.
        let login_part = HEADER
            .find(&clean)
            .map_or(&clean[..], |m| &clean[..m.start()]);
        let mut said: Vec<&str> = login_part
            .lines()
            .map(str::trim)
            .filter(|l| {
                let l = l.to_lowercase();
                [
                    "logging in",
                    "waiting for",
                    "confirm",
                    "failed",
                    "steam guard",
                    "two-factor",
                    "password",
                    "credentials",
                    "rate limit",
                    "denied",
                    "error",
                    "retrying",
                ]
                .iter()
                .any(|w| l.contains(w))
            })
            .collect();
        // "Waiting for confirmation..." repeats every few seconds.
        said.dedup();
        said.truncate(16);
        crate::diag::expert(
            "steampics.login",
            json!({ "lines": said, "exit": output.status.code() }),
        );
        crate::info!(
            "SteamPics",
            "SteamCMD login: {}",
            crate::diag::sanitize_text(&said.join(" | "))
        );
        if let Some(found) = LOGIN_FAILED.find(login_part) {
            return Err(RunError::Login(found.as_str().to_string()));
        }
        // After a failed login SteamCMD still prints its cached app info, so
        // only its own success line proves the account was used.
        if !LOGIN_OK.is_match(login_part) {
            return Err(RunError::Login(
                "no 'Waiting for user info...OK' from SteamCMD".into(),
            ));
        }
    }
    if !HEADER.is_match(&clean) {
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
    {
        let mut tracked = BTreeSet::new();
        configured(root, &mut tracked);
        *LIVE.lock().unwrap_or_else(|e| e.into_inner()) = (cfg.live, cfg.live_min_gap, tracked);
    }
    let mut runner = RUNNER.lock().await;
    runner.load(&state_path(base));
    let stale = runner
        .last_run
        .is_none_or(|at| at.elapsed() >= cfg.min_interval);
    // A wake from live mode runs SteamCMD now (taken by the first channel).
    let forced = persist && FORCE.swap(false, std::sync::atomic::Ordering::SeqCst);
    if stale || forced || !runner.covered.contains(&id) {
        let mut wanted = BTreeSet::new();
        configured(root, &mut wanted);
        wanted.insert(id);
        let started = Instant::now();
        let login = cfg.login.as_deref().filter(|_| {
            runner
                .login_blocked_until
                .is_none_or(|t| Instant::now() >= t)
        });
        let first = login.map_or(Login::Anonymous, Login::Saved);
        let mut result = run_steamcmd(&cfg.command, first, &wanted, cfg.timeout, cancel).await;
        // The password only replaces a missing or expired saved session; a
        // network error or rate limit must not send it (each try is a new
        // Steam Guard request).
        let no_session = matches!(&result, Err(RunError::Login(found))
            if found.to_lowercase().contains("cached credentials"));
        runner.mode = if login.is_some() {
            "login"
        } else {
            "anonymous"
        }
        .into();
        // No saved session yet (or it expired): log in with the password once;
        // Steam may ask to approve it in the Steam Mobile app.
        if let (true, Some(name), Some(password)) = (no_session, login, cfg.password.as_deref()) {
            crate::warn!(
                "SteamPics",
                "Logging in to Steam as {name} with the password from .env. If Steam asks, approve the login in the Steam Mobile app now: SteamCMD waits only about 1 minute.",
            );
            result = run_steamcmd(
                &cfg.command,
                Login::Password(name, password),
                &wanted,
                cfg.timeout,
                cancel,
            )
            .await;
            if let Err(RunError::Failed(message)) = &result {
                result = Err(RunError::Login(message.clone()));
            }
        }
        if let Err(RunError::Login(found)) = &result {
            crate::warn!(
                "SteamPics",
                "Steam login for SteamPics.Login failed (\"{found}\"); using anonymous for 6 hours. Check STEAMCMD_LOGIN/STEAMCMD_PASSWORD in .env and approve the login in the Steam Mobile app when asked."
            );
            runner.login_blocked_until = Some(Instant::now() + Duration::from_secs(6 * 3600));
            runner.mode = "anonymous".into();
            if persist && let Err(error) = runner.save() {
                crate::warn!("SteamPics", "cannot save the login pause: {error}");
            }
            result =
                run_steamcmd(&cfg.command, Login::Anonymous, &wanted, cfg.timeout, cancel).await;
        }
        match result {
            Err(RunError::Login(message)) => {
                runner.last_error = Some(format!("Steam login: {message}"));
            }
            Err(RunError::Cancelled) => {
                if forced {
                    FORCE.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                return Fetched {
                    items: runner.items(id),
                    failure: None,
                    cancelled: true,
                };
            }
            Err(RunError::Failed(message)) => {
                crate::warn!("SteamPics", "{message}");
                runner.last_error = Some(message);
                // A run live mode asked for failed: try again at the next check.
                if forced {
                    FORCE.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                // The dashboard shows the error (status block).
                if persist && let Err(error) = runner.save() {
                    crate::warn!(
                        "SteamPics",
                        "cannot save {}: {error}",
                        state_path(base).display()
                    );
                }
            }
            Ok(text) => {
                let apps = parse_output(&text);
                let unknown: Vec<u32> = apps.iter().filter(|a| !a.known).map(|a| a.appid).collect();
                let now = chrono::Utc::now().timestamp();
                let log = runner.apply(apps, cfg.ignore.as_ref(), cfg.changelists, now);
                crate::diag::expert(
                    "steampics.run",
                    json!({ "apps": wanted.len(), "unknown": unknown, "changedApps": log.len(),
                            "elapsedMs": started.elapsed().as_millis() as u64 }),
                );
                runner.last_error = None;
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
            icon_image(&cs2.flat, 730).as_deref(),
            Some(
                "https://shared.fastly.steamstatic.com/community_assets/images/apps/730/8dbc71957312bbd3baea65848b545be9eae2a355.jpg"
            )
        );
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
        assert!(runner.apply(apps.clone(), None, false, 10).is_empty());
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
        let log = runner.apply(next.clone(), None, false, 20);
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
        assert!(runner.apply(next.clone(), None, false, 30).is_empty());
        assert_eq!(runner.items(730).len(), 2);
        // A bare change number bump (hidden depots) is still logged.
        let mut bump = next;
        bump[0].change += 1;
        let log = runner.apply(bump, None, false, 40);
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

    #[tokio::test]
    async fn a_timed_out_steamcmd_leaves_no_child_behind() {
        // A wrapper script like steamcmd.sh: a shell that starts a child.
        let dir = std::env::temp_dir().join(format!("xf-steamcmd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("steamcmd");
        let marker = dir.join("child.pid");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nsleep 30 &\necho $! > {}\nwait\n",
                marker.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let apps: BTreeSet<u32> = [730].into();
        let result = run_steamcmd(
            script.to_str().unwrap(),
            Login::Anonymous,
            &apps,
            Duration::from_millis(500),
            &CancellationToken::new(),
        )
        .await;
        assert!(matches!(result, Err(RunError::Failed(_))));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let child: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: signal 0 only checks whether the process exists.
        let alive = unsafe { libc::kill(child, 0) } == 0;
        std::fs::remove_dir_all(&dir).ok();
        assert!(!alive, "the script's child survived the timeout");
    }

    #[test]
    fn login_names() {
        assert_eq!(
            login_name(Some(&json!("feed_bot1"))),
            Some("feed_bot1".into())
        );
        for off in [
            json!(""),
            json!("anonymous"),
            json!("a b"),
            json!("x;rm"),
            json!(5),
        ] {
            assert_eq!(login_name(Some(&off)), None, "{off}");
        }
        assert_eq!(login_name(None), None);
    }

    #[test]
    fn switching_login_mode_posts_only_what_both_modes_see() {
        let mut runner = Runner::default();
        let apps = parse_output(&fixture());
        runner.apply(apps.clone(), None, true, 10);
        let before = runner.items(730).len();
        // The account also sees a `staff` branch (not a new branch), and the
        // public build really changed in the meantime: that one is posted.
        let mut seen = apps.clone();
        seen[0].change += 1;
        seen[0]
            .flat
            .insert("depots/branches/staff/buildid".into(), "1".into());
        seen[0]
            .flat
            .insert("depots/branches/public/buildid".into(), "26900000".into());
        runner.mode = "login".into();
        runner.apply(seen.clone(), None, true, 20);
        let items = runner.items(730);
        assert_eq!(items.len(), before + 1, "{items:#?}");
        let text = serde_json::to_string(&items).unwrap();
        assert!(text.contains("26900000"));
        assert!(
            !text.contains("staff"),
            "a branch only one mode sees is not \"added\""
        );
        let before = items.len();
        // Later changes in the same mode are compared as usual.
        let mut next = seen;
        next[0].change += 1;
        next[0]
            .flat
            .insert("depots/branches/public/buildid".into(), "26900001".into());
        runner.apply(next, None, true, 30);
        assert_eq!(runner.items(730).len(), before + 1);
    }

    #[tokio::test]
    async fn login_is_judged_by_steamcmd_login_lines_only() {
        let dir = std::env::temp_dir().join(format!("xf-loginlines-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fixture = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/steam-pics/app_info_print.txt"
        ))
        .unwrap();
        let header = fixture.find("AppID : ").unwrap();
        let (login_lines, apps_part) = fixture.split_at(header);
        let script = dir.join("steamcmd");
        let apps: BTreeSet<u32> = [730].into();
        use std::os::unix::fs::PermissionsExt;
        let run = |out: String| {
            let out_file = dir.join("out.txt");
            std::fs::write(&out_file, out).unwrap();
            std::fs::write(&script, format!("#!/bin/sh\ncat {}\n", out_file.display())).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        };
        // A good login, then app data with words that look like a failure.
        run(format!(
            "{login_lines}{apps_part}\n\"launch\" \"-server password: x ERROR (Timeout)\"\n"
        ));
        let ok = run_steamcmd(
            script.to_str().unwrap(),
            Login::Saved("feed_bot1"),
            &apps,
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await;
        assert!(ok.is_ok(), "app data must not count as a login failure");
        // A failed login still followed by cached app info: a failure.
        run(format!(
            "Logging in user 'feed_bot1' to Steam Public...FAILED (No Connection)\n{apps_part}"
        ));
        let failed = run_steamcmd(
            script.to_str().unwrap(),
            Login::Saved("feed_bot1"),
            &apps,
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await;
        assert!(matches!(failed, Err(RunError::Login(_))));
        // An unknown failure text without SteamCMD's OK line: also a failure.
        run(format!(
            "Logging in user 'feed_bot1' to Steam Public...something new\n{apps_part}"
        ));
        let unknown = run_steamcmd(
            script.to_str().unwrap(),
            Login::Saved("feed_bot1"),
            &apps,
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await;
        assert!(matches!(unknown, Err(RunError::Login(_))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn login_pause_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("xf-loginpause-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = state_path(&dir);
        let mut runner = Runner::default();
        runner.load(&path);
        runner.login_blocked_until = Some(Instant::now() + Duration::from_secs(3 * 3600));
        runner.save().unwrap();
        let mut restarted = Runner::default();
        restarted.load(&path);
        let left = restarted
            .login_blocked_until
            .expect("pause restored")
            .saturating_duration_since(Instant::now());
        assert!(left > Duration::from_secs(2 * 3600) && left <= Duration::from_secs(3 * 3600));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn password_login_with_app_approval() {
        let dir = std::env::temp_dir().join(format!("xf-steampw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/steam-pics/app_info_print.txt"
        );
        let seen = dir.join("seen");
        let fake = |body: &str| {
            let script = dir.join("steamcmd");
            std::fs::write(&script, format!("#!/bin/sh\necho \"$@\" > {s}\nstat -c %a \"$2\" >> {s}\ncat \"$2\" >> {s}\n{body}\n", s = seen.display())).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
            script
        };
        let apps: BTreeSet<u32> = [730].into();
        // Steam asks for approval in the app, then prints the app info.
        // The account's Steam Guard notice is not a failure; the timeout is.
        let script = fake(&format!(
            "echo \"Logging in user 'feed_bot1' to Steam Public...This account is protected by a Steam Guard mobile authenticator.\"\necho 'Waiting for confirmation...'\necho 'Waiting for confirmation...OK'\ncat {fixture}"
        ));
        assert!(
            run_steamcmd(
                script.to_str().unwrap(),
                Login::Password("feed_bot1", "Secr3t!pw"),
                &apps,
                Duration::from_secs(10),
                &CancellationToken::new()
            )
            .await
            .is_ok()
        );
        let script = fake(&format!(
            "echo 'Waiting for confirmation...'\necho 'Retrying...'\necho 'ERROR (Timeout)'\ncat {fixture}"
        ));
        assert!(matches!(
            run_steamcmd(
                script.to_str().unwrap(),
                Login::Password("feed_bot1", "Secr3t!pw"),
                &apps,
                Duration::from_secs(10),
                &CancellationToken::new()
            )
            .await,
            Err(RunError::Login(_))
        ));
        let script = fake(&format!(
            "echo 'Please confirm the login in the Steam Mobile app on your phone.'\necho 'Waiting for confirmation...OK'\ncat {fixture}"
        ));
        let ok = run_steamcmd(
            script.to_str().unwrap(),
            Login::Password("feed_bot1", "Secr3t!pw"),
            &apps,
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await;
        assert!(ok.is_ok());
        let log = std::fs::read_to_string(&seen).unwrap();
        let mut lines = log.lines();
        let argv = lines.next().unwrap();
        assert!(
            argv.starts_with("+runscript ") && !argv.contains("Secr3t"),
            "{argv}"
        );
        assert_eq!(lines.next(), Some("600"));
        assert!(
            log.contains("login feed_bot1 Secr3t!pw\napp_info_update 1\napp_info_print 730\nquit")
        );
        let file = argv.trim_start_matches("+runscript ");
        assert!(
            !std::path::Path::new(file).exists(),
            "the password file is deleted"
        );
        // A refused login: the error never shows the password.
        let script =
            fake("echo 'login feed_bot1 Secr3t!pw'\necho 'Timed out waiting for confirmation'");
        let err = run_steamcmd(
            script.to_str().unwrap(),
            Login::Password("feed_bot1", "Secr3t!pw"),
            &apps,
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await;
        match err {
            Err(RunError::Login(m)) => assert!(!m.contains("Secr3t"), "{m}"),
            _ => panic!("expected a login error"),
        }
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(login_password(Some(&json!("${STEAMCMD_PASSWORD}"))), None);
        assert_eq!(login_password(Some(&json!("a b"))), None);
        assert_eq!(login_password(Some(&json!("ok!pw"))), Some("ok!pw".into()));
    }

    #[tokio::test]
    async fn a_lost_steam_session_stops_the_run() {
        let dir = std::env::temp_dir().join(format!("xf-steamlogin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("steamcmd");
        let args = dir.join("args");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"$@\" > {}\necho 'Logging in user ...'\necho 'Steam Guard code:'\n", args.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let apps: BTreeSet<u32> = [730].into();
        let result = run_steamcmd(
            script.to_str().unwrap(),
            Login::Saved("feed_bot1"),
            &apps,
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await;
        let used = std::fs::read_to_string(&args).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert!(matches!(result, Err(RunError::Login(_))));
        assert!(
            used.starts_with("+@NoPromptForPassword 1 +login feed_bot1 +app_info_update"),
            "{used}"
        );
    }

    #[test]
    fn stale_or_partial_answers_are_ignored() {
        let mut runner = Runner::default();
        let apps = parse_output(&fixture());
        runner.apply(apps.clone(), None, true, 10);
        let mut newer = apps.clone();
        newer[0].change += 5;
        newer[0]
            .flat
            .insert("depots/branches/public/buildid".into(), "26900000".into());
        runner.apply(newer.clone(), None, true, 20);
        let before = runner.items(730).len();
        // An older change number (stale cache) posts no rollback.
        let mut stale = apps.clone();
        stale[0].change += 1;
        runner.apply(stale, None, true, 30);
        assert_eq!(runner.items(730).len(), before);
        // An answer without any depot posts no "Branch removed".
        let mut partial = newer.clone();
        partial[0].change += 1;
        partial[0].flat.retain(|k, _| !k.starts_with("depots/"));
        runner.apply(partial, None, true, 40);
        assert_eq!(runner.items(730).len(), before);
        // The next real answer is compared with the last good state.
        let mut next = newer;
        next[0].change += 2;
        next[0]
            .flat
            .insert("depots/branches/public/buildid".into(), "26900001".into());
        runner.apply(next, None, true, 50);
        assert_eq!(runner.items(730)[0]["categories"][0], "Build");
    }

    #[test]
    fn changelists_and_rollbacks() {
        let build = |apps: &[App], id: &str, n: u64| {
            let mut next = apps.to_vec();
            next[0].change += n;
            next[0]
                .flat
                .insert("depots/branches/public/buildid".into(), id.into());
            next
        };
        let mut runner = Runner::default();
        let apps = parse_output(&fixture());
        runner.apply(apps.clone(), None, true, 10);
        // Build A -> B -> A: three posts with three identities.
        runner.apply(build(&apps, "26900000", 1), None, true, 20);
        runner.apply(build(&apps, "26798866", 2), None, true, 30);
        let ids: BTreeSet<String> = runner
            .items(730)
            .iter()
            .map(|e| crate::text::entry_identity(e, true))
            .collect();
        assert_eq!(ids.len(), 3, "{ids:?}");
        // Nothing visible changed, then only a review score.
        let mut next = build(&apps, "26798866", 3);
        let log = runner.apply(next.clone(), None, true, 40);
        assert_eq!(log[0]["events"], json!([]));
        let newest = runner.items(730).remove(0);
        assert_eq!(newest["categories"][0], "Changelist");
        assert_eq!(newest["steamPics"]["keys"], "");
        next[0].change += 1;
        next[0]
            .flat
            .insert("common/review_percentage".into(), "1".into());
        runner.apply(next, None, true, 50);
        let newest = runner.items(730).remove(0);
        assert_eq!(newest["steamPics"]["keys"], "review_percentage");
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
