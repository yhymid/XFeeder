//! `xfeeder rerender`: rebuild Discord posts XFeeder already sent in the
//! current layout, by editing the messages through their webhook.
//!
//! Uses `sent.json` (filled since this version): posts sent before it
//! existed are not known and stay as they are. Never posts new messages.
//! A message deleted on Discord is reported and skipped.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::config;
use crate::deliver::{self, SendError};
use crate::js;

const HELP: &str = "\
xfeeder rerender [--channel NAME] [--hours N] [--limit N] [--apply] [--config PATH]

Rebuild posts already sent to Discord in the current layout (edits the
messages through their webhook; nothing new is posted).

  --channel NAME   only this channel (name or key, e.g. channels11#11)
  --hours N        only posts sent in the last N hours (default: all known)
  --limit N        at most N newest posts (default 50)
  --apply          really edit; without it only lists what would change
  --config PATH    config.json (default ./config.json; sent.json beside it)";

struct Args {
    channel: Option<String>,
    hours: Option<f64>,
    limit: usize,
    apply: bool,
    config: PathBuf,
}

fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let mut out = Args {
        channel: None,
        hours: None,
        limit: 50,
        apply: false,
        config: PathBuf::from("./config.json"),
    };
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--channel" => out.channel = Some(value("--channel")?),
            "--hours" => {
                out.hours = Some(
                    value("--hours")?
                        .parse::<f64>()
                        .ok()
                        .filter(|h| h.is_finite() && *h > 0.0)
                        .ok_or("--hours must be a positive number")?,
                );
            }
            "--limit" => {
                out.limit = value("--limit")?
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=2000).contains(n))
                    .ok_or("--limit must be 1..2000")?;
            }
            "--apply" => out.apply = true,
            "--config" => out.config = PathBuf::from(value("--config")?),
            other => return Err(format!("Unknown argument: {other}")),
        }
    }
    Ok(out)
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
    let config = match config::load(&args.config) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    crate::http::net().configure(&config.network, None);
    let base = config::absolute(&args.config)
        .parent()
        .map_or_else(|| PathBuf::from("."), std::path::Path::to_path_buf);
    // Read only: the running worker owns sent.json.
    let path = crate::sent::path_for(&base.join("cache.json"));
    crate::sent::init(path.clone(), false);
    let since = args
        .hours
        .map(|h| chrono::Utc::now().timestamp_millis() - (h * 3_600_000.0) as i64);
    let mut records: Vec<_> = crate::sent::all()
        .into_iter()
        .filter(|r| since.is_none_or(|s| r.sent_at >= s))
        .filter_map(|r| {
            let channel = config.channels.iter().find(|c| c.cache_key == r.channel)?;
            let wanted = args
                .channel
                .as_deref()
                .is_none_or(|n| channel.label() == n || channel.cache_key == n);
            (wanted && !channel.webhook.is_empty()).then(|| (channel.clone(), r))
        })
        .collect();
    records.reverse(); // newest first
    records.truncate(args.limit);
    if records.is_empty() {
        println!("No matching posts in {}.", path.display());
        return ExitCode::SUCCESS;
    }
    let cancel = CancellationToken::new();
    let (mut edited, mut gone, mut failed) = (0, 0, 0);
    for (channel, record) in &records {
        let title = js::to_string_or_empty(js::get(&record.entry, "title"));
        let when = chrono::DateTime::from_timestamp_millis(record.sent_at)
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default();
        if !args.apply {
            println!(
                "would edit  {when}  {}  {}",
                channel.label(),
                js::prefix16(&title, 80)
            );
            continue;
        }
        let entry: Value = record.entry.clone();
        match deliver::edit_webhook(
            &channel.webhook,
            channel.thread.as_deref(),
            &record.message_id,
            &entry,
            channel
                .ping
                .as_ref()
                .and_then(|p| p.mention(&entry, &record.source))
                .as_ref(),
            &cancel,
        )
        .await
        {
            Ok(()) => {
                edited += 1;
                println!(
                    "edited      {when}  {}  {}",
                    channel.label(),
                    js::prefix16(&title, 80)
                );
            }
            Err(SendError::Gone) => {
                gone += 1;
                println!(
                    "deleted     {when}  {}  {}",
                    channel.label(),
                    js::prefix16(&title, 80)
                );
            }
            Err(SendError::Cancelled) => break,
            Err(_) => failed += 1,
        }
        // Webhook edits share the channel's rate limit with new posts.
        tokio::time::sleep(Duration::from_millis(1200)).await;
    }
    if args.apply {
        println!("{edited} edited, {gone} deleted on Discord, {failed} failed.");
    } else {
        println!(
            "{} post(s); run again with --apply to edit them.",
            records.len()
        );
    }
    if failed > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
