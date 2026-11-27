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
use crate::state::{StateStore, UnsafeState, push_cache};
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
    /// Channel `Ping` (Discord posts only).
    ping: Option<crate::ping::Ping>,
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
    fn new(
        webhook: String,
        thread: Option<String>,
        telegram: Option<config::Telegram>,
        ping: Option<crate::ping::Ping>,
    ) -> Self {
        Self {
            webhook,
            thread,
            telegram,
            ping,
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
        crate::deliver::set_post_text(&config.root);
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

    /// Drop one remembered entry (dashboard request). False if it was not
    /// there; nothing is written in a dry run.
    pub async fn forget_entry(
        &self,
        bucket: &str,
        feed: &str,
        id: &str,
    ) -> Result<bool, UnsafeState> {
        if self.dry_run {
            return Ok(false);
        }
        let removed = self.state.delivery.with(|root| {
            root.get_mut(bucket)
                .and_then(Value::as_object_mut)
                .and_then(|b| b.get_mut(feed))
                .and_then(Value::as_array_mut)
                .is_some_and(|list| {
                    let before = list.len();
                    list.retain(|v| v.as_str() != Some(id));
                    list.len() != before
                })
        })?;
        if removed {
            self.state.delivery.save().await?;
        }
        Ok(removed)
    }

    /// Make every feed of the channel due now (AdaptivePolling).
    fn clear_feed_due(&self, cache_key: &str) {
        let prefix = format!("{cache_key}|");
        self.feed_due
            .lock()
            .expect("lock")
            .retain(|k, _| !k.starts_with(&prefix));
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
        if let Some(adopted) = self.adopt_history(channel, &key) {
            crate::info!(
                "Cache",
                "{}: the channel's settings changed (new history key {key}); keeping the delivery history recorded under {adopted}",
                channel.label()
            );
        }
        keys.insert(channel.cache_key.clone(), key.clone());
        key
    }

    /// A hand edit of a channel without `CacheKey` (a feed added, a webhook
    /// rotated) changes its history key. Without this, every feed of the
    /// channel got an empty history: entries that came in since the last
    /// check were marked as seen (lost), and with `FirstRunSend` the newest
    /// of every feed were posted again (F07-5). The key each channel slot
    /// (group + position) used last is kept in `cache.json`; a slot whose
    /// new key has no history takes over the old one. Taking a wrong
    /// slot's history is never worse than starting empty: only ids that
    /// were really sent are carried over.
    fn adopt_history(&self, channel: &Channel, key: &str) -> Option<String> {
        let slot = format!("{}#{}", channel.source_key, channel.position);
        let config = self.config();
        let in_use = |k: &str| {
            config
                .channels
                .iter()
                .any(|c| c.cache_key == k || c.legacy_cache_key.as_deref() == Some(k))
        };
        let result = self.state.delivery.with(|root| {
            let previous = root
                .get(crate::state::META_KEY)
                .and_then(|m| m.get("channelKeys"))
                .and_then(|k| k.get(&slot))
                .and_then(Value::as_str)
                .map(str::to_string);
            let mut adopted = None;
            if let Some(old) = previous.filter(|old| old != key)
                && !root.contains_key(key)
                && let Some(history) = root.get(&old).cloned()
            {
                root.insert(key.to_string(), history);
                if !in_use(&old) {
                    root.remove(&old);
                }
                adopted = Some(old);
            }
            let meta = root
                .entry(crate::state::META_KEY)
                .or_insert_with(|| Value::Object(Map::new()));
            if !meta.is_object() {
                *meta = Value::Object(Map::new());
            }
            if let Some(meta) = meta.as_object_mut() {
                let keys = meta
                    .entry("channelKeys")
                    .or_insert_with(|| Value::Object(Map::new()));
                if !keys.is_object() {
                    *keys = Value::Object(Map::new());
                }
                if let Some(keys) = keys.as_object_mut() {
                    keys.insert(slot.clone(), json!(key));
                }
            }
            adopted
        });
        result.ok().flatten()
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
            targets
                .ping
                .as_ref()
                .and_then(|p| p.mention(&merged, source))
                .as_ref(),
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
            let ping = match target {
                Target::Webhook => targets
                    .ping
                    .as_ref()
                    .and_then(|p| p.mention(entry, source))
                    .map(|m| format!(" (ping {})", m.line))
                    .unwrap_or_default(),
                Target::Telegram => String::new(),
            };
            println!(
                "[Dry Run] {label}: {} -> {}{ping}: {}",
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
                    targets
                        .ping
                        .as_ref()
                        .and_then(|p| p.mention(entry, source))
                        .as_ref(),
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
    #[allow(clippy::too_many_arguments)]
    async fn baseline(
        &self,
        channel: &Channel,
        cache: &mut Map<String, Value>,
        source: &str,
        identified: &[(String, Value)],
        accepted: &[bool],
        kinds: &[Target],
        bucket_key: &str,
        ids: &FetchIds,
    ) -> Result<(), Stop> {
        let (aliases, keep) = (&ids.aliases, &ids.keep);
        let has_history = |value: Option<&Value>| real_history(source, value);
        if has_history(cache.get(source)) {
            return Ok(()); // legacy single bucket, migrated by `pending`
        }
        let fresh: Vec<Target> = kinds
            .iter()
            .copied()
            .filter(|t| !has_history(cache.get(&format!("{source}::{}", t.kind()))))
            .collect();
        let (send, seen) = first_check_split(identified, accepted, channel.first_run_send, aliases);
        if fresh.is_empty() || seen.is_empty() {
            return Ok(());
        }
        for target in &fresh {
            cache.insert(
                format!("{source}::{}", target.kind()),
                Value::Array(crate::state::push_cache_keeping(
                    &[],
                    &seen,
                    CACHE_LIMIT,
                    keep,
                )),
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
        // Ids of everything the feed lists now (filtered or not): history
        // trimming never drops these.
        let mut keep: std::collections::HashSet<String> = entries
            .iter()
            .map(|e| entry_identity(e, discord))
            .filter(|id| !id.is_empty())
            .collect();
        let aliases = guid_aliases(&entries, discord);
        keep.extend(aliases.values().cloned());
        // History decisions (shared links, first check, guid aliases) see
        // everything the feed lists; the filter only decides what is sent.
        // A first check with `MaxAgeHours` used to leave the older entries
        // unrecorded, and an edit (`updated` moving) later posted them.
        let now = chrono::Utc::now().timestamp_millis();
        let mut identified: Vec<(String, Value)> = entries
            .into_iter()
            .map(|e| (entry_identity(&e, discord), e))
            .collect();
        let sent_guid = |link: &str| sent_guid(&channel.cache_key, source, link);
        if stabilize_shared_links(cache, source, &kinds, &mut identified, &label, &sent_guid) {
            self.persist(&bucket_key, cache).await?;
        }
        keep.extend(identified.iter().map(|(id, _)| id.clone()));
        let accepted: Vec<bool> = identified
            .iter()
            .map(|(_, e)| channel.filter.as_ref().is_none_or(|f| f.accepts(e, now)))
            .collect();
        let kept = accepted.iter().filter(|a| **a).count();
        if kept != fetched {
            expert(
                "channel.feed.filtered",
                json!({ "channel": label, "url": source, "fetched": fetched, "kept": kept }),
            );
        }
        let shown: Vec<(String, Value)> = identified
            .iter()
            .zip(&accepted)
            .filter(|(_, a)| **a)
            .map(|(e, _)| e.clone())
            .collect();
        self.observe_entries(channel, source, &shown);
        let ids = FetchIds { aliases, keep };
        self.baseline(
            channel,
            cache,
            source,
            &identified,
            &accepted,
            &kinds,
            &bucket_key,
            &ids,
        )
        .await?;
        let FetchIds { aliases, keep } = ids;
        if sync_guid_aliases(cache, source, &kinds, &identified, &aliases, &keep, &label) {
            self.persist(&bucket_key, cache).await?;
        }
        let mut pending: Vec<&(String, Value)> = identified
            .iter()
            .zip(&accepted)
            .filter(|(_, a)| **a)
            .map(|(e, _)| e)
            .filter(|(id, _)| !Self::pending(cache, source, id, &kinds).is_empty())
            .collect();
        // Oldest first, so a long backlog (after downtime) loses nothing off
        // the end of a rolling feed; undated entries keep their feed place.
        oldest_first(&mut pending);
        expert(
            "channel.feed.pending",
            json!({ "channel": label, "url": source, "fetched": kept, "pending": pending.len() }),
        );
        if pending.is_empty() {
            return Ok(false);
        }
        let selected: Vec<&(String, Value)> =
            pending.into_iter().take(channel.request_send).collect();
        let mut failed = false;
        for (identity, entry) in selected.iter() {
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
                        let mut ids = vec![json!(identity)];
                        if let Some(alias) = aliases.get(identity.as_str())
                            && !existing.iter().any(|v| v.as_str() == Some(alias))
                        {
                            ids.push(json!(alias));
                        }
                        if !existing.iter().any(|v| v.as_str() == Some(identity)) {
                            cache.insert(
                                name,
                                Value::Array(crate::state::push_cache_keeping(
                                    &existing,
                                    &ids,
                                    CACHE_LIMIT,
                                    &keep,
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
                channel.ping.clone(),
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
            channel.ping.clone(),
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
            // A feed that fails backs off on its own (feed health); it does
            // not hold back the channel's other feeds (channels12: 232 feeds
            // waited 2–8× their interval for one broken one). Only failed
            // deliveries back off the whole channel.
            if let Some(error) = outcome.failure {
                expert(
                    "channel.feed.failed",
                    json!({ "channel": label, "url": url, "error": { "message": error } }),
                );
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
    // Channels live mode woke while they were running: checked again as soon
    // as that run ends (its reschedule would otherwise push the wake back).
    let mut rewake: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut first = true;
    loop {
        if !first {
            // Something may have finished while the previous channel ran.
            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                // Live mode saw a Steam change: look at the steampics:// channels now.
                () = crate::steam_pics::woken() => {}
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
        apply_requests(&app, channels, &mut schedules, &active).await;
        let woken = crate::steam_pics::take_woken();
        if !woken.is_empty() {
            for channel in channels {
                let hit = channel
                    .feeds
                    .iter()
                    .filter_map(|f| crate::steam_pics::appid(f))
                    .any(|id| woken.contains(&id));
                if hit {
                    rewake.insert(channel.cache_key.clone());
                }
            }
        }
        rewake.retain(|key| {
            if active.contains(key) {
                return true;
            }
            if let Some(channel) = channels.iter().find(|c| &c.cache_key == key) {
                schedules.entry(key.clone()).or_default().next_run_at = 0;
                app.clear_feed_due(key);
                crate::info!(
                    "SteamLive",
                    "Checking {} now (Steam change)",
                    channel.label()
                );
            }
            false
        });
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

/// Dashboard requests (see `requests.rs`). A forget for a channel that is
/// running now waits: the running round would write its own copy back.
async fn apply_requests(
    app: &App,
    channels: &[Channel],
    schedules: &mut HashMap<String, Schedule>,
    active: &[String],
) {
    let dir = crate::requests::dir_for(&app.config_path);
    for (path, request) in crate::requests::pending(&dir) {
        match request {
            crate::requests::Request::Check { channel } => {
                match channels.iter().find(|c| c.cache_key == channel) {
                    Some(found) => {
                        schedules.entry(channel.clone()).or_default().next_run_at = 0;
                        app.clear_feed_due(&channel);
                        crate::info!("Requests", "Checking {} now (dashboard)", found.label());
                    }
                    None => crate::warn!("Requests", "Check requested for an unknown channel"),
                }
                crate::requests::done(&path);
            }
            crate::requests::Request::Forget { bucket, feed, id } => {
                let busy = channels
                    .iter()
                    .any(|c| active.contains(&c.cache_key) && app.bucket_key(c) == bucket);
                if busy {
                    continue;
                }
                match app.forget_entry(&bucket, &feed, &id).await {
                    Ok(removed) => {
                        crate::info!(
                            "Requests",
                            "{} a remembered entry of {} (dashboard); it can be posted again",
                            if removed { "Forgot" } else { "Did not find" },
                            sanitize_text(feed.rsplit_once("::").map_or(&feed, |(u, _)| u))
                        );
                        crate::requests::done(&path);
                    }
                    Err(error) => crate::error!("Requests", "Cannot forget the entry: {error}"),
                }
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

/// Whether a delivery bucket holds a real history. One holding nothing but
/// the feed's own address does not: feeds whose entries had no link or guid
/// (Mojang's patch note JSON) gave every entry that identity, and once they
/// get real identities the first check must not replay the whole feed.
/// Link and guid of an entry that the parsers would key `link#guid` when the
/// link is shared (see `parsers::mark_shared_links`).
fn link_and_guid(entry: &Value) -> Option<(String, String)> {
    use crate::js::{get, or, to_string_or_empty};
    let link = crate::text::normalize_link(&to_string_or_empty(or(&[
        get(entry, "sourceLink"),
        get(entry, "link"),
    ])));
    let guid = to_string_or_empty(get(entry, "guid")).trim().to_string();
    (!link.is_empty() && !guid.is_empty() && guid != link).then_some((link, guid))
}

/// Keeps identities of entries that share a link stable across checks.
///
/// The parsers key an entry `link#guid` only while another entry of the same
/// fetch has that link, so one entry could change identity between checks:
/// sent again when a second entry with its link appeared, or a new entry
/// swallowed when it was alone again with a link already in history. Here:
/// - a link that history already holds as `link#…` keeps `link#guid` for
///   every entry with it, even when it is alone in this fetch;
/// - the first time a link is seen shared while history has only the bare
///   link (sent when it was alone), the bare link's place goes to the entry
///   that was really sent under it: `sent_guid(link)` is the guid recorded
///   when it was sent (sent.json). Without that proof, or when the sent entry
///   is not in this fetch (it left the feed, or a filter hid it), nothing is
///   handed over and every entry with the link is sent: at worst one post
///   twice, never a new post skipped.
///
/// Returns whether the history was changed.
/// First check of a feed: which entries are sent (the newest `first_run_send`
/// by date among those the filter accepts; feed order breaks ties) and which
/// ids are recorded as seen (every other listed entry, filtered or not, so a
/// later edit cannot bring an old one back).
fn first_check_split(
    identified: &[(String, Value)],
    accepted: &[bool],
    first_run_send: usize,
    aliases: &std::collections::HashMap<String, String>,
) -> (Vec<usize>, Vec<Value>) {
    let mut order: Vec<usize> = (0..identified.len())
        .filter(|&i| accepted.get(i).copied().unwrap_or(true))
        .collect();
    order.sort_by_key(|&i| {
        std::cmp::Reverse(
            crate::js::get(&identified[i].1, "isoDate")
                .as_str()
                .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
                .map_or(i64::MIN, |d| d.timestamp_millis()),
        )
    });
    let send: Vec<usize> = order.into_iter().take(first_run_send).collect();
    let seen: Vec<Value> = identified
        .iter()
        .enumerate()
        .filter(|(i, (id, _))| !id.is_empty() && !send.contains(i))
        .flat_map(|(_, (id, _))| {
            std::iter::once(json!(id)).chain(aliases.get(id).map(|a| json!(a)))
        })
        .collect();
    (send, seen)
}

fn stabilize_shared_links(
    cache: &mut Map<String, Value>,
    source: &str,
    kinds: &[Target],
    identified: &mut [(String, Value)],
    label: &str,
    sent_guid: &dyn Fn(&str) -> Option<String>,
) -> bool {
    let names: Vec<String> = std::iter::once(source.to_string())
        .chain(kinds.iter().map(|t| format!("{source}::{}", t.kind())))
        .collect();
    let any_key = |cache: &Map<String, Value>, test: &dyn Fn(&str) -> bool| {
        names.iter().any(|n| {
            cache
                .get(n)
                .and_then(Value::as_array)
                .is_some_and(|l| l.iter().filter_map(Value::as_str).any(test))
        })
    };
    // Sticky: once shared, always `link#guid`.
    for (id, entry) in identified.iter_mut() {
        let Some((link, guid)) = link_and_guid(entry) else {
            continue;
        };
        let prefix = format!("{link}#");
        if *id == link && any_key(cache, &|k: &str| k.starts_with(&prefix)) {
            *id = format!("{link}#{guid}");
            entry["identityKey"] = json!(id.clone());
        }
    }
    // First time shared: the bare link in history belongs to the entry that
    // was sent under it, if the send record says which one that was.
    let mut groups: std::collections::BTreeMap<String, Vec<usize>> = Default::default();
    for (i, (id, entry)) in identified.iter().enumerate() {
        if let Some((link, guid)) = link_and_guid(entry)
            && *id == format!("{link}#{guid}")
        {
            groups.entry(link).or_default().push(i);
        }
    }
    let mut changed = false;
    for (link, members) in groups {
        let prefix = format!("{link}#");
        let needs_owner = names.iter().skip(1).any(|name| {
            cache
                .get(name)
                .and_then(Value::as_array)
                .is_some_and(|list| {
                    list.iter().any(|v| v.as_str() == Some(link.as_str()))
                        && !list
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|k| k.starts_with(&prefix))
                })
        });
        if !needs_owner {
            continue;
        }
        let proof = sent_guid(&link);
        let owner = proof.as_deref().and_then(|guid| {
            members
                .iter()
                .copied()
                .find(|&i| link_and_guid(&identified[i].1).is_some_and(|(_, g)| g == guid))
        });
        let Some(owner) = owner else {
            crate::info!(
                "Channel",
                "{label}: {} entries now share the link {}; {}, so all of them are sent",
                members.len(),
                sanitize_url(&link),
                if proof.is_some() {
                    "the one sent before is no longer in the feed"
                } else {
                    "no send record says which one was sent before"
                }
            );
            // Mark the link as shared so this is decided only once.
            for name in names.iter().skip(1) {
                if let Some(list) = cache.get(name).and_then(Value::as_array)
                    && list.iter().any(|v| v.as_str() == Some(link.as_str()))
                {
                    let marker = json!(format!("{link}#"));
                    let list = crate::state::push_cache(list, &[marker], CACHE_LIMIT);
                    cache.insert(name.clone(), Value::Array(list));
                    changed = true;
                }
            }
            continue;
        };
        let owner_id = identified[owner].0.clone();
        for name in names.iter().skip(1) {
            let Some(list) = cache.get(name).and_then(Value::as_array) else {
                continue;
            };
            let has_bare = list.iter().any(|v| v.as_str() == Some(link.as_str()));
            let has_shared = list
                .iter()
                .filter_map(Value::as_str)
                .any(|k| k.starts_with(&prefix));
            if has_bare && !has_shared {
                let list = crate::state::push_cache(list, &[json!(owner_id)], CACHE_LIMIT);
                cache.insert(name.clone(), Value::Array(list));
                changed = true;
                crate::info!(
                    "Channel",
                    "{label}: {} entries now share the link {}; the one already sent ({}) keeps its place, the others are new",
                    members.len(),
                    sanitize_url(&link),
                    crate::text::cut_text(
                        crate::js::get(&identified[owner].1, "title")
                            .as_str()
                            .unwrap_or(""),
                        80
                    )
                );
            }
        }
    }
    changed
}

/// What one fetch lists: guid aliases and every id history must keep.
struct FetchIds {
    aliases: std::collections::HashMap<String, String>,
    keep: std::collections::HashSet<String>,
}

/// `identity → guid:<guid>` for entries whose guid is not a URL and is unique
/// in the fetch (onet: UUIDs). Such an entry counts as seen under either key,
/// so a feed that changes its links but keeps its guids posts nothing twice
/// (onet did on 2026-11-24: 21 posts went out again).
fn guid_aliases(entries: &[Value], discord: bool) -> std::collections::HashMap<String, String> {
    let guid = |e: &Value| {
        crate::js::to_string_or_empty(crate::js::get(e, "guid"))
            .trim()
            .to_string()
    };
    let mut count: std::collections::HashMap<String, usize> = Default::default();
    for e in entries {
        *count.entry(guid(e)).or_default() += 1;
    }
    entries
        .iter()
        .filter_map(|e| {
            let g = guid(e);
            let id = entry_identity(e, discord);
            (!g.is_empty()
                && count.get(&g) == Some(&1)
                && !g.contains("://")
                && !id.is_empty()
                && id != g)
                .then(|| (id, format!("guid:{g}")))
        })
        .collect()
}

/// Keeps an entry's identity and its guid alias together in every bucket:
/// an entry seen under one is recorded under the other. Returns whether the
/// history changed.
fn sync_guid_aliases(
    cache: &mut Map<String, Value>,
    source: &str,
    kinds: &[Target],
    identified: &[(String, Value)],
    aliases: &std::collections::HashMap<String, String>,
    keep: &std::collections::HashSet<String>,
    label: &str,
) -> bool {
    let mut changed = false;
    for target in kinds {
        let name = format!("{source}::{}", target.kind());
        let Some(list) = cache.get(&name).and_then(Value::as_array) else {
            continue;
        };
        let has = |key: &str| list.iter().any(|v| v.as_str() == Some(key));
        let mut add: Vec<Value> = Vec::new();
        for (id, entry) in identified {
            let Some(alias) = aliases.get(id) else {
                continue;
            };
            match (has(id), has(alias)) {
                (true, false) => add.push(json!(alias)),
                (false, true) => {
                    crate::info!(
                        "Channel",
                        "{label}: {} has a new link but the same guid; not sent again",
                        crate::text::cut_text(
                            crate::js::get(entry, "title").as_str().unwrap_or(""),
                            80
                        )
                    );
                    add.push(json!(id));
                }
                _ => {}
            }
        }
        if !add.is_empty() {
            let list = crate::state::push_cache_keeping(list, &add, CACHE_LIMIT, keep);
            cache.insert(name, Value::Array(list));
            changed = true;
        }
    }
    changed
}

/// Stable sort by `isoDate`, oldest first; undated entries stay right after
/// the dated entry before them in the feed.
fn oldest_first(pending: &mut [&(String, Value)]) {
    let mut last = i64::MIN;
    let keys: Vec<i64> = pending
        .iter()
        .rev()
        .map(|(_, e)| {
            if let Some(t) = crate::js::get(e, "isoDate")
                .as_str()
                .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
            {
                last = t.timestamp_millis();
            }
            last
        })
        .collect();
    let mut keyed: Vec<(i64, usize)> = keys.into_iter().rev().zip(0..).collect();
    keyed.sort_by_key(|&(k, i)| (k, std::cmp::Reverse(i)));
    let order: Vec<&(String, Value)> = keyed.iter().map(|&(_, i)| pending[i]).collect();
    pending.copy_from_slice(&order);
}

/// The guid of the entry last sent with identity `link` (the bare link) from
/// this channel and feed, from the send records.
fn sent_guid(channel: &str, source: &str, link: &str) -> Option<String> {
    crate::sent::all()
        .into_iter()
        .rev()
        .find(|r| r.channel == channel && r.source == source && r.identity == link)
        .and_then(|r| {
            let guid = crate::js::to_string_or_empty(crate::js::get(&r.entry, "guid"));
            let guid = guid.trim();
            (!guid.is_empty()).then(|| guid.to_string())
        })
}

fn real_history(source: &str, bucket: Option<&Value>) -> bool {
    let own = crate::text::normalize_link(source);
    bucket
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|id| id.as_str() != Some(own.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One check of a feed: parse like the parsers do, stabilize, then send
    /// what is pending (recorded in history). Returns the titles sent.
    fn check(cache: &mut Map<String, Value>, items: &[(&str, &str, &str)]) -> Vec<String> {
        check_with(cache, items, &mut std::collections::HashMap::new())
    }

    /// `sent`: identity → guid of what was sent, like the send records.
    fn check_with(
        cache: &mut Map<String, Value>,
        items: &[(&str, &str, &str)],
        sent_records: &mut std::collections::HashMap<String, String>,
    ) -> Vec<String> {
        const SRC: &str = "https://feed.example/rss";
        let entries: Vec<Value> = items
            .iter()
            .map(|(title, link, date)| json!({ "title": title, "link": link, "guid": format!("g-{title}"), "isoDate": date }))
            .collect();
        let entries = crate::parsers::finish(SRC, entries);
        let mut identified: Vec<(String, Value)> = entries
            .into_iter()
            .map(|e| (entry_identity(&e, true), e))
            .collect();
        let records = sent_records.clone();
        let proof = |link: &str| records.get(link).cloned();
        stabilize_shared_links(
            cache,
            SRC,
            &[Target::Webhook],
            &mut identified,
            "test",
            &proof,
        );
        let mut sent = Vec::new();
        for (id, entry) in &identified {
            if !App::pending(cache, SRC, id, &[Target::Webhook]).is_empty() {
                sent.push(entry["title"].as_str().unwrap().to_string());
                sent_records.insert(id.clone(), entry["guid"].as_str().unwrap().to_string());
                let name = format!("{SRC}::webhook");
                let list = cache[&name].as_array().unwrap().clone();
                cache.insert(
                    name,
                    Value::Array(crate::state::push_cache(&list, &[json!(id)], CACHE_LIMIT)),
                );
            }
        }
        sent
    }

    #[test]
    fn a_hand_edited_channel_keeps_its_history() {
        let _stores = crate::GLOBAL_STORES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("xfeeder-test-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (config, cache) = (dir.join("config.json"), dir.join("cache.json"));
        let write = |feeds: &[&str]| {
            let raw = json!({ "channels": [{
                "Webhook": "https://discord.com/api/webhooks/1/abc",
                "RSS": feeds,
            }] });
            std::fs::write(&config, raw.to_string()).unwrap();
        };
        let bucket = "https://a.example/feed::webhook";
        write(&["https://a.example/feed"]);
        let app = App::new(&config, &cache, false, false).unwrap();
        let channel = app.config().channels[0].clone();
        let old = app.bucket_key(&channel);
        app.state
            .delivery
            .with(|root| root.insert(old.clone(), json!({ bucket: ["https://a.example/1"] })))
            .unwrap();
        app.state.delivery.save_blocking().unwrap();
        drop(app);
        // A feed added by hand: a new key, the same history.
        write(&["https://a.example/feed", "https://b.example/feed"]);
        let app = App::new(&config, &cache, false, false).unwrap();
        let channel = app.config().channels[0].clone();
        let new = app.bucket_key(&channel);
        assert_ne!(new, old);
        let (moved, gone) = app.state.delivery.read(|root| {
            (
                root.get(&new).and_then(|b| b.get(bucket)).cloned(),
                !root.contains_key(&old),
            )
        });
        assert_eq!(moved, Some(json!(["https://a.example/1"])));
        assert!(gone, "the old bucket is moved, not copied");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_check_records_what_the_filter_hides() {
        // F07-6: MaxAgeHours hides the old release; it must still be
        // recorded, or a later `updated` bump posts it as new.
        let identified: Vec<(String, Value)> = [
            ("https://r/new", "2026-11-27T00:00:00Z"),
            ("https://r/old", "2026-11-10T00:00:00Z"),
            ("https://r/older", "2026-11-01T00:00:00Z"),
        ]
        .iter()
        .map(|(id, date)| (id.to_string(), json!({ "isoDate": date })))
        .collect();
        let accepted = [true, false, false];
        let none = std::collections::HashMap::new();
        let (send, seen) = first_check_split(&identified, &accepted, 0, &none);
        assert!(send.is_empty());
        assert_eq!(
            seen,
            [
                json!("https://r/new"),
                json!("https://r/old"),
                json!("https://r/older")
            ]
        );
        // FirstRunSend picks among accepted entries only.
        let accepted = [false, true, false];
        let (send, seen) = first_check_split(&identified, &accepted, 1, &none);
        assert_eq!(send, [1]);
        assert_eq!(seen, [json!("https://r/new"), json!("https://r/older")]);
    }

    #[test]
    fn shared_links_send_nothing_twice_and_miss_nothing() {
        let mut cache = Map::new();
        let mut sent = std::collections::HashMap::new();
        let l = "https://kernel.example/";
        assert_eq!(
            check_with(&mut cache, &[("A", l, "2026-11-01T00:00:00Z")], &mut sent),
            ["A"]
        );
        // B appears with the same link: B is new, A was sent already.
        let ab = [
            ("B", l, "2026-11-02T00:00:00Z"),
            ("A", l, "2026-11-01T00:00:00Z"),
        ];
        assert_eq!(check_with(&mut cache, &ab, &mut sent), ["B"]);
        assert!(check_with(&mut cache, &ab, &mut sent).is_empty());
        // Back to one entry with that link: a new one is sent, an old one is not.
        assert_eq!(
            check_with(&mut cache, &[("C", l, "2026-11-03T00:00:00Z")], &mut sent),
            ["C"]
        );
        assert!(check_with(&mut cache, &[("A", l, "2026-11-01T00:00:00Z")], &mut sent).is_empty());
        assert!(check_with(&mut cache, &[("B", l, "2026-11-02T00:00:00Z")], &mut sent).is_empty());
    }

    #[test]
    fn a_feed_that_changes_its_links_but_keeps_guids_posts_nothing_twice() {
        // onet, 2026-11-24: same UUID guid, a new link format for a while.
        const SRC: &str = "https://onet.example/feed";
        let entry = |link: &str| {
            crate::parsers::finish(
                SRC,
                vec![
                    json!({ "title": "Bitwa", "link": link, "guid": "9c401436-415a-46bf-971b-dd753ed16254" }),
                ],
            )
        };
        let mut cache = Map::new();
        let kinds = [Target::Webhook];
        let name = format!("{SRC}::webhook");
        // Sent under the old link: history gets the link and the guid alias.
        let first = entry("https://onet.example/kraj/bitwa/cj9cqjm");
        let aliases = guid_aliases(&first, true);
        let id = entry_identity(&first[0], true);
        let alias = aliases.get(&id).expect("alias").clone();
        cache.insert(name.clone(), json!([id, alias]));
        // Next check: the same article under a new link.
        let second = entry("https://onet.example/1795482011830/4/kraj_bitwa_cj9cqjm");
        let aliases = guid_aliases(&second, true);
        let identified: Vec<(String, Value)> = second
            .into_iter()
            .map(|e| (entry_identity(&e, true), e))
            .collect();
        let keep = std::collections::HashSet::new();
        assert!(sync_guid_aliases(
            &mut cache,
            SRC,
            &kinds,
            &identified,
            &aliases,
            &keep,
            "t"
        ));
        assert!(App::pending(&mut cache, SRC, &identified[0].0, &kinds).is_empty());
        // Guids that are URLs or repeat in the fetch get no alias.
        let shared = vec![
            json!({ "title": "a", "link": "https://x/1", "guid": "same" }),
            json!({ "title": "b", "link": "https://x/2", "guid": "same" }),
            json!({ "title": "c", "link": "https://x/3", "guid": "https://x/3?p=1" }),
        ];
        assert!(guid_aliases(&shared, true).is_empty());
    }

    #[test]
    fn pending_entries_go_out_oldest_first() {
        let e = |id: &str, date: &str| (id.to_string(), json!({ "isoDate": date }));
        let items = [
            e("new", "2026-11-03T00:00:00Z"),
            e("undated", ""),
            e("mid", "2026-11-02T00:00:00Z"),
            e("old", "2026-11-01T00:00:00Z"),
        ];
        let mut pending: Vec<&(String, Value)> = items.iter().collect();
        oldest_first(&mut pending);
        let order: Vec<&str> = pending.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(order, ["old", "mid", "undated", "new"]);
    }

    #[test]
    fn a_new_entry_on_a_sent_link_is_never_swallowed() {
        let l = "https://kernel.example/";
        // V10 F1a: the sent entry left the feed, two new ones share its link.
        let mut cache = Map::new();
        let mut sent = std::collections::HashMap::new();
        check_with(&mut cache, &[("A", l, "2026-11-01T00:00:00Z")], &mut sent);
        let bc = [
            ("C", l, "2026-11-03T00:00:00Z"),
            ("B", l, "2026-11-02T00:00:00Z"),
        ];
        let mut got = check_with(&mut cache, &bc, &mut sent);
        got.sort();
        assert_eq!(got, ["B", "C"]);
        assert!(check_with(&mut cache, &bc, &mut sent).is_empty());
        // V10 F5 / F07: the sent entry is undated; dates never pick the owner.
        let mut cache = Map::new();
        let mut sent = std::collections::HashMap::new();
        check_with(&mut cache, &[("A", l, "2026-11-01T00:00:00Z")], &mut sent);
        let ab = [("B", l, ""), ("A", l, "2026-11-01T00:00:00Z")];
        assert_eq!(check_with(&mut cache, &ab, &mut sent), ["B"]);
        // No send record (older history): both are sent, nothing is lost.
        let mut cache = Map::new();
        check_with(
            &mut cache,
            &[("A", l, "2026-11-01T00:00:00Z")],
            &mut std::collections::HashMap::new(),
        );
        let ab = [
            ("B", l, "2026-11-02T00:00:00Z"),
            ("A", l, "2026-11-01T00:00:00Z"),
        ];
        let mut empty = std::collections::HashMap::new();
        let mut got = check_with(&mut cache, &ab, &mut empty);
        got.sort();
        assert_eq!(got, ["A", "B"]);
        assert!(check_with(&mut cache, &ab, &mut empty).is_empty());
    }

    #[test]
    fn unshared_links_keep_their_identity_when_the_guid_changes() {
        // Feeds whose guid changes on every fetch stay keyed by link alone.
        let mut cache = Map::new();
        let m = "https://site.example/post";
        assert_eq!(
            check(&mut cache, &[("one", m, "2026-11-01T00:00:00Z")]),
            ["one"]
        );
        assert!(check(&mut cache, &[("one again", m, "2026-11-01T00:00:00Z")]).is_empty());
    }

    #[test]
    fn a_history_of_only_the_feed_address_is_not_real() {
        let feed = "https://launchercontent.mojang.com/v2/javaPatchNotes.json";
        assert!(!real_history(feed, None));
        assert!(!real_history(feed, Some(&json!([]))));
        assert!(!real_history(feed, Some(&json!([feed, feed, feed]))));
        assert!(real_history(
            feed,
            Some(&json!([feed, "mojang:java:26-4-snapshot-9"]))
        ));
        assert!(real_history("https://f", Some(&json!(["a"]))));
    }

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
