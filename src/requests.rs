//! Requests from the dashboard to the running worker.
//!
//! The worker keeps `cache.json` in memory and rewrites it after every
//! send, so the dashboard must not edit it. Instead it drops one small JSON
//! file per request into `requests/` next to `config.json`; the worker picks
//! them up on its next scheduler tick, applies them to its own state and
//! deletes them. One file per request means no read-modify-write races, and
//! both kinds of request are idempotent.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    /// Run the channel (`cache_key`) now, all its feeds included.
    Check { channel: String },
    /// Drop one remembered entry so it can be posted again:
    /// `bucket` is the channel's key in cache.json, `feed` the
    /// `url::target` list, `id` the remembered value.
    Forget {
        bucket: String,
        feed: String,
        id: String,
    },
}

const MAX_FILE: u64 = 64 * 1024;
const MAX_PER_TICK: usize = 100;

pub fn dir_for(config_path: &Path) -> PathBuf {
    crate::config::absolute(config_path)
        .parent()
        .map_or_else(|| PathBuf::from("requests"), |d| d.join("requests"))
}

/// Queue a request (dashboard side).
pub fn submit(dir: &Path, request: &Request) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let name = format!(
        "{}-{}.json",
        chrono::Utc::now().timestamp_millis(),
        hex::encode(rand::random::<[u8; 4]>())
    );
    let text = serde_json::to_vec(request).map_err(std::io::Error::other)?;
    crate::state::write_atomic(&dir.join(name), &text, 0o600)
}

/// Waiting requests, oldest first (both sides). Unreadable or invalid files
/// are removed so they cannot block the queue.
pub fn pending(dir: &Path) -> Vec<(PathBuf, Request)> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .take(MAX_PER_TICK)
        .filter_map(|path| {
            let parsed = std::fs::metadata(&path)
                .ok()
                .filter(|m| m.is_file() && m.len() <= MAX_FILE)
                .and_then(|_| std::fs::read(&path).ok())
                .and_then(|bytes| serde_json::from_slice::<Request>(&bytes).ok());
            match parsed {
                Some(request) => Some((path, request)),
                None => {
                    crate::warn!(
                        "Requests",
                        "Ignoring invalid request file {}",
                        path.display()
                    );
                    let _ = std::fs::remove_file(&path);
                    None
                }
            }
        })
        .collect()
}

pub fn done(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_then_pending_in_order_and_invalid_files_dropped() {
        let dir = std::env::temp_dir().join(format!("xf-requests-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let check = Request::Check {
            channel: "channels:abc".into(),
        };
        let forget = Request::Forget {
            bucket: "channels:abc".into(),
            feed: "https://a.example/feed::webhook".into(),
            id: "https://a.example/1".into(),
        };
        submit(&dir, &check).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        submit(&dir, &forget).unwrap();
        std::fs::write(dir.join("0-bad.json"), "{nope").unwrap();
        let got = pending(&dir);
        assert_eq!(
            got.iter().map(|(_, r)| r.clone()).collect::<Vec<_>>(),
            [check, forget]
        );
        assert!(!dir.join("0-bad.json").exists(), "invalid request removed");
        for (path, _) in got {
            done(&path);
        }
        assert!(pending(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
