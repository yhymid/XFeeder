//! Text helpers: HTML stripping, entity decoding, link normalization, entry
//! identity (must match the identities stored by previous versions) and
//! permissive date parsing.

use std::sync::OnceLock;

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use regex::Regex;
use serde_json::Value;
use sha1::{Digest, Sha1};
use url::Url;

use crate::js;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    re(
        &ENTITY,
        r"&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,15});",
    )
    .replace_all(text, |caps: &regex::Captures| {
        let name = &caps[1];
        let decoded = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"))
        {
            u32::from_str_radix(hex, 16)
                .ok()
                .and_then(char::from_u32)
                .map(String::from)
        } else if let Some(dec) = name.strip_prefix('#') {
            dec.parse::<u32>()
                .ok()
                .and_then(char::from_u32)
                .map(String::from)
        } else {
            named_entity(name).map(String::from)
        };
        decoded.unwrap_or_else(|| caps[0].to_string())
    })
    .into_owned()
}

fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "laquo" => "«",
        "raquo" => "»",
        "lsquo" => "‘",
        "rsquo" => "’",
        "ldquo" => "“",
        "rdquo" => "”",
        "bdquo" => "„",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "euro" => "€",
        "pound" => "£",
        "middot" => "·",
        "bull" => "•",
        "deg" => "°",
        "times" => "×",
        "shy" => "",
        "zwnj" => "",
        "zwj" => "",
        _ => return None,
    })
}

const BLOCK_TAGS: [&str; 24] = [
    "br",
    "p",
    "div",
    "li",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
    "td",
    "th",
    "table",
    "blockquote",
    "section",
    "article",
    "header",
    "footer",
    "hr",
    "img",
    "pre",
];

/// Remove markup like `string-strip-html`: script/style bodies and comments
/// disappear, block tags become whitespace, inline tags vanish.
pub fn strip_html(input: &str) -> String {
    static DROP: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    if !input.contains('<') {
        return js::trim(&decode_entities(input)).to_string();
    }
    let text = re(
        &DROP,
        r"(?is)<!--.*?-->|<script\b[^>]*>.*?</script\s*>|<style\b[^>]*>.*?</style\s*>",
    )
    .replace_all(input, " ");
    let text = re(
        &TAG,
        r"(?s)</?([A-Za-z][A-Za-z0-9:-]*)(?:\s[^>]*)?/?>|<![^>]*>",
    )
    .replace_all(&text, |caps: &regex::Captures| {
        let tag = caps
            .get(1)
            .map(|m| m.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        if BLOCK_TAGS.contains(&tag.as_str()) {
            "\n"
        } else {
            ""
        }
    });
    let text = re(&SPACES, r"[ \t\u{a0}]*\n[ \t\n\u{a0}]*").replace_all(&text, "\n");
    js::trim(&decode_entities(&text)).to_string()
}

/// Text of an xml2js-like value (`a?.VALUE` for nodes with attributes).
pub fn node_text(value: &Value) -> String {
    match value {
        Value::Object(map) => map.get("VALUE").map(node_text).unwrap_or_default(),
        Value::Null => String::new(),
        other => js::to_string(other),
    }
}

pub fn first_image_in_html(html: &str) -> Option<String> {
    static IMG: OnceLock<Regex> = OnceLock::new();
    re(&IMG, r#"(?i)<img\s+[^>]*src=["']([^"']+)["']"#)
        .captures(html)
        .map(|c| c[1].to_string())
}

const TRACKING: [&str; 8] = [
    "utm_name",
    "fbclid",
    "gclid",
    "yclid",
    "mc_cid",
    "mc_eid",
    "ref",
    "utm_source",
];

/// `normalizeLink`: drop the fragment and tracking parameters.
pub fn normalize_link(input: &str) -> String {
    let Ok(mut url) = Url::parse(input) else {
        return input.to_string();
    };
    url.set_fragment(None);
    if url.query().is_some() {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let keep: Vec<&(String, String)> = pairs
            .iter()
            .filter(|(key, _)| {
                !key.to_lowercase().starts_with("utm_") && !TRACKING.contains(&key.as_str())
            })
            .collect();
        if keep.len() != pairs.len() {
            if keep.is_empty() {
                url.set_query(None);
            } else {
                url.query_pairs_mut()
                    .clear()
                    .extend_pairs(keep.iter().map(|(k, v)| (k.as_str(), v.as_str())));
            }
        }
    }
    url.to_string()
}

/// Delivery identity: link > guid > stable content hash.
pub fn entry_identity(entry: &Value, discord: bool) -> String {
    let direct = js::or(&[js::get(entry, "link"), js::get(entry, "guid")]);
    let direct = js::to_string_or_empty(direct);
    let key = normalize_link(&direct);
    if !key.is_empty() {
        return key;
    }
    let parts: Vec<String> = ["title", "isoDate", "author", "contentSnippet"]
        .iter()
        .map(|field| js::get(entry, field))
        .filter(|value| js::truthy(value))
        .map(js::to_string)
        .collect();
    let fallback = js::trim(&parts.join("\n")).to_string();
    if fallback.is_empty() {
        return if discord {
            js::to_string_or_empty(js::get(entry, "guid"))
        } else {
            String::new()
        };
    }
    format!(
        "hash:{}",
        &hex::encode(Sha1::digest(fallback.as_bytes()))[..20]
    )
}

pub fn iso(datetime: DateTime<Utc>) -> String {
    datetime.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn now_iso() -> String {
    iso(Utc::now())
}

/// `parseDate`: RFC 2822, ISO 8601 and Unix timestamps → ISO string.
pub fn parse_date(value: &Value) -> Option<String> {
    if !js::truthy(value) {
        return None;
    }
    match value {
        Value::Number(number) => {
            let n = number.as_f64()?;
            let digits = js::to_string(value).len();
            let millis = if digits == 10 { n * 1000.0 } else { n };
            Utc.timestamp_millis_opt(millis as i64).single().map(iso)
        }
        Value::String(text) => parse_date_str(text).map(iso),
        _ => None,
    }
}

pub fn parse_date_str(text: &str) -> Option<DateTime<Utc>> {
    let text = text.trim();
    // JavaScript ignores a wrong weekday ("Mon, 02 Jan 2024"); chrono rejects
    // it, and feeds get this wrong often enough to matter.
    static WEEKDAY: OnceLock<Regex> = OnceLock::new();
    let text = re(&WEEKDAY, r"^[A-Za-z]{3,9},?\s+(\d)")
        .find(text)
        .map_or(text, |m| &text[m.end() - 1..]);
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(text) {
        return Some(dt.with_timezone(&Utc));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f%z",
        "%Y-%m-%dT%H:%M%z",
        "%Y-%m-%d %H:%M:%S%.f%z",
        "%a, %d %b %Y %H:%M:%S %z",
        "%d %b %Y %H:%M:%S %z",
    ] {
        if let Ok(dt) = DateTime::parse_from_str(text, format) {
            return Some(dt.with_timezone(&Utc));
        }
    }
    // RFC 822 dates with a named zone chrono does not know (e.g. "CEST").
    static ZONE: OnceLock<Regex> = OnceLock::new();
    if let Some(caps) = re(&ZONE, r"^(.*\d{1,2}:\d{2}(?::\d{2})?)\s+([A-Z]{2,5})$").captures(text) {
        let offset = match &caps[2] {
            "CET" => "+0100",
            "CEST" => "+0200",
            "BST" => "+0100",
            "IST" => "+0530",
            "JST" => "+0900",
            "AEST" => "+1000",
            "MSK" => "+0300",
            "EET" => "+0200",
            "EEST" => "+0300",
            _ => "+0000",
        };
        if let Ok(dt) = DateTime::parse_from_rfc2822(&format!("{} {offset}", &caps[1])) {
            return Some(dt.with_timezone(&Utc));
        }
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y/%m/%d %H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    for format in ["%Y-%m-%d", "%Y/%m/%d"] {
        if let Ok(date) = NaiveDate::parse_from_str(text, format) {
            return Some(Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0)?));
        }
    }
    None
}

/// `new Date(iso).toLocaleString("en-US")` in the server time zone (UTC on the
/// VPS), e.g. `1/2/2024, 3:04:05 PM`.
pub fn locale_en_us(value: &str) -> String {
    let Some(dt) = parse_date_str(value) else {
        return "Invalid Date".into();
    };
    let local = dt.with_timezone(&chrono::Local);
    local.format("%-m/%-d/%Y, %-I:%M:%S %p").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn link_normalization() {
        assert_eq!(
            normalize_link("https://a.pl/x?utm_source=rss&id=5#top"),
            "https://a.pl/x?id=5"
        );
        assert_eq!(
            normalize_link("https://a.pl/x?utm_medium=a&fbclid=1"),
            "https://a.pl/x"
        );
        assert_eq!(normalize_link("https://a.pl/x?id=5"), "https://a.pl/x?id=5");
        assert_eq!(normalize_link("not a url"), "not a url");
        assert_eq!(
            normalize_link("https://www.youtube.com/watch?v=Z7BLIwA17jM"),
            "https://www.youtube.com/watch?v=Z7BLIwA17jM"
        );
    }

    #[test]
    fn identity_fallback_hash() {
        let entry = json!({ "title": "T", "isoDate": "2024-01-01T00:00:00.000Z" });
        let id = entry_identity(&entry, false);
        assert!(id.starts_with("hash:") && id.len() == 25);
        assert_eq!(entry_identity(&json!({ "guid": "abc" }), false), "abc");
    }

    #[test]
    fn dates() {
        assert_eq!(
            parse_date(&json!("Mon, 02 Jan 2024 03:04:05 GMT")).as_deref(),
            Some("2024-01-02T03:04:05.000Z")
        );
        assert_eq!(
            parse_date(&json!("2024-01-02T03:04:05+01:00")).as_deref(),
            Some("2024-01-02T02:04:05.000Z")
        );
        assert_eq!(
            parse_date(&json!("2024-01-02")).as_deref(),
            Some("2024-01-02T00:00:00.000Z")
        );
        assert_eq!(
            parse_date(&json!(1_700_000_000)).as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(
            parse_date(&json!("Tue, 10 Jun 2025 12:00:00 CEST")).as_deref(),
            Some("2025-06-10T10:00:00.000Z")
        );
        assert_eq!(parse_date(&json!("garbage")), None);
    }

    #[test]
    fn html_stripping() {
        assert_eq!(
            strip_html("<p>Hello <b>big</b> world</p><script>x()</script>"),
            "Hello big world"
        );
        assert_eq!(strip_html("a &amp; b"), "a & b");
        assert_eq!(strip_html("line1<br/>line2"), "line1\nline2");
        assert_eq!(
            first_image_in_html(r#"<p><img class="x" src="https://i/1.png"></p>"#).as_deref(),
            Some("https://i/1.png")
        );
    }
}
