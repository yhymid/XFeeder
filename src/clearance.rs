//! Reuse of a Cloudflare clearance (`Scrapling.ReuseClearance`).
//!
//! TEMPORARY MECHANISM, switchable: with `"ReuseClearance": true` in the
//! `Scrapling` section, the cookies a browser got after passing a Cloudflare
//! check (`cf_clearance` and the rest of that site's cookies) are kept with the
//! browser's User-Agent in `clearance.json` (mode 0600, next to config.json).
//! The next check of that site first tries plain HTTP with those cookies and
//! that User-Agent (boop.pl: 0.04 s instead of 26 s through the browser). When
//! the site rejects them, the clearance is dropped and the normal browser path
//! runs as before. Without the option (or `false`) nothing here is used and
//! the worker behaves exactly as before; the file is then ignored.
//!
//! Cookie values never reach logs or diagnostics: only the host, the age and
//! the outcome are reported.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Clearance {
    /// User-Agent of the browser that passed the check; Cloudflare ties the
    /// cookie to it.
    #[serde(rename = "userAgent")]
    pub user_agent: String,
    /// `Cookie` header value for the site.
    pub cookie: String,
    /// Unix seconds when `cf_clearance` expires (0 = unknown).
    pub expires: i64,
    #[serde(rename = "savedAt")]
    pub saved_at: i64,
}

struct Store {
    path: PathBuf,
    persist: bool,
    hosts: BTreeMap<String, Clearance>,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

/// `Scrapling.ReuseClearance: true` turns the mechanism on.
pub fn enabled(root: &Value) -> bool {
    js::path(root, &["Scrapling", "ReuseClearance"]) == &Value::Bool(true)
}

pub fn path_for(base: &Path) -> PathBuf {
    base.join("clearance.json")
}

/// Load `clearance.json`. `persist = false` (dry runs, `preview`) keeps
/// changes in memory only.
pub fn init(path: PathBuf, persist: bool) {
    let hosts = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    *STORE.lock().expect("clearance lock") = Some(Store {
        path,
        persist,
        hosts,
    });
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(|h| h.trim_start_matches("www.").to_ascii_lowercase())
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Saved clearance for the URL's site, unless it has expired.
pub fn get(url: &str) -> Option<Clearance> {
    let host = host_of(url)?;
    let guard = STORE.lock().expect("clearance lock");
    let clearance = guard.as_ref()?.hosts.get(&host)?.clone();
    (clearance.expires == 0 || clearance.expires > now() + 60).then_some(clearance)
}

pub fn age_minutes(clearance: &Clearance) -> i64 {
    (now() - clearance.saved_at) / 60
}

fn write(store: &Store) {
    if !store.persist {
        return;
    }
    let Ok(text) = serde_json::to_string_pretty(&store.hosts) else {
        return;
    };
    if let Err(error) = crate::state::write_atomic(&store.path, text.as_bytes(), 0o600) {
        crate::warn!("Clearance", "Cannot save {}: {error}", store.path.display());
    }
}

/// Keep the cookies of a browser fetch that passed Cloudflare. Only a fetch
/// that carries `cf_clearance` for the site is saved.
pub fn save_from_browser(url: &str, cookies: &[Value], user_agent: Option<&str>) {
    let (Some(host), Some(user_agent)) = (host_of(url), user_agent.filter(|u| !u.is_empty()))
    else {
        return;
    };
    let matches_host = |cookie: &Value| {
        let domain = js::to_string_or_empty(js::get(cookie, "domain"))
            .trim_start_matches('.')
            .to_ascii_lowercase();
        !domain.is_empty()
            && (host == domain || host.ends_with(&format!(".{domain}")) || domain.ends_with(&host))
    };
    let site: Vec<&Value> = cookies.iter().filter(|c| matches_host(c)).collect();
    let Some(clearance_cookie) = site
        .iter()
        .find(|c| js::get(c, "name").as_str() == Some("cf_clearance"))
    else {
        return;
    };
    let cookie = site
        .iter()
        .filter_map(|c| {
            let name = c.get("name")?.as_str()?;
            let value = c.get("value")?.as_str()?;
            (!name.is_empty()).then(|| format!("{name}={value}"))
        })
        .collect::<Vec<_>>()
        .join("; ");
    let expires = js::get(clearance_cookie, "expires")
        .as_f64()
        .filter(|e| *e > 0.0)
        .map_or(0, |e| e as i64);
    let clearance = Clearance {
        user_agent: user_agent.to_string(),
        cookie,
        expires,
        saved_at: now(),
    };
    let mut guard = STORE.lock().expect("clearance lock");
    let Some(store) = guard.as_mut() else {
        return;
    };
    if store
        .hosts
        .get(&host)
        .is_some_and(|c| c.cookie == clearance.cookie)
    {
        return;
    }
    store.hosts.insert(host.clone(), clearance);
    write(store);
    crate::diag::expert(
        "clearance.saved",
        serde_json::json!({ "host": host, "expiresInDays": if expires > 0 { (expires - now()) / 86_400 } else { -1 } }),
    );
    crate::info!(
        "Clearance",
        "Saved Cloudflare clearance for {host}; next checks try plain HTTP first"
    );
}

/// Drop the clearance of a site that rejected it.
pub fn forget(url: &str, status: Option<u16>) {
    let Some(host) = host_of(url) else { return };
    let mut guard = STORE.lock().expect("clearance lock");
    let Some(store) = guard.as_mut() else { return };
    if let Some(old) = store.hosts.remove(&host) {
        write(store);
        crate::info!(
            "Clearance",
            "{host} rejected the saved clearance (HTTP {}, {} min old); using the browser again",
            status.map_or("—".into(), |s| s.to_string()),
            age_minutes(&old)
        );
        crate::diag::expert(
            "clearance.rejected",
            serde_json::json!({ "host": host, "status": status, "ageMinutes": age_minutes(&old) }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saves_only_cloudflare_clearance_for_the_site_and_forgets_it() {
        let dir = std::env::temp_dir().join(format!("xf-clearance-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clearance.json");
        init(path.clone(), true);
        let future = now() + 86_400 * 30;
        // No cf_clearance: nothing saved.
        save_from_browser(
            "https://boop.pl/rss",
            &[json!({ "name": "a", "value": "1", "domain": "boop.pl" })],
            Some("UA"),
        );
        assert!(get("https://boop.pl/rss").is_none());
        let cookies = [
            json!({ "name": "cf_clearance", "value": "abc", "domain": ".boop.pl", "expires": future as f64 }),
            json!({ "name": "sess", "value": "x", "domain": "boop.pl" }),
            json!({ "name": "other", "value": "y", "domain": "example.com" }),
        ];
        save_from_browser(
            "https://www.boop.pl/rss",
            &cookies,
            Some("Mozilla/5.0 Test"),
        );
        let saved = get("https://boop.pl/other").expect("saved");
        assert_eq!(saved.cookie, "cf_clearance=abc; sess=x");
        assert_eq!(saved.user_agent, "Mozilla/5.0 Test");
        assert_eq!(saved.expires, future);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // Reload from disk.
        init(path.clone(), true);
        assert!(get("https://boop.pl/rss").is_some());
        forget("https://boop.pl/rss", Some(403));
        assert!(get("https://boop.pl/rss").is_none());
        assert!(!enabled(&json!({ "Scrapling": {} })));
        assert!(enabled(&json!({ "Scrapling": { "ReuseClearance": true } })));
        let _ = std::fs::remove_dir_all(dir);
    }
}
