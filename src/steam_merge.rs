//! One Discord post per game update (`Settings.SteamMerge`).
//!
//! A game update usually appears twice: SteamDB sees the new build within
//! minutes, the developer's announcement on Steam follows (often minutes,
//! sometimes hours later). Whichever comes first is posted right away, so
//! nothing waits. When the other one arrives within `WindowHours` (12) for
//! the same app in the same channel, the first post is **edited** to show
//! both (announcement title, notes and picture, plus the build and a SteamDB
//! button) instead of posting again.
//!
//! - every SteamDB build without an announcement stays its own post;
//! - an announcement joins the newest build post that has none yet;
//! - an announcement only joins when it looks like an update (title or text
//!   says update/patch/hotfix/version..., or SteamDB already names it);
//!   events and sales stay separate posts;
//! - if the edit fails (message deleted, Discord error) the entry is posted
//!   normally.
//!
//! ```json
//! "Settings": { "SteamMerge": { "Enabled": true, "WindowHours": 12 } }
//! ```
//! `steampics://APPID` builds count as SteamDB builds; only their `Build`
//! entries (new public build) join, branch entries stay their own posts.
//!
//! Off without the key or with `false`: every entry is its own post, as
//! before.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::js;
use crate::sent::Record;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Merge {
    pub window_ms: i64,
}

pub fn from_config(root: &Value) -> Option<Merge> {
    let default = Merge {
        window_ms: 12 * 3_600_000,
    };
    match js::get(js::get(root, "Settings"), "SteamMerge") {
        Value::Bool(true) => Some(default),
        Value::Object(map) => {
            if map.get("Enabled") == Some(&Value::Bool(false)) {
                return None;
            }
            let hours = map
                .get("WindowHours")
                .and_then(Value::as_f64)
                .filter(|h| h.is_finite() && *h > 0.0)
                .map_or(12.0, |h| h.min(72.0));
            Some(Merge {
                window_ms: (hours * 3_600_000.0) as i64,
            })
        }
        _ => None,
    }
}

static STORE_FEED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"store\.steampowered\.com/feeds/news/app/(\d+)").unwrap());
static STEAMDB_FEED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"steamdb\.info/api/PatchnotesRSS/?\?(?:.*&)?appid=(\d+)").unwrap()
});
static UPDATE_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(update|updated|patch|patches|hotfix|hot-fix|release notes|patch notes|changelog|change log|fixes|bug ?fix(es)?|version|aktualizacja|poprawki)\b|\bv?\d+\.\d+(\.\d+)?\b",
    )
    .unwrap()
});

/// `(is_steamdb, appid)` of a Steam store news or SteamDB patch notes feed.
pub fn kind(source: &str) -> Option<(bool, String)> {
    if let Some(app) = crate::steam_pics::appid(source.trim()) {
        return Some((true, app.to_string()));
    }
    if let Some(c) = STEAMDB_FEED.captures(source) {
        return Some((true, c[1].to_string()));
    }
    STORE_FEED
        .captures(source)
        .map(|c| c[1].to_string())
        .or_else(|| crate::steam_events::appid(source))
        .map(|app| (false, app))
}

/// Steam PICS branch entries are not game updates and never join.
fn joinable(source: &str, entry: &Value) -> bool {
    !crate::steam_pics::is_url(source.trim())
        || js::get(entry, "categories").get(0).and_then(Value::as_str) == Some("Build")
}

fn text(entry: &Value, field: &str) -> String {
    js::to_string_or_empty(js::get(entry, field))
}

/// Whether the announcement is about this build.
fn related(announcement: &Value, build: &Value) -> bool {
    let title = text(announcement, "title");
    let build_text = text(build, "contentSnippet").to_lowercase();
    if title.len() >= 4 && build_text.contains(&title.to_lowercase()) {
        return true;
    }
    let notes: String = text(announcement, "contentSnippet")
        .chars()
        .take(400)
        .collect();
    UPDATE_WORDS.is_match(&title) || UPDATE_WORDS.is_match(&notes)
}

fn without_query(link: &str) -> String {
    match url::Url::parse(link) {
        Ok(mut url) => {
            url.set_query(None);
            url.to_string()
        }
        Err(_) => link.to_string(),
    }
}

/// The announcement with the build attached (`merged`).
pub fn combine(announcement: &Value, build: &Value) -> Value {
    let mut out = crate::sent::slim(announcement);
    let image = text(announcement, "enclosure");
    // The store header is only a fallback; SteamDB's build card says more.
    if (image.is_empty() || image.ends_with("/header.jpg")) && !text(build, "enclosure").is_empty()
    {
        out["enclosure"] = build["enclosure"].clone();
    }
    out["merged"] = json!({
        "title": text(build, "title"),
        "link": without_query(&text(build, "link")),
    });
    out
}

/// The earlier post this entry should be merged into, and the merged entry.
pub fn find(
    records: &[Record],
    channel_key: &str,
    source: &str,
    entry: &Value,
    now_ms: i64,
    merge: &Merge,
) -> Option<(Record, Value)> {
    let (is_db, app) = kind(source)?;
    if !joinable(source, entry) {
        return None;
    }
    let record = records
        .iter()
        .rev()
        .filter(|r| r.channel == channel_key && now_ms - r.sent_at <= merge.window_ms)
        .find(|r| {
            r.entry.get("merged").is_none()
                && joinable(&r.source, &r.entry)
                && kind(&r.source).is_some_and(|(db, a)| db != is_db && a == app)
        })?;
    let (announcement, build) = if is_db {
        (&record.entry, entry)
    } else {
        (entry, &record.entry)
    };
    related(announcement, build).then(|| (record.clone(), combine(announcement, build)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DB: &str = "https://steamdb.info/api/PatchnotesRSS/?appid=730";
    const STORE: &str = "https://store.steampowered.com/feeds/news/app/730";
    const NOW: i64 = 1_800_000_000_000;

    fn build(n: u32) -> Value {
        json!({
            "title": format!("Counter-Strike 2 update for {n} November 2026"),
            "link": format!("https://steamdb.info/patchnotes/{n}/?utm_source=rss"),
            "enclosure": format!("https://steamdb.info/patchnotes/{n}.png"),
            "contentSnippet": "Counter-Strike 2 Update (SteamDB Build 1)",
        })
    }

    fn announcement(title: &str) -> Value {
        json!({
            "title": title,
            "link": "https://store.steampowered.com/news/app/730/view/1",
            "enclosure": "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/730/header.jpg",
            "contentSnippet": "[ MAPS ]\n• Fixed some walkable ledges",
        })
    }

    fn record(id: &str, source: &str, entry: Value, age_h: i64) -> Record {
        Record {
            channel: "ch".into(),
            source: source.into(),
            identity: id.into(),
            message_id: id.into(),
            discord_channel: "9".into(),
            sent_at: NOW - age_h * 3_600_000,
            entry,
        }
    }

    #[test]
    fn announcement_joins_newest_unmerged_build() {
        let m = Merge {
            window_ms: 12 * 3_600_000,
        };
        let records = vec![record("1", DB, build(1), 3), record("2", DB, build(2), 1)];
        let (target, merged) = find(
            &records,
            "ch",
            STORE,
            &announcement("Counter-Strike 2 Update"),
            NOW,
            &m,
        )
        .unwrap();
        assert_eq!(target.message_id, "2");
        assert_eq!(merged["title"], "Counter-Strike 2 Update");
        assert_eq!(
            merged["link"],
            "https://store.steampowered.com/news/app/730/view/1"
        );
        assert_eq!(
            merged["merged"]["link"],
            "https://steamdb.info/patchnotes/2/"
        );
        assert_eq!(merged["enclosure"], "https://steamdb.info/patchnotes/2.png");
        // Other channel, other game, too old, already merged: nothing.
        assert!(find(&records, "other", STORE, &announcement("Update"), NOW, &m).is_none());
        let other_app = "https://store.steampowered.com/feeds/news/app/570";
        assert!(find(&records, "ch", other_app, &announcement("Update"), NOW, &m).is_none());
        let old = vec![record("1", DB, build(1), 13)];
        assert!(find(&old, "ch", STORE, &announcement("Update"), NOW, &m).is_none());
        let done = vec![record("1", DB, combine(&announcement("U"), &build(1)), 1)];
        assert!(find(&done, "ch", STORE, &announcement("Update"), NOW, &m).is_none());
    }

    #[test]
    fn build_joins_announcement_but_not_an_event() {
        let m = Merge {
            window_ms: 12 * 3_600_000,
        };
        let posted = vec![record("5", STORE, announcement("Patch 1.2.3"), 2)];
        let (target, merged) = find(&posted, "ch", DB, &build(7), NOW, &m).unwrap();
        assert_eq!(target.message_id, "5");
        assert_eq!(merged["title"], "Patch 1.2.3");
        let mut sale = announcement("Autumn Sale is live!");
        sale["contentSnippet"] = json!("Save 50% this week");
        let event = vec![record("6", STORE, sale, 1)];
        assert!(find(&event, "ch", DB, &build(8), NOW, &m).is_none());
        // Two builds the same day: the second build is a new post.
        let merged_already = vec![record("5", STORE, merged, 1)];
        assert!(find(&merged_already, "ch", DB, &build(9), NOW, &m).is_none());
    }

    #[test]
    fn steam_pics_builds_join_but_branches_do_not() {
        let m = Merge {
            window_ms: 12 * 3_600_000,
        };
        const PICS: &str = "steampics://730";
        let pics = |kind: &str| {
            let mut e = build(3);
            e["categories"] = json!([kind, "branch:public", "SteamPICS"]);
            e
        };
        assert_eq!(kind(PICS), Some((true, "730".into())));
        let posted = vec![record("5", STORE, announcement("Patch 1.2.3"), 2)];
        assert!(find(&posted, "ch", PICS, &pics("Build"), NOW, &m).is_some());
        assert!(find(&posted, "ch", PICS, &pics("Branch added"), NOW, &m).is_none());
        let builds = vec![
            record("1", PICS, pics("Build"), 2),
            record("2", PICS, pics("Branch added"), 1),
        ];
        let (target, _) = find(&builds, "ch", STORE, &announcement("Update"), NOW, &m).unwrap();
        assert_eq!(target.message_id, "1");
    }

    #[test]
    fn configuration_and_feed_kinds() {
        assert_eq!(kind(DB), Some((true, "730".into())));
        assert_eq!(kind(STORE), Some((false, "730".into())));
        assert_eq!(
            kind("https://store.steampowered.com/feeds/news/group/39049601"),
            None
        );
        assert_eq!(from_config(&json!({})), None);
        assert_eq!(
            from_config(&json!({ "Settings": { "SteamMerge": { "WindowHours": 6 } } })),
            Some(Merge {
                window_ms: 6 * 3_600_000
            })
        );
        assert_eq!(
            from_config(&json!({ "Settings": { "SteamMerge": { "Enabled": false } } })),
            None
        );
    }
}
