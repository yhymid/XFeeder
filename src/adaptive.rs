//! Per-feed check interval (`AdaptivePolling`).
//!
//! Off unless configured. With it, each feed of a channel gets its own
//! interval, computed from the dates of the feed's own entries, so it works
//! from the first check without collecting history:
//!
//! - **after a fresh entry** (newer than `BurstHours`): `MinMinutes`, because
//!   updates come in series (patch, then hotfix);
//! - **otherwise**: the average gap between the newest entries divided by
//!   `Divisor` (a site posting every 2 h is checked every 15 min);
//! - always between `MinMinutes` and the channel's `TimeChecker`: a feed is
//!   **never checked less often than without this option** (a game updated
//!   once in six months stays at `TimeChecker`).
//!
//! ```json
//! "Settings": { "AdaptivePolling": { "Enabled": true, "MinMinutes": 5, "BurstHours": 6, "Divisor": 8 } }
//! ```
//!
//! A channel (or `ChannelDefaults`) can override it with its own object or
//! `"AdaptivePolling": false`. `false` everywhere = the previous scheduler.

use serde_json::Value;

use crate::js;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Adaptive {
    pub min_ms: u64,
    pub burst_ms: u64,
    pub divisor: u64,
}

impl Default for Adaptive {
    fn default() -> Self {
        Self {
            min_ms: 5 * 60_000,
            burst_ms: 6 * 3_600_000,
            divisor: 8,
        }
    }
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n > 0.0)
}

/// The channel's setting, else `Settings.AdaptivePolling`.
pub fn from_config(channel_raw: &Value, root: &Value) -> Option<Adaptive> {
    let own = js::get(channel_raw, "AdaptivePolling");
    let value = if own.is_null() {
        js::get(js::get(root, "Settings"), "AdaptivePolling")
    } else {
        own
    };
    match value {
        Value::Bool(true) => Some(Adaptive::default()),
        Value::Object(map) => {
            if map.get("Enabled") == Some(&Value::Bool(false)) {
                return None;
            }
            let base = Adaptive::default();
            Some(Adaptive {
                min_ms: map
                    .get("MinMinutes")
                    .and_then(number)
                    .map_or(base.min_ms, |m| (m.max(1.0) * 60_000.0) as u64),
                burst_ms: map
                    .get("BurstHours")
                    .and_then(|v| v.as_f64().filter(|n| n.is_finite() && *n >= 0.0))
                    .map_or(base.burst_ms, |h| (h * 3_600_000.0) as u64),
                divisor: map
                    .get("Divisor")
                    .and_then(number)
                    .map_or(base.divisor, |d| d.max(1.0) as u64),
            })
        }
        _ => None,
    }
}

/// How long until this feed should be checked again, and why.
///
/// `fetched_at_ms` is when the entries were read: parsers give entries
/// without a date the current time, and those are ignored here.
pub fn interval_ms(
    items: &[Value],
    fetched_at_ms: i64,
    max_ms: u64,
    adaptive: &Adaptive,
) -> (u64, &'static str) {
    let min_ms = adaptive.min_ms.min(max_ms);
    let mut dates: Vec<i64> = items
        .iter()
        .filter_map(|item| {
            let text = js::get(item, "isoDate").as_str()?;
            let ms = crate::text::parse_date_str(text)?.timestamp_millis();
            // Filled in by the parser (no date in the feed), or in the future.
            let filled = (fetched_at_ms - ms).abs() < 5_000;
            (!filled && ms <= fetched_at_ms + 3_600_000).then_some(ms)
        })
        .collect();
    dates.sort_unstable_by(|a, b| b.cmp(a));
    dates.dedup();
    let Some(&newest) = dates.first() else {
        return (max_ms, "no dated entries");
    };
    if fetched_at_ms - newest < adaptive.burst_ms as i64 {
        return (min_ms, "fresh entry");
    }
    let window = &dates[..dates.len().min(10)];
    if window.len() < 2 {
        return (max_ms, "single entry");
    }
    let span = window[0] - window[window.len() - 1];
    let gap = (span / (window.len() as i64 - 1)).max(0) as u64;
    let interval = (gap / adaptive.divisor).clamp(min_ms, max_ms);
    let reason = if interval == max_ms {
        "rarely updated"
    } else if interval == min_ms {
        "very active"
    } else {
        "average gap"
    };
    (interval, reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const H: i64 = 3_600_000;
    const MAX: u64 = 30 * 60_000;

    fn items(now: i64, ages_h: &[f64]) -> Vec<Value> {
        ages_h
            .iter()
            .map(|h| {
                let ms = now - (h * H as f64) as i64;
                json!({ "isoDate": crate::text::iso(chrono::DateTime::from_timestamp_millis(ms).unwrap()) })
            })
            .collect()
    }

    #[test]
    fn rare_feed_never_slower_than_time_checker() {
        let now = 1_800_000_000_000;
        let a = Adaptive::default();
        // L4D2: last update half a year ago, previous one a month before.
        let l4d2 = items(now, &[24.0 * 180.0, 24.0 * 210.0, 24.0 * 400.0]);
        assert_eq!(interval_ms(&l4d2, now, MAX, &a), (MAX, "rarely updated"));
        // The update arrives: checked every 5 min for the next hours.
        let updated = items(now, &[0.5, 24.0 * 180.0, 24.0 * 210.0]);
        assert_eq!(
            interval_ms(&updated, now, MAX, &a),
            (5 * 60_000, "fresh entry")
        );
        // 7 hours later the burst is over: back to TimeChecker.
        let later = items(now, &[7.0, 24.0 * 180.0, 24.0 * 210.0]);
        assert_eq!(interval_ms(&later, now, MAX, &a).0, MAX);
    }

    #[test]
    fn active_feed_is_checked_more_often() {
        let now = 1_800_000_000_000;
        let a = Adaptive::default();
        // News site: an article every ~1.5 h, newest 7 h old (night).
        let news: Vec<f64> = (0..10).map(|i| 7.0 + 1.5 * i as f64).collect();
        let (ms, why) = interval_ms(&items(now, &news), now, MAX, &a);
        assert_eq!(why, "average gap");
        assert_eq!(ms, (1.5 * H as f64) as u64 / 8); // 11.25 min
        // Undated entries (filled with "now") do not trigger the burst.
        let undated = vec![
            json!({ "isoDate": crate::text::iso(chrono::DateTime::from_timestamp_millis(now).unwrap()) }),
        ];
        assert_eq!(
            interval_ms(&undated, now, MAX, &a),
            (MAX, "no dated entries")
        );
        // MinMinutes above TimeChecker: TimeChecker wins.
        let slow = Adaptive {
            min_ms: 60 * 60_000,
            ..a
        };
        assert_eq!(interval_ms(&items(now, &[0.1]), now, MAX, &slow).0, MAX);
    }

    #[test]
    fn configuration() {
        let root =
            json!({ "Settings": { "AdaptivePolling": { "MinMinutes": 2, "BurstHours": 1 } } });
        let a = from_config(&json!({}), &root).unwrap();
        assert_eq!((a.min_ms, a.burst_ms, a.divisor), (120_000, 3_600_000, 8));
        assert_eq!(
            from_config(&json!({ "AdaptivePolling": false }), &root),
            None
        );
        assert_eq!(from_config(&json!({}), &json!({})), None);
        assert_eq!(
            from_config(&json!({ "AdaptivePolling": true }), &json!({})),
            Some(Adaptive::default())
        );
        assert_eq!(
            from_config(
                &json!({}),
                &json!({ "Settings": { "AdaptivePolling": { "Enabled": false } } })
            ),
            None
        );
    }
}
