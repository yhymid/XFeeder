//! Feed parsers, tried in the original priority order on one downloaded body.
//! Every parser returns standardized entries:
//! `{title, link, contentSnippet, isoDate, enclosure, author, guid, categories}`.

use std::sync::OnceLock;

use regex::Regex;
use scraper::{Html, Selector};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::js::{self, get, or, path, prefix16, truthy};
use crate::text::{
    first_image_in_html, html_to_text, node_text, now_iso, parse_date, resolve_url, strip_html,
    upgrade_image,
};
use crate::xmltree::{self, as_list};

pub struct Body {
    pub text: String,
    /// Axios parsed any JSON-looking body automatically; parsers rely on it.
    pub json: Option<Value>,
}

impl Body {
    pub fn new(text: String) -> Self {
        let trimmed = text.trim_start();
        let json = if trimmed.starts_with('{') || trimmed.starts_with('[') {
            serde_json::from_str(trimmed).ok()
        } else {
            None
        };
        Self { text, json }
    }
}

pub type Parser = fn(&str, &Body) -> Vec<Value>;

pub const PARSERS: [(&str, Parser); 10] = [
    ("parseYouTube", parse_youtube),
    ("parseGitHubAPI", crate::github_api::parse),
    ("parseSteamEvents", crate::steam_events::parse),
    ("parseMojang", crate::mojang::parse),
    ("parseAtom", parse_atom),
    ("parseXML", parse_xml),
    ("parseJSON", parse_json),
    ("parseApiX", parse_api_x),
    ("parseRSS", parse_rss),
    ("parseFallback", parse_fallback),
];

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

pub(crate) fn snippet(raw: &str, max: usize) -> String {
    let text = html_to_text(raw);
    let cut = prefix16(&text, max);
    if cut.len() == text.len() {
        return js::trim(cut).to_string();
    }
    // Cut at the last word boundary and show that the text goes on.
    let cut = cut
        .rfind(char::is_whitespace)
        .filter(|&i| i > cut.len() / 2)
        .map_or(cut, |i| &cut[..i]);
    format!("{}…", js::trim_end(cut))
}

/// The longer Discord text of an entry (`contentText`, see
/// [`crate::text::html_to_rich`]); `contentSnippet` stays as it was, because
/// entries without a link or guid are identified by it.
pub(crate) fn rich(raw: &str) -> String {
    crate::text::cut_text(&crate::text::html_to_rich(raw), 4000)
}

fn with_text(mut entry: Value, raw: &str) -> Value {
    let text = rich(raw);
    if !text.is_empty() {
        entry["contentText"] = json!(text);
    }
    entry
}

/// Commit trailers are noise in a message card (and `Claude-Session` links
/// should not be published).
fn without_trailers(text: &str) -> String {
    static TRAILER: OnceLock<Regex> = OnceLock::new();
    let trailer = re(
        &TRAILER,
        r"(?i)^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|helped-by|change-id|claude-session):\s",
    );
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !trailer.is_match(l.trim()))
        .collect();
    js::trim(&kept.join("\n")).to_string()
}

/// Links back to the article ("Czytaj więcej »", "Read more", "The post …
/// appeared first on …") are already the "Open" button.
fn without_read_more(text: &str) -> String {
    static TAIL: OnceLock<Regex> = OnceLock::new();
    static POST: OnceLock<Regex> = OnceLock::new();
    let text = re(
        &POST,
        r"(?im)^The post .{1,300} appeared first on .{1,120}\.?$",
    )
    .replace_all(text, "");
    let text = re(
        &TAIL,
        r"(?i)\s*(?:czytaj (?:więcej|dalej|całość)|read more|continue reading|read the full (?:article|story))\s*(?:[»›→…]|\.\.\.|&raquo;)?\s*$",
    )
    .replace(text.trim_end(), "");
    js::trim(&text).to_string()
}

/// Name for a commit whose e-mail is not linked to a GitHub account
/// (`86289848+login@users.noreply.github.com` → `login`, `me@x.pl` → `me`).
fn name_from_email(email: &str) -> Option<String> {
    let local = email.trim().split('@').next()?.trim();
    let local = local.split_once('+').map_or(local, |(_, login)| login);
    (!local.is_empty()).then(|| local.to_string())
}

fn xml_doc(body: &Body) -> Option<Value> {
    if body.json.is_some() {
        return None;
    }
    xmltree::parse(&body.text).ok()
}

fn text_or(value: &Value, fallback: &str) -> String {
    let text = node_text(value);
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

fn date_or_now(value: &Value) -> Value {
    let value = if truthy(value) {
        value.clone()
    } else {
        Value::String(now_iso())
    };
    parse_date(&value).map_or(Value::Null, Value::String)
}

fn opt_date(value: &Value) -> Value {
    parse_date(value).map_or(Value::Null, Value::String)
}

#[allow(clippy::too_many_arguments)]
fn entry(
    title: String,
    link: Value,
    content: String,
    iso: Value,
    enclosure: Value,
    author: Value,
    guid: Value,
    categories: Value,
) -> Value {
    json!({
        "title": title, "link": link, "contentSnippet": content, "isoDate": iso,
        "enclosure": enclosure, "author": author, "guid": guid, "categories": categories,
    })
}

fn string_value(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::String(_) => value.clone(),
        Value::Object(_) => match node_text(value) {
            text if text.is_empty() => value.clone(),
            text => Value::String(text),
        },
        other => Value::String(js::to_string(other)),
    }
}

/// Categories as plain strings. XML gives objects for categories with
/// attributes: Atom `<category term="AI" label="…"/>`, RSS
/// `<category domain="…">Improvement</category>`; filters need the text.
fn category_list(value: &Value) -> Value {
    let mut out: Vec<String> = Vec::new();
    for item in as_list(value) {
        let label = js::to_string_or_empty(or(&[
            path(item, &["ATTR", "label"]),
            path(item, &["ATTR", "term"]),
        ]));
        let text = if label.trim().is_empty() {
            node_text(item)
        } else {
            label
        };
        let text = text.trim();
        if !text.is_empty() && !out.iter().any(|t| t == text) {
            out.push(text.to_string());
        }
    }
    json!(out)
}

/// Whether a media element points at an image: by `type`/`medium`, or by
/// the file extension when neither is given. Podcast enclosures are audio.
fn is_image_media(node: &Value, url: &str) -> bool {
    let kind = js::to_string_or_empty(path(node, &["ATTR", "type"])).to_lowercase();
    let medium = js::to_string_or_empty(path(node, &["ATTR", "medium"])).to_lowercase();
    if !kind.is_empty() || !medium.is_empty() {
        return kind.starts_with("image/") || medium == "image";
    }
    let bare = url.split(['?', '#']).next().unwrap_or("").to_lowercase();
    ![
        ".mp3", ".m4a", ".aac", ".mp4", ".m4v", ".ogg", ".oga", ".opus", ".wav", ".webm", ".mov",
        ".pdf", ".zip",
    ]
    .iter()
    .any(|ext| bare.ends_with(ext))
}

/// The item's image: enclosure, `media:content`, `media:thumbnail` (also in
/// `media:group`), `itunes:image`, in that order. Only real images count.
fn item_image(e: &Value) -> Option<String> {
    let group = get(e, "media:group");
    let candidates = [
        (get(e, "enclosure"), "url"),
        (get(e, "media:content"), "url"),
        (get(e, "media:thumbnail"), "url"),
        (get(group, "media:content"), "url"),
        (get(group, "media:thumbnail"), "url"),
        (get(e, "itunes:image"), "href"),
    ];
    candidates.into_iter().find_map(|(value, attr)| {
        as_list(value).into_iter().find_map(|node| {
            let url = js::to_string_or_empty(path(node, &["ATTR", attr]));
            let url = url.trim();
            (!url.is_empty() && is_image_media(node, url)).then(|| url.to_string())
        })
    })
}

// ---------------------------------------------------------------- Finish --

/// Fixes applied to the entries of every feed after parsing (not to Discord
/// channel messages):
/// - relative links and images become absolute (Gitea writes `/owner/repo/…`);
///   the original link stays in `sourceLink`, the delivery identity;
/// - small images are swapped for larger versions (`imageFallback` keeps the
///   original in case the larger one does not exist);
/// - Steam store news without a picture get the game's header image;
/// - the text does not repeat the title (WordPress "Site\nTitle\nText…").
///
/// Running it twice gives the same result.
pub fn finish(url: &str, mut items: Vec<Value>) -> Vec<Value> {
    static STEAM_APP: OnceLock<Regex> = OnceLock::new();
    let steam_app = re(
        &STEAM_APP,
        r"^https?://store\.steampowered\.com/feeds/news/app/(\d+)",
    )
    .captures(url)
    .map(|c| c[1].to_string())
    .or_else(|| crate::steam_events::appid(url));
    for item in &mut items {
        let Some(map) = item.as_object_mut() else {
            continue;
        };
        if let Some(link) = map.get("link").and_then(Value::as_str)
            && let Some(absolute) = resolve_url(url, link)
        {
            map.insert("sourceLink".into(), json!(link));
            map.insert("link".into(), json!(absolute));
        }
        if let Some(image) = map
            .get("enclosure")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            let image = resolve_url(url, &image).unwrap_or(image);
            if let Some(better) = upgrade_image(&image) {
                map.insert("imageFallback".into(), json!(image));
                map.insert("enclosure".into(), json!(better));
            } else {
                map.insert("enclosure".into(), json!(image));
            }
        } else if let Some(app) = &steam_app
            && !map.get("enclosure").is_some_and(truthy)
        {
            // Both are guesses: newer apps keep their header under a hashed
            // path (header.jpg answers 404), some have no library hero
            // either. Delivery checks both and sends no image if neither
            // exists (`imageFallbackCheck`).
            let base =
                format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{app}");
            map.insert("enclosure".into(), json!(format!("{base}/header.jpg")));
            map.insert(
                "imageFallback".into(),
                json!(format!("{base}/library_hero.jpg")),
            );
            map.insert("imageFallbackCheck".into(), json!(true));
        }
        // YouTube Shorts are vertical: use the vertical thumbnail (checked
        // before sending like every upgrade; regular videos keep 16:9).
        if let (Some(link), Some(image)) = (
            map.get("link").and_then(Value::as_str),
            map.get("enclosure").and_then(Value::as_str),
        ) && let Some(id) = link
            .split_once("youtube.com/shorts/")
            .map(|(_, rest)| rest.split(['?', '/', '#']).next().unwrap_or(""))
            && id.len() == 11
            && image.contains("ytimg.com/vi/")
            && !image.ends_with("/oardefault.jpg")
        {
            let shorts = format!("https://i.ytimg.com/vi/{id}/oardefault.jpg");
            if !map.contains_key("imageFallback") {
                map.insert("imageFallback".into(), json!(image));
            }
            map.insert("enclosure".into(), json!(shorts));
        }
        let title = map.get("title").map(js::to_string).unwrap_or_default();
        if let Some(text) = map.get("contentSnippet").and_then(Value::as_str) {
            let trimmed = without_read_more(&without_title(&without_trailers(text), &title));
            if trimmed != text {
                map.insert("contentSnippet".into(), json!(trimmed));
            }
        }
    }
    mark_shared_links(&mut items);
    items
}

/// Entries that share one link but have different guids (kernel.org lists
/// every release with `https://www.kernel.org/`) would all get the same
/// identity, so only the first one would ever be sent. Give those entries
/// `identityKey` = `link#guid`. Entries with a unique link keep their
/// identity, so the history of every other feed stays valid.
fn mark_shared_links(items: &mut [Value]) {
    let link_of = |item: &Value| {
        crate::text::normalize_link(&js::to_string_or_empty(or(&[
            get(item, "sourceLink"),
            get(item, "link"),
        ])))
    };
    let mut counts: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for item in items.iter() {
        let link = link_of(item);
        if !link.is_empty() {
            counts
                .entry(link)
                .or_default()
                .push(js::to_string_or_empty(get(item, "guid")));
        }
    }
    for item in items.iter_mut() {
        let link = link_of(item);
        let guid = js::to_string_or_empty(get(item, "guid"));
        let Some(guids) = counts.get(&link) else {
            continue;
        };
        let distinct = guids.iter().filter(|g| **g == guid).count() == 1;
        if guids.len() > 1
            && distinct
            && !guid.trim().is_empty()
            && guid.trim() != link
            && let Some(map) = item.as_object_mut()
        {
            map.insert(
                "identityKey".into(),
                json!(format!("{link}#{}", guid.trim())),
            );
        }
    }
}

/// Drop the title (and a site-name line before it) from the start of the text.
fn without_title(text: &str, title: &str) -> String {
    let title = js::collapse_ws(title);
    let title = title.trim();
    if title.chars().count() < 8 {
        return text.to_string();
    }
    if text.trim().eq_ignore_ascii_case(title) {
        return String::new();
    }
    let lines: Vec<&str> = text.lines().collect();
    for (index, line) in lines.iter().take(3).enumerate() {
        if line.trim().eq_ignore_ascii_case(title) {
            let rest = lines[index + 1..].join("\n");
            return if rest.trim().is_empty() {
                text.to_string()
            } else {
                rest
            };
        }
    }
    text.to_string()
}

// --------------------------------------------------------------- YouTube --

pub fn parse_youtube(url: &str, body: &Body) -> Vec<Value> {
    if !url.contains("youtube.com/feeds/") && !url.contains("youtu") {
        return Vec::new();
    }
    let Some(doc) = xml_doc(body) else {
        crate::warn!(
            "YouTube Parser",
            "Error fetching {}: invalid XML",
            crate::diag::sanitize_url(url)
        );
        return Vec::new();
    };
    let entries = as_list(path(&doc, &["feed", "entry"]));
    let items: Vec<Value> = entries
        .into_iter()
        .map(|e| {
            let title = strip_html(&text_or(get(e, "title"), "No title"));
            let iso = date_or_now(or(&[get(e, "published"), get(e, "updated")]));
            let author = or(&[path(e, &["author", "name"]), path(e, &["author", "VALUE"])]);
            let author = if truthy(author) {
                string_value(author)
            } else {
                json!("Unknown author")
            };
            let video_id = get(e, "yt:videoId");
            let video = if truthy(video_id) {
                Some(js::to_string(video_id))
            } else {
                None
            };
            let link = match path(e, &["link", "ATTR", "href"]) {
                v if truthy(v) => v.clone(),
                _ => json!(video.as_ref().map_or_else(
                    || url.to_string(),
                    |id| format!("https://www.youtube.com/watch?v={id}")
                )),
            };
            let group = get(e, "media:group");
            let description = node_text(or(&[
                get(group, "media:description"),
                path(e, &["summary", "VALUE"]),
                get(e, "summary"),
            ]));
            let thumbs = as_list(get(group, "media:thumbnail"));
            let mut image = thumbs
                .last()
                .map(|t| path(t, &["ATTR", "url"]).clone())
                .filter(truthy);
            if image.is_none() && thumbs.len() > 1 {
                image = Some(path(thumbs[0], &["ATTR", "url"]).clone()).filter(truthy);
            }
            let image = image
                .or_else(|| {
                    video
                        .as_ref()
                        .map(|id| json!(format!("https://i.ytimg.com/vi/{id}/maxresdefault.jpg")))
                })
                .unwrap_or(Value::Null);
            let guid = or(&[get(e, "id"), video_id, &link]).clone();
            entry(
                title,
                link,
                snippet(&description, 500),
                iso,
                image,
                author,
                string_value(&guid),
                json!([]),
            )
        })
        .collect();
    if !items.is_empty() {
        crate::info!(
            "YouTube Parser",
            "Success ({}) → {}",
            items.len(),
            crate::diag::sanitize_url(url)
        );
    }
    items
}

// ------------------------------------------------------------------ Atom --

pub fn parse_atom(url: &str, body: &Body) -> Vec<Value> {
    if url.contains("youtube.com") || url.contains("yt:") {
        return Vec::new();
    }
    let Some(doc) = xml_doc(body) else {
        return Vec::new();
    };
    let feed = get(&doc, "feed");
    as_list(get(feed, "entry"))
        .into_iter()
        .map(|e| {
            let title = if truthy(get(e, "title")) {
                strip_html(&node_text(get(e, "title")))
            } else {
                "No title".to_string()
            };
            let iso = opt_date(or(&[get(e, "updated"), get(e, "published")]));
            let author = string_value(or(&[
                path(e, &["author", "name", "VALUE"]),
                path(e, &["author", "name"]),
                path(feed, &["author", "name"]),
            ]));
            let author = if truthy(&author) {
                author
            } else {
                name_from_email(&node_text(path(e, &["author", "email"])))
                    .map_or(Value::Null, Value::String)
            };
            let links = get(e, "link");
            let link = match links {
                Value::Array(list) => list
                    .iter()
                    .find(|l| path(l, &["ATTR", "rel"]) == "alternate")
                    .map_or(Value::Null, |l| path(l, &["ATTR", "href"]).clone()),
                other => match path(other, &["ATTR", "href"]) {
                    v if truthy(v) => v.clone(),
                    _ => Value::Null,
                },
            };
            let mut image = or(&[
                path(e, &["media:thumbnail", "ATTR", "url"]),
                path(e, &["media:content", "ATTR", "url"]),
            ])
            .clone();
            if !truthy(&image)
                && let Value::Array(list) = links
            {
                image = list
                    .iter()
                    .find(|l| {
                        path(l, &["ATTR", "rel"]) == "enclosure"
                            && path(l, &["ATTR", "type"])
                                .as_str()
                                .is_some_and(|t| t.starts_with("image/"))
                    })
                    .map_or(Value::Null, |l| path(l, &["ATTR", "href"]).clone());
            }
            let description = node_text(or(&[
                path(e, &["summary", "VALUE"]),
                get(e, "summary"),
                path(e, &["content", "VALUE"]),
                get(e, "content"),
            ]));
            let content = snippet(&description, 500);
            // The full content when there is one; summaries are often a teaser.
            let full = node_text(or(&[
                path(e, &["content", "VALUE"]),
                get(e, "content"),
                path(e, &["summary", "VALUE"]),
                get(e, "summary"),
            ]));
            let guid = or(&[get(e, "id"), &link, &json!(title.clone())]).clone();
            let categories = category_list(get(e, "category"));
            with_text(
                entry(
                    title,
                    link,
                    content,
                    iso,
                    if truthy(&image) { image } else { Value::Null },
                    author,
                    string_value(&guid),
                    categories,
                ),
                &full,
            )
        })
        .filter(|item| truthy(&item["link"]) || truthy(&item["title"]))
        .collect()
}

// ------------------------------------------------------------------- XML --

pub fn parse_xml(url: &str, body: &Body) -> Vec<Value> {
    let Some(doc) = xml_doc(body) else {
        crate::info!(
            "XML Parser",
            "{}: not an XML document, trying the next parser",
            crate::diag::sanitize_url(url)
        );
        return Vec::new();
    };
    let (kind, entries) = if truthy(path(&doc, &["rss", "channel", "item"])) {
        ("RSS", as_list(path(&doc, &["rss", "channel", "item"])))
    } else if truthy(path(&doc, &["feed", "entry"])) {
        ("Atom", as_list(path(&doc, &["feed", "entry"])))
    } else if truthy(path(&doc, &["channel", "item"])) {
        ("RSS (no-root)", as_list(path(&doc, &["channel", "item"])))
    } else if truthy(path(&doc, &["rdf:RDF", "item"])) {
        // RSS 1.0: items are siblings of <channel>, under <rdf:RDF>.
        ("RDF", as_list(path(&doc, &["rdf:RDF", "item"])))
    } else if truthy(path(&doc, &["RDF", "item"])) {
        ("RDF", as_list(path(&doc, &["RDF", "item"])))
    } else {
        crate::info!(
            "XML Parser",
            "No elements detected in {}",
            crate::diag::sanitize_url(url)
        );
        return Vec::new();
    };
    let items: Vec<Value> = entries
        .into_iter()
        .map(|e| {
            let title = strip_html(&text_or(
                or(&[path(e, &["title", "VALUE"]), get(e, "title")]),
                "No title",
            ));
            let link = or(&[
                path(e, &["link", "ATTR", "href"]),
                path(e, &["link", "VALUE"]),
                get(e, "link"),
                path(e, &["ATTR", "rdf:about"]),
            ]);
            let link = if truthy(link) {
                string_value(link)
            } else {
                json!(url)
            };
            let author = string_value(or(&[
                path(e, &["author", "name"]),
                path(e, &["author", "VALUE"]),
                get(e, "dc:creator"),
                get(e, "creator"),
                get(e, "author"),
            ]));
            let pub_date = or(&[
                get(e, "pubDate"),
                get(e, "published"),
                get(e, "updated"),
                get(e, "created"),
                get(e, "dc:date"),
            ]);
            let raw = node_text(or(&[
                path(e, &["content:encoded", "VALUE"]),
                get(e, "content:encoded"),
                path(e, &["content", "VALUE"]),
                get(e, "content"),
                path(e, &["summary", "VALUE"]),
                get(e, "summary"),
                path(e, &["description", "VALUE"]),
                get(e, "description"),
            ]));
            let image = item_image(e)
                .or_else(|| first_image_in_html(&raw))
                .map_or(Value::Null, Value::String);
            let categories = category_list(get(e, "category"));
            let guid = or(&[path(e, &["guid", "VALUE"]), get(e, "guid"), &link]).clone();
            with_text(
                entry(
                    title,
                    link,
                    snippet(&raw, 500),
                    date_or_now(pub_date),
                    image,
                    author,
                    string_value(&guid),
                    categories,
                ),
                &raw,
            )
        })
        .collect();
    crate::info!(
        "XML Parser",
        "Success ({}) [{kind}] → {}",
        items.len(),
        crate::diag::sanitize_url(url)
    );
    items
}

// ------------------------------------------------------------------ JSON --

fn fallback_guid(url: &str, parts: &[&Value]) -> String {
    let joined: Vec<String> = parts
        .iter()
        .filter(|v| truthy(v))
        .map(|v| js::to_string(v))
        .collect();
    let fingerprint = js::trim(&joined.join("\n")).to_string();
    if fingerprint.is_empty() {
        return format!("{url}#unknown");
    }
    format!(
        "{url}#{}",
        &hex::encode(Sha1::digest(fingerprint.as_bytes()))[..16]
    )
}

fn plain(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other if !truthy(other) => String::new(),
        other => js::to_string(other),
    }
}

pub fn parse_json(url: &str, body: &Body) -> Vec<Value> {
    let Some(data) = &body.json else {
        return Vec::new();
    };
    if truthy(get(data, "version")) && get(data, "items").is_array() {
        let items: Vec<Value> = get(data, "items")
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| {
                let title = js::or_else(&[get(item, "title")], json!("No title"));
                let link = js::or_else(&[get(item, "url"), get(item, "external_url")], Value::Null);
                let iso = opt_date(or(&[
                    get(item, "date_published"),
                    get(item, "date_modified"),
                ]));
                let image = js::or_else(
                    &[get(item, "image"), get(item, "banner_image")],
                    Value::Null,
                );
                let author = js::or_else(
                    &[
                        path(item, &["author", "name"]),
                        path(data, &["author", "name"]),
                    ],
                    Value::Null,
                );
                let raw = if truthy(get(item, "content_text")) || truthy(get(item, "summary")) {
                    plain(or(&[get(item, "content_text"), get(item, "summary")]))
                } else if truthy(get(item, "content_html")) {
                    strip_html(&plain(get(item, "content_html")))
                } else {
                    String::new()
                };
                let description = js::trim(&js::collapse_ws(&raw)).to_string();
                let guid = js::or_else(&[get(item, "id"), &link], Value::Null);
                let guid = if truthy(&guid) {
                    guid
                } else {
                    json!(fallback_guid(
                        url,
                        &[&title, &iso, &author, &json!(description)]
                    ))
                };
                entry(
                    js::to_string(&title),
                    link,
                    prefix16(&description, 500).to_string(),
                    iso,
                    image,
                    author,
                    guid,
                    js::or_else(&[get(item, "tags")], json!([])),
                )
            })
            .collect();
        crate::info!(
            "JSONFeed",
            "Success ({}) → {}",
            items.len(),
            crate::diag::sanitize_url(url)
        );
        return items;
    }
    let list = js::or_else(
        &[
            get(data, "items"),
            get(data, "entries"),
            get(data, "posts"),
            get(data, "articles"),
            get(data, "data"),
        ],
        json!([]),
    );
    let Some(list) = list.as_array().filter(|l| !l.is_empty()) else {
        crate::info!(
            "JSON Parser",
            "Unrecognized JSON structure for {}",
            crate::diag::sanitize_url(url)
        );
        return Vec::new();
    };
    let items: Vec<Value> = list
        .iter()
        .map(|e| {
            let title = js::or_else(&[get(e, "title"), get(e, "name")], json!("No title"));
            let link = js::or_else(&[get(e, "link"), get(e, "url")], Value::Null);
            let iso = opt_date(or(&[
                get(e, "pubDate"),
                get(e, "published"),
                get(e, "updated"),
            ]));
            let image = js::or_else(
                &[
                    path(e, &["enclosure", "link"]),
                    get(e, "thumbnail"),
                    get(e, "image_url"),
                    get(e, "image"),
                ],
                Value::Null,
            );
            let author = js::or_else(
                &[get(e, "author"), get(e, "creator"), get(e, "user")],
                Value::Null,
            );
            let raw = strip_html(&plain(or(&[
                get(e, "description"),
                get(e, "summary"),
                get(e, "content"),
                get(e, "snippet"),
            ])));
            let description = js::trim(&js::collapse_ws(&raw)).to_string();
            let guid = js::or_else(&[get(e, "guid"), &link], Value::Null);
            let guid = if truthy(&guid) {
                guid
            } else {
                json!(fallback_guid(
                    url,
                    &[&title, &iso, &author, &json!(description)]
                ))
            };
            entry(
                js::to_string(&title),
                link,
                prefix16(&description, 500).to_string(),
                iso,
                image,
                author,
                guid,
                js::or_else(&[get(e, "categories"), get(e, "tags")], json!([])),
            )
        })
        .collect();
    crate::info!(
        "JSON API",
        "Success ({}) → {}",
        items.len(),
        crate::diag::sanitize_url(url)
    );
    items
}

// ------------------------------------------------------------------ ApiX --

fn standardize(raw: &Value) -> Option<Value> {
    if !raw.is_object() {
        return None;
    }
    let title = js::or_else(
        &[
            get(raw, "title"),
            get(raw, "name"),
            get(raw, "headline"),
            get(raw, "caption"),
        ],
        json!("No title"),
    );
    let id_link = if truthy(get(raw, "id")) {
        json!(format!("#{}", js::to_string(get(raw, "id"))))
    } else {
        Value::Null
    };
    let link = js::or_else(
        &[
            get(raw, "url"),
            get(raw, "link"),
            get(raw, "permalink"),
            &id_link,
        ],
        Value::Null,
    );
    let description = or(&[
        get(raw, "summary"),
        get(raw, "description"),
        get(raw, "body"),
        get(raw, "text"),
        get(raw, "content"),
    ]);
    let date = js::or_else(
        &[
            get(raw, "date"),
            get(raw, "created_at"),
            get(raw, "updated_at"),
            get(raw, "published_at"),
            get(raw, "timestamp"),
        ],
        Value::Null,
    );
    let image = js::or_else(
        &[
            get(raw, "image"),
            get(raw, "thumbnail"),
            get(raw, "banner"),
            get(raw, "media_url"),
            get(raw, "preview_image"),
        ],
        Value::Null,
    );
    let author = js::or_else(
        &[
            path(raw, &["author", "name"]),
            get(raw, "author"),
            path(raw, &["user", "name"]),
            get(raw, "user"),
            get(raw, "by"),
        ],
        Value::Null,
    );
    let content = match description {
        Value::String(text) => js::trim(prefix16(&strip_html(text), 500)).to_string(),
        v if !truthy(v) => String::new(),
        _ => "No description.".to_string(),
    };
    let guid = js::or_else(&[get(raw, "id"), &link, &title], Value::Null);
    let item = entry(
        js::to_string(&title),
        link,
        content,
        date_or_now(&date),
        image,
        author,
        guid,
        js::or_else(&[get(raw, "tags"), get(raw, "categories")], json!([])),
    );
    (truthy(&item["link"]) && truthy(&item["title"])).then_some(item)
}

pub fn parse_api_x(url: &str, body: &Body) -> Vec<Value> {
    let Some(data) = &body.json else {
        return Vec::new();
    };
    let mut items: Vec<Value> = match data {
        Value::Array(list) => list.clone(),
        Value::Object(map) => {
            let direct = js::or_else(
                &[
                    "items", "posts", "entries", "articles", "results", "children", "data",
                    "response",
                ]
                .map(|k| get(data, k)),
                json!([]),
            );
            match direct {
                Value::Array(list) if !list.is_empty() => list,
                _ => map
                    .values()
                    .find_map(|v| match v {
                        Value::Array(list) if !list.is_empty() => Some(list.clone()),
                        Value::Object(inner) => inner
                            .values()
                            .find_map(|x| x.as_array().filter(|l| !l.is_empty()).cloned()),
                        _ => None,
                    })
                    .unwrap_or_default(),
            }
        }
        _ => Vec::new(),
    };
    items = items.iter().filter_map(standardize).collect();
    if items.is_empty() {
        crate::info!("ApiX", "No entries in {}", crate::diag::sanitize_url(url));
    }
    items
}

// ----------------------------------------------------------- regex RSS --

fn tag_content(block: &str, tag: &str) -> String {
    let pattern = format!(
        r"(?is)<{}[^>]*>(.*?)</{}>",
        regex::escape(tag),
        regex::escape(tag)
    );
    let found = Regex::new(&pattern)
        .ok()
        .and_then(|r| r.captures(block))
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    static CDATA: OnceLock<Regex> = OnceLock::new();
    re(&CDATA, r"(?s)<!\[CDATA\[(.*?)\]\]>")
        .replace_all(&found, "$1")
        .trim()
        .to_string()
}

fn tag_attr(block: &str, tag: &str, attr: &str) -> Option<String> {
    let pattern = format!(
        r#"(?i)<{}[^>]*{}="([^"]+)"[^>]*>"#,
        regex::escape(tag),
        regex::escape(attr)
    );
    Regex::new(&pattern)
        .ok()?
        .captures(block)
        .map(|c| c[1].to_string())
}

pub fn parse_rss(url: &str, body: &Body) -> Vec<Value> {
    if body.json.is_some() || body.text.is_empty() {
        return Vec::new();
    }
    static ITEM: OnceLock<Regex> = OnceLock::new();
    static ENTRY: OnceLock<Regex> = OnceLock::new();
    let mut kind = "RSS";
    let mut blocks: Vec<String> = re(&ITEM, r"(?is)<item\b[^>]*>(.*?)</item>")
        .captures_iter(&body.text)
        .map(|c| c[1].to_string())
        .collect();
    if blocks.is_empty() {
        kind = "Atom";
        blocks = re(&ENTRY, r"(?is)<entry\b[^>]*>(.*?)</entry>")
            .captures_iter(&body.text)
            .map(|c| c[1].to_string())
            .collect();
    }
    if blocks.is_empty() {
        return Vec::new();
    }
    let items: Vec<Value> = blocks
        .iter()
        .map(|block| {
            let title = tag_content(block, "title");
            let link = Some(tag_content(block, "link"))
                .filter(|l| !l.is_empty())
                .or_else(|| tag_attr(block, "link", "href"))
                .unwrap_or_else(|| url.to_string());
            let description = [
                tag_content(block, "content:encoded"),
                tag_content(block, "description"),
                tag_content(block, "summary"),
            ]
            .into_iter()
            .find(|d| !d.is_empty())
            .unwrap_or_default();
            static IMG: OnceLock<Regex> = OnceLock::new();
            let image = tag_attr(block, "enclosure", "url")
                .filter(|u| {
                    // Podcast enclosures are audio: use an enclosure only when
                    // it is (or looks like) an image.
                    let node = json!({ "ATTR": { "type": tag_attr(block, "enclosure", "type") } });
                    is_image_media(&node, u)
                })
                .or_else(|| tag_attr(block, "media:content", "url"))
                .or_else(|| tag_attr(block, "media:thumbnail", "url"))
                .or_else(|| {
                    re(&IMG, r#"(?i)<img[^>]+src="([^">]+)""#)
                        .captures(&description)
                        .map(|c| c[1].to_string())
                });
            let author = [
                tag_content(block, "author"),
                tag_content(block, "dc:creator"),
                tag_content(block, "creator"),
            ]
            .into_iter()
            .find(|a| !a.is_empty())
            .unwrap_or_default();
            let pub_date = [
                tag_content(block, "pubDate"),
                tag_content(block, "published"),
                tag_content(block, "updated"),
            ]
            .into_iter()
            .find(|d| !d.is_empty());
            let guid = Some(tag_content(block, "guid"))
                .filter(|g| !g.is_empty())
                .unwrap_or_else(|| link.clone());
            entry(
                strip_html(if title.is_empty() { "No title" } else { &title }),
                json!(link),
                snippet(&description, 500),
                date_or_now(&pub_date.map_or(Value::Null, Value::String)),
                image.map_or(Value::Null, Value::String),
                json!(author),
                json!(guid),
                json!([]),
            )
        })
        .collect();
    crate::info!(
        "RSS Parser",
        "Success ({}) [{kind}] → {}",
        items.len(),
        crate::diag::sanitize_url(url)
    );
    items
}

/// Last-resort `<item>` extraction used by the pipeline after all parsers.
pub fn regex_items(body: &str) -> Vec<Value> {
    if !body.contains("<item") {
        return Vec::new();
    }
    static ITEM: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();
    re(&ITEM, r"<item\b[^>]*>([\s\S]*?)</item>")
        .captures_iter(body)
        .map(|c| {
            let block = &c[1];
            let tag = |name: &str| {
                let pattern = format!(r"(?i)<{name}[^>]*>([\s\S]*?)</{name}>");
                Regex::new(&pattern).ok().and_then(|r| r.captures(block)).map(|m| js::trim(&m[1]).to_string()).unwrap_or_default()
            };
            let description = re(&TAGS, r"<[^>]+>").replace_all(&tag("description"), "").into_owned();
            let link = tag("link");
            let guid = Some(tag("guid")).filter(|g| !g.is_empty()).unwrap_or_else(|| link.clone());
            let pub_date = tag("pubDate");
            json!({
                "title": Some(tag("title")).filter(|t| !t.is_empty()).unwrap_or_else(|| "No title".into()),
                "link": link,
                "contentSnippet": prefix16(&description, 400),
                "isoDate": if pub_date.is_empty() { Value::Null } else { json!(pub_date) },
                "enclosure": Value::Null,
                "author": tag("author"),
                "guid": guid,
                "categories": [],
            })
        })
        .collect()
}

// -------------------------------------------------------------- fallback --

fn select_attr(doc: &Html, selector: &str, attr: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    doc.select(&selector)
        .next()
        .and_then(|el| el.value().attr(attr))
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn select_text(doc: &Html, selector: &str, first: bool) -> String {
    let Ok(selector) = Selector::parse(selector) else {
        return String::new();
    };
    let mut matches = doc.select(&selector);
    if first {
        matches
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default()
    } else {
        matches.map(|el| el.text().collect::<String>()).collect()
    }
}

/// Feed advertised by an HTML page (`<link rel="alternate"
/// type="application/rss+xml" href="…">`, also Atom and JSON Feed), resolved
/// against the page URL. RSS is preferred over Atom over JSON Feed.
pub fn discover_feed(page_url: &str, html: &str) -> Option<String> {
    let base = url::Url::parse(page_url).ok()?;
    let doc = Html::parse_document(html);
    let selector = scraper::Selector::parse("link[href][type]").ok()?;
    let mut best: Option<(usize, String)> = None;
    for link in doc.select(&selector) {
        let rel = link.value().attr("rel").unwrap_or("").to_ascii_lowercase();
        if !rel.split_whitespace().any(|r| r == "alternate") {
            continue;
        }
        let kind = link
            .value()
            .attr("type")
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let Some(rank) = [
            "application/rss+xml",
            "application/atom+xml",
            "application/feed+json",
        ]
        .iter()
        .position(|t| *t == kind) else {
            continue;
        };
        let href = link.value().attr("href").unwrap_or("").trim();
        let Ok(found) = base.join(href) else { continue };
        if !matches!(found.scheme(), "http" | "https") || found.as_str() == page_url {
            continue;
        }
        if best.as_ref().is_none_or(|(r, _)| rank < *r) {
            best = Some((rank, found.to_string()));
        }
    }
    best.map(|(_, url)| url)
}

/// A well-formed RSS/Atom/RDF document. When it has no entries it is an
/// empty feed (e.g. a YouTube channel without videos), not a web page.
pub fn is_feed_document(body: &Body) -> bool {
    xml_doc(body)
        .and_then(|doc| {
            doc.as_object().map(|root| {
                root.keys()
                    .any(|k| matches!(k.as_str(), "rss" | "feed" | "rdf:RDF" | "RDF"))
            })
        })
        .unwrap_or(false)
}

pub fn parse_fallback(url: &str, body: &Body) -> Vec<Value> {
    if body.json.is_some()
        || is_feed_document(body)
        || is_blocked_page(&body.text, 200, &serde_json::Map::new())
    {
        return Vec::new();
    }
    let Ok(base) = url::Url::parse(url) else {
        return Vec::new();
    };
    let doc = Html::parse_document(&body.text);
    let title = select_attr(&doc, r#"meta[property="og:title"]"#, "content")
        .or_else(|| select_attr(&doc, r#"meta[name="twitter:title"]"#, "content"))
        .or_else(|| {
            Some(js::trim(&select_text(&doc, "title", true)).to_string()).filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "No title".into());
    let link = select_attr(&doc, r#"meta[property="og:url"]"#, "content")
        .or_else(|| select_attr(&doc, r#"meta[name="twitter:url"]"#, "content"))
        .unwrap_or_else(|| base.to_string());
    let description = select_attr(&doc, r#"meta[property="og:description"]"#, "content")
        .or_else(|| select_attr(&doc, r#"meta[name="description"]"#, "content"))
        .or_else(|| select_attr(&doc, r#"meta[name="twitter:description"]"#, "content"))
        .or_else(|| {
            Some(js::trim(&select_text(&doc, "article p", true)).to_string())
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "No description.".into());
    let mut image = select_attr(&doc, r#"meta[property="og:image"]"#, "content")
        .or_else(|| select_attr(&doc, r#"meta[name="twitter:image"]"#, "content"))
        .or_else(|| select_attr(&doc, r#"link[rel*="icon"]"#, "href"));
    if let Some(src) = image.as_ref().filter(|s| s.starts_with('/')) {
        image = Some(format!("{}{src}", base.origin().ascii_serialization()));
    }
    let author = select_attr(&doc, r#"meta[name="author"]"#, "content")
        .or_else(|| select_attr(&doc, r#"meta[property="article:author"]"#, "content"))
        .or_else(|| Some(select_text(&doc, "a[rel=author]", false)).filter(|t| !t.is_empty()));
    let date = select_attr(
        &doc,
        r#"meta[property="article:published_time"]"#,
        "content",
    )
    .or_else(|| select_attr(&doc, "time[datetime]", "datetime"));
    let description = js::trim(prefix16(&js::collapse_ws(&description), 500)).to_string();
    crate::info!(
        "Fallback Parser",
        "HTML fallback OK → {}",
        crate::diag::sanitize_url(url)
    );
    vec![entry(
        title,
        json!(link),
        description,
        date_or_now(&date.map_or(Value::Null, Value::String)),
        image.map_or(Value::Null, Value::String),
        author.map_or(Value::Null, Value::String),
        json!(link),
        json!([]),
    )]
}

// ---------------------------------------------------------- blocked page --

fn interstitial() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    re(
        &RE,
        r"(?i)^(?:(?:one|just) a?\s*moment(?:,? please)?|checking (?:your browser|if (?:the )?site connection is secure)|(?:please )?verify (?:that )?you are (?:a )?human|are you human|attention required|access denied|request blocked|(?:403\s*[-:|]?\s*)?forbidden|(?:404\s*[-:|]?\s*)?(?:page )?not found|(?:503\s*[-:|]?\s*)?service unavailable|(?:500\s*[-:|]?\s*)?internal server error|(?:502\s*[-:|]?\s*)?bad gateway|security (?:check|verification)|error 1020)(?:[.!…\s]*)(?:[|—-]\s*(?:cloudflare|security check))?$",
    )
}

/// Challenge/error document detection (never scans entry prose).
pub fn is_blocked_page(body: &str, status: u16, headers: &serde_json::Map<String, Value>) -> bool {
    if status >= 400 {
        return true;
    }
    let source = js::trim(body.trim_start_matches('\u{feff}'));
    static FEED: OnceLock<Regex> = OnceLock::new();
    static HTML: OnceLock<Regex> = OnceLock::new();
    // A feed document is never a challenge page, even when the headers of a
    // solved request still carry `cf-mitigated: challenge`.
    if source.starts_with('{')
        || source.starts_with('[')
        || re(&FEED, r"(?i)^(?:<\?xml[^>]*>\s*)?<(?:rss|feed|rdf:RDF)\b").is_match(source)
    {
        return false;
    }
    if headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("cf-mitigated") && js::to_string(v).eq_ignore_ascii_case("challenge")
    }) {
        return true;
    }
    if !re(
        &HTML,
        r"(?i)<(?:!doctype\s+html|html|head|title|body|h1|form)\b",
    )
    .is_match(source)
    {
        return interstitial().is_match(source);
    }
    let doc = Html::parse_document(source);
    let mut labels = vec![
        select_text(&doc, "head title", true),
        select_text(&doc, "body h1", true),
    ];
    let body_text = js::trim(&js::collapse_ws(&select_text(&doc, "body", false))).to_string();
    if js::len16(&body_text) <= 240 {
        labels.push(body_text);
    }
    if labels
        .iter()
        .any(|label| interstitial().is_match(js::trim(&js::collapse_ws(label))))
    {
        return true;
    }
    Selector::parse("script[src*='/cdn-cgi/challenge-platform/'], form#challenge-form, form[action*='/cdn-cgi/'], #cf-challenge-running, #challenge-running")
        .map(|s| doc.select(&s).next().is_some())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!(
            "{}/tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn rss_fixture() {
        let body = Body::new(fixture("feed-pipeline/rss.xml"));
        let items = parse_xml("https://example.com/rss", &body);
        assert!(!items.is_empty());
        assert!(
            items
                .iter()
                .all(|i| i["title"].is_string() && i["isoDate"].is_string())
        );
    }

    #[test]
    fn atom_and_youtube_fixtures() {
        let atom = parse_atom(
            "https://example.com/atom",
            &Body::new(fixture("feed-pipeline/atom.xml")),
        );
        assert!(!atom.is_empty());
        let yt = parse_youtube(
            "https://www.youtube.com/feeds/videos.xml?channel_id=X",
            &Body::new(fixture("feed-pipeline/youtube.xml")),
        );
        assert!(!yt.is_empty());
        assert!(
            yt[0]["link"]
                .as_str()
                .unwrap()
                .contains("youtube.com/watch")
        );
    }

    #[test]
    fn json_feed_fixture() {
        let items = parse_json(
            "https://example.com/feed.json",
            &Body::new(fixture("feed-pipeline/json-feed.json")),
        );
        assert!(!items.is_empty());
    }

    #[test]
    fn feed_discovery() {
        let page = r#"<html><head>
            <link rel="alternate" type="application/feed+json" href="/feed.json">
            <link rel="alternate" type="application/atom+xml" href="atom.xml">
            <link rel="Alternate Home" type="application/rss+xml" href="https://cdn.example.com/rss">
            <link rel="stylesheet" type="text/css" href="/s.css">
        </head><body></body></html>"#;
        assert_eq!(
            discover_feed("https://example.com/blog/", page).as_deref(),
            Some("https://cdn.example.com/rss")
        );
        let atom = r#"<link rel="alternate" type="application/atom+xml" href="atom.xml">"#;
        assert_eq!(
            discover_feed("https://example.com/blog/", atom).as_deref(),
            Some("https://example.com/blog/atom.xml")
        );
        assert!(
            discover_feed("https://e/", "<link rel=alternate type=text/html href=/x>").is_none()
        );
        assert!(
            discover_feed(
                "https://e/f",
                r#"<link rel="alternate" type="application/rss+xml" href="/f">"#
            )
            .is_none()
        );
    }

    #[test]
    fn empty_feed_is_not_a_web_page() {
        let empty = Body::new(r#"<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom"><title>Olek47</title><link rel="alternate" href="https://www.youtube.com/channel/UC1"/></feed>"#.into());
        assert!(
            parse_fallback(
                "https://www.youtube.com/feeds/videos.xml?channel_id=UC1",
                &empty
            )
            .is_empty()
        );
        let rss =
            Body::new("<rss version=\"2.0\"><channel><title>x</title></channel></rss>".into());
        assert!(parse_fallback("https://a/feed", &rss).is_empty());
        let page = Body::new("<html><head><title>Page</title></head><body></body></html>".into());
        assert_eq!(parse_fallback("https://a/", &page).len(), 1);
    }

    #[test]
    fn invalid_xml_falls_through() {
        let body = Body::new(fixture("feed-pipeline/invalid.xml"));
        assert!(parse_xml("https://e/x", &body).is_empty());
    }

    #[test]
    fn solved_feed_with_challenge_headers_is_not_blocked() {
        let mut headers = serde_json::Map::new();
        headers.insert("cf-mitigated".into(), json!("challenge"));
        headers.insert("server".into(), json!("cloudflare"));
        let rss = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<rss version=\"2.0\"><channel></channel></rss>";
        assert!(!is_blocked_page(rss, 200, &headers));
        assert!(is_blocked_page(
            "<html><title>Weryfikacja</title></html>",
            200,
            &headers
        ));
        assert!(is_blocked_page(rss, 403, &headers));
    }

    #[test]
    fn challenge_pages() {
        let empty = serde_json::Map::new();
        for name in [
            "checking.html",
            "just-moment.html",
            "one-moment.html",
            "error.html",
        ] {
            assert!(
                is_blocked_page(&fixture(&format!("challenge-pages/{name}")), 200, &empty),
                "{name}"
            );
        }
        assert!(!is_blocked_page(
            &fixture("challenge-pages/article.html"),
            200,
            &empty
        ));
        assert!(!is_blocked_page(
            "<rss><channel></channel></rss>",
            200,
            &empty
        ));
        assert!(is_blocked_page("ok", 403, &empty));
    }

    #[test]
    fn finish_fixes_links_images_and_repeated_titles() {
        let items = vec![
            json!({ "title": "Recenzenci GTA 6 muszą uważać", "link": "/news/1", "enclosure": "https://a.pl/wp-content/uploads/x-150x150.png",
                    "contentSnippet": "Gry-Wideo.pl\nRecenzenci GTA 6 muszą uważać\nPatrick O’Rourke twierdzi" }),
            json!({ "title": "removed site", "link": "https://g/c/1", "enclosure": "https://avatars.githubusercontent.com/u/1?s=30", "contentSnippet": "removed site" }),
        ];
        let once = finish("https://a.pl/rss", items);
        assert_eq!(once[0]["link"], "https://a.pl/news/1");
        assert_eq!(once[0]["sourceLink"], "/news/1");
        assert_eq!(
            once[0]["enclosure"],
            "https://a.pl/wp-content/uploads/x.png"
        );
        assert_eq!(
            once[0]["imageFallback"],
            "https://a.pl/wp-content/uploads/x-150x150.png"
        );
        assert_eq!(once[0]["contentSnippet"], "Patrick O’Rourke twierdzi");
        assert_eq!(once[1]["contentSnippet"], "");
        assert_eq!(
            finish("https://a.pl/rss", once.clone()),
            once,
            "finish is idempotent"
        );

        let steam = finish(
            "https://store.steampowered.com/feeds/news/app/730",
            vec![
                json!({ "title": "Counter-Strike 2 Update", "link": "https://s/1", "enclosure": null }),
            ],
        );
        assert_eq!(
            steam[0]["enclosure"],
            "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/730/header.jpg"
        );
        assert_eq!(
            steam[0]["imageFallback"],
            "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/730/library_hero.jpg"
        );
        assert_eq!(steam[0]["imageFallbackCheck"], true);
    }

    #[test]
    fn commit_cards_drop_trailers_and_name_unlinked_authors() {
        let text = "Fix it\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_x";
        assert_eq!(without_trailers(text), "Fix it");
        assert_eq!(
            name_from_email("86289848+yhymid@users.noreply.github.com").as_deref(),
            Some("yhymid")
        );
        assert_eq!(
            name_from_email("codex@openai.local").as_deref(),
            Some("codex")
        );
        let long = format!("<p>{}</p>", "word ".repeat(200));
        let cut = snippet(&long, 500);
        assert!(
            cut.ends_with("word…") && cut.chars().count() <= 501,
            "{cut}"
        );
    }

    #[test]
    fn read_more_links_and_shorts_thumbnails() {
        assert_eq!(
            without_read_more("Oferta w Empiku. Czytaj więcej »"),
            "Oferta w Empiku."
        );
        assert_eq!(
            without_read_more("Text\nThe post X appeared first on Site."),
            "Text"
        );
        assert_eq!(
            without_read_more("To kosztuje więcej"),
            "To kosztuje więcej"
        );
        let items = finish(
            "https://www.youtube.com/feeds/videos.xml?channel_id=x",
            vec![
                json!({ "title": "s", "link": "https://www.youtube.com/shorts/txyNotYMZ_A", "enclosure": "https://i1.ytimg.com/vi/txyNotYMZ_A/hqdefault.jpg" }),
                json!({ "title": "v", "link": "https://www.youtube.com/watch?v=GOUuN2Zivys", "enclosure": "https://i1.ytimg.com/vi/GOUuN2Zivys/hqdefault.jpg" }),
            ],
        );
        assert_eq!(
            items[0]["enclosure"],
            "https://i.ytimg.com/vi/txyNotYMZ_A/oardefault.jpg"
        );
        assert_eq!(
            items[0]["imageFallback"],
            "https://i1.ytimg.com/vi/txyNotYMZ_A/hqdefault.jpg"
        );
        assert_eq!(
            items[1]["enclosure"],
            "https://i.ytimg.com/vi/GOUuN2Zivys/maxresdefault.jpg"
        );
    }

    #[test]
    fn rdf_feed_items_are_read() {
        let xml = r#"<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.org/"><title>Ex</title></channel>
  <item rdf:about="https://example.org/a"><title>First</title><link>https://example.org/a</link><dc:date>2026-11-20T10:00:00Z</dc:date></item>
  <item rdf:about="https://example.org/b"><title>Second</title><dc:date>2026-11-21T10:00:00Z</dc:date></item>
</rdf:RDF>"#;
        let items = parse_xml("https://example.org/rdf", &Body::new(xml.into()));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["title"], "First");
        assert_eq!(items[0]["isoDate"], "2026-11-20T10:00:00.000Z");
        assert_eq!(items[1]["link"], "https://example.org/b");
        let regex = parse_rss("https://example.org/rdf", &Body::new(xml.into()));
        assert_eq!(regex.len(), 2);
    }

    #[test]
    fn podcast_audio_is_not_an_image() {
        let xml = r#"<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>P</title>
  <item><title>Ep 1</title><link>https://p.example/1</link>
    <enclosure url="https://p.example/1.mp3" type="audio/mpeg" length="1"/>
    <itunes:image href="https://p.example/1.jpg"/></item>
  <item><title>Ep 2</title><link>https://p.example/2</link>
    <enclosure url="https://p.example/2.mp3?x=1" length="1"/></item>
  <item><title>Ep 3</title><link>https://p.example/3</link>
    <enclosure url="https://p.example/3.mp3" type="audio/mpeg"/>
    <enclosure url="https://p.example/3.png" type="image/png"/></item>
</channel></rss>"#;
        let items = parse_xml("https://p.example/feed", &Body::new(xml.into()));
        assert_eq!(items[0]["enclosure"], "https://p.example/1.jpg");
        assert_eq!(items[1]["enclosure"], Value::Null);
        assert_eq!(items[2]["enclosure"], "https://p.example/3.png");
        let regex = parse_rss("https://p.example/feed", &Body::new(xml.into()));
        assert_ne!(regex[0]["enclosure"], "https://p.example/1.mp3");
    }

    #[test]
    fn categories_are_plain_text() {
        let atom = r#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>T</title><id>x</id><link rel="alternate" href="https://a/1"/>
<category term="AI"/><category term="ai-x" label="Policy"/><category term="AI"/></entry></feed>"#;
        let items = parse_atom("https://a/feed", &Body::new(atom.into()));
        assert_eq!(items[0]["categories"], json!(["AI", "Policy"]));
        let rss = r#"<?xml version="1.0"?><rss version="2.0"><channel><item><title>T</title>
<link>https://a/1</link><category domain="changelog-type">Improvement</category>
<category domain="changelog-label">copilot</category></item></channel></rss>"#;
        let items = parse_xml("https://a/rss", &Body::new(rss.into()));
        assert_eq!(items[0]["categories"], json!(["Improvement", "copilot"]));
        let (filter, _) = crate::filter::Filter::parse(
            &json!({ "Include": ["copilot"], "Fields": ["categories"] }),
        );
        assert!(filter.unwrap().accepts(&items[0], 0));
    }

    #[test]
    fn entries_sharing_a_link_get_their_own_identity() {
        let xml = r#"<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>7.4-rc4</title><link>https://www.kernel.org/</link><guid isPermaLink="false">kernel.org,mainline,7.4-rc4</guid></item>
<item><title>7.3.2</title><link>https://www.kernel.org/</link><guid isPermaLink="false">kernel.org,stable,7.3.2</guid></item>
<item><title>Other</title><link>https://www.kernel.org/other</link><guid>g3</guid></item>
</channel></rss>"#;
        let url = "https://www.kernel.org/feeds/kdist.xml";
        let items = finish(url, parse_xml(url, &Body::new(xml.into())));
        let ids: Vec<String> = items
            .iter()
            .map(|e| crate::text::entry_identity(e, false))
            .collect();
        assert_ne!(ids[0], ids[1]);
        assert!(ids[0].ends_with("#kernel.org,mainline,7.4-rc4"), "{ids:?}");
        // A unique link keeps the identity it always had.
        assert_eq!(
            ids[2],
            crate::text::normalize_link("https://www.kernel.org/other")
        );
        assert_eq!(finish(url, items.clone()), items);
    }
}
