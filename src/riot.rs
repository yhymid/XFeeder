//! Riot Games news pages (League of Legends, Teamfighttactics, Valorant).
//!
//! Riot has no RSS (`/rss.xml` is 404). The news pages are Next.js pages
//! whose data is in `<script id="__NEXT_DATA__">`: the first
//! `articleCardGrid` blade holds the cards, newest first. A tag page keeps
//! only that tag, e.g. patch notes:
//!
//! ```text
//! https://www.leagueoflegends.com/en-us/news/tags/patch-notes/
//! https://teamfighttactics.leagueoflegends.com/en-us/news/tags/patch-notes/
//! https://playvalorant.com/en-us/news/tags/patch-notes/
//! ```
//!
//! The categories are the card's category and tags (`Game Updates`,
//! `Patch Notes`, …), so `Filters` can keep one of them.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::js::{self, get, path};
use crate::parsers::Body;

/// Cards kept from one page (a tag page lists ~180, years back).
const MAX_CARDS: usize = 30;

pub fn is_page(url: &str) -> bool {
    url::Url::parse(url).ok().is_some_and(|u| {
        u.scheme() == "https"
            && matches!(
                u.host_str(),
                Some(
                    "www.leagueoflegends.com"
                        | "teamfighttactics.leagueoflegends.com"
                        | "playvalorant.com"
                        | "www.playvalorant.com"
                )
            )
            && u.path().contains("/news")
    })
}

fn next_data(text: &str) -> Option<Value> {
    static SCRIPT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)<script[^>]*\bid="__NEXT_DATA__"[^>]*>(.*?)</script>"#).unwrap()
    });
    serde_json::from_str(SCRIPT.captures(text)?.get(1)?.as_str()).ok()
}

fn cards(data: &Value) -> Option<&Vec<Value>> {
    path(data, &["props", "pageProps", "page", "blades"])
        .as_array()?
        .iter()
        .find(|b| get(b, "type") == &json!("articleCardGrid"))
        .and_then(|b| get(b, "items").as_array())
}

pub fn parse(url: &str, body: &Body) -> Vec<Value> {
    if !is_page(url) {
        return Vec::new();
    }
    let Some(data) = next_data(&body.text) else {
        return Vec::new();
    };
    let Some(origin) = url::Url::parse(url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
    else {
        return Vec::new();
    };
    let Some(cards) = cards(&data) else {
        return Vec::new();
    };
    cards
        .iter()
        .take(MAX_CARDS)
        .filter_map(|card| {
            let title = js::collapse_ws(js::trimmed_str(get(card, "title"))?);
            let target = js::trimmed_str(path(card, &["action", "payload", "url"]))?;
            let link = if target.starts_with("https://") {
                target.to_string()
            } else if target.starts_with('/') {
                format!("{origin}{target}")
            } else {
                return None;
            };
            let html = js::to_string_or_empty(path(card, &["description", "body"]));
            let image = js::trimmed_str(path(card, &["media", "url"]))
                .filter(|_| path(card, &["media", "type"]) == &json!("image"))
                .or_else(|| js::trimmed_str(path(card, &["imageMedia", "url"])));
            let mut categories: Vec<String> = js::trimmed_str(path(card, &["category", "title"]))
                .map(str::to_string)
                .into_iter()
                .collect();
            categories.extend(
                get(card, "tags")
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| js::trimmed_str(get(t, "title")).map(str::to_string)),
            );
            Some(json!({
                "title": title.trim(),
                "link": link,
                "contentSnippet": crate::parsers::snippet(&html, 500),
                "contentText": crate::parsers::rich(&html),
                "isoDate": js::or(&[get(card, "publishedAt"), path(card, &["analytics", "publishDate"])]),
                "enclosure": image,
                "author": Value::Null,
                "guid": link,
                "categories": categories,
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://www.leagueoflegends.com/en-us/news/tags/patch-notes/";

    fn page(items: Value) -> Body {
        let data = json!({ "props": { "pageProps": { "page": { "blades": [
            { "type": "riotbar" },
            { "type": "articleCardGrid", "items": items },
        ] } } } });
        Body {
            text: format!(
                r#"<html><script id="__NEXT_DATA__" type="application/json">{data}</script></html>"#
            ),
            json: None,
            xml: Default::default(),
        }
    }

    #[test]
    fn patch_note_cards() {
        let body = page(json!([
            { "title": "League of Legends Patch 26.23 Notes", "publishedAt": "2026-11-17T19:00:00.000Z",
              "action": { "type": "weblink", "payload": { "url": "/en-us/news/game-updates/league-of-legends-patch-26-23-notes" } },
              "media": { "type": "image", "url": "https://cmsassets.rgpub.io/a.jpg" },
              "description": { "type": "html", "body": "Winter map returns." },
              "category": { "title": "Game Updates" }, "tags": [{ "title": "Patch Notes" }] },
            { "title": "No link", "action": { "type": "weblink", "payload": {} } },
        ]));
        let items = parse(URL, &body);
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0]["link"],
            json!(
                "https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-23-notes"
            )
        );
        assert_eq!(items[0]["isoDate"], json!("2026-11-17T19:00:00.000Z"));
        assert_eq!(
            items[0]["enclosure"],
            json!("https://cmsassets.rgpub.io/a.jpg")
        );
        assert_eq!(
            items[0]["categories"],
            json!(["Game Updates", "Patch Notes"])
        );
        assert_eq!(items[0]["contentSnippet"], json!("Winter map returns."));
    }

    #[test]
    fn other_hosts_and_pages() {
        assert!(is_page(
            "https://playvalorant.com/en-us/news/tags/patch-notes/"
        ));
        assert!(!is_page("https://www.leagueoflegends.com/en-us/champions/"));
        assert!(parse("https://example.com/news", &page(json!([]))).is_empty());
    }
}
