//! Regression tests on saved production feeds, grouped in profiles
//! (`profiles/*.json`: news, games, dev). Every sample goes through the
//! parsers and `parsers::finish` exactly like a live feed, and the result is
//! compared with `tests/fixtures/profiles/<profile>.expected.json`.
//!
//! A change in what XFeeder reads from any site fails the test and prints the
//! difference. When the change is intended, refresh the expectations:
//!
//! ```sh
//! XFEEDER_UPDATE_SNAPSHOTS=1 cargo test profile
//! ```

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::js::get;
use crate::parsers::{self, Body};
use crate::text::entry_identity;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Same order as the feed pipeline: parsers by priority, then the regex
/// fallback.
fn parse(url: &str, text: String) -> (String, Vec<Value>) {
    let body = Body::new(text);
    for (name, parser) in parsers::PARSERS {
        let items = parser(url, &body);
        if !items.is_empty() {
            return (name.to_string(), parsers::finish(url, items));
        }
    }
    (
        "rss-regex".into(),
        parsers::finish(url, parsers::regex_items(&body.text)),
    )
}

/// Dates filled in with "now" (entries without a date) would change on
/// every run.
fn stable_date(value: &Value) -> Value {
    let Some(text) = value.as_str() else {
        return value.clone();
    };
    match crate::text::parse_date_str(text) {
        Some(date) if (chrono::Utc::now() - date).num_seconds().abs() < 60 => json!("<now>"),
        _ => value.clone(),
    }
}

fn summary(items: &[Value]) -> Vec<Value> {
    items
        .iter()
        .map(|item| {
            let text: String = get(item, "contentSnippet")
                .as_str()
                .unwrap_or("")
                .chars()
                .take(160)
                .collect();
            let mut out = Map::new();
            for field in [
                "title",
                "author",
                "link",
                "sourceLink",
                "enclosure",
                "imageFallback",
            ] {
                let value = get(item, field);
                if !value.is_null() {
                    out.insert(field.into(), value.clone());
                }
            }
            out.insert("isoDate".into(), stable_date(get(item, "isoDate")));
            out.insert("text".into(), json!(text));
            out.insert("identity".into(), json!(entry_identity(item, false)));
            Value::Object(out)
        })
        .collect()
}

fn profile_result(profile: &Value) -> Value {
    let mut feeds = Map::new();
    for feed in get(profile, "feeds").as_array().into_iter().flatten() {
        let url = get(feed, "url").as_str().expect("feed url");
        let sample = get(feed, "sample").as_str().expect("feed sample");
        let text = std::fs::read_to_string(root().join(sample))
            .unwrap_or_else(|e| panic!("cannot read sample {sample}: {e}"));
        let (parser, items) = parse(url, text);
        feeds.insert(
            url.to_string(),
            json!({ "parser": parser, "entries": items.len(), "items": summary(&items) }),
        );
    }
    Value::Object(feeds)
}

fn first_difference(path: &str, expected: &Value, actual: &Value) -> Option<String> {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            let mut keys: Vec<&String> = e.keys().chain(a.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|k| {
                first_difference(
                    &format!("{path}.{k}"),
                    e.get(k).unwrap_or(&Value::Null),
                    a.get(k).unwrap_or(&Value::Null),
                )
            })
        }
        (Value::Array(e), Value::Array(a)) if e.len() == a.len() => e
            .iter()
            .zip(a)
            .enumerate()
            .find_map(|(i, (x, y))| first_difference(&format!("{path}[{i}]"), x, y)),
        _ if expected == actual => None,
        _ => Some(format!(
            "{path}\n  expected: {expected}\n  actual:   {actual}"
        )),
    }
}

fn check_profile(name: &str) {
    let profile_path = root().join("profiles").join(format!("{name}.json"));
    let profile: Value =
        serde_json::from_str(&std::fs::read_to_string(&profile_path).expect("profile file"))
            .expect("profile JSON");
    let actual = profile_result(&profile);
    let expected_path: &Path =
        &root().join(format!("tests/fixtures/profiles/{name}.expected.json"));
    if std::env::var("XFEEDER_UPDATE_SNAPSHOTS").as_deref() == Ok("1") || !expected_path.exists() {
        let text = serde_json::to_string_pretty(&actual).expect("json") + "\n";
        std::fs::write(expected_path, text).expect("write expectations");
        return;
    }
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(expected_path).expect("expectations"))
            .expect("expectations JSON");
    if let Some(diff) = first_difference(name, &expected, &actual) {
        panic!(
            "profile {name} changed at {diff}\n\nIf this is intended: XFEEDER_UPDATE_SNAPSHOTS=1 cargo test profile"
        );
    }
}

#[test]
fn profile_news() {
    check_profile("news");
}

#[test]
fn profile_games() {
    check_profile("games");
}

#[test]
fn profile_dev() {
    check_profile("dev");
}

#[test]
fn every_profile_feed_has_entries_and_no_duplicate_identities() {
    for name in ["news", "games", "dev"] {
        let profile: Value = serde_json::from_str(
            &std::fs::read_to_string(root().join(format!("profiles/{name}.json"))).unwrap(),
        )
        .unwrap();
        for (url, result) in profile_result(&profile).as_object().unwrap() {
            let items = result["items"].as_array().unwrap();
            assert!(!items.is_empty(), "{name}: {url} has no entries");
            let mut ids: Vec<&str> = items
                .iter()
                .filter_map(|i| i["identity"].as_str())
                .collect();
            let count = ids.len();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), count, "{name}: {url} has duplicate identities");
            for item in items {
                for field in ["enclosure", "link"] {
                    if let Some(url) = item[field].as_str() {
                        assert!(
                            url.starts_with("https://") || url.starts_with("http://"),
                            "{name}: {field} not absolute: {url}"
                        );
                    }
                }
            }
        }
    }
}
