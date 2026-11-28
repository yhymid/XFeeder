//! Steam store events as a feed source.
//!
//! The store RSS (`store.steampowered.com/feeds/news/app/APPID`) cannot tell
//! patch notes from news, broadcasts or crossposts. The store's own events
//! JSON can (`event_type`), with the same post ids, so switching a game from
//! the RSS to this URL keeps the same post ids (history is kept per source URL,
//! so the first check of the new URL relies on `FirstRunSend`):
//!
//! ```text
//! https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=APPID&count_before=0&count_after=5&lang_list=0
//! ```
//!
//! Every entry gets a category: `Patch`, `Major update`, `Beta`, `Release` or
//! `News`, plus `event_type:N`. Keep only patches with
//! `"Filters": { "Include": ["Patch", "Major update"], "Fields": ["categories"] }`.
//! Broadcasts and streams (event types 11, 17–19, 36) are left out.
//!
//! The endpoint is Valve's store backend, not a documented API: the old RSS
//! URL keeps working as before and is the way back.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::{Value, json};

use crate::js::{self, get};
use crate::parsers::Body;

const HOST: &str = "store.steampowered.com";
const IMAGES: &str = "https://clan.fastly.steamstatic.com/images";

pub fn is_api(url: &str) -> bool {
    url::Url::parse(url).ok().is_some_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some(HOST)
            && (u.path().starts_with("/events/ajaxgetadjacentpartnerevents")
                || u.path().starts_with("/events/ajaxgetpartnereventspageable"))
    })
}

/// The `appid` of an events URL.
pub fn appid(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    if !is_api(url) {
        return None;
    }
    parsed
        .query_pairs()
        .find(|(k, _)| k == "appid")
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
}

/// A valid answer from the events endpoint (it may hold no posts to send).
pub fn answered(url: &str, body: &Body) -> bool {
    is_api(url)
        && body
            .json
            .as_ref()
            .is_some_and(|j| get(j, "success") == &json!(1) && get(j, "events").is_array())
}

static PATCH_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(patch(\s*notes)?|hotfix|update\s*v?\d+(\.\d+)*|release notes|changelog)\b|\bv?\d+\.\d+(\.\d+)?\b.*\b(released|stable|unstable)\b",
    )
    .unwrap()
});

/// Category of an event, or `None` for posts that are left out.
fn class(event_type: i64, tags: &[String], title: &str) -> Option<&'static str> {
    match event_type {
        11 | 17 | 18 | 19 | 36 => None,
        14 => Some("Major update"),
        29 => Some("Beta"),
        10 => Some("Release"),
        12 | 13 | 30 | 32 | 33 => Some("Patch"),
        _ if tags.iter().any(|t| t == "patchnotes") => Some("Patch"),
        28 | 34 | 35 if PATCH_TITLE.is_match(title) => Some("Patch"),
        _ => Some("News"),
    }
}

fn iso(seconds: i64) -> Value {
    chrono::DateTime::from_timestamp(seconds, 0).map_or(Value::Null, |d| {
        json!(d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    })
}

fn first_file(json_data: &Value, key: &str) -> Option<String> {
    js::trimmed_str(&get(json_data, key)[0]).map(str::to_string)
}

static IMG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\[img(?:\s+src=["']?([^"'\]\s]+)["']?)?[^\]]*\]([^\[]*)\[/img\]"#).unwrap()
});

fn clan_url(text: &str) -> String {
    text.replace("{STEAM_CLAN_IMAGE}", IMAGES)
        .replace("{STEAM_CLAN_LOC_IMAGE}", IMAGES)
}

/// Steam's BBCode as simple HTML for the shared HTML→text path. Returns the
/// HTML and the first image of the body.
pub fn bbcode_to_html(body: &str) -> (String, Option<String>) {
    static URL_OPEN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)\[url=\s*["']*([^"'\]\s]+)["']*[^\]]*\]"#).unwrap());
    // `[url]EA.com[/url]`: the text is the address.
    static URL_BARE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\[url\]\s*((?:https?://)?[a-z0-9.-]+\.[a-z]{2,}(?:/[^\[\s]*)?)\s*\[/url\]")
            .unwrap()
    });
    // A link card: `[dynamiclink href="…"][/dynamiclink]`, sometimes with the
    // URL repeated inside (like `[previewyoutube=ID]URL[/previewyoutube]`).
    static DYNAMIC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?is)\[dynamiclink\s+href=["']?([^"'\]\s]+)["']?[^\]]*\].*?\[/dynamiclink\]"#)
            .unwrap()
    });
    static YOUTUBE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?is)\[previewyoutube=["']?([A-Za-z0-9_-]{6,})[^\]]*\].*?\[/previewyoutube\]"#,
        )
        .unwrap()
    });
    static DROP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?is)\[video[^\]]*\].*?\[/video\]|\[/?(carousel|noparse|expand|color|size|align|center|left|right)(?:[= ][^\]]*)?\]|\[/?previewyoutube[^\]]*\]|\[img[^\]]*\]\s*$",
        )
        .unwrap()
    });
    static TAG: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\[(/?)(p|b|i|u|strike|spoiler|h1|h2|h3|h4|h5|list|olist|\*|quote|code|c|hr|table|tr|th|td)(?:[= ][^\]]*)?\]")
            .unwrap()
    });
    // `\[` and `\]` are literal brackets; keep them out of the tag pass.
    let text = body.replace("\\[", "\u{E000}").replace("\\]", "\u{E001}");
    let text = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    // Steam shows a line break in a post body as a line break. In HTML it
    // would be a space, which glued "· fix one\n· fix two" lists into one line.
    let text = text.replace("\r\n", "\n").replace('\n', "<br>");
    let mut first_image = None;
    let text = IMG.replace_all(&text, |c: &Captures| {
        if first_image.is_none() {
            let src = c.get(1).map_or_else(|| c[2].trim(), |m| m.as_str().trim());
            let src = clan_url(&src.replace("&amp;", "&"));
            if src.starts_with("http") {
                first_image = Some(src);
            }
        }
        ""
    });
    let text = YOUTUBE.replace_all(&text, "<p>https://youtu.be/$1</p>");
    let text = DYNAMIC.replace_all(&text, "<p>$1</p>");
    let text = DROP.replace_all(&text, "");
    let text = URL_BARE.replace_all(&text, |c: &Captures| {
        let href = if c[1].contains("://") {
            c[1].to_string()
        } else {
            format!("https://{}", &c[1])
        };
        format!(r#"<a href="{href}">{}</a>"#, &c[1])
    });
    let text = URL_OPEN.replace_all(&text, r#"<a href="$1">"#);
    let text = text.replace("[/url]", "</a>").replace("[/URL]", "</a>");
    let text = TAG.replace_all(&text, |c: &Captures| {
        let close = &c[1] == "/";
        let tag = c[2].to_lowercase();
        let html = match tag.as_str() {
            "*" => return if close { String::new() } else { "<li>".into() },
            "hr" => return if close { String::new() } else { "<hr>".into() },
            "list" => "ul",
            "olist" => "ol",
            "strike" => "s",
            "spoiler" if close => return "</span>".into(),
            "spoiler" => return r#"<span class="bb_spoiler">"#.into(),
            "quote" => "blockquote",
            "code" => "pre",
            "c" => "code",
            other => return format!("<{}{other}>", if close { "/" } else { "" }),
        };
        format!("<{}{html}>", if close { "/" } else { "" })
    });
    let html = text.replace('\u{E000}', "[").replace('\u{E001}', "]");
    (clan_url(&html), first_image)
}

pub fn parse(url: &str, body: &Body) -> Vec<Value> {
    if !is_api(url) {
        return Vec::new();
    }
    let Some(Value::Array(events)) = body.json.as_ref().map(|j| get(j, "events")) else {
        return Vec::new();
    };
    events
        .iter()
        .filter_map(|event| {
            let announcement = get(event, "announcement_body");
            let flag = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
            if flag(event, "published") != 1
                || flag(event, "hidden") != 0
                || flag(event, "unlisted") != 0
                || flag(announcement, "hidden") != 0
            {
                return None;
            }
            let gid = js::to_string_or_empty(get(event, "gid"));
            let app = js::to_string_or_empty(get(event, "appid"));
            if gid.is_empty() || app.is_empty() {
                return None;
            }
            let title = js::collapse_ws(&js::to_string_or_empty(js::or(&[
                get(event, "event_name"),
                get(announcement, "headline"),
            ])))
            .trim()
            .to_string();
            let tags: Vec<String> = get(announcement, "tags")
                .as_array()
                .map(|t| {
                    t.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let event_type = get(event, "event_type").as_i64().unwrap_or(0);
            let label = class(event_type, &tags, &title)?;
            // Patch notes for a build on a beta/test branch (public-beta,
            // latest_experimental, pre_release, …) are a Beta post, so a
            // channel that includes only "Patch" gets public builds only.
            let branch = js::to_string_or_empty(get(event, "build_branch"));
            let branch = branch.trim();
            let label = if label == "Patch" && !branch.is_empty() && branch != "public" {
                "Beta"
            } else {
                label
            };
            // Same link (and identity) as the store RSS item.
            let link = format!("https://store.steampowered.com/news/app/{app}/view/{gid}");
            let (html, body_image) =
                bbcode_to_html(&js::to_string_or_empty(get(announcement, "body")));
            let json_data: Value = get(event, "jsondata")
                .as_str()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);
            let clan = js::to_string_or_empty(get(announcement, "clanid"));
            let image = first_file(&json_data, "localized_capsule_image")
                .or_else(|| first_file(&json_data, "localized_title_image"))
                .filter(|_| !clan.is_empty())
                .map(|file| format!("{IMAGES}/{clan}/{file}"))
                .or(body_image);
            // The post time, like the store RSS: an event's start can be
            // months after the announcement (future dates, MaxAgeHours).
            let started = get(announcement, "posttime")
                .as_i64()
                .filter(|t| *t > 0)
                .or_else(|| get(event, "rtime32_start_time").as_i64())
                .unwrap_or(0);
            Some(json!({
                "title": if title.is_empty() { "No title".to_string() } else { title },
                "link": link,
                "contentSnippet": crate::parsers::snippet(&html, 500),
                "contentText": crate::parsers::rich(&html),
                "isoDate": iso(started),
                "enclosure": image,
                "author": Value::Null,
                "guid": link,
                "categories": [label, format!("event_type:{event_type}")],
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_branches_and_patch_titles() {
        let body = Body {
            text: String::new(),
            json: Some(json!({ "success": 1, "events": [
                { "gid": "1", "appid": 730, "published": 1, "event_type": 12, "event_name": "Beta patch",
                  "rtime32_start_time": 1_900_000_000, "build_branch": "public-beta",
                  "announcement_body": { "gid": "a1", "posttime": 1_795_000_000, "body": "x", "tags": [] } },
                { "gid": "2", "appid": 730, "published": 1, "event_type": 13, "event_name": "Patch",
                  "build_branch": "public",
                  "announcement_body": { "gid": "a2", "posttime": 1_795_000_000, "body": "x", "tags": [] } },
                { "gid": "3", "appid": 730, "published": 1, "event_type": 28, "event_name": "Update 21",
                  "announcement_body": { "gid": "a3", "posttime": 1_795_000_000, "body": "x", "tags": [] } },
            ]})),
            xml: Default::default(),
        };
        let items = parse(URL, &body);
        assert_eq!(items[0]["isoDate"], json!("2026-11-18T11:06:40.000Z"));
        assert_eq!(items[0]["categories"][0], json!("Beta"));
        assert_eq!(items[1]["categories"][0], json!("Patch"));
        assert_eq!(items[2]["categories"][0], json!("Patch"));
    }

    #[test]
    fn video_and_link_cards_with_text_inside() {
        let body = "Watch:\n[previewyoutube=AX6OFBzjmlk;full]https://www.youtube.com/watch?v=AX6OFBzjmlk[/previewyoutube]\n\
                    [dynamiclink href=\"https://store.steampowered.com/app/1/X/\"]https://store.steampowered.com/app/1/X/[/dynamiclink]";
        let (html, _) = bbcode_to_html(body);
        assert_eq!(
            crate::text::html_to_text(&html),
            "Watch:\nhttps://youtu.be/AX6OFBzjmlk\nhttps://store.steampowered.com/app/1/X/"
        );
    }

    #[test]
    fn leftover_bbcode_does_not_leak() {
        let text = |b: &str| crate::text::html_to_text(&bbcode_to_html(b).0);
        assert_eq!(text("[center]Patch[/center]"), "Patch");
        assert_eq!(
            text("read the guides at [url]EA.com[/url]."),
            "read the guides at EA.com."
        );
        assert!(
            bbcode_to_html("[url]EA.com[/url]")
                .0
                .contains(r#"href="https://EA.com""#)
        );
        assert!(
            bbcode_to_html(r#"by [url=""https://veroz.artstation.com/""]VEROZ[/url]"#)
                .0
                .contains(r#"href="https://veroz.artstation.com/""#)
        );
        assert_eq!(
            text(
                "[previewyoutube=CJJPYpQ6kOo;full][previewyoutube=CJJPYpQ6kOo;full]x[/previewyoutube][/previewyoutube]"
            ),
            "https://youtu.be/CJJPYpQ6kOo"
        );
        assert_eq!(text("Done.\n[img]"), "Done.");
        // Discord hides spoilers and strikes through; plain text shows the words.
        let rich = |b: &str| crate::text::html_to_rich(&bbcode_to_html(b).0);
        assert_eq!(
            rich("after deciding [spoiler]her parents'[/spoiler] fate."),
            "after deciding ||her parents'|| fate."
        );
        assert_eq!(
            rich("[strike]masochists[/strike] brave heroes"),
            "~~masochists~~ brave heroes"
        );
        assert_eq!(text("[spoiler]x[/spoiler] y"), "x y");
        // A pipe or tilde of the feed is still escaped.
        assert_eq!(rich("[spoiler]a|b[/spoiler]"), "||a\\|b||");
    }

    #[test]
    fn line_breaks_in_bodies_stay_line_breaks() {
        // Hades II hotfix notes: one "·" item per source line.
        let body = "· [spoiler][b]Dream Dives[/b][/spoiler]: Fixed [b]Wells of Charon[/b]\n\
                    · Fixed an interaction between [b]Weed Killer (Demeter)[/b] and Dividing Blaze\r\n\
                    [p]- White Fox - Jade Majesty\n- Jeff the Land Shark[/p]";
        let (html, _) = bbcode_to_html(body);
        let text = crate::text::html_to_text(&html);
        assert_eq!(
            text,
            "· Dream Dives: Fixed Wells of Charon\n\
             · Fixed an interaction between Weed Killer (Demeter) and Dividing Blaze\n\
             - White Fox - Jade Majesty\n\
             - Jeff the Land Shark"
        );
    }

    const URL: &str = "https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=730&count_before=0&count_after=5&lang_list=0";

    fn event(gid: &str, kind: i64, name: &str, tags: &[&str], body: &str) -> Value {
        json!({
            "gid": gid, "appid": 730, "event_type": kind, "event_name": name,
            "rtime32_start_time": 1795049820, "published": 1, "hidden": 0, "unlisted": 0,
            "jsondata": "{\"localized_capsule_image\":[\"cap.png\"]}",
            "announcement_body": { "clanid": "3381077", "body": body, "tags": tags, "hidden": 0 }
        })
    }

    #[test]
    fn recognises_the_events_url() {
        assert!(is_api(URL));
        assert_eq!(appid(URL).as_deref(), Some("730"));
        assert!(!is_api("https://store.steampowered.com/feeds/news/app/730"));
        assert!(!is_api(
            "http://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=1"
        ));
    }

    #[test]
    fn classifies_and_keeps_rss_identity() {
        let body = Body {
            text: String::new(),
            json: Some(json!({ "success": 1, "events": [
                event("1", 12, " Counter-Strike 2 Update", &["patchnotes"], "[p]\\[ MAPS ][/p][list][*][p]Fixed [b]ledges[/b][/p][/list]"),
                event("2", 11, "Live broadcast", &[], ""),
                event("3", 28, "Patch Notes - Update 44.1", &[], "[p]x[/p]"),
                event("4", 28, "Community spotlight", &[], "[img]{STEAM_CLAN_IMAGE}/1/a.png[/img][p]y[/p]"),
                event("5", 14, "7.42 Gameplay Update", &[], "")
            ]})),
            xml: Default::default(),
        };
        let items = parse(URL, &body);
        let titles: Vec<&str> = items.iter().map(|i| i["title"].as_str().unwrap()).collect();
        assert_eq!(
            titles,
            [
                "Counter-Strike 2 Update",
                "Patch Notes - Update 44.1",
                "Community spotlight",
                "7.42 Gameplay Update"
            ]
        );
        assert_eq!(
            items[0]["link"],
            "https://store.steampowered.com/news/app/730/view/1"
        );
        assert_eq!(items[0]["guid"], items[0]["link"]);
        assert_eq!(items[0]["categories"], json!(["Patch", "event_type:12"]));
        assert_eq!(items[1]["categories"][0], "Patch");
        assert_eq!(items[2]["categories"][0], "News");
        assert_eq!(items[3]["categories"][0], "Major update");
        assert_eq!(
            items[0]["enclosure"],
            "https://clan.fastly.steamstatic.com/images/3381077/cap.png"
        );
        assert_eq!(items[0]["isoDate"], "2026-11-19T00:57:00.000Z");
        let text = items[0]["contentSnippet"].as_str().unwrap();
        assert!(
            text.contains("[ MAPS ]") && text.contains("Fixed ledges"),
            "{text}"
        );
        assert!(answered(URL, &body));
    }

    #[test]
    fn bbcode_links_images_and_escapes() {
        let (html, image) = bbcode_to_html(
            "[p]a < b & c[/p][url= \"https://x.test/?a=1&b=2\"]Link[/url][img src=\"https://i.test/1.png\"][/img][previewyoutube=\"ZF09w_v7Shw;full\"][/previewyoutube]",
        );
        assert!(html.contains("a &lt; b &amp; c"));
        assert!(html.contains(r#"<a href="https://x.test/?a=1&amp;b=2">Link</a>"#));
        assert!(html.contains("https://youtu.be/ZF09w_v7Shw"));
        assert_eq!(image.as_deref(), Some("https://i.test/1.png"));
    }

    #[test]
    fn bbcode_tags_with_attributes() {
        // Seen in real posts (Total War, PUBG, Windrose, EA FC, …).
        let body = r#"[p align="start"]Hey folks,[/p][p align="justify"]Patch [url="https://x.test/a" style="button"]notes[/url][/p][table equalcells="1" colwidth="50,50"][tr][td colwidth="50"]A[/td][/tr][/table][color=#3498db]Blue[/color][img src="https://i.test/2.png" style="button"][/img][dynamiclink href="https://store.steampowered.com/app/1"][/dynamiclink][quote=dev]Q[/quote]"#;
        let (html, image) = bbcode_to_html(body);
        assert!(!html.contains('['), "{html}");
        assert!(
            html.contains(r#"<a href="https://x.test/a">notes</a>"#),
            "{html}"
        );
        assert!(
            html.contains("https://store.steampowered.com/app/1"),
            "{html}"
        );
        assert_eq!(image.as_deref(), Some("https://i.test/2.png"));
        let text = crate::text::html_to_text(&html);
        assert!(
            text.contains("Hey folks") && text.contains("Blue") && !text.contains("align"),
            "{text}"
        );
    }
}
