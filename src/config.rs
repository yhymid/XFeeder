//! Configuration: `.env` loading, `${VAR}` substitution, schema v2 conversion,
//! network settings and channel normalization (identical semantics and cache
//! identities to the Node.js 2.x/3.0 implementations).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};

use crate::js::{self, Obj, truthy};

pub type Env = HashMap<String, String>;

// ---------------------------------------------------------------- dotenv --

fn strip_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &value[1..value.len() - 1];
        }
    }
    value
}

pub fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn parse_dotenv(content: &str) -> Env {
    let mut values = Env::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim_end();
        if !valid_env_key(key) {
            continue;
        }
        values.insert(key.to_string(), strip_quotes(value.trim()).to_string());
    }
    values
}

pub fn load_dotenv(path: &Path) -> Env {
    std::fs::read_to_string(path)
        .map(|text| parse_dotenv(&text))
        .unwrap_or_default()
}

/// `.env` next to the config, overridden by the process environment.
pub fn env_for(config_path: &Path) -> Env {
    let mut env = load_dotenv(&env_path(config_path));
    env.extend(std::env::vars());
    env
}

pub fn env_path(config_path: &Path) -> PathBuf {
    absolute(config_path)
        .parent()
        .map_or_else(|| PathBuf::from(".env"), |dir| dir.join(".env"))
}

pub fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Replace values that are exactly `${NAME}`; missing variables become "".
pub fn resolve_env(value: &Value, env: &Env) -> Value {
    match value {
        Value::String(text) => match env_reference(text) {
            Some(name) => Value::String(env.get(name).cloned().unwrap_or_default()),
            None => value.clone(),
        },
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| resolve_env(item, env)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), resolve_env(v, env)))
                .collect(),
        ),
        other => other.clone(),
    }
}

pub fn env_reference(text: &str) -> Option<&str> {
    let name = text.strip_prefix("${")?.strip_suffix('}')?;
    valid_env_key(name).then_some(name)
}

/// Every `${NAME}` occurring anywhere in config strings.
pub fn collect_env_refs(value: &Value, out: &mut HashSet<String>) {
    match value {
        Value::String(text) => {
            let mut rest = text.as_str();
            while let Some(start) = rest.find("${") {
                let tail = &rest[start + 2..];
                match tail.find('}') {
                    Some(end) if valid_env_key(&tail[..end]) => {
                        out.insert(tail[..end].to_string());
                        rest = &tail[end + 1..];
                    }
                    _ => rest = tail,
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_env_refs(item, out)),
        Value::Object(map) => map.values().for_each(|item| collect_env_refs(item, out)),
        _ => {}
    }
}

// ------------------------------------------------------------- network --

pub const PRESETS: [(&str, Option<f64>); 6] = [
    ("potato", Some(10_000.0)),
    ("low", Some(2_000_000.0)),
    ("medium", Some(10_000_000.0)),
    ("high", Some(50_000_000.0)),
    ("very-high", Some(100_000_000.0)),
    ("unlimited", None),
];

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub bandwidth_profile: String,
    pub download_bytes_per_second: Option<f64>,
    pub upload_bytes_per_second: Option<f64>,
    pub network_friendly_mode: bool,
    pub scrapling_resource_saving: bool,
    pub max_concurrent_requests: Option<u64>,
    pub max_concurrent_scrapling_requests: Option<u64>,
    pub setup_timeout_ms: u64,
    pub idle_timeout_ms: u64,
    pub request_deadline_ms: Option<u64>,
    pub shutdown_grace_ms: u64,
    pub outbound_policy: String,
    pub max_response_bytes: Option<u64>,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        normalize_network(&Value::Object(Map::new())).expect("defaults are valid")
    }
}

impl NetworkConfig {
    pub fn http_concurrency(&self) -> Option<u64> {
        self.max_concurrent_requests
            .or(self.network_friendly_mode.then_some(2))
    }
    pub fn scrapling_concurrency(&self) -> Option<u64> {
        self.max_concurrent_scrapling_requests
            .or(self.network_friendly_mode.then_some(1))
    }
    pub fn public_only(&self) -> bool {
        self.outbound_policy == "public-only"
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Issue {
    pub path: String,
    pub code: String,
    pub message: String,
}

fn issue(path: impl Into<String>, code: &str, message: &str) -> Issue {
    Issue {
        path: path.into(),
        code: code.into(),
        message: message.into(),
    }
}

const NETWORK_FIELDS: [&str; 13] = [
    "bandwidthProfile",
    "downloadLimitMbps",
    "uploadLimitMbps",
    "networkFriendlyMode",
    "maxConcurrentRequests",
    "maxConcurrentScraplingRequests",
    "scraplingResourceSaving",
    "setupTimeoutMs",
    "idleTimeoutMs",
    "requestDeadlineMs",
    "shutdownGraceMs",
    "outboundPolicy",
    "maxResponseBytes",
];

/// `normalizeNetworkConfig`; `network` may be absent (`null`).
pub fn normalize_network(input: &Value) -> Result<NetworkConfig, Vec<Issue>> {
    let empty = Map::new();
    let map = match input {
        Value::Null => &empty,
        Value::Object(map) => map,
        _ => {
            return Err(vec![issue(
                "network",
                "INVALID_TYPE",
                "network must be an object",
            )]);
        }
    };
    let mut errors = Vec::new();
    let field = |name: &str| format!("network.{name}");
    for key in map.keys() {
        if !NETWORK_FIELDS.contains(&key.as_str()) {
            errors.push(issue(
                field(key),
                "UNKNOWN_FIELD",
                "Unsupported network setting or unit",
            ));
        }
    }
    let get = |name: &str| map.get(name).filter(|value| !value.is_null());
    let profile = match get("bandwidthProfile") {
        None => "unlimited".to_string(),
        Some(Value::String(text))
            if text == "custom" || PRESETS.iter().any(|(name, _)| name == text) =>
        {
            text.clone()
        }
        Some(_) => {
            errors.push(issue(
                field("bandwidthProfile"),
                "UNKNOWN_PROFILE",
                "Unknown bandwidth profile",
            ));
            "unlimited".to_string()
        }
    };
    let rate = |name: &str, errors: &mut Vec<Issue>| -> Option<f64> {
        let value = get(name)?;
        let Some(number) = value.as_f64().filter(|n| n.is_finite()) else {
            errors.push(issue(
                field(name),
                "INVALID_NUMBER",
                "Limit must be a finite number in Mbps",
            ));
            return None;
        };
        if number <= 0.0 || number > 1_000_000.0 || (number * 125_000.0).round() < 1.0 {
            errors.push(issue(
                field(name),
                "OUT_OF_RANGE",
                "Limit must be positive and representable (up to 1,000,000 Mbps)",
            ));
            return None;
        }
        Some((number * 125_000.0).round())
    };
    let download = rate("downloadLimitMbps", &mut errors);
    let upload = rate("uploadLimitMbps", &mut errors);
    if profile == "custom" && download.is_none() && upload.is_none() && errors.is_empty() {
        errors.push(issue(
            field("downloadLimitMbps"),
            "CUSTOM_LIMIT_REQUIRED",
            "Custom requires at least one limit; null leaves a direction unlimited",
        ));
    }
    let boolean = |name: &str, fallback: bool, errors: &mut Vec<Issue>| match map.get(name) {
        None => fallback,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => {
            errors.push(issue(
                field(name),
                "INVALID_BOOLEAN",
                "Setting must be a boolean",
            ));
            fallback
        }
    };
    let friendly = boolean("networkFriendlyMode", false, &mut errors);
    let saving = boolean("scraplingResourceSaving", true, &mut errors);
    let integer =
        |name: &str, min: u64, max: u64, errors: &mut Vec<Issue>| -> Option<Option<u64>> {
            let Some(value) = get(name) else {
                return Some(None);
            };
            match value.as_u64().filter(|n| *n >= min && *n <= max) {
                Some(n) if value.as_f64().is_some_and(|f| f.fract() == 0.0) => Some(Some(n)),
                _ => {
                    errors.push(issue(
                        field(name),
                        "OUT_OF_RANGE",
                        &format!(
                            "Setting must be {} between {min} and {max}",
                            if min > 0 {
                                "a positive integer"
                            } else {
                                "an integer"
                            }
                        ),
                    ));
                    None
                }
            }
        };
    let max_requests = integer("maxConcurrentRequests", 1, 10_000, &mut errors).flatten();
    let max_scrapling = integer("maxConcurrentScraplingRequests", 1, 10_000, &mut errors).flatten();
    let setup = integer("setupTimeoutMs", 0, 2_147_000_000, &mut errors)
        .flatten()
        .unwrap_or(15_000);
    let idle = integer("idleTimeoutMs", 0, 2_147_000_000, &mut errors)
        .flatten()
        .unwrap_or(15_000);
    let deadline = integer("requestDeadlineMs", 1, 2_147_000_000, &mut errors).flatten();
    let grace = integer("shutdownGraceMs", 0, 60_000, &mut errors)
        .flatten()
        .unwrap_or(5_000);
    let max_bytes = integer("maxResponseBytes", 1, 268_435_456, &mut errors).flatten();
    let outbound = match get("outboundPolicy") {
        None => "unrestricted".to_string(),
        Some(Value::String(text)) if text == "unrestricted" || text == "public-only" => {
            text.clone()
        }
        Some(_) => {
            errors.push(issue(
                field("outboundPolicy"),
                "UNKNOWN_POLICY",
                "Expected unrestricted or public-only",
            ));
            "unrestricted".to_string()
        }
    };
    if !errors.is_empty() {
        return Err(errors);
    }
    let preset = PRESETS
        .iter()
        .find(|(name, _)| *name == profile)
        .and_then(|(_, bits)| *bits);
    Ok(NetworkConfig {
        download_bytes_per_second: if profile == "custom" {
            download
        } else {
            preset.map(|bits| bits / 8.0)
        },
        upload_bytes_per_second: if profile == "custom" { upload } else { None },
        bandwidth_profile: profile,
        network_friendly_mode: friendly,
        scrapling_resource_saving: saving,
        max_concurrent_requests: max_requests,
        max_concurrent_scrapling_requests: max_scrapling,
        setup_timeout_ms: setup,
        idle_timeout_ms: idle,
        request_deadline_ms: deadline,
        shutdown_grace_ms: grace,
        outbound_policy: outbound,
        max_response_bytes: max_bytes,
    })
}

pub fn issues_text(issues: &[Issue]) -> String {
    issues
        .iter()
        .map(|i| format!("{}: {}", i.path, i.message))
        .collect::<Vec<_>>()
        .join("; ")
}

// ----------------------------------------------------------- schema v2 --

/// Lightweight structural check for schema v2 and conversion to the legacy
/// runtime shape (the same mapping as `toLegacyRuntime`).
pub fn v2_to_legacy(v2: &Value) -> Result<Value, Vec<Issue>> {
    let mut errors = Vec::new();
    let Some(root) = v2.as_object() else {
        return Err(vec![issue(
            "$",
            "invalid_type",
            "Config root must be a JSON object",
        )]);
    };
    for key in root.keys() {
        if !["schemaVersion", "settings", "integrations", "channels"].contains(&key.as_str()) {
            errors.push(issue(
                key.clone(),
                "unknown_field",
                "Unsupported configuration field",
            ));
        }
    }
    for key in ["settings", "integrations", "channels"] {
        if !root.get(key).is_some_and(Value::is_object) {
            errors.push(issue(key, "required", "Required field is missing"));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let settings = &root["settings"];
    let ints = &root["integrations"];
    let mut legacy = Map::new();
    let mut put = |section: &str, pairs: Vec<(&str, &Value)>, present: bool| {
        if !present {
            return;
        }
        let object: Obj = pairs
            .into_iter()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        legacy.insert(section.to_string(), Value::Object(object));
    };
    put(
        "Settings",
        vec![
            ("Logs", js::get(settings, "logs")),
            ("DebugExpert", js::get(settings, "debugExpert")),
            (
                "MaxConcurrentChannels",
                js::get(settings, "maxConcurrentChannels"),
            ),
            ("FirstRunSend", js::get(settings, "firstRunSend")),
            ("Diagnostics", js::get(settings, "diagnostics")),
        ],
        settings.as_object().is_some_and(|m| !m.is_empty()),
    );
    let discord = js::get(ints, "discord");
    put(
        "Auth",
        vec![
            ("Token", js::get(discord, "token")),
            ("cookie", js::get(discord, "cookie")),
            ("x-super-properties", js::get(discord, "superProperties")),
        ],
        discord.is_object(),
    );
    let proxy = js::get(ints, "proxy");
    put(
        "Proxy",
        vec![
            ("Enabled", js::get(proxy, "enabled")),
            ("Url", js::get(proxy, "url")),
        ],
        proxy.is_object(),
    );
    let scrapling = js::get(ints, "scrapling");
    put(
        "Scrapling",
        vec![
            ("Enabled", js::get(scrapling, "enabled")),
            ("AutoFallback", js::get(scrapling, "autoFallback")),
        ],
        scrapling.is_object(),
    );
    let telegram = js::get(ints, "telegram");
    put(
        "Telegram",
        vec![
            ("Enabled", js::get(telegram, "enabled")),
            ("BotToken", js::get(telegram, "botToken")),
            ("ChatID", js::get(telegram, "chatId")),
            ("TimeoutMs", js::get(telegram, "timeoutMs")),
        ],
        telegram.is_object(),
    );
    let root_telegram_complete =
        truthy(js::get(telegram, "botToken")) && truthy(js::get(telegram, "chatId"));

    let mut channels = Map::new();
    for (name, channel) in root["channels"].as_object().into_iter().flatten() {
        let at = format!("channels.{name}");
        if js::get(channel, "enabled") == &Value::Bool(false) {
            errors.push(issue(
                format!("{at}.enabled"),
                "unsupported_semantics",
                "Legacy runner cannot safely disable channels",
            ));
        }
        let mut feeds = Vec::new();
        let mut discord_source: Option<Value> = None;
        for (index, source) in js::get(channel, "sources")
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            match js::get(source, "type").as_str() {
                Some("feed") => feeds.push(js::get(source, "url").clone()),
                Some("discord") if discord_source.is_some() => errors.push(issue(
                    format!("{at}.sources[{index}]"),
                    "duplicate_source",
                    "Only one Discord source per channel is supported",
                )),
                Some("discord") => {
                    let mut object = Obj::new();
                    object.insert("ChannelIDs".into(), js::get(source, "channelIds").clone());
                    for (from, to) in [
                        ("token", "Token"),
                        ("guildId", "GuildID"),
                        ("cookie", "cookie"),
                        ("superProperties", "x-super-properties"),
                    ] {
                        if truthy(js::get(source, from)) {
                            object.insert(to.into(), js::get(source, from).clone());
                        }
                    }
                    discord_source = Some(Value::Object(object));
                }
                _ => errors.push(issue(
                    format!("{at}.sources[{index}].type"),
                    "invalid_enum",
                    "Expected a supported source or destination type",
                )),
            }
        }
        let mut out = Obj::new();
        out.insert(
            "CacheKey".into(),
            Value::String(
                js::trimmed_str(js::get(channel, "id"))
                    .map_or_else(|| format!("channels:{name}"), str::to_string),
            ),
        );
        for (from, to) in [
            ("timeChecker", "TimeChecker"),
            ("requestSend", "RequestSend"),
        ] {
            if truthy(js::get(channel, from)) {
                out.insert(to.into(), js::get(channel, from).clone());
            }
        }
        for (from, to) in [("firstRunSend", "FirstRunSend"), ("filters", "Filters")] {
            if !js::get(channel, from).is_null() {
                out.insert(to.into(), js::get(channel, from).clone());
            }
        }
        if !feeds.is_empty() {
            out.insert("Feeds".into(), Value::Array(feeds));
        }
        if let Some(discord) = discord_source {
            out.insert("Discord".into(), discord);
        }
        let mut seen_webhook = false;
        let mut seen_telegram = false;
        for (index, dest) in js::get(channel, "destinations")
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            match js::get(dest, "type").as_str() {
                Some("webhook") => {
                    if seen_webhook {
                        errors.push(issue(
                            format!("{at}.destinations[{index}]"),
                            "duplicate_destination",
                            "Only one webhook destination per channel is supported",
                        ));
                    }
                    seen_webhook = true;
                    out.insert("Webhook".into(), js::get(dest, "url").clone());
                    if truthy(js::get(dest, "threadId")) {
                        out.insert("Thread".into(), js::get(dest, "threadId").clone());
                    }
                }
                Some("telegram") => {
                    if seen_telegram {
                        errors.push(issue(
                            format!("{at}.destinations[{index}]"),
                            "duplicate_destination",
                            "Only one Telegram destination per channel is supported",
                        ));
                    }
                    seen_telegram = true;
                    let mut tg = Obj::new();
                    tg.insert("Enabled".into(), Value::Bool(true));
                    for (from, to) in [
                        ("botToken", "BotToken"),
                        ("chatId", "ChatID"),
                        ("messageThreadId", "MessageThreadID"),
                        ("disableWebPagePreview", "DisableWebPagePreview"),
                        ("timeoutMs", "TimeoutMs"),
                    ] {
                        let value = js::get(dest, from);
                        if !value.is_null()
                            && (from == "disableWebPagePreview"
                                || from == "chatId"
                                || truthy(value))
                        {
                            tg.insert(to.into(), value.clone());
                        }
                    }
                    out.insert("Telegram".into(), Value::Object(tg));
                }
                _ => errors.push(issue(
                    format!("{at}.destinations[{index}].type"),
                    "invalid_enum",
                    "Expected a supported source or destination type",
                )),
            }
        }
        if !seen_telegram && root_telegram_complete {
            out.insert("Telegram".into(), json!({ "Enabled": false }));
        }
        channels.insert(name.clone(), Value::Object(out));
    }
    legacy.insert("channels".into(), Value::Object(channels));
    if errors.is_empty() {
        Ok(Value::Object(legacy))
    } else {
        Err(errors)
    }
}

pub fn schema_version(config: &Value) -> Result<u8, Issue> {
    match config.get("schemaVersion") {
        None => Ok(1),
        Some(value) if value == &json!(1) => Ok(1),
        Some(value) if value == &json!(2) => Ok(2),
        Some(_) => Err(issue(
            "schemaVersion",
            "unsupported_version",
            "Unsupported configuration schema version",
        )),
    }
}

/// Legacy runtime shape for either schema version (before env resolution).
pub fn runtime_shape(raw: &Value) -> Result<Value, Vec<Issue>> {
    if !raw.is_object() {
        return Err(vec![issue(
            "$",
            "invalid_type",
            "Config root must be a JSON object",
        )]);
    }
    match schema_version(raw).map_err(|e| vec![e])? {
        2 => v2_to_legacy(raw),
        _ => Ok(raw.clone()),
    }
}

// --------------------------------------------------------- loaded config --

#[derive(Clone, Debug)]
pub struct Config {
    /// Legacy runtime shape with environment references resolved.
    pub root: Value,
    pub network: NetworkConfig,
    pub channels: Vec<Channel>,
    pub digest: String,
}

impl Config {
    pub fn settings(&self) -> &Value {
        js::get(&self.root, "Settings")
    }
    pub fn logs(&self) -> bool {
        js::get(self.settings(), "Logs") == &Value::Bool(true)
    }
    pub fn debug_expert(&self) -> bool {
        js::get(self.settings(), "DebugExpert") == &Value::Bool(true)
    }
    pub fn max_concurrent_channels(&self) -> usize {
        js::get(self.settings(), "MaxConcurrentChannels")
            .as_u64()
            .map_or(1, |n| n as usize)
    }
}

pub fn load(config_path: &Path) -> Result<Config, String> {
    let text = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Cannot read {}: {e}", config_path.display()))?;
    let raw: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid JSON in {}: {e}", config_path.display()))?;
    from_value(&raw, &env_for(config_path))
}

pub fn from_value(raw: &Value, env: &Env) -> Result<Config, String> {
    let shape = runtime_shape(raw).map_err(|issues| issues_text(&issues))?;
    let root = resolve_env(&shape, env);
    let network =
        normalize_network(js::get(&root, "network")).map_err(|issues| issues_text(&issues))?;
    let concurrency = js::get(js::get(&root, "Settings"), "MaxConcurrentChannels");
    if !concurrency.is_null() && !concurrency.as_u64().is_some_and(|n| (1..=8).contains(&n)) {
        return Err("Settings.MaxConcurrentChannels must be an integer from 1 to 8".into());
    }
    let channels = collect_channels(&root);
    let digest = root.to_string();
    Ok(Config {
        root,
        network,
        channels,
        digest,
    })
}

// -------------------------------------------------------------- channels --

const FEED_FIELDS: [&str; 4] = ["RSS", "Feeds", "URLs", "Sources"];
const CHANNEL_HINTS: [&str; 14] = [
    "RSS",
    "Feeds",
    "URLs",
    "Sources",
    "Webhook",
    "Thread",
    "Discord",
    "Telegram",
    "TimeChecker",
    "RequestSend",
    "ID",
    "Key",
    "CacheKey",
    "Matrix",
];
const RESERVED_ROOT: [&str; 9] = [
    "Settings",
    "Solver",
    "network",
    "Auth",
    "Proxy",
    "Scrapling",
    "ChannelDefaults",
    "DefaultChannel",
    "Telegram",
];

fn is_http(text: &str) -> bool {
    let lower = text.get(..8).unwrap_or(text).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || crate::steam_pics::is_url(text)
}

fn looks_like_channel(value: &Value) -> bool {
    match value {
        Value::String(text) => is_http(text),
        Value::Array(items) => items.iter().all(|item| item.as_str().is_some_and(is_http)),
        Value::Object(map) => map
            .keys()
            .any(|key| CHANNEL_HINTS[..13].contains(&key.as_str())),
        _ => false,
    }
}

pub fn is_channel_group(key: &str, value: &Value) -> bool {
    if RESERVED_ROOT.contains(&key) {
        return false;
    }
    let starts = key.to_lowercase().starts_with("channels");
    match value {
        Value::Array(items) if items.is_empty() => starts,
        Value::Array(items) => items.iter().all(looks_like_channel),
        Value::Object(map) if map.is_empty() => starts,
        Value::Object(map) => map.values().all(looks_like_channel),
        _ => false,
    }
}

pub fn channel_groups(root: &Value) -> Vec<(&String, &Value)> {
    root.as_object()
        .into_iter()
        .flatten()
        .filter(|(key, value)| is_channel_group(key, value))
        .collect()
}

#[derive(Clone, Debug)]
pub struct Telegram {
    pub enabled: bool,
    pub bot_token: String,
    pub chat_id: String,
    pub message_thread_id: Option<u64>,
    pub disable_preview: bool,
    /// Send entries with an image as a photo with caption (`SendPhoto`).
    pub send_photo: bool,
    pub timeout_ms: u64,
}

impl Telegram {
    pub fn is_target(&self) -> bool {
        self.enabled && !self.bot_token.trim().is_empty() && !self.chat_id.trim().is_empty()
    }
}

#[derive(Clone, Debug)]
pub struct Channel {
    pub index: usize,
    /// Position of the entry in its group (array index, or key order of a
    /// named group), counting entries that were skipped.
    pub position: usize,
    pub name: Option<String>,
    /// `Label`: the name shown in logs and the dashboard. Not part of the
    /// history key, so it can be changed freely.
    pub display: Option<String>,
    pub source_key: String,
    pub webhook: String,
    pub thread: Option<String>,
    pub feeds: Vec<String>,
    pub time_checker: u64,
    pub request_send: usize,
    /// Newest entries delivered when a feed is seen for the first time; the
    /// rest of its current entries are only recorded as seen.
    pub first_run_send: usize,
    /// Entry filter (`Filters`), if configured.
    pub filter: Option<crate::filter::Filter>,
    /// Mentions above Discord posts (`Ping`), if configured.
    pub ping: Option<crate::ping::Ping>,
    /// Per-feed check interval (`AdaptivePolling`); `None` = every feed is
    /// checked every `TimeChecker` minutes.
    pub adaptive: Option<crate::adaptive::Adaptive>,
    /// Normalized Discord source configuration (raw JSON shape kept).
    pub discord: Option<Value>,
    pub telegram: Option<Telegram>,
    pub raw: Value,
    /// Identity used for delivery state (3.0 fingerprint unless overridden).
    pub cache_key: String,
    /// Fingerprint used by XFeeder 2.x; recognised so that an upgrade does
    /// not resend entries already delivered by an older worker.
    pub legacy_cache_key: Option<String>,
}

impl Channel {
    pub fn label(&self) -> String {
        self.display
            .clone()
            .or_else(|| self.name.clone())
            .unwrap_or_else(|| format!("{}#{}", self.source_key, self.index + 1))
    }
    pub fn has_webhook(&self) -> bool {
        !self.webhook.trim().is_empty()
    }
    pub fn has_telegram(&self) -> bool {
        self.telegram.as_ref().is_some_and(Telegram::is_target)
    }
    pub fn discord_webhook(&self) -> String {
        let local = self
            .discord
            .as_ref()
            .map(|d| js::to_string_or_empty(js::get(d, "Webhook")))
            .unwrap_or_default();
        if local.is_empty() {
            self.webhook.clone()
        } else {
            local
        }
    }
    pub fn discord_thread(&self) -> Option<String> {
        match self.discord.as_ref().map(|d| js::get(d, "Thread")) {
            Some(Value::String(thread)) => Some(thread.clone()),
            _ => self.thread.clone(),
        }
    }
}

fn normalize_thread(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) if text.is_empty() || text == "null" => None,
        other => Some(js::to_string(other)),
    }
}

fn positive_floor(value: &Value, fallback: u64) -> u64 {
    let number = js::to_number(value);
    if value.is_null() || !number.is_finite() || number <= 0.0 {
        fallback
    } else {
        number.floor() as u64
    }
}

fn feed_list(channel: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for field in FEED_FIELDS {
        let value = js::get(channel, field);
        let list: Vec<&Value> = match value {
            Value::Array(items) => items.iter().collect(),
            other => vec![other],
        };
        for item in list {
            if let Some(text) = item.as_str() {
                let text = js::trim(text);
                if !text.is_empty() && seen.insert(text.to_string()) {
                    merged.push(text.to_string());
                }
            }
        }
    }
    merged
}

fn auth_defaults(root: &Value) -> Obj {
    let mut out = Obj::new();
    for key in ["Token", "x-super-properties", "cookie"] {
        if let Some(text) = js::trimmed_str(js::path(root, &["Auth", key])) {
            out.insert(key.into(), Value::String(text.into()));
        }
    }
    out
}

fn normalize_discord(discord: &Value, defaults: &Obj) -> Option<Value> {
    let local = discord.as_object()?;
    let mut merged = defaults.clone();
    merged.extend(local.clone());
    for key in [
        "Webhook",
        "Token",
        "GuildID",
        "cookie",
        "x-super-properties",
    ] {
        if let Some(value) = merged.get(key).filter(|v| truthy(v)).cloned() {
            merged.insert(
                key.into(),
                Value::String(js::trim(&js::to_string(&value)).to_string()),
            );
        }
    }
    let thread = normalize_thread(merged.get("Thread").unwrap_or(&Value::Null));
    merged.insert("Thread".into(), thread.map_or(Value::Null, Value::String));
    if let Some(Value::Array(ids)) = merged.get("ChannelIDs") {
        let ids: Vec<Value> = ids
            .iter()
            .filter_map(js::trimmed_str)
            .map(|id| Value::String(id.into()))
            .collect();
        merged.insert("ChannelIDs".into(), Value::Array(ids));
    }
    if let Some(Value::String(id)) = merged.get("ChannelID") {
        let id = id.trim().to_string();
        merged.insert("ChannelID".into(), Value::String(id));
    }
    Some(Value::Object(merged))
}

fn merge_telegram(root: &Value, local: &Value) -> Option<Telegram> {
    let root = root.as_object();
    let local = local.as_object();
    if root.is_none() && local.is_none() {
        return None;
    }
    let mut merged = root.cloned().unwrap_or_default();
    merged.extend(local.cloned().unwrap_or_default());
    for key in ["BotToken", "ChatID"] {
        if let Some(Value::String(text)) = local.and_then(|l| l.get(key))
            && text.trim().is_empty()
        {
            let fallback = root
                .and_then(|r| r.get(key))
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or(Value::String(String::new()));
            merged.insert(key.into(), fallback);
        }
    }
    let get = |key: &str| merged.get(key).unwrap_or(&Value::Null);
    let thread = js::to_number(get("MessageThreadID"));
    let timeout = js::to_number(get("TimeoutMs"));
    let timeout_value = get("TimeoutMs");
    Some(Telegram {
        enabled: get("Enabled") != &Value::Bool(false),
        bot_token: match get("BotToken") {
            Value::String(s) => s.trim().to_string(),
            v => js::to_string_or_empty(v),
        },
        chat_id: match get("ChatID") {
            Value::Null => String::new(),
            v => js::trim(&js::to_string(v)).to_string(),
        },
        message_thread_id: (!get("MessageThreadID").is_null()
            && thread.is_finite()
            && thread.fract() == 0.0
            && thread > 0.0)
            .then_some(thread as u64),
        disable_preview: get("DisableWebPagePreview") == &Value::Bool(true),
        send_photo: get("SendPhoto") != &Value::Bool(false),
        timeout_ms: if !timeout_value.is_null() && timeout.is_finite() && timeout > 0.0 {
            (timeout.floor() as u64).max(1)
        } else {
            15_000
        },
    })
}

fn build_from_shorthand(input: &Value, defaults: &Value) -> Option<Obj> {
    let mut base = defaults.as_object().cloned().unwrap_or_default();
    match input {
        Value::String(_) | Value::Array(_) => {
            base.insert(
                "Feeds".into(),
                match input {
                    Value::String(_) => Value::Array(vec![input.clone()]),
                    other => other.clone(),
                },
            );
            Some(base)
        }
        Value::Object(map) => {
            base.extend(map.clone());
            for key in ["Discord", "Telegram"] {
                let from_defaults = js::get(defaults, key);
                let from_input = js::get(input, key);
                if truthy(from_defaults) || truthy(from_input) {
                    let mut merged = from_defaults.as_object().cloned().unwrap_or_default();
                    merged.extend(from_input.as_object().cloned().unwrap_or_default());
                    base.insert(key.into(), Value::Object(merged));
                }
            }
            Some(base)
        }
        _ => None,
    }
}

fn non_negative(value: &Value) -> Option<usize> {
    let n = js::to_number(value);
    (!value.is_null() && n.is_finite() && n >= 0.0).then(|| n.floor() as usize)
}

fn first_run_send(raw: &Value, root: &Value) -> usize {
    non_negative(js::get(raw, "FirstRunSend"))
        .or_else(|| non_negative(js::get(js::get(root, "Settings"), "FirstRunSend")))
        .unwrap_or(0)
}

fn explicit_id(raw: &Value) -> Option<String> {
    ["CacheKey", "Key", "ID"]
        .iter()
        .find_map(|key| js::trimmed_str(js::get(raw, key)).map(str::to_string))
}

fn fingerprint_key(channel: &Channel, legacy: bool) -> String {
    let discord = channel.discord.as_ref().map_or(Value::Null, |d| {
        let ids = match js::get(d, "ChannelIDs") {
            ids @ Value::Array(_) => ids.clone(),
            _ => js::or_else(&[js::get(d, "ChannelID")], Value::Null),
        };
        json!({
            "channelIds": ids,
            "guildId": js::or_else(&[js::get(d, "GuildID")], json!("")),
            "webhook": js::or_else(&[js::get(d, "Webhook")], json!("")),
            "thread": js::or_else(&[js::get(d, "Thread")], Value::Null),
        })
    });
    let mut fingerprint = json!({
        "sourceKey": channel.source_key,
        "name": channel.name.clone().unwrap_or_default(),
        "feeds": channel.feeds,
        "webhook": channel.webhook,
        "thread": channel.thread.clone().filter(|t| !t.is_empty()),
        "discord": discord,
    });
    let raw = &channel.raw;
    if legacy {
        let matrix = js::get(raw, "Matrix");
        fingerprint["matrix"] = if truthy(matrix) {
            json!({
                "enabled": js::get(matrix, "Enabled") != &Value::Bool(false),
                "homeserver": js::or_else(&[js::get(matrix, "Homeserver")], json!("")),
                "roomId": js::or_else(&[js::get(matrix, "RoomID")], json!("")),
                "msgType": js::or_else(&[js::get(matrix, "MsgType")], json!("")),
            })
        } else {
            Value::Null
        };
    } else {
        fingerprint["telegram"] = channel.telegram.as_ref().map_or(Value::Null, |tg| {
            json!({
                "enabled": tg.enabled,
                "chatId": tg.chat_id,
                "messageThreadId": tg.message_thread_id.map_or(json!(""), |id| json!(id)),
                "disableWebPagePreview": tg.disable_preview,
            })
        });
    }
    let digest = Sha1::digest(js::stable_stringify(&fingerprint).as_bytes());
    let digest = &hex::encode(digest)[..12];
    format!(
        "{}:{}",
        channel.source_key,
        channel.name.clone().unwrap_or_else(|| digest.to_string())
    )
}

pub fn collect_channels(root: &Value) -> Vec<Channel> {
    let defaults = [
        js::get(root, "ChannelDefaults"),
        js::get(root, "DefaultChannel"),
    ]
    .into_iter()
    .find(|v| v.is_object())
    .cloned()
    .unwrap_or(Value::Object(Map::new()));
    let auth = auth_defaults(root);
    let mut built: Vec<(String, usize, Option<String>, Obj)> = Vec::new();
    for (key, value) in channel_groups(root) {
        match value {
            Value::Array(items) => {
                for (position, item) in items.iter().enumerate() {
                    if let Some(channel) = build_from_shorthand(item, &defaults) {
                        built.push((key.clone(), position, None, channel));
                    }
                }
            }
            Value::Object(map) => {
                for (position, (name, item)) in map.iter().enumerate() {
                    if let Some(channel) = build_from_shorthand(item, &defaults) {
                        built.push((key.clone(), position, Some(name.clone()), channel));
                    }
                }
            }
            _ => {}
        }
    }
    built
        .into_iter()
        .enumerate()
        .map(|(index, (source_key, position, name, object))| {
            let raw = Value::Object(object);
            let mut channel = Channel {
                index,
                position,
                name,
                display: js::trimmed_str(js::get(&raw, "Label"))
                    .filter(|l| !l.is_empty())
                    .map(|l| js::prefix16(l, 60).to_string()),
                webhook: js::get(&raw, "Webhook")
                    .as_str()
                    .map(|s| js::trim(s).to_string())
                    .unwrap_or_default(),
                thread: normalize_thread(js::get(&raw, "Thread")),
                feeds: feed_list(&raw),
                time_checker: positive_floor(js::get(&raw, "TimeChecker"), 30),
                request_send: positive_floor(js::get(&raw, "RequestSend"), 5) as usize,
                first_run_send: first_run_send(&raw, root),
                filter: crate::filter::Filter::parse(js::get(&raw, "Filters")).0,
                ping: crate::ping::Ping::parse(js::get(&raw, "Ping")).0,
                adaptive: crate::adaptive::from_config(&raw, root),
                discord: normalize_discord(js::get(&raw, "Discord"), &auth),
                telegram: merge_telegram(js::get(root, "Telegram"), js::get(&raw, "Telegram")),
                source_key,
                raw,
                cache_key: String::new(),
                legacy_cache_key: None,
            };
            match explicit_id(&channel.raw) {
                Some(id) => channel.cache_key = id,
                None => {
                    channel.cache_key = fingerprint_key(&channel, false);
                    let legacy = fingerprint_key(&channel, true);
                    if legacy != channel.cache_key {
                        channel.legacy_cache_key = Some(legacy);
                    }
                }
            }
            channel
        })
        .collect()
}

pub fn validate_channels(channels: &[Channel]) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut seen: HashMap<&str, String> = HashMap::new();
    for channel in channels {
        let label = channel.label();
        if !channel.has_webhook() && !channel.has_telegram() {
            warnings.push(format!(
                "[Config] {label}: missing delivery target (Webhook or complete Telegram config)."
            ));
        }
        if channel.feeds.is_empty() && channel.discord.is_none() {
            warnings.push(format!(
                "[Config] {label}: missing feed sources or Discord source."
            ));
        }
        if let Some(discord) = &channel.discord {
            let has_ids = match js::get(discord, "ChannelIDs") {
                Value::Array(ids) => !ids.is_empty(),
                _ => js::trimmed_str(js::get(discord, "ChannelID")).is_some(),
            };
            if !has_ids {
                warnings.push(format!(
                    "[Config] {label}: Discord source is enabled but ChannelIDs are missing."
                ));
            }
            if js::to_string_or_empty(js::get(discord, "Token"))
                .trim()
                .is_empty()
            {
                warnings.push(format!("[Config] {label}: Discord source is enabled but Token is missing (global Auth also counts)."));
            }
        }
        if let Some(tg) = &channel.telegram
            && tg.enabled
            && !tg.is_target()
        {
            warnings.push(format!(
                "[Config] {label}: Telegram is enabled but BotToken or ChatID is missing."
            ));
        }
        for problem in crate::filter::Filter::parse(js::get(&channel.raw, "Filters")).1 {
            warnings.push(format!("[Config] {label}: {problem}"));
        }
        for problem in crate::ping::Ping::parse(js::get(&channel.raw, "Ping")).1 {
            warnings.push(format!("[Config] {label}: {problem}"));
        }
        match seen.get(channel.cache_key.as_str()) {
            Some(other) => warnings.push(format!("[Config] {label}: cache key collision with {other}. Set explicit ID/CacheKey for one of them.")),
            None => {
                seen.insert(&channel.cache_key, label);
            }
        }
    }
    warnings
}

pub fn unsupported_sections(root: &Value, channels: &[Channel]) -> Vec<String> {
    let mut warnings: Vec<String> = Vec::new();
    let mut report = |label: String| {
        let text = format!(
            "Unsupported configuration section \"{label}\" is not executed. Supported delivery destinations: Discord, Telegram."
        );
        if !warnings.contains(&text) {
            warnings.push(text);
        }
    };
    for (key, value) in root.as_object().into_iter().flatten() {
        if !RESERVED_ROOT.contains(&key.as_str())
            && !is_channel_group(key, value)
            && value.is_object()
        {
            report(key.clone());
        }
    }
    let mut inspect = |raw: &Value, label: &str| {
        for (key, value) in raw.as_object().into_iter().flatten() {
            if !CHANNEL_HINTS[..13].contains(&key.as_str())
                && !matches!(key.as_str(), "Filters" | "AdaptivePolling" | "Ping")
                && value.is_object()
            {
                report(format!("{label}.{key}"));
            }
        }
    };
    inspect(js::get(root, "ChannelDefaults"), "ChannelDefaults");
    inspect(js::get(root, "DefaultChannel"), "DefaultChannel");
    for channel in channels {
        inspect(&channel.raw, &channel.label());
    }
    warnings
}

/// Full validation for `--check-config` and the dashboard (errors, warnings).
pub fn validate(raw: &Value, env: &Env) -> (Vec<String>, Vec<String>, Vec<Issue>) {
    let shape = match runtime_shape(raw) {
        Ok(shape) => shape,
        Err(issues) => {
            let errors = issues
                .iter()
                .map(|i| crate::diag::sanitize_text(&format!("{}: {}", i.path, i.message)))
                .collect();
            return (errors, Vec::new(), issues);
        }
    };
    let resolved = resolve_env(&shape, env);
    let channels = collect_channels(&resolved);
    let mut errors: Vec<String> = match normalize_network(js::get(&resolved, "network")) {
        Ok(_) => Vec::new(),
        Err(issues) => issues
            .iter()
            .map(|i| format!("{}: {}", i.path, i.message))
            .collect(),
    };
    let positive = |value: &Value| {
        let n = js::to_number(value);
        n.is_finite() && n.fract() == 0.0 && n > 0.0
    };
    let defaults = [
        js::get(&resolved, "ChannelDefaults"),
        js::get(&resolved, "DefaultChannel"),
    ]
    .into_iter()
    .find(|v| truthy(v))
    .unwrap_or(&js::NULL);
    for (key, label) in [
        ("TimeChecker", "Default check interval"),
        ("RequestSend", "Default maximum entries"),
    ] {
        let value = js::get(defaults, key);
        if !value.is_null() && !positive(value) {
            errors.push(format!("{label} must be a positive whole number."));
        }
    }
    for channel in &channels {
        for (key, label) in [
            ("TimeChecker", "Check interval"),
            ("RequestSend", "Maximum entries"),
        ] {
            let value = js::get(&channel.raw, key);
            if !value.is_null() && !positive(value) {
                errors.push(format!(
                    "{}: {label} must be a positive whole number.",
                    channel
                        .name
                        .clone()
                        .unwrap_or_else(|| channel.source_key.clone())
                ));
            }
        }
    }
    let whole = |value: &Value| {
        let n = js::to_number(value);
        value.is_null() || (n.is_finite() && n.fract() == 0.0 && n >= 0.0)
    };
    if !whole(js::get(js::get(&resolved, "Settings"), "FirstRunSend")) {
        errors.push("Settings.FirstRunSend must be a whole number (0 or more).".into());
    }
    for channel in &channels {
        if !whole(js::get(&channel.raw, "FirstRunSend")) {
            errors.push(format!(
                "{}: FirstRunSend must be a whole number (0 or more).",
                channel.label()
            ));
        }
    }
    let mut warnings = unsupported_sections(&resolved, &channels);
    warnings.extend(validate_channels(&channels));
    let clean = |list: Vec<String>| {
        list.iter()
            .map(|text| crate::diag::sanitize_text(text))
            .collect()
    };
    (clean(errors), clean(warnings), Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_is_the_place_in_the_group() {
        let hook = "https://discord.com/api/webhooks/1/a";
        let root = serde_json::json!({
            "channels": [{ "Webhook": hook, "RSS": ["https://a.example/feed"] }, { "Webhook": hook, "RSS": "https://c.example/feed" }],
            "channels2": { "x": { "Webhook": hook, "RSS": "https://b.example/feed" }, "y": { "Webhook": hook, "RSS": "https://d.example/feed" } }
        });
        let found: Vec<(String, usize, usize)> = collect_channels(&root)
            .iter()
            .map(|c| (c.source_key.clone(), c.index, c.position))
            .collect();
        assert_eq!(
            found,
            [
                ("channels".into(), 0, 0),
                ("channels".into(), 1, 1),
                ("channels2".into(), 2, 0),
                ("channels2".into(), 3, 1)
            ]
        );
    }

    #[test]
    fn dotenv_parsing() {
        let env = parse_dotenv("# c\nA=1\n B = \"two\" \nbad line\n1X=3\nC='x'\n");
        assert_eq!(env.get("A").map(String::as_str), Some("1"));
        assert_eq!(env.get("B").map(String::as_str), Some("two"));
        assert_eq!(env.get("C").map(String::as_str), Some("x"));
        assert!(!env.contains_key("1X"));
    }

    #[test]
    fn legacy_and_current_cache_keys() {
        // Values verified against the Node.js implementations.
        let root = json!({
            "channels": [{ "Webhook": "https://discord.com/api/webhooks/1/x", "Thread": "42", "RSS": ["https://a.example/feed"] }]
        });
        let channels = collect_channels(&root);
        assert_eq!(channels.len(), 1);
        let channel = &channels[0];
        assert!(channel.cache_key.starts_with("channels:"));
        assert!(
            channel
                .legacy_cache_key
                .as_ref()
                .is_some_and(|k| k.starts_with("channels:") && k != &channel.cache_key)
        );
        assert_eq!(channel.time_checker, 30);
        assert_eq!(channel.request_send, 5);
        assert_eq!(channel.thread.as_deref(), Some("42"));
    }

    #[test]
    fn named_channels_use_names_and_defaults() {
        let root = json!({
            "ChannelDefaults": { "TimeChecker": 10, "RequestSend": 2 },
            "channels": { "main": { "Feeds": ["https://a/f", "https://a/f"], "Webhook": " https://w " } },
            "Scrapling": { "Enabled": true }
        });
        let channels = collect_channels(&root);
        assert_eq!(channels[0].cache_key, "channels:main");
        assert_eq!(channels[0].feeds, vec!["https://a/f".to_string()]);
        assert_eq!(channels[0].webhook, "https://w");
        assert_eq!(channels[0].time_checker, 10);
    }

    #[test]
    fn network_defaults_and_errors() {
        let net = normalize_network(&Value::Null).unwrap();
        assert_eq!(net.setup_timeout_ms, 15_000);
        assert_eq!(net.http_concurrency(), None);
        assert!(normalize_network(&json!({ "bogus": 1 })).is_err());
        let low = normalize_network(&json!({ "bandwidthProfile": "low" })).unwrap();
        assert_eq!(low.download_bytes_per_second, Some(250_000.0));
    }

    #[test]
    fn v2_conversion() {
        let v2 = json!({
            "schemaVersion": 2, "settings": { "logs": true }, "integrations": {},
            "channels": { "news": { "sources": [{ "type": "feed", "url": "https://a/f" }],
                "destinations": [{ "type": "webhook", "url": "https://w", "threadId": "9" }] } }
        });
        let legacy = v2_to_legacy(&v2).unwrap();
        let channels = collect_channels(&legacy);
        assert_eq!(channels[0].cache_key, "channels:news");
        assert_eq!(channels[0].thread.as_deref(), Some("9"));
    }
}
