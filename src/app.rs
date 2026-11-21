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
    /// Destinations found unreachable during this channel run.
    unreachable: Mutex<Vec<Target>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Sent {
    Yes,
    Failed,
    Unreachable,
}

impl Targets {
    fn new(webhook: String, thread: Option<String>, telegram: Option<config::Telegram>) -> Self {
        Self {
            webhook,
            thread,
            telegram,
            unreachable: Mutex::new(Vec::new()),
        }
    }

    fn is_unreachable(&self, target: Target) -> bool {
        self.unreachable.lock().expect("lock").contains(&target)
    }

    fn mark_unreachable(&self, target: Target) {
        let mut list = self.unreachable.lock().expect("lock");
        if !list.contains(&target) {
            list.push(target);
        }
    }

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
    /// Diagnostics: when each entry (source + identity) was first fetched.
    first_seen: Mutex<HashMap<String, i64>>,
    /// `AdaptivePolling`: when each feed (channel key + URL) is due again.
    feed_due: Mutex<HashMap<String, u64>>,
}

pub struct ChannelResult {
    pub failure: Option<String>,
    /// With `AdaptivePolling`: when the channel's earliest feed is due.
    pub next_due_ms: Option<u64>,
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
        crate::clearance::init(crate::clearance::path_for(&base), !dry_run);
        crate::sent::init(crate::sent::path_for(&base.join("cache.json")), !dry_run);
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
            first_seen: Mutex::new(HashMap::new()),
            feed_due: Mutex::new(HashMap::new()),
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

    async fn with_working_image(&self, entry: &Value) -> Value {
        if self.dry_run {
            return entry.clone();
        }
        crate::deliver::working_image(entry, &self.cancel).await.0
    }

    /// `Settings.SteamMerge`: edit the earlier Steam/SteamDB post of this
    /// update instead of posting again. `None` = post normally.
    async fn merge_steam(
        &self,
        channel_key: &str,
        label: &str,
        source: &str,
        targets: &Targets,
        entry: &Value,
    ) -> Result<Option<Sent>, Stop> {
        let Some(merge) = crate::steam_merge::from_config(&self.config().root) else {
            return Ok(None);
        };
        let now = chrono::Utc::now().timestamp_millis();
        let Some((record, merged)) =
            crate::steam_merge::find(&crate::sent::all(), channel_key, source, entry, now, &merge)
        else {
            return Ok(None);
        };
        let title = crate::js::to_string_or_empty(crate::js::get(entry, "title"));
        if self.dry_run {
            println!(
                "[Dry Run] {label}: {} -> webhook (merged into message {}): {}",
                sanitize_url(source),
                record.message_id,
                sanitize_text(&title)
            );
            return Ok(Some(Sent::Yes));
        }
        match deliver::edit_webhook(
            &targets.webhook,
            targets.thread.as_deref(),
            &record.message_id,
            &merged,
            &self.cancel,
        )
        .await
        {
            Ok(()) => {
                crate::sent::update_entry(&record.message_id, &merged);
                crate::info!(
                    "Channel",
                    "{label}: {} merged into the earlier post {} instead of a new message",
                    sanitize_text(&title),
                    record.message_id
                );
                expert(
                    "delivery.merged",
                    json!({ "channel": label, "source": sanitize_url(source), "messageId": record.message_id }),
                );
                Ok(Some(Sent::Yes))
            }
            Err(SendError::Cancelled) => Err(Stop::Cancelled),
            Err(_) => {
                crate::warn!(
                    "Channel",
                    "{label}: could not merge {} into post {}; posting it separately",
                    sanitize_text(&title),
                    record.message_id
                );
                Ok(None)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn deliver(
        &self,
        channel_key: &str,
        identity: &str,
        label: &str,
        source: &str,
        target: Target,
        targets: &Targets,
        entry: &Value,
    ) -> Result<Sent, Stop> {
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
        if target == Target::Webhook
            && let Some(sent) = self
                .merge_steam(channel_key, label, source, targets, entry)
                .await?
        {
            return Ok(sent);
        }
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
            return Ok(Sent::Yes);
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
            .map(|message| {
                // Kept for later edits (`xfeeder rerender`, Steam merging).
                if let Some(message) = message {
                    crate::sent::record(channel_key, source, identity, &message, entry);
                }
            }),
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
                Ok(Sent::Yes)
            }
            Err(SendError::Cancelled) => Err(Stop::Cancelled),
            Err(SendError::Unreachable(message)) => {
                crate::error!(
                    "Channel",
                    "{label}: {} destination unreachable ({}); skipping its remaining entries this run. Check the Webhook/Thread/ChatID in config.json.",
                    target.kind(),
                    sanitize_text(&message)
                );
                expert(
                    "delivery.failed",
                    json!({ "channel": label, "target": target.kind(), "durationMs": started.elapsed().as_millis() as u64, "error": { "code": "TARGET_UNREACHABLE", "message": message } }),
                );
                Ok(Sent::Unreachable)
            }
            Err(SendError::Gone) => Ok(Sent::Failed),
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
                Ok(Sent::Failed)
            }
        }
    }

    /// Diagnostics: remember first-fetch times and report feed freshness and
    /// data anomalies (future dates, duplicate or missing identities).
    fn observe_entries(&self, channel: &Channel, source: &str, identified: &[(String, Value)]) {
        if !crate::diagnostics::enabled() {
            return;
        }
        let now = chrono::Utc::now().timestamp_millis();
        let label = channel.label();
        let mut dates: Vec<i64> = Vec::new();
        let mut ids = std::collections::HashSet::new();
        let anomaly = |kind: &str, extra: Value| {
            let mut payload =
                json!({ "kind": kind, "channel": label, "url": sanitize_url(source) });
            if let (Value::Object(map), Value::Object(more)) = (&mut payload, extra) {
                map.extend(more);
            }
            crate::diagnostics::record("anomaly", payload);
        };
        {
            let mut seen = self.first_seen.lock().expect("lock");
            if seen.len() > 100_000 {
                let cutoff = now - 7 * 86_400_000;
                seen.retain(|_, at| *at > cutoff);
            }
            for (identity, entry) in identified {
                if identity.is_empty() {
                    anomaly(
                        "entry.no_identity",
                        json!({ "title": sanitize_text(&crate::js::to_string_or_empty(crate::js::get(entry, "title"))) }),
                    );
                    continue;
                }
                if !ids.insert(identity.clone()) {
                    anomaly(
                        "entry.duplicate_in_feed",
                        json!({ "id": sanitize_url(identity) }),
                    );
                }
                seen.entry(format!("{source}\u{1}{identity}"))
                    .or_insert(now);
                if let Some(date) = crate::js::get(entry, "isoDate")
                    .as_str()
                    .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
                {
                    let ms = date.timestamp_millis();
                    if ms > now + 10 * 60_000 {
                        anomaly(
                            "entry.future_date",
                            json!({ "id": sanitize_url(identity), "aheadMs": ms - now }),
                        );
                    } else {
                        dates.push(ms.min(now));
                    }
                }
            }
        }
        dates.sort_unstable_by(|a, b| b.cmp(a));
        let mut gaps: Vec<i64> = dates
            .windows(2)
            .map(|w| w[0] - w[1])
            .filter(|g| *g > 0)
            .collect();
        gaps.sort_unstable();
        expert(
            "feed.freshness",
            json!({
                "channel": channel.label(), "url": source, "entries": identified.len(), "dated": dates.len(),
                "newestAgeMs": dates.first().map(|d| now - d),
                "medianGapMs": gaps.get(gaps.len() / 2),
            }),
        );
    }

    /// Diagnostics: publication → first fetch → Discord for one delivery.
    fn observe_sent(
        &self,
        channel: &Channel,
        source: &str,
        target: Target,
        identity: &str,
        entry: &Value,
    ) {
        if !crate::diagnostics::enabled() || self.dry_run {
            return;
        }
        let now = chrono::Utc::now().timestamp_millis();
        let seen = self
            .first_seen
            .lock()
            .expect("lock")
            .get(&format!("{source}\u{1}{identity}"))
            .copied();
        let published = crate::js::get(entry, "isoDate")
            .as_str()
            .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
            .map(|d| d.timestamp_millis())
            // A future publication date says nothing about our latency.
            .filter(|p| *p <= now + 10 * 60_000);
        expert(
            "latency.entry",
            json!({
                "channel": channel.label(), "url": source, "target": target.kind(),
                "title": crate::js::to_string_or_empty(crate::js::get(entry, "title")),
                "publishedAt": crate::js::get(entry, "isoDate"),
                "publishToSeenMs": published.zip(seen).map(|(p, s)| (s - p).max(0)),
                "seenToSentMs": seen.map(|s| now - s),
                "publishToSentMs": published.map(|p| (now - p).max(0)),
            }),
        );
    }

    /// First sight of a feed for a destination (no delivery history and no
    /// legacy bucket): record its current entries as seen, except the newest
    /// `FirstRunSend`, so a new feed, a new destination or an edited channel
    /// (whose cache key changes) does not replay the whole feed.
    async fn baseline(
        &self,
        channel: &Channel,
        cache: &mut Map<String, Value>,
        source: &str,
        identified: &[(String, Value)],
        kinds: &[Target],
        bucket_key: &str,
    ) -> Result<(), Stop> {
        let has_history = |value: Option<&Value>| {
            value
                .and_then(Value::as_array)
                .is_some_and(|list| !list.is_empty())
        };
        if has_history(cache.get(source)) {
            return Ok(()); // legacy single bucket, migrated by `pending`
        }
        let fresh: Vec<Target> = kinds
            .iter()
            .copied()
            .filter(|t| !has_history(cache.get(&format!("{source}::{}", t.kind()))))
            .collect();
        // Feeds are usually newest-first, but do not rely on it: keep the
        // newest `FirstRunSend` by date (feed order breaks ties).
        let mut order: Vec<usize> = (0..identified.len()).collect();
        order.sort_by_key(|&i| {
            std::cmp::Reverse(
                crate::js::get(&identified[i].1, "isoDate")
                    .as_str()
                    .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
                    .map_or(i64::MIN, |d| d.timestamp_millis()),
            )
        });
        let send: Vec<usize> = order.into_iter().take(channel.first_run_send).collect();
        let seen: Vec<Value> = identified
            .iter()
            .enumerate()
            .filter(|(i, (id, _))| !id.is_empty() && !send.contains(i))
            .map(|(_, (id, _))| json!(id))
            .collect();
        if fresh.is_empty() || seen.is_empty() {
            return Ok(());
        }
        for target in &fresh {
            cache.insert(
                format!("{source}::{}", target.kind()),
                Value::Array(push_cache(&[], &seen, CACHE_LIMIT)),
            );
        }
        let kinds: Vec<&str> = fresh.iter().map(|t| t.kind()).collect();
        crate::info!(
            "Channel",
            "{}{}: first check of {} for {}: {} existing entries marked as seen, newest {} will be sent (FirstRunSend)",
            if self.dry_run { "[Dry Run] " } else { "" },
            channel.label(),
            sanitize_url(source),
            kinds.join("+"),
            seen.len(),
            send.len()
        );
        self.persist(bucket_key, cache).await
    }

    async fn persist(&self, bucket_key: &str, cache: &Map<String, Value>) -> Result<(), Stop> {
        if self.dry_run {
            return Ok(());
        }
        self.state.delivery.with(|root| {
            root.insert(bucket_key.to_string(), Value::Object(cache.clone()));
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
        Ok(())
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
        let entries = if discord {
            entries
        } else {
            crate::parsers::finish(source, entries)
        };
        let fetched = entries.len();
        let entries: Vec<Value> = match &channel.filter {
            Some(filter) => {
                let now = chrono::Utc::now().timestamp_millis();
                entries
                    .into_iter()
                    .filter(|e| filter.accepts(e, now))
                    .collect()
            }
            None => entries,
        };
        if entries.len() != fetched {
            expert(
                "channel.feed.filtered",
                json!({ "channel": label, "url": source, "fetched": fetched, "kept": entries.len() }),
            );
        }
        let identified: Vec<(String, Value)> = entries
            .into_iter()
            .map(|e| (entry_identity(&e, discord), e))
            .collect();
        self.observe_entries(channel, source, &identified);
        self.baseline(channel, cache, source, &identified, &kinds, &bucket_key)
            .await?;
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
            let entry = &self.with_working_image(entry).await;
            for target in Self::pending(cache, source, identity, &kinds) {
                if targets.is_unreachable(target) {
                    failed = true;
                    continue;
                }
                let delivered = self
                    .deliver(
                        &channel.cache_key,
                        identity,
                        &label,
                        source,
                        target,
                        targets,
                        entry,
                    )
                    .await;
                if !self.dry_run {
                    // Pace provider requests even after a failure.
                    let pause = self.sleep(SEND_DELAY).await;
                    if delivered.is_ok() {
                        pause?;
                    }
                }
                let delivered = delivered?;
                if delivered == Sent::Yes {
                    self.observe_sent(channel, source, target, identity, entry);
                }
                match delivered {
                    Sent::Yes if !identity.is_empty() => {
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
                            self.persist(&bucket_key, cache).await?;
                        }
                    }
                    Sent::Yes => {}
                    Sent::Failed => failed = true,
                    Sent::Unreachable => {
                        targets.mark_unreachable(target);
                        failed = true;
                    }
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

        let discord_key = format!("{}|discord", channel.cache_key);
        let discord_due = channel.adaptive.is_none()
            || self
                .feed_due
                .lock()
                .expect("lock")
                .get(&discord_key)
                .is_none_or(|due| *due <= now_ms());
        if let Some(discord) = channel.discord.as_ref().filter(|_| discord_due) {
            if channel.adaptive.is_some() {
                self.feed_due
                    .lock()
                    .expect("lock")
                    .insert(discord_key, now_ms() + channel.time_checker * 60_000);
            }
            let targets = Targets::new(
                channel.discord_webhook(),
                channel.discord_thread(),
                channel.telegram.clone(),
            );
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
        // One instance per channel run: an unreachable destination is
        // skipped for every remaining feed of this channel.
        let targets = Targets::new(
            channel.webhook.clone(),
            channel.thread.clone(),
            channel.telegram.clone(),
        );
        let mut next_due: Option<u64> = None;
        let max_ms = channel.time_checker * 60_000;
        for url in &channel.feeds {
            if self.cancel.is_cancelled() {
                return Err(Stop::Cancelled);
            }
            let due_key = format!("{}|{url}", channel.cache_key);
            if channel.adaptive.is_some() {
                let due = self.feed_due.lock().expect("lock").get(&due_key).copied();
                if let Some(due) = due.filter(|d| *d > now_ms()) {
                    next_due = Some(next_due.map_or(due, |n| n.min(due)));
                    expert(
                        "channel.feed.not_due",
                        json!({ "channel": label, "url": url, "dueInSec": (due - now_ms()) / 1000 }),
                    );
                    continue;
                }
            }
            expert(
                "channel.feed.begin",
                json!({ "channel": label, "url": url }),
            );
            let outcome = pipeline.fetch(url).await?;
            if let Some(adaptive) = &channel.adaptive {
                let fetched_at = now_ms();
                let (interval, reason) = if outcome.failure.is_some() {
                    (max_ms, "failed")
                } else {
                    crate::adaptive::interval_ms(
                        &outcome.items,
                        fetched_at as i64,
                        max_ms,
                        adaptive,
                    )
                };
                let due = fetched_at + interval;
                self.feed_due.lock().expect("lock").insert(due_key, due);
                next_due = Some(next_due.map_or(due, |n| n.min(due)));
                expert(
                    "feed.interval",
                    json!({ "channel": label, "url": url, "minutes": interval as f64 / 60_000.0, "reason": reason }),
                );
            }
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
                .process(
                    channel,
                    &mut cache,
                    outcome.source.as_deref().unwrap_or(url),
                    outcome.items,
                    &targets,
                    false,
                )
                .await?
            {
                failure.get_or_insert_with(|| "Delivery failed".into());
            }
        }
        expert(
            "channel.process.complete",
            json!({ "index": channel.index + 1, "channel": label, "durationMs": started.elapsed().as_millis() as u64 }),
        );
        Ok(ChannelResult {
            failure,
            next_due_ms: next_due,
        })
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
    /// When the last successful run finished (0 = never).
    last_run_at: u64,
}

/// A shorter `TimeChecker` (config reload) applies to runs that are
/// already planned: next run = last run + new interval, if that is sooner.
fn apply_interval(schedule: &mut Schedule, minutes: u64) {
    if schedule.failures == 0 && schedule.last_run_at > 0 {
        let sooner = schedule.last_run_at + minutes * 60_000;
        if sooner < schedule.next_run_at {
            schedule.next_run_at = sooner;
        }
    }
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
        schedule.last_run_at = now_ms();
        schedule.next_run_at = schedule.last_run_at + interval;
    }
}

/// Run the round-robin queue until shutdown. Due channels are started one
/// after another in round-robin order (up to `MaxConcurrentChannels` at a
/// time); the queue only sleeps for `delay` when no channel is due. 2.x
/// considered a single channel per tick, so with N channels a due channel
/// could wait N × 30 s.
pub async fn run_queue(app: Arc<App>, delay: Duration) {
    let mut schedules: HashMap<String, Schedule> = HashMap::new();
    let mut cursor = 0usize;
    let mut next_key: Option<String> = None;
    let mut running: JoinSet<(String, String, u64, Result<ChannelResult, Stop>)> = JoinSet::new();
    let mut active: Vec<String> = Vec::new();
    let mut first = true;
    loop {
        if !first {
            // Something may have finished while the previous channel ran.
            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                () = app.stop.cancelled() => break,
                () = app.cancel.cancelled() => break,
                Some(done) = running.join_next(), if !running.is_empty() => {
                    handle_done(&app, done, &mut schedules, &mut active);
                    // A slot is free: start the next due channel right away.
                    first = true;
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
        for channel in channels {
            if let Some(schedule) = schedules.get_mut(&channel.cache_key) {
                apply_interval(schedule, channel.time_checker);
            }
        }
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
        let limit = config.max_concurrent_channels().clamp(1, 8);
        if active.len() >= limit {
            continue;
        }
        // Next due channel in round-robin order, starting at the cursor.
        cursor = next_index(channels, next_key.as_deref(), cursor);
        let picked = (0..channels.len())
            .map(|step| (cursor + step) % channels.len())
            .find(|&index| {
                let key = &channels[index].cache_key;
                !active.contains(key)
                    && schedules.get(key).is_none_or(|s| s.next_run_at <= now_ms())
            });
        let Some(index) = picked else {
            expert("queue.wait", json!({ "reason": "no channel due" }));
            continue;
        };
        let channel = channels[index].clone();
        cursor = (index + 1) % channels.len();
        next_key = Some(channels[cursor].cache_key.clone());
        let key = channel.cache_key.clone();
        crate::info!(
            "Scheduler",
            "Checking channel {} ({}/{})",
            channel.label(),
            channel.index + 1,
            channels.len()
        );
        let due_at = schedules.get(&key).map_or(0, |s| s.next_run_at);
        expert(
            "queue.channel.selected",
            json!({
                "index": channel.index + 1, "channel": channel.label(),
                "lateMs": (due_at > 0).then(|| now_ms().saturating_sub(due_at)),
                "intervalMin": channel.time_checker, "active": active.len(),
            }),
        );
        active.push(key.clone());
        let worker = app.clone();
        running.spawn(async move {
            let minutes = channel.time_checker;
            let result = worker.run_channel(&channel).await;
            (channel.cache_key.clone(), channel.label(), minutes, result)
        });
        if limit == 1 {
            // Sequential mode: finish this channel before the next one.
            tokio::select! {
                Some(done) = running.join_next() => handle_done(&app, done, &mut schedules, &mut active),
                () = app.stop.cancelled() => break,
                () = app.cancel.cancelled() => break,
            }
        }
        // Look for the next due channel right away instead of sleeping.
        first = true;
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
        Ok(ChannelResult {
            failure: None,
            next_due_ms,
        }) => {
            reschedule(schedule, minutes, false);
            // AdaptivePolling: wake up for the earliest due feed (never later
            // than TimeChecker, never sooner than a minute).
            if let Some(due) = next_due_ms {
                schedule.next_run_at = schedule.next_run_at.min(due.max(now_ms() + 60_000));
            }
            expert("queue.channel.complete", json!({ "channel": label }));
        }
        Ok(ChannelResult {
            failure: Some(message),
            ..
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
    fn shorter_interval_moves_planned_run_forward() {
        let mut schedule = Schedule::default();
        reschedule(&mut schedule, 60, false);
        let planned = schedule.next_run_at;
        apply_interval(&mut schedule, 90);
        assert_eq!(
            schedule.next_run_at, planned,
            "a longer interval waits for the planned run"
        );
        apply_interval(&mut schedule, 30);
        assert_eq!(schedule.next_run_at, schedule.last_run_at + 30 * 60_000);
        let mut failing = Schedule::default();
        reschedule(&mut failing, 60, true);
        let backoff = failing.next_run_at;
        apply_interval(&mut failing, 1);
        assert_eq!(failing.next_run_at, backoff, "backoff is kept");
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
