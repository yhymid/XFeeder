//! Free games as feed sources: Epic Games, Steam, GOG and GamerPower.
//!
//! None of these stores has an RSS feed for giveaways. Each URL below is the
//! store's own backend (GamerPower is a public giveaway API that also lists
//! itch.io, Ubisoft, EA, Prime Gaming and other stores):
//!
//! ```text
//! https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=PL&allowCountries=PL
//! https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json={"query":{"start":0,"count":50,"filters":{"price_filters":{"min_discount_percent":99},"type_filters":{"include_apps":true,"include_dlc":true}}},"context":{"language":"english","country_code":"PL","steam_realm":1},"data_request":{"include_basic_info":true,"include_assets":true,"include_all_purchase_options":true}}
//! https://catalog.gog.com/v1/catalog?limit=48&price=between:0,0&discounted=eq:true&productType=in:game,pack,dlc&countryCode=PL&locale=en-US&currencyCode=PLN&order=desc:trending&page=1
//! https://www.gamerpower.com/api/giveaways?type=game
//! ```
//!
//! Only offers that are free **and** normally paid become entries: sales,
//! demos and free-to-play games are left out. Every entry carries `offer`
//! (`status`, `starts`, `until`, `price`), shown as a "Free until …" line, and
//! the categories `Free now` or `Upcoming` plus the store (GamerPower: its
//! platforms, e.g. `Epic Games Store`, `Itch.io`). A channel that reads both
//! the Epic backend and GamerPower can drop GamerPower's copies of Epic offers
//! with `"Filters": { "Exclude": ["/^Epic Games Store$/"], "Fields": ["categories"] }`.
//!
//! The entry id includes the offer's start (Epic, Steam) so a game that is
//! free again months later is posted again.

use serde_json::{Value, json};

use crate::js::{self, get, path};
use crate::parsers::Body;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Store {
    Epic,
    Steam,
    Gog,
    GamerPower,
}

fn store(url: &str) -> Option<Store> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "https" {
        return None;
    }
    match (u.host_str()?, u.path()) {
        ("store-site-backend-static.ak.epicgames.com", "/freeGamesPromotions") => Some(Store::Epic),
        ("api.steampowered.com", p) if p.starts_with("/IStoreQueryService/Query/") => {
            Some(Store::Steam)
        }
        ("catalog.gog.com", "/v1/catalog") => Some(Store::Gog),
        ("www.gamerpower.com" | "gamerpower.com", "/api/giveaways" | "/api/filter") => {
            Some(Store::GamerPower)
        }
        _ => None,
    }
}

/// A URL this module reads (its answers go to `parseFreeGames` only).
pub fn is_api(url: &str) -> bool {
    store(url).is_some()
}

/// A valid store answer, even when it holds no free game today.
pub fn answered(url: &str, body: &Body) -> bool {
    let Some(json) = body.json.as_ref() else {
        return false;
    };
    match store(url) {
        Some(Store::Epic) => path(json, &["data", "Catalog", "searchStore", "elements"]).is_array(),
        Some(Store::Steam) => get(json, "response").is_object(),
        Some(Store::Gog) => get(json, "products").is_array(),
        // GamerPower answers `{"status":0,"status_message":"No active giveaways…"}`
        // when nothing matches.
        Some(Store::GamerPower) => json.is_array() || get(json, "status").as_i64() == Some(0),
        None => false,
    }
}

pub fn parse(url: &str, body: &Body) -> Vec<Value> {
    let Some(json) = body.json.as_ref() else {
        return Vec::new();
    };
    let now = chrono::Utc::now().timestamp();
    match store(url) {
        Some(Store::Epic) => epic(json, now),
        Some(Store::Steam) => steam(json),
        Some(Store::Gog) => gog(json),
        Some(Store::GamerPower) => gamerpower(json),
        None => Vec::new(),
    }
}

fn iso(seconds: i64) -> Value {
    chrono::DateTime::from_timestamp(seconds, 0).map_or(Value::Null, |d| {
        json!(d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    })
}

fn text(v: &Value) -> String {
    js::trimmed_str(v).unwrap_or("").to_string()
}

#[allow(clippy::too_many_arguments)]
fn entry(
    id: String,
    title: String,
    link: String,
    description: &str,
    image: Option<String>,
    date: Value,
    offer: Value,
    categories: Vec<String>,
) -> Value {
    // Store descriptions are plain text, some with HTML tags (Steam): read
    // as HTML with line breaks kept, through the shared text path.
    let html = crate::text::clean_invisible(description.trim()).replace('\n', "<br>");
    json!({
        "title": title,
        "link": link,
        "contentSnippet": crate::parsers::snippet(&html, 500),
        "contentText": crate::parsers::rich(&html),
        "isoDate": date,
        "enclosure": image,
        "author": Value::Null,
        "guid": id,
        "categories": categories,
        "offer": offer,
    })
}

// --- Epic Games -----------------------------------------------------------

fn epic_slug(game: &Value) -> Option<String> {
    let page = |list: &Value| {
        list.as_array()?
            .iter()
            .filter(|m| get(m, "pageType") == &json!("productHome"))
            .find_map(|m| js::trimmed_str(get(m, "pageSlug")).map(str::to_string))
    };
    page(get(game, "offerMappings"))
        .or_else(|| page(path(game, &["catalogNs", "mappings"])))
        .or_else(|| {
            js::trimmed_str(get(game, "productSlug"))
                .map(|s| s.trim_end_matches("/home").to_string())
        })
        .filter(|s| !s.is_empty() && !s.starts_with('['))
}

fn epic_image(game: &Value) -> Option<String> {
    let images = get(game, "keyImages").as_array()?;
    [
        "OfferImageWide",
        "DieselStoreFrontWide",
        "Thumbnail",
        "OfferImageTall",
    ]
    .iter()
    .find_map(|kind| {
        images
            .iter()
            .find(|i| get(i, "type") == &json!(kind))
            .and_then(|i| js::trimmed_str(get(i, "url")))
    })
    .map(str::to_string)
}

/// The free (`discountPercentage == 0` is "pay 0 %") offers of one group.
fn epic_free(game: &Value, key: &str) -> Vec<(i64, i64)> {
    let parse = |v: &Value| {
        js::trimmed_str(v)
            .and_then(crate::text::parse_date_str)
            .map(|d| d.timestamp())
    };
    get(get(game, "promotions"), key)
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|g| get(g, "promotionalOffers").as_array().into_iter().flatten())
        .filter(|o| path(o, &["discountSetting", "discountPercentage"]).as_i64() == Some(0))
        .filter_map(|o| Some((parse(get(o, "startDate"))?, parse(get(o, "endDate"))?)))
        .collect()
}

fn epic(json: &Value, now: i64) -> Vec<Value> {
    let Some(games) = path(json, &["data", "Catalog", "searchStore", "elements"]).as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for game in games {
        let price = path(game, &["price", "totalPrice"]);
        // A free-to-play game in the promo slot has no price to save.
        if price
            .get("originalPrice")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            <= 0
        {
            continue;
        }
        let id = text(get(game, "id"));
        let title = text(get(game, "title"));
        if id.is_empty() || title.is_empty() {
            continue;
        }
        let link = epic_slug(game).map_or_else(
            || "https://store.epicgames.com/en-US/free-games".to_string(),
            |slug| format!("https://store.epicgames.com/en-US/p/{slug}"),
        );
        let normal = text(path(price, &["fmtPrice", "originalPrice"]));
        let current = epic_free(game, "promotionalOffers")
            .into_iter()
            .filter(|(start, end)| *start <= now && now < *end)
            .filter(|_| price.get("discountPrice").and_then(Value::as_i64) == Some(0));
        let upcoming = epic_free(game, "upcomingPromotionalOffers")
            .into_iter()
            .filter(|(start, _)| *start > now);
        for ((start, end), status) in current
            .map(|o| (o, "Free now"))
            .chain(upcoming.map(|o| (o, "Upcoming")))
        {
            out.push(entry(
                format!(
                    "epic:{id}:{start}{}",
                    if status == "Upcoming" {
                        ":upcoming"
                    } else {
                        ""
                    }
                ),
                title.clone(),
                link.clone(),
                &text(get(game, "description")),
                epic_image(game),
                iso(start),
                json!({ "status": status, "starts": iso(start), "until": iso(end),
                        "price": (!normal.is_empty()).then_some(normal.clone()) }),
                vec![status.into(), "Epic Games".into()],
            ));
        }
    }
    out
}

// --- Steam ----------------------------------------------------------------

fn cents(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str()?.parse().ok())
}

fn steam(json: &Value) -> Vec<Value> {
    let Some(items) = path(json, &["response", "store_items"]).as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let option = get(item, "best_purchase_option");
            // Free to keep: nothing to pay now, but normally paid.
            if cents(get(option, "final_price_in_cents"))? != 0
                || cents(get(option, "original_price_in_cents")).unwrap_or(0) <= 0
            {
                return None;
            }
            let appid = get(item, "appid")
                .as_i64()
                .or_else(|| get(item, "id").as_i64())?;
            let name = text(get(item, "name"));
            if name.is_empty() {
                return None;
            }
            let until = get(option, "active_discounts")
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|d| get(d, "discount_end_date").as_i64())
                .max();
            let path_part = text(get(item, "store_url_path"));
            let link = if path_part.is_empty() {
                format!("https://store.steampowered.com/app/{appid}/")
            } else {
                format!("https://store.steampowered.com/{path_part}")
            };
            let assets = get(item, "assets");
            let image = js::trimmed_str(get(assets, "asset_url_format"))
                .zip(
                    js::trimmed_str(get(assets, "header"))
                        .or_else(|| js::trimmed_str(get(assets, "main_capsule"))),
                )
                .map(|(format, file)| {
                    format!(
                        "https://shared.akamai.steamstatic.com/store_item_assets/{}",
                        format.replace("${FILENAME}", file)
                    )
                });
            let normal = text(get(option, "formatted_original_price"));
            Some(entry(
                format!("steam:{appid}:{}", until.unwrap_or(0)),
                name,
                link,
                &text(path(item, &["basic_info", "short_description"])),
                image,
                Value::Null,
                json!({ "status": "Free now", "starts": Value::Null,
                        "until": until.map_or(Value::Null, iso),
                        "price": (!normal.is_empty()).then_some(normal) }),
                vec!["Free now".into(), "Steam".into()],
            ))
        })
        .collect()
}

// --- GOG ------------------------------------------------------------------

fn gog(json: &Value) -> Vec<Value> {
    let Some(products) = get(json, "products").as_array() else {
        return Vec::new();
    };
    let amount = |v: &Value| text(v).replace(',', ".").parse::<f64>().ok();
    products
        .iter()
        .filter_map(|p| {
            let price = get(p, "price");
            if amount(path(price, &["finalMoney", "amount"]))? != 0.0
                || amount(path(price, &["baseMoney", "amount"])).unwrap_or(0.0) <= 0.0
            {
                return None;
            }
            let id = text(get(p, "id"));
            let title = text(get(p, "title"));
            let link = text(get(p, "storeLink"));
            if id.is_empty() || title.is_empty() || !link.starts_with("https://") {
                return None;
            }
            let base = path(price, &["baseMoney"]);
            let normal = format!(
                "{} {}",
                text(get(base, "amount")),
                text(get(base, "currency"))
            );
            Some(entry(
                format!("gog:{id}"),
                title,
                link,
                "",
                js::trimmed_str(get(p, "coverHorizontal")).map(str::to_string),
                Value::Null,
                json!({ "status": "Free now", "starts": Value::Null, "until": Value::Null,
                        "price": normal.trim() }),
                vec!["Free now".into(), "GOG".into()],
            ))
        })
        .collect()
}

// --- GamerPower -----------------------------------------------------------

/// GamerPower dates (`2026-11-27 18:24:43`, or `N/A`), read as UTC.
fn gp_date(v: &Value) -> Value {
    js::trimmed_str(v)
        .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
        .map_or(Value::Null, |d| iso(d.and_utc().timestamp()))
}

fn gamerpower(json: &Value) -> Vec<Value> {
    let Some(list) = json.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter(|g| text(get(g, "status")).eq_ignore_ascii_case("active"))
        .filter_map(|g| {
            let id = get(g, "id").as_i64()?;
            let title = text(get(g, "title"));
            let link = [get(g, "gamerpower_url"), get(g, "open_giveaway_url")]
                .into_iter()
                .map(text)
                // A giveaway without a page has `gamerpower_url` ".../n-a".
                .find(|l| l.starts_with("https://") && !l.ends_with("/n-a"))?;
            if title.is_empty() {
                return None;
            }
            let worth = text(get(g, "worth"));
            let worth = (!worth.is_empty() && worth != "N/A").then_some(worth);
            let mut categories = vec!["Free now".to_string()];
            categories.extend(
                text(get(g, "platforms"))
                    .split(',')
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(str::to_string),
            );
            // The claim steps ("1. Click …\r\n2. …") as a numbered list.
            let esc = |t: &str| {
                t.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
            };
            let mut description = format!("<p>{}</p>", esc(&text(get(g, "description"))));
            let steps: Vec<String> = text(get(g, "instructions"))
                .lines()
                .map(|l| l.trim().trim_start_matches(|c: char| c.is_ascii_digit()))
                .map(|l| l.strip_prefix('.').unwrap_or(l).trim())
                .filter(|l| !l.is_empty())
                .map(|l| format!("<li>{}</li>", esc(l)))
                .collect();
            if !steps.is_empty() {
                description.push_str(&format!("<ol>{}</ol>", steps.concat()));
            }
            Some(entry(
                format!("gamerpower:{id}"),
                title,
                link,
                &description,
                js::trimmed_str(get(g, "image"))
                    .or_else(|| js::trimmed_str(get(g, "thumbnail")))
                    .map(str::to_string),
                gp_date(get(g, "published_date")),
                json!({ "status": "Free now", "starts": Value::Null,
                        "until": gp_date(get(g, "end_date")), "price": worth }),
                categories,
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(v: Value) -> Body {
        Body {
            text: String::new(),
            json: Some(v),
            xml: Default::default(),
        }
    }

    const EPIC: &str = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=PL&allowCountries=PL";

    fn offer(start: &str, end: &str, pct: i64) -> Value {
        json!({ "promotionalOffers": [{ "startDate": start, "endDate": end,
                "discountSetting": { "discountType": "PERCENTAGE", "discountPercentage": pct } }] })
    }

    #[test]
    fn urls() {
        assert!(is_api(EPIC));
        assert!(is_api(
            "https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json={}"
        ));
        assert!(is_api("https://catalog.gog.com/v1/catalog?limit=48"));
        assert!(is_api("https://www.gamerpower.com/api/filter?platform=pc"));
        assert!(!is_api(
            "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/"
        ));
        assert!(!is_api("http://www.gamerpower.com/api/giveaways"));
    }

    #[test]
    fn epic_current_upcoming_sales_and_free_to_play() {
        let now = crate::text::parse_date_str("2026-11-28T12:00:00Z")
            .unwrap()
            .timestamp();
        let game = |title: &str, discount: i64, original: i64, promos: Value, upcoming: Value| {
            json!({ "title": title, "id": format!("id-{title}"), "description": "Fun.",
                "keyImages": [{ "type": "Thumbnail", "url": "https://img/t" }, { "type": "OfferImageWide", "url": "https://img/w" }],
                "productSlug": null,
                "offerMappings": [{ "pageSlug": format!("{}-1a2b", title.to_lowercase()), "pageType": "productHome" }],
                "price": { "totalPrice": { "discountPrice": discount, "originalPrice": original,
                    "fmtPrice": { "originalPrice": "PLN 63.00" } } },
                "promotions": { "promotionalOffers": [promos], "upcomingPromotionalOffers": [upcoming] } })
        };
        let none = json!({ "promotionalOffers": [] });
        let json = json!({ "data": { "Catalog": { "searchStore": { "elements": [
            game("Bread", 0, 6300, offer("2026-11-26T16:00:00.000Z", "2026-12-03T16:00:00.000Z", 0), none.clone()),
            game("Sale", 1680, 8400, offer("2026-11-27T16:00:00.000Z", "2026-12-01T15:00:00.000Z", 20), none.clone()),
            game("Firestone", 0, 0, offer("2026-11-26T16:00:00.000Z", "2026-12-03T16:00:00.000Z", 0), none.clone()),
            game("Strange", 7500, 7500, none.clone(), offer("2026-12-03T16:00:00.000Z", "2026-12-10T16:00:00.000Z", 0)),
        ] } } } });
        let items = epic(&json, now);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["title"], json!("Bread"));
        assert_eq!(
            items[0]["link"],
            json!("https://store.epicgames.com/en-US/p/bread-1a2b")
        );
        assert_eq!(items[0]["enclosure"], json!("https://img/w"));
        assert_eq!(
            items[0]["offer"]["until"],
            json!("2026-12-03T16:00:00.000Z")
        );
        assert_eq!(items[0]["offer"]["price"], json!("PLN 63.00"));
        assert_eq!(items[0]["categories"], json!(["Free now", "Epic Games"]));
        assert_eq!(items[1]["title"], json!("Strange"));
        assert_eq!(items[1]["categories"][0], json!("Upcoming"));
        assert_ne!(items[0]["guid"], items[1]["guid"]);
        assert!(answered(EPIC, &body(json)));
    }

    #[test]
    fn steam_free_to_keep_only() {
        let item = |appid: i64, fin: &str, orig: &str| {
            json!({ "appid": appid, "name": format!("Game {appid}"), "store_url_path": format!("app/{appid}/Game"),
                "basic_info": { "short_description": "A <b>game</b>." },
                "assets": { "asset_url_format": format!("steam/apps/{appid}/${{FILENAME}}?t=1"), "header": "h.jpg" },
                "best_purchase_option": { "final_price_in_cents": fin, "original_price_in_cents": orig,
                    "formatted_original_price": "45,99 zł", "active_discounts": [{ "discount_end_date": 1_796_061_600 }] } })
        };
        let json = json!({ "response": { "store_items": [item(1, "0", "4599"), item(2, "873", "4599"), item(3, "0", "0")] } });
        let items = steam(&json);
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0]["link"],
            json!("https://store.steampowered.com/app/1/Game")
        );
        assert_eq!(items[0]["guid"], json!("steam:1:1796061600"));
        assert_eq!(items[0]["contentText"], json!("A game."));
        assert_eq!(
            items[0]["enclosure"],
            json!("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/h.jpg?t=1")
        );
        assert_eq!(items[0]["offer"]["price"], json!("45,99 zł"));
        let empty = json!({ "response": {} });
        assert!(steam(&empty).is_empty());
        assert!(answered(
            "https://api.steampowered.com/IStoreQueryService/Query/v1/",
            &body(empty)
        ));
    }

    #[test]
    fn gog_paid_games_at_zero() {
        let p = |id: &str, fin: &str, base: &str| {
            json!({ "id": id, "title": format!("G{id}"), "storeLink": format!("https://www.gog.com/en/game/g{id}"),
                "coverHorizontal": "https://img/c.jpg",
                "price": { "finalMoney": { "amount": fin, "currency": "PLN" }, "baseMoney": { "amount": base, "currency": "PLN" } } })
        };
        let items = gog(
            &json!({ "products": [p("1", "0.00", "29.99"), p("2", "0.00", "0.00"), p("3", "5.00", "29.99")] }),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["guid"], json!("gog:1"));
        assert_eq!(items[0]["offer"]["price"], json!("29.99 PLN"));
    }

    #[test]
    fn gamerpower_platforms_and_dates() {
        let json = json!([
            { "id": 3863, "title": "Lonely in the Winter (itch.io) Giveaway", "worth": "$2.99",
              "image": "https://gp/1b.jpg", "description": "Claim it.", "instructions": "1. Click.\r\n2. Claim.",
              "open_giveaway_url": "https://www.gamerpower.com/open/x", "gamerpower_url": "https://www.gamerpower.com/x",
              "published_date": "2026-11-27 18:24:43", "end_date": "2026-12-06 23:59:00",
              "platforms": "PC, Itch.io, DRM-Free", "status": "Active", "type": "Game" },
            { "id": 2, "title": "Old", "gamerpower_url": "https://www.gamerpower.com/old", "status": "Expired",
              "platforms": "PC", "end_date": "N/A", "published_date": "N/A" },
            { "id": 3, "title": "No page", "gamerpower_url": "https://www.gamerpower.com/n-a",
              "open_giveaway_url": "https://www.gamerpower.com/open/no-page", "status": "Active", "platforms": "PC" },
        ]);
        let items = gamerpower(&json);
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[1]["link"],
            json!("https://www.gamerpower.com/open/no-page")
        );
        assert_eq!(
            items[0]["categories"],
            json!(["Free now", "PC", "Itch.io", "DRM-Free"])
        );
        assert_eq!(items[0]["isoDate"], json!("2026-11-27T18:24:43.000Z"));
        assert_eq!(
            items[0]["offer"]["until"],
            json!("2026-12-06T23:59:00.000Z")
        );
        assert_eq!(items[0]["offer"]["price"], json!("$2.99"));
        assert_eq!(
            items[0]["contentText"],
            json!("Claim it.\n1\\. Click.\n2\\. Claim.")
        );
        let none = json!({ "status": 0, "status_message": "No active giveaways available at the moment." });
        assert!(gamerpower(&none).is_empty());
        assert!(answered(
            "https://www.gamerpower.com/api/giveaways?type=game",
            &body(none)
        ));
    }
}
