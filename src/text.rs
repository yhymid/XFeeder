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
        "zwnj" => "\u{200c}",
        "zwj" => "\u{200d}",
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

/// `href`s made absolute against `base` (only web results; `#top`,
/// `mailto:` and other schemes stay as they are).
pub fn absolute_hrefs<'a>(html: &'a str, base: &Url) -> std::borrow::Cow<'a, str> {
    static ANCHOR: OnceLock<Regex> = OnceLock::new();
    if !html.contains("href") {
        return std::borrow::Cow::Borrowed(html);
    }
    re(
        &ANCHOR,
        r#"(?is)(<a(?-u:\b)[^>]*?(?-u:\b)href\s*=\s*)(["'])([^"']*)(["'])([^>]*>)(.*?)(</a\s*>)"#,
    )
    .replace_all(html, |c: &regex::Captures| {
        let href = c[3].trim();
        let relative = (!href.is_empty() && !href.starts_with('#') && !href.contains(':'))
            || href.starts_with("//");
        // A link around only an image (an avatar, a screenshot) has no
        // text to show; it stays as it was and is left out.
        let has_text = !strip_html(&c[6]).trim().is_empty();
        let resolved = (relative && has_text)
            .then(|| base.join(&decode_entities(href)).ok())
            .flatten()
            .filter(|u| matches!(u.scheme(), "http" | "https"));
        match resolved {
            Some(u) => format!(
                "{}{}{}{}{}{}{}",
                &c[1],
                &c[2],
                u.as_str().replace('"', "%22").replace('\'', "%27"),
                &c[4],
                &c[5],
                &c[6],
                &c[7]
            ),
            None => c[0].to_string(),
        }
    })
}

/// Invisible characters that only cause trouble go: zero-width spaces, the
/// BOM, bidi overrides and isolates (`dev \u{202E}txt.exe` spoofing), and
/// lines made only of direction marks. A zero-width joiner stays between two
/// non-ASCII characters (🧑‍🎨, 🐈‍⬛ were split into two emoji) and a
/// non-joiner between two letters (Persian).
pub fn clean_invisible(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        let prev = i.checked_sub(1).and_then(|p| chars.get(p)).copied();
        let next = chars.get(i + 1).copied();
        let keep = match c {
            '\u{200b}'
            | '\u{2060}'
            | '\u{feff}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}' => false,
            '\u{200d}' => {
                let symbol =
                    |c: Option<char>| c.is_some_and(|c| !c.is_ascii() && !c.is_whitespace());
                symbol(prev) && symbol(next)
            }
            '\u{200c}' => {
                let letter =
                    |c: Option<char>| c.is_some_and(|c| !c.is_ascii() && c.is_alphabetic());
                letter(prev) && letter(next)
            }
            _ => true,
        };
        if keep {
            out.push(c);
        }
    }
    if !out.contains(['\u{200e}', '\u{200f}']) {
        return out;
    }
    out.split('\n')
        .map(|line| {
            if line
                .chars()
                .all(|c| c.is_whitespace() || c == '\u{200e}' || c == '\u{200f}')
            {
                ""
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

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
    let input: String = input.chars().filter(|c| *c != LIST_MARK).collect();
    let marked = list_markers(&input, re(&LI, r"(?i)<(/?)(ul|ol|li)(?-u:\b)([^>]*)>"));
    let text = clean_invisible(&strip_html(&marked))
        // Steam escapes BBCode brackets in its HTML ("\[ MAPS ]").
        .replace("\\[", "[")
        .replace("\\]", "]");
    let mut lines: Vec<String> = Vec::new();
    let mut bullet: Option<String> = None;
    for line in text.lines() {
        // A list marker keeps its EM SPACE indent (`\s` would flatten it).
        if let Some(label) = line
            .trim_matches(|c: char| c.is_ascii_whitespace())
            .strip_prefix(LIST_MARK)
        {
            bullet = Some(format!("{label} "));
            continue;
        }
        let line = re(&SPACE, r"\s+").replace_all(line, " ");
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // "• 7f3a037" + "docs: crop…" (a commit id on its own) → one line.
        if bullet.is_none()
            && let Some(last) = lines.last_mut()
            && let Some(word) = last.strip_prefix("• ")
            && !word.contains(' ')
            && word.len() <= 12
        {
            last.push(' ');
            last.push_str(line);
            continue;
        }
        lines.push(match bullet.take() {
            Some(prefix) => format!("{prefix}{line}"),
            None => line.to_string(),
        });
    }
    lines.join("\n")
}

/// Marks a list item on its own line; the rest of the line is the item's
/// prefix (indent and label).
const LIST_MARK: char = '\u{E020}';
/// Nested lists are indented with EM SPACE (Discord trims ordinary spaces
/// and would read four of them as code).
const LIST_INDENT: char = '\u{2003}';

/// `<li>` becomes a marker line carrying its prefix: `• `, `◦ ` and `▪ ` by
/// depth for bullets, `1. `, `2. `… for ordered lists (`start` honoured),
/// indented one EM SPACE per level below the first (at most two).
fn list_markers(input: &str, tags: &Regex) -> String {
    static START: OnceLock<Regex> = OnceLock::new();
    let mut stack: Vec<Option<u64>> = Vec::new();
    let mut out = String::with_capacity(input.len() + 64);
    let mut last = 0;
    for c in tags.captures_iter(input) {
        let whole = c.get(0).expect("match");
        out.push_str(&input[last..whole.start()]);
        last = whole.end();
        let close = &c[1] == "/";
        match (close, c[2].to_ascii_lowercase().as_str()) {
            (false, "ul") => stack.push(None),
            (false, "ol") => {
                let start = re(&START, r#"(?i)(?-u:\b)start\s*=\s*["']?(\d{1,6})"#)
                    .captures(&c[3])
                    .and_then(|s| s[1].parse::<u64>().ok())
                    .unwrap_or(1);
                stack.push(Some(start.saturating_sub(1)));
            }
            (true, "ul" | "ol") => {
                stack.pop();
            }
            (false, "li") => {
                let depth = stack.len().max(1);
                let label = match stack.last_mut() {
                    Some(Some(n)) => {
                        *n += 1;
                        format!("{n}.")
                    }
                    _ => ["•", "◦", "▪"][depth.min(3) - 1].to_string(),
                };
                let indent: String = std::iter::repeat_n(LIST_INDENT, depth.min(3) - 1).collect();
                out.push_str(&format!("\n{LIST_MARK}{indent}{label}\n"));
                continue;
            }
            _ => {}
        }
        // List tags themselves are block breaks, like before.
        out.push_str(whole.as_str());
    }
    out.push_str(&input[last..]);
    out
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
        .filter(|c| !('\u{E010}'..='\u{E022}').contains(c))
        .collect();
    let input = cleaned.as_str();
    // Code keeps its lines and indent and is not escaped: each `<pre>` is
    // set aside and comes back as a fenced block.
    static PRE: OnceLock<Regex> = OnceLock::new();
    let mut code: Vec<String> = Vec::new();
    // GitHub commit messages are prose in `<pre style="white-space:pre-wrap">`;
    // they stay text.
    let input = re(&PRE, r"(?is)<pre(?-u:\b)([^>]*)>(.*?)</pre\s*>").replace_all(
        input,
        |c: &regex::Captures| {
            if c[1].to_ascii_lowercase().contains("pre-wrap") {
                return c[0].to_string();
            }
            code.push(code_text(&c[2]));
            format!("<p>{CODE_MARK}{}{CODE_MARK}</p>", code.len() - 1)
        },
    );
    // A quote's lines get `> ` once they are built.
    static QUOTE: OnceLock<Regex> = OnceLock::new();
    let input = re(
        &QUOTE,
        r"(?is)<blockquote(?-u:\b)[^>]*>(.*?)</blockquote\s*>",
    )
    .replace_all(&input, |c: &regex::Captures| {
        format!("<div>{QUOTE_OPEN}</div>{}<div>{QUOTE_CLOSE}</div>", &c[1])
    });
    let input = input.as_ref();
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
    let html = render_tables(&html);
    let text = html_to_text(&html);
    // An empty line before a heading that follows text sets sections apart.
    let mut out: Vec<String> = Vec::new();
    let mut quoted = false;
    for line in text.lines() {
        let line = if line.contains([QUOTE_OPEN, QUOTE_CLOSE]) {
            if line.contains(QUOTE_OPEN) {
                quoted = true;
            }
            if line.contains(QUOTE_CLOSE) {
                quoted = false;
            }
            let rest = line.replace([QUOTE_OPEN, QUOTE_CLOSE], "");
            if rest.trim().is_empty() {
                continue;
            }
            rest
        } else {
            line.to_string()
        };
        if let Some(block) = line
            .trim()
            .strip_prefix(CODE_MARK)
            .and_then(|l| l.strip_suffix(CODE_MARK))
            .and_then(|n| n.parse::<usize>().ok())
            .and_then(|n| code.get(n))
        {
            if !block.is_empty() {
                out.push(format!("```\n{block}\n```"));
            }
            continue;
        }
        let Some(line) = rich_line(&line) else {
            continue;
        };
        let line = if quoted { format!("> {line}") } else { line };
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

/// Tables as lines Discord can show (it has no tables; every cell was its
/// own line and bold cells became headings). Innermost tables first.
/// - one cell: its text; one column: one line (a bullet each if several);
/// - two columns without a header row: `**key**: value`;
/// - a header row over a header column (a matrix): `**row** — H1: v1 · H2: v2`;
/// - up to four short columns: `**H1 · H2**` then `v1 · v2` per row;
/// - else one bullet per row with its fields below.
fn render_tables(html: &str) -> String {
    let mut html = html.to_string();
    for _ in 0..64 {
        let lower = html.to_ascii_lowercase();
        let Some(end) = lower.find("</table") else {
            break;
        };
        let Some(start) = lower[..end].rfind("<table") else {
            break;
        };
        let close = lower[end..].find('>').map_or(html.len(), |i| end + i + 1);
        let open_end = lower[start..end].find('>').map_or(end, |i| start + i + 1);
        let inner = &html[open_end..end];
        let rendered = if layout_table(inner) {
            // Kept as before: each cell becomes its own block.
            format!("<div>{inner}</div>")
        } else {
            render_table(inner)
        };
        html.replace_range(start..close, &rendered);
    }
    html
}

/// A table used for page layout (lowcygier: a picture cell beside a text
/// cell with paragraphs), not for data: a cell holds a picture or blocks.
fn layout_table(inner: &str) -> bool {
    static MEDIA: OnceLock<Regex> = OnceLock::new();
    static CELL: OnceLock<Regex> = OnceLock::new();
    static BREAK: OnceLock<Regex> = OnceLock::new();
    if re(
        &MEDIA,
        r"(?i)<(?:img|ul|ol|blockquote|pre|figure|video|iframe)(?-u:\b)",
    )
    .is_match(inner)
    {
        return true;
    }
    // More than one paragraph or line of text in one cell (a callout box).
    let breaks = re(&BREAK, r"(?i)</?(?:p|div|br)(?-u:\b)[^>]*>");
    re(&CELL, r"(?is)<t[hd](?-u:\b)[^>]*>(.*?)(?:</t[hd]\s*>|$)")
        .captures_iter(inner)
        .any(|c| {
            breaks
                .split(&c[1])
                .filter(|part| !strip_html(part).trim().is_empty())
                .count()
                > 1
        })
}

fn render_table(inner: &str) -> String {
    static ROW: OnceLock<Regex> = OnceLock::new();
    static CELL: OnceLock<Regex> = OnceLock::new();
    static BOLD: OnceLock<Regex> = OnceLock::new();
    let row_re = re(&ROW, r"(?is)<tr(?-u:\b)[^>]*>(.*?)(?:</tr\s*>|$)");
    let cell_re = re(&CELL, r"(?is)<(th|td)(?-u:\b)[^>]*>(.*?)(?:</t[hd]\s*>|$)");
    let bold_re = re(
        &BOLD,
        r"(?is)^\s*(?:<p(?-u:\b)[^>]*>\s*)?<(?:b|strong)>.*</(?:b|strong)>\s*(?:</p>\s*)?$",
    );
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut rows: Vec<Vec<(String, bool)>> = row_re
        .captures_iter(inner)
        .map(|r| {
            cell_re
                .captures_iter(&r[1])
                .map(|c| {
                    let raw = &c[2];
                    let headed = raw.contains(HEAD_OPEN);
                    let text = strip_html(&raw.replace([HEAD_OPEN, HEAD_CLOSE], ""))
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");
                    let header = c[1].eq_ignore_ascii_case("th") || headed || bold_re.is_match(raw);
                    (text, header)
                })
                .collect()
        })
        .collect();
    rows.retain(|r| r.iter().any(|(t, _)| !t.is_empty()));
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let used: Vec<usize> = (0..width)
        .filter(|&i| {
            rows.iter()
                .any(|r| r.get(i).is_some_and(|(t, _)| !t.is_empty()))
        })
        .collect();
    let rows: Vec<Vec<(String, bool)>> = rows
        .into_iter()
        .map(|r| {
            used.iter()
                .map(|&i| r.get(i).cloned().unwrap_or_default())
                .collect()
        })
        .collect();
    let cols = used.len();
    if rows.is_empty() {
        return " ".to_string();
    }
    let b = |s: &str| format!("{AUTHOR_BOLD_MARK}{}{AUTHOR_BOLD_MARK}", esc(s));
    // A first row with a single header cell over several columns is the
    // table's title (Black Desert: "Featured Rewards" over a grid).
    let mut rows = rows;
    let mut title = None;
    if rows.len() > 1 && cols > 1 {
        let filled: Vec<&(String, bool)> = rows[0].iter().filter(|(t, _)| !t.is_empty()).collect();
        if let [(text, true)] = filled.as_slice() {
            title = Some(format!("<p>{}</p>", b(text)));
            rows.remove(0);
        }
    }
    let body = render_rows(&rows, cols, &b, &esc);
    match title {
        Some(title) => format!("{title}{body}"),
        None => body,
    }
}

/// The visible length of a cell text: a link counts as its text only.
fn visible_len(text: &str) -> usize {
    let mut n = 0;
    let mut in_url = false;
    for c in text.chars() {
        match c {
            LINK_MID => in_url = true,
            LINK_CLOSE => in_url = false,
            LINK_OPEN => {}
            _ if !in_url => n += 1,
            _ => {}
        }
    }
    n
}

fn render_rows(
    rows: &[Vec<(String, bool)>],
    cols: usize,
    b: &dyn Fn(&str) -> String,
    esc: &dyn Fn(&str) -> String,
) -> String {
    let para = |lines: Vec<String>| format!("<p>{}</p>", lines.join("<br>"));
    let list = |items: Vec<String>| {
        format!(
            "<ul>{}</ul>",
            items
                .iter()
                .map(|i| format!("<li>{i}</li>"))
                .collect::<String>()
        )
    };
    let joined = |r: &Vec<(String, bool)>| {
        r.iter()
            .map(|(t, _)| t.as_str())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    };
    if cols <= 1 {
        let lines: Vec<String> = rows.iter().map(|r| esc(&r[0].0)).collect();
        return if lines.len() > 1 {
            list(lines)
        } else {
            para(lines)
        };
    }
    // One row: its cells on one line, or one line each when long
    // (language links, a row of buttons).
    if rows.len() == 1 {
        let line = joined(&rows[0]);
        return if visible_len(&line) <= 200 {
            para(vec![esc(&line)])
        } else {
            para(
                rows[0]
                    .iter()
                    .filter(|(t, _)| !t.is_empty())
                    .map(|(t, _)| esc(t))
                    .collect(),
            )
        };
    }
    let header_row = rows[0].iter().all(|(t, h)| t.is_empty() || *h)
        && rows[0].iter().any(|(t, _)| !t.is_empty());
    let key_value = |data: &[Vec<(String, bool)>]| {
        para(
            data.iter()
                .map(|r| match (r[0].0.is_empty(), r[1].0.is_empty()) {
                    (false, false) => format!("{}: {}", b(&r[0].0), esc(&r[1].0)),
                    (true, _) => esc(&r[1].0),
                    (_, true) => esc(&r[0].0),
                })
                .collect(),
        )
    };
    if cols == 2 && !header_row {
        return key_value(rows);
    }
    let data = if header_row { &rows[1..] } else { rows };
    let heads: Vec<&str> = if header_row {
        rows[0].iter().map(|(t, _)| t.as_str()).collect()
    } else {
        Vec::new()
    };
    let field = |i: usize, v: &str| match heads.get(i).filter(|h| !h.is_empty()) {
        Some(h) => format!("{}: {}", esc(h), esc(v)),
        None => esc(v),
    };
    let matrix = header_row && heads[0].is_empty() && data.iter().all(|r| r[0].1);
    if matrix {
        return para(
            data.iter()
                .map(|r| {
                    let rest: Vec<String> = (1..cols)
                        .filter(|&i| !r[i].0.is_empty())
                        .map(|i| field(i, &r[i].0))
                        .collect();
                    format!("{} — {}", b(&r[0].0), rest.join(" · "))
                })
                .collect(),
        );
    }
    let short = cols <= 4 && rows.iter().all(|r| visible_len(&joined(r)) <= 100);
    if short {
        let mut lines = Vec::new();
        if header_row {
            lines.push(b(&joined(&rows[0])));
        }
        lines.extend(data.iter().map(|r| esc(&joined(r))));
        return para(lines);
    }
    // Two long columns under a header (Roblox "Field / Meaning").
    if cols == 2 {
        return key_value(data);
    }
    list(
        data.iter()
            .map(|r| {
                let fields: Vec<String> = (0..cols)
                    .filter(|&i| !r[i].0.is_empty())
                    .map(|i| field(i, &r[i].0))
                    .collect();
                match fields.split_first() {
                    Some((first, rest)) if !rest.is_empty() => {
                        format!("{first}{}", list(rest.to_vec()))
                    }
                    Some((first, _)) => first.clone(),
                    None => String::new(),
                }
            })
            .collect(),
    )
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
    // A nested list item's indent is not trimmed away.
    let indent: String = line.chars().take_while(|c| *c == LIST_INDENT).collect();
    let line = &line[indent.len()..];
    rich_line_body(line).map(|l| format!("{indent}{l}"))
}

fn rich_line_body(line: &str) -> Option<String> {
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
        // Spaces and brackets would end the markdown link early; encoded,
        // `Foo_(bar)` keeps its link. Junk like `https://(SWTOR.COM/…)` has
        // no host and still shows only its text.
        let encoded = c[2]
            .trim()
            .replace(' ', "%20")
            .replace('(', "%28")
            .replace(')', "%29")
            .replace('<', "%3C")
            .replace('>', "%3E");
        let url = encoded.as_str();
        let web = (url.starts_with("https://") || url.starts_with("http://"))
            && Url::parse(url).is_ok_and(|u| {
                u.host_str().is_some_and(|h| {
                    h.contains('.')
                        && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'))
                })
            });
        // Text that looks like an address shows the real one: no
        // "[https://bank.example](https://evil.example)".
        // Versions and file names ("v1.2.3", "3.0-beta", "README.md") are
        // not addresses (37 GitHub links showed the long URL), and text
        // naming the link's own host is no spoofing.
        static ADDRESS: OnceLock<Regex> = OnceLock::new();
        let address = re(
            &ADDRESS,
            r"(?i)^(?:[a-z][a-z0-9+.-]*://|www\.)|^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,24})(?:[/:]\S*)?$",
        );
        let looks_like_address = address.captures(&raw).is_some_and(|c| {
            let not_tld = [
                "md", "js", "ts", "json", "rs", "toml", "txt", "exe", "zip", "yml", "yaml", "lock",
                "sh", "py", "html", "css", "png", "jpg", "gif", "svg", "pdf", "dll", "so", "deb",
                "rpm", "tar", "gz", "xz", "msi", "apk", "jar",
            ];
            match c.get(1) {
                None => true,
                Some(tld) => !not_tld.contains(&tld.as_str().to_ascii_lowercase().as_str()),
            }
        });
        let same_host = || {
            let host = |s: &str| {
                Url::parse(&if s.contains("://") { s.to_string() } else { format!("https://{s}") })
                    .ok()
                    .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_ascii_lowercase()))
            };
            host(&raw).is_some() && host(&raw) == host(url)
        };
        if !web {
            text
        } else if raw.is_empty() || raw == url || (looks_like_address && !same_host()) {
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

/// A `<pre>` block set aside (`\u{E021}N\u{E021}`) and a quote's start and end.
const CODE_MARK: char = '\u{E021}';
const QUOTE_OPEN: char = '\u{E022}';
const QUOTE_CLOSE: char = '\u{E019}';

/// The text of a `<pre>` block for a Discord code fence: tags gone,
/// entities decoded, lines and indent kept, a ``` inside broken up, and at
/// most 1500 characters.
fn code_text(html: &str) -> String {
    static BR: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    let text = re(&BR, r"(?i)<br\s*/?>").replace_all(html, "\n");
    let text = re(&TAG, r"<[^>]*>").replace_all(&text, "");
    let text = decode_entities(&text).replace("```", "`\u{200b}``");
    let text = text.trim_matches(['\n', '\r']).trim_end();
    if text.chars().count() <= 1500 {
        return text.to_string();
    }
    let cut: String = text.chars().take(1500).collect();
    format!("{}\n…", cut.trim_end())
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
    fn code_and_quotes() {
        assert_eq!(
            html_to_rich(
                "<p>Run:</p><pre><code>fn main() {\n    let x = a*b_c;\n}</code></pre><p>done</p>"
            ),
            "Run:\n```\nfn main() {\n    let x = a*b_c;\n}\n```\ndone"
        );
        assert_eq!(
            html_to_rich("<pre>a ``` b</pre>"),
            "```\na `\u{200b}`` b\n```"
        );
        assert_eq!(
            html_to_rich("<blockquote><p>Quoted *one*</p><p>&gt; two</p></blockquote><p>after</p>"),
            "> Quoted \\*one\\*\n> \\> two\nafter"
        );
        // A GitHub commit message stays text.
        assert_eq!(
            html_to_rich(
                "<pre style='white-space:pre-wrap;width:81ex'>Fix the parser\n\nKeeps entities.</pre>"
            ),
            "Fix the parser\nKeeps entities."
        );
        // Plain text keeps the words only.
        assert_eq!(html_to_text("<blockquote><p>q</p></blockquote>"), "q");
    }

    #[test]
    fn tables_become_readable_lines() {
        let e = '\u{2003}';
        // A matrix (World of Tanks event times).
        assert_eq!(
            html_to_rich(
                "<table><tr><th></th><th>EU (CET)</th><th>NA (PT | ET)</th></tr><tr><td><b>Event Start</b></td><td>December 1 at 05:00</td><td>December 1 at 02:00 | 05:00</td></tr></table>"
            ),
            "**Event Start** — EU (CET): December 1 at 05:00 · NA (PT \\| ET): December 1 at 02:00 \\| 05:00"
        );
        // A one-cell layout box: its text, the bold no heading of its own.
        assert_eq!(
            html_to_rich(
                "<p>Before</p><table><tr><td><b>Update 02/10</b> is live</td></tr></table>"
            ),
            "Before\nUpdate 02/10 is live"
        );
        // Key and value, with an empty spacer column dropped.
        assert_eq!(
            html_to_rich(
                "<table><tr><td>Event Name</td><td></td><td>[Attendance] Support</td></tr><tr><td>Event Period</td><td></td><td>Dec 1 - Dec 8</td></tr></table>"
            ),
            "**Event Name**: [Attendance] Support\n**Event Period**: Dec 1 - Dec 8"
        );
        // Short columns with a header.
        assert_eq!(
            html_to_rich(
                "<table><tr><th>State</th><th>Icon</th><th>Meaning</th></tr><tr><td>Open</td><td>green</td><td>active</td></tr><tr><td>Closed</td><td>purple</td><td>done</td></tr></table>"
            ),
            "**State · Icon · Meaning**\nOpen · green · active\nClosed · purple · done"
        );
        // One row of links: one line; a title cell over a grid.
        assert_eq!(
            html_to_rich(
                r#"<table><tr><td><a href="https://x.example/ko">한국어</a></td><td><a href="https://x.example/de">Deutsch</a></td></tr></table>"#
            ),
            "[한국어](https://x.example/ko) · [Deutsch](https://x.example/de)"
        );
        assert_eq!(
            html_to_rich(
                "<table><tr><th>Featured Rewards</th><th></th><th></th></tr><tr><td>Box</td><td>Horn</td><td>Draught</td></tr><tr><td>Censer</td><td>Gear</td><td>Perfume</td></tr></table>"
            ),
            "**Featured Rewards**\nBox · Horn · Draught\nCenser · Gear · Perfume"
        );
        // A layout table (picture beside paragraphs) keeps its blocks.
        assert_eq!(
            html_to_rich(
                r#"<table><tr><td><img src="https://x.example/i.jpg"></td><td><p>One.</p><p>Two.</p></td></tr></table>"#
            ),
            "One.\nTwo."
        );
        // Long rows: one bullet per row, fields below.
        let long = "x".repeat(120);
        assert_eq!(
            html_to_rich(&format!(
                "<table><tr><th>Component</th><th>Version</th><th>Notes</th></tr><tr><td>IGC</td><td>2.20</td><td>{long}</td></tr></table>"
            )),
            format!("• Component: IGC\n{e}◦ Version: 2.20\n{e}◦ Notes: {long}")
        );
    }

    #[test]
    fn nested_and_ordered_lists() {
        let e = '\u{2003}';
        assert_eq!(
            html_to_text("<ul><li>A<ul><li>A1</li><li>A2</li></ul></li><li>B</li></ul>"),
            format!("• A\n{e}◦ A1\n{e}◦ A2\n• B")
        );
        assert_eq!(
            html_to_text("<ol><li>one</li><li>two<ol><li>sub</li></ol></li></ol>"),
            format!("1. one\n2. two\n{e}1. sub")
        );
        assert_eq!(
            html_to_text(r#"<ol start="5"><li>five</li></ol>"#),
            "5. five"
        );
        assert_eq!(
            html_to_text("<li><p>Fixed ledges</p></li>"),
            "• Fixed ledges"
        );
        assert_eq!(
            html_to_text(
                "<ul><li>1<ul><li>2<ul><li>3<ul><li>4</li></ul></li></ul></li></ul></li></ul>"
            ),
            format!("• 1\n{e}◦ 2\n{e}{e}▪ 3\n{e}{e}▪ 4")
        );
        // Discord: the indent stays, a number is escaped (no markdown list).
        assert_eq!(
            html_to_rich("<ol><li>one</li><li>two<ol><li>sub</li></ol></li></ol>"),
            format!("1\\. one\n2\\. two\n{e}1\\. sub")
        );
    }

    #[test]
    fn links_keep_their_target() {
        let base = Url::parse("https://github.com/yhymid/XFeeder/compare/a...b").unwrap();
        let html = r##"<a href="/yhymid/XFeeder/tree/3.0-beta">3.0-beta</a> <a href="#top">top</a> <a href="mailto:a@b.c">mail</a>"##;
        let abs = absolute_hrefs(html, &base);
        assert!(
            abs.contains(r#"href="https://github.com/yhymid/XFeeder/tree/3.0-beta""#),
            "{abs}"
        );
        assert!(abs.contains(r##"href="#top""##) && abs.contains("mailto:a@b.c"));
        assert_eq!(
            html_to_rich(&abs),
            "[3.0-beta](https://github.com/yhymid/XFeeder/tree/3.0-beta) top mail"
        );
        // Versions and file names are link text, not addresses.
        assert_eq!(
            html_to_rich(r#"<a href="https://github.com/o/r/releases/tag/v1.2.3">v1.2.3</a>"#),
            "[v1.2.3](https://github.com/o/r/releases/tag/v1.2.3)"
        );
        assert_eq!(
            html_to_rich(r#"<a href="https://github.com/o/r/blob/main/README.md">README.md</a>"#),
            "[README.md](https://github.com/o/r/blob/main/README.md)"
        );
        // Brackets and spaces are encoded instead of losing the link.
        assert_eq!(
            html_to_rich(r#"<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>"#),
            "[Foo](https://en.wikipedia.org/wiki/Foo_%28bar%29)"
        );
        assert_eq!(
            html_to_rich(r#"<a href="https://(SWTOR.COM/x)">site</a>"#),
            "site"
        );
    }

    #[test]
    fn invisible_characters_are_cleaned_but_emoji_stay_whole() {
        assert_eq!(
            html_to_text("🧑&zwj;🎨 and 🐈\u{200d}⬛"),
            "🧑\u{200d}🎨 and 🐈\u{200d}⬛"
        );
        assert_eq!(
            html_to_text("👨&#x200D;💻 dev &#x202E;txt.exe"),
            "👨\u{200d}💻 dev txt.exe"
        );
        assert_eq!(clean_invisible("a\u{200d}b c\u{200b}d\u{feff}"), "ab cd");
        assert_eq!(
            clean_invisible("می\u{200c}خواهم x\u{200c}y"),
            "می\u{200c}خواهم xy"
        );
        assert_eq!(clean_invisible("one\n\u{200e}\ntwo"), "one\n\ntwo");
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
