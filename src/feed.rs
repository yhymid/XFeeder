//! Feed pipeline: conditional download → challenge detection → snapshot
//! replay → Scrapling fallback → parser chain, guarded by a per-feed,
//! persisted circuit breaker.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::diag::{expert, sanitize_url};
use crate::http::{self, HttpError};
use crate::parsers::{self, Body};
use crate::scrapling::{self, ScraplingConfig, Signals};
use crate::state::{StateStore, UnsafeState};

#[derive(Debug)]
pub enum Stop {
    Unsafe(UnsafeState),
    Cancelled,
}

impl From<UnsafeState> for Stop {
    fn from(error: UnsafeState) -> Self {
        Self::Unsafe(error)
    }
}

/// Items plus an optional failure that marks the channel run as failed
/// (backoff) without stopping other feeds of the channel.
pub struct Outcome {
    pub items: Vec<Value>,
    pub failure: Option<String>,
    /// Feed URL discovered on the configured web page, if one was used.
    /// Delivery history is kept under this URL.
    pub source: Option<String>,
}

#[derive(Debug, Default)]
struct Download {
    ok: bool,
    status: Option<u16>,
    headers: Map<String, Value>,
    data: String,
    not_modified: bool,
    scrapling: bool,
    reason: Option<&'static str>,
    error: Option<String>,
}

fn accept_auto() -> String {
    http::ACCEPT_AUTO.to_string()
}

fn looks_like_feed(body: &str) -> bool {
    let start = body.trim_start_matches('\u{feff}').trim_start();
    let lower = start
        .get(..200.min(start.len()))
        .unwrap_or(start)
        .to_ascii_lowercase();
    start.starts_with('{')
        || start.starts_with('[')
        || lower.starts_with("<?xml")
        || lower.starts_with("<rss")
        || lower.starts_with("<feed")
        || lower.starts_with("<rdf")
}

struct Ctx<'a> {
    config: &'a Config,
    base: &'a Path,
    cancel: &'a CancellationToken,
}

impl Ctx<'_> {
    fn scrapling(&self) -> (ScraplingConfig<'_>, Option<&'static scrapling::Runtime>) {
        let cfg = ScraplingConfig::new(&self.config.root);
        let runtime = if cfg.enabled() {
            scrapling::detect(self.base)
        } else {
            None
        };
        (cfg, runtime)
    }

    fn evaluate(
        &self,
        url: &str,
        status: Option<u16>,
        headers: &Map<String, Value>,
        body: &str,
    ) -> Option<Signals> {
        let (cfg, runtime) = self.scrapling();
        runtime?;
        if cfg.url_config(url).get("enabled") == Some(&Value::Bool(false)) {
            return None;
        }
        let anti = cfg.antibot(url);
        let ok_feed = status.is_some_and(|s| (200..300).contains(&s)) && looks_like_feed(body);
        // A healthy XML/JSON feed may mention "captcha" in an article; only
        // documents (or error statuses) are scanned for challenge text.
        let mut signals =
            scrapling::analyze(status, headers, if ok_feed { "" } else { body }, &anti);
        if ok_feed {
            signals.blocked = signals.status_blocked || signals.header_blocked;
        }
        signals.blocked |= parsers::is_blocked_page(body, status.unwrap_or(200), headers);
        if cfg.should_use(url, status)
            || ((cfg.auto_fallback() || cfg.url_fallback(url)) && anti.enabled && signals.blocked)
        {
            if anti.log_decisions && signals.blocked {
                crate::warn!(
                    "Scrapling AntiBot",
                    "HTTP challenge detected for {}: score={} reasons={}",
                    sanitize_url(url),
                    signals.score,
                    signals.reasons.join(", ")
                );
            }
            return Some(signals);
        }
        None
    }

    async fn with_scrapling(&self, url: &str, seed: Option<&Signals>) -> Result<Download, Stop> {
        let (cfg, runtime) = self.scrapling();
        let Some(runtime) = runtime else {
            return Ok(Download {
                reason: Some("SCRAPLING_NO_RESULT"),
                ..Default::default()
            });
        };
        let anti = cfg.antibot(url);
        let mut modes = cfg.mode_sequence(url);
        if anti.prefer_stealth
            && let Some(seed) = seed
            && (seed.cloudflare
                || seed.status_blocked
                || seed.header_blocked
                || seed.body_blocked
                || seed.title_blocked)
        {
            let mut ordered: Vec<String> = ["stealthy-fetch", "fetch"]
                .iter()
                .filter(|m| modes.iter().any(|x| x == *m))
                .map(|m| m.to_string())
                .collect();
            let rest: Vec<String> = modes
                .iter()
                .filter(|m| !ordered.contains(m))
                .cloned()
                .collect();
            ordered.extend(rest);
            modes = ordered;
        }
        let saving = self.config.network.scrapling_resource_saving;
        let mut last_error = None;
        let mut last_blocked = false;
        for mode in modes.iter().take(anti.max_attempts.max(1)) {
            let started = Instant::now();
            expert(
                "scrapling.attempt.begin",
                json!({ "url": url, "mode": mode }),
            );
            let options = scrapling::request_options(&cfg, url, mode, saving);
            let timeout_ms = options
                .get("timeoutMs")
                .map(crate::js::to_number)
                .filter(|n| n.is_finite() && *n > 0.0);
            let timeout = Duration::from_millis(
                timeout_ms.map_or(120_000.0, |t| (t + 30_000.0).clamp(10_000.0, 300_000.0)) as u64,
            );
            let _permit = http::net()
                .acquire(true, self.cancel)
                .await
                .map_err(|_| Stop::Cancelled)?;
            match scrapling::fetch(runtime, url, mode, options, timeout, self.cancel).await {
                Ok(fetched) => {
                    if self.cancel.is_cancelled() {
                        return Err(Stop::Cancelled);
                    }
                    let signals =
                        scrapling::analyze(fetched.status, &fetched.headers, &fetched.html, &anti);
                    // A real feed document is the content itself: the headers
                    // of a solved Cloudflare page still say "cloudflare" or
                    // carry `cf-mitigated` from the challenge response.
                    let feed_body = fetched.status.is_none_or(|s| (200..300).contains(&s))
                        && looks_like_feed(&fetched.html);
                    if (signals.blocked && !feed_body)
                        || parsers::is_blocked_page(
                            &fetched.html,
                            fetched.status.unwrap_or(200),
                            &fetched.headers,
                        )
                    {
                        last_blocked = true;
                        expert(
                            "scrapling.attempt.blocked",
                            json!({ "url": url, "mode": mode, "status": fetched.status, "score": signals.score, "reasons": signals.reasons, "durationMs": started.elapsed().as_millis() as u64 }),
                        );
                        if anti.log_decisions {
                            crate::warn!(
                                "Scrapling AntiBot",
                                "Mode {mode} looks blocked for {}: score={}",
                                sanitize_url(url),
                                signals.score
                            );
                        }
                        continue;
                    }
                    expert(
                        "scrapling.attempt.complete",
                        json!({ "url": url, "mode": mode, "status": fetched.status, "bodyBytes": fetched.html.len(), "durationMs": started.elapsed().as_millis() as u64 }),
                    );
                    if crate::clearance::enabled(&self.config.root) {
                        crate::clearance::save_from_browser(
                            url,
                            &fetched.cookies,
                            fetched.user_agent.as_deref(),
                        );
                    }
                    return Ok(Download {
                        ok: true,
                        status: fetched.status,
                        headers: fetched.headers,
                        data: fetched.html,
                        scrapling: true,
                        ..Default::default()
                    });
                }
                Err(error) => {
                    if self.cancel.is_cancelled() {
                        return Err(Stop::Cancelled);
                    }
                    expert(
                        "scrapling.attempt.failed",
                        json!({ "url": url, "mode": mode, "durationMs": started.elapsed().as_millis() as u64, "error": { "message": error } }),
                    );
                    if anti.log_decisions {
                        crate::warn!(
                            "Scrapling AntiBot",
                            "Mode {mode} failed for {}: {error}",
                            sanitize_url(url)
                        );
                    }
                    last_error = Some(error);
                }
            }
        }
        let reason = if last_error.is_some() {
            "SCRAPLING_ERROR"
        } else if last_blocked {
            "SCRAPLING_BLOCKED"
        } else {
            "SCRAPLING_NO_RESULT"
        };
        Ok(Download {
            reason: Some(reason),
            error: last_error,
            ..Default::default()
        })
    }

    /// Direct/Scrapling download, then the optional `Solver` backend when the
    /// feed is listed in `Solver.Feeds` or (with `Solver.Auto`) the result is
    /// a challenge or a configured error status.
    async fn download(
        &self,
        url: &str,
        validator: Option<&(String, String)>,
        allow_browser: bool,
    ) -> Result<Download, Stop> {
        let solver = crate::solver::SolverConfig::from_root(&self.config.root)
            .filter(|_| !self.config.network.public_only());
        let forced = solver.as_ref().is_some_and(|s| s.forced(url));
        if !forced {
            let dl = self.download_direct(url, validator, allow_browser).await?;
            let challenge = matches!(dl.reason, Some("ANTIBOT_CHALLENGE_UNRESOLVED"))
                || (dl.ok
                    && !dl.not_modified
                    && parsers::is_blocked_page(&dl.data, dl.status.unwrap_or(200), &dl.headers));
            let retry = !dl.ok || challenge;
            match &solver {
                Some(s) if retry && allow_browser && s.retry(dl.status, challenge) => {}
                _ => return Ok(dl),
            }
        }
        let Some(solver) = solver else {
            unreachable!("forced implies a solver")
        };
        if !allow_browser {
            return Ok(Download {
                reason: Some("SOLVER_COOLDOWN"),
                ..Default::default()
            });
        }
        let started = Instant::now();
        let _permit = http::net()
            .acquire(true, self.cancel)
            .await
            .map_err(|_| Stop::Cancelled)?;
        let result = solver.fetch(url, self.cancel).await;
        if self.cancel.is_cancelled() {
            return Err(Stop::Cancelled);
        }
        match result {
            Ok(solved)
                if (200..300).contains(&solved.status)
                    && !parsers::is_blocked_page(&solved.body, solved.status, &solved.headers) =>
            {
                crate::info!(
                    "Solver",
                    "Fetched {} through the solver ({} bytes, {}ms)",
                    sanitize_url(url),
                    solved.body.len(),
                    started.elapsed().as_millis()
                );
                Ok(Download {
                    ok: true,
                    status: Some(solved.status),
                    headers: solved.headers,
                    data: solved.body,
                    ..Default::default()
                })
            }
            Ok(solved) => {
                crate::warn!(
                    "Solver",
                    "Solver could not get {} (HTTP {})",
                    sanitize_url(url),
                    solved.status
                );
                Ok(Download {
                    status: Some(solved.status),
                    reason: Some("SOLVER_BLOCKED"),
                    error: Some(format!("solver returned HTTP {}", solved.status)),
                    ..Default::default()
                })
            }
            Err(error) => {
                crate::warn!(
                    "Solver",
                    "Solver failed for {}: {}",
                    sanitize_url(url),
                    crate::diag::sanitize_text(&error)
                );
                Ok(Download {
                    reason: Some("SOLVER_ERROR"),
                    error: Some(error),
                    ..Default::default()
                })
            }
        }
    }

    /// Plain HTTP with a saved Cloudflare clearance (see `clearance.rs`).
    /// `None` when the site rejected it: the clearance is dropped and the
    /// normal path (browser) runs.
    async fn with_clearance(
        &self,
        url: &str,
        validator: Option<&(String, String)>,
        clearance: &crate::clearance::Clearance,
    ) -> Result<Option<Download>, Stop> {
        let started = Instant::now();
        let mut headers = vec![
            ("accept".to_string(), accept_auto()),
            ("user-agent".to_string(), clearance.user_agent.clone()),
            ("cookie".to_string(), clearance.cookie.clone()),
        ];
        if let Some((etag, modified)) = validator {
            if !etag.is_empty() {
                headers.push(("if-none-match".into(), etag.clone()));
            }
            if !modified.is_empty() {
                headers.push(("if-modified-since".into(), modified.clone()));
            }
        }
        let result = http::get(http::Get {
            url,
            headers,
            cancel: self.cancel,
            timeout_ms: None,
        })
        .await;
        let status = match &result {
            Ok(r) => Some(r.status),
            Err(HttpError::Cancelled) => return Err(Stop::Cancelled),
            Err(e) => e.status(),
        };
        let accepted = result.as_ref().ok().filter(|r| {
            r.status == 304
                || ((200..300).contains(&r.status)
                    && looks_like_feed(&r.body)
                    && !parsers::is_blocked_page(&r.body, r.status, &r.headers))
        });
        let Some(response) = accepted else {
            crate::clearance::forget(url, status);
            return Ok(None);
        };
        expert(
            "clearance.reused",
            json!({ "url": url, "status": response.status, "ageMinutes": crate::clearance::age_minutes(clearance), "durationMs": started.elapsed().as_millis() as u64 }),
        );
        let response = result.expect("accepted response");
        Ok(Some(if response.status == 304 {
            Download {
                ok: true,
                status: Some(304),
                headers: response.headers,
                not_modified: true,
                ..Default::default()
            }
        } else {
            Download {
                ok: true,
                status: Some(response.status),
                headers: response.headers,
                data: response.body,
                ..Default::default()
            }
        }))
    }

    async fn download_direct(
        &self,
        url: &str,
        validator: Option<&(String, String)>,
        allow_scrapling: bool,
    ) -> Result<Download, Stop> {
        match url::Url::parse(url) {
            Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => {}
            Ok(_) => {
                return Ok(Download {
                    reason: Some("UNSUPPORTED_PROTOCOL"),
                    ..Default::default()
                });
            }
            Err(_) => {
                return Ok(Download {
                    reason: Some("INVALID_URL"),
                    ..Default::default()
                });
            }
        }
        let public_only = self.config.network.public_only();
        let (cfg, runtime) = self.scrapling();
        let per = cfg.url_config(url);
        let forced = runtime.is_some()
            && per.get("enabled") != Some(&Value::Bool(false))
            && (cfg.force_global() || per.get("enabled") == Some(&Value::Bool(true)));
        expert(
            "download.begin",
            json!({ "url": url, "forcedScrapling": forced, "scraplingEnabled": runtime.is_some() }),
        );
        if forced && public_only {
            return Ok(Download {
                reason: Some("SCRAPLING_DISALLOWED_BY_PUBLIC_ONLY"),
                ..Default::default()
            });
        }
        if !public_only
            && crate::clearance::enabled(&self.config.root)
            && let Some(clearance) = crate::clearance::get(url)
            && let Some(dl) = self.with_clearance(url, validator, &clearance).await?
        {
            return Ok(dl);
        }
        if forced && !allow_scrapling {
            return Ok(Download {
                reason: Some("SCRAPLING_COOLDOWN"),
                ..Default::default()
            });
        }
        if forced {
            let mut result = self.with_scrapling(url, None).await?;
            if !result.ok {
                result.reason = Some(if result.reason == Some("SCRAPLING_BLOCKED") {
                    "ANTIBOT_CHALLENGE_UNRESOLVED"
                } else {
                    "SCRAPLING_FORCED_FAILED"
                });
            }
            return Ok(result);
        }
        let mut headers = vec![("accept".to_string(), accept_auto())];
        if let Some((etag, modified)) = validator {
            if !etag.is_empty() {
                headers.push(("if-none-match".into(), etag.clone()));
            }
            if !modified.is_empty() {
                headers.push(("if-modified-since".into(), modified.clone()));
            }
        }
        let mut result = http::get(http::Get {
            url,
            headers: headers.clone(),
            cancel: self.cancel,
            timeout_ms: None,
        })
        .await;
        // Some servers reject feed-specific Accept headers (406/415).
        if let Err(HttpError::Status(response)) = &result
            && matches!(response.status, 406 | 415)
        {
            headers[0].1 = "*/*".into();
            result = http::get(http::Get {
                url,
                headers,
                cancel: self.cancel,
                timeout_ms: None,
            })
            .await;
        }
        let allow = !public_only && allow_scrapling;
        match result {
            Ok(response) => {
                if response.status == 304 {
                    return Ok(Download {
                        ok: true,
                        status: Some(304),
                        headers: response.headers,
                        not_modified: true,
                        ..Default::default()
                    });
                }
                if allow
                    && let Some(signals) = self.evaluate(
                        url,
                        Some(response.status),
                        &response.headers,
                        &response.body,
                    )
                {
                    expert(
                        "download.scrapling.fallback",
                        json!({ "url": url, "status": response.status, "score": signals.score, "reasons": signals.reasons }),
                    );
                    let fallback = self.with_scrapling(url, Some(&signals)).await?;
                    if fallback.ok {
                        return Ok(fallback);
                    }
                    if signals.blocked {
                        return Ok(Download {
                            status: Some(response.status),
                            reason: Some("ANTIBOT_CHALLENGE_UNRESOLVED"),
                            error: fallback.error,
                            ..Default::default()
                        });
                    }
                }
                if parsers::is_blocked_page(&response.body, response.status, &response.headers) {
                    return Ok(Download {
                        status: Some(response.status),
                        reason: Some("ANTIBOT_CHALLENGE_UNRESOLVED"),
                        ..Default::default()
                    });
                }
                Ok(Download {
                    ok: true,
                    status: Some(response.status),
                    headers: response.headers,
                    data: response.body,
                    ..Default::default()
                })
            }
            Err(HttpError::Cancelled) => Err(Stop::Cancelled),
            Err(error) => {
                if error.status() == Some(429) {
                    let response = error.response().cloned();
                    return Ok(Download {
                        status: Some(429),
                        headers: response.map(|r| r.headers).unwrap_or_default(),
                        reason: Some("HTTP_RATE_LIMITED"),
                        error: Some(error.to_string()),
                        ..Default::default()
                    });
                }
                if allow
                    && let Some(response) = error.response()
                    && let Some(signals) = self.evaluate(
                        url,
                        Some(response.status),
                        &response.headers,
                        &response.body,
                    )
                {
                    let fallback = self.with_scrapling(url, Some(&signals)).await?;
                    if fallback.ok {
                        return Ok(fallback);
                    }
                    if signals.blocked {
                        return Ok(Download {
                            status: Some(response.status),
                            reason: Some("ANTIBOT_CHALLENGE_UNRESOLVED"),
                            error: fallback.error.or(Some(error.to_string())),
                            ..Default::default()
                        });
                    }
                }
                let reason = match error {
                    HttpError::InvalidUrl(_) => "INVALID_URL",
                    HttpError::UnsupportedProtocol(_) => "UNSUPPORTED_PROTOCOL",
                    _ => "HTTP_ERROR",
                };
                Ok(Download {
                    status: error.status(),
                    reason: Some(reason),
                    error: Some(format!("{}:{}", error.code(), error)),
                    ..Default::default()
                })
            }
        }
    }
}

// --------------------------------------------------------- circuit breaker --

const FAILURE_THRESHOLD: u64 = 3;
const BROWSER_THRESHOLD: u64 = 2;
const BASE_DELAY_MS: u64 = 5 * 60 * 1000;
const MAX_DELAY_MS: u64 = 6 * 60 * 60 * 1000;
const BROWSER_COOLDOWN_MS: u64 = 30 * 60 * 1000;

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Health {
    pub consecutive_failures: u64,
    pub browser_failures: u64,
    pub next_retry_at: u64,
    pub scrapling_cooldown_until: u64,
    pub last_failure_at: u64,
    pub last_success_at: u64,
}

fn health_of(state: &Value) -> Health {
    let field = |key: &str| {
        state
            .get("health")
            .and_then(|h| h.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    Health {
        consecutive_failures: field("consecutiveFailures").min(1000),
        browser_failures: field("browserFailures").min(1000),
        next_retry_at: field("nextRetryAt"),
        scrapling_cooldown_until: field("scraplingCooldownUntil"),
        last_failure_at: field("lastFailureAt"),
        last_success_at: field("lastSuccessAt"),
    }
}

pub fn poll_delay_ms(streak: u64) -> u64 {
    if streak < FAILURE_THRESHOLD {
        return 0;
    }
    (BASE_DELAY_MS << (streak - FAILURE_THRESHOLD).min(16)).min(MAX_DELAY_MS)
}

pub struct Circuit {
    probes: Mutex<HashSet<String>>,
}

impl Circuit {
    pub fn new() -> Self {
        Self {
            probes: Mutex::new(HashSet::new()),
        }
    }

    async fn store(state: &StateStore, url: &str, health: Health) -> Result<(), UnsafeState> {
        let mut record = state
            .feed_state(url)
            .as_object()
            .cloned()
            .unwrap_or_default();
        record.insert(
            "health".into(),
            serde_json::to_value(health).unwrap_or_default(),
        );
        state.set_feed_state(url, Value::Object(record)).await
    }

    async fn succeeded(state: &StateStore, url: &str) -> Result<(), UnsafeState> {
        let health = health_of(&state.feed_state(url));
        if health.consecutive_failures == 0
            && health.browser_failures == 0
            && health.next_retry_at == 0
            && health.scrapling_cooldown_until == 0
        {
            return Ok(());
        }
        let updated = Health {
            consecutive_failures: 0,
            browser_failures: 0,
            next_retry_at: 0,
            scrapling_cooldown_until: 0,
            last_success_at: now_ms(),
            ..health
        };
        Self::store(state, url, updated).await?;
        expert(
            "feed.circuit.recovered",
            json!({ "url": url, "status": "Healthy" }),
        );
        Ok(())
    }

    async fn failed(
        state: &StateStore,
        url: &str,
        reason: &str,
        scrapling: bool,
    ) -> Result<(), UnsafeState> {
        let health = health_of(&state.feed_state(url));
        let at = now_ms();
        let streak = (health.consecutive_failures + 1).min(1000);
        let browser = scrapling
            || [
                "SCRAPLING",
                "SOLVER",
                "ANTIBOT",
                "CHALLENGE",
                "BLOCKED_PAGE",
            ]
            .iter()
            .any(|k| reason.to_uppercase().contains(k));
        let browser_failures = if browser {
            (health.browser_failures + 1).min(1000)
        } else {
            health.browser_failures
        };
        let delay = poll_delay_ms(streak);
        let cooldown = if browser_failures >= BROWSER_THRESHOLD {
            at + BROWSER_COOLDOWN_MS
        } else {
            0
        };
        let updated = Health {
            consecutive_failures: streak,
            browser_failures,
            next_retry_at: if delay > 0 { at + delay } else { 0 },
            scrapling_cooldown_until: health.scrapling_cooldown_until.max(cooldown),
            last_failure_at: at,
            ..health
        };
        Self::store(state, url, updated).await?;
        if delay > 0 {
            expert(
                "retry.scheduled",
                json!({ "url": url, "delayMs": delay, "retryAt": updated.next_retry_at }),
            );
        }
        expert(
            "feed.circuit.failed",
            json!({ "url": url, "streak": streak }),
        );
        Ok(())
    }
}

// ---------------------------------------------------------------- pipeline --

pub struct Pipeline<'a> {
    pub config: &'a Config,
    pub state: &'a StateStore,
    pub circuit: &'a Circuit,
    pub base: &'a Path,
    pub cancel: &'a CancellationToken,
}

fn header(headers: &Map<String, Value>, name: &str) -> String {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| crate::js::to_string(v))
        .unwrap_or_default()
}

impl Pipeline<'_> {
    pub async fn fetch(&self, url: &str) -> Result<Outcome, Stop> {
        let health = health_of(&self.state.feed_state(url));
        let at = now_ms();
        let probe = health.consecutive_failures >= FAILURE_THRESHOLD;
        {
            let mut probes = self.circuit.probes.lock().expect("lock");
            if health.next_retry_at > at || probes.contains(url) {
                expert(
                    "feed.circuit.suppressed",
                    json!({ "url": url, "status": "Paused", "retryAt": health.next_retry_at }),
                );
                return Ok(Outcome {
                    items: Vec::new(),
                    failure: None,
                    source: None,
                });
            }
            if probe {
                probes.insert(url.to_string());
            }
        }
        let allow_scrapling = health.scrapling_cooldown_until <= at;
        let mut discovered = None;
        let result = self.fetch_core(url, allow_scrapling, &mut discovered).await;
        if probe {
            self.circuit.probes.lock().expect("lock").remove(url);
        }
        let (mut outcome, report) = result?;
        outcome.source = discovered;
        match report {
            Some((reason, scrapling)) => {
                Circuit::failed(self.state, url, &reason, scrapling).await?
            }
            None => Circuit::succeeded(self.state, url).await?,
        }
        Ok(outcome)
    }

    async fn save(&self, url: &str, dl: &Download, items: &[Value]) -> Result<(), Stop> {
        if self.cancel.is_cancelled() {
            return Err(Stop::Cancelled);
        }
        if dl.ok && dl.status != Some(304) && self.state.persist {
            self.state
                .set_feed_snapshot(
                    url,
                    &header(&dl.headers, "etag"),
                    &header(&dl.headers, "last-modified"),
                    items,
                )
                .await?;
        } else if dl.ok && dl.status != Some(304) {
            // Dry runs never persist snapshots.
        }
        Ok(())
    }

    /// Returns the outcome and, when the feed failed, the circuit reason.
    async fn fetch_core(
        &self,
        url: &str,
        allow_scrapling: bool,
        discovered: &mut Option<String>,
    ) -> Result<(Outcome, Option<(String, bool)>), Stop> {
        let started = Instant::now();
        let validator = self.state.validator(url);
        expert(
            "feed.begin",
            json!({ "url": url, "hasEtag": validator.as_ref().is_some_and(|v| !v.0.is_empty()), "hasLastModified": validator.as_ref().is_some_and(|v| !v.1.is_empty()) }),
        );
        let ctx = Ctx {
            config: self.config,
            base: self.base,
            cancel: self.cancel,
        };
        let mut dl = ctx
            .download(url, validator.as_ref(), allow_scrapling)
            .await?;
        // A web page instead of a feed: follow the feed it advertises.
        if dl.ok
            && !dl.not_modified
            && !looks_like_feed(&dl.data)
            && let Some(found) = parsers::discover_feed(url, &dl.data)
        {
            let next = ctx.download(&found, None, allow_scrapling).await?;
            if next.ok && looks_like_feed(&next.data) {
                crate::info!(
                    "Feed pipeline",
                    "{} is a web page; using the feed it advertises: {} (put that URL in config.json to skip this step)",
                    sanitize_url(url),
                    sanitize_url(&found)
                );
                // Validators of the discovered feed must not be sent to the page.
                dl = Download {
                    headers: Map::new(),
                    ..next
                };
                *discovered = Some(found);
            }
        }
        expert(
            "feed.download.complete",
            json!({
                "url": url, "ok": dl.ok, "status": dl.status, "reason": dl.reason, "bodyBytes": dl.data.len(),
                "notModified": dl.not_modified, "scrapling": dl.scrapling, "elapsedMs": started.elapsed().as_millis() as u64,
                "cacheControl": header(&dl.headers, "cache-control"),
                "hasValidators": !header(&dl.headers, "etag").is_empty() || !header(&dl.headers, "last-modified").is_empty(),
                "sentValidator": validator.is_some(),
            }),
        );
        let blocked = dl.ok
            && !dl.not_modified
            && parsers::is_blocked_page(&dl.data, dl.status.unwrap_or(200), &dl.headers);
        if blocked
            || matches!(
                dl.reason,
                Some("ANTIBOT_CHALLENGE_UNRESOLVED" | "SCRAPLING_BLOCKED")
            )
        {
            expert(
                "feed.blocked_page",
                json!({ "url": url, "status": dl.status, "reason": dl.reason }),
            );
            crate::warn!(
                "Feed pipeline",
                "{} returned a challenge/block page ({}); no entries this time",
                sanitize_url(url),
                dl.reason.unwrap_or("ANTIBOT_CHALLENGE_UNRESOLVED")
            );
            let reason = dl
                .reason
                .unwrap_or("ANTIBOT_CHALLENGE_UNRESOLVED")
                .to_string();
            return Ok((
                Outcome {
                    items: Vec::new(),
                    failure: Some("Challenge/error page rejected".into()),
                    source: None,
                },
                Some((reason, dl.scrapling)),
            ));
        }
        if dl.ok && dl.not_modified {
            let items = self.state.feed_items(url);
            expert(
                "feed.not_modified",
                json!({ "url": url, "replayedItems": items.len(), "durationMs": started.elapsed().as_millis() as u64 }),
            );
            return Ok((
                Outcome {
                    items,
                    failure: None,
                    source: None,
                },
                None,
            ));
        }
        if !dl.ok && matches!(dl.reason, Some("INVALID_URL" | "UNSUPPORTED_PROTOCOL")) {
            crate::warn!(
                "Feed pipeline",
                "Unsupported feed source {} ({})",
                sanitize_url(url),
                dl.reason.unwrap_or_default()
            );
            return Ok((
                Outcome {
                    items: Vec::new(),
                    failure: None,
                    source: None,
                },
                Some((dl.reason.unwrap_or_default().to_string(), false)),
            ));
        }
        if !dl.ok {
            let reason = dl.reason.unwrap_or("REQUEST_FAILED");
            let message = dl.error.clone().unwrap_or_else(|| reason.to_string());
            let items = self.state.feed_items(url);
            crate::warn!(
                "Feed pipeline",
                "Feed download failed for {}; replaying {} saved entries ({})",
                sanitize_url(url),
                items.len(),
                crate::diag::sanitize_text(&message)
            );
            expert(
                "feed.skipped",
                json!({ "url": url, "reason": reason, "replayedItems": items.len(), "durationMs": started.elapsed().as_millis() as u64 }),
            );
            return Ok((
                Outcome {
                    items,
                    failure: Some(message),
                    source: None,
                },
                Some((reason.to_string(), dl.scrapling)),
            ));
        }
        let parse_started = Instant::now();
        if dl.scrapling && scrapling::detect_format(&dl.data) == "html" {
            let cfg = ScraplingConfig::new(&self.config.root);
            let options = cfg
                .url_config(url)
                .get("htmlParseOptions")
                .cloned()
                .unwrap_or(Value::Null);
            let items = scrapling::html_to_items(&dl.data, &options);
            if !items.is_empty() {
                crate::info!(
                    "Feed pipeline",
                    "Scrapling HTML parsed {} entries from {}",
                    items.len(),
                    sanitize_url(url)
                );
                expert(
                    "feed.parsed",
                    json!({ "url": url, "parser": "scrapling-html", "itemCount": items.len(), "durationMs": started.elapsed().as_millis() as u64, "parseMs": parse_started.elapsed().as_millis() as u64 }),
                );
                self.save(url, &dl, &items).await?;
                return Ok((
                    Outcome {
                        items,
                        failure: None,
                        source: None,
                    },
                    None,
                ));
            }
        }
        if self.cancel.is_cancelled() {
            return Err(Stop::Cancelled);
        }
        let body = Body::new(dl.data.clone());
        for (name, parser) in parsers::PARSERS {
            expert("feed.parser.begin", json!({ "url": url, "parser": name }));
            let items = parser(url, &body);
            if !items.is_empty() {
                crate::info!(
                    &format!("Parser:{name}"),
                    "Success ({}) → {}",
                    items.len(),
                    sanitize_url(url)
                );
                expert(
                    "feed.parsed",
                    json!({ "url": url, "parser": name, "itemCount": items.len(), "durationMs": started.elapsed().as_millis() as u64, "parseMs": parse_started.elapsed().as_millis() as u64 }),
                );
                self.save(url, &dl, &items).await?;
                return Ok((
                    Outcome {
                        items,
                        failure: None,
                        source: None,
                    },
                    None,
                ));
            }
            expert(
                "feed.parser.no_match",
                json!({ "url": url, "parser": name }),
            );
        }
        let items = parsers::regex_items(&dl.data);
        if !items.is_empty() {
            expert(
                "feed.parsed",
                json!({ "url": url, "parser": "rss-regex", "itemCount": items.len(), "durationMs": started.elapsed().as_millis() as u64, "parseMs": parse_started.elapsed().as_millis() as u64 }),
            );
            self.save(url, &dl, &items).await?;
            return Ok((
                Outcome {
                    items,
                    failure: None,
                    source: None,
                },
                None,
            ));
        }
        if parsers::is_feed_document(&body) {
            crate::info!(
                "Feed pipeline",
                "Feed has no entries: {}",
                sanitize_url(url)
            );
        } else {
            crate::warn!("Feed pipeline", "No data from feed {}", sanitize_url(url));
        }
        expert(
            "feed.empty",
            json!({ "url": url, "durationMs": started.elapsed().as_millis() as u64 }),
        );
        Ok((
            Outcome {
                items: Vec::new(),
                failure: None,
                source: None,
            },
            None,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule() {
        assert_eq!(poll_delay_ms(2), 0);
        assert_eq!(poll_delay_ms(3), BASE_DELAY_MS);
        assert_eq!(poll_delay_ms(4), BASE_DELAY_MS * 2);
        assert_eq!(poll_delay_ms(40), MAX_DELAY_MS);
    }
}
