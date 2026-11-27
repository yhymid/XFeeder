//! Live mode for `steampics://` (`Settings.SteamPics.Live`, build feature
//! `live-pics`).
//!
//! An anonymous Steam connection (steam-vent) asks every ~10 s which apps
//! changed since the last change number (`PICSChangesSince`). When one of
//! the configured apps changed, it wakes the normal SteamCMD run at once
//! instead of waiting for `MinIntervalMinutes`. Nothing else changes: the
//! SteamCMD run (with `Login`, when set) reads the app info, compares it with
//! the saved state and makes the posts, so live mode cannot post twice or
//! post anything SteamCMD would not. If the connection fails, it reconnects
//! with a growing pause, and the normal interval keeps working meanwhile.
//!
//! Wakes are at least `LiveMinSeconds` (120) apart: changes in between are
//! collected and sent with the next wake. When Steam says the change number
//! is too old (`force_full_*`, after a long pause), every app is woken.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use serde_json::json;
use steam_vent::{Connection, ConnectionTrait, ServerList};
use steam_vent_proto_steam::steammessages_clientserver_appinfo::{
    CMsgClientPICSChangesSinceRequest, CMsgClientPICSChangesSinceResponse,
};
use tokio_util::sync::CancellationToken;

const POLL: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BACKOFF_SECS: u64 = 60;

async fn since(
    connection: &Connection,
    n: u32,
) -> Result<CMsgClientPICSChangesSinceResponse, String> {
    let job = connection.job(CMsgClientPICSChangesSinceRequest {
        since_change_number: Some(n),
        send_app_info_changes: Some(true),
        send_package_info_changes: Some(false),
        ..Default::default()
    });
    match tokio::time::timeout(REQUEST_TIMEOUT, job).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(format!("{error:?}")),
        Err(_) => Err("no answer within 15 s".into()),
    }
}

async fn connect() -> Result<Connection, String> {
    let list = tokio::time::timeout(CONNECT_TIMEOUT, ServerList::discover())
        .await
        .map_err(|_| "server list: no answer within 30 s".to_string())?
        .map_err(|e| format!("server list: {e:?}"))?;
    tokio::time::timeout(CONNECT_TIMEOUT, Connection::anonymous(&list))
        .await
        .map_err(|_| "logon: no answer within 30 s".to_string())?
        .map_err(|e| format!("logon: {e:?}"))
}

/// ±50 % jitter so several instances do not reconnect in step.
fn jitter(base: Duration) -> Duration {
    let factor = 0.5 + rand::random::<f64>();
    base.mul_f64(factor)
}

/// Poll pause: never below `POLL` (Steam silently drops faster polling).
fn poll_pause() -> Duration {
    POLL.mul_f64(1.0 + rand::random::<f64>() * 0.5)
}

/// Kept across connections: the last change number asked for and the apps
/// that changed but were not woken yet, so a reconnect loses nothing (an N
/// that is too old makes Steam answer `force_full_*`: every app is woken).
#[derive(Default)]
struct Progress {
    n: u32,
    waiting: BTreeSet<u32>,
    last_wake: Option<Instant>,
}

enum End {
    Stopped,
    TurnedOff,
    Lost(String),
}

async fn pause(duration: Duration, stop: &CancellationToken) -> bool {
    tokio::select! {
        () = tokio::time::sleep(duration) => true,
        () = stop.cancelled() => false,
    }
}

/// Runs until `stop` is cancelled. Idle (no connection) while live mode is
/// off or no `steampics://` source has been checked yet.
pub async fn run(stop: CancellationToken) {
    let mut attempt: u32 = 0;
    let mut progress = Progress::default();
    let mut warned = false;
    loop {
        if stop.is_cancelled() {
            return;
        }
        let (enabled, _) = crate::steam_pics::live_settings();
        if crate::steam_pics::live_requested() && !enabled && !warned {
            warned = true;
            crate::warn!(
                "SteamLive",
                "Settings.SteamPics.Live is on, but this build has no live mode (build with --features live-pics)"
            );
        }
        if !enabled || crate::steam_pics::tracked().is_empty() {
            if !pause(POLL, &stop).await {
                return;
            }
            continue;
        }
        let started = Instant::now();
        match connect().await {
            Err(error) => {
                crate::warn!("SteamLive", "cannot connect to Steam: {error}");
                crate::steam_pics::set_live_status(|s| {
                    s.insert("connected".into(), json!(false));
                    s.insert("error".into(), json!(error));
                });
                crate::diag::expert(
                    "pics_live.disconnected",
                    json!({ "error": error, "uptimeS": 0 }),
                );
            }
            Ok(connection) => {
                crate::info!(
                    "SteamLive",
                    "connected to Steam (anonymous); asking for changes every ~10 s"
                );
                crate::steam_pics::set_live_status(|s| {
                    s.insert("connected".into(), json!(true));
                    s.insert("connectedAt".into(), json!(crate::text::now_iso()));
                    s.remove("error");
                });
                crate::diag::expert(
                    "pics_live.connected",
                    json!({ "cell": connection.cell_id(), "logonMs": started.elapsed().as_millis() as u64 }),
                );
                let end = poll(&connection, &mut progress, &stop).await;
                let uptime = started.elapsed().as_secs();
                if uptime > 300 {
                    attempt = 0;
                }
                let error = match &end {
                    End::Lost(e) => e.clone(),
                    End::TurnedOff => "live mode turned off".into(),
                    End::Stopped => "stopped".into(),
                };
                crate::steam_pics::set_live_status(|s| {
                    s.insert("connected".into(), json!(false));
                    s.insert("error".into(), json!(error));
                });
                match end {
                    End::Stopped => return,
                    // Off in the config: idle until it is turned on again.
                    End::TurnedOff => {
                        attempt = 0;
                        continue;
                    }
                    End::Lost(error) => {
                        crate::warn!(
                            "SteamLive",
                            "connection lost after {uptime} s: {error}; reconnecting"
                        );
                        crate::diag::expert(
                            "pics_live.disconnected",
                            json!({ "error": error, "uptimeS": uptime }),
                        );
                    }
                }
            }
        }
        attempt = attempt.saturating_add(1);
        let delay = jitter(Duration::from_secs(
            (1u64 << attempt.min(6)).min(MAX_BACKOFF_SECS),
        ));
        crate::diag::expert(
            "pics_live.reconnect_backoff",
            json!({ "delayS": delay.as_secs(), "attempt": attempt }),
        );
        if !pause(delay, &stop).await {
            return;
        }
    }
}

/// Polls one connection until it fails, live mode is turned off or `stop`.
async fn poll(connection: &Connection, progress: &mut Progress, stop: &CancellationToken) -> End {
    if progress.n == 0 {
        progress.n = match since(connection, 0).await {
            Ok(r) => r.current_change_number(),
            Err(error) => return End::Lost(error),
        };
    }
    let mut failures = 0;
    loop {
        if !pause(poll_pause(), stop).await {
            return End::Stopped;
        }
        let (enabled, min_gap) = crate::steam_pics::live_settings();
        if !enabled {
            crate::info!("SteamLive", "live mode turned off; disconnecting");
            return End::TurnedOff;
        }
        let n = progress.n;
        let started = Instant::now();
        let response = match since(connection, n).await {
            Ok(r) => {
                failures = 0;
                r
            }
            Err(error) => {
                failures += 1;
                // A closed connection fails at once; a lost one times out.
                if failures >= 2 || error.contains("Closed") || error.contains("AlreadyClosed") {
                    return End::Lost(error);
                }
                continue;
            }
        };
        let tracked = crate::steam_pics::tracked();
        let current = response.current_change_number();
        let full = response.force_full_update() || response.force_full_app_update() || current < n;
        if full {
            crate::info!(
                "SteamLive",
                "Steam cannot list changes since {n} (now {current}); checking every app"
            );
            crate::diag::expert("pics_live.gap", json!({ "n": n, "current": current }));
            progress.waiting.extend(tracked.iter().copied());
        } else {
            progress.waiting.extend(
                response
                    .app_changes
                    .iter()
                    .map(|a| a.appid())
                    .filter(|id| tracked.contains(id)),
            );
        }
        crate::diag::expert(
            "pics_live.poll",
            json!({ "latencyMs": started.elapsed().as_millis() as u64, "appChanges": response.app_changes.len(),
                    "waiting": progress.waiting.len(), "n": n, "current": current }),
        );
        progress.n = if full { current } else { current.max(n) };
        crate::steam_pics::set_live_status(|s| {
            s.insert("lastPollAt".into(), json!(crate::text::now_iso()));
            s.insert("changeNumber".into(), json!(progress.n));
        });
        if !progress.waiting.is_empty() && progress.last_wake.is_none_or(|t| t.elapsed() >= min_gap)
        {
            let apps: Vec<u32> = progress.waiting.iter().copied().collect();
            crate::info!(
                "SteamLive",
                "change seen for {} app(s) ({}); checking now",
                apps.len(),
                apps.iter()
                    .take(8)
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            crate::diag::expert("pics_live.wake", json!({ "apps": apps }));
            crate::steam_pics::wake(&apps);
            crate::steam_pics::set_live_status(|s| {
                s.insert("lastWakeAt".into(), json!(crate::text::now_iso()));
                let wakes = s
                    .get("wakes")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                s.insert("wakes".into(), json!(wakes + 1));
            });
            progress.waiting.clear();
            progress.last_wake = Some(Instant::now());
        }
    }
}
