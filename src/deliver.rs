//! Destinations (Discord webhook in Components V2, Telegram Bot API) and the
//! Discord channel source. Payload formats match the Node.js senders.

use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::config::Telegram;
use crate::http::{self, HttpError};
use crate::js::{self, get, len16, prefix16, truthy};
use crate::text::discord_time;

const COMPONENTS_V2: u64 = 1 << 15;
const MAX_TEXT: usize = 1800;
const MAX_BUTTON: usize = 80;
const MAX_MEDIA: usize = 10;
const MAX_429_RETRIES: u32 = 3;

#[derive(Debug)]
pub enum SendError {
    Cancelled,
    Failed(String),
    /// The destination itself is gone or forbidden (deleted thread/webhook,
    /// revoked token, unknown chat); retrying other entries now is pointless.
    Unreachable(String),
    /// The message to edit no longer exists.
    Gone,
}

/// Discord answers that do not depend on the message being sent.
fn discord_target_gone(status: u16, body: &str) -> bool {
    let code = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|b| b.get("code").and_then(Value::as_u64));
    matches!(status, 401 | 403 | 404)
        || (status == 400 && matches!(code, Some(10003 | 10015 | 50001 | 50083)))
}

fn telegram_target_gone(status: u16, description: &str) -> bool {
    let text = description.to_lowercase();
    matches!(status, 401 | 403)
        || (status == 400 && (text.contains("chat not found") || text.contains("thread not found")))
}

impl From<HttpError> for SendError {
    fn from(error: HttpError) -> Self {
        match error {
            HttpError::Cancelled => Self::Cancelled,
            other => Self::Failed(other.to_string()),
        }
    }
}

/// `Settings.PostText`: Discord posts show the longer `contentText` (bold
/// headings, named links), cut at the end of a line at `Length` characters
/// (default 1500, 300–3500). `false` or `"Enabled": false` = the previous
/// layout (`contentSnippet`, at most 800 characters).
static POST_TEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1500);

pub fn set_post_text(root: &Value) {
    POST_TEXT.store(post_text_length(root), std::sync::atomic::Ordering::Relaxed);
}

fn post_text_length(root: &Value) -> usize {
    let raw = get(get(root, "Settings"), "PostText");
    match raw {
        Value::Bool(false) => 0,
        Value::Object(map) if map.get("Enabled") == Some(&Value::Bool(false)) => 0,
        _ => get(raw, "Length")
            .as_u64()
            .map_or(1500, |n| n.clamp(300, 3500) as usize),
    }
}

fn post_body(entry: &Value) -> String {
    let length = POST_TEXT.load(std::sync::atomic::Ordering::Relaxed);
    match get(entry, "contentText").as_str() {
        Some(text) if length > 0 && !text.trim().is_empty() => {
            crate::text::cut_text(text.trim(), length)
        }
        _ => truncate(get(entry, "contentSnippet"), 800),
    }
}

fn safe_text(value: &Value, max: usize) -> String {
    if value.is_null() {
        return String::new();
    }
    let text = js::to_string(value).replace('\0', "");
    let text = js::trim(&text);
    if len16(text) <= max {
        return text.to_string();
    }
    format!("{}...", js::trim_end(prefix16(text, max - 3)))
}

fn truncate(value: &Value, max: usize) -> String {
    if !truthy(value) {
        return String::new();
    }
    let text = js::to_string(value);
    if len16(&text) > max {
        format!("{}...", js::trim(prefix16(&text, max)))
    } else {
        text
    }
}

fn http_url(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let parsed = url::Url::parse(text).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| text.to_string())
}

struct Container(Vec<Value>);

impl Container {
    fn text(&mut self, value: impl Into<Value>) {
        let content = safe_text(&value.into(), MAX_TEXT);
        if !content.is_empty() {
            self.0.push(json!({ "type": 10, "content": content }));
        }
    }
    fn media(&mut self, items: Vec<(Value, Value)>) {
        let items: Vec<Value> = items
            .into_iter()
            .filter_map(|(url, description)| {
                let url = http_url(&url)?;
                let description = safe_text(&description, 200);
                Some(if description.is_empty() {
                    json!({ "media": { "url": url } })
                } else {
                    json!({ "media": { "url": url }, "description": description })
                })
            })
            .take(MAX_MEDIA)
            .collect();
        if !items.is_empty() {
            self.0.push(json!({ "type": 12, "items": items }));
        }
    }
    /// Texts with a small picture on the right (Section + Thumbnail).
    fn section(&mut self, texts: Vec<String>, thumbnail: &Value) {
        let texts: Vec<Value> = texts
            .into_iter()
            .map(|t| safe_text(&json!(t), MAX_TEXT))
            .filter(|t| !t.is_empty())
            .take(3)
            .map(|t| json!({ "type": 10, "content": t }))
            .collect();
        match http_url(thumbnail) {
            Some(url) if !texts.is_empty() => self.0.push(json!({
                "type": 9,
                "components": texts,
                "accessory": { "type": 11, "media": { "url": url } },
            })),
            _ => self.0.extend(texts),
        }
    }
    /// Link buttons side by side in one row.
    fn buttons(&mut self, buttons: &[(&str, &Value)]) {
        let row: Vec<Value> = buttons
            .iter()
            .filter_map(|(label, url)| {
                let url = http_url(url)?;
                let label = safe_text(&json!(label), MAX_BUTTON);
                (!label.is_empty())
                    .then(|| json!({ "type": 2, "style": 5, "label": label, "url": url }))
            })
            .collect();
        if !row.is_empty() {
            self.0.push(json!({ "type": 1, "components": row }));
        }
    }

    fn button(&mut self, label: &str, url: &Value) {
        let Some(url) = http_url(url) else { return };
        let label = safe_text(&json!(label), MAX_BUTTON);
        if !label.is_empty() {
            self.0.push(json!({ "type": 1, "components": [{ "type": 2, "style": 5, "label": label, "url": url }] }));
        }
    }
}

fn youtube_thumbnail(link: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?:v=|/)([A-Za-z0-9_-]{11})").ok()?;
    re.captures(link)
        .map(|c| format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", &c[1]))
}

fn attachments(entry: &Value, username: &Value) -> Vec<(Value, Value)> {
    get(entry, "attachments")
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_MEDIA)
        .map(|u| (u.clone(), username.clone()))
        .collect()
}

/// Markdown text of a Steam PICS entry, SteamDB-bot style: app name linking
/// the changelist, the change number, then what changed.
fn steam_pics_text(p: &Value) -> (String, String, Option<u32>) {
    let s = |k: &str| js::to_string_or_empty(get(p, k)).trim().to_string();
    // Markdown link text must not close the link early.
    let clean = |t: String| t.replace(['[', ']'], "").replace('\n', " ");
    let name = clean(s("name"));
    let branch = clean(s("branch"));
    let build = match (s("buildid"), s("buildLink")) {
        (id, link) if !id.is_empty() && http_url(&json!(link)).is_some() => {
            format!("[build {id}]({link})")
        }
        (id, _) if !id.is_empty() => format!("build {id}"),
        _ => String::new(),
    };
    let (what, accent) = match s("kind").as_str() {
        "Current" => (format!("Current public {build}"), Some(0x5865F2)),
        "Build" => (format!("Depots (public, {build})"), Some(0x66C0F4)),
        "Branch added" => (format!("Depots (Added {branch}, {build})"), Some(0x57F287)),
        "Branch build" => (format!("Depots ({branch}, {build})"), Some(0xE67E22)),
        "Branch removed" => (format!("Depots (Removed {branch})"), Some(0xED4245)),
        // No build or branch change: yellow, with the keys that changed, if any.
        "Changelist" => (clean(s("keys")), Some(0xFEE75C)),
        other => (clean(other.to_string()), None),
    };
    let mut lines = Vec::new();
    lines.push(format!("Changelist {}", s("change")));
    if !what.is_empty() {
        lines.push(format!("Changed: **{what}**"));
    }
    (name, lines.join("\n"), accent)
}

/// A Steam PICS entry as a classic embed, SteamDB-bot style. Not Components
/// V2: its thumbnail keeps the portrait capsule's shape (V2 crops it square).
/// Discord cannot turn such a message into a V2 one later, so SteamMerge
/// never edits these posts (`steam_merge::find`).
fn steam_pics_embed(entry: &Value, p: &Value) -> (Value, String) {
    let (name, text, accent) = steam_pics_text(p);
    // Author line with the game's own icon: as tall as SteamDB's site line,
    // so the text reaches the bottom of the capsule.
    let author = match js::to_string_or_empty(get(p, "kind")).as_str() {
        "Current" => "Current build",
        "Build" => "New build",
        "Branch added" => "Branch added",
        "Branch build" => "Branch build",
        "Branch removed" => "Branch removed",
        "Changelist" => "Changelist",
        _ => "Steam change",
    };
    let mut embed = json!({
        "author": { "name": author },
        "title": safe_text(&json!(name), 256),
        "description": safe_text(&json!(text), 4000),
    });
    if let Some(icon) = http_url(get(p, "icon")) {
        embed["author"]["icon_url"] = json!(icon);
    }
    if let Some(link) = http_url(get(p, "changeLink")) {
        embed["url"] = json!(link);
    }
    if let Some(color) = accent {
        embed["color"] = json!(color);
    }
    if let Some(thumb) = http_url(get(p, "thumbnail")) {
        embed["thumbnail"] = json!({ "url": thumb });
    }
    let label = js::to_string(js::or(&[
        get(entry, "title"),
        get(entry, "link"),
        &json!("(no title)"),
    ]));
    (json!({ "embeds": [embed] }), label)
}

/// The webhook payload an entry would be posted with (no mention), for
/// `xfeeder preview --payload`.
pub fn preview_payload(entry: &Value) -> Value {
    with_mention(webhook_payload(entry).0, None, true)
}

fn webhook_payload(entry: &Value) -> (Value, String) {
    if get(entry, "steamPics").is_object() && !truthy(get(entry, "merged")) {
        return steam_pics_embed(entry, get(entry, "steamPics"));
    }
    let mut c = Container(Vec::new());
    let link = get(entry, "link");
    let title = get(entry, "title");
    let link_text = link.as_str().unwrap_or("");
    #[allow(clippy::needless_late_init)]
    let label;
    if truthy(link) && (link_text.contains("youtube.com") || link_text.contains("youtu.be")) {
        c.text(format!(
            "📺 {}",
            js::to_string(js::or(&[title, &json!("New video")]))
        ));
        c.text(link.clone());
        let thumb = if truthy(get(entry, "enclosure")) {
            get(entry, "enclosure").clone()
        } else {
            youtube_thumbnail(link_text).map_or(Value::Null, Value::String)
        };
        c.media(vec![(thumb, js::or(&[title, &json!("Thumbnail")]).clone())]);
        c.button("Open on YouTube", link);
        label = format!("YouTube: {}", js::to_string(title));
    } else if get(entry, "categories")
        .as_array()
        .is_some_and(|c| c.contains(&json!("discord")))
    {
        let username = js::or(&[get(entry, "author"), &json!("User")]).clone();
        let timestamp = if truthy(get(entry, "isoDate")) {
            discord_time(&js::to_string(get(entry, "isoDate")))
        } else {
            String::new()
        };
        c.text(format!(
            "💬 New message from **{}**",
            js::to_string(&username)
        ));
        c.text(get(entry, "contentSnippet").clone());
        let mut media = Vec::new();
        if truthy(get(entry, "enclosure")) {
            media.push((get(entry, "enclosure").clone(), username.clone()));
        }
        if truthy(get(entry, "embedThumbnail")) {
            media.push((get(entry, "embedThumbnail").clone(), json!("Embed")));
        }
        media.extend(attachments(entry, &username));
        c.media(media);
        let referenced = get(entry, "referenced");
        if truthy(referenced) {
            c.text(format!(
                "↪️ *Reply to: {} — \"{}\"*",
                js::to_string(js::or(&[get(referenced, "author"), &json!("Anonymous")])),
                truncate(get(referenced, "content"), 100)
            ));
        }
        c.text(format!("👤 {} • 🕒 {timestamp}", js::to_string(&username)));
        c.button("Open", link);
        label = format!("Discord message from {}", js::to_string(&username));
    } else if truthy(get(entry, "attachments"))
        || truthy(get(entry, "content"))
        || truthy(get(entry, "referenced"))
    {
        let username = js::or(&[
            js::path(entry, &["author", "username"]),
            get(entry, "author"),
            &json!("User"),
        ])
        .clone();
        let timestamp = if truthy(get(entry, "timestamp")) {
            discord_time(&js::to_string(get(entry, "timestamp")))
        } else {
            String::new()
        };
        c.text(format!(
            "💬 New message from **{}**",
            js::to_string(&username)
        ));
        c.text(get(entry, "content").clone());
        c.media(attachments(entry, &username));
        let referenced = get(entry, "referenced");
        if truthy(referenced) {
            c.text(format!(
                "↪️ *Reply to: {} — \"{}\"*",
                js::to_string(js::or(&[get(referenced, "author"), &json!("Anonymous")])),
                truncate(get(referenced, "content"), 100)
            ));
        }
        c.text(format!("👤 {} • 🕒 {timestamp}", js::to_string(&username)));
        c.button("Open", link);
        label = format!("Discord message from {}", js::to_string(&username));
    } else {
        let heading = format!(
            "📰 **{}**",
            js::to_string(js::or(&[title, &json!("New entry")]))
        );
        let body = post_body(entry);
        let image = get(entry, "enclosure");
        if crate::text::is_avatar(image) {
            c.section(vec![heading, body], image);
        } else {
            c.text(heading);
            c.text(body);
            c.media(vec![(
                image.clone(),
                js::or(&[title, &json!("Media")]).clone(),
            )]);
        }
        // Who wrote it, or else which site it is from (feeds like Steam,
        // SteamDB and onet name no author), and when.
        let who = if truthy(get(entry, "author")) {
            Some(format!("👤 {}", js::to_string(get(entry, "author"))))
        } else {
            link.as_str()
                .and_then(|l| url::Url::parse(l).ok())
                .and_then(|u| {
                    u.host_str()
                        .map(|h| h.trim_start_matches("www.").to_string())
                })
                .map(|host| format!("🌐 {host}"))
        };
        let when = truthy(get(entry, "isoDate"))
            .then(|| discord_time(&js::to_string(get(entry, "isoDate"))))
            .filter(|t| !t.is_empty())
            .map(|t| format!("🕒 {t}"));
        let meta: Vec<String> = [who, when].into_iter().flatten().collect();
        if !meta.is_empty() {
            c.text(meta.join(" • "));
        }
        // Steam announcement merged with its SteamDB build (`SteamMerge`).
        let merged = get(entry, "merged");
        if truthy(get(merged, "link")) {
            c.text(format!(
                "🛠️ {}",
                js::to_string(js::or(&[get(merged, "title"), &json!("SteamDB build")]))
            ));
            c.buttons(&[("Open", link), ("SteamDB", get(merged, "link"))]);
        } else {
            c.button("Open", link);
        }
        label = js::to_string(js::or(&[title, link, &json!("(no title)")]));
    }
    (
        json!({ "flags": COMPONENTS_V2, "components": [{ "type": 17, "components": c.0 }] }),
        label,
    )
}

fn discord_retry_ms(response: &http::Response, attempt: u32) -> u64 {
    let clamp = |ms: f64| ms.ceil().clamp(500.0, 15_000.0) as u64;
    let body: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
    let from_body = js::to_number(get(&body, "retry_after"));
    if from_body.is_finite() && from_body > 0.0 {
        return clamp(from_body * 1000.0);
    }
    let header = |name: &str| {
        response
            .header(name)
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n > 0.0)
    };
    if let Some(reset) = header("x-ratelimit-reset-after") {
        return clamp(reset * 1000.0);
    }
    if let Some(retry) = header("retry-after") {
        return clamp(if retry < 100.0 { retry * 1000.0 } else { retry });
    }
    clamp(500.0 * 2f64.powi(attempt as i32))
}

/// A message posted through a webhook.
#[derive(Clone, Debug, PartialEq)]
pub struct SentMessage {
    pub id: String,
    /// Channel or thread the message is in.
    pub channel_id: String,
}

/// Webhook URL with `with_components`, `wait` and `thread_id`; with a
/// message id, the URL of that message (for editing).
fn webhook_url(
    webhook: &str,
    thread: Option<&str>,
    message: Option<&str>,
) -> Result<url::Url, SendError> {
    let mut url =
        url::Url::parse(webhook).map_err(|_| SendError::Failed("Invalid webhookUrl.".into()))?;
    if let Some(id) = message {
        if !id.chars().all(|c| c.is_ascii_digit()) || id.is_empty() {
            return Err(SendError::Failed("Invalid message id.".into()));
        }
        url.path_segments_mut()
            .map_err(|_| SendError::Failed("Invalid webhookUrl.".into()))?
            .pop_if_empty()
            .extend(["messages", id]);
    }
    let retained: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !matches!(k.as_ref(), "with_components" | "wait" | "thread_id"))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut query = url.query_pairs_mut();
        query
            .clear()
            .extend_pairs(retained)
            .append_pair("with_components", "true");
        if message.is_none() {
            query.append_pair("wait", "true");
        }
        if let Some(thread) = thread.filter(|t| !t.is_empty() && *t != "null") {
            query.append_pair("thread_id", thread);
        }
    }
    Ok(url)
}

/// POST (new message) or PATCH (edit) with Discord's 429 handling.
async fn webhook_call(
    url: &url::Url,
    payload: &Value,
    edit: bool,
    label: &str,
    cancel: &CancellationToken,
) -> Result<http::Response, SendError> {
    for attempt in 0..=MAX_429_RETRIES {
        let result = if edit {
            http::patch_json(url.as_str(), payload, None, cancel).await
        } else {
            http::post_json(url.as_str(), payload, None, cancel).await
        };
        match result {
            Ok(response) => return Ok(response),
            Err(HttpError::Status(response))
                if response.status == 429 && attempt < MAX_429_RETRIES =>
            {
                let wait = discord_retry_ms(&response, attempt);
                crate::diag::expert(
                    "discord.rate_limited",
                    json!({ "waitMs": wait, "attempt": attempt + 1,
                            "global": response.header("x-ratelimit-global").is_some(),
                            "scope": response.header("x-ratelimit-scope").unwrap_or("") }),
                );
                crate::warn!(
                    "Discord delivery",
                    "Rate limited (429), attempt {}/{MAX_429_RETRIES}, waiting {wait}ms",
                    attempt + 1
                );
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_millis(wait)) => {}
                    () = cancel.cancelled() => return Err(SendError::Cancelled),
                }
            }
            Err(HttpError::Cancelled) => return Err(SendError::Cancelled),
            Err(error) => {
                let detail = error
                    .response()
                    .map(|r| {
                        format!(
                            " status={} response={}",
                            r.status,
                            js::prefix16(&r.body, 300)
                        )
                    })
                    .unwrap_or_default();
                crate::error!(
                    "Discord delivery",
                    "Webhook {} failed for {}: {error}{}",
                    if edit { "edit" } else { "delivery" },
                    crate::diag::sanitize_text(label),
                    crate::diag::sanitize_text(&detail)
                );
                if let Some(r) = error.response() {
                    // Editing a message that was deleted: not a dead target.
                    if edit && r.status == 404 && r.body.contains("10008") {
                        return Err(SendError::Gone);
                    }
                    if discord_target_gone(r.status, &r.body) {
                        return Err(SendError::Unreachable(format!(
                            "{error}{}",
                            crate::diag::sanitize_text(&detail)
                        )));
                    }
                }
                return Err(error.into());
            }
        }
    }
    Err(SendError::Failed(
        "Discord rate limit retries exhausted.".into(),
    ))
}

/// Put the `Ping` line above the post and set `allowed_mentions`: only the
/// configured mentions may notify, and only when `notify` (new posts).
fn with_mention(mut payload: Value, mention: Option<&crate::ping::Mention>, notify: bool) -> Value {
    if let Some(mention) = mention {
        if let Some(components) = payload["components"].as_array_mut() {
            components.insert(0, json!({ "type": 10, "content": mention.line }));
        } else if payload["embeds"].is_array() {
            payload["content"] = json!(mention.line);
        }
    }
    payload["allowed_mentions"] = match mention {
        Some(mention) if notify => mention.allowed.clone(),
        _ => crate::ping::silent(),
    };
    payload
}

pub async fn send_webhook(
    webhook: &str,
    thread: Option<&str>,
    entry: &Value,
    mention: Option<&crate::ping::Mention>,
    cancel: &CancellationToken,
) -> Result<Option<SentMessage>, SendError> {
    let url = webhook_url(webhook, thread, None)?;
    let (payload, label) = webhook_payload(entry);
    let empty_embeds = payload["embeds"].as_array().is_none_or(Vec::is_empty);
    if empty_embeds
        && payload["components"][0]["components"]
            .as_array()
            .is_none_or(Vec::is_empty)
    {
        return Err(SendError::Failed(
            "Components payload is empty after sanitization.".into(),
        ));
    }
    let payload = with_mention(payload, mention, true);
    let started = std::time::Instant::now();
    let response = webhook_call(&url, &payload, false, &label, cancel).await?;
    let body = serde_json::from_str::<Value>(&response.body).unwrap_or(Value::Null);
    let id = js::to_string_or_empty(get(&body, "id"));
    let channel_id = js::to_string_or_empty(get(&body, "channel_id"));
    crate::info!(
        "ComponentsV2",
        "Sent: {} (HTTP {}, {}ms, confirmed={}, message={id} channel={channel_id})",
        crate::diag::sanitize_text(&label),
        response.status,
        started.elapsed().as_millis(),
        !id.is_empty(),
    );
    Ok((!id.is_empty()).then_some(SentMessage { id, channel_id }))
}

/// Replace a message this webhook sent earlier with the current layout of
/// `entry` (`xfeeder rerender`, Steam + SteamDB merging).
pub async fn edit_webhook(
    webhook: &str,
    thread: Option<&str>,
    message_id: &str,
    entry: &Value,
    mention: Option<&crate::ping::Mention>,
    cancel: &CancellationToken,
) -> Result<(), SendError> {
    let url = webhook_url(webhook, thread, Some(message_id))?;
    let (payload, label) = webhook_payload(entry);
    // The message already has the Components V2 flag; an edit sends only
    // the new components. Edits never ping.
    let body = if payload["embeds"].is_array() {
        json!({ "embeds": payload["embeds"] })
    } else {
        json!({ "components": payload["components"] })
    };
    let payload = with_mention(body, mention, false);
    let started = std::time::Instant::now();
    let response = webhook_call(&url, &payload, true, &label, cancel).await?;
    crate::info!(
        "ComponentsV2",
        "Edited: {} (HTTP {}, {}ms, message={message_id})",
        crate::diag::sanitize_text(&label),
        response.status,
        started.elapsed().as_millis(),
    );
    Ok(())
}

// ---------------------------------------------------------------- Telegram --

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_limited(value: &Value, max: usize) -> String {
    let input = js::trim(&js::collapse_ws(&js::to_string_or_empty(value))).to_string();
    let mut output = String::with_capacity(input.len());
    // UTF-16 length of `output`, kept as it grows (was recounted per char).
    let mut units = 0;
    let mut truncated = false;
    for ch in input.chars() {
        let escaped = match ch {
            '&' => "&amp;",
            '<' => "&lt;",
            '>' => "&gt;",
            '"' => "&quot;",
            _ => "",
        };
        let add = if escaped.is_empty() {
            ch.len_utf16()
        } else {
            escaped.len()
        };
        if units + add > max {
            truncated = true;
            break;
        }
        if escaped.is_empty() {
            output.push(ch);
        } else {
            output.push_str(escaped);
        }
        units += add;
    }
    if truncated && units < max {
        output.push('…');
    }
    output
}

const TELEGRAM_CAPTION_MAX: usize = 1024;

pub fn telegram_text(entry: &Value) -> Result<String, String> {
    const MAX: usize = 4096;
    let title = escape_limited(js::or(&[get(entry, "title"), &json!("New entry")]), 480);
    let snippet = escape_limited(
        js::or(&[
            get(entry, "contentSnippet"),
            get(entry, "content"),
            &json!(""),
        ]),
        2600,
    );
    let meta_parts: Vec<String> = [get(entry, "author"), get(entry, "isoDate")]
        .iter()
        .filter(|v| truthy(v))
        .map(|v| js::to_string(v))
        .collect();
    let meta = escape_limited(&json!(meta_parts.join(" · ")), 320);
    let link = http_url(get(entry, "link"));
    let mut attachments: Vec<String> = get(entry, "attachments")
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(http_url)
        .take(2)
        .collect();
    if let Some(enclosure) = http_url(get(entry, "enclosure"))
        && !crate::text::is_avatar(get(entry, "enclosure"))
        && !attachments.contains(&enclosure)
        && attachments.len() < 2
    {
        attachments.push(enclosure);
    }
    let mut parts: Vec<String> = [format!("<b>{title}</b>"), meta, snippet]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
    let append = |part: String, parts: &mut Vec<String>| {
        let mut next = parts.clone();
        next.push(part.clone());
        if len16(&next.join("\n\n")) <= MAX {
            parts.push(part);
        }
    };
    if let Some(link) = link {
        append(
            format!("<a href=\"{}\">Open article</a>", escape_html(&link)),
            &mut parts,
        );
    }
    for (index, url) in attachments.iter().enumerate() {
        append(
            format!(
                "<a href=\"{}\">Attachment {}</a>",
                escape_html(url),
                index + 1
            ),
            &mut parts,
        );
    }
    let text = parts.join("\n\n");
    if len16(&text) > MAX {
        Err("Telegram message exceeds the 4096-character limit.".into())
    } else {
        Ok(text)
    }
}

/// Telegram rejects these photo URLs with a 400 that a text message avoids.
fn telegram_photo_rejected(status: u16, description: &str) -> bool {
    status == 400
        && !telegram_target_gone(status, description)
        && !description
            .to_ascii_lowercase()
            .contains("can't parse entities")
}

async fn telegram_call(
    config: &Telegram,
    method: &str,
    payload: &Value,
    cancel: &CancellationToken,
) -> Result<(), (SendError, u16, String)> {
    let url = format!("https://api.telegram.org/bot{}/{method}", config.bot_token);
    match http::post_json(&url, payload, Some(config.timeout_ms), cancel).await {
        Ok(response) => {
            let body: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
            if get(&body, "ok") == &Value::Bool(false) {
                let description = js::to_string(js::or(&[
                    get(&body, "description"),
                    &json!("request was rejected"),
                ]));
                return Err((
                    SendError::Failed(format!("Telegram API error: {description}")),
                    response.status,
                    description,
                ));
            }
            Ok(())
        }
        Err(HttpError::Cancelled) => Err((SendError::Cancelled, 0, String::new())),
        Err(HttpError::Status(response)) => {
            let body: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
            let description = get(&body, "description").as_str().unwrap_or("").to_string();
            let message = if description.is_empty() {
                format!("Telegram API request failed with HTTP {}.", response.status)
            } else {
                format!("Telegram API error: {description}")
            };
            let error = if telegram_target_gone(response.status, &description) {
                SendError::Unreachable(message)
            } else {
                SendError::Failed(message)
            };
            Err((error, response.status, description))
        }
        Err(error) => Err((
            SendError::Failed(format!("Telegram API request failed ({}).", error.code())),
            0,
            String::new(),
        )),
    }
}

/// Use the larger image chosen by `parsers::finish` only if it exists
/// (YouTube has no `maxresdefault` for some videos); otherwise go back to the
/// image the feed gave. One small ranged request. Returns the entry to send
/// and the HTTP status of the check (`None` when nothing was checked).
pub async fn working_image(entry: &Value, cancel: &CancellationToken) -> (Value, Option<u16>) {
    let (Some(fallback), Some(image)) = (
        get(entry, "imageFallback").as_str(),
        get(entry, "enclosure").as_str(),
    ) else {
        return (entry.clone(), None);
    };
    // GitHub serves every avatar size: the larger one never needs a check
    // (over half of all checks were these).
    if image.starts_with("https://avatars.githubusercontent.com/") {
        return (entry.clone(), None);
    }
    let (ok, status) = image_exists(image, cancel).await;
    if ok {
        return (entry.clone(), status);
    }
    let mut entry = entry.clone();
    // A guessed fallback (Steam app art) is checked too; when it is missing
    // as well, the post goes out without an image instead of a broken one.
    if get(&entry, "imageFallbackCheck") == &json!(true) && !image_exists(fallback, cancel).await.0
    {
        entry["enclosure"] = Value::Null;
        return (entry, status);
    }
    entry["enclosure"] = json!(fallback);
    (entry, status)
}

/// Answers of recent image checks: the same image (a Steam game's header for
/// every post of that game, one image for several channels) is asked once.
type ImageCheck = (bool, Option<u16>, std::time::Instant);
static IMAGE_CHECKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, ImageCheck>>,
> = std::sync::LazyLock::new(Default::default);
const IMAGE_CHECK_TTL: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

async fn image_exists(image: &str, cancel: &CancellationToken) -> (bool, Option<u16>) {
    if let Some(&(ok, status, at)) = IMAGE_CHECKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(image)
        && at.elapsed() < IMAGE_CHECK_TTL
    {
        return (ok, status);
    }
    let (ok, status) = check_image(image, cancel).await;
    // A network failure (status 0) is not remembered: try again next time.
    if status.is_some_and(|s| s != 0) {
        let mut checks = IMAGE_CHECKS.lock().unwrap_or_else(|e| e.into_inner());
        if checks.len() > 5_000 {
            checks.retain(|_, (_, _, at)| at.elapsed() < IMAGE_CHECK_TTL);
        }
        checks.insert(image.to_string(), (ok, status, std::time::Instant::now()));
    }
    (ok, status)
}

async fn check_image(image: &str, cancel: &CancellationToken) -> (bool, Option<u16>) {
    let response = http::get(http::Get {
        url: image,
        headers: vec![("Range".into(), "bytes=0-1023".into())],
        cancel,
        timeout_ms: Some(8_000),
    })
    .await;
    let status = match &response {
        Ok(r) => Some(r.status),
        Err(e) => e.status().or(Some(0)),
    };
    // A 200 HTML page (a login wall, a soft 404) is not an image.
    let html = response.as_ref().is_ok_and(|r| {
        r.header("content-type")
            .is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("text/html"))
    });
    let ok = status.is_some_and(|s| (200..300).contains(&s)) && !html;
    crate::diag::expert(
        "delivery.image.check",
        json!({ "image": image, "ok": ok, "status": status }),
    );
    (ok, status)
}

/// Photo to attach: the entry image (`enclosure`), when it is an http(s) URL.
/// Profile pictures are not worth a photo message.
fn telegram_photo(entry: &Value) -> Option<String> {
    let image = get(entry, "enclosure");
    if crate::text::is_avatar(image) {
        return None;
    }
    http_url(image)
}

pub async fn send_telegram(
    config: &Telegram,
    entry: &Value,
    cancel: &CancellationToken,
) -> Result<(), SendError> {
    if !config.enabled {
        return Err(SendError::Failed("Telegram target is disabled.".into()));
    }
    let text = telegram_text(entry).map_err(SendError::Failed)?;
    let mut base = json!({ "chat_id": config.chat_id, "parse_mode": "HTML" });
    if let Some(thread) = config.message_thread_id {
        base["message_thread_id"] = json!(thread);
    }
    // A photo carries the text as its caption (max 1024 characters).
    if config.send_photo
        && len16(&text) <= TELEGRAM_CAPTION_MAX
        && let Some(photo) = telegram_photo(entry)
    {
        let mut payload = base.clone();
        payload["photo"] = json!(photo);
        payload["caption"] = json!(text);
        match telegram_call(config, "sendPhoto", &payload, cancel).await {
            Ok(()) => return Ok(()),
            Err((_, status, description)) if telegram_photo_rejected(status, &description) => {
                crate::warn!(
                    "Telegram",
                    "Photo rejected ({}); sending text only",
                    crate::diag::sanitize_text(&description)
                );
            }
            Err((error, _, _)) => return Err(error),
        }
    }
    let mut payload = base;
    payload["text"] = json!(text);
    if config.disable_preview {
        payload["link_preview_options"] = json!({ "is_disabled": true });
    }
    telegram_call(config, "sendMessage", &payload, cancel)
        .await
        .map_err(|(error, _, _)| error)
}

// ----------------------------------------------------------- Discord source --

fn channel_ids(config: &Value) -> Vec<String> {
    let mut ids: Vec<String> = match get(config, "ChannelIDs") {
        Value::Array(list) => list
            .iter()
            .filter_map(js::trimmed_str)
            .map(str::to_string)
            .collect(),
        Value::String(id) if !id.trim().is_empty() => vec![id.trim().to_string()],
        _ => Vec::new(),
    };
    if ids.is_empty()
        && let Some(id) = js::trimmed_str(get(config, "ChannelID"))
    {
        ids.push(id.to_string());
    }
    ids
}

/// Read recent messages; per-channel failures are reported, not fatal.
pub async fn read_discord(
    config: &Value,
    cancel: &CancellationToken,
) -> Result<(Vec<Value>, Option<String>), SendError> {
    if !truthy(get(config, "Token")) {
        crate::error!("Discord source", "Missing Discord configuration or token");
        return Ok((Vec::new(), None));
    }
    let ids = channel_ids(config);
    if ids.is_empty() {
        crate::error!(
            "Discord source",
            "Missing ChannelIDs; add \"ChannelIDs\" (GuildID is not channel ID)."
        );
        return Ok((Vec::new(), None));
    }
    let guild = js::to_string(js::or(&[get(config, "GuildID"), &json!("unknown")]));
    let limit = js::to_string(js::or(&[get(config, "Limit"), &json!(50)]));
    let timeout = js::to_number(js::or(&[get(config, "Timeout"), &json!(15000)])) as u64;
    let mut messages = Vec::new();
    let mut failure = None;
    for id in ids {
        let url = format!("https://discord.com/api/v9/channels/{id}/messages?limit={limit}");
        let mut headers = vec![
            (
                "authorization".to_string(),
                js::to_string(get(config, "Token")),
            ),
            ("accept".into(), "*/*".into()),
            ("accept-language".into(), "en".into()),
            (
                "referer".into(),
                format!("https://discord.com/channels/{guild}/{id}"),
            ),
            ("x-discord-locale".into(), "en-US".into()),
            ("x-discord-timezone".into(), "Europe/Warsaw".into()),
        ];
        for (key, header) in [
            ("cookie", "cookie"),
            ("x-super-properties", "x-super-properties"),
        ] {
            if truthy(get(config, key)) {
                headers.push((header.into(), js::to_string(get(config, key))));
            }
        }
        match http::get(http::Get {
            url: &url,
            headers,
            cancel,
            timeout_ms: Some(timeout),
        })
        .await
        {
            Ok(response) => {
                let data: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
                for msg in data.as_array().into_iter().flatten() {
                    messages.push(discord_entry(msg, config));
                }
            }
            Err(HttpError::Cancelled) => return Err(SendError::Cancelled),
            Err(error) => {
                crate::error!("Discord source", "Channel fetch failed for {id}: {error}");
                failure = Some(error.to_string());
            }
        }
    }
    crate::info!(
        "Discord source",
        "Source fetch complete ({} messages)",
        messages.len()
    );
    Ok((messages, failure))
}

fn discord_entry(msg: &Value, config: &Value) -> Value {
    let attachments: Vec<Value> = get(msg, "attachments")
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| get(a, "url").clone())
        .filter(truthy)
        .collect();
    let embed_thumb = get(msg, "embeds")
        .as_array()
        .and_then(|embeds| {
            embeds
                .iter()
                .find(|e| truthy(get(e, "thumbnail")) || truthy(get(e, "image")))
        })
        .map(|e| {
            js::or_else(
                &[
                    js::path(e, &["thumbnail", "url"]),
                    js::path(e, &["image", "url"]),
                ],
                Value::Null,
            )
        })
        .unwrap_or(Value::Null);
    let mut image = Value::Null;
    if !attachments.is_empty() {
        image = get(msg, "attachments")
            .as_array()
            .and_then(|list| {
                list.iter().find(|a| {
                    get(a, "content_type")
                        .as_str()
                        .is_some_and(|t| t.starts_with("image/"))
                })
            })
            .map_or(Value::Null, |a| get(a, "url").clone());
    }
    if !truthy(&image) && truthy(&embed_thumb) {
        image = embed_thumb.clone();
    }
    let author = js::path(msg, &["author"]);
    let name = js::or(&[get(author, "global_name"), get(author, "username")]).clone();
    let referenced = get(msg, "referenced_message");
    let content = get(msg, "content");
    let title = if truthy(content) {
        let text = js::to_string(content);
        if len16(&text) > 80 {
            format!("{}...", prefix16(&text, 80))
        } else {
            text
        }
    } else {
        format!("Message from {}", js::to_string(&name))
    };
    let id = get(msg, "id");
    let guild = js::or(&[get(msg, "guild_id"), get(config, "GuildID")]);
    let mut entry = json!({
        "guid": id,
        "title": title,
        "link": format!("https://discord.com/channels/{}/{}/{}", js::to_string(guild), js::to_string(get(msg, "channel_id")), js::to_string(id)),
        "contentSnippet": js::or(&[content, &json!("(no content)")]),
        "isoDate": js::or_else(&[get(msg, "timestamp")], json!(crate::text::now_iso())),
        "author": js::or(&[&name, &json!("Unknown")]),
        "enclosure": image,
        "embedThumbnail": embed_thumb,
        "attachments": attachments,
        "categories": ["discord"],
        "discordData": {
            "messageId": id, "channelId": get(msg, "channel_id"), "guildId": get(msg, "guild_id"), "authorId": get(author, "id"),
            "attachments": get(msg, "attachments").as_array().map_or(0, Vec::len),
            "embeds": get(msg, "embeds").as_array().map_or(0, Vec::len),
            "mentions": get(msg, "mentions").as_array().map_or(0, Vec::len),
            "reactions": get(msg, "reactions").as_array().map_or(0, Vec::len),
        },
    });
    if truthy(referenced) {
        entry["referenced"] = json!({
            "author": js::or(&[js::path(referenced, &["author", "global_name"]), js::path(referenced, &["author", "username"])]),
            "content": get(referenced, "content"),
        });
    }
    entry
}

#[cfg(test)]
mod tests {

    #[test]
    fn permanent_target_errors() {
        assert!(discord_target_gone(
            400,
            r#"{"message": "Unknown Channel", "code": 10003}"#
        ));
        assert!(discord_target_gone(
            404,
            r#"{"message": "Unknown Webhook", "code": 10015}"#
        ));
        assert!(!discord_target_gone(
            400,
            r#"{"message": "Invalid Form Body", "code": 50035}"#
        ));
        assert!(!discord_target_gone(500, ""));
        assert!(telegram_target_gone(400, "Bad Request: chat not found"));
        assert!(telegram_target_gone(
            403,
            "Forbidden: bot was blocked by the user"
        ));
        assert!(!telegram_target_gone(
            400,
            "Bad Request: can't parse entities"
        ));
    }

    #[test]
    fn telegram_photo_fallback_rules() {
        assert!(telegram_photo_rejected(
            400,
            "Bad Request: wrong file identifier/HTTP URL specified"
        ));
        assert!(telegram_photo_rejected(
            400,
            "Bad Request: failed to get HTTP URL content"
        ));
        assert!(!telegram_photo_rejected(400, "Bad Request: chat not found"));
        assert!(!telegram_photo_rejected(429, "Too Many Requests"));
        assert_eq!(
            telegram_photo(&json!({ "enclosure": "https://i/1.jpg" })).as_deref(),
            Some("https://i/1.jpg")
        );
        assert!(telegram_photo(&json!({ "enclosure": "javascript:x" })).is_none());
    }

    use super::*;

    #[test]
    fn mentions_only_from_ping_and_never_on_edits() {
        let entry =
            json!({ "title": "Ping <@&111111111111111111> @everyone", "link": "https://a/1" });
        let (payload, _) = webhook_payload(&entry);
        let plain = with_mention(payload.clone(), None, true);
        assert_eq!(plain["allowed_mentions"], json!({ "parse": [] }));
        assert_eq!(plain["components"].as_array().unwrap().len(), 1);
        let mention = crate::ping::Mention {
            line: "<@&222222222222222222>".into(),
            allowed: json!({ "roles": ["222222222222222222"] }),
        };
        let sent = with_mention(payload.clone(), Some(&mention), true);
        assert_eq!(
            sent["components"][0],
            json!({ "type": 10, "content": "<@&222222222222222222>" })
        );
        assert_eq!(sent["components"][1]["type"], json!(17));
        assert_eq!(sent["allowed_mentions"], mention.allowed);
        let edited = with_mention(payload, Some(&mention), false);
        assert_eq!(edited["components"][0]["type"], json!(10));
        assert_eq!(edited["allowed_mentions"], json!({ "parse": [] }));
    }

    #[test]
    fn feed_payload_shape() {
        let entry = json!({ "title": "Hello", "link": "https://a/1", "contentSnippet": "x".repeat(900), "enclosure": "javascript:x", "author": "me", "isoDate": "2024-01-02T03:04:05.000Z" });
        let (payload, _) = webhook_payload(&entry);
        let components = payload["components"][0]["components"].as_array().unwrap();
        assert_eq!(payload["flags"], json!(32768));
        assert_eq!(components[0]["content"], json!("📰 **Hello**"));
        assert!(components[1]["content"].as_str().unwrap().ends_with("..."));
        assert!(
            components.iter().all(|c| c["type"] != json!(12)),
            "non-http media is dropped"
        );
        assert_eq!(
            components.last().unwrap()["components"][0]["url"],
            json!("https://a/1")
        );
    }

    #[test]
    fn post_text_setting() {
        assert_eq!(post_text_length(&json!({})), 1500);
        assert_eq!(
            post_text_length(&json!({ "Settings": { "PostText": { "Length": 2000 } } })),
            2000
        );
        assert_eq!(
            post_text_length(&json!({ "Settings": { "PostText": { "Length": 50 } } })),
            300
        );
        assert_eq!(
            post_text_length(&json!({ "Settings": { "PostText": false } })),
            0
        );
        assert_eq!(
            post_text_length(&json!({ "Settings": { "PostText": { "Enabled": false } } })),
            0
        );
    }

    #[test]
    fn post_uses_the_longer_text() {
        let long = (1..=120)
            .map(|i| format!("· Fixed thing number {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let entry = json!({ "title": "Patch", "link": "https://a/1", "contentSnippet": "short", "contentText": long });
        let (payload, _) = webhook_payload(&entry);
        let body = payload["components"][0]["components"][1]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(body.starts_with("· Fixed thing number 1\n"), "{body}");
        assert!(body.ends_with("\n…"), "cut at a line end: {body}");
        assert!(body.chars().count() <= 1500);
        // Without contentText the previous text is used.
        let old = json!({ "title": "Patch", "link": "https://a/1", "contentSnippet": "short" });
        let (payload, _) = webhook_payload(&old);
        assert_eq!(
            payload["components"][0]["components"][1]["content"],
            "short"
        );
    }

    #[test]
    fn entry_without_link_has_no_button() {
        let entry = json!({ "title": "Minecraft 26.4 Pre-Release 1", "link": null, "contentSnippet": "text",
            "enclosure": "https://launchercontent.mojang.com/v2/images/a.jpg", "author": "Minecraft" });
        let (payload, label) = webhook_payload(&entry);
        let text = payload.to_string();
        assert_eq!(label, "Minecraft 26.4 Pre-Release 1");
        assert!(!text.contains("\"style\":5"), "no link button: {text}");
        assert!(text.contains("launchercontent.mojang.com/v2/images/a.jpg"));
    }

    #[test]
    fn youtube_payload() {
        let (payload, _) = webhook_payload(
            &json!({ "title": "Vid", "link": "https://www.youtube.com/watch?v=Z7BLIwA17jM" }),
        );
        let media = &payload["components"][0]["components"][2];
        assert_eq!(
            media["items"][0]["media"]["url"],
            json!("https://i.ytimg.com/vi/Z7BLIwA17jM/hqdefault.jpg")
        );
    }

    #[test]
    fn telegram_escaping() {
        let text = telegram_text(
            &json!({ "title": "<b>&", "link": "https://a/?x=1&y=2", "contentSnippet": "body" }),
        )
        .unwrap();
        assert!(text.starts_with("<b>&lt;b&gt;&amp;</b>"));
        assert!(text.contains("href=\"https://a/?x=1&amp;y=2\""));
    }

    #[test]
    fn avatar_is_a_thumbnail_next_to_the_text() {
        let entry = json!({ "title": "fix", "link": "https://g/c/1", "contentSnippet": "body",
                            "enclosure": "https://avatars.githubusercontent.com/u/1?s=460" });
        let (payload, _) = webhook_payload(&entry);
        let parts = payload["components"][0]["components"].as_array().unwrap();
        assert_eq!(parts[0]["type"], 9);
        assert_eq!(parts[0]["components"].as_array().unwrap().len(), 2);
        assert_eq!(parts[0]["accessory"]["type"], 11);
        assert!(
            parts.iter().all(|p| p["type"] != 12),
            "no big gallery image"
        );
        assert!(telegram_photo(&entry).is_none());
    }

    #[test]
    fn steam_pics_entries_are_compact_like_steamdb_posts() {
        let entry = json!({ "title": "Counter-Strike 2: new branch 1.42.0.0",
            "link": "https://steamdb.info/app/730/depots/?branch=1.42.0.0",
            "steamPics": { "name": "Counter-Strike 2", "appid": 730, "change": 41339549,
                "changeLink": "https://steamdb.info/app/730/history/?changeid=41339549",
                "kind": "Branch added", "branch": "1.42.0.0", "buildid": "26798866",
                "buildLink": "https://steamdb.info/patchnotes/26798866/",
                "description": "Game version 1.42.0.0 (20-Nov-2026)",
                "thumbnail": "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/730/library_600x900.jpg",
                "icon": "https://shared.fastly.steamstatic.com/community_assets/images/apps/730/i.jpg" } });
        let (payload, label) = webhook_payload(&entry);
        // A classic embed: its thumbnail keeps the portrait shape.
        assert!(payload.get("flags").is_none() && payload.get("components").is_none());
        let embed = &payload["embeds"][0];
        assert_eq!(embed["title"], "Counter-Strike 2");
        assert_eq!(embed["author"]["name"], "Branch added");
        assert_eq!(
            embed["author"]["icon_url"],
            "https://shared.fastly.steamstatic.com/community_assets/images/apps/730/i.jpg"
        );
        assert_eq!(
            embed["url"],
            "https://steamdb.info/app/730/history/?changeid=41339549"
        );
        assert_eq!(embed["color"], 0x57F287);
        assert!(
            embed["thumbnail"]["url"]
                .as_str()
                .unwrap()
                .ends_with("library_600x900.jpg")
        );
        assert_eq!(
            embed["description"],
            "Changelist 41339549\n\
             Changed: **Depots (Added 1.42.0.0, [build 26798866](https://steamdb.info/patchnotes/26798866/))**"
        );
        assert_eq!(label, "Counter-Strike 2: new branch 1.42.0.0");
        // Removed branch: red, no build link.
        let mut removed = entry.clone();
        removed["steamPics"]["kind"] = json!("Branch removed");
        let (payload, _) = webhook_payload(&removed);
        assert_eq!(payload["embeds"][0]["color"], 0xED4245);
        assert!(
            payload
                .to_string()
                .contains("Changed: **Depots (Removed 1.42.0.0)**")
        );
        // A bare changelist: yellow, no "Changed" line.
        let mut bare = entry.clone();
        bare["steamPics"]["kind"] = json!("Changelist");
        let (payload_bare, _) = webhook_payload(&bare);
        assert_eq!(payload_bare["embeds"][0]["color"], 0xFEE75C);
        assert_eq!(
            payload_bare["embeds"][0]["description"],
            "Changelist 41339549"
        );
        // A ping line goes into `content` above the embed.
        let mention = crate::ping::Mention {
            line: "<@&1>".into(),
            allowed: json!({ "roles": ["1"] }),
        };
        let pinged = with_mention(payload, Some(&mention), true);
        assert_eq!(pinged["content"], "<@&1>");
        // Merged with an announcement: the normal Components V2 layout.
        let mut merged = entry;
        merged["merged"] = json!({ "title": "x", "link": "https://steamdb.info/patchnotes/1/" });
        let (payload, _) = webhook_payload(&merged);
        assert_eq!(payload["flags"], COMPONENTS_V2);
    }

    #[test]
    fn meta_line_names_the_site_when_there_is_no_author() {
        let entry = json!({ "title": "CS2 update", "link": "https://steamdb.info/patchnotes/1/", "isoDate": "2026-11-19T12:58:18.000Z",
                            "enclosure": "https://steamdb.info/patchnotes/1.png" });
        let (payload, _) = webhook_payload(&entry);
        let text = payload.to_string();
        assert!(
            text.contains("🌐 steamdb.info • 🕒 <t:1795093098:f>"),
            "{text}"
        );
        assert!(!text.contains("Anonymous"));
    }
}

#[cfg(test)]
mod webhook_url_tests {
    use super::webhook_url;

    #[test]
    fn send_and_edit_urls() {
        let hook = "https://discord.com/api/webhooks/1/tok?wait=false&x=1";
        let send = webhook_url(hook, Some("55"), None).unwrap();
        assert_eq!(
            send.as_str(),
            "https://discord.com/api/webhooks/1/tok?x=1&with_components=true&wait=true&thread_id=55"
        );
        let edit = webhook_url(hook, None, Some("99")).unwrap();
        assert_eq!(
            edit.as_str(),
            "https://discord.com/api/webhooks/1/tok/messages/99?x=1&with_components=true"
        );
        assert!(webhook_url(hook, None, Some("../x")).is_err());
    }

    #[test]
    fn merged_steam_post_has_build_line_and_two_buttons() {
        let announcement = serde_json::json!({
            "title": "Counter-Strike 2 Update",
            "link": "https://store.steampowered.com/news/app/730/view/1",
            "contentSnippet": "[ MAPS ]",
            "enclosure": "https://steamdb.info/patchnotes/2.png",
        });
        let merged = crate::steam_merge::combine(
            &announcement,
            &serde_json::json!({
                "title": "Counter-Strike 2 update for 20 November 2026",
                "link": "https://steamdb.info/patchnotes/2/?utm_source=rss",
            }),
        );
        let (payload, _) = super::webhook_payload(&merged);
        let text = payload.to_string();
        assert!(text.contains("🛠️ Counter-Strike 2 update for 20 November 2026"));
        let rows: Vec<&serde_json::Value> = payload["components"][0]["components"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["type"] == 1)
            .collect();
        assert_eq!(rows.len(), 1);
        let buttons = rows[0]["components"].as_array().unwrap();
        assert_eq!(buttons.len(), 2);
        assert_eq!(buttons[1]["url"], "https://steamdb.info/patchnotes/2/");
    }
}
