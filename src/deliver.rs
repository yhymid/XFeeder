//! Destinations (Discord webhook in Components V2, Telegram Bot API) and the
//! Discord channel source. Payload formats match the Node.js senders.

use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::config::Telegram;
use crate::http::{self, HttpError};
use crate::js::{self, get, len16, prefix16, truthy};
use crate::text::locale_en_us;

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

fn webhook_payload(entry: &Value) -> (Value, String) {
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
            locale_en_us(&js::to_string(get(entry, "isoDate")))
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
            locale_en_us(&js::to_string(get(entry, "timestamp")))
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
        c.text(format!(
            "📰 **{}**",
            js::to_string(js::or(&[title, &json!("New entry")]))
        ));
        c.text(truncate(get(entry, "contentSnippet"), 800));
        c.media(vec![(
            get(entry, "enclosure").clone(),
            js::or(&[title, &json!("Media")]).clone(),
        )]);
        if truthy(get(entry, "author")) || truthy(get(entry, "isoDate")) {
            let ts = if truthy(get(entry, "isoDate")) {
                locale_en_us(&js::to_string(get(entry, "isoDate")))
            } else {
                String::new()
            };
            c.text(format!(
                "👤 {} • 🕒 {ts}",
                js::to_string(js::or(&[get(entry, "author"), &json!("Anonymous")]))
            ));
        }
        c.button("Open", link);
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

pub async fn send_webhook(
    webhook: &str,
    thread: Option<&str>,
    entry: &Value,
    cancel: &CancellationToken,
) -> Result<(), SendError> {
    let mut url =
        url::Url::parse(webhook).map_err(|_| SendError::Failed("Invalid webhookUrl.".into()))?;
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
            .append_pair("with_components", "true")
            .append_pair("wait", "true");
        if let Some(thread) = thread.filter(|t| !t.is_empty() && *t != "null") {
            query.append_pair("thread_id", thread);
        }
    }
    let (payload, label) = webhook_payload(entry);
    if payload["components"][0]["components"]
        .as_array()
        .is_none_or(Vec::is_empty)
    {
        return Err(SendError::Failed(
            "Components payload is empty after sanitization.".into(),
        ));
    }
    for attempt in 0..=MAX_429_RETRIES {
        let started = std::time::Instant::now();
        match http::post_json(url.as_str(), &payload, None, cancel).await {
            Ok(response) => {
                let confirmed = serde_json::from_str::<Value>(&response.body)
                    .ok()
                    .is_some_and(|b| truthy(get(&b, "id")));
                crate::info!(
                    "ComponentsV2",
                    "Sent: {} (HTTP {}, {}ms, confirmed={confirmed})",
                    crate::diag::sanitize_text(&label),
                    response.status,
                    started.elapsed().as_millis()
                );
                return Ok(());
            }
            Err(HttpError::Status(response))
                if response.status == 429 && attempt < MAX_429_RETRIES =>
            {
                let wait = discord_retry_ms(&response, attempt);
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
                    "Webhook delivery failed: {error}{}",
                    crate::diag::sanitize_text(&detail)
                );
                if let Some(r) = error.response()
                    && discord_target_gone(r.status, &r.body)
                {
                    return Err(SendError::Unreachable(format!(
                        "{error}{}",
                        crate::diag::sanitize_text(&detail)
                    )));
                }
                return Err(error.into());
            }
        }
    }
    Err(SendError::Failed(
        "Discord rate limit retries exhausted".into(),
    ))
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
    let mut output = String::new();
    let mut truncated = false;
    for ch in input.chars() {
        let escaped = escape_html(&ch.to_string());
        if len16(&output) + len16(&escaped) > max {
            truncated = true;
            break;
        }
        output.push_str(&escaped);
    }
    if truncated && len16(&output) < max {
        output.push('…');
    }
    output
}

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

pub async fn send_telegram(
    config: &Telegram,
    entry: &Value,
    cancel: &CancellationToken,
) -> Result<(), SendError> {
    if !config.enabled {
        return Err(SendError::Failed("Telegram target is disabled.".into()));
    }
    let mut payload = json!({ "chat_id": config.chat_id, "text": telegram_text(entry).map_err(SendError::Failed)?, "parse_mode": "HTML" });
    if let Some(thread) = config.message_thread_id {
        payload["message_thread_id"] = json!(thread);
    }
    if config.disable_preview {
        payload["link_preview_options"] = json!({ "is_disabled": true });
    }
    let url = format!(
        "https://api.telegram.org/bot{}/sendMessage",
        config.bot_token
    );
    match http::post_json(&url, &payload, Some(config.timeout_ms), cancel).await {
        Ok(response) => {
            let body: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
            if get(&body, "ok") == &Value::Bool(false) {
                return Err(SendError::Failed(format!(
                    "Telegram API error: {}",
                    js::to_string(js::or(&[
                        get(&body, "description"),
                        &json!("request was rejected")
                    ]))
                )));
            }
            Ok(())
        }
        Err(HttpError::Cancelled) => Err(SendError::Cancelled),
        Err(HttpError::Status(response)) => {
            let body: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
            let description = get(&body, "description").as_str().unwrap_or("");
            let message = if description.is_empty() {
                format!("Telegram API request failed with HTTP {}.", response.status)
            } else {
                format!("Telegram API error: {description}")
            };
            if telegram_target_gone(response.status, description) {
                Err(SendError::Unreachable(message))
            } else {
                Err(SendError::Failed(message))
            }
        }
        Err(error) => Err(SendError::Failed(format!(
            "Telegram API request failed ({}).",
            error.code()
        ))),
    }
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

    use super::*;

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
}
