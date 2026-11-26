//! Minecraft patch notes from the launcher's own JSON files.
//!
//! ```text
//! https://launchercontent.mojang.com/v2/javaPatchNotes.json
//! https://launchercontent.mojang.com/v2/bedrockPatchNotes.json
//! ```
//!
//! Entries there have no web link and no guid, so the generic JSON parser
//! gave every entry the feed's own address as its identity and nothing was
//! ever sent. Here each entry keeps its own `id` (`identityKey`
//! `mojang:java:<id>` or `mojang:bedrock:<id>`), its date, the launcher's
//! short text and picture, and a category: `snapshot` or `release` for Java,
//! `retail` or `beta` for Bedrock.
//!
//! The launcher has no public page per entry and minecraft.net article
//! addresses cannot be derived from the title (checked 2026-11-26: 6 of 9
//! guesses were 404), so entries have no link.

use serde_json::{Value, json};

use crate::js::{self, get};
use crate::parsers::Body;

const HOST: &str = "launchercontent.mojang.com";

/// `java` or `bedrock` for the two patch note files, else `None`.
fn edition(url: &str) -> Option<&'static str> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.host_str() != Some(HOST) {
        return None;
    }
    match parsed.path() {
        "/v2/javaPatchNotes.json" => Some("java"),
        "/v2/bedrockPatchNotes.json" => Some("bedrock"),
        _ => None,
    }
}

fn text(value: &Value) -> String {
    js::collapse_ws(&js::to_string_or_empty(value))
        .trim()
        .to_string()
}

pub fn parse(url: &str, body: &Body) -> Vec<Value> {
    let Some(edition) = edition(url) else {
        return Vec::new();
    };
    let Some(Value::Array(entries)) = body.json.as_ref().map(|j| get(j, "entries")) else {
        return Vec::new();
    };
    let items: Vec<Value> = entries
        .iter()
        .filter_map(|e| {
            let id = text(get(e, "id"));
            let title = text(get(e, "title"));
            if id.is_empty() || title.is_empty() {
                return None;
            }
            // Bedrock dates are plain days ("2026-10-27").
            let date = text(get(e, "date"));
            let date = if date.len() == 10 {
                format!("{date}T00:00:00Z")
            } else {
                date
            };
            let iso = crate::text::parse_date(&json!(date)).map_or(Value::Null, Value::String);
            // Bedrock short texts start with the title glued to the first sentence.
            let short = text(get(e, "shortText"));
            let short = short.strip_prefix(&title).unwrap_or(&short).trim();
            let image = text(get(get(e, "image"), "url"));
            let kind = text(js::or(&[get(e, "type"), get(e, "patchNoteType")]));
            let categories: Vec<Value> = [kind, text(get(e, "version"))]
                .into_iter()
                .filter(|c| !c.is_empty())
                .map(Value::String)
                .collect();
            Some(json!({
                "title": title,
                "link": Value::Null,
                "contentSnippet": crate::parsers::snippet(short, 500),
                "isoDate": iso,
                "enclosure": if image.is_empty() { Value::Null } else { json!(image) },
                "author": "Minecraft",
                "guid": format!("mojang:{edition}:{id}"),
                "identityKey": format!("mojang:{edition}:{id}"),
                "categories": categories,
            }))
        })
        .collect();
    crate::info!(
        "Mojang",
        "Success ({}) → {}",
        items.len(),
        crate::diag::sanitize_url(url)
    );
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    const JAVA: &str = "https://launchercontent.mojang.com/v2/javaPatchNotes.json";
    const BEDROCK: &str = "https://launchercontent.mojang.com/v2/bedrockPatchNotes.json";

    fn fixture(name: &str) -> Body {
        let path = format!(
            "{}/tests/fixtures/mojang/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        Body::new(std::fs::read_to_string(path).expect("fixture"))
    }

    #[test]
    fn every_entry_has_its_own_identity() {
        for (url, file, edition) in [
            (JAVA, "javaPatchNotes.json", "java"),
            (BEDROCK, "bedrockPatchNotes.json", "bedrock"),
        ] {
            let items = parse(url, &fixture(file));
            assert!(items.len() >= 3, "{file}");
            let ids: std::collections::BTreeSet<String> = items
                .iter()
                .map(|e| crate::text::entry_identity(e, true))
                .collect();
            assert_eq!(ids.len(), items.len(), "{file}");
            assert!(
                ids.iter()
                    .all(|id| id.starts_with(&format!("mojang:{edition}:")))
            );
            assert!(items.iter().all(|e| e["isoDate"].is_string()), "{file}");
        }
    }

    #[test]
    fn java_entry_fields() {
        let items = crate::parsers::finish(JAVA, parse(JAVA, &fixture("javaPatchNotes.json")));
        let first = &items[0];
        assert_eq!(first["title"], "Minecraft 26.4 Pre-Release 1");
        assert_eq!(first["isoDate"], "2026-11-24T12:48:31.000Z");
        assert_eq!(
            first["enclosure"],
            "https://launchercontent.mojang.com/v2/images/26.4pre1540x540.jpg"
        );
        assert_eq!(first["categories"], json!(["snapshot", "26.4-pre-1"]));
        assert!(
            first["contentSnippet"]
                .as_str()
                .unwrap()
                .starts_with("The first pre-release for 26.4")
        );
        assert_eq!(
            crate::text::entry_identity(first, true),
            "mojang:java:26-4-pre-release-1"
        );
    }

    #[test]
    fn bedrock_text_without_glued_title_and_plain_day_date() {
        let items = parse(BEDROCK, &fixture("bedrockPatchNotes.json"));
        let first = &items[0];
        assert_eq!(first["isoDate"], "2026-10-27T00:00:00.000Z");
        assert!(
            first["contentSnippet"]
                .as_str()
                .unwrap()
                .starts_with("Brrrr!"),
            "{}",
            first["contentSnippet"]
        );
        assert_eq!(first["categories"][0], "retail");
    }

    #[test]
    fn other_urls_are_left_to_other_parsers() {
        let body = fixture("javaPatchNotes.json");
        assert!(parse("https://launchercontent.mojang.com/v2/news.json", &body).is_empty());
        assert!(parse("https://example.com/v2/javaPatchNotes.json", &body).is_empty());
    }
}
