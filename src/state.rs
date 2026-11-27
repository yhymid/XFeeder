//! Durable state. `cache.json` holds delivery identities per channel and
//! target bucket; `cache.feeds.json` holds conditional-request validators,
//! replay snapshots and per-feed health. Both are compatible with XFeeder
//! 2.x/3.0 files. A store that cannot be read or written safely is latched
//! "unsafe" and all further delivery stops (no silent resets → no duplicates).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::js::Obj;

pub const META_KEY: &str = "__xfeeder";

#[derive(Debug, Clone)]
pub struct UnsafeState(pub String);

impl std::fmt::Display for UnsafeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UnsafeState {}

pub struct JsonStore {
    path: PathBuf,
    data: Mutex<Obj>,
    blocked: Mutex<Option<String>>,
    /// Serializes writers so an older snapshot never overwrites a newer one.
    write_lock: tokio::sync::Mutex<u64>,
}

fn sync_dir(dir: &Path) -> std::io::Result<()> {
    match std::fs::File::open(dir).and_then(|f| f.sync_all()) {
        Ok(()) => Ok(()),
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(libc::EINVAL | libc::ENOTSUP | libc::EISDIR | libc::EBADF | libc::EPERM)
            ) =>
        {
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Atomic replace: exclusive temp file (0600), fsync, rename, fsync dir.
pub fn write_atomic(path: &Path, content: &[u8], mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let temp = dir.join(format!(
        "{name}.{}.{}.tmp",
        std::process::id(),
        hex::encode(rand::random::<[u8; 6]>())
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temp)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)?;
        sync_dir(dir)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

impl JsonStore {
    pub fn open(path: &Path) -> Result<Self, UnsafeState> {
        let data = Self::load(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            data: Mutex::new(data),
            blocked: Mutex::new(None),
            write_lock: tokio::sync::Mutex::new(0),
        })
    }

    fn load(path: &Path) -> Result<Obj, UnsafeState> {
        let display = path.display();
        let original = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let dir = path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."));
                let prefix = format!(
                    "{}.corrupt-",
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("")
                );
                let quarantined = std::fs::read_dir(dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix));
                if quarantined {
                    return Err(UnsafeState(format!(
                        "Missing {display} with quarantined state present; restore a verified cache before restarting."
                    )));
                }
                return Ok(Obj::new());
            }
            Err(error) => {
                return Err(UnsafeState(format!(
                    "Cannot read {display}; refusing to start or overwrite delivery state: {error}"
                )));
            }
        };
        match serde_json::from_slice::<Value>(&original) {
            Ok(Value::Object(map)) => Ok(map),
            _ => {
                // Content-addressed quarantine: restarts never multiply copies,
                // and the original file is never renamed or replaced.
                let quarantine = PathBuf::from(format!(
                    "{}.corrupt-{}",
                    path.display(),
                    hex::encode(Sha256::digest(&original))
                ));
                use std::os::unix::fs::OpenOptionsExt;
                match std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&quarantine)
                {
                    Ok(mut file) => {
                        if let Err(e) = file.write_all(&original) {
                            return Err(UnsafeState(format!(
                                "Invalid {display}; quarantine could not be preserved ({e}). Startup blocked."
                            )));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        if std::fs::read(&quarantine).ok().as_deref() != Some(&original[..]) {
                            return Err(UnsafeState(format!(
                                "Invalid {display}; quarantine collision. Original retained; startup blocked."
                            )));
                        }
                    }
                    Err(e) => {
                        return Err(UnsafeState(format!(
                            "Invalid {display}; quarantine could not be preserved ({e}). Startup blocked."
                        )));
                    }
                }
                Err(UnsafeState(format!(
                    "Invalid {display}; original retained and quarantined at {}. Restore a verified cache before restarting; delivery is blocked to prevent duplicates.",
                    quarantine.display()
                )))
            }
        }
    }

    pub fn check(&self) -> Result<(), UnsafeState> {
        match self.blocked.lock().expect("lock").as_ref() {
            Some(message) => Err(UnsafeState(message.clone())),
            None => Ok(()),
        }
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut Obj) -> R) -> Result<R, UnsafeState> {
        self.check()?;
        Ok(f(&mut self.data.lock().expect("lock")))
    }

    pub fn read<R>(&self, f: impl FnOnce(&Obj) -> R) -> R {
        f(&self.data.lock().expect("lock"))
    }

    fn snapshot(&self) -> Vec<u8> {
        let data = self.data.lock().expect("lock");
        serde_json::to_vec_pretty(&*data).unwrap_or_default()
    }

    fn block(&self, message: String) -> UnsafeState {
        crate::error!("Cache", "{message}");
        *self.blocked.lock().expect("lock") = Some(message.clone());
        UnsafeState(message)
    }

    /// Snapshot now, write in order; a failure latches the store as unsafe.
    pub async fn save(&self) -> Result<(), UnsafeState> {
        self.check()?;
        let snapshot = self.snapshot();
        let mut guard = self.write_lock.lock().await;
        *guard += 1;
        self.check()?;
        let path = self.path.clone();
        let result =
            tokio::task::spawn_blocking(move || write_atomic(&path, &snapshot, 0o600)).await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(self.block(format!("Cannot persist {}; delivery state is now unsafe. Refusing further operation. ({e})", self.path.display()))),
            Err(e) => Err(self.block(format!("Cannot persist {}: {e}", self.path.display()))),
        }
    }

    pub fn save_blocking(&self) -> Result<(), UnsafeState> {
        self.check()?;
        let snapshot = self.snapshot();
        write_atomic(&self.path, &snapshot, 0o600).map_err(|e| {
            self.block(format!(
                "Cannot persist {}; delivery state is now unsafe. ({e})",
                self.path.display()
            ))
        })
    }
}

pub fn feed_state_path(cache_path: &Path) -> PathBuf {
    let stem = cache_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("cache");
    cache_path.with_file_name(format!("{stem}.feeds.json"))
}

pub struct StateStore {
    pub delivery: JsonStore,
    pub feeds: JsonStore,
    pub persist: bool,
}

fn snapshots_mut(map: &mut Obj) -> &mut Obj {
    let meta = map
        .entry(META_KEY)
        .or_insert_with(|| Value::Object(Map::new()));
    if !meta.is_object() {
        *meta = Value::Object(Map::new());
    }
    let snaps = meta
        .as_object_mut()
        .expect("object")
        .entry("feedSnapshots")
        .or_insert_with(|| Value::Object(Map::new()));
    if !snaps.is_object() {
        *snaps = Value::Object(Map::new());
    }
    snaps.as_object_mut().expect("object")
}

impl StateStore {
    pub fn open(cache_path: &Path, persist: bool) -> Result<Self, UnsafeState> {
        let feeds_path = feed_state_path(cache_path);
        if crate::config::absolute(cache_path) == crate::config::absolute(&feeds_path) {
            return Err(UnsafeState(
                "Feed state must not share the delivery cache path".into(),
            ));
        }
        let store = Self {
            delivery: JsonStore::open(cache_path)?,
            feeds: JsonStore::open(&feeds_path)?,
            persist,
        };
        store.migrate_legacy_snapshots()?;
        if persist {
            let channels = store
                .delivery
                .read(|m| m.keys().filter(|k| *k != META_KEY).count());
            crate::info!("Cache", "Loaded ({channels} channels)");
        }
        Ok(store)
    }

    /// 2.x kept feed snapshots inside cache.json; move them to the feed store
    /// (written first, so an interrupted migration never loses them).
    fn migrate_legacy_snapshots(&self) -> Result<(), UnsafeState> {
        let legacy = self.delivery.read(|m| {
            m.get(META_KEY)
                .and_then(|meta| meta.get("feedSnapshots"))
                .and_then(Value::as_object)
                .cloned()
        });
        let Some(legacy) = legacy else { return Ok(()) };
        if !self.persist {
            return Ok(());
        }
        let added = self.feeds.with(|feeds| {
            let target = snapshots_mut(feeds);
            let mut added = false;
            for (url, snapshot) in legacy {
                if !target.contains_key(&url) {
                    target.insert(url, snapshot);
                    added = true;
                }
            }
            added
        })?;
        if added {
            self.feeds.save_blocking()?;
        }
        self.delivery.with(|map| {
            if let Some(Value::Object(meta)) = map.get_mut(META_KEY) {
                meta.remove("feedSnapshots");
                if meta.is_empty() {
                    map.remove(META_KEY);
                }
            }
        })?;
        self.delivery.save_blocking()
    }

    pub fn usable(&self) -> bool {
        self.delivery.check().is_ok() && self.feeds.check().is_ok()
    }

    pub fn feed_state(&self, url: &str) -> Value {
        let lookup = |map: &Obj| {
            map.get(META_KEY)
                .and_then(|m| m.get("feedSnapshots"))
                .and_then(|s| s.get(url))
                .cloned()
        };
        self.feeds
            .read(lookup)
            .or_else(|| self.delivery.read(lookup))
            .filter(Value::is_object)
            .unwrap_or(Value::Null)
    }

    pub async fn set_feed_state(&self, url: &str, value: Value) -> Result<(), UnsafeState> {
        self.feeds.with(|map| {
            snapshots_mut(map).insert(url.to_string(), value);
        })?;
        if self.persist {
            self.feeds.save().await
        } else {
            Ok(())
        }
    }

    pub fn validator(&self, url: &str) -> Option<(String, String)> {
        let state = self.feed_state(url);
        state.is_object().then(|| {
            (
                crate::js::to_string_or_empty(&state["etag"]),
                crate::js::to_string_or_empty(&state["lastModified"]),
            )
        })
    }

    pub fn feed_items(&self, url: &str) -> Vec<Value> {
        self.feed_state(url)
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    /// Store a 200 response snapshot, keeping health metadata.
    pub async fn set_feed_snapshot(
        &self,
        url: &str,
        etag: &str,
        last_modified: &str,
        items: &[Value],
    ) -> Result<(), UnsafeState> {
        let old = self.feed_state(url);
        let mut next = old.as_object().cloned().unwrap_or_default();
        next.insert("etag".into(), json!(etag));
        next.insert("lastModified".into(), json!(last_modified));
        next.insert("items".into(), Value::Array(items.to_vec()));
        let unchanged = crate::js::to_string_or_empty(&old["etag"]) == etag
            && crate::js::to_string_or_empty(&old["lastModified"]) == last_modified
            && old
                .get("items")
                .and_then(Value::as_array)
                .map_or(items.is_empty(), |list| list.as_slice() == items);
        if unchanged {
            return Ok(());
        }
        self.set_feed_state(url, Value::Object(next)).await
    }

    pub async fn flush(&self) -> Result<(), UnsafeState> {
        if !self.persist {
            return Ok(());
        }
        self.delivery.save().await?;
        self.feeds.save().await
    }
}

/// Newest-first list capped at `limit` (`pushCache`).
pub fn push_cache(existing: &[Value], ids: &[Value], limit: usize) -> Vec<Value> {
    let mut merged: Vec<Value> = ids.to_vec();
    merged.extend(existing.iter().cloned());
    merged.truncate(limit);
    merged
}

/// Like `push_cache`, but an id in `keep` (the entries the feed lists right
/// now) is never dropped: a feed longer than `limit` would otherwise lose
/// the ids of entries it still lists and send them again. The list can
/// grow past `limit` by as many kept ids as that.
pub fn push_cache_keeping(
    existing: &[Value],
    ids: &[Value],
    limit: usize,
    keep: &std::collections::HashSet<String>,
) -> Vec<Value> {
    let mut merged: Vec<Value> = ids.to_vec();
    merged.extend(existing.iter().cloned());
    let mut excess = merged.len().saturating_sub(limit);
    if excess == 0 {
        return merged;
    }
    let mut out: Vec<Value> = Vec::with_capacity(merged.len());
    for value in merged.into_iter().rev() {
        if excess > 0 && !value.as_str().is_some_and(|id| keep.contains(id)) {
            excess -= 1;
            continue;
        }
        out.push(value);
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xfeeder-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn history_never_drops_what_the_feed_still_lists() {
        let ids: Vec<Value> = (0..5).map(|i| Value::String(format!("e{i}"))).collect();
        let keep: std::collections::HashSet<String> =
            ["e3", "e4"].iter().map(|s| s.to_string()).collect();
        let out = push_cache_keeping(&ids, &[Value::String("new".into())], 3, &keep);
        let out: Vec<&str> = out.iter().filter_map(Value::as_str).collect();
        assert_eq!(out, ["new", "e3", "e4"]);
    }

    #[test]
    fn corrupt_cache_is_quarantined_and_blocks() {
        let dir = temp_dir("corrupt");
        let cache = dir.join("cache.json");
        std::fs::write(&cache, b"{broken").unwrap();
        assert!(StateStore::open(&cache, true).is_err());
        assert_eq!(std::fs::read(&cache).unwrap(), b"{broken");
        let quarantined = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(quarantined, 1);
        // A second start does not create another copy and stays blocked.
        assert!(StateStore::open(&cache, true).is_err());
        std::fs::remove_file(&cache).unwrap();
        assert!(
            StateStore::open(&cache, true).is_err(),
            "missing cache with quarantine present must block"
        );
    }

    #[test]
    fn legacy_snapshots_move_to_feed_store() {
        let dir = temp_dir("migrate");
        let cache = dir.join("cache.json");
        std::fs::write(&cache, br#"{"0":{"u":["a"]},"__xfeeder":{"feedSnapshots":{"https://f":{"etag":"e","items":[]}}}}"#).unwrap();
        let store = StateStore::open(&cache, true).unwrap();
        assert_eq!(
            store.validator("https://f"),
            Some(("e".into(), String::new()))
        );
        let delivery: Value = serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert!(delivery.get(META_KEY).is_none());
        assert!(dir.join("cache.feeds.json").exists());
    }

    #[test]
    fn push_cache_caps() {
        let out = push_cache(&[json!("b"), json!("c")], &[json!("a")], 2);
        assert_eq!(out, vec![json!("a"), json!("b")]);
    }
}
