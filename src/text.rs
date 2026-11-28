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
        r"(?is)<!--.*?-->|<script(?-u:\b)[^>]*>.*?</script\s*>|<style(?-u:\b)[^>]*>.*?</style\s*>",
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

/// Readable text from HTML for message bodies: one line per paragraph or
/// list item (`• `), no empty lines, no invisible characters.
pub fn html_to_text(input: &str) -> String {
    static LI: OnceLock<Regex> = OnceLock::new();
    static SPACE: OnceLock<Regex> = OnceLock::new();
    static PRE: OnceLock<Regex> = OnceLock::new();
    static WS: OnceLock<Regex> = OnceLock::new();
    // In HTML a line break in the source is just a space (GitHub's activity
    // feed breaks lines between every tag); only `<pre>` keeps them.
    let input = if input.contains('<') {
        let pre = re(&PRE, r"(?is)<pre(?-u:\b).*?</pre\s*>");
        let ws = re(&WS, r"\s+");
        let mut out = String::with_capacity(input.len());
        let mut last = 0;
        for m in pre.find_iter(input) {
            out.push_str(&ws.replace_all(&input[last..m.start()], " "));
            out.push_str(m.as_str());
            last = m.end();
        }
        out.push_str(&ws.replace_all(&input[last..], " "));
        out
    } else {
        input.to_string()
    };
    // WordPress feeds (blender.org) start every body with `<?xml encoding="utf-8"?>`.
    static PI: OnceLock<Regex> = OnceLock::new();
    let input = re(&PI, r"(?s)<\?.*?\?>").replace_all(&input, "");
    let marked = re(&LI, r"(?i)<li(?-u:\b)[^>]*>").replace_all(&input, "\n•\n");
    let text = strip_html(&marked)
        .replace(
            ['\u{200b}', '\u{200c}', '\u{200d}', '\u{2060}', '\u{feff}'],
            "",
        )
        // Steam escapes BBCode brackets in its HTML ("\[ MAPS ]").
        .replace("\\[", "[")
        .replace("\\]", "]");
    let mut lines: Vec<String> = Vec::new();
    let mut bullet = false;
    for line in text.lines() {
        let line = re(&SPACE, r"\s+").replace_all(line, " ");
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "•" {
            bullet = true;
            continue;
        }
        // "• 7f3a037" + "docs: crop…" (a commit id on its own) → one line.
        if !bullet
            && let Some(last) = lines.last_mut()
            && let Some(word) = last.strip_prefix("• ")
            && !word.contains(' ')
            && word.len() <= 12
        {
            last.push(' ');
            last.push_str(line);
            continue;
        }
        lines.push(if bullet {
            format!("• {line}")
        } else {
            line.to_string()
        });
        bullet = false;
    }
    lines.join("\n")
}

// Markers that survive `strip_html` (they are not tags) and become Discord
// markdown afterwards.
const HEAD_OPEN: char = '\u{E010}';
const HEAD_CLOSE: char = '\u{E011}';
const LINK_OPEN: char = '\u{E012}';
const LINK_MID: char = '\u{E013}';
const LINK_CLOSE: char = '\u{E014}';

/// Post text for Discord: like [`html_to_text`], plus headings (`<h1>`–`<h6>`,
/// a paragraph or line that is only bold, `<Section name>` lines) in bold,
/// links with their own text as `[text](url)` and a line that is only a URL
/// as a short named link. Telegram and delivery identities keep using the
/// plain `contentSnippet`.
pub fn html_to_rich(input: &str) -> String {
    static HEADING: OnceLock<Regex> = OnceLock::new();
    static BOLD_LINE: OnceLock<Regex> = OnceLock::new();
    static ANCHOR: OnceLock<Regex> = OnceLock::new();
    // The private-use characters below mark headings, links and kept bold
    // while a text is built; a feed must not be able to send them.
    let cleaned: String = input
        .chars()
        .filter(|c| !('\u{E010}'..='\u{E018}').contains(c))
        .collect();
    let input = cleaned.as_str();
    // `<hN>`, and Steam's RSS form `<div class="bb_h1">` (557 of 564
    // headings in the 11 Steam RSS feeds, 27.11).
    let html = re(
        &HEADING,
        r#"(?is)<h[1-6](?-u:\b)[^>]*>(.*?)</h[1-6]\s*>|<div\s+class=["']bb_h[1-6]["'][^>]*>([^<]*(?:<(?:[^d/]|/[^d])[^<]*)*?)</div\s*>"#,
    )
    .replace_all(input, |c: &regex::Captures| {
        let text = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
        format!("<p>{HEAD_OPEN}{text}{HEAD_CLOSE}</p>")
    });
    let bold = re(
        &BOLD_LINE,
        r"(?is)(^|<br\s*/?>|<p(?-u:\b)[^>]*>|</p>|\n)\s*<(?:b|strong)>([^<]{1,100})</(?:b|strong)>\s*(<br\s*/?>|</p>|\n|$)",
    );
    // Twice: two bold lines in a row share the break between them.
    let mut html = html.into_owned();
    for _ in 0..2 {
        html = bold
            .replace_all(&html, |c: &regex::Captures| {
                format!("{}{HEAD_OPEN}{}{HEAD_CLOSE}{}", &c[1], &c[2], &c[3])
            })
            .into_owned();
    }
    // Spoilers stay hidden, struck-through text stays struck through.
    static SPOILER: OnceLock<Regex> = OnceLock::new();
    static STRIKE: OnceLock<Regex> = OnceLock::new();
    let html = re(
        &SPOILER,
        r#"(?is)<span\s+class=["']bb_spoiler["'][^>]*>(.*?)</span\s*>"#,
    )
    .replace_all(&html, format!("{SPOILER_MARK}$1{SPOILER_MARK}").as_str())
    .into_owned();
    let html = re(
        &STRIKE,
        r"(?is)<(?:s|strike|del)>(.*?)</(?:s|strike|del)\s*>",
    )
    .replace_all(&html, format!("{STRIKE_MARK}$1{STRIKE_MARK}").as_str())
    .into_owned();
    let html = re(
        &ANCHOR,
        r#"(?is)<a(?-u:\b)[^>]*?(?-u:\b)href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a\s*>"#,
    )
    .replace_all(&html, |c: &regex::Captures| {
        // Link text on one line, without tags (a <br> or <p> inside the
        // link would split the markers over lines).
        let text = strip_html(&c[2])
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        format!("{LINK_OPEN}{text}{LINK_MID}{}{LINK_CLOSE}", &c[1])
    });
    let text = html_to_text(&html);
    // An empty line before a heading that follows text sets sections apart.
    let mut out: Vec<String> = Vec::new();
    for line in text.lines().filter_map(rich_line) {
        let heading = line.starts_with("**") && line.ends_with("**");
        let after_text = out
            .last()
            .is_some_and(|l| !(l.starts_with("**") && l.ends_with("**")));
        if heading && after_text {
            out.push(String::new());
        }
        out.push(line);
    }
    out.join("\n")
}

/// Feed text as Discord markdown that shows exactly what the feed says:
/// `*`, `_`, `~`, `|`, `` ` `` and `\` are escaped (censored names like
/// `C***p` no longer turn bold), so are `[`/`]` of a fake masked link and
/// `<@…>`/`<#…>`/`<t:…>` syntax. Bare URLs stay as they are (Discord links
/// them; a `\` would break them), and a balanced `**bold**` or `` `code` ``
/// span the author wrote is kept.
pub fn escape_markdown(text: &str) -> String {
    static URL: OnceLock<Regex> = OnceLock::new();
    static KEEP: OnceLock<Regex> = OnceLock::new();
    let url = re(&URL, r"https?://[^\s<>]+[^\s<>.,;:!?)\]]");
    let keep = re(
        &KEEP,
        r"\*\*[^*\s](?:[^*\n]{0,98}[^*\s])?\*\*|`[^`\n]{1,80}`",
    );
    let fake_link = text.contains("](");
    let mut out = String::with_capacity(text.len() + 8);
    let mut last = 0;
    let plain = |part: &str, out: &mut String| {
        let mut kept = 0;
        // Only a span the author meant: it starts and ends at a word
        // boundary ("C***p, q***q" is not "**p, q**").
        let edge =
            |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '*' && c != '\\');
        for span in keep.find_iter(part).filter(|m| {
            edge(part[..m.start()].chars().next_back()) && edge(part[m.end()..].chars().next())
        }) {
            escape_plain(&part[kept..span.start()], fake_link, out);
            out.push_str(span.as_str());
            kept = span.end();
        }
        escape_plain(&part[kept..], fake_link, out);
    };
    for found in url.find_iter(text) {
        plain(&text[last..found.start()], &mut out);
        out.push_str(found.as_str());
        last = found.end();
    }
    plain(&text[last..], &mut out);
    out
}

fn escape_plain(part: &str, brackets: bool, out: &mut String) {
    let mut chars = part.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' | '*' | '_' | '~' | '|' | '`' => {
                out.push('\\');
                out.push(c);
            }
            '[' | ']' if brackets => {
                out.push('\\');
                out.push(c);
            }
            '<' if chars
                .peek()
                .is_some_and(|n| matches!(n, '@' | '#' | ':' | 't' | 'a' | '/')) =>
            {
                out.push_str("\\<");
            }
            _ => out.push(c),
        }
    }
    // Visual only: allowed_mentions already stops pings.
    if out.contains("@everyone") || out.contains("@here") {
        let fixed = out
            .replace("@everyone", "@\u{200B}everyone")
            .replace("@here", "@\u{200B}here");
        *out = fixed;
    }
}

/// Markdown a line would start with by accident: `# `, `-# `, `> `, `1. `.
fn escape_line_start(line: String) -> String {
    static START: OnceLock<Regex> = OnceLock::new();
    let start = re(&START, r"^(?:(#{1,3}) |(-#) |(>{1,3}) |(\d{1,4})([.)]) )");
    let Some(c) = start.captures(&line) else {
        return line;
    };
    let end = c.get(0).map_or(0, |m| m.end());
    let head = if let Some(h) = c.get(1) {
        format!("\\{} ", h.as_str())
    } else if c.get(2).is_some() {
        "\\-# ".to_string()
    } else if let Some(q) = c.get(3) {
        format!("\\{} ", q.as_str())
    } else {
        format!("{}\\{} ", &c[4], &c[5])
    };
    format!("{head}{}", &line[end..])
}

fn rich_line(line: &str) -> Option<String> {
    static LINK: OnceLock<Regex> = OnceLock::new();
    let link = re(
        &LINK,
        "\u{E012}([^\u{E013}]*)\u{E013}([^\u{E014}]*)\u{E014}",
    );
    // Decorative rules ("______", "=====") are not text.
    static RULE: OnceLock<Regex> = OnceLock::new();
    if re(&RULE, r"^\s*[_\-=~*]{5,}\s*$").is_match(line) {
        return None;
    }
    // Bold the author wrote around whole phrases, links included
    // (Cursor: "**[Google Drive](…):** search files"), is kept: its `**`
    // become a marker that escaping leaves alone.
    static AUTHOR_BOLD: OnceLock<Regex> = OnceLock::new();
    let edge = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '*' && c != '\\');
    let bold = re(
        &AUTHOR_BOLD,
        r"\*\*[^*\s][^*]{0,300}?[^*\s]\*\*|\*\*[^*\s]\*\*",
    );
    let mut marked = String::with_capacity(line.len());
    let mut last = 0;
    for m in bold.find_iter(line) {
        if !(edge(line[..m.start()].chars().next_back()) && edge(line[m.end()..].chars().next())) {
            continue;
        }
        marked.push_str(&line[last..m.start()]);
        marked.push(AUTHOR_BOLD_MARK);
        marked.push_str(&m.as_str()[2..m.len() - 2]);
        marked.push(AUTHOR_BOLD_MARK);
        last = m.end();
    }
    marked.push_str(&line[last..]);
    let line = marked.as_str();
    // Feed text is escaped piece by piece; the links and bold built around
    // it are not.
    let mut escaped = String::with_capacity(line.len() + 8);
    let mut last = 0;
    for found in link.find_iter(line) {
        escaped.push_str(&escape_markdown(&line[last..found.start()]));
        escaped.push_str(found.as_str());
        last = found.end();
    }
    escaped.push_str(&escape_markdown(&line[last..]));
    let line = escaped.as_str();
    let line = link.replace_all(line, |c: &regex::Captures| {
        let raw = c[1].trim().replace(['[', ']'], "");
        let text = escape_markdown(&raw);
        let url = c[2].trim();
        let web = url.starts_with("https://") || url.starts_with("http://");
        // Text that looks like an address shows the real one: no
        // "[https://bank.example](https://evil.example)".
        static ADDRESS: OnceLock<Regex> = OnceLock::new();
        let address = re(
            &ADDRESS,
            r"(?i)^(?:[a-z][a-z0-9+.-]*://|www\.)|^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:/\S*)?$",
        );
        if !web || url.contains([' ', ')']) {
            text
        } else if raw.is_empty() || raw == url || address.is_match(&raw) {
            url.to_string()
        } else {
            format!("[{text}]({url})")
        }
    });
    // Markers of a link that did not close on this line must not leak.
    let line = line.replace([LINK_OPEN, LINK_MID, LINK_CLOSE], " ");
    let line = line.trim();
    let whole = line.starts_with(HEAD_OPEN)
        && line.ends_with(HEAD_CLOSE)
        && line.matches(HEAD_OPEN).count() == 1;
    let line = if whole {
        let inner = line.trim_matches([HEAD_OPEN, HEAD_CLOSE]).trim();
        let inner = inner
            .trim_start_matches(['<'])
            .trim_end_matches(['>'])
            .trim();
        if inner.is_empty() || inner.contains("**") {
            inner.to_string()
        } else {
            format!("**{inner}**")
        }
    } else {
        line.replace([HEAD_OPEN, HEAD_CLOSE], "")
    };
    // "<New Events>" written as a section name.
    let line = match line.strip_prefix('<').and_then(|l| l.strip_suffix('>')) {
        Some(name) if !name.is_empty() && name.len() <= 60 && !name.contains(['<', '>', '/']) => {
            format!("**{}**", name.trim())
        }
        _ => line,
    };
    let line = line.trim().to_string();
    if line.is_empty() {
        return None;
    }
    let line = escape_line_start(line).replace(AUTHOR_BOLD_MARK, "**");
    let line = marker_pairs(&line, SPOILER_MARK, "||");
    let line = marker_pairs(&line, STRIKE_MARK, "~~");
    Some(named_url(&line).unwrap_or(line))
}

/// Stands for an author's `**` while a line is escaped.
const AUTHOR_BOLD_MARK: char = '\u{E016}';
/// Spoiler (`||…||`) and struck-through (`~~…~~`) text while a line is
/// escaped.
const SPOILER_MARK: char = '\u{E017}';
const STRIKE_MARK: char = '\u{E018}';

/// A marker pair becomes Discord markdown when it is balanced on the line
/// and holds text; otherwise it goes.
fn marker_pairs(line: &str, mark: char, markdown: &str) -> String {
    let count = line.matches(mark).count();
    if count == 0 {
        return line.to_string();
    }
    let empty = format!("{mark}{mark}");
    if count % 2 == 1 || line.contains(&empty) {
        return line.replace(&empty, "").replace(mark, "");
    }
    line.replace(mark, markdown)
}

/// A line that is only a URL becomes a short named link.
fn named_url(line: &str) -> Option<String> {
    let url = Url::parse(line).ok()?;
    if !matches!(url.scheme(), "http" | "https") || line.contains(char::is_whitespace) {
        return None;
    }
    let host = url
        .host_str()?
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let segments: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    let label = match (host.as_str(), segments.as_slice()) {
        ("store.steampowered.com", ["app", _, name, ..]) if !name.is_empty() => {
            format!("{} on Steam", name.replace('_', " "))
        }
        ("store.steampowered.com", ["app", ..]) => "Steam store page".to_string(),
        ("youtu.be", _) | ("youtube.com", _) => "YouTube video".to_string(),
        _ => return None,
    };
    Some(format!("[{label}]({line})"))
}

/// Cut a post text at the end of a line (or a word) before `max` UTF-16
/// units and show that it goes on.
pub fn cut_text(text: &str, max: usize) -> String {
    if js::len16(text) <= max {
        return text.to_string();
    }
    let mut out = cut_raw(text, max);
    // A heading with nothing under it is not worth keeping before the "…"
    // (19 % of cut posts ended like that on 27.11).
    if let Some(body) = out.strip_suffix("\n…")
        && let Some((before, last)) = body.trim_end().rsplit_once('\n')
        && last.starts_with("**")
        && last.ends_with("**")
        && !before.trim().is_empty()
    {
        out = format!("{}\n…", before.trim_end());
    }
    // An escape cut off from its character would escape the "…".
    let body = out.trim_end_matches(['…', '\n']);
    let slashes = body.len() - body.trim_end_matches('\\').len();
    if slashes % 2 == 1 {
        let rest = &out[body.len()..];
        return format!("{}{rest}", &body[..body.len() - 1]);
    }
    out
}

fn cut_raw(text: &str, max: usize) -> String {
    let cut = js::prefix16(text, max.saturating_sub(2));
    // The cut already ends a word or a line.
    let next = text[cut.len()..].chars().next();
    if next == Some('\n') {
        return format!("{}\n…", cut.trim_end());
    }
    if let Some(i) = cut.rfind('\n').filter(|&i| i > cut.len() / 2) {
        return format!("{}\n…", cut[..i].trim_end());
    }
    if next.is_some_and(char::is_whitespace) {
        return format!("{}…", cut.trim_end());
    }
    let cut = cut
        .rfind(char::is_whitespace)
        .filter(|&i| i > cut.len() / 2)
        .map_or(cut, |i| &cut[..i]);
    format!("{}…", cut.trim_end())
}

/// Absolute form of a possibly relative link found in a feed.
pub fn resolve_url(base: &str, href: &str) -> Option<String> {
    if href.is_empty() || Url::parse(href).is_ok() {
        return None;
    }
    let joined = Url::parse(base).ok()?.join(href).ok()?;
    matches!(joined.scheme(), "http" | "https").then(|| joined.to_string())
}

/// Profile pictures (GitHub, Gravatar): shown small, next to the text.
pub fn is_avatar(value: &Value) -> bool {
    let Some(url) = value.as_str().and_then(|u| Url::parse(u).ok()) else {
        return false;
    };
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    host == "avatars.githubusercontent.com"
        || (host.ends_with("gravatar.com") && url.path().starts_with("/avatar/"))
}

/// A larger version of a known small feed image, if the site offers one:
/// GitHub/Gravatar avatars (30 px), YouTube `hqdefault` (480×360, letterboxed)
/// and WordPress thumbnails (`name-224x224.jpg`).
pub fn upgrade_image(input: &str) -> Option<String> {
    static YT: OnceLock<Regex> = OnceLock::new();
    static WP: OnceLock<Regex> = OnceLock::new();
    let mut url = Url::parse(input).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if is_avatar(&Value::String(input.to_string())) {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| k != "s" && k != "size")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.query_pairs_mut()
            .clear()
            .extend_pairs(pairs)
            .append_pair("s", "460");
    } else if host.ends_with("ytimg.com") {
        let caps = re(
            &YT,
            r"^/vi(?:_webp)?/([A-Za-z0-9_-]{11})/(?:default|mqdefault|hqdefault|sddefault)\.(?:jpg|webp)$",
        )
        .captures(url.path())?;
        return Some(format!(
            "https://i.ytimg.com/vi/{}/maxresdefault.jpg",
            &caps[1]
        ));
    } else if url.path().contains("/wp-content/uploads/") {
        let path = re(&WP, r"(?i)-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp|gif))$")
            .replace(url.path(), "$1")
            .into_owned();
        url.set_path(&path);
    } else {
        return None;
    }
    let upgraded = url.to_string();
    (upgraded != input).then_some(upgraded)
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
    static SRC: OnceLock<Regex> = OnceLock::new();
    static SIZE: OnceLock<Regex> = OnceLock::new();
    let src = re(&SRC, r#"(?i)(?-u:\b)src\s*=\s*["']([^"']+)["']"#);
    let size = re(&SIZE, r#"(?i)(?-u:\b)(?:width|height)\s*=\s*["']?(\d+)"#);
    // The first real picture: not an emoji or icon (Discourse forums put
    // 20 px emoji first), not inline data, not a tracking pixel.
    re(&IMG, r"(?i)<img\s[^>]*>")
        .find_iter(html)
        .find_map(|tag| {
            let tag = tag.as_str();
            let url = decode_entities(src.captures(tag)?.get(1)?.as_str());
            let lower = tag.to_ascii_lowercase();
            let small = size
                .captures_iter(tag)
                .any(|c| c[1].parse::<u32>().is_ok_and(|n| n <= 64));
            let junk = small
                || lower.contains("emoji")
                || lower.contains("class=\"icon")
                || url.starts_with("data:")
                || url.to_ascii_lowercase().ends_with(".svg");
            (!junk).then_some(url)
        })
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

/// Delivery identity: `identityKey` (set by `parsers::finish` for entries
/// that share a link) > link > guid > stable content hash.
pub fn entry_identity(entry: &Value, discord: bool) -> String {
    if let Some(key) = js::trimmed_str(js::get(entry, "identityKey")) {
        return key.to_string();
    }
    // `sourceLink`: the link as the feed wrote it, before it was made absolute,
    // so entries delivered earlier keep their identity.
    let link = js::or(&[js::get(entry, "sourceLink"), js::get(entry, "link")]);
    let from_guid = !js::truthy(link);
    let direct = js::to_string_or_empty(js::or(&[link, js::get(entry, "guid")]));
    let key = normalize_link(&direct);
    if !key.is_empty() {
        // A guid keeps its `#…`: for link-less entries it is what tells them
        // apart (`url#<hash>` from the parsers, JSON Feed `…/changelog#v1`).
        // Stripping it gave every such entry the feed URL (F07-7).
        if from_guid
            && let Some((_, fragment)) = direct.trim().split_once('#')
            && !fragment.is_empty()
            && !key.contains('#')
        {
            return format!("{key}#{fragment}");
        }
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
    // "2026-11-19 12:58:18 UTC" (GitHub activity feeds).
    if let Some(naive) = text
        .strip_suffix(" UTC")
        .or_else(|| text.strip_suffix(" GMT"))
        .and_then(|t| NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S%.f").ok())
    {
        return Some(Utc.from_utc_datetime(&naive));
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
/// Discord timestamp markup: every reader sees the date in their own time
/// zone and language. Empty when the date cannot be read.
pub fn discord_time(value: &str) -> String {
    parse_date_str(value).map_or_else(String::new, |dt| format!("<t:{}:f>", dt.timestamp()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_fragments_keep_link_less_entries_apart() {
        let a = json!({ "guid": "https://f.example/feed.json#0123456789abcdef" });
        let b = json!({ "guid": "https://f.example/feed.json#fedcba9876543210" });
        assert_ne!(entry_identity(&a, false), entry_identity(&b, false));
        assert_eq!(
            entry_identity(&json!({ "guid": "https://site/changelog#v1" }), false),
            "https://site/changelog#v1"
        );
        // A link still drops its fragment, as before.
        assert_eq!(
            entry_identity(
                &json!({ "link": "https://site/post#comments", "guid": "x" }),
                false
            ),
            "https://site/post"
        );
    }

    #[test]
    fn feed_text_is_escaped_for_discord() {
        let r = |html: &str| html_to_rich(html);
        assert_eq!(
            r("<p># PST 11.25.2026 – revised</p>"),
            "\\# PST 11.25.2026 – revised"
        );
        assert_eq!(r("<p>-# small</p>"), "\\-# small");
        assert_eq!(r("<p>&gt; A: When Ready</p>"), "\\> A: When Ready");
        assert_eq!(r("<p>C***pBiet, q***q</p>"), "C\\*\\*\\*pBiet, q\\*\\*\\*q");
        assert_eq!(
            r("<h2>*** INCOMING ***</h2>"),
            "**\\*\\*\\* INCOMING \\*\\*\\***"
        );
        assert_eq!(
            r("<p>node_modules/, operator.local.*, *.sqlite*</p>"),
            "node\\_modules/, operator.local.\\*, \\*.sqlite\\*"
        );
        assert_eq!(
            r("<p>See https://en.wikipedia.org/wiki/Foo_(bar)_baz now</p>"),
            "See https://en.wikipedia.org/wiki/Foo_(bar)_baz now"
        );
        assert_eq!(
            r("<p>[click](https://evil.example)</p>"),
            "\\[click\\](https://evil.example)"
        );
        assert_eq!(
            r("<p>Ping &lt;@&amp;123&gt; at &lt;t:1795093098:R&gt; @everyone</p>"),
            "Ping \\<@&123> at \\<t:1795093098:R> @\u{200B}everyone"
        );
        assert_eq!(
            r("<p>**Start voice chat** lets you</p>"),
            "**Start voice chat** lets you"
        );
        assert_eq!(r("<p>a ** b</p>"), "a \\*\\* b");
        assert_eq!(r("<p>______________________________</p><p>x</p>"), "x");
        assert_eq!(
            r("<p>1. Back up saves</p><p>2. Right-click</p>"),
            "1\\. Back up saves\n2\\. Right-click"
        );
        assert_eq!(r("<p>- White Fox</p>"), "- White Fox");
        assert_eq!(r("<p>Use `npx init` now</p>"), "Use `npx init` now");
        assert_eq!(
            r(r#"<p><a href="https://a.example/x">snake_case beta</a></p>"#),
            "[snake\\_case beta](https://a.example/x)"
        );
        assert_eq!(
            r(r#"<p>**<a href="https://c.example/gd">Google Drive</a>:** search files</p>"#),
            "**[Google Drive](https://c.example/gd):** search files"
        );
        let text = format!("{}\n\n**Next section**\n{}", "a".repeat(60), "b".repeat(80));
        assert_eq!(cut_text(&text, 90), format!("{}\n…", "a".repeat(60)));
        // An escape never dangles before the "…" of a cut.
        let cut = cut_text("aaaaaaaa \\*bbbbbbbbbbbbbbbbbbbbbbbb", 12);
        assert!(!cut.contains("\\…"), "{cut}");
    }

    #[test]
    fn the_first_real_picture_is_the_post_image() {
        let html = r#"<p><img src="https://forum/images/emoji/twitter/tada.png?v=12" class="emoji" width="20" height="20"> Hi</p><img src="https://cdn/x.jpg?a=1&amp;b=2" width="1200">"#;
        assert_eq!(
            first_image_in_html(html).as_deref(),
            Some("https://cdn/x.jpg?a=1&b=2")
        );
        assert_eq!(
            first_image_in_html(r#"<img src="data:image/gif;base64,R0">"#),
            None
        );
    }

    #[test]
    fn steam_rss_headings_are_bold() {
        let out = html_to_rich(
            r#"<div class="bb_h1">Bug Fixes and Change Notes</div><p>Fixed a crash.</p>"#,
        );
        assert!(out.starts_with("**Bug Fixes and Change Notes**"), "{out}");
        assert!(out.contains("Fixed a crash."));
    }

    #[test]
    fn rich_text_for_discord() {
        let html = "<h2>All-New Content</h2><p><b>New In Store</b></p><p>- White Fox<br>- Jeff</p>\
            <p><b>&lt;New Events&gt;</b></p><p>Read <a href=\"https://a.example/notes\">the notes</a> now.</p>\
            <p>https://store.steampowered.com/app/3531720/ELDEN_RING_NIGHTREIGN_The_Forsaken_Hollows/</p>\
            <p>https://youtu.be/2UNC9EkMWHY</p><p>Text with <b>bold</b> inside.</p>";
        assert_eq!(
            html_to_rich(html),
            "**All-New Content**\n**New In Store**\n- White Fox\n- Jeff\n\n**New Events**\n\
             Read [the notes](https://a.example/notes) now.\n\
             [ELDEN RING NIGHTREIGN The Forsaken Hollows on Steam](https://store.steampowered.com/app/3531720/ELDEN_RING_NIGHTREIGN_The_Forsaken_Hollows/)\n\
             [YouTube video](https://youtu.be/2UNC9EkMWHY)\n\
             Text with bold inside."
        );
        // A link whose text is its URL stays a plain URL; other schemes lose the link.
        assert_eq!(
            html_to_rich(
                "<a href=\"https://x.example/a\">https://x.example/a</a> <a href=\"javascript:x\">click</a>"
            ),
            "https://x.example/a click"
        );
    }

    #[test]
    fn rich_links_cannot_leak_markers_or_spoof() {
        assert_eq!(
            html_to_rich("<a href=\"https://x.example/a\">first<br>second</a>"),
            "[first second](https://x.example/a)"
        );
        assert_eq!(
            html_to_rich(
                "<a href=\"https://evil.example/login\">https://steamcommunity.com/login</a>"
            ),
            "https://evil.example/login"
        );
        assert_eq!(
            html_to_rich("<a href=\"https://evil.example/\">steamcommunity.com</a>"),
            "https://evil.example/"
        );
        let text =
            html_to_rich("<p><a href=\"https://x.example/\">a<figure>b</figure></p><p>c</a></p>");
        assert!(
            !text.contains(['\u{E012}', '\u{E013}', '\u{E014}']),
            "{text:?}"
        );
    }

    #[test]
    fn cut_text_ends_at_a_line() {
        let text = "line one\nline two\nline three is longer";
        assert_eq!(cut_text(text, 100), text);
        assert_eq!(cut_text(text, 24), "line one\nline two\n…");
        assert_eq!(
            cut_text("one two three four five six", 15),
            "one two three…"
        );
    }
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

    #[test]
    fn html_to_text_keeps_paragraphs_and_list_items() {
        let html = r#"<p class="bb_paragraph">\[ MAPS ]</p><ul><li><p>Fixed ledges</p></li><li>Fixed&nbsp;gaps</li></ul><p>A"#.to_string() + "\u{2060}" + "B   C</p>";
        assert_eq!(
            html_to_text(&html),
            "[ MAPS ]\n• Fixed ledges\n• Fixed gaps\nAB C"
        );
    }

    #[test]
    fn small_images_get_larger_versions() {
        assert_eq!(
            upgrade_image("https://avatars.githubusercontent.com/u/1?s=30&v=4").as_deref(),
            Some("https://avatars.githubusercontent.com/u/1?v=4&s=460")
        );
        assert_eq!(
            upgrade_image("https://0.gravatar.com/avatar/ab?d=x&r=g&s=30").as_deref(),
            Some("https://0.gravatar.com/avatar/ab?d=x&r=g&s=460")
        );
        assert_eq!(
            upgrade_image("https://i4.ytimg.com/vi/GOUuN2Zivys/hqdefault.jpg").as_deref(),
            Some("https://i.ytimg.com/vi/GOUuN2Zivys/maxresdefault.jpg")
        );
        assert_eq!(
            upgrade_image("https://a.pl/wp-content/uploads/2026/01/x_miniaturka-224x224.jpg")
                .as_deref(),
            Some("https://a.pl/wp-content/uploads/2026/01/x_miniaturka.jpg")
        );
        assert_eq!(upgrade_image("https://a.pl/wp-content/uploads/x.jpg"), None);
        assert_eq!(
            upgrade_image("https://i.ytimg.com/vi/GOUuN2Zivys/maxresdefault.jpg"),
            None
        );
        assert_eq!(upgrade_image("https://img.boop.pl/a.jpg?class=1200"), None);
        assert!(is_avatar(&json!(
            "https://avatars.githubusercontent.com/u/1?s=30"
        )));
        assert!(!is_avatar(&json!("https://steamdb.info/patchnotes/1.png")));
    }

    #[test]
    fn relative_links_resolve_and_keep_identity() {
        assert_eq!(
            resolve_url("https://git.example/o/r.rss", "/o/r/commit/1").as_deref(),
            Some("https://git.example/o/r/commit/1")
        );
        assert_eq!(resolve_url("https://a/feed", "https://b/x"), None);
        let before = json!({ "link": "/o/r/commit/1" });
        let after =
            json!({ "link": "https://git.example/o/r/commit/1", "sourceLink": "/o/r/commit/1" });
        assert_eq!(
            entry_identity(&before, false),
            entry_identity(&after, false)
        );
    }

    #[test]
    fn html_source_line_breaks_are_spaces_except_in_pre() {
        let html = "<div>yhymid\n  deleted\n branch <a>3.0-alpha</a></div><ul><li><code><a>7f3a037</a></code>\n<div>docs: crop</div></li></ul><pre>line one\nline two</pre>";
        assert_eq!(
            html_to_text(html),
            "yhymid deleted branch 3.0-alpha\n• 7f3a037 docs: crop\nline one\nline two"
        );
        assert_eq!(html_to_text("plain\ntext"), "plain\ntext");
    }

    #[test]
    fn github_activity_dates_parse() {
        assert_eq!(
            parse_date(&json!("2026-11-19 12:58:18 UTC")).as_deref(),
            Some("2026-11-19T12:58:18.000Z")
        );
    }

    #[test]
    fn discord_timestamps() {
        assert_eq!(discord_time("2026-11-19T12:58:18.000Z"), "<t:1795093098:f>");
        assert_eq!(discord_time("nonsense"), "");
    }

    #[test]
    fn processing_instructions_are_dropped() {
        let text =
            html_to_text(r#"<?xml encoding="utf-8"?><html><body><p>Blender 5.3</p></body></html>"#);
        assert_eq!(text.trim(), "Blender 5.3");
    }
}
