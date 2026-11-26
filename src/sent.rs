//! Messages posted through webhooks (`sent.json`, next to `cache.json`).
//!
//! For every Discord message XFeeder posts it keeps the message id and the
//! entry it was built from, so the message can be edited later: `xfeeder
//! rerender` rebuilds old posts in the current layout, and Steam + SteamDB
//! merging adds an announcement to the build post sent before it.
//! Webhook URLs are not stored; they come from the current config.
//!
//! Bounded to the newest `LIMIT` messages.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const LIMIT: usize = 2_000;

/// Entry fields kept for rebuilding a message.
const FIELDS: [&str; 15] = [
    "title",
    "link",
    "sourceLink",
    "identityKey",
    "contentSnippet",
    "contentText",
    "isoDate",
    "enclosure",
    "imageFallback",
    "imageFallbackCheck",
    "author",
    "guid",
    "categories",
    "merged",
    "steamPics",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Record {
    /// Channel identity (`Channel::cache_key`).
    pub channel: String,
    /// Feed URL the entry came from.
    pub source: String,
    pub identity: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    /// Discord channel or thread of the message.
    #[serde(rename = "discordChannel")]
    pub discord_channel: String,
    /// Unix milliseconds.
    #[serde(rename = "sentAt")]
    pub sent_at: i64,
    pub entry: Value,
}

struct Store {
    path: PathBuf,
    persist: bool,
    records: Vec<Record>,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

pub fn path_for(cache_path: &Path) -> PathBuf {
    cache_path.with_file_name("sent.json")
}

pub fn init(path: PathBuf, persist: bool) {
    let records = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    *STORE.lock().expect("sent lock") = Some(Store {
        path,
        persist,
        records,
    });
}

fn write(store: &Store) {
    if !store.persist {
        return;
    }
    let Ok(text) = serde_json::to_string(&store.records) else {
        return;
    };
    if let Err(error) = crate::state::write_atomic(&store.path, text.as_bytes(), 0o600) {
        crate::warn!(
            "Sent messages",
            "Cannot save {}: {error}",
            store.path.display()
        );
    }
}

/// The entry fields needed to rebuild the message.
pub fn slim(entry: &Value) -> Value {
    let mut out = Map::new();
    for field in FIELDS {
        if let Some(value) = entry.get(field).filter(|v| !v.is_null()) {
            out.insert(field.into(), value.clone());
        }
    }
    Value::Object(out)
}

pub fn record(
    channel: &str,
    source: &str,
    identity: &str,
    message: &crate::deliver::SentMessage,
    entry: &Value,
) {
    let mut guard = STORE.lock().expect("sent lock");
    let Some(store) = guard.as_mut() else { return };
    store.records.retain(|r| r.message_id != message.id);
    store.records.push(Record {
        channel: channel.to_string(),
        source: source.to_string(),
        identity: identity.to_string(),
        message_id: message.id.clone(),
        discord_channel: message.channel_id.clone(),
        sent_at: chrono::Utc::now().timestamp_millis(),
        entry: slim(entry),
    });
    if store.records.len() > LIMIT {
        let excess = store.records.len() - LIMIT;
        store.records.drain(..excess);
    }
    write(store);
}

/// All records, oldest first.
pub fn all() -> Vec<Record> {
    STORE
        .lock()
        .expect("sent lock")
        .as_ref()
        .map(|s| s.records.clone())
        .unwrap_or_default()
}

/// Store the entry a message now shows (after an edit).
pub fn update_entry(message_id: &str, entry: &Value) {
    let mut guard = STORE.lock().expect("sent lock");
    let Some(store) = guard.as_mut() else { return };
    if let Some(record) = store
        .records
        .iter_mut()
        .find(|r| r.message_id == message_id)
    {
        record.entry = slim(entry);
        write(store);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::deliver::SentMessage;
    use serde_json::json;

    /// Tests share the process-wide store; they run under this lock.
    pub static LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn records_are_bounded_slim_and_persisted() {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("xf-sent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sent.json");
        init(path.clone(), true);
        let entry = json!({ "title": "T", "link": "https://a/1", "contentSnippet": "x", "secret": "no", "isoDate": null });
        let message = SentMessage {
            id: "1".into(),
            channel_id: "9".into(),
        };
        record("ch", "https://a/feed", "https://a/1", &message, &entry);
        record("ch", "https://a/feed", "https://a/1", &message, &entry);
        let records = all();
        assert_eq!(records.len(), 1, "same message recorded once");
        assert_eq!(
            records[0].entry,
            json!({ "title": "T", "link": "https://a/1", "contentSnippet": "x" })
        );
        init(path.clone(), true);
        assert_eq!(all().len(), 1, "reloaded from disk");
        update_entry("1", &json!({ "title": "New" }));
        assert_eq!(all()[0].entry["title"], "New");
        for i in 0..(LIMIT + 5) {
            let m = SentMessage {
                id: i.to_string(),
                channel_id: "9".into(),
            };
            STORE.lock().unwrap().as_mut().unwrap().persist = false;
            record("ch", "s", &i.to_string(), &m, &entry);
        }
        let records = all();
        assert_eq!(records.len(), LIMIT);
        assert_eq!(records[0].message_id, "5", "oldest dropped first");
        let _ = std::fs::remove_dir_all(dir);
    }
}
