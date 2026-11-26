//! Channel `Ping`: mention a role, users or @everyone above a Discord post.
//!
//! ```json
//! "Ping": "123456789012345678"                       // one role, every post
//! "Ping": {
//!   "Roles": ["123456789012345678"],
//!   "Users": ["234567890123456789"],
//!   "Everyone": false,
//!   "Feeds": ["/releases"],          // only entries of feeds whose URL contains this
//!   "Include": ["release", "/v\\d+/"],// only entries matching (like Filters.Include)
//!   "Text": "🔔 New release"          // shown before the mentions
//! }
//! ```
//!
//! Only the mentions configured here can notify: every webhook post carries
//! `allowed_mentions`, so `@everyone`, `<@&role>` or `<@user>` written in a
//! feed entry never ping anyone. Edits of earlier posts never ping.

use serde_json::{Value, json};

use crate::filter::Filter;
use crate::js;

#[derive(Clone, Debug, Default)]
pub struct Ping {
    roles: Vec<String>,
    users: Vec<String>,
    everyone: bool,
    feeds: Vec<String>,
    include: Option<Filter>,
    text: String,
}

/// The mention line of one post and the `allowed_mentions` that lets it
/// (and nothing else) notify.
#[derive(Clone, Debug, PartialEq)]
pub struct Mention {
    pub line: String,
    pub allowed: Value,
}

/// `allowed_mentions` that notifies nobody.
pub fn silent() -> Value {
    json!({ "parse": [] })
}

fn snowflakes(value: &Value, field: &str, problems: &mut Vec<String>) -> Vec<String> {
    let items: Vec<&Value> = match value {
        Value::Null => Vec::new(),
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let mut out = Vec::new();
    for item in items {
        let text = match item {
            Value::String(s) => s.trim().to_string(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
        let id = text
            .trim_start_matches("<@&")
            .trim_start_matches("<@")
            .trim_end_matches('>');
        if (15..=21).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()) {
            if !out.iter().any(|o| o == id) {
                out.push(id.to_string());
            }
        } else {
            problems.push(format!("Ping.{field}: \"{text}\" is not a Discord ID"));
        }
    }
    out
}

impl Ping {
    /// Parse a channel's `Ping`. `None` when it is absent or names nobody;
    /// problems are returned as messages.
    pub fn parse(raw: &Value) -> (Option<Self>, Vec<String>) {
        let mut problems = Vec::new();
        let ping = match raw {
            Value::Null | Value::Bool(false) => return (None, problems),
            Value::String(_) | Value::Number(_) | Value::Array(_) => Self {
                roles: snowflakes(raw, "Roles", &mut problems),
                ..Self::default()
            },
            Value::Object(_) => {
                let feeds = match js::get(raw, "Feeds") {
                    Value::String(s) => vec![s.clone()],
                    Value::Array(items) => items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                    _ => Vec::new(),
                }
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .collect();
                let (include, filter_problems) = Filter::parse(&json!({
                    "Include": js::get(raw, "Include"),
                    "Fields": js::get(raw, "Fields"),
                    "CaseSensitive": js::get(raw, "CaseSensitive"),
                }));
                problems.extend(
                    filter_problems
                        .into_iter()
                        .map(|p| p.replacen("Filters.", "Ping.", 1)),
                );
                Self {
                    roles: snowflakes(js::get(raw, "Roles"), "Roles", &mut problems),
                    users: snowflakes(js::get(raw, "Users"), "Users", &mut problems),
                    everyone: js::get(raw, "Everyone") == &Value::Bool(true),
                    feeds,
                    include,
                    text: js::get(raw, "Text")
                        .as_str()
                        .map(|t| js::prefix16(t.trim(), 200).to_string())
                        .unwrap_or_default(),
                }
            }
            _ => {
                problems.push("Ping must be a role ID, a list of role IDs or an object".into());
                return (None, problems);
            }
        };
        if ping.roles.is_empty() && ping.users.is_empty() && !ping.everyone {
            if problems.is_empty() {
                problems.push("Ping names no Roles, Users or Everyone".into());
            }
            return (None, problems);
        }
        (Some(ping), problems)
    }

    /// The mention for an entry of feed `source`, if this entry should ping.
    pub fn mention(&self, entry: &Value, source: &str) -> Option<Mention> {
        if !self.feeds.is_empty() && !self.feeds.iter().any(|f| source.contains(f.as_str())) {
            return None;
        }
        if let Some(include) = &self.include
            && !include.accepts(entry, chrono::Utc::now().timestamp_millis())
        {
            return None;
        }
        let mut parts = Vec::new();
        if !self.text.is_empty() {
            parts.push(self.text.clone());
        }
        if self.everyone {
            parts.push("@everyone".into());
        }
        parts.extend(self.roles.iter().map(|r| format!("<@&{r}>")));
        parts.extend(self.users.iter().map(|u| format!("<@{u}>")));
        let mut allowed = serde_json::Map::new();
        if self.everyone {
            allowed.insert("parse".into(), json!(["everyone"]));
        }
        if !self.roles.is_empty() {
            allowed.insert("roles".into(), json!(self.roles));
        }
        if !self.users.is_empty() {
            allowed.insert("users".into(), json!(self.users));
        }
        Some(Mention {
            line: parts.join(" "),
            allowed: Value::Object(allowed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROLE: &str = "123456789012345678";
    const USER: &str = "234567890123456789";

    #[test]
    fn shorthand_role_pings_every_post() {
        let (ping, problems) = Ping::parse(&json!(ROLE));
        assert!(problems.is_empty());
        let m = ping
            .unwrap()
            .mention(&json!({"title": "x"}), "https://a/feed")
            .unwrap();
        assert_eq!(m.line, format!("<@&{ROLE}>"));
        assert_eq!(m.allowed, json!({ "roles": [ROLE] }));
    }

    #[test]
    fn conditions_limit_which_entries_ping() {
        let raw = json!({
            "Roles": [format!("<@&{ROLE}>")], "Users": [USER], "Everyone": true,
            "Feeds": ["/releases"], "Include": ["/^v?\\d+\\.\\d+/"], "Text": "🔔 New release"
        });
        let (ping, problems) = Ping::parse(&raw);
        assert!(problems.is_empty(), "{problems:?}");
        let ping = ping.unwrap();
        let release = json!({ "title": "3.0 - Rust Update" });
        let m = ping
            .mention(&release, "https://github.com/o/r/releases.atom")
            .unwrap();
        assert_eq!(
            m.line,
            format!("🔔 New release @everyone <@&{ROLE}> <@{USER}>")
        );
        assert_eq!(
            m.allowed,
            json!({ "parse": ["everyone"], "roles": [ROLE], "users": [USER] })
        );
        assert!(
            ping.mention(&release, "https://github.com/o/r/commits/main.atom")
                .is_none()
        );
        assert!(
            ping.mention(
                &json!({"title": "Fix typo"}),
                "https://github.com/o/r/releases.atom"
            )
            .is_none()
        );
    }

    #[test]
    fn steam_pics_kinds_can_be_picked() {
        // Only a new public build of CS2: not changelists, not other branches.
        let raw = json!({
            "Roles": [ROLE], "Feeds": ["steampics://730"],
            "Include": ["/^Build$/"], "Fields": ["categories"], "CaseSensitive": true
        });
        let (ping, problems) = Ping::parse(&raw);
        assert!(problems.is_empty(), "{problems:?}");
        let ping = ping.unwrap();
        let entry = |kind: &str, branch: &str| json!({ "title": "Counter-Strike 2", "categories": [kind, format!("branch:{branch}"), "SteamPICS"] });
        assert!(
            ping.mention(&entry("Build", "public"), "steampics://730")
                .is_some()
        );
        assert!(
            ping.mention(&entry("Branch build", "1.42.0.0"), "steampics://730")
                .is_none()
        );
        assert!(
            ping.mention(
                &json!({ "title": "x", "categories": ["Changelist", "SteamPICS"] }),
                "steampics://730"
            )
            .is_none()
        );
        assert!(
            ping.mention(&entry("Build", "public"), "steampics://570")
                .is_none()
        );
    }

    #[test]
    fn bad_ids_and_empty_pings_are_reported() {
        let (ping, problems) = Ping::parse(&json!({ "Roles": ["moderators"] }));
        assert!(ping.is_none());
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("not a Discord ID"));
        assert!(Ping::parse(&json!({})).0.is_none());
        assert!(Ping::parse(&Value::Null).1.is_empty());
    }
}
