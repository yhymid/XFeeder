//! `xfeeder preview`: what XFeeder reads from a feed and how long each stage
//! takes, without sending or saving anything.
//!
//! ```text
//! xfeeder preview <URL>... [--profile NAME|FILE] [--items N] [--bench N]
//!                 [--config PATH] [--json]
//! ```
//!
//! The feed goes through the same path as the worker (HTTP client, Scrapling
//! and solver from `config.json`, parsers, `parsers::finish`, the image check
//! before sending). Delivery history is never read or written: every run is a
//! full download, as for a feed seen for the first time.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::config;
use crate::feed::{Circuit, Pipeline};
use crate::js::{self, get};
use crate::state::StateStore;

pub const HELP: &str = "Usage: xfeeder preview <URL>... [options]

Shows what XFeeder reads from each feed (title, author, date, image, link,
text) and how long download, parsing and the image check take. Nothing is
sent and no history is read or written.

Options:
  --profile NAME   Feeds of a profile: profiles/NAME.json (news, games, dev)
                   or a path to a profile file.
  --items N        Entries shown per feed (default 3, 0 = timings only).
  --bench N        Fetch every feed N times and print min/median/p95/max.
  --config PATH    config.json for Scrapling, solver, proxy and network
                   settings (default ./config.json when it exists).
  --json           Print one JSON object per feed instead of text.";

struct Args {
    urls: Vec<String>,
    items: usize,
    bench: usize,
    config: Option<PathBuf>,
    json: bool,
}

fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let mut out = Args {
        urls: Vec::new(),
        items: 3,
        bench: 1,
        config: None,
        json: false,
    };
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| iter.next().ok_or(format!("{name} requires a value"));
        match arg.as_str() {
            "--items" => out.items = value("--items")?.parse().map_err(|_| "--items: number")?,
            "--bench" => {
                out.bench = value("--bench")?.parse().map_err(|_| "--bench: number")?;
                if !(1..=100).contains(&out.bench) {
                    return Err("--bench: 1 to 100".into());
                }
            }
            "--config" => out.config = Some(PathBuf::from(value("--config")?)),
            "--profile" => out.urls.extend(profile_urls(&value("--profile")?)?),
            "--json" => out.json = true,
            url if url.starts_with("http://") || url.starts_with("https://") => {
                out.urls.push(url.to_string());
            }
            other => return Err(format!("Unknown argument: {other}")),
        }
    }
    if out.urls.is_empty() {
        return Err("Give at least one feed URL or --profile".into());
    }
    Ok(out)
}

/// Feed URLs of a profile file (`{"feeds": [{"url": …}, …]}`).
pub fn profile_urls(name: &str) -> Result<Vec<String>, String> {
    let path = profile_path(name);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read profile {}: {e}", path.display()))?;
    let profile: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid profile {}: {e}", path.display()))?;
    let urls: Vec<String> = get(&profile, "feeds")
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| get(f, "url").as_str().map(str::to_string))
        .collect();
    if urls.is_empty() {
        return Err(format!("Profile {} has no feeds", path.display()));
    }
    Ok(urls)
}

fn profile_path(name: &str) -> PathBuf {
    let direct = PathBuf::from(name);
    if direct.extension().is_some() || name.contains('/') {
        return direct;
    }
    PathBuf::from("profiles").join(format!("{name}.json"))
}

fn load_config(path: Option<&Path>) -> Result<(config::Config, PathBuf), String> {
    let path = path.map_or_else(|| PathBuf::from("./config.json"), Path::to_path_buf);
    if path.exists() {
        return Ok((config::load(&path)?, path));
    }
    let empty = config::from_value(&json!({}), &config::Env::new())?;
    Ok((empty, path))
}

/// Per-stage timings of one fetch, from the events the pipeline emits.
#[derive(Clone, Default)]
struct Timing {
    total_ms: u64,
    http_ms: u64,
    ttfb_ms: Option<u64>,
    bytes: u64,
    requests: usize,
    parse_ms: Option<u64>,
    parser: String,
    scrapling: bool,
    image_ms: u64,
    image_checks: usize,
}

struct Run {
    timing: Timing,
    items: Vec<Value>,
    image_status: Vec<Option<u16>>,
    failure: Option<String>,
}

async fn fetch_once(
    pipeline: &Pipeline<'_>,
    url: &str,
    items_shown: usize,
    cancel: &CancellationToken,
) -> Result<Run, String> {
    crate::diag::capture_start();
    let started = Instant::now();
    let outcome = pipeline.fetch(url).await.map_err(|e| format!("{e:?}"))?;
    let fetched_ms = started.elapsed().as_millis() as u64;
    let events = crate::diag::capture_take();
    let mut timing = Timing {
        total_ms: fetched_ms,
        ..Timing::default()
    };
    for (event, details) in &events {
        match event.as_str() {
            "http.timing" => {
                timing.requests += 1;
                timing.http_ms += get(details, "totalMs").as_u64().unwrap_or(0);
                timing.bytes += get(details, "bytes").as_u64().unwrap_or(0);
                if timing.ttfb_ms.is_none() {
                    timing.ttfb_ms = get(details, "ttfbMs").as_u64();
                }
            }
            "feed.parsed" => {
                timing.parse_ms = get(details, "parseMs").as_u64();
                timing.parser = js::to_string(get(details, "parser"));
            }
            e if e.starts_with("scrapling.") => timing.scrapling = true,
            _ => {}
        }
    }
    let source = outcome.source.as_deref().unwrap_or(url);
    let items = crate::parsers::finish(source, outcome.items);
    let mut shown = Vec::new();
    let mut image_status = Vec::new();
    let image_started = Instant::now();
    for item in items.iter().take(items_shown.max(1)) {
        let (checked, status) = crate::deliver::working_image(item, cancel).await;
        if status.is_some() {
            timing.image_checks += 1;
        }
        image_status.push(status);
        shown.push(checked);
    }
    timing.image_ms = image_started.elapsed().as_millis() as u64;
    timing.total_ms += timing.image_ms;
    let mut all = shown;
    all.extend(items.into_iter().skip(items_shown.max(1)));
    Ok(Run {
        timing,
        items: all,
        image_status,
        failure: outcome.failure,
    })
}

fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

fn stats(values: &[u64]) -> Value {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    json!({
        "min": sorted.first().copied().unwrap_or(0),
        "median": percentile(&sorted, 0.5),
        "p95": percentile(&sorted, 0.95),
        "max": sorted.last().copied().unwrap_or(0),
    })
}

fn n(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0)
}

fn line(label: &str, value: &Value) -> String {
    let text = js::to_string(value);
    if value.is_null() || text.is_empty() {
        format!("    {label:<8} —")
    } else {
        format!("    {label:<8} {text}")
    }
}

/// Things worth knowing before adding the feed to a channel.
fn hints(items: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    let count = |field: &str| items.iter().filter(|i| js::truthy(get(i, field))).count();
    let n = items.len();
    if n == 0 {
        return vec!["no entries".into()];
    }
    for (field, what) in [
        ("isoDate", "date"),
        ("enclosure", "image"),
        ("author", "author"),
        ("contentSnippet", "text"),
    ] {
        let have = count(field);
        if have < n {
            out.push(format!("{what}: {have}/{n} entries"));
        }
    }
    let upgraded = count("imageFallback");
    if upgraded > 0 {
        out.push(format!("larger image used for {upgraded}/{n} entries"));
    }
    let fixed = count("sourceLink");
    if fixed > 0 {
        out.push(format!(
            "relative link made absolute for {fixed}/{n} entries"
        ));
    }
    out
}

fn print_text(url: &str, runs: &[Run], items_shown: usize) {
    let first = &runs[0];
    let t = &first.timing;
    println!("━━ {}", crate::diag::sanitize_url(url));
    println!(
        "  {} entries · parser {} · {} request(s), {} KB{}",
        first.items.len(),
        if t.parser.is_empty() {
            "—"
        } else {
            &t.parser
        },
        t.requests,
        t.bytes / 1024,
        if t.scrapling { " · Scrapling" } else { "" }
    );
    if let Some(failure) = &first.failure {
        println!("  ✗ {failure}");
    }
    if runs.len() == 1 {
        println!(
            "  time: total {} ms = download {} ms (first byte {} ms) + parse {} ms + image check {} ms ({}×)",
            t.total_ms,
            t.http_ms,
            t.ttfb_ms.map_or("—".into(), |v| v.to_string()),
            t.parse_ms.map_or("—".into(), |v| v.to_string()),
            t.image_ms,
            t.image_checks
        );
    } else {
        let col = |f: fn(&Timing) -> u64| {
            let s = stats(&runs.iter().map(|r| f(&r.timing)).collect::<Vec<_>>());
            format!(
                "{:>6} {:>6} {:>6} {:>6}",
                n(&s["min"]),
                n(&s["median"]),
                n(&s["p95"]),
                n(&s["max"])
            )
        };
        println!(
            "  bench ×{} (ms)       min median    p95    max",
            runs.len()
        );
        println!("    total          {}", col(|t| t.total_ms));
        println!("    download       {}", col(|t| t.http_ms));
        println!("    first byte     {}", col(|t| t.ttfb_ms.unwrap_or(0)));
        println!("    parse          {}", col(|t| t.parse_ms.unwrap_or(0)));
        println!("    image check    {}", col(|t| t.image_ms));
    }
    for hint in hints(&first.items) {
        println!("  · {hint}");
    }
    for (index, item) in first.items.iter().take(items_shown).enumerate() {
        println!("  [{}] {}", index + 1, js::to_string(get(item, "title")));
        println!("{}", line("author", get(item, "author")));
        println!("{}", line("date", get(item, "isoDate")));
        let image = match (
            get(item, "enclosure").as_str(),
            first.image_status.get(index),
        ) {
            (Some(url), Some(Some(status))) if (200..300).contains(status) => {
                json!(format!("{url}  (larger version OK)"))
            }
            (Some(url), Some(Some(status))) => {
                json!(format!(
                    "{url}  (larger version missing: {status}, using feed image)"
                ))
            }
            (Some(url), _) => json!(url),
            (None, _) => Value::Null,
        };
        println!("{}", line("image", &image));
        println!("{}", line("link", get(item, "link")));
        let text = js::to_string(get(item, "contentSnippet"));
        let text: String = text.replace('\n', " ⏎ ").chars().take(240).collect();
        println!("{}", line("text", &json!(text)));
    }
    println!();
}

fn print_json(url: &str, runs: &[Run], items_shown: usize) {
    let first = &runs[0];
    let col = |f: fn(&Timing) -> u64| stats(&runs.iter().map(|r| f(&r.timing)).collect::<Vec<_>>());
    let out = json!({
        "url": crate::diag::sanitize_url(url),
        "entries": first.items.len(),
        "parser": first.timing.parser,
        "scrapling": first.timing.scrapling,
        "requests": first.timing.requests,
        "bytes": first.timing.bytes,
        "failure": first.failure,
        "runs": runs.len(),
        "ms": {
            "total": col(|t| t.total_ms),
            "download": col(|t| t.http_ms),
            "firstByte": col(|t| t.ttfb_ms.unwrap_or(0)),
            "parse": col(|t| t.parse_ms.unwrap_or(0)),
            "imageCheck": col(|t| t.image_ms),
        },
        "hints": hints(&first.items),
        "items": first.items.iter().take(items_shown).collect::<Vec<_>>(),
    });
    println!("{out}");
}

pub async fn run(args: Vec<String>) -> ExitCode {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}\n\n{HELP}");
            return ExitCode::from(2);
        }
    };
    let (config, config_path) = match load_config(args.config.as_deref()) {
        Ok(loaded) => loaded,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let proxy = (js::path(&config.root, &["Proxy", "Enabled"]) == &Value::Bool(true))
        .then(|| {
            js::to_string_or_empty(js::path(&config.root, &["Proxy", "Url"]))
                .trim()
                .to_string()
        })
        .filter(|p| !p.is_empty());
    crate::http::net().configure(&config.network, proxy);
    crate::diag::set_verbose(false);
    // An empty, never-saved history: each fetch is a full first download.
    let scratch = std::env::temp_dir().join(format!("xfeeder-preview-{}", std::process::id()));
    let state = match StateStore::open(&scratch.join("cache.json"), false) {
        Ok(state) => state,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let base = config::absolute(&config_path)
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    let cancel = CancellationToken::new();
    let mut failed = false;
    for url in &args.urls {
        let mut runs = Vec::new();
        for _ in 0..args.bench {
            // A fresh circuit per run: a failure must not pause the next one.
            let circuit = Circuit::new();
            let pipeline = Pipeline {
                config: &config,
                state: &state,
                circuit: &circuit,
                base: &base,
                cancel: &cancel,
            };
            match fetch_once(&pipeline, url, args.items, &cancel).await {
                Ok(run) => runs.push(run),
                Err(error) => {
                    eprintln!("{}: {error}", crate::diag::sanitize_url(url));
                    break;
                }
            }
        }
        if runs.is_empty() {
            failed = true;
            continue;
        }
        failed |= runs[0].items.is_empty() || runs[0].failure.is_some();
        if args.json {
            print_json(url, &runs, args.items);
        } else {
            print_text(url, &runs, args.items);
        }
    }
    crate::http::net().begin_shutdown();
    crate::scrapling::close().await;
    let _ = std::fs::remove_dir_all(&scratch);
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_and_hints() {
        let s = stats(&[5, 1, 3, 2, 4]);
        assert_eq!(
            (s["min"].as_u64(), s["median"].as_u64(), s["max"].as_u64()),
            (Some(1), Some(3), Some(5))
        );
        let items = vec![
            json!({ "title": "a", "isoDate": "x", "enclosure": "https://i", "imageFallback": "https://s" }),
            json!({ "title": "b", "isoDate": "x" }),
        ];
        let h = hints(&items);
        assert!(h.contains(&"image: 1/2 entries".to_string()));
        assert!(h.contains(&"author: 0/2 entries".to_string()));
        assert!(h.contains(&"larger image used for 1/2 entries".to_string()));
    }

    #[test]
    fn arguments() {
        let a = parse_args(vec![
            "https://a/feed".into(),
            "--bench".into(),
            "5".into(),
            "--items".into(),
            "0".into(),
        ])
        .unwrap();
        assert_eq!((a.urls.len(), a.bench, a.items), (1, 5, 0));
        assert!(parse_args(vec![]).is_err());
        assert!(parse_args(vec!["https://a".into(), "--bench".into(), "0".into()]).is_err());
    }
}
