//! Server-rendered dashboard UI: plain HTML pages and form posts, no
//! JavaScript. Every page is built here from the same config, `.env`,
//! activity and diagnostics files the JSON API reads.
//!
//! Mutating requests are POST forms; they are accepted only from the same
//! origin (checked by the caller) and carry the config revision they were
//! rendered from, so a concurrent edit is never overwritten.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Map, Value, json};

use super::{
    Server, network_runtime, public_metrics, read_activity, read_json, read_text, replace_secret,
    reserved_secret, revision, runtime_channels, secret_status, structured_activity, validation,
    worker_ready, write_private,
};
use crate::config;
use crate::diag::sanitize_text;
use crate::js;

const STYLES: &str = include_str!("styles.css");
const FAVICON: &str = include_str!("favicon.svg");
/// Channel keys edited through dedicated form fields.
const FEED_KEYS: [&str; 4] = ["RSS", "Feeds", "URLs", "Sources"];
const HANDLED: [&str; 10] = [
    "Label",
    "RSS",
    "Feeds",
    "URLs",
    "Sources",
    "Webhook",
    "Thread",
    "TimeChecker",
    "RequestSend",
    "FirstRunSend",
];

/// Request data the pages need.
pub(super) struct Req<'a> {
    pub method: &'a Method,
    pub path: &'a str,
    pub query: &'a HashMap<String, String>,
    pub form: HashMap<String, String>,
    pub headers: &'a HeaderMap,
    pub authorized: bool,
    pub auth_required: bool,
    /// Same-origin check for form posts passed.
    pub can_post: bool,
}

impl Req<'_> {
    fn q(&self, key: &str) -> &str {
        self.query.get(key).map_or("", String::as_str)
    }
    fn f(&self, key: &str) -> &str {
        self.form.get(key).map_or("", String::as_str)
    }
    fn checked(&self, key: &str) -> bool {
        self.form.contains_key(key)
    }
}

pub(super) fn parse_form(body: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect()
}

// ------------------------------------------------------------- primitives --

/// HTML-escape text for element content and quoted attributes.
pub(super) fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn enc(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

fn html(status: StatusCode, body: String) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .expect("response")
}

fn asset(mime: &'static str, body: &'static str) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=300")
        .body(Body::from(body))
        .expect("response")
}

/// POST-redirect-GET with a one-line notice.
fn redirect(to: &str, notice: &str, error: bool) -> Response {
    let mut location = to.to_string();
    if !notice.is_empty() {
        location.push(if to.contains('?') { '&' } else { '?' });
        let _ = write!(
            location,
            "{}={}",
            if error { "error" } else { "ok" },
            enc(notice)
        );
    }
    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("response")
}

fn redirect_with_cookie(to: &str, cookie: &str) -> Response {
    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, to)
        .header(header::SET_COOKIE, cookie)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("response")
}

const NAV: [(&str, &str); 7] = [
    ("/", "Overview"),
    ("/channels", "Channels"),
    ("/posts", "Posts"),
    ("/activity", "Activity"),
    ("/diagnostics", "Diagnostics"),
    ("/settings", "Settings"),
    ("/advanced", "Advanced"),
];

fn layout(req: &Req, title: &str, body: &str, refresh: Option<u32>) -> String {
    let mut out = String::new();
    let _ = write!(
        out,
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{} · XFeeder</title><link rel=\"stylesheet\" href=\"/styles.css\">\
         <link rel=\"icon\" href=\"/favicon.svg\">",
        esc(title)
    );
    if let Some(seconds) = refresh {
        let _ = write!(out, "<meta http-equiv=\"refresh\" content=\"{seconds}\">");
    }
    out.push_str("</head><body><header><a class=\"brand\" href=\"/\">XFeeder</a>");
    let lang = super::i18n::from_headers(req.headers);
    // Language switch: the current page in the other language (without
    // the one-time ok/error notice).
    let mut query: Vec<String> = req
        .query
        .iter()
        .filter(|(k, _)| !matches!(k.as_str(), "ok" | "error"))
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect();
    query.sort();
    let back = enc(&if query.is_empty() {
        req.path.to_string()
    } else {
        format!("{}?{}", req.path, query.join("&"))
    });
    let _ = write!(
        out,
        "<span class=\"lang\" aria-label=\"Language\">{}</span>",
        [("en", "EN"), ("pl", "PL")]
            .iter()
            .map(|(code, label)| if *code == lang.code() {
                format!("<strong>{label}</strong>")
            } else {
                format!("<a href=\"/lang?to={code}&amp;back={back}\" lang=\"{code}\">{label}</a>")
            })
            .collect::<Vec<_>>()
            .join(" · ")
    );
    if req.authorized {
        out.push_str("<nav>");
        for (href, label) in NAV {
            let active = if href == "/" {
                req.path == "/"
            } else {
                req.path.starts_with(href)
            };
            let _ = write!(
                out,
                "<a href=\"{href}\"{}>{label}</a>",
                if active { " aria-current=\"page\"" } else { "" }
            );
        }
        out.push_str("</nav>");
        if req.auth_required {
            out.push_str(
                "<form method=\"post\" action=\"/logout\" class=\"inline\"><button class=\"link\">Log out</button></form>",
            );
        }
    }
    out.push_str("</header><main>");
    for (key, class) in [("ok", "notice ok"), ("error", "notice error")] {
        let text = req.q(key);
        if !text.is_empty() {
            let _ = write!(
                out,
                "<p class=\"{class}\" role=\"status\">{}</p>",
                esc(&text.chars().take(400).collect::<String>())
            );
        }
    }
    // Every table sits in a framed box that scrolls sideways on narrow screens.
    let body = body
        .replace("<table>", "<div class=\"table\"><table>")
        .replace("</table>", "</table></div>");
    let _ = write!(out, "<h1>{}</h1>{body}</main>", esc(title));
    out.push_str("</body></html>");
    if lang == super::i18n::Lang::Pl {
        return super::i18n::to_polish(&out);
    }
    out
}

fn page(req: &Req, status: StatusCode, title: &str, body: &str) -> Response {
    html(status, layout(req, title, body, None))
}

fn list(items: &[String], class: &str) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut out = format!("<ul class=\"{class}\">");
    for item in items {
        let _ = write!(out, "<li>{}</li>", esc(item));
    }
    out.push_str("</ul>");
    out
}

fn hidden(name: &str, value: &str) -> String {
    format!(
        "<input type=\"hidden\" name=\"{}\" value=\"{}\">",
        esc(name),
        esc(value)
    )
}

fn text_input(label: &str, name: &str, value: &str, hint: &str, kind: &str) -> String {
    format!(
        "<label>{}<input type=\"{kind}\" name=\"{}\" value=\"{}\"{}>{}</label>",
        esc(label),
        esc(name),
        esc(value),
        if kind == "number" { " min=\"0\"" } else { "" },
        if hint.is_empty() {
            String::new()
        } else {
            format!("<small>{}</small>", esc(hint))
        }
    )
}

fn textarea(label: &str, name: &str, value: &str, rows: u32, hint: &str) -> String {
    format!(
        "<label>{}<textarea name=\"{}\" rows=\"{rows}\" spellcheck=\"false\">{}</textarea>{}</label>",
        esc(label),
        esc(name),
        esc(value),
        if hint.is_empty() {
            String::new()
        } else {
            format!("<small>{}</small>", esc(hint))
        }
    )
}

fn checkbox(label: &str, name: &str, checked: bool) -> String {
    format!(
        "<label class=\"check\"><input type=\"checkbox\" name=\"{}\" value=\"1\"{}> {}</label>",
        esc(name),
        if checked { " checked" } else { "" },
        esc(label)
    )
}

fn ms(value: f64) -> String {
    if value >= 60_000.0 {
        format!("{:.1} min", value / 60_000.0)
    } else if value >= 1000.0 {
        format!("{:.1} s", value / 1000.0)
    } else {
        format!("{value:.0} ms")
    }
}

fn ago(time: &str) -> String {
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(time) else {
        return "–".into();
    };
    let secs = (chrono::Utc::now().timestamp_millis() - at.timestamp_millis()) / 1000;
    match secs {
        s if s < 0 => "just now".into(),
        s if s < 90 => format!("{s} s ago"),
        s if s < 5400 => format!("{} min ago", s / 60),
        s if s < 172_800 => format!("{} h ago", s / 3600),
        s => format!("{} days ago", s / 86_400),
    }
}

// ------------------------------------------------------------ config I/O --

struct Problems {
    errors: Vec<String>,
    warnings: Vec<String>,
}

fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other
                    .get("message")
                    .and_then(Value::as_str)
                    .map_or_else(|| other.to_string(), str::to_string),
            })
            .collect(),
        _ => Vec::new(),
    }
}

impl Server {
    fn problems(&self, next: &Value) -> Problems {
        let result = validation(next, &self.paths.env);
        let mut errors = strings(&result["errors"]);
        if result["runtimeSupported"] == json!(false) {
            errors.extend(result["issues"].as_array().into_iter().flatten().map(|i| {
                format!(
                    "{}: {}",
                    js::to_string(&i["path"]),
                    js::to_string(&i["message"])
                )
            }));
        }
        Problems {
            errors,
            warnings: strings(&result["warnings"]),
        }
    }

    /// Validate and write; `Err` carries what to show the user.
    fn store(&self, next: &Value, original: &str, accept: bool) -> Result<(), Problems> {
        let problems = self.problems(next);
        if !problems.errors.is_empty() || (!problems.warnings.is_empty() && !accept) {
            return Err(problems);
        }
        let mut text = format!(
            "{}\n",
            serde_json::to_string_pretty(next).unwrap_or_default()
        );
        if original.contains("\r\n") {
            text = text.replace('\n', "\r\n");
        }
        // One step back is always available: config.json.bak.
        if !original.is_empty() {
            let _ = write_private(&self.paths.config.with_extension("json.bak"), original);
        }
        write_private(&self.paths.config, &text).map_err(|e| Problems {
            errors: vec![sanitize_text(&e.to_string())],
            warnings: Vec::new(),
        })
    }

    fn diagnostics_dir(&self, config: &Value) -> PathBuf {
        let base = self.paths.config.parent().unwrap_or(Path::new("."));
        let shape = config::runtime_shape(config).unwrap_or_else(|_| json!({}));
        crate::diagnostics::Options::from_settings(js::get(&shape, "Settings"), base, true)
            .map_or_else(|| base.join("diagnostics"), |o| o.dir)
    }
}

fn problems_html(problems: &Problems, accept_hint: bool) -> String {
    let mut out = String::new();
    if !problems.errors.is_empty() {
        let _ = write!(
            out,
            "<div class=\"notice error\"><strong>Not saved, configuration errors:</strong>{}</div>",
            list(&problems.errors, "")
        );
    }
    if !problems.warnings.is_empty() {
        let _ = write!(
            out,
            "<div class=\"notice warn\"><strong>Warnings:</strong>{}{}</div>",
            list(&problems.warnings, ""),
            if accept_hint && problems.errors.is_empty() {
                "<p>Tick “Save despite warnings” to save anyway.</p>"
            } else {
                ""
            }
        );
    }
    out
}

fn stale(req: &Req, rev: &str) -> bool {
    req.f("rev") != rev
}

const STALE: &str =
    "The configuration changed on disk since this page was opened. Reload and try again.";

// ----------------------------------------------------------------- router --

pub(super) async fn handle(server: &Server, req: &Req<'_>) -> Response {
    match (req.method, req.path) {
        (&Method::GET, "/styles.css") => return asset("text/css; charset=utf-8", STYLES),
        (&Method::GET, "/favicon.svg") => return asset("image/svg+xml", FAVICON),
        // A display preference, not a state change: allowed before login.
        (&Method::GET, "/lang") => {
            let lang = if req.q("to") == "pl" { "pl" } else { "en" };
            let cookie = format!(
                "{}={lang}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
                super::i18n::COOKIE
            );
            return redirect_with_cookie(super::i18n::safe_back(req.q("back")), &cookie);
        }
        _ => {}
    }
    let post = *req.method == Method::POST;
    if post && !req.can_post {
        return page(
            req,
            StatusCode::FORBIDDEN,
            "Forbidden",
            "<p>Form posts are accepted only from this dashboard (same origin).</p>",
        );
    }
    match (post, req.path) {
        (false, "/login") => return login_page(req, ""),
        (true, "/login") => return login(server, req),
        (true, "/logout") => {
            let cookie = server.auth.logout(req.headers);
            return redirect_with_cookie("/login", &cookie);
        }
        _ => {}
    }
    if !req.authorized {
        return redirect("/login", "", false);
    }
    match (post, req.path) {
        (false, "/") => overview(server, req).await,
        (true, "/worker") => worker(server, req).await,
        (false, "/channels") => channels(server, req),
        (false, "/channels/edit") => channel_edit(server, req),
        (true, "/channels/save") => channel_save(server, req),
        (false, "/channels/delete") => channel_delete_confirm(server, req),
        (true, "/channels/delete") => channel_delete(server, req),
        (true, "/config/remove-section") => remove_section(server, req),
        (true, "/channels/duplicate") => channel_duplicate(server, req),
        (false, "/activity") => activity(server, req),
        (false, "/feed") => feed_page(server, req),
        (true, "/feed/test") => feed_test(server, req).await,
        (false, "/posts") => posts_page(server, req),
        (true, "/posts/rerender") => post_rerender(server, req).await,
        (false, "/diagnostics") => diagnostics(server, req),
        (false, "/settings") => settings(server, req, None),
        (true, "/settings/general") => settings_general(server, req),
        (true, "/settings/network") => settings_network(server, req),
        (true, "/settings/features") => settings_features(server, req),
        (true, "/settings/clearance-forget") => clearance_forget(server, req),
        (true, "/settings/secret") => settings_secret(server, req),
        (false, "/advanced") => advanced(server, req, None, None),
        (true, "/advanced") => advanced_save(server, req),
        _ => page(
            req,
            StatusCode::NOT_FOUND,
            "Not found",
            "<p><a href=\"/\">Back to the overview</a></p>",
        ),
    }
}

// ------------------------------------------------------------------ login --

fn login_page(req: &Req, error: &str) -> Response {
    if !req.auth_required || req.authorized {
        return redirect("/", "", false);
    }
    let body = format!(
        "{}<form method=\"post\" action=\"/login\" class=\"card narrow\">\
         <label>Dashboard password<input type=\"password\" name=\"password\" autocomplete=\"current-password\" required autofocus></label>\
         <button>Log in</button></form>",
        if error.is_empty() {
            String::new()
        } else {
            format!("<p class=\"notice error\">{}</p>", esc(error))
        }
    );
    page(
        req,
        if error.is_empty() {
            StatusCode::OK
        } else {
            StatusCode::UNAUTHORIZED
        },
        "Log in",
        &body,
    )
}

fn login(server: &Server, req: &Req) -> Response {
    if server.auth.reserve_login() > 0 {
        return login_page(req, "Too many login attempts. Try again in a minute.");
    }
    match server.auth.login(req.f("password")) {
        None => login_page(req, "Invalid dashboard password."),
        Some(Some(cookie)) => redirect_with_cookie("/", &cookie),
        Some(None) => redirect("/", "", false),
    }
}

// --------------------------------------------------------------- overview --

/// Telemetry stores channels and feeds as the first 16 hex characters of
/// their SHA-256; the dashboard has the config, so it can name them again.
fn pseudonym(text: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(text.as_bytes()))[..16].to_string()
}

/// `channel:<id>` / `feed:<id>` → channel label / short feed URL.
fn activity_names(config: &Value) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for channel in runtime_channels(config) {
        let label = channel.label();
        names.insert(format!("channel:{}", pseudonym(&label)), label);
        for url in &channel.feeds {
            names.insert(format!("feed:{}", pseudonym(url)), short_url(url));
        }
    }
    names
}

/// `host/path` without the scheme, shortened in the middle.
fn short_url(url: &str) -> String {
    let text = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.");
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 60 {
        text.to_string()
    } else {
        format!(
            "{}…{}",
            chars[..30].iter().collect::<String>(),
            chars[chars.len() - 25..].iter().collect::<String>()
        )
    }
}

/// Delivery key (as in cache.json / sent.json) → channel label. The key
/// covers the resolved webhook, so `${VAR}` values from `.env` are needed.
fn channel_labels(server: &Server, config: &Value) -> HashMap<String, String> {
    let channels = config::load(&server.paths.config)
        .map(|c| c.channels)
        .unwrap_or_else(|_| runtime_channels(config));
    let mut labels = HashMap::new();
    for channel in channels {
        if let Some(legacy) = &channel.legacy_cache_key {
            labels.insert(legacy.clone(), channel.label());
        }
        labels.insert(channel.cache_key.clone(), channel.label());
    }
    labels
}

// ------------------------------------------------------------------ feeds --

fn ms_time(ms: u64) -> String {
    if ms == 0 {
        return "–".into();
    }
    chrono::DateTime::from_timestamp_millis(ms as i64).map_or("–".into(), |d| ago(&d.to_rfc3339()))
}

fn failing_feeds_html(server: &Server) -> String {
    let mut rows = String::new();
    for (url, snapshot) in feed_snapshots(server) {
        let health = &snapshot["health"];
        let failures = health["consecutiveFailures"].as_u64().unwrap_or(0);
        if failures == 0 {
            continue;
        }
        let _ = write!(
            rows,
            "<tr><td><a href=\"/feed?url={}\">{}</a></td><td class=\"num\">{failures}</td><td>{}</td><td>{}</td></tr>",
            esc(&enc(&url)),
            esc(&short_url(&url)),
            esc(&ms_time(health["lastFailureAt"].as_u64().unwrap_or(0))),
            esc(&ms_time(health["lastSuccessAt"].as_u64().unwrap_or(0))),
        );
    }
    if rows.is_empty() {
        return String::new();
    }
    format!(
        "<section><h2>Feeds with problems</h2><table><thead><tr><th>Feed</th><th>Failures in a row</th><th>Last failure</th><th>Last success</th></tr></thead><tbody>{rows}</tbody></table></section>"
    )
}

fn feed_page(server: &Server, req: &Req) -> Response {
    let url = req.q("url").trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return page(
            req,
            StatusCode::NOT_FOUND,
            "Not found",
            "<p>Not an http(s) URL.</p>",
        );
    }
    let config = read_json(&server.paths.config);
    let snapshots = feed_snapshots(server);
    let snapshot = snapshots.get(url).cloned().unwrap_or(Value::Null);
    let channels: Vec<config::Channel> = config::load(&server.paths.config)
        .map(|c| c.channels)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.feeds.iter().any(|f| f == url))
        .collect();
    let mut body = format!(
        "<p><a href=\"{0}\" rel=\"noreferrer\"><code>{1}</code></a></p>\
         <form method=\"post\" action=\"/feed/test\" class=\"inline\">{2}<button>Test now</button></form> \
         <small class=\"muted\">Downloads the feed now, as the worker would (browser, solver and proxy included). Nothing is sent or saved.</small>",
        esc(url),
        esc(url),
        hidden("url", url),
    );
    // Where it is used and how often it is checked.
    body.push_str("<h2>Channels</h2>");
    if channels.is_empty() {
        body.push_str("<p class=\"muted\">Not used by any channel.</p>");
    } else {
        body.push_str("<table><thead><tr><th>Channel</th><th>Checked every</th><th>Why</th></tr></thead><tbody>");
        for channel in &channels {
            let (ms, why) = feed_interval(channel, &snapshot);
            let _ = write!(
                body,
                "<tr><td>{}</td><td>{} min</td><td>{}</td></tr>",
                esc(&channel.label()),
                minutes(ms),
                esc(why)
            );
        }
        body.push_str("</tbody></table>");
    }
    // Health and how it is fetched.
    let health = &snapshot["health"];
    let per_url = js::path(&config, &["Scrapling", "PerUrlConfig", url]);
    let browser = if per_url["enabled"] == json!(true) {
        "always (PerUrlConfig enabled)"
    } else if per_url["fallback"] == json!(true) {
        "only when blocked (PerUrlConfig fallback)"
    } else if per_url["enabled"] == json!(false) {
        "never (PerUrlConfig)"
    } else if js::path(&config, &["Scrapling", "AutoFallback"]) == &json!(false) {
        "never"
    } else {
        "only when blocked (AutoFallback)"
    };
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_start_matches("www.").to_string())
        })
        .unwrap_or_default();
    let clearance = read_json(
        &server
            .paths
            .config
            .parent()
            .unwrap_or(Path::new("."))
            .join("clearance.json"),
    )
    .get(&host)
    .map_or_else(
        || "none".to_string(),
        |c| {
            let saved = c["savedAt"].as_i64().unwrap_or(0) * 1000;
            let expires = c["expires"].as_i64().unwrap_or(0);
            let days = (expires - chrono::Utc::now().timestamp()) / 86_400;
            format!(
                "saved {}{}",
                ms_time(saved as u64),
                if expires > 0 {
                    format!(", valid for {days} more days")
                } else {
                    String::new()
                }
            )
        },
    );
    let _ = write!(
        body,
        "<h2>State</h2><table><tbody>\
         <tr><td>Failures in a row</td><td>{}</td></tr>\
         <tr><td>Last failure</td><td>{}</td></tr>\
         <tr><td>Last success after a failure</td><td>{}</td></tr>\
         <tr><td>Browser (Scrapling)</td><td>{}</td></tr>\
         <tr><td>Saved Cloudflare clearance</td><td>{}</td></tr>\
         <tr><td>ETag / Last-Modified</td><td><code>{}</code> / <code>{}</code></td></tr>\
         </tbody></table>",
        health["consecutiveFailures"].as_u64().unwrap_or(0),
        esc(&ms_time(health["lastFailureAt"].as_u64().unwrap_or(0))),
        esc(&ms_time(health["lastSuccessAt"].as_u64().unwrap_or(0))),
        esc(browser),
        esc(&clearance),
        esc(snapshot["etag"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("–")),
        esc(snapshot["lastModified"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("–")),
    );
    body.push_str("<h2>Last saved entries</h2>");
    body.push_str(&entries_table(
        snapshot["items"].as_array().map_or(&[][..], Vec::as_slice),
        5,
    ));
    page(
        req,
        StatusCode::OK,
        &format!("Feed {}", short_url(url)),
        &body,
    )
}

fn entries_table(items: &[Value], limit: usize) -> String {
    if items.is_empty() {
        return "<p class=\"muted\">No entries saved yet.</p>".into();
    }
    let mut out = String::from(
        "<table><thead><tr><th>Date</th><th>Entry</th><th>Author</th><th>Image</th></tr></thead><tbody>",
    );
    for item in items.iter().take(limit) {
        let link = js::to_string_or_empty(&item["link"]);
        let title = js::to_string_or_empty(&item["title"]);
        let image = js::to_string_or_empty(&item["enclosure"]);
        let _ = write!(
            out,
            "<tr><td>{}</td><td>{}<br><small class=\"muted\">{}</small></td><td>{}</td><td>{}</td></tr>",
            esc(&item["isoDate"].as_str().map_or("–".into(), ago)),
            if link.starts_with("http") {
                format!(
                    "<a href=\"{}\" rel=\"noreferrer\">{}</a>",
                    esc(&link),
                    esc(&title)
                )
            } else {
                esc(&title)
            },
            esc(js::prefix16(
                &js::to_string_or_empty(&item["contentSnippet"]),
                160
            )),
            esc(&js::to_string_or_empty(&item["author"])),
            if image.starts_with("http") {
                format!("<a href=\"{}\" rel=\"noreferrer\">image</a>", esc(&image))
            } else {
                "–".into()
            },
        );
    }
    out.push_str("</tbody></table>");
    out
}

static TEST_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Run `xfeeder preview` for one URL in a child process (same config).
async fn feed_test(server: &Server, req: &Req<'_>) -> Response {
    use std::sync::atomic::Ordering;
    let url = req.f("url").trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return redirect("/channels", "Not an http(s) URL.", true);
    }
    let back = format!("/feed?url={}", enc(&url));
    if TEST_RUNNING.swap(true, Ordering::SeqCst) {
        return redirect(
            &back,
            "Another test is running; try again in a moment.",
            true,
        );
    }
    let result = async {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let child = tokio::process::Command::new(exe)
            .args(["preview", &url, "--items", "5", "--json", "--config"])
            .arg(&server.paths.config)
            .current_dir(server.paths.config.parent().unwrap_or(Path::new(".")))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let output = tokio::time::timeout(std::time::Duration::from_secs(150), child)
            .await
            .map_err(|_| "The test took longer than 150 s.".to_string())?
            .map_err(|e| e.to_string())?;
        serde_json::from_slice::<Value>(&output.stdout)
            .map_err(|_| "The test gave no result.".to_string())
    }
    .await;
    TEST_RUNNING.store(false, Ordering::SeqCst);
    let data = match result {
        Ok(data) => data,
        Err(message) => return redirect(&back, &sanitize_text(&message), true),
    };
    let ms = |k: &str| {
        data["ms"][k]["median"]
            .as_u64()
            .map_or("–".into(), |v| ms(v as f64))
    };
    let transport = if data["scrapling"] == json!(true) {
        "browser (Scrapling)"
    } else {
        "plain HTTP"
    };
    let mut body = format!(
        "<p><a href=\"{back}\">← Back to the feed</a></p><table><tbody>\
         <tr><td>Result</td><td>{}</td></tr>\
         <tr><td>Entries</td><td>{}</td></tr><tr><td>Parser</td><td>{}</td></tr><tr><td>Fetched with</td><td>{}</td></tr>\
         <tr><td>Time</td><td>{} (download {}, parsing {}, image check {})</td></tr>\
         <tr><td>Would be checked every</td><td>{} min ({})</td></tr></tbody></table>",
        esc(&data["failure"]
            .as_str()
            .map_or_else(|| "OK".to_string(), str::to_string)),
        data["entries"].as_u64().unwrap_or(0),
        esc(data["parser"].as_str().unwrap_or("–")),
        transport,
        ms("total"),
        ms("download"),
        ms("parse"),
        ms("imageCheck"),
        data["adaptiveMinutes"]
            .as_f64()
            .map_or("–".into(), |m| format!("{m:.1}")),
        esc(data["adaptiveReason"].as_str().unwrap_or("–")),
    );
    let hints: Vec<String> = data["hints"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(esc)
        .collect();
    if !hints.is_empty() {
        let _ = write!(
            body,
            "<h2>Hints</h2><ul>{}</ul>",
            hints
                .iter()
                .map(|h| format!("<li>{h}</li>"))
                .collect::<String>()
        );
    }
    body.push_str("<h2>Entries as XFeeder reads them</h2>");
    body.push_str(&entries_table(
        data["items"].as_array().map_or(&[][..], Vec::as_slice),
        5,
    ));
    page(
        req,
        StatusCode::OK,
        &format!("Test {}", short_url(&url)),
        &body,
    )
}

// ------------------------------------------------------------------ posts --

fn posts_page(server: &Server, req: &Req) -> Response {
    let config = read_json(&server.paths.config);
    let labels = channel_labels(server, &config);
    let posts = recent_posts(server, 200);
    let mut body = String::from(
        "<p class=\"muted\">Posts sent to Discord (newest first). “Rebuild” edits the message in the current layout; nothing new is posted.</p>",
    );
    if posts.is_empty() {
        body.push_str("<p class=\"muted\">No posts recorded yet (posts are recorded since version 3.0 beta).</p>");
        return page(req, StatusCode::OK, "Posts", &body);
    }
    body.push_str("<table><thead><tr><th>Time</th><th>Channel</th><th>Entry</th><th></th></tr></thead><tbody>");
    for post in &posts {
        let time = chrono::DateTime::from_timestamp_millis(post.sent_at)
            .map(|d| d.to_rfc3339())
            .unwrap_or_default();
        let title = js::to_string_or_empty(&post.entry["title"]);
        let link = js::to_string_or_empty(&post.entry["link"]);
        let _ = write!(
            body,
            "<tr><td title=\"{}\">{}</td><td>{}</td><td>{}{}</td><td><form method=\"post\" action=\"/posts/rerender\" class=\"inline\">{}<button class=\"link\">Rebuild</button></form></td></tr>",
            esc(&time),
            esc(&ago(&time)),
            esc(labels
                .get(&post.channel)
                .map_or(post.channel.as_str(), String::as_str)),
            if link.starts_with("http") {
                format!(
                    "<a href=\"{}\" rel=\"noreferrer\">{}</a>",
                    esc(&link),
                    esc(&title)
                )
            } else {
                esc(&title)
            },
            if post.entry["merged"].is_object() {
                " <small>(+ SteamDB)</small>"
            } else {
                ""
            },
            hidden("id", &post.message_id),
        );
    }
    body.push_str("</tbody></table>");
    page(req, StatusCode::OK, "Posts", &body)
}

async fn post_rerender(server: &Server, req: &Req<'_>) -> Response {
    let id = req.f("id");
    let Some(post) = recent_posts(server, 2000)
        .into_iter()
        .find(|p| p.message_id == id)
    else {
        return redirect("/posts", "Post not found.", true);
    };
    let channel = config::load(&server.paths.config).ok().and_then(|c| {
        c.channels.into_iter().find(|ch| {
            ch.cache_key == post.channel
                || ch.legacy_cache_key.as_deref() == Some(post.channel.as_str())
        })
    });
    let Some(channel) = channel.filter(|c| !c.webhook.is_empty()) else {
        return redirect(
            "/posts",
            "The channel of this post no longer exists or has no webhook.",
            true,
        );
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    match crate::deliver::edit_webhook(
        &channel.webhook,
        channel.thread.as_deref(),
        &post.message_id,
        &post.entry,
        &cancel,
    )
    .await
    {
        Ok(()) => redirect("/posts", "Post rebuilt.", false),
        Err(crate::deliver::SendError::Gone) => {
            redirect("/posts", "This message was deleted on Discord.", true)
        }
        Err(_) => redirect(
            "/posts",
            "Discord did not accept the edit; see the log.",
            true,
        ),
    }
}

/// Newest posts from `sent.json` (newest first).
fn recent_posts(server: &Server, limit: usize) -> Vec<crate::sent::Record> {
    let path = crate::sent::path_for(&server.paths.cache);
    let mut records: Vec<crate::sent::Record> = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    records.reverse();
    records.truncate(limit);
    records
}

fn posts_table(posts: &[crate::sent::Record], labels: &HashMap<String, String>) -> String {
    if posts.is_empty() {
        return "<p class=\"muted\">No posts recorded yet (posts are recorded since version 3.0 beta).</p>".into();
    }
    let mut out = String::from(
        "<table><thead><tr><th>Time</th><th>Channel</th><th>Entry</th></tr></thead><tbody>",
    );
    for post in posts {
        let time = chrono::DateTime::from_timestamp_millis(post.sent_at)
            .map(|d| d.to_rfc3339())
            .unwrap_or_default();
        let title = js::to_string_or_empty(&post.entry["title"]);
        let link = js::to_string_or_empty(&post.entry["link"]);
        let title_html = if link.starts_with("https://") || link.starts_with("http://") {
            format!(
                "<a href=\"{}\" rel=\"noreferrer\">{}</a>",
                esc(&link),
                esc(&title)
            )
        } else {
            esc(&title)
        };
        let merged = if post.entry["merged"].is_object() {
            " <small>(+ SteamDB)</small>"
        } else {
            ""
        };
        let _ = write!(
            out,
            "<tr><td title=\"{}\">{}</td><td>{}</td><td>{title_html}{merged}</td></tr>",
            esc(&time),
            esc(&ago(&time)),
            esc(labels
                .get(&post.channel)
                .map_or(post.channel.as_str(), String::as_str)),
        );
    }
    out.push_str("</tbody></table>");
    out
}

async fn overview(server: &Server, req: &Req<'_>) -> Response {
    let text = read_text(&server.paths.config);
    let config: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let channels = runtime_channels(&config);
    let feeds: usize = channels.iter().map(|c| c.feeds.len()).sum();
    let webhooks = channels.iter().filter(|c| c.has_webhook()).count();
    let telegrams = channels.iter().filter(|c| c.has_telegram()).count();
    let ready = worker_ready(&server.paths.config);
    let status = {
        let mut worker = server.worker.lock().await;
        server.worker_status(&mut worker).await
    };
    let activity = structured_activity(&server.paths.config, 2000);
    let summary = &activity["summary"];
    let problems = server.problems(&config);
    let cache = read_json(&server.paths.cache);
    let cached: usize = cache
        .as_object()
        .into_iter()
        .flatten()
        .flat_map(|(_, b)| b.as_object().into_iter().flatten())
        .filter_map(|(_, v)| v.as_array().map(Vec::len))
        .sum();

    let mut body = String::new();
    let worker_text = if status["managed"] == json!(true) {
        "Running (started by the dashboard)"
    } else if status["externalWorker"] == json!(true) {
        "Running (systemd or another process)"
    } else {
        "Not running"
    };
    let _ = write!(
        body,
        "<section class=\"cards\">\
         <div class=\"card\"><span>Worker</span><strong class=\"{}\">{}</strong><small>{}</small></div>\
         <div class=\"card\"><span>Channels</span><strong>{}</strong><small>{} feeds</small></div>\
         <div class=\"card\"><span>Destinations</span><strong>{webhooks} Discord</strong><small>{telegrams} Telegram</small></div>\
         <div class=\"card\"><span>Last 24 h</span><strong>{} sent</strong><small>{} errors</small></div>\
         <div class=\"card\"><span>Last activity</span><strong>{}</strong><small>health: {}</small></div>\
         <div class=\"card\"><span>Delivery cache</span><strong>{cached}</strong><small>remembered entries</small></div>\
         </section>",
        if ready { "good" } else { "bad" },
        if ready { "Ready" } else { "Not ready" },
        esc(worker_text),
        channels.len(),
        feeds,
        summary["deliveries24h"]
            .as_u64()
            .map_or("–".into(), |n| n.to_string()),
        summary["errors24h"]
            .as_u64()
            .map_or("–".into(), |n| n.to_string()),
        esc(&summary["lastActivityAt"].as_str().map_or("–".into(), ago)),
        esc(summary["health"].as_str().unwrap_or("unknown")),
    );

    let external = status["externalWorker"] == json!(true) && status["managed"] != json!(true);
    if external {
        body.push_str(
            "<section><h2>Worker control</h2><p class=\"muted\">The worker runs as a systemd service (or another process), so it is not controlled from here. Restart it with <code>sudo systemctl restart xfeeder</code>; configuration changes are picked up without a restart.</p></section>",
        );
    } else {
        body.push_str("<section><h2>Worker control</h2><div class=\"row\">");
        for (action, label) in [("start", "Start"), ("restart", "Restart"), ("stop", "Stop")] {
            let _ = write!(
                body,
                "<form method=\"post\" action=\"/worker\">{}<button{}>{label}</button></form>",
                hidden("action", action),
                if action == "stop" {
                    " class=\"danger\""
                } else {
                    ""
                }
            );
        }
        body.push_str(
        "</div><small>Only a worker started here can be stopped or restarted here; a systemd service is managed with systemctl.</small></section>",
    );
    }

    if !problems.errors.is_empty() || !problems.warnings.is_empty() {
        let mut buttons = String::new();
        for name in unsupported_sections(&problems) {
            let _ = write!(
                buttons,
                "<form method=\"post\" action=\"/config/remove-section\" class=\"inline\">{}{}<button class=\"danger\">Remove the section “{}”</button></form> ",
                hidden("name", &name),
                hidden("rev", &revision(&text)),
                esc(&name)
            );
        }
        if !buttons.is_empty() {
            buttons = format!(
                "<p class=\"row\">{buttons}<small>The previous config is kept as config.json.bak.</small></p>"
            );
        }
        let _ = write!(
            body,
            "<section><h2>Configuration</h2>{}{buttons}</section>",
            problems_html(&problems, false)
        );
    }

    if let Some(data) = read_activity(&server.paths.config) {
        let metrics = public_metrics(&data["metrics"]);
        let mut rows = String::new();
        for (name, value) in metrics["counters"].as_object().into_iter().flatten() {
            if let Some(n) = value.as_f64() {
                let _ = write!(
                    rows,
                    "<tr><td>{}</td><td class=\"num\">{n}</td></tr>",
                    esc(counter_label(name))
                );
            }
        }
        for (target, label) in [("webhook", "Discord posts"), ("telegram", "Telegram posts")] {
            let d = &metrics["counters"]["delivery_total"][target];
            let _ = write!(
                rows,
                "<tr><td>{label}</td><td class=\"num\">{} ok / {} failed</td></tr>",
                d["success"], d["error"]
            );
        }
        let mut durations = String::new();
        for (name, d) in metrics["durations"].as_object().into_iter().flatten() {
            let count = d["count"].as_f64().unwrap_or(0.0);
            if count > 0.0 {
                let _ = write!(
                    durations,
                    "<tr><td>{}</td><td class=\"num\">{count}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                    esc(counter_label(name)),
                    ms(d["sum"].as_f64().unwrap_or(0.0) / count),
                    d["min"].as_f64().map_or("–".into(), ms),
                    d["max"].as_f64().map_or("–".into(), ms),
                );
            }
        }
        let _ = write!(
            body,
            "<section class=\"split\"><div><h2>Since the worker started</h2><table><tbody>{rows}</tbody></table></div>\
             <div><h2>Durations</h2><table><thead><tr><th>Stage</th><th>count</th><th>avg</th><th>min</th><th>max</th></tr></thead><tbody>{durations}</tbody></table>\
             <small>Updated {}</small></div></section>",
            esc(&data["updatedAt"].as_str().map_or("–".into(), ago))
        );
    }

    let names = activity_names(&config);
    let labels = channel_labels(server, &config);
    let _ = write!(
        body,
        "{}<section><h2>Recent posts</h2>{}<p><a href=\"/posts\">All posts →</a></p></section>",
        failing_feeds_html(server),
        posts_table(&recent_posts(server, 10), &labels)
    );
    let mut problems_feed = activity.clone();
    if let Some(items) = problems_feed["items"].as_array_mut() {
        items.retain(|i| i["status"] != json!("success"));
        items.truncate(10);
    }
    let _ = write!(
        body,
        "<section><h2>Recent problems</h2>{}<p><a href=\"/activity\">All activity →</a></p></section>",
        activity_table(&problems_feed, &names)
    );
    html(StatusCode::OK, layout(req, "Overview", &body, None))
}

/// Sections the worker reports as not executed.
fn unsupported_sections(problems: &Problems) -> Vec<String> {
    problems
        .warnings
        .iter()
        .filter_map(|w| {
            w.strip_prefix("Unsupported configuration section \"")
                .and_then(|rest| rest.split_once('"'))
                .map(|(name, _)| name.to_string())
        })
        .collect()
}

fn remove_section(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    if stale(req, &revision(&text)) {
        return redirect("/", STALE, true);
    }
    let Ok(mut config) = serde_json::from_str::<Value>(&text) else {
        return redirect(
            "/",
            "config.json is not valid JSON; fix it in Advanced.",
            true,
        );
    };
    let name = req.f("name");
    // Only a section the worker itself reports as unsupported.
    if !unsupported_sections(&server.problems(&config))
        .iter()
        .any(|n| n == name)
    {
        return redirect(
            "/",
            "This section is used; it can only be removed in Advanced.",
            true,
        );
    }
    if let Some(root) = config.as_object_mut() {
        root.remove(name);
    }
    match server.store(&config, &text, true) {
        Ok(()) => redirect(
            "/",
            &format!("Section “{name}” removed (previous config in config.json.bak)."),
            false,
        ),
        Err(problems) => redirect("/", &problems.errors.join(" "), true),
    }
}

async fn worker(server: &Server, req: &Req<'_>) -> Response {
    let action = req.f("action");
    if !matches!(action, "start" | "stop" | "restart") {
        return redirect("/", "Unknown worker action.", true);
    }
    match server.worker_run(action).await {
        Ok(_) => redirect("/", &format!("Worker {action}: done."), false),
        Err((_, message)) => redirect("/", &message, true),
    }
}

// --------------------------------------------------------------- activity --

/// Technical counter and duration names, as shown.
fn counter_label(name: &str) -> &str {
    match name {
        "feed_fetch_total" => "Feed checks",
        "feed_fetch_error_total" => "Failed checks",
        "feed_not_modified_total" => "Unchanged (HTTP 304)",
        "items_parsed_total" => "Entries read",
        "scrapling_fallback_total" => "Fetched through the browser",
        "feed_fetch_duration_ms" => "Feed download",
        "channel_run_duration_ms" => "Channel round",
        "delivery_duration_ms" => "Sending a post",
        other => other,
    }
}

/// Events that are routine and hidden unless asked for.
/// Status as a small badge: word plus colour, never colour alone.
fn status_badge(status: &str) -> String {
    let (class, label) = match status {
        "success" | "ok" => ("ok", "OK"),
        "warning" => ("warn", "Warning"),
        "error" => ("bad", "Error"),
        "" => return String::new(),
        other => ("", other),
    };
    format!("<span class=\"badge {class}\">{}</span>", esc(label))
}

/// Readable name of an activity event (the raw name stays in the tooltip).
fn event_label(event: &str) -> &str {
    match event {
        "feed.fetch.started" => "Feed check started",
        "feed.fetch.completed" => "Feed checked",
        "feed.not_modified" => "Feed unchanged (304)",
        "feed.parse.completed" => "Entries read",
        "feed.failed" => "Feed check failed",
        "scrapling.used" => "Fetched through the browser",
        "delivery.sent" => "Post sent",
        "delivery.failed" => "Post failed",
        "channel.started" => "Channel round started",
        "channel.completed" => "Channel round finished",
        "channel.failed" => "Channel round failed",
        "worker.started" => "Worker started",
        "worker.stopped" => "Worker stopped",
        "config.loaded" => "Config loaded",
        "config.reloaded" => "Config reloaded",
        "retry.scheduled" => "Retry scheduled",
        other => other,
    }
}

const ROUTINE: [&str; 6] = [
    "feed.fetch.started",
    "feed.fetch.completed",
    "feed.not_modified",
    "feed.parse.completed",
    "channel.started",
    "channel.completed",
];

fn activity_table(activity: &Value, names: &HashMap<String, String>) -> String {
    let items = activity["items"].as_array().cloned().unwrap_or_default();
    if activity["available"] != json!(true) {
        return "<p class=\"muted\">No activity recorded yet (the worker writes it while running).</p>".into();
    }
    if items.is_empty() {
        return "<p class=\"muted\">No events.</p>".into();
    }
    let name_of = |names: &HashMap<String, String>, id: &str| -> String {
        names.get(id).cloned().unwrap_or_else(|| {
            id.trim_start_matches("channel:")
                .trim_start_matches("feed:")
                .to_string()
        })
    };
    let mut out = String::from(
        "<table><thead><tr><th>Time</th><th>Event</th><th>Status</th><th>Channel</th><th>Feed</th><th>Target</th><th class=\"num\">Duration</th><th class=\"num\">HTTP</th><th class=\"num\">Items</th><th>Error</th></tr></thead><tbody>",
    );
    for item in &items {
        let time = item["time"].as_str().unwrap_or("");
        let _ = write!(
            out,
            "<tr class=\"{}\"><td title=\"{}\">{}</td><td title=\"{}\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td>{}</td></tr>",
            esc(item["status"].as_str().unwrap_or("")),
            esc(time),
            esc(&ago(time)),
            esc(item["event"].as_str().unwrap_or("")),
            esc(event_label(item["event"].as_str().unwrap_or(""))),
            status_badge(item["status"].as_str().unwrap_or("")),
            esc(&name_of(names, item["channel"].as_str().unwrap_or(""))),
            esc(&name_of(names, item["source"].as_str().unwrap_or(""))),
            esc(item["target"].as_str().unwrap_or("")),
            item["durationMs"].as_f64().map_or(String::new(), ms),
            item["details"]["httpStatus"]
                .as_u64()
                .map_or(String::new(), |n| n.to_string()),
            item["details"]["itemCount"]
                .as_u64()
                .map_or(String::new(), |n| n.to_string()),
            esc(&js::to_string_or_empty(&item["details"]["errorCode"])),
        );
    }
    out.push_str("</tbody></table>");
    out
}

fn activity(server: &Server, req: &Req) -> Response {
    let limit = req.q("limit").parse().unwrap_or(200usize).clamp(1, 2000);
    let mut data = structured_activity(&server.paths.config, 2000);
    let status = req.q("status");
    let kind = req.q("type");
    let everything = req.q("view") == "all";
    if let Some(items) = data["items"].as_array_mut() {
        items.retain(|i| {
            (status.is_empty() || i["status"] == json!(status))
                && (kind.is_empty() || i["type"] == json!(kind))
                && (everything
                    || !status.is_empty()
                    || !kind.is_empty()
                    || !ROUTINE.contains(&i["event"].as_str().unwrap_or("")))
        });
        items.truncate(limit);
    }
    let s = &data["summary"];
    let mut body = format!(
        "<p class=\"muted\">Sent in the last 24 h: <strong>{}</strong> · errors: <strong>{}</strong> · last event: {} · observed since {}</p>",
        s["deliveries24h"]
            .as_u64()
            .map_or("–".into(), |n| n.to_string()),
        s["errors24h"]
            .as_u64()
            .map_or("–".into(), |n| n.to_string()),
        esc(&s["lastActivityAt"].as_str().map_or("–".into(), ago)),
        esc(s["observedSince"].as_str().unwrap_or("–")),
    );
    body.push_str("<p class=\"row\">");
    for (label, query) in [
        ("Important", ""),
        ("All", "view=all"),
        ("Errors", "status=error"),
        ("Deliveries", "type=delivery"),
        ("Fetches", "type=fetch"),
        ("Worker", "type=worker"),
    ] {
        let current = (query.is_empty() && status.is_empty() && kind.is_empty() && !everything)
            || (query == "view=all" && everything)
            || (!query.is_empty()
                && (query == format!("status={status}") || query == format!("type={kind}")));
        let _ = write!(
            body,
            "<a class=\"pill{}\" href=\"/activity{}{}\">{label}</a>",
            if current { " on" } else { "" },
            if query.is_empty() { "" } else { "?" },
            query
        );
    }
    body.push_str("</p>");
    let config = read_json(&server.paths.config);
    body.push_str(&activity_table(&data, &activity_names(&config)));
    html(StatusCode::OK, layout(req, "Activity", &body, Some(30)))
}

// --------------------------------------------------------------- channels --

/// Object form of a channel entry (bare URL strings/arrays become `Feeds`).
fn channel_data(raw: &Value) -> Map<String, Value> {
    match raw {
        Value::Object(map) => map.clone(),
        Value::String(url) => {
            let mut map = Map::new();
            map.insert("Feeds".into(), json!([url]));
            map
        }
        other => {
            let mut map = Map::new();
            map.insert("Feeds".into(), other.clone());
            map
        }
    }
}

fn feed_list(data: &Map<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in FEED_KEYS {
        let values = match data.get(key) {
            Some(Value::Array(items)) => items.clone(),
            Some(other) => vec![other.clone()],
            None => continue,
        };
        for value in values {
            if let Some(url) = value.as_str().map(str::trim).filter(|u| !u.is_empty())
                && !out.iter().any(|u| u == url)
            {
                out.push(url.to_string());
            }
        }
    }
    out
}

fn host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "source".into())
}

/// `(group, key, raw)` for every editable channel of a v1 config.
fn channel_entries(config: &Value) -> Vec<(String, String, Value)> {
    let mut out = Vec::new();
    for (group, value) in config::channel_groups(config) {
        match value {
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    out.push((group.clone(), index.to_string(), item.clone()));
                }
            }
            Value::Object(map) => {
                for (name, item) in map {
                    out.push((group.clone(), name.clone(), item.clone()));
                }
            }
            _ => {}
        }
    }
    out
}

/// The worker's view of the channel at `group`/`key` (with `.env` resolved).
fn runtime_channel(server: &Server, group: &str, key: &str) -> Option<config::Channel> {
    let loaded = config::load(&server.paths.config).ok()?;
    let mut in_group = loaded
        .channels
        .into_iter()
        .filter(|c| c.source_key == group);
    match key.parse::<usize>() {
        Ok(index)
            if read_json(&server.paths.config)
                .get(group)
                .is_some_and(Value::is_array) =>
        {
            in_group.find(|c| c.position == index)
        }
        _ => in_group.find(|c| c.name.as_deref() == Some(key)),
    }
}

/// The key under which the channel's delivery history is stored now.
fn delivery_key(server: &Server, group: &str, key: &str) -> Option<String> {
    let channel = runtime_channel(server, group, key)?;
    let cache = read_json(&server.paths.cache);
    // A 2.x key still in use wins, as in the worker.
    Some(match &channel.legacy_cache_key {
        Some(legacy) if cache.get(&channel.cache_key).is_none() && cache.get(legacy).is_some() => {
            legacy.clone()
        }
        _ => channel.cache_key,
    })
}

/// Saved snapshot (last entries, health) of every feed.
fn feed_snapshots(server: &Server) -> Map<String, Value> {
    let path = server.paths.cache.with_file_name("cache.feeds.json");
    read_json(&path)["__xfeeder"]["feedSnapshots"]
        .as_object()
        .cloned()
        .unwrap_or_default()
}

/// Current check interval of a feed (AdaptivePolling) and why.
fn feed_interval(channel: &config::Channel, snapshot: &Value) -> (u64, &'static str) {
    let max = channel.time_checker * 60_000;
    match &channel.adaptive {
        Some(adaptive) => {
            let items = snapshot["items"].as_array().cloned().unwrap_or_default();
            crate::adaptive::interval_ms(
                &items,
                chrono::Utc::now().timestamp_millis(),
                max,
                adaptive,
            )
        }
        None => (max, "TimeChecker"),
    }
}

fn minutes(ms: u64) -> String {
    let m = ms as f64 / 60_000.0;
    if (m - m.round()).abs() < 0.05 {
        format!("{m:.0}")
    } else {
        format!("{m:.1}")
    }
}

fn find_channel(config: &Value, group: &str, key: &str) -> Option<Value> {
    match config.get(group)? {
        Value::Array(items) => items.get(key.parse::<usize>().ok()?).cloned(),
        Value::Object(map) => map.get(key).cloned(),
        _ => None,
    }
}

fn is_v2(config: &Value) -> bool {
    config["schemaVersion"] == json!(2)
}

fn channel_label(group: &str, key: &str, object_group: bool) -> String {
    if object_group {
        key.to_string()
    } else {
        format!("{group} #{}", key.parse::<usize>().map_or(0, |i| i + 1))
    }
}

fn channels(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let config: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let rev = revision(&text);
    if is_v2(&config) {
        let mut body = String::from(
            "<p class=\"notice warn\">This config uses schema v2. Channels are listed read-only; edit them in <a href=\"/advanced\">Advanced</a>.</p><table><thead><tr><th>Channel</th><th>Feeds</th><th>Interval</th></tr></thead><tbody>",
        );
        for (i, c) in runtime_channels(&config).iter().enumerate() {
            let _ = write!(
                body,
                "<tr><td>{}</td><td class=\"num\">{}</td><td>{} min</td></tr>",
                esc(&c
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("Channel {}", i + 1))),
                c.feeds.len(),
                c.time_checker
            );
        }
        body.push_str("</tbody></table>");
        return page(req, StatusCode::OK, "Channels", &body);
    }
    let entries = channel_entries(&config);
    let first_group = config::channel_groups(&config)
        .first()
        .map_or_else(|| "channels".to_string(), |(g, _)| (*g).clone());
    let mut body = format!(
        "<p class=\"row\"><a class=\"button\" href=\"/channels/edit?new=1&amp;group={}\">Add channel</a><span class=\"muted\">{} channels. Changes are picked up by the worker on its next cycle.</span></p>",
        esc(&enc(&first_group)),
        entries.len()
    );
    body.push_str("<table><thead><tr><th>Channel</th><th>Sources</th><th>Destination</th><th>Checked every</th><th>Last post</th><th>Status</th><th></th></tr></thead><tbody>");
    let snapshots = feed_snapshots(server);
    let posts = recent_posts(server, 2000);
    let resolved = config::load(&server.paths.config)
        .map(|c| c.channels)
        .unwrap_or_default();
    for (group, key, raw) in &entries {
        let runtime = {
            let object = config.get(group).is_some_and(Value::is_object);
            let mut in_group = resolved.iter().filter(|c| &c.source_key == group);
            if object {
                in_group.find(|c| c.name.as_deref() == Some(key.as_str()))
            } else {
                key.parse::<usize>()
                    .ok()
                    .and_then(|i| in_group.find(|c| c.position == i))
            }
        };
        let (interval, last_post, status) = match runtime {
            Some(channel) => {
                let ranges: Vec<u64> = channel
                    .feeds
                    .iter()
                    .map(|f| feed_interval(channel, snapshots.get(f).unwrap_or(&Value::Null)).0)
                    .collect();
                let (lo, hi) = (
                    ranges
                        .iter()
                        .min()
                        .copied()
                        .unwrap_or(channel.time_checker * 60_000),
                    ranges
                        .iter()
                        .max()
                        .copied()
                        .unwrap_or(channel.time_checker * 60_000),
                );
                let interval = if lo == hi {
                    format!("{} min", minutes(lo))
                } else {
                    format!("{}–{} min", minutes(lo), minutes(hi))
                };
                let keys = [
                    Some(channel.cache_key.as_str()),
                    channel.legacy_cache_key.as_deref(),
                ];
                let last = posts
                    .iter()
                    .find(|p| keys.contains(&Some(p.channel.as_str())));
                let last_post = last.map_or_else(
                    || "<span class=\"muted\">–</span>".to_string(),
                    |p| {
                        let time = chrono::DateTime::from_timestamp_millis(p.sent_at)
                            .map(|d| d.to_rfc3339())
                            .unwrap_or_default();
                        format!(
                            "{}<br><small class=\"muted\">{}</small>",
                            esc(&ago(&time)),
                            esc(js::prefix16(&js::to_string_or_empty(&p.entry["title"]), 60))
                        )
                    },
                );
                let failing = channel
                    .feeds
                    .iter()
                    .filter(|f| {
                        snapshots
                            .get(*f)
                            .and_then(|s| s["health"]["consecutiveFailures"].as_u64())
                            .unwrap_or(0)
                            > 0
                    })
                    .count();
                let status = if failing == 0 {
                    "<span class=\"good\">OK</span>".to_string()
                } else {
                    format!("<span class=\"bad\">{failing} failing</span>")
                };
                (interval, last_post, status)
            }
            None => ("–".into(), "–".into(), "–".into()),
        };
        let data = channel_data(raw);
        let feeds = feed_list(&data);
        let object_group = config.get(group).is_some_and(Value::is_object);
        let mut hosts: Vec<String> = feeds.iter().map(|f| host(f)).collect();
        hosts.dedup();
        let webhook = js::trimmed_str(data.get("Webhook").unwrap_or(&Value::Null)).is_some()
            || js::trimmed_str(js::path(raw, &["Discord", "Webhook"])).is_some();
        let telegram = js::trimmed_str(js::path(raw, &["Telegram", "ChatID"])).is_some();
        let thread = js::to_string_or_empty(data.get("Thread").unwrap_or(&Value::Null));
        let mut dest = Vec::new();
        if webhook {
            dest.push(if thread.is_empty() {
                "Discord".to_string()
            } else {
                format!("Discord thread {thread}")
            });
        }
        if telegram {
            dest.push("Telegram".into());
        }
        let q = format!("group={}&amp;key={}", esc(&enc(group)), esc(&enc(key)));
        let _ = write!(
            body,
            "<tr><td><a href=\"/channels/edit?{q}\">{}</a>{}</td><td><strong>{}</strong> <span class=\"muted\">{}</span></td><td>{}</td><td>{interval}</td><td>{last_post}</td><td>{status}</td>\
             <td class=\"actions\"><a href=\"/channels/edit?{q}\">Edit</a>\
             <form method=\"post\" action=\"/channels/duplicate\" class=\"inline\">{}{}{}<button class=\"link\">Duplicate</button></form>\
             <a class=\"danger\" href=\"/channels/delete?{q}\">Delete</a></td></tr>",
            esc(&runtime
                .and_then(|c| c.display.clone())
                .unwrap_or_else(|| channel_label(group, key, object_group))),
            if runtime.is_some_and(|c| c.display.is_some()) {
                format!(
                    "<br><small class=\"muted\">{}</small>",
                    esc(&channel_label(group, key, object_group))
                )
            } else {
                String::new()
            },
            feeds.len(),
            esc(&hosts.into_iter().take(3).collect::<Vec<_>>().join(", ")),
            esc(&if dest.is_empty() {
                "none".to_string()
            } else {
                dest.join(" + ")
            }),
            hidden("rev", &rev),
            hidden("group", group),
            hidden("key", key),
        );
    }
    body.push_str("</tbody></table>");
    page(req, StatusCode::OK, "Channels", &body)
}

#[derive(Default, Debug)]
struct ChannelForm {
    orig_group: String,
    orig_key: String,
    group: String,
    name: String,
    label: String,
    webhook: String,
    thread: String,
    sources: String,
    time_checker: String,
    request_send: String,
    first_run_send: String,
    include: String,
    exclude: String,
    fields: String,
    case_sensitive: bool,
    max_age: String,
    extra: String,
    accept: bool,
}

fn lines(value: &Value) -> String {
    match value {
        Value::Array(items) => items
            .iter()
            .map(js::to_string_or_empty)
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => js::to_string_or_empty(other),
    }
}

fn split_lines(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if !out.iter().any(|l| l == line) {
            out.push(line.to_string());
        }
    }
    out
}

impl ChannelForm {
    fn from_value(group: &str, key: &str, raw: &Value) -> Self {
        let data = channel_data(raw);
        let get = |k: &str| data.get(k).map_or(String::new(), js::to_string_or_empty);
        let filters = data.get("Filters").cloned().unwrap_or(Value::Null);
        let mut extra = data.clone();
        for k in HANDLED.iter().chain(["Filters"].iter()) {
            extra.shift_remove(*k);
        }
        let known_filter = [
            "Include",
            "Exclude",
            "Fields",
            "CaseSensitive",
            "MaxAgeHours",
        ];
        let filter_extra = filters
            .as_object()
            .is_some_and(|f| f.keys().any(|k| !known_filter.contains(&k.as_str())));
        if filter_extra {
            // Unknown filter keys: keep the whole object in the JSON box.
            extra.insert("Filters".into(), filters.clone());
        }
        let filters = if filter_extra { Value::Null } else { filters };
        Self {
            orig_group: group.into(),
            orig_key: key.into(),
            group: group.into(),
            name: key.into(),
            label: get("Label"),
            webhook: get("Webhook"),
            thread: get("Thread"),
            sources: feed_list(&data).join("\n"),
            time_checker: get("TimeChecker"),
            request_send: get("RequestSend"),
            first_run_send: get("FirstRunSend"),
            include: lines(js::get(&filters, "Include")),
            exclude: lines(js::get(&filters, "Exclude")),
            fields: lines(js::get(&filters, "Fields")).replace('\n', ", "),
            case_sensitive: js::get(&filters, "CaseSensitive") == &Value::Bool(true),
            max_age: js::to_string_or_empty(js::get(&filters, "MaxAgeHours")),
            extra: if extra.is_empty() {
                String::new()
            } else {
                serde_json::to_string_pretty(&Value::Object(extra)).unwrap_or_default()
            },
            accept: false,
        }
    }

    fn from_post(req: &Req) -> Self {
        let f = |k: &str| req.f(k).trim().to_string();
        Self {
            orig_group: req.f("orig_group").into(),
            orig_key: req.f("orig_key").into(),
            group: f("group"),
            name: f("name"),
            label: f("label"),
            webhook: f("webhook"),
            thread: f("thread"),
            sources: req.f("sources").into(),
            time_checker: f("time_checker"),
            request_send: f("request_send"),
            first_run_send: f("first_run_send"),
            include: req.f("include").into(),
            exclude: req.f("exclude").into(),
            fields: f("fields"),
            case_sensitive: req.checked("case_sensitive"),
            max_age: f("max_age"),
            extra: req.f("extra").into(),
            accept: req.checked("accept"),
        }
    }

    /// Channel object from the form, keeping the original key order and
    /// feed key. `original` is the entry being edited, if any.
    fn build(&self, original: Option<&Value>) -> Result<Value, String> {
        let extra = match self.extra.trim() {
            "" => Map::new(),
            text => match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(map)) => map,
                Ok(_) => return Err("“Other settings” must be a JSON object { … }.".into()),
                Err(e) => return Err(format!("“Other settings” is not valid JSON: {e}")),
            },
        };
        let original = original.map(channel_data).unwrap_or_default();
        let feed_key = FEED_KEYS
            .iter()
            .find(|k| original.contains_key(**k))
            .copied()
            .unwrap_or("RSS");
        let sources = split_lines(&self.sources);
        if sources.is_empty() {
            return Err("Add at least one source URL.".into());
        }
        for url in &sources {
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(format!("Not an http(s) URL: {url}"));
            }
        }
        let number = |label: &str, text: &str| -> Result<Option<Value>, String> {
            if text.is_empty() {
                return Ok(None);
            }
            text.parse::<u64>()
                .map(|n| Some(json!(n)))
                .map_err(|_| format!("{label} must be a whole number."))
        };
        let mut handled: Map<String, Value> = Map::new();
        if !self.label.is_empty() {
            handled.insert("Label".into(), json!(self.label));
        }
        handled.insert(feed_key.into(), json!(sources));
        if !self.webhook.is_empty() {
            handled.insert("Webhook".into(), json!(self.webhook));
        }
        if !self.thread.is_empty() {
            handled.insert("Thread".into(), json!(self.thread));
        }
        for (key, label, text) in [
            ("TimeChecker", "Check every", &self.time_checker),
            ("RequestSend", "Max entries per run", &self.request_send),
            ("FirstRunSend", "First-run send", &self.first_run_send),
        ] {
            if let Some(v) = number(label, text)? {
                handled.insert(key.into(), v);
            }
        }
        let mut filters = Map::new();
        let include = split_lines(&self.include);
        let exclude = split_lines(&self.exclude);
        let fields: Vec<String> = self
            .fields
            .split(',')
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(str::to_string)
            .collect();
        if !include.is_empty() {
            filters.insert("Include".into(), json!(include));
        }
        if !exclude.is_empty() {
            filters.insert("Exclude".into(), json!(exclude));
        }
        if !fields.is_empty() {
            filters.insert("Fields".into(), json!(fields));
        }
        if self.case_sensitive {
            filters.insert("CaseSensitive".into(), json!(true));
        }
        if let Some(v) = number("Max age (hours)", &self.max_age)? {
            filters.insert("MaxAgeHours".into(), v);
        }
        if !filters.is_empty() {
            if extra.contains_key("Filters") {
                return Err("Filters are set both in the form and in “Other settings”.".into());
            }
            handled.insert("Filters".into(), Value::Object(filters));
        }
        for key in handled.keys() {
            if extra.contains_key(key) {
                return Err(format!(
                    "“{key}” is set both in the form and in “Other settings”."
                ));
            }
        }
        let mut out = Map::new();
        for key in original.keys() {
            if let Some(v) = handled.get(key).or_else(|| extra.get(key)) {
                out.insert(key.clone(), v.clone());
            }
        }
        for (key, value) in handled.iter().chain(extra.iter()) {
            if !out.contains_key(key) {
                out.insert(key.clone(), value.clone());
            }
        }
        Ok(Value::Object(out))
    }
}

fn group_names(config: &Value) -> Vec<String> {
    config::channel_groups(config)
        .into_iter()
        .map(|(g, _)| g.clone())
        .collect()
}

fn channel_form_html(form: &ChannelForm, rev: &str, groups: &[String], notice: &str) -> String {
    let mut out = String::from(notice);
    out.push_str("<form method=\"post\" action=\"/channels/save\" class=\"stack\">");
    out.push_str(&hidden("rev", rev));
    out.push_str(&hidden("orig_group", &form.orig_group));
    out.push_str(&hidden("orig_key", &form.orig_key));
    let _ = write!(
        out,
        "<fieldset><legend>Channel</legend><div class=\"grid2\">\
         <label>Group<input name=\"group\" value=\"{}\" list=\"groups\" required><small>Existing group, or a new one starting with “channels”.</small></label>\
         <datalist id=\"groups\">{}</datalist>{}{}</div></fieldset>",
        esc(&form.group),
        groups
            .iter()
            .map(|g| format!("<option value=\"{}\">", esc(g)))
            .collect::<String>(),
        text_input(
            "Name",
            "name",
            &form.name,
            "Used only in named groups (JSON objects); array groups number channels automatically.",
            "text"
        ),
        text_input(
            "Display name",
            "label",
            &form.label,
            "Shown in the dashboard and logs, e.g. Changelog. Can be changed at any time: it does not affect the delivery history.",
            "text"
        ),
    );
    let feed_links: String = split_lines(&form.sources)
        .iter()
        .map(|url| {
            format!(
                "<li><a href=\"/feed?url={}\">{}</a></li>",
                esc(&enc(url)),
                esc(&short_url(url))
            )
        })
        .collect();
    let rows = split_lines(&form.sources).len().clamp(4, 20) as u32 + 1;
    let _ = write!(
        out,
        "<fieldset><legend>Sources</legend>{}{}</fieldset>",
        textarea(
            "Feed URLs",
            "sources",
            &form.sources,
            rows,
            "One URL per line: RSS, Atom, JSON Feed, YouTube or a web page with a feed link."
        ),
        if feed_links.is_empty() {
            String::new()
        } else {
            format!(
                "<details><summary>Feed details and test</summary><ul class=\"feeds\">{feed_links}</ul></details>"
            )
        }
    );
    let _ = write!(
        out,
        "<fieldset><legend>Discord</legend><div class=\"grid2\">{}{}</div></fieldset>",
        text_input(
            "Webhook URL",
            "webhook",
            &form.webhook,
            "Or ${ENV_NAME} to read it from .env.",
            "text"
        ),
        text_input(
            "Thread ID",
            "thread",
            &form.thread,
            "Forum or thread to post into (optional).",
            "text"
        ),
    );
    let _ = write!(
        out,
        "<fieldset><legend>Schedule</legend><div class=\"grid3\">{}{}{}</div></fieldset>",
        text_input(
            "Check every (minutes)",
            "time_checker",
            &form.time_checker,
            "Empty = default (30).",
            "number"
        ),
        text_input(
            "Max entries per run",
            "request_send",
            &form.request_send,
            "Empty = default (5).",
            "number"
        ),
        text_input(
            "First-run send",
            "first_run_send",
            &form.first_run_send,
            "Newest N entries posted when a feed is first seen. Empty = global setting.",
            "number"
        ),
    );
    let _ = write!(
        out,
        "<fieldset><legend>Filters</legend><div class=\"grid2\">{}{}</div><div class=\"grid3\">{}{}{}</div></fieldset>",
        textarea(
            "Include (any of)",
            "include",
            &form.include,
            3,
            "One phrase per line; /regex/ allowed. Empty = everything."
        ),
        textarea(
            "Exclude",
            "exclude",
            &form.exclude,
            3,
            "One phrase per line; /regex/ allowed."
        ),
        text_input(
            "Fields",
            "fields",
            &form.fields,
            "Comma-separated, e.g. title, contentSnippet. Empty = title and summary.",
            "text"
        ),
        text_input(
            "Max age (hours)",
            "max_age",
            &form.max_age,
            "Skip older entries. Empty = no limit.",
            "number"
        ),
        checkbox("Case-sensitive", "case_sensitive", form.case_sensitive),
    );
    let _ = write!(
        out,
        "<fieldset><legend>Other settings</legend>{}</fieldset>",
        textarea(
            "JSON",
            "extra",
            &form.extra,
            8,
            "Remaining channel keys (Telegram, Discord, Scrapling, ...) as a JSON object. Kept as is."
        )
    );
    let _ = write!(
        out,
        "<div class=\"row\">{}<button>Save channel</button><a href=\"/channels\">Cancel</a></div></form>",
        checkbox("Save despite warnings", "accept", form.accept)
    );
    out
}

fn channel_edit(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let config: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    if is_v2(&config) {
        return redirect("/channels", "Schema v2: edit channels in Advanced.", true);
    }
    let groups = group_names(&config);
    let (form, title) = if req.q("new") == "1" {
        let group = if req.q("group").is_empty() {
            "channels".to_string()
        } else {
            req.q("group").to_string()
        };
        let mut form = ChannelForm::from_value("", "", &json!({}));
        form.group = group;
        form.name = String::new();
        (form, "New channel".to_string())
    } else {
        let (group, key) = (req.q("group"), req.q("key"));
        let Some(raw) = find_channel(&config, group, key) else {
            return redirect(
                "/channels",
                "Channel not found (the config may have changed).",
                true,
            );
        };
        let object_group = config.get(group).is_some_and(Value::is_object);
        let mut form = ChannelForm::from_value(group, key, &raw);
        if !object_group {
            form.name = String::new();
        }
        (
            form,
            format!("Edit {}", channel_label(group, key, object_group)),
        )
    };
    let body = channel_form_html(&form, &revision(&text), &groups, "");
    page(req, StatusCode::OK, &title, &body)
}

/// Put `value` at `group`/`name`, moving it from `orig` when given.
fn place(
    config: &mut Value,
    orig: Option<(&str, &str)>,
    group: &str,
    name: &str,
    value: Value,
) -> Result<(), String> {
    match config.get(group) {
        Some(existing) if !config::is_channel_group(group, existing) => {
            return Err(format!(
                "“{group}” is another configuration field, not a channel group."
            ));
        }
        None if !config::is_channel_group(group, &json!([])) => {
            return Err("New groups must be named “channels…” (for example channels2).".into());
        }
        _ => {}
    }
    let object_group = config.get(group).is_some_and(Value::is_object);
    if let Some((og, ok)) = orig
        && og == group
        && (!object_group || ok == name)
    {
        match config.get_mut(group) {
            Some(Value::Array(items)) => {
                let slot = ok
                    .parse::<usize>()
                    .ok()
                    .and_then(|i| items.get_mut(i))
                    .ok_or("Channel not found.")?;
                *slot = value;
            }
            Some(Value::Object(map)) => {
                map.insert(name.into(), value);
            }
            _ => return Err("Channel not found.".into()),
        }
        return Ok(());
    }
    if object_group {
        if name.is_empty() {
            return Err("Enter a name: this group stores channels by name.".into());
        }
        if config[group].get(name).is_some() {
            return Err(format!(
                "A channel named “{name}” already exists in {group}."
            ));
        }
    }
    if let Some((og, ok)) = orig {
        remove(config, og, ok)?;
    }
    match config
        .as_object_mut()
        .map(|root| root.entry(group).or_insert_with(|| json!([])))
    {
        Some(Value::Array(items)) => items.push(value),
        Some(Value::Object(map)) => {
            map.insert(name.into(), value);
        }
        _ => return Err("Config root must be a JSON object.".into()),
    }
    Ok(())
}

fn remove(config: &mut Value, group: &str, key: &str) -> Result<Value, String> {
    let removed = match config.get_mut(group) {
        Some(Value::Array(items)) => {
            let index = key
                .parse::<usize>()
                .ok()
                .filter(|i| *i < items.len())
                .ok_or("Channel not found.")?;
            items.remove(index)
        }
        Some(Value::Object(map)) => map.shift_remove(key).ok_or("Channel not found.")?,
        _ => return Err("Channel not found.".into()),
    };
    let empty = match &config[group] {
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    };
    // An empty group not named channels* would no longer be recognised.
    if empty
        && !group.to_lowercase().starts_with("channels")
        && let Some(root) = config.as_object_mut()
    {
        root.shift_remove(group);
    }
    Ok(removed)
}

fn channel_save(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let Ok(mut config) = serde_json::from_str::<Value>(&text) else {
        return redirect(
            "/channels",
            "config.json is not valid JSON; fix it in Advanced.",
            true,
        );
    };
    let rev = revision(&text);
    let form = ChannelForm::from_post(req);
    let groups = group_names(&config);
    let title = if form.orig_group.is_empty() {
        "New channel".to_string()
    } else {
        "Edit channel".to_string()
    };
    let fail = |message: String, form: &ChannelForm| {
        let notice = format!("<p class=\"notice error\">{}</p>", esc(&message));
        page(
            req,
            StatusCode::BAD_REQUEST,
            &title,
            &channel_form_html(form, &rev, &groups, &notice),
        )
    };
    if stale(req, &rev) {
        return fail(STALE.into(), &form);
    }
    let orig =
        (!form.orig_group.is_empty()).then_some((form.orig_group.as_str(), form.orig_key.as_str()));
    let original = orig.and_then(|(g, k)| find_channel(&config, g, k));
    if orig.is_some() && original.is_none() {
        return fail("The channel no longer exists.".into(), &form);
    }
    let mut value = match form.build(original.as_ref()) {
        Ok(v) => v,
        Err(message) => return fail(message, &form),
    };
    // A channel in a list group is keyed by its webhook, thread and feeds:
    // editing them would start its delivery history over. Keep the current
    // key, unless the channel already has one of its own.
    if let (Some((group, key)), Some(map)) = (orig, value.as_object_mut())
        && config.get(group).is_some_and(Value::is_array)
        && !["ID", "Key", "CacheKey"]
            .iter()
            .any(|k| map.contains_key(*k))
        && let Some(current) = delivery_key(server, group, key)
    {
        map.insert("CacheKey".into(), json!(current));
    }
    if let Err(message) = place(&mut config, orig, &form.group, &form.name, value) {
        return fail(message, &form);
    }
    match server.store(&config, &text, form.accept) {
        Ok(()) => redirect("/channels", "Channel saved.", false),
        Err(problems) => {
            let notice = problems_html(&problems, true);
            page(
                req,
                StatusCode::UNPROCESSABLE_ENTITY,
                &title,
                &channel_form_html(&form, &rev, &groups, &notice),
            )
        }
    }
}

fn channel_delete_confirm(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let config: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let (group, key) = (req.q("group"), req.q("key"));
    let Some(raw) = find_channel(&config, group, key) else {
        return redirect("/channels", "Channel not found.", true);
    };
    let object_group = config.get(group).is_some_and(Value::is_object);
    let feeds = feed_list(&channel_data(&raw));
    let body = format!(
        "<p>Delete <strong>{}</strong> with {} source(s)? Its delivery history stays in the cache.</p>{}\
         <form method=\"post\" action=\"/channels/delete\" class=\"row\">{}{}{}<button class=\"danger\">Delete</button><a href=\"/channels\">Cancel</a></form>",
        esc(&channel_label(group, key, object_group)),
        feeds.len(),
        list(&feeds, "muted"),
        hidden("rev", &revision(&text)),
        hidden("group", group),
        hidden("key", key),
    );
    page(req, StatusCode::OK, "Delete channel", &body)
}

fn channel_delete(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let Ok(mut config) = serde_json::from_str::<Value>(&text) else {
        return redirect("/channels", "config.json is not valid JSON.", true);
    };
    if stale(req, &revision(&text)) {
        return redirect("/channels", STALE, true);
    }
    if let Err(message) = remove(&mut config, req.f("group"), req.f("key")) {
        return redirect("/channels", &message, true);
    }
    match server.store(&config, &text, true) {
        Ok(()) => redirect("/channels", "Channel deleted.", false),
        Err(p) => redirect("/channels", &p.errors.join("; "), true),
    }
}

fn channel_duplicate(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let Ok(mut config) = serde_json::from_str::<Value>(&text) else {
        return redirect("/channels", "config.json is not valid JSON.", true);
    };
    if stale(req, &revision(&text)) {
        return redirect("/channels", STALE, true);
    }
    let (group, key) = (req.f("group"), req.f("key"));
    let Some(raw) = find_channel(&config, group, key) else {
        return redirect("/channels", "Channel not found.", true);
    };
    let mut copy = Value::Object(channel_data(&raw));
    if let Some(map) = copy.as_object_mut() {
        for k in ["ID", "Key", "CacheKey"] {
            map.shift_remove(k);
        }
    }
    let name = match config.get(group) {
        Some(Value::Object(map)) => {
            let mut i = 2;
            while map.contains_key(&format!("{key} {i}")) {
                i += 1;
            }
            format!("{key} {i}")
        }
        _ => String::new(),
    };
    if let Err(message) = place(&mut config, None, group, &name, copy) {
        return redirect("/channels", &message, true);
    }
    match server.store(&config, &text, true) {
        Ok(()) => redirect(
            "/channels",
            "Channel duplicated (added at the end of its group).",
            false,
        ),
        Err(p) => redirect("/channels", &p.errors.join("; "), true),
    }
}

// ------------------------------------------------------------ diagnostics --

fn valid_diag_name(name: &str) -> bool {
    let Some((kind, rest)) = name.split_once('-') else {
        return false;
    };
    let ext = match kind {
        "events" => ".txt",
        "summary" => ".md",
        _ => return false,
    };
    rest.strip_suffix(ext).is_some_and(|date| {
        date.len() == 10 && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
    })
}

/// Last `max` bytes of a file, starting at a line boundary.
fn tail(path: &Path, max: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map_or(0, |m| m.len());
    let start = len.saturating_sub(max);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    let _ = file.take(max).read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        text.split_once('\n')
            .map_or(text.clone(), |(_, rest)| rest.to_string())
    } else {
        text
    }
}

/// Minimal Markdown → HTML for the generated summary (headings, lists,
/// pipe tables, code spans, bold). Everything is escaped first.
#[cfg(test)]
pub(super) fn summary_html_for_tests(markdown: &str) -> String {
    format!(
        "<html lang=\"en\"><body>{}</body></html>",
        summary_html(markdown)
    )
}

fn summary_html(markdown: &str) -> String {
    let inline = |text: &str| -> String {
        let escaped = esc(text);
        let mut out = String::new();
        for (i, part) in escaped.split('`').enumerate() {
            if i % 2 == 1 {
                let _ = write!(out, "<code>{part}</code>");
            } else {
                for (j, piece) in part.split("**").enumerate() {
                    if j % 2 == 1 {
                        let _ = write!(out, "<strong>{piece}</strong>");
                    } else {
                        out.push_str(piece);
                    }
                }
            }
        }
        out
    };
    let mut out = String::new();
    let mut in_list = false;
    let mut table: Vec<Vec<String>> = Vec::new();
    let flush_table = |table: &mut Vec<Vec<String>>, out: &mut String| {
        if table.is_empty() {
            return;
        }
        out.push_str("<div class=\"scroll\"><table>");
        for (i, row) in table.iter().enumerate() {
            let cell = if i == 0 { "th" } else { "td" };
            out.push_str("<tr>");
            for c in row {
                let _ = write!(out, "<{cell}>{}</{cell}>", inline(c));
            }
            out.push_str("</tr>");
        }
        out.push_str("</table></div>");
        table.clear();
    };
    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('|') {
            if in_list {
                out.push_str("</ul>");
                in_list = false;
            }
            let cells: Vec<String> = trimmed
                .trim_matches('|')
                .split('|')
                .map(|c| c.trim().to_string())
                .collect();
            if !cells
                .iter()
                .all(|c| c.chars().all(|ch| ch == '-' || ch == ':'))
            {
                table.push(cells);
            }
            continue;
        }
        flush_table(&mut table, &mut out);
        if let Some(item) = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("  - "))
        {
            if !in_list {
                out.push_str("<ul>");
                in_list = true;
            }
            let _ = write!(out, "<li>{}</li>", inline(item));
            continue;
        }
        if in_list {
            out.push_str("</ul>");
            in_list = false;
        }
        if let Some(h) = trimmed.strip_prefix("### ") {
            let _ = write!(out, "<h4>{}</h4>", inline(h));
        } else if let Some(h) = trimmed.strip_prefix("## ") {
            let _ = write!(out, "<h3>{}</h3>", inline(h));
        } else if let Some(h) = trimmed.strip_prefix("# ") {
            let _ = write!(out, "<h2>{}</h2>", inline(h));
        } else if !trimmed.is_empty() {
            let _ = write!(out, "<p>{}</p>", inline(trimmed));
        }
    }
    flush_table(&mut table, &mut out);
    if in_list {
        out.push_str("</ul>");
    }
    out
}

fn diagnostics(server: &Server, req: &Req) -> Response {
    let config = read_json(&server.paths.config);
    let dir = server.diagnostics_dir(&config);
    let shape = config::runtime_shape(&config).unwrap_or_else(|_| json!({}));
    let enabled = crate::diagnostics::Options::from_settings(
        js::get(&shape, "Settings"),
        Path::new("."),
        false,
    )
    .is_some();
    let mut files: Vec<(String, u64)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            valid_diag_name(&name).then(|| (name, e.metadata().map_or(0, |m| m.len())))
        })
        .collect();
    files.sort_by(|a, b| {
        b.0[b.0.find('-').unwrap_or(0)..]
            .cmp(&a.0[a.0.find('-').unwrap_or(0)..])
            .then(b.0.cmp(&a.0))
    });
    let mut body = format!(
        "<p class=\"muted\">Recorder: <strong>{}</strong> · folder <code>{}</code>. Enable or tune it in <a href=\"/settings\">Settings</a>; the worker must be restarted to apply.</p>",
        if enabled { "enabled" } else { "disabled" },
        esc(&dir.display().to_string())
    );
    if files.is_empty() {
        body.push_str("<p class=\"muted\">No diagnostics files yet.</p>");
        return page(req, StatusCode::OK, "Diagnostics", &body);
    }
    let selected = req.q("file");
    let selected = if valid_diag_name(selected) && files.iter().any(|(n, _)| n == selected) {
        selected.to_string()
    } else {
        files
            .iter()
            .find(|(n, _)| n.starts_with("summary-"))
            .unwrap_or(&files[0])
            .0
            .clone()
    };
    body.push_str("<div class=\"split wide\"><nav class=\"files\"><h2>Files</h2><ul>");
    for (name, size) in &files {
        let _ = write!(
            body,
            "<li><a href=\"/diagnostics?file={}\"{}>{}</a> <small>{:.1} MB</small></li>",
            esc(&enc(name)),
            if *name == selected {
                " aria-current=\"page\""
            } else {
                ""
            },
            esc(name),
            *size as f64 / 1_048_576.0
        );
    }
    body.push_str("</ul></nav><div>");
    let path = dir.join(&selected);
    if selected.starts_with("summary-") {
        let _ = write!(
            body,
            "<article class=\"report\">{}</article>",
            summary_html(&std::fs::read_to_string(&path).unwrap_or_default())
        );
    } else {
        let text = tail(&path, 128 * 1024);
        let last: Vec<&str> = text.lines().rev().take(300).collect();
        let _ = write!(
            body,
            "<h2>{}</h2><p class=\"muted\">Newest 300 events first (one JSON object per line). The full file is on the server.</p><pre class=\"log\">{}</pre>",
            esc(&selected),
            esc(&last.join("\n"))
        );
    }
    body.push_str("</div></div>");
    html(StatusCode::OK, layout(req, "Diagnostics", &body, None))
}

// --------------------------------------------------------------- settings --

fn settings_section(config: &Value) -> (&'static str, &Value) {
    if is_v2(config) {
        ("settings", js::get(config, "settings"))
    } else {
        ("Settings", js::get(config, "Settings"))
    }
}

fn settings(server: &Server, req: &Req, notice: Option<String>) -> Response {
    let text = read_text(&server.paths.config);
    let config: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let rev = revision(&text);
    let v2 = is_v2(&config);
    let (_, section) = settings_section(&config);
    let key = |v1: &str, v2k: &str| js::get(section, if v2 { v2k } else { v1 });
    let diag = key("Diagnostics", "diagnostics");
    let diag_on = match diag {
        Value::Bool(b) => *b,
        Value::Object(_) => js::get(diag, "Enabled") != &Value::Bool(false),
        _ => false,
    };
    let diag_num = |k: &str, d: u64| js::get(diag, k).as_u64().unwrap_or(d).to_string();
    let mut body = notice.unwrap_or_default();
    let _ = write!(
        body,
        "<form method=\"post\" action=\"/settings/general\" class=\"stack\">{}\
         <fieldset><legend>General</legend>{}{}<div class=\"grid3\">{}{}</div></fieldset>\
         <fieldset><legend>Diagnostics recorder</legend><p class=\"muted\">Records every event, timing and log line to <code>diagnostics/</code> and writes a latency report. Applied after a worker restart.</p>{}<div class=\"grid3\">{}{}{}</div></fieldset>\
         <div class=\"row\">{}<button>Save</button></div></form>",
        hidden("rev", &rev),
        checkbox(
            "Write log files (Logs)",
            "logs",
            key("Logs", "logs") == &json!(true)
        ),
        checkbox(
            "Expert diagnostics on stdout (DebugExpert)",
            "expert",
            key("DebugExpert", "debugExpert") == &json!(true)
        ),
        text_input(
            "Channels processed at once",
            "max_concurrent",
            &js::to_string_or_empty(&js::or_else(
                &[key("MaxConcurrentChannels", "maxConcurrentChannels")],
                json!(1)
            )),
            "1–8.",
            "number"
        ),
        text_input(
            "First-run send (global)",
            "first_run_send",
            &js::to_string_or_empty(key("FirstRunSend", "firstRunSend")),
            "Newest N entries posted when a feed is first seen. Empty = 0.",
            "number"
        ),
        checkbox("Enabled", "diag_enabled", diag_on),
        text_input(
            "Report every (minutes)",
            "diag_summary",
            &diag_num("SummaryMinutes", 15),
            "",
            "number"
        ),
        text_input(
            "Keep files (days)",
            "diag_retention",
            &diag_num("RetentionDays", 14),
            "",
            "number"
        ),
        text_input(
            "Max file size per day (MB)",
            "diag_max_mb",
            &diag_num("MaxFileMB", 256),
            "",
            "number"
        ),
        checkbox("Save despite warnings", "accept", false),
    );

    if !v2 {
        body.push_str(&features_form(&config, &rev));
    }
    body.push_str(&clearances_html(server));

    // Network
    let raw = js::get(&config, "network");
    let get = |k: &str| js::to_string_or_empty(js::get(raw, k));
    let profile = js::get(raw, "bandwidthProfile")
        .as_str()
        .unwrap_or("unlimited");
    let policy = js::get(raw, "outboundPolicy")
        .as_str()
        .unwrap_or("unrestricted");
    let mut options = String::new();
    for name in config::PRESETS.iter().map(|(n, _)| *n).chain(["custom"]) {
        let _ = write!(
            options,
            "<option{}>{name}</option>",
            if name == profile { " selected" } else { "" }
        );
    }
    let mut policies = String::new();
    for name in ["unrestricted", "public-only"] {
        let _ = write!(
            policies,
            "<option{}>{name}</option>",
            if name == policy { " selected" } else { "" }
        );
    }
    let runtime = network_runtime(&server.paths.config, raw);
    let effective = config::normalize_network(raw).ok().map(|n| {
        format!(
            "HTTP concurrency {} · browser concurrency {} · request deadline {}",
            n.http_concurrency()
                .map_or("unlimited".into(), |c| c.to_string()),
            n.scrapling_concurrency()
                .map_or("unlimited".into(), |c| c.to_string()),
            n.request_deadline_ms
                .map_or("none".into(), |d| ms(d as f64)),
        )
    });
    let _ = write!(
        body,
        "<form method=\"post\" action=\"/settings/network\" class=\"stack\">{}\
         <fieldset><legend>Network</legend><p class=\"muted\">Empty fields use the defaults. {}</p>\
         <div class=\"grid3\"><label>Bandwidth profile<select name=\"bandwidthProfile\">{options}</select></label>{}{}</div>\
         <div class=\"grid3\">{}{}<label>Outbound policy<select name=\"outboundPolicy\">{policies}</select><small>public-only blocks private and local addresses.</small></label></div>\
         <div class=\"grid3\">{}{}{}</div><div class=\"grid3\">{}{}</div>{}{}</fieldset>\
         <div class=\"row\"><button>Save network settings</button></div></form>\
         <p class=\"muted\">Worker: {}</p>",
        hidden("rev", &rev),
        esc(&effective.unwrap_or_else(|| "The current network section is invalid.".into())),
        text_input(
            "Download limit (Mbps)",
            "downloadLimitMbps",
            &get("downloadLimitMbps"),
            "custom profile only",
            "text"
        ),
        text_input(
            "Upload limit (Mbps)",
            "uploadLimitMbps",
            &get("uploadLimitMbps"),
            "custom profile only",
            "text"
        ),
        text_input(
            "Max parallel requests",
            "maxConcurrentRequests",
            &get("maxConcurrentRequests"),
            "",
            "number"
        ),
        text_input(
            "Max parallel browser fetches",
            "maxConcurrentScraplingRequests",
            &get("maxConcurrentScraplingRequests"),
            "",
            "number"
        ),
        text_input(
            "Connect timeout (ms)",
            "setupTimeoutMs",
            &get("setupTimeoutMs"),
            "",
            "number"
        ),
        text_input(
            "Idle timeout (ms)",
            "idleTimeoutMs",
            &get("idleTimeoutMs"),
            "",
            "number"
        ),
        text_input(
            "Request deadline (ms)",
            "requestDeadlineMs",
            &get("requestDeadlineMs"),
            "",
            "number"
        ),
        text_input(
            "Shutdown grace (ms)",
            "shutdownGraceMs",
            &get("shutdownGraceMs"),
            "",
            "number"
        ),
        text_input(
            "Max response size (bytes)",
            "maxResponseBytes",
            &get("maxResponseBytes"),
            "",
            "number"
        ),
        checkbox(
            "Network-friendly mode",
            "networkFriendlyMode",
            js::get(raw, "networkFriendlyMode") == &json!(true)
        ),
        checkbox(
            "Browser resource saving",
            "scraplingResourceSaving",
            js::get(raw, "scraplingResourceSaving") != &json!(false)
        ),
        if runtime["available"] == json!(true) {
            format!(
                "reporting{} · updated {}",
                if runtime["applied"] == json!(true) {
                    ", settings applied"
                } else {
                    ", settings not applied yet"
                },
                esc(&runtime["updatedAt"].as_str().map_or("–".into(), ago))
            )
        } else {
            esc(runtime["reason"].as_str().unwrap_or("unavailable"))
        },
    );

    // Secrets
    let env_text = read_text(&server.paths.env);
    let secrets = secret_status(&config, &env_text);
    let env_rev = revision(&env_text);
    body.push_str("<section><h2>Secrets (.env)</h2><p class=\"muted\">Values are never shown. Setting one replaces it in .env; the worker reads it on its next cycle.</p>");
    if secrets.is_empty() {
        body.push_str(
            "<p class=\"muted\">The config references no ${ENV} values and .env is empty.</p>",
        );
    } else {
        body.push_str(
            "<table><thead><tr><th>Name</th><th>Status</th><th>New value</th></tr></thead><tbody>",
        );
        for (name, status) in &secrets {
            let editable = !reserved_secret(name);
            let _ = write!(
                body,
                "<tr><td><code>{}</code></td><td>{}</td><td>{}</td></tr>",
                esc(name),
                esc(status.as_str().unwrap_or("")),
                if editable {
                    format!(
                        "<form method=\"post\" action=\"/settings/secret\" class=\"row\">{}{}<input type=\"password\" name=\"value\" autocomplete=\"off\" required><button>Set</button></form>",
                        hidden("env_rev", &env_rev),
                        hidden("name", name)
                    )
                } else {
                    "reserved".into()
                }
            );
        }
        body.push_str("</tbody></table>");
    }
    body.push_str("</section>");
    page(req, StatusCode::OK, "Settings", &body)
}

/// Value of an optional switchable feature: `true`, `{ "Enabled": … }` or absent.
fn feature_on(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Object(map) => map.get("Enabled") != Some(&Value::Bool(false)),
        _ => false,
    }
}

fn features_form(config: &Value, rev: &str) -> String {
    let settings = js::get(config, "Settings");
    let adaptive = js::get(settings, "AdaptivePolling");
    let merge = js::get(settings, "SteamMerge");
    let telegram = js::get(config, "Telegram");
    let num = |v: &Value, k: &str, d: &str| {
        js::get(v, k)
            .as_f64()
            .map_or_else(|| d.to_string(), |n| n.to_string())
    };
    let token = js::to_string_or_empty(js::get(telegram, "BotToken"));
    let token_shown = if token.starts_with("${") {
        token.clone()
    } else {
        String::new()
    };
    let token_hint = if token.is_empty() || token.starts_with("${") {
        "Use ${NAME} and set the value under Secrets (.env) below."
    } else {
        "A token is written directly in config.json; empty keeps it. Better: ${NAME} with the value in .env."
    };
    format!(
        "<form method=\"post\" action=\"/settings/features\" class=\"stack\">{}\
         <fieldset><legend>Adaptive polling</legend><p class=\"muted\">Feeds that post often are checked more often (never less often than the channel's “Check every”). Off = every feed is checked at its channel's interval.</p>{}<div class=\"grid3\">{}{}{}</div></fieldset>\
         <fieldset><legend>Steam + SteamDB in one post</legend><p class=\"muted\">A SteamDB patch note and the Steam news about the same update become one post (edited when the second arrives).</p>{}<div class=\"grid3\">{}</div></fieldset>\
         <fieldset><legend>Cloudflare</legend>{}<small>Reuses a solved Cloudflare clearance for plain requests until it expires, so the browser is started less often. Temporary mechanism.</small></fieldset>\
         <fieldset><legend>Telegram (defaults for all channels)</legend>{}<div class=\"grid3\">{}{}{}</div><div class=\"grid3\">{}{}{}</div></fieldset>\
         <div class=\"row\">{}<button>Save</button></div></form>",
        hidden("rev", rev),
        checkbox("Enabled", "adaptive", feature_on(adaptive)),
        text_input(
            "Fastest check (minutes)",
            "adaptive_min",
            &num(adaptive, "MinMinutes", "5"),
            "Default 5.",
            "text"
        ),
        text_input(
            "“Fresh” for (hours)",
            "adaptive_burst",
            &num(adaptive, "BurstHours", "6"),
            "After a new entry the feed is checked at the fastest rate for this long. Default 6.",
            "text"
        ),
        text_input(
            "Divisor",
            "adaptive_divisor",
            &num(adaptive, "Divisor", "8"),
            "Interval = average gap between entries ÷ this. Default 8.",
            "text"
        ),
        checkbox("Enabled", "merge", feature_on(merge)),
        text_input(
            "Window (hours)",
            "merge_hours",
            &num(merge, "WindowHours", "12"),
            "How far apart the two may arrive. 1–72, default 12.",
            "text"
        ),
        checkbox(
            "Reuse the Cloudflare clearance (ReuseClearance)",
            "reuse_clearance",
            js::path(config, &["Scrapling", "ReuseClearance"]) == &json!(true)
        ),
        checkbox(
            "Enabled",
            "tg_enabled",
            telegram.is_object() && js::get(telegram, "Enabled") != &json!(false)
        ),
        text_input("Bot token", "tg_token", &token_shown, token_hint, "text"),
        text_input(
            "Chat ID",
            "tg_chat",
            &js::to_string_or_empty(js::get(telegram, "ChatID")),
            "Or ${NAME}.",
            "text"
        ),
        text_input(
            "Topic (message thread) ID",
            "tg_thread",
            &js::to_string_or_empty(js::get(telegram, "MessageThreadID")),
            "Optional.",
            "text"
        ),
        checkbox(
            "Send the image as a photo",
            "tg_photo",
            js::get(telegram, "SendPhoto") != &json!(false)
        ),
        checkbox(
            "Turn off link previews",
            "tg_nopreview",
            js::get(telegram, "DisableWebPagePreview") == &json!(true)
        ),
        text_input(
            "Timeout (ms)",
            "tg_timeout",
            &js::to_string_or_empty(js::get(telegram, "TimeoutMs")),
            "Empty = 15000.",
            "text"
        ),
        checkbox("Save despite warnings", "accept", false),
    )
}

fn clearance_path(server: &Server) -> std::path::PathBuf {
    crate::clearance::path_for(server.paths.config.parent().unwrap_or(Path::new(".")))
}

fn clearances_html(server: &Server) -> String {
    let saved = crate::clearance::list(&clearance_path(server));
    if saved.is_empty() {
        return String::new();
    }
    let now = chrono::Utc::now().timestamp();
    let mut rows = String::new();
    for (host, c) in &saved {
        let _ = write!(
            rows,
            "<tr><td>{}</td><td>{}</td><td>{}</td><td><form method=\"post\" action=\"/settings/clearance-forget\" class=\"inline\">{}<button class=\"link\">Forget</button></form></td></tr>",
            esc(host),
            esc(&ms_time(c.saved_at.max(0) as u64 * 1000)),
            if c.expires > 0 {
                format!("{} d", (c.expires - now).max(0) / 86_400)
            } else {
                "–".into()
            },
            hidden("host", host),
        );
    }
    format!(
        "<section><h2>Saved Cloudflare clearances</h2><p class=\"muted\">Forgetting one makes the next check of that site use the browser again. The worker notices it without a restart.</p>\
         <table><thead><tr><th>Site</th><th>Saved</th><th>Valid for</th><th></th></tr></thead><tbody>{rows}</tbody></table>\
         <form method=\"post\" action=\"/settings/clearance-forget\">{}<button class=\"danger\">Forget all</button></form></section>",
        hidden("host", "*"),
    )
}

fn clearance_forget(server: &Server, req: &Req) -> Response {
    let path = clearance_path(server);
    let mut saved = crate::clearance::list(&path);
    let host = req.f("host");
    let removed = if host == "*" {
        std::mem::take(&mut saved).len()
    } else {
        usize::from(saved.remove(host).is_some())
    };
    if removed == 0 {
        return redirect("/settings", "Nothing to forget.", true);
    }
    let text = serde_json::to_string_pretty(&saved).unwrap_or_else(|_| "{}".into());
    match write_private(&path, &text) {
        Ok(()) => redirect("/settings", "Clearance forgotten.", false),
        Err(e) => redirect(
            "/settings",
            &format!("Cannot write clearance.json: {e}"),
            true,
        ),
    }
}

fn settings_features(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let Ok(mut config) = serde_json::from_str::<Value>(&text) else {
        return redirect("/settings", "config.json is not valid JSON.", true);
    };
    if stale(req, &revision(&text)) {
        return redirect("/settings", STALE, true);
    }
    if is_v2(&config) {
        return redirect(
            "/settings",
            "This config uses schema v2; edit it in Advanced.",
            true,
        );
    }
    let number = |key: &str, label: &str, lo: f64, hi: f64| -> Result<Option<f64>, String> {
        match req.f(key).trim().replace(',', ".") {
            t if t.is_empty() => Ok(None),
            t => t
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && (lo..=hi).contains(n))
                .map(Some)
                .ok_or_else(|| format!("{label} must be a number {lo}–{hi}.")),
        }
    };
    let parsed = (|| -> Result<_, String> {
        Ok((
            number("adaptive_min", "Fastest check", 1.0, 1440.0)?,
            number("adaptive_burst", "“Fresh” for", 0.0, 168.0)?,
            number("adaptive_divisor", "Divisor", 1.0, 100.0)?,
            number("merge_hours", "Window", 1.0, 72.0)?,
            number("tg_timeout", "Timeout", 1000.0, 120_000.0)?,
        ))
    })();
    let (min, burst, divisor, hours, timeout) = match parsed {
        Ok(v) => v,
        Err(message) => return redirect("/settings", &message, true),
    };
    let thread = req.f("tg_thread").trim().to_string();
    if !thread.is_empty() && thread.parse::<u64>().is_err() {
        return redirect("/settings", "Topic ID must be a whole number.", true);
    }
    let as_json = |n: f64| {
        if n.fract() == 0.0 {
            json!(n as u64)
        } else {
            json!(n)
        }
    };
    // Keep unknown keys of each object; turning a feature off keeps its values.
    let object = |v: &Value| v.as_object().cloned().unwrap_or_default();
    if !config["Settings"].is_object() {
        config["Settings"] = json!({});
    }
    let section = &mut config["Settings"];
    let mut adaptive = object(&section["AdaptivePolling"]);
    adaptive.insert("Enabled".into(), json!(req.checked("adaptive")));
    for (key, value) in [
        ("MinMinutes", min),
        ("BurstHours", burst),
        ("Divisor", divisor),
    ] {
        match value {
            Some(n) => adaptive.insert(key.into(), as_json(n)),
            None => adaptive.shift_remove(key),
        };
    }
    section["AdaptivePolling"] = Value::Object(adaptive);
    let mut merge = object(&section["SteamMerge"]);
    merge.insert("Enabled".into(), json!(req.checked("merge")));
    match hours {
        Some(n) => merge.insert("WindowHours".into(), as_json(n)),
        None => merge.shift_remove("WindowHours"),
    };
    section["SteamMerge"] = Value::Object(merge);
    let reuse = req.checked("reuse_clearance");
    if reuse || config["Scrapling"].is_object() {
        if !config["Scrapling"].is_object() {
            config["Scrapling"] = json!({});
        }
        config["Scrapling"]["ReuseClearance"] = json!(reuse);
    }
    let tg_enabled = req.checked("tg_enabled");
    if tg_enabled || config["Telegram"].is_object() {
        let mut tg = object(&config["Telegram"]);
        tg.insert("Enabled".into(), json!(tg_enabled));
        let token = req.f("tg_token").trim();
        if !token.is_empty() {
            tg.insert("BotToken".into(), json!(token));
        }
        let chat = req.f("tg_chat").trim();
        if chat.is_empty() {
            tg.shift_remove("ChatID");
        } else {
            tg.insert("ChatID".into(), json!(chat));
        }
        tg.insert(
            "MessageThreadID".into(),
            thread.parse::<u64>().map_or(Value::Null, |n| json!(n)),
        );
        tg.insert("SendPhoto".into(), json!(req.checked("tg_photo")));
        tg.insert(
            "DisableWebPagePreview".into(),
            json!(req.checked("tg_nopreview")),
        );
        match timeout {
            Some(n) => tg.insert("TimeoutMs".into(), as_json(n)),
            None => tg.shift_remove("TimeoutMs"),
        };
        config["Telegram"] = Value::Object(tg);
    }
    match server.store(&config, &text, req.checked("accept")) {
        Ok(()) => redirect("/settings", "Settings saved.", false),
        Err(p) => settings(server, req, Some(problems_html(&p, true))),
    }
}

fn settings_general(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let Ok(mut config) = serde_json::from_str::<Value>(&text) else {
        return redirect("/settings", "config.json is not valid JSON.", true);
    };
    if stale(req, &revision(&text)) {
        return redirect("/settings", STALE, true);
    }
    let v2 = is_v2(&config);
    let Ok(max) = req.f("max_concurrent").trim().parse::<u64>() else {
        return redirect(
            "/settings",
            "Channels processed at once must be a number 1–8.",
            true,
        );
    };
    if !(1..=8).contains(&max) {
        return redirect("/settings", "Channels processed at once must be 1–8.", true);
    }
    let first_run = match req.f("first_run_send").trim() {
        "" => None,
        t => match t.parse::<u64>() {
            Ok(n) => Some(n),
            Err(_) => return redirect("/settings", "First-run send must be a whole number.", true),
        },
    };
    let num = |k: &str, d: u64, lo: u64, hi: u64| {
        req.f(k).trim().parse::<u64>().unwrap_or(d).clamp(lo, hi)
    };
    let (section, _) = settings_section(&config);
    if !config[section].is_object() {
        config[section] = json!({});
    }
    let s = &mut config[section];
    let name = |v1: &'static str, v2k: &'static str| if v2 { v2k } else { v1 };
    s[name("Logs", "logs")] = json!(req.checked("logs"));
    s[name("DebugExpert", "debugExpert")] = json!(req.checked("expert"));
    s[name("MaxConcurrentChannels", "maxConcurrentChannels")] = json!(max);
    let frs = name("FirstRunSend", "firstRunSend");
    match first_run {
        Some(n) => s[frs] = json!(n),
        None => {
            if let Some(map) = s.as_object_mut() {
                map.shift_remove(frs);
            }
        }
    }
    let diag_key = name("Diagnostics", "diagnostics");
    let mut diag = match &s[diag_key] {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    diag.insert("Enabled".into(), json!(req.checked("diag_enabled")));
    diag.insert(
        "SummaryMinutes".into(),
        json!(num("diag_summary", 15, 1, 1440)),
    );
    diag.insert(
        "RetentionDays".into(),
        json!(num("diag_retention", 14, 1, 365)),
    );
    diag.insert(
        "MaxFileMB".into(),
        json!(num("diag_max_mb", 256, 1, 10_240)),
    );
    s[diag_key] = Value::Object(diag);
    match server.store(&config, &text, req.checked("accept")) {
        Ok(()) => redirect("/settings", "Settings saved.", false),
        Err(p) => settings(server, req, Some(problems_html(&p, true))),
    }
}

fn settings_network(server: &Server, req: &Req) -> Response {
    let text = read_text(&server.paths.config);
    let Ok(mut config) = serde_json::from_str::<Value>(&text) else {
        return redirect("/settings", "config.json is not valid JSON.", true);
    };
    if stale(req, &revision(&text)) {
        return redirect("/settings", STALE, true);
    }
    let mut network = match js::get(&config, "network") {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for key in ["bandwidthProfile", "outboundPolicy"] {
        network.insert(key.into(), json!(req.f(key)));
    }
    for key in ["downloadLimitMbps", "uploadLimitMbps"] {
        match req.f(key).trim() {
            "" => {
                network.shift_remove(key);
            }
            t => match t.parse::<f64>() {
                Ok(n) => {
                    network.insert(key.into(), js::number(n));
                }
                Err(_) => return redirect("/settings", &format!("{key} must be a number."), true),
            },
        }
    }
    for key in [
        "maxConcurrentRequests",
        "maxConcurrentScraplingRequests",
        "setupTimeoutMs",
        "idleTimeoutMs",
        "requestDeadlineMs",
        "shutdownGraceMs",
        "maxResponseBytes",
    ] {
        match req.f(key).trim() {
            "" => {
                network.shift_remove(key);
            }
            t => match t.parse::<u64>() {
                Ok(n) => {
                    network.insert(key.into(), json!(n));
                }
                Err(_) => {
                    return redirect("/settings", &format!("{key} must be a whole number."), true);
                }
            },
        }
    }
    network.insert(
        "networkFriendlyMode".into(),
        json!(req.checked("networkFriendlyMode")),
    );
    network.insert(
        "scraplingResourceSaving".into(),
        json!(req.checked("scraplingResourceSaving")),
    );
    let network = Value::Object(network);
    if let Err(issues) = config::normalize_network(&network) {
        let messages: Vec<String> = issues
            .iter()
            .map(|i| format!("{}: {}", i.path, i.message))
            .collect();
        return redirect("/settings", &messages.join("; "), true);
    }
    config["network"] = network;
    match server.store(&config, &text, true) {
        Ok(()) => redirect("/settings", "Network settings saved.", false),
        Err(p) => redirect("/settings", &p.errors.join("; "), true),
    }
}

fn settings_secret(server: &Server, req: &Req) -> Response {
    let name = req.f("name");
    let valid = !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid || reserved_secret(name) {
        return redirect("/settings", "Invalid or reserved secret name.", true);
    }
    let config = read_json(&server.paths.config);
    let existing = read_text(&server.paths.env);
    if !secret_status(&config, &existing).contains_key(name) {
        return redirect(
            "/settings",
            "The secret must be referenced by the config or declared in .env.",
            true,
        );
    }
    if req.f("env_rev") != revision(&existing) {
        return redirect(
            "/settings",
            ".env changed since this page was opened. Try again.",
            true,
        );
    }
    match replace_secret(&existing, name, req.f("value")) {
        Err(message) => redirect("/settings", message, true),
        Ok(updated) => match write_private(&server.paths.env, &updated) {
            Ok(()) => redirect("/settings", &format!("{name} updated."), false),
            Err(e) => redirect("/settings", &sanitize_text(&e.to_string()), true),
        },
    }
}

// --------------------------------------------------------------- advanced --

fn advanced(server: &Server, req: &Req, text: Option<&str>, notice: Option<String>) -> Response {
    let current = read_text(&server.paths.config);
    let body = format!(
        "{}<p class=\"notice warn\">This is the raw config.json. It may contain webhook URLs and tokens: do not share screenshots of this page.</p>\
         <form method=\"post\" action=\"/advanced\" class=\"stack\">{}{}\
         <div class=\"row\">{}<button>Validate and save</button><a href=\"/advanced\">Discard changes</a></div></form>",
        notice.unwrap_or_default(),
        hidden("rev", &revision(&current)),
        textarea("config.json", "config", text.unwrap_or(&current), 32, ""),
        checkbox("Save despite warnings", "accept", false),
    );
    page(
        req,
        if text.is_some() {
            StatusCode::UNPROCESSABLE_ENTITY
        } else {
            StatusCode::OK
        },
        "Advanced",
        &body,
    )
}

fn advanced_save(server: &Server, req: &Req) -> Response {
    let current = read_text(&server.paths.config);
    // Browsers submit textarea line breaks as CRLF.
    let mut posted = req.f("config").replace("\r\n", "\n");
    if stale(req, &revision(&current)) {
        return advanced(
            server,
            req,
            Some(&posted),
            Some(format!("<p class=\"notice error\">{STALE}</p>")),
        );
    }
    let next = match serde_json::from_str::<Value>(&posted) {
        Ok(v @ Value::Object(_)) => v,
        Ok(_) => {
            return advanced(
                server,
                req,
                Some(&posted),
                Some("<p class=\"notice error\">The root must be a JSON object.</p>".into()),
            );
        }
        Err(e) => {
            return advanced(
                server,
                req,
                Some(&posted),
                Some(format!(
                    "<p class=\"notice error\">Invalid JSON: {}</p>",
                    esc(&e.to_string())
                )),
            );
        }
    };
    let problems = server.problems(&next);
    if !problems.errors.is_empty() || (!problems.warnings.is_empty() && !req.checked("accept")) {
        return advanced(
            server,
            req,
            Some(&posted),
            Some(problems_html(&problems, true)),
        );
    }
    if !posted.ends_with('\n') {
        posted.push('\n');
    }
    if current.contains("\r\n") {
        posted = posted.replace('\n', "\r\n");
    }
    match write_private(&server.paths.config, &posted) {
        Ok(()) => redirect("/advanced", "config.json saved.", false),
        Err(e) => advanced(
            server,
            req,
            Some(&posted),
            Some(format!(
                "<p class=\"notice error\">{}</p>",
                esc(&sanitize_text(&e.to_string()))
            )),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaping() {
        assert_eq!(
            esc("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }

    #[test]
    fn channel_form_round_trip_keeps_order_and_unknown_keys() {
        let raw = json!({
            "Webhook": "${HOOK}", "Thread": "42", "RSS": ["https://a.example/feed"],
            "Telegram": { "ChatID": "@x" }, "TimeChecker": 60,
            "Filters": { "Include": ["patch"], "MaxAgeHours": 24 }
        });
        let form = ChannelForm::from_value("channels", "0", &raw);
        assert_eq!(form.sources, "https://a.example/feed");
        assert_eq!(form.include, "patch");
        assert!(form.extra.contains("Telegram"));
        let built = form.build(Some(&raw)).unwrap();
        assert_eq!(built, raw);
        let keys: Vec<&String> = built.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "Webhook",
                "Thread",
                "RSS",
                "Telegram",
                "TimeChecker",
                "Filters"
            ]
        );
    }

    #[test]
    fn channel_form_edits() {
        let raw = json!("https://a.example/feed");
        let mut form = ChannelForm::from_value("channels", "1", &raw);
        form.sources =
            "https://a.example/feed\nhttps://b.example/rss\nhttps://b.example/rss\n".into();
        form.time_checker = "15".into();
        form.webhook = "https://discord.com/api/webhooks/1/x".into();
        let built = form.build(Some(&raw)).unwrap();
        assert_eq!(
            built["Feeds"],
            json!(["https://a.example/feed", "https://b.example/rss"])
        );
        assert_eq!(built["TimeChecker"], json!(15));
        form.time_checker = "soon".into();
        assert!(form.build(Some(&raw)).is_err());
        form.time_checker = String::new();
        form.extra = "{\"Webhook\":\"dup\"}".into();
        assert!(form.build(Some(&raw)).unwrap_err().contains("both"));
        form.extra = String::new();
        form.sources = "ftp://x".into();
        assert!(form.build(None).is_err());
    }

    #[test]
    fn placing_and_removing_channels() {
        let mut config = json!({ "Settings": {}, "channels": [{ "RSS": ["https://a/1"] }], "channelsNamed": { "One": { "RSS": ["https://a/2"] } } });
        place(
            &mut config,
            None,
            "channels",
            "",
            json!({ "RSS": ["https://a/3"] }),
        )
        .unwrap();
        assert_eq!(config["channels"].as_array().unwrap().len(), 2);
        place(
            &mut config,
            Some(("channels", "0")),
            "channels",
            "",
            json!({ "RSS": ["https://a/9"] }),
        )
        .unwrap();
        assert_eq!(config["channels"][0]["RSS"][0], "https://a/9");
        assert!(
            place(
                &mut config,
                None,
                "channelsNamed",
                "One",
                json!({ "RSS": ["https://a/4"] })
            )
            .is_err()
        );
        assert!(
            place(
                &mut config,
                None,
                "Settings",
                "",
                json!({ "RSS": ["https://a/4"] })
            )
            .is_err()
        );
        assert!(
            place(
                &mut config,
                None,
                "news",
                "",
                json!({ "RSS": ["https://a/4"] })
            )
            .is_err()
        );
        place(
            &mut config,
            Some(("channels", "1")),
            "channelsNamed",
            "Two",
            json!({ "RSS": ["https://a/3"] }),
        )
        .unwrap();
        assert_eq!(config["channels"].as_array().unwrap().len(), 1);
        assert_eq!(config["channelsNamed"]["Two"]["RSS"][0], "https://a/3");
        remove(&mut config, "channelsNamed", "One").unwrap();
        assert!(config["channelsNamed"].get("One").is_none());
        assert!(remove(&mut config, "channels", "5").is_err());
    }

    #[test]
    fn diagnostics_names_and_markdown() {
        assert!(valid_diag_name("summary-2026-11-17.md"));
        assert!(valid_diag_name("events-2026-11-17.txt"));
        assert!(!valid_diag_name("../config.json"));
        assert!(!valid_diag_name("events-2026-11-17.md"));
        let md = "# T\n\n| a | b |\n|---|---|\n| <x> | `y` |\n\n- **bold** item\n";
        let out = summary_html(md);
        assert!(
            out.contains("<th>a</th>")
                && out.contains("<td>&lt;x&gt;</td>")
                && out.contains("<code>y</code>")
        );
        assert!(out.contains("<li><strong>bold</strong> item</li>"));
        assert!(!out.contains("<x>"));
    }
}
