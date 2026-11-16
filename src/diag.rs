//! Secret-safe logging. Every message that can contain a URL or provider text
//! passes through `sanitize_text` before it reaches stdout/journald.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use regex::Regex;
use serde_json::Value;
use url::Url;

static EXPERT: AtomicBool = AtomicBool::new(false);
static LOGS: AtomicBool = AtomicBool::new(true);

pub fn set_expert(enabled: bool) {
    EXPERT.store(enabled, Ordering::Relaxed);
}

pub fn expert_enabled() -> bool {
    EXPERT.load(Ordering::Relaxed)
}

/// `Settings.Logs`: verbose informational output. Warnings and errors are
/// always printed.
pub fn set_verbose(enabled: bool) {
    LOGS.store(enabled, Ordering::Relaxed);
}

pub fn verbose() -> bool {
    LOGS.load(Ordering::Relaxed) || expert_enabled()
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

const SENSITIVE_QUERY: &str =
    r"(?i)(token|secret|password|auth|key|signature|sig|credential|cookie)";

pub fn sanitize_url(input: &str) -> String {
    static TRAIL: OnceLock<Regex> = OnceLock::new();
    static QUERY: OnceLock<Regex> = OnceLock::new();
    static BOT: OnceLock<Regex> = OnceLock::new();
    static HOOK: OnceLock<Regex> = OnceLock::new();
    static BOT_RAW: OnceLock<Regex> = OnceLock::new();
    static HOOK_RAW: OnceLock<Regex> = OnceLock::new();
    let trailing = re(&TRAIL, r"[),.;]+$")
        .find(input)
        .map_or("", |m| m.as_str());
    let candidate = &input[..input.len() - trailing.len()];
    if let Ok(mut parsed) = Url::parse(candidate) {
        let _ = parsed.set_username("");
        let _ = parsed.set_password(None);
        let query = re(&QUERY, SENSITIVE_QUERY);
        if parsed.query().is_some() {
            let pairs: Vec<(String, String)> = parsed
                .query_pairs()
                .map(|(key, value)| {
                    let value = if query.is_match(&key) {
                        "[REDACTED]".to_string()
                    } else {
                        value.into_owned()
                    };
                    (key.into_owned(), value)
                })
                .collect();
            if pairs.iter().any(|(_, value)| value == "[REDACTED]") {
                parsed.query_pairs_mut().clear().extend_pairs(pairs);
            }
        }
        let path = parsed.path().to_string();
        let path = re(&BOT, r"(?i)/bot[^/]+/").replace(&path, "/bot[REDACTED]/");
        let path = re(&HOOK, r"(?i)(/webhooks/\d+/)[^/]+").replace(&path, "${1}[REDACTED]");
        parsed.set_path(&path);
        return format!("{parsed}{trailing}");
    }
    let value =
        re(&BOT_RAW, r"(?i)(bot\d+:)[A-Za-z0-9_-]{20,}").replace_all(input, "${1}[REDACTED]");
    re(&HOOK_RAW, r"(?i)(/webhooks/\d+/)[^/?\s]+")
        .replace_all(&value, "${1}[REDACTED]")
        .into_owned()
}

pub fn sanitize_text(value: &str) -> String {
    static URLS: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static BOT: OnceLock<Regex> = OnceLock::new();
    static TG: OnceLock<Regex> = OnceLock::new();
    static KV: OnceLock<Regex> = OnceLock::new();
    let text = re(&URLS, r#"(?i)https?://[^\s<>"'`]+"#)
        .replace_all(value, |caps: &regex::Captures| sanitize_url(&caps[0]));
    let text =
        re(&BEARER, r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+").replace_all(&text, "Bearer [REDACTED]");
    let text = re(&BOT, r"(?i)\b(bot\d+:)[A-Za-z0-9_-]{20,}").replace_all(&text, "${1}[REDACTED]");
    let text =
        re(&TG, r"\b\d{6,}:[A-Za-z0-9_-]{20,}\b").replace_all(&text, "[REDACTED TELEGRAM TOKEN]");
    re(
        &KV,
        r"(?i)((?:token|secret|password|cookie|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+",
    )
    .replace_all(&text, "${1}[REDACTED]")
    .into_owned()
}

/// Recursively redact a JSON value for diagnostics.
pub fn sanitize_value(value: &Value, key: &str, depth: usize) -> Value {
    static KEY: OnceLock<Regex> = OnceLock::new();
    if re(
        &KEY,
        r"(?i)(token|secret|password|cookie|authorization|credential|api[_-]?key|webhook)",
    )
    .is_match(key)
    {
        return Value::String("[REDACTED]".into());
    }
    match value {
        Value::String(text) => {
            let lower = key.to_ascii_lowercase();
            if lower.contains("url") || lower.contains("uri") || lower.contains("href") {
                Value::String(sanitize_url(text))
            } else {
                Value::String(sanitize_text(text))
            }
        }
        Value::Array(items) if depth < 6 => Value::Array(
            items
                .iter()
                .take(50)
                .map(|item| sanitize_value(item, "", depth + 1))
                .collect(),
        ),
        Value::Object(map) if depth < 6 => Value::Object(
            map.iter()
                .take(100)
                .map(|(child, item)| (child.clone(), sanitize_value(item, child, depth + 1)))
                .collect(),
        ),
        Value::Array(_) | Value::Object(_) => Value::String("[Max depth]".into()),
        other => other.clone(),
    }
}

pub fn emit(level: &str, scope: &str, message: &str, details: Option<&Value>) {
    if level == "info" && !verbose() {
        return;
    }
    let message = sanitize_text(message).replace(['\r', '\n'], " ");
    let line = match details {
        Some(details) => format!(
            "[{scope}][{level}] {message} {}",
            sanitize_value(details, "", 0)
        ),
        None => format!("[{scope}][{level}] {message}"),
    };
    if level == "info" {
        println!("{line}");
    } else {
        eprintln!("{line}");
    }
}

/// Expert diagnostics: structured, redacted, only with `--debug-expert`.
pub fn expert(event: &str, details: Value) {
    crate::telemetry::observe(event, &details);
    if !expert_enabled() {
        return;
    }
    let mut payload = serde_json::Map::new();
    payload.insert(
        "time".into(),
        Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    payload.insert("event".into(), Value::String(event.into()));
    if let Value::Object(map) = sanitize_value(&details, "", 0) {
        payload.extend(map);
    }
    println!("[Expert] {}", Value::Object(payload));
}

#[macro_export]
macro_rules! info {
    ($scope:expr, $($arg:tt)*) => { $crate::diag::emit("info", $scope, &format!($($arg)*), None) };
}
#[macro_export]
macro_rules! warn {
    ($scope:expr, $($arg:tt)*) => { $crate::diag::emit("warn", $scope, &format!($($arg)*), None) };
}
#[macro_export]
macro_rules! error {
    ($scope:expr, $($arg:tt)*) => { $crate::diag::emit("error", $scope, &format!($($arg)*), None) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_webhooks_and_bot_tokens() {
        assert_eq!(
            sanitize_url("https://discord.com/api/webhooks/123/abcDEF?wait=true"),
            "https://discord.com/api/webhooks/123/[REDACTED]?wait=true"
        );
        assert_eq!(
            sanitize_url("https://api.telegram.org/bot123:ABCdefghijklmnopqrstuvwx/sendMessage"),
            "https://api.telegram.org/bot[REDACTED]/sendMessage"
        );
        assert_eq!(
            sanitize_url("https://x.io/feed?token=abc&a=1"),
            "https://x.io/feed?token=%5BREDACTED%5D&a=1"
        );
        assert_eq!(
            sanitize_text("password=hunter2 ok"),
            "password=[REDACTED] ok"
        );
    }
}
