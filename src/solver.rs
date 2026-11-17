//! Optional challenge-solver backend speaking the FlareSolverr `/v1` API
//! (FlareSolverr, Byparr, TRAWL and other compatible services).
//!
//! ```json
//! "Solver": {
//!   "Enabled": true,
//!   "Url": "http://127.0.0.1:8191",
//!   "Feeds": ["https://example.com/feed"],
//!   "Auto": true,
//!   "OnStatus": [403, 503],
//!   "MaxTimeoutMs": 60000
//! }
//! ```
//!
//! `Feeds` are always fetched through the solver; with `Auto` any other feed
//! is retried through it when the direct request ends with a status from
//! `OnStatus` or with a challenge page. The page the solver returns is used
//! directly: replaying its cookies from a different HTTP client usually gets
//! challenged again (different TLS fingerprint).

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::js;

pub struct SolverConfig {
    url: String,
    feeds: Vec<String>,
    auto: bool,
    on_status: Vec<u16>,
    max_timeout_ms: u64,
}

pub struct Solved {
    pub status: u16,
    pub headers: Map<String, Value>,
    pub body: String,
}

impl SolverConfig {
    pub fn from_root(root: &Value) -> Option<Self> {
        let raw = js::get(root, "Solver");
        if !raw.is_object() || js::get(raw, "Enabled") == &Value::Bool(false) {
            return None;
        }
        let url = js::trimmed_str(js::get(raw, "Url"))?
            .trim_end_matches('/')
            .to_string();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return None;
        }
        let feeds = match js::get(raw, "Feeds") {
            Value::Array(items) => items
                .iter()
                .filter_map(js::trimmed_str)
                .map(str::to_string)
                .collect(),
            Value::String(one) if !one.trim().is_empty() => vec![one.trim().to_string()],
            _ => Vec::new(),
        };
        let on_status = match js::get(raw, "OnStatus") {
            Value::Array(items) => items
                .iter()
                .filter_map(Value::as_u64)
                .filter_map(|s| u16::try_from(s).ok())
                .collect(),
            _ => vec![403, 503],
        };
        let max_timeout_ms = js::get(raw, "MaxTimeoutMs")
            .as_u64()
            .filter(|ms| *ms > 0)
            .unwrap_or(60_000)
            .clamp(5_000, 300_000);
        Some(Self {
            url,
            feeds,
            auto: js::get(raw, "Auto") == &Value::Bool(true),
            on_status,
            max_timeout_ms,
        })
    }

    pub fn forced(&self, url: &str) -> bool {
        self.feeds.iter().any(|f| f == url)
    }

    /// Whether a failed direct download should be retried via the solver.
    pub fn retry(&self, status: Option<u16>, challenge: bool) -> bool {
        self.auto && (challenge || status.is_some_and(|s| self.on_status.contains(&s)))
    }

    pub async fn fetch(&self, url: &str, cancel: &CancellationToken) -> Result<Solved, String> {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        let client = CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("solver client")
        });
        let request = client
            .post(format!("{}/v1", self.url))
            .timeout(Duration::from_millis(self.max_timeout_ms + 15_000))
            .json(&json!({ "cmd": "request.get", "url": url, "maxTimeout": self.max_timeout_ms }))
            .send();
        let response = tokio::select! {
            r = request => r.map_err(|e| format!("solver request failed: {}", e.without_url()))?,
            () = cancel.cancelled() => return Err("cancelled".into()),
        };
        let code = response.status().as_u16();
        let data: Value = tokio::select! {
            r = response.json() => r.map_err(|e| format!("solver returned invalid JSON (HTTP {code}): {}", e.without_url()))?,
            () = cancel.cancelled() => return Err("cancelled".into()),
        };
        parse_answer(&data, code)
    }
}

fn parse_answer(data: &Value, code: u16) -> Result<Solved, String> {
    let solution = js::get(data, "solution");
    let Some(body) = js::get(solution, "response").as_str() else {
        let message = js::trimmed_str(js::get(data, "message"))
            .or_else(|| js::trimmed_str(js::get(data, "error")))
            .unwrap_or("no solution");
        return Err(format!("solver: {message} (HTTP {code})"));
    };
    let status = js::get(solution, "status")
        .as_u64()
        .and_then(|s| u16::try_from(s).ok())
        .unwrap_or(200);
    let headers = js::get(solution, "headers")
        .as_object()
        .map(|h| {
            h.iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    Ok(Solved {
        status,
        headers,
        body: unwrap_browser_body(body),
    })
}

/// Browsers serialise XML and JSON documents inside viewer markup: Chromium
/// keeps the original XML in `#webkit-xml-viewer-source-xml` and shows text
/// (JSON, plain XML) in a `<pre>`. Recover the original document.
pub fn unwrap_browser_body(body: &str) -> String {
    const MARKER: &str = "id=\"webkit-xml-viewer-source-xml\"";
    if let Some(at) = body.find(MARKER)
        && let Some(open_end) = body[at..].find('>')
    {
        let inner = body[at + open_end + 1..].trim_start();
        // Cut at the closing tag of the document's root element; the viewer
        // adds its own markup after the source div.
        let root: String = inner
            .strip_prefix('<')
            .unwrap_or("")
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != '>' && *c != '/')
            .collect();
        if !root.is_empty()
            && let Some(end) = inner.rfind(&format!("</{root}>"))
        {
            return inner[..end + root.len() + 3].to_string();
        }
    }
    let trimmed = body.trim();
    let lower = trimmed
        .get(..trimmed.len().min(400))
        .unwrap_or("")
        .to_ascii_lowercase();
    if lower.starts_with("<html")
        && let Some(start) = trimmed.find("<pre")
        && let Some(open_end) = trimmed[start..].find('>')
        && let Some(end) = trimmed.rfind("</pre>")
    {
        let content = &trimmed[start + open_end + 1..end];
        // Only a page that is nothing but the <pre> (a viewer), not an
        // article that happens to contain a code block.
        let outside = trimmed[..start].to_ascii_lowercase();
        if !outside.contains("<p") && !outside.contains("<div") && !outside.contains("<article") {
            let text = html_unescape(content);
            let head = text.trim_start();
            if head.starts_with('<') || head.starts_with('{') || head.starts_with('[') {
                return text;
            }
        }
    }
    body.to_string()
}

fn html_unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_parsing() {
        assert!(SolverConfig::from_root(&json!({})).is_none());
        assert!(SolverConfig::from_root(&json!({ "Solver": { "Url": "ftp://x" } })).is_none());
        assert!(
            SolverConfig::from_root(&json!({ "Solver": { "Enabled": false, "Url": "http://s" } }))
                .is_none()
        );
        let cfg = SolverConfig::from_root(&json!({ "Solver": {
            "Url": "http://127.0.0.1:8191/", "Feeds": ["https://a/f"], "Auto": true
        }}))
        .unwrap();
        assert_eq!(cfg.url, "http://127.0.0.1:8191");
        assert!(cfg.forced("https://a/f") && !cfg.forced("https://b/f"));
        assert!(
            cfg.retry(Some(403), false) && cfg.retry(None, true) && !cfg.retry(Some(404), false)
        );
        let manual = SolverConfig::from_root(&json!({ "Solver": { "Url": "http://s" } })).unwrap();
        assert!(!manual.retry(Some(403), true));
    }

    #[test]
    fn answers() {
        let ok = parse_answer(
            &json!({ "status": "ok", "solution": { "status": 200, "headers": { "Content-Type": "text/xml" }, "response": "<rss/>" } }),
            200,
        )
        .unwrap();
        assert_eq!((ok.status, ok.body.as_str()), (200, "<rss/>"));
        assert_eq!(ok.headers["content-type"], json!("text/xml"));
        let err = parse_answer(
            &json!({ "status": "error", "message": "Error solving the challenge." }),
            500,
        );
        assert!(err.err().unwrap().contains("Error solving"));
    }

    #[test]
    fn browser_viewers() {
        let chromium = r#"<html><head><style>x</style></head><body><div id="webkit-xml-viewer-source-xml"><rss version="2.0"><channel><item><title>A</title></item></channel></rss></div><div class="pretty-print"></div></body></html>"#;
        let out = unwrap_browser_body(chromium);
        assert!(out.starts_with("<rss") && out.ends_with("</rss>"), "{out}");
        let json_view = r#"<html><head><meta name="color-scheme" content="light dark"></head><body><pre style="word-wrap: break-word;">{"items":[{"title":"a &amp; b"}]}</pre></body></html>"#;
        assert_eq!(
            unwrap_browser_body(json_view),
            r#"{"items":[{"title":"a & b"}]}"#
        );
        let article = "<html><body><div><p>Text</p><pre>&lt;code&gt;</pre></div></body></html>";
        assert_eq!(unwrap_browser_body(article), article);
        assert_eq!(unwrap_browser_body("<rss/>"), "<rss/>");
    }
}
