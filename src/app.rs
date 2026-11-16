//! Worker: channel runner, round-robin scheduler (sequential or bounded
//! concurrent), config hot reload, graceful shutdown.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::config::{self, Channel, Config};
use crate::deliver::{self, SendError};
use crate::diag::{expert, sanitize_text, sanitize_url};
use crate::feed::{Circuit, Pipeline, Stop};
use crate::http::net;
use crate::state::{StateStore, push_cache};
use crate::text::entry_identity;

const SEND_DELAY: Duration = Duration::from_millis(500);
const CACHE_LIMIT: usize = 2000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Target {
    Webhook,
    Telegram,
}

impl Target {
    fn kind(self) -> &'static str {
        match self {
            Self::Webhook => "webhook",
            Self::Telegram => "telegram",
        }
    }
}

struct Targets {
    webhook: String,
    thread: Option<String>,
    telegram: Option<config::Telegram>,
}

impl Targets {
    fn list(&self) -> Vec<Target> {
        let mut out = Vec::new();
        if !self.webhook.trim().is_empty() {
            out.push(Target::Webhook);
        }
        if self
            .telegram
            .as_ref()
            .is_some_and(config::Telegram::is_target)
        {
            out.push(Target::Telegram);
        }
        out
    }
}

pub struct App {
    pub config_path: PathBuf,
    pub base: PathBuf,
    pub dry_run: bool,
    pub state: StateStore,
    circuit: Circuit,
    config: RwLock<Arc<Config>>,
    pub cancel: CancellationToken,
    /// Soft stop: no new channel runs; running ones get the grace period.
    pub stop: CancellationToken,
    stopping: AtomicBool,
    debug_expert: bool,
    /// Live delivery-cache bucket key per channel (current or 2.x legacy).
    bucket_keys: Mutex<HashMap<String, String>>,
}

pub struct ChannelResult {
    pub failure: Option<String>,
}

impl App {
    pub fn new(
        config_path: &Path,
        cache_path: &Path,
        dry_run: bool,
        debug_expert: bool,
    ) -> Result<Arc<Self>, String> {
        let config = config::load(config_path)?;
        let state = StateStore::open(cache_path, !dry_run).map_err(|e| e.to_string())?;
        let base = config::absolute(config_path)
            .parent()
            .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
        let app = Arc::new(Self {
            config_path: config_path.to_path_buf(),
            base,
            dry_run,
            state,
            circuit: Circuit::new(),
            config: RwLock::new(Arc::new(config)),
            cancel: CancellationToken::new(),
            stop: CancellationToken::new(),
            stopping: AtomicBool::new(false),
            debug_expert,
            bucket_keys: Mutex::new(HashMap::new()),
        });
        let current = app.config();
        app.apply(&current, false);
        Ok(app)
    }

    pub fn config(&self) -> Arc<Config> {
        self.config.read().expect("lock").clone()
    }

    fn apply(&self, config: &Config, quiet: bool) {
        let proxy = (crate::js::path(&config.root, &["Proxy", "Enabled"]) == &Value::Bool(true))
            .then(|| {
                crate::js::to_string_or_empty(crate::js::path(&config.root, &["Proxy", "Url"]))
                    .trim()
                    .to_string()
            })
            .filter(|p| !p.is_empty());
        net().configure(&config.network, proxy);
        crate::diag::set_expert(self.debug_expert || config.debug_expert());
        crate::diag::set_verbose(config.logs() || self.debug_expert);
        if quiet {
            return;
        }
        crate::info!("App", "Channels to process: {}", config.channels.len());
        for warning in config::unsupported_sections(&config.root, &config.channels)
            .into_iter()
            .chain(config::validate_channels(&config.channels))
        {
            crate::warn!("Config", "{}", sanitize_text(&warning));
        }
        for channel in &config.channels {
            let targets: Vec<&str> = [
                channel.has_webhook().then_some("webhook"),
                channel.discord.is_some().then_some("discord-source"),
                channel.has_telegram().then_some("telegram"),
            ]
            .into_iter()
            .flatten()
            .collect();
            crate::info!(
                "App",
                "Channel configured: {} feeds={} targets={} interval={}m burst={} cacheKey={}",
                channel.label(),
                channel.feeds.len(),
                if targets.is_empty() {
                    "none".to_string()
                } else {
                    targets.join("+")
                },
                channel.time_checker,
                channel.request_send,
                channel.cache_key
            );
        }
    }

    /// Reload config from disk when its resolved content changed.
    pub fn refresh(&self, quiet: bool) -> bool {
        match config::load(&self.config_path) {
            Ok(next) => {
                if next.digest == self.config().digest {
                    return false;
                }
                self.apply(&next, quiet);
                expert(
                    "config.loaded",
                    json!({ "channelCount": next.channels.len() }),
                );
                *self.config.write().expect("lock") = Arc::new(next);
                true
            }
            Err(error) => {
                crate::error!("App", "Configuration reload failed: {error}");
                false
            }
        }
    }

    pub fn stopping(&self) -> bool {
        self.stopping.load(Ordering::Relaxed)
    }

    pub fn begin_stop(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        self.stop.cancel();
    }

    fn bucket_key(&self, channel: &Channel) -> String {
        let mut keys = self.bucket_keys.lock().expect("lock");
        if let Some(key) = keys.get(&channel.cache_key) {
            return key.clone();
        }
        let key = self.state.delivery.read(|cache| {
            if cache.contains_key(&channel.cache_key) {
                return channel.cache_key.clone();
            }
            match &channel.legacy_cache_key {
                Some(legacy) if cache.contains_key(legacy) => {
                    crate::info!(
                        "Cache",
                        "{}: using delivery history recorded by XFeeder 2.x ({legacy})",
                        channel.label()
                    );
                    legacy.clone()
                }
                _ => channel.cache_key.clone(),
            }
        });
        keys.insert(channel.cache_key.clone(), key.clone());
        key
    }

    fn pending(
        cache: &mut Map<String, Value>,
        source: &str,
        identity: &str,
        targets: &[Target],
    ) -> Vec<Target> {
        // Migrate a legacy single bucket (pre target-split) on first use.
        if let Some(Value::Array(legacy)) = cache.get(source).cloned()
            && !legacy.is_empty()
        {
            for target in targets {
                let name = format!("{source}::{}", target.kind());
                if cache
                    .get(&name)
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty)
                {
                    cache.insert(name, Value::Array(push_cache(&[], &legacy, CACHE_LIMIT)));
                }
            }
        }
        targets
            .iter()
            .copied()
            .filter(|target| {
                let name = format!("{source}::{}", target.kind());
                let bucket = cache
                    .entry(name)
                    .or_insert_with(|| Value::Array(Vec::new()));
                if !bucket.is_array() {
                    *bucket = Value::Array(Vec::new());
                }
                identity.is_empty()
                    || !bucket
                        .as_array()
                        .expect("array")
                        .iter()
                        .any(|v| v.as_str() == Some(identity))
            })
            .collect()
    }

    async fn sleep(&self, duration: Duration) -> Result<(), Stop> {
        tokio::select! {
            () = tokio::time::sleep(duration) => Ok(()),
            () = self.cancel.cancelled() => Err(Stop::Cancelled),
        }
    }

    async fn deliver(
        &self,
        label: &str,
        source: &str,
        target: Target,
        targets: &Targets,
        entry: &Value,
    ) -> Result<bool, Stop> {
        if self.cancel.is_cancelled() {
            return Err(Stop::Cancelled);
        }
        let started = Instant::now();
        let title = crate::js::to_string(crate::js::or(&[
            crate::js::get(entry, "title"),
            crate::js::get(entry, "link"),
            crate::js::get(entry, "guid"),
            &json!("unknown"),
        ]));
        expert(
            "delivery.begin",
            json!({ "channel": label, "source": source, "target": target.kind(), "dryRun": self.dry_run }),
        );
        if self.dry_run {
            println!(
                "[Dry Run] {label}: {} -> {}: {}",
                sanitize_url(source),
                target.kind(),
                sanitize_text(&title)
            );
            expert(
                "delivery.simulated",
                json!({ "channel": label, "target": target.kind(), "dryRun": true }),
            );
            return Ok(true);
        }
        let result = match target {
            Target::Webhook => {
                deliver::send_webhook(
                    &targets.webhook,
                    targets.thread.as_deref(),
                    entry,
                    &self.cancel,
                )
                .await
            }
            Target::Telegram => match &targets.telegram {
                Some(tg) => deliver::send_telegram(tg, entry, &self.cancel).await,
                None => Ok(()),
            },
        };
        match result {
            Ok(()) => {
                expert(
                    "delivery.complete",
                    json!({ "channel": label, "target": target.kind(), "durationMs": started.elapsed().as_millis() as u64 }),
                );
                Ok(true)
            }
            Err(SendError::Cancelled) => Err(Stop::Cancelled),
            Err(SendError::Failed(message)) => {
                crate::error!(
                    "Channel",
                    "{label} send failed ({} -> {}): {}: {}",
                    sanitize_url(source),
                    target.kind(),
                    sanitize_text(&title),
                    sanitize_text(&message)
                );
                expert(
                    "delivery.failed",
                    json!({ "channel": label, "target": target.kind(), "durationMs": started.elapsed().as_millis() as u64, "error": { "message": message } }),
                );
                Ok(false)
            }
        }
    }

    /// Deliver up to `RequestSend` pending entries of one source, oldest
    /// first; every confirmed delivery is persisted before the next one.
    async fn process(
        &self,
        channel: &Channel,
        cache: &mut Map<String, Value>,
        source: &str,
        entries: Vec<Value>,
        targets: &Targets,
        discord: bool,
    ) -> Result<bool, Stop> {
        let kinds = targets.list();
        let label = channel.label();
        let bucket_key = self.bucket_key(channel);
        let identified: Vec<(String, Value)> = entries
            .into_iter()
            .map(|e| (entry_identity(&e, discord), e))
            .collect();
        let pending: Vec<&(String, Value)> = identified
            .iter()
            .filter(|(id, _)| !Self::pending(cache, source, id, &kinds).is_empty())
            .collect();
        expert(
            "channel.feed.pending",
            json!({ "channel": label, "url": source, "fetched": identified.len(), "pending": pending.len() }),
        );
        if pending.is_empty() {
            return Ok(false);
        }
        let selected: Vec<&(String, Value)> =
            pending.into_iter().take(channel.request_send).collect();
        let mut failed = false;
        for (identity, entry) in selected.iter().rev() {
            for target in Self::pending(cache, source, identity, &kinds) {
                let delivered = self.deliver(&label, source, target, targets, entry).await;
                if !self.dry_run {
                    // Pace provider requests even after a failure.
                    let pause = self.sleep(SEND_DELAY).await;
                    if delivered.is_ok() {
                        pause?;
                    }
                }
                match delivered? {
                    true if !identity.is_empty() => {
                        let name = format!("{source}::{}", target.kind());
                        let existing = cache
                            .get(&name)
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        if !existing.iter().any(|v| v.as_str() == Some(identity)) {
                            cache.insert(
                                name,
                                Value::Array(push_cache(
                                    &existing,
                                    &[json!(identity)],
                                    CACHE_LIMIT,
                                )),
                            );
                            if !self.dry_run {
                                self.state.delivery.with(|root| {
                                    root.insert(bucket_key.clone(), Value::Object(cache.clone()));
                                })?;
                                let started = Instant::now();
                                self.state.delivery.save().await?;
                                let elapsed = started.elapsed().as_millis() as u64;
                                if elapsed >= 1000 {
                                    crate::warn!(
                                        "Delivery cache",
                                        "Delivery cache write was slow ({elapsed}ms)"
                                    );
                                }
                            }
                        }
                    }
                    true => {}
                    false => failed = true,
                }
            }
        }
        let total = kinds.len();
        let mut completed = 0;
        let mut partial = 0;
        for (identity, _) in &selected {
            if identity.is_empty() {
                continue;
            }
            let left = Self::pending(cache, source, identity, &kinds).len();
            if left == 0 {
                completed += 1;
            } else if left < total {
                partial += 1;
            }
        }
        println!(
            "[Channel {}] {label}: {} completed {completed}/{} entries. Partial: {partial}.",
            channel.index + 1,
            sanitize_url(source),
            selected.len()
        );
        expert(
            "channel.feed.delivery_summary",
            json!({ "channel": label, "url": source, "completed": completed, "selected": selected.len(), "partial": partial, "dryRun": self.dry_run }),
        );
        Ok(failed)
    }

    pub async fn run_channel(&self, channel: &Channel) -> Result<ChannelResult, Stop> {
        let started = Instant::now();
        let label = channel.label();
        let config = self.config();
        expert(
            "channel.process.begin",
            json!({ "index": channel.index + 1, "channel": label, "feedCount": channel.feeds.len(), "dryRun": self.dry_run }),
        );
        let bucket_key = self.bucket_key(channel);
        // Work on a copy; live state is replaced after every confirmed send.
        let mut cache: Map<String, Value> = self.state.delivery.with(|root| {
            root.get(&bucket_key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        })?;
        let mut failure: Option<String> = None;

        if let Some(discord) = &channel.discord {
            let targets = Targets {
                webhook: channel.discord_webhook(),
                thread: channel.discord_thread(),
                telegram: channel.telegram.clone(),
            };
            if targets.list().is_empty() {
                crate::warn!(
                    "Channel",
                    "[Channel {}] {label}: Discord source has no delivery target configured.",
                    channel.index + 1
                );
            } else {
                match deliver::read_discord(discord, &self.cancel).await {
                    Ok((messages, error)) => {
                        failure = failure.or(error);
                        if self
                            .process(channel, &mut cache, "discord", messages, &targets, true)
                            .await?
                        {
                            failure.get_or_insert_with(|| "Discord delivery failed".into());
                        }
                    }
                    Err(_) => return Err(Stop::Cancelled),
                }
            }
        }

        let pipeline = Pipeline {
            config: &config,
            state: &self.state,
            circuit: &self.circuit,
            base: &self.base,
            cancel: &self.cancel,
        };
        let targets = Targets {
            webhook: channel.webhook.clone(),
            thread: channel.thread.clone(),
            telegram: channel.telegram.clone(),
        };
        for url in &channel.feeds {
            if self.cancel.is_cancelled() {
                return Err(Stop::Cancelled);
            }
            expert(
                "channel.feed.begin",
                json!({ "channel": label, "url": url }),
            );
            let outcome = pipeline.fetch(url).await?;
            if let Some(error) = outcome.failure {
                failure.get_or_insert(error);
            }
            if outcome.items.is_empty() {
                expert(
                    "channel.feed.empty",
                    json!({ "channel": label, "url": url }),
                );
                continue;
            }
            if targets.list().is_empty() {
                crate::warn!(
                    "Channel",
                    "[Channel {}] {label}: Feed {} has no delivery target configured.",
                    channel.index + 1,
                    sanitize_url(url)
                );
                continue;
            }
            if self
                .process(channel, &mut cache, url, outcome.items, &targets, false)
                .await?
            {
                failure.get_or_insert_with(|| "Delivery failed".into());
            }
        }
        expert(
            "channel.process.complete",
            json!({ "index": channel.index + 1, "channel": label, "durationMs": started.elapsed().as_millis() as u64 }),
        );
        Ok(ChannelResult { failure })
    }

    pub async fn run_once(&self) -> Result<(usize, usize), Stop> {
        self.refresh(false);
        let config = self.config();
        if config.channels.is_empty() {
            crate::error!(
                "Scheduler",
                "No valid channels configured for one-shot execution"
            );
            return Ok((0, 0));
        }
        let mut checked = 0;
        for channel in &config.channels {
            if self.stopping() {
                break;
            }
            crate::info!(
                "Scheduler",
                "Checking channel {} ({}/{})",
                channel.label(),
                channel.index + 1,
                config.channels.len()
            );
            match self.run_channel(channel).await {
                Ok(_) => checked += 1,
                Err(Stop::Cancelled) => break,
                Err(error) => return Err(error),
            }
        }
        Ok((checked, config.channels.len()))
    }

    pub async fn flush(&self) {
        if let Err(error) = self.state.flush().await {
            crate::error!("Shutdown", "Final state flush failed: {error}");
        }
    }
}

// --------------------------------------------------------------- scheduler --

#[derive(Clone, Copy, Default)]
struct Schedule {
    next_run_at: u64,
    failures: u32,
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn next_index(channels: &[Channel], expected: Option<&str>, fallback: usize) -> usize {
    if channels.is_empty() {
        return 0;
    }
    let bounded = fallback % channels.len();
    if let Some(key) = expected {
        if channels[bounded].cache_key == key {
            return bounded;
        }
        if let Some(index) = channels.iter().position(|c| c.cache_key == key) {
            return index;
        }
    }
    bounded
}

fn reschedule(schedule: &mut Schedule, minutes: u64, failed: bool) {
    let interval = minutes * 60_000;
    if failed {
        schedule.failures = (schedule.failures + 1).min(32);
        let backoff = (interval << (schedule.failures - 1).min(3)).min(interval.max(3_600_000));
        schedule.next_run_at = now_ms() + interval.max(backoff);
    } else {
        schedule.failures = 0;
        schedule.next_run_at = now_ms() + interval;
    }
}

/// Run the round-robin queue until shutdown. One channel is considered per
/// tick (`delay`); with concurrency > 1 different channels may overlap.
pub async fn run_queue(app: Arc<App>, delay: Duration) {
    let mut schedules: HashMap<String, Schedule> = HashMap::new();
    let mut cursor = 0usize;
    let mut next_key: Option<String> = None;
    let mut running: JoinSet<(String, String, u64, Result<ChannelResult, Stop>)> = JoinSet::new();
    let mut active: Vec<String> = Vec::new();
    let mut first = true;
    loop {
        if !first {
            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                () = app.stop.cancelled() => break,
                () = app.cancel.cancelled() => break,
                Some(done) = running.join_next(), if !running.is_empty() => {
                    handle_done(&app, done, &mut schedules, &mut active);
                    continue;
                }
            }
        }
        first = false;
        while let Some(done) = running.try_join_next() {
            handle_done(&app, done, &mut schedules, &mut active);
        }
        if app.stopping() {
            break;
        }
        app.refresh(false);
        let config = app.config();
        let channels = &config.channels;
        let due = channels
            .iter()
            .filter(|c| {
                schedules
                    .get(&c.cache_key)
                    .is_none_or(|s| s.next_run_at <= now_ms())
            })
            .count();
        crate::telemetry::set_gauges(active.len() as u64, due as u64);
        if channels.is_empty() {
            crate::warn!("Scheduler", "No channels available after refresh; waiting");
            expert("queue.wait", json!({ "reason": "no channels" }));
            continue;
        }
        cursor = next_index(channels, next_key.as_deref(), cursor);
        let channel = channels[cursor].clone();
        cursor = (cursor + 1) % channels.len();
        next_key = Some(channels[cursor].cache_key.clone());
        let key = channel.cache_key.clone();
        let schedule = schedules.get(&key).copied().unwrap_or_default();
        let limit = config.max_concurrent_channels().clamp(1, 8);
        if active.contains(&key) || active.len() >= limit || now_ms() < schedule.next_run_at {
            expert(
                "queue.channel.skipped",
                json!({ "channel": channel.label(), "reason": "interval not elapsed or busy" }),
            );
            continue;
        }
        crate::info!(
            "Scheduler",
            "Checking channel {} ({}/{})",
            channel.label(),
            channel.index + 1,
            channels.len()
        );
        expert(
            "queue.channel.selected",
            json!({ "index": channel.index + 1, "channel": channel.label() }),
        );
        active.push(key.clone());
        let worker = app.clone();
        running.spawn(async move {
            let minutes = channel.time_checker;
            let result = worker.run_channel(&channel).await;
            (channel.cache_key.clone(), channel.label(), minutes, result)
        });
        if limit == 1 {
            // Sequential mode: finish this channel before the next tick.
            tokio::select! {
                Some(done) = running.join_next() => handle_done(&app, done, &mut schedules, &mut active),
                () = app.stop.cancelled() => break,
                () = app.cancel.cancelled() => break,
            }
        }
    }
    // Shutdown: give running channels the network grace period, then cancel.
    let grace = Duration::from_millis(net().config().shutdown_grace_ms);
    let deadline = tokio::time::sleep(grace);
    tokio::pin!(deadline);
    while !running.is_empty() {
        tokio::select! {
            Some(done) = running.join_next() => handle_done(&app, done, &mut schedules, &mut active),
            () = &mut deadline => {
                app.cancel.cancel();
                let _ = tokio::time::timeout(Duration::from_secs(2), async { while running.join_next().await.is_some() {} }).await;
                running.abort_all();
                break;
            }
        }
    }
}

fn handle_done(
    app: &App,
    done: Result<(String, String, u64, Result<ChannelResult, Stop>), tokio::task::JoinError>,
    schedules: &mut HashMap<String, Schedule>,
    active: &mut Vec<String>,
) {
    let Ok((key, label, minutes, result)) = done else {
        return;
    };
    active.retain(|k| k != &key);
    let schedule = schedules.entry(key.clone()).or_default();
    match result {
        Ok(ChannelResult { failure: None }) => {
            reschedule(schedule, minutes, false);
            expert("queue.channel.complete", json!({ "channel": label }));
        }
        Ok(ChannelResult {
            failure: Some(message),
        }) => {
            reschedule(schedule, minutes, true);
            crate::warn!(
                "Scheduler",
                "Channel {label} finished with errors: {}",
                sanitize_text(&message)
            );
            expert(
                "queue.channel.failed",
                json!({ "channel": label, "error": { "message": message } }),
            );
        }
        Err(Stop::Cancelled) => reschedule(schedule, minutes, false),
        Err(Stop::Unsafe(error)) => {
            crate::error!(
                "Scheduler",
                "Persistent state is unsafe; stopping scheduler: {error}"
            );
            app.begin_stop();
            app.cancel.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_caps_at_eight_intervals_or_one_hour() {
        let mut schedule = Schedule::default();
        for _ in 0..10 {
            reschedule(&mut schedule, 60, true);
        }
        let remaining = schedule.next_run_at - now_ms();
        assert!((3_600_000 - 1000..=3_600_000 + 1000).contains(&remaining));
        let mut short = Schedule::default();
        for _ in 0..10 {
            reschedule(&mut short, 1, true);
        }
        assert!(short.next_run_at - now_ms() <= 8 * 60_000 + 1000);
    }

    #[test]
    fn legacy_bucket_migrates_per_target() {
        let mut cache = Map::new();
        cache.insert("https://f".into(), json!(["a", "b"]));
        let pending = App::pending(
            &mut cache,
            "https://f",
            "a",
            &[Target::Webhook, Target::Telegram],
        );
        assert!(pending.is_empty());
        assert_eq!(cache["https://f::webhook"], json!(["a", "b"]));
        assert_eq!(
            App::pending(&mut cache, "https://f", "c", &[Target::Webhook]),
            vec![Target::Webhook]
        );
    }
}
