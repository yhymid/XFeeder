//! Snapshot tests of post text built from real feed entries (feed review
//! F06; excerpts of the 27.11 data, two crafted after real posts).
//!
//! Each `tests/fixtures/render/NN-name.json` holds `kind` (`steam` BBCode
//! or `html`), `title`, `link` and `raw`; the expected Discord text is in
//! `NN-name.discord.md` and the Telegram message in `NN-name.telegram.html`.
//! When a change is intended, refresh them and read the diff:
//!
//! ```sh
//! XFEEDER_UPDATE_SNAPSHOTS=1 cargo test render
//! ```

use std::path::PathBuf;

use serde_json::{Value, json};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/render")
}

/// The entry the parsers would build from the fixture, as far as the text
/// goes: the body as HTML with links made absolute, the snippet and the
/// Discord text, after `finish`.
fn entry(fixture: &Value) -> Value {
    let raw = fixture["raw"].as_str().unwrap_or_default();
    let html = if fixture["kind"] == "steam" {
        crate::steam_events::bbcode_to_html(raw).0
    } else {
        raw.to_string()
    };
    let link = fixture["link"].as_str().unwrap_or_default();
    let html = match url::Url::parse(link) {
        Ok(base) => crate::text::absolute_hrefs(&html, &base).into_owned(),
        Err(_) => html,
    };
    let entry = json!({
        "title": fixture["title"],
        "link": link,
        "contentSnippet": crate::parsers::snippet(&html, 500),
        "contentText": crate::parsers::rich(&html),
        "isoDate": "2026-11-27T12:00:00.000Z",
    });
    // The clean-up every feed gets (trailers, read-more, GitHub rejoin).
    crate::parsers::finish(link, vec![entry]).remove(0)
}

#[test]
fn render_snapshots() {
    let update = std::env::var("XFEEDER_UPDATE_SNAPSHOTS").as_deref() == Ok("1");
    let mut fixtures: Vec<PathBuf> = std::fs::read_dir(dir())
        .expect("render fixtures")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    fixtures.sort();
    assert!(
        fixtures.len() >= 30,
        "only {} render fixtures",
        fixtures.len()
    );
    let mut changed = Vec::new();
    for path in fixtures {
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("fixture")).expect("JSON");
        let entry = entry(&fixture);
        let discord = format!("{}\n", entry["contentText"].as_str().unwrap_or_default());
        let telegram = format!(
            "{}\n",
            crate::deliver::telegram_text(&entry).unwrap_or_else(|e| format!("ERROR: {e}"))
        );
        for (ext, actual) in [("discord.md", discord), ("telegram.html", telegram)] {
            let expected_path = path.with_extension(ext);
            if update || !expected_path.exists() {
                std::fs::write(&expected_path, &actual).expect("write snapshot");
                continue;
            }
            let expected = std::fs::read_to_string(&expected_path).expect("snapshot");
            if expected != actual {
                changed.push(
                    expected_path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    assert!(
        changed.is_empty(),
        "post text changed for {changed:?}\n\nIf this is intended: XFEEDER_UPDATE_SNAPSHOTS=1 cargo test render, then review the diff"
    );
}
