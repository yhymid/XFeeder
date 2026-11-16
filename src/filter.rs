//! Per-channel entry filters (`Filters` in a channel or `ChannelDefaults`).
//!
//! ```json
//! "Filters": {
//!   "Include": ["patch notes", "/\\bv\\d+\\.\\d+/"],
//!   "Exclude": ["sponsored"],
//!   "Fields": ["title", "contentSnippet", "categories"],
//!   "CaseSensitive": false,
//!   "MaxAgeHours": 72
//! }
//! ```
//!
//! A pattern is a plain substring, or a regular expression when written as
//! `/…/`. An entry passes when it matches at least one `Include` pattern (or
//! `Include` is empty), matches no `Exclude` pattern and, with `MaxAgeHours`,
//! is not older than that. Entries without a date are never dropped by age.

use regex::{Regex, RegexBuilder};
use serde_json::Value;

use crate::js;

const DEFAULT_FIELDS: [&str; 3] = ["title", "contentSnippet", "categories"];
const KNOWN_FIELDS: [&str; 7] = [
    "title",
    "contentSnippet",
    "content",
    "categories",
    "author",
    "link",
    "guid",
];

#[derive(Clone, Debug)]
enum Pattern {
    Text(String),
    Regex(Regex),
}

#[derive(Clone, Debug, Default)]
pub struct Filter {
    include: Vec<Pattern>,
    exclude: Vec<Pattern>,
    fields: Vec<String>,
    case_sensitive: bool,
    max_age_hours: Option<f64>,
}

fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => vec![text.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
    .into_iter()
    .filter(|s| !s.trim().is_empty())
    .collect()
}

impl Filter {
    /// Parse a `Filters` object. Returns `None` when nothing is configured;
    /// problems (bad regex, unknown field, bad age) are returned as messages
    /// and the offending part is ignored.
    pub fn parse(raw: &Value) -> (Option<Self>, Vec<String>) {
        let mut problems = Vec::new();
        if raw.is_null() {
            return (None, problems);
        }
        if !raw.is_object() {
            problems.push("Filters must be an object".into());
            return (None, problems);
        }
        let case_sensitive = js::get(raw, "CaseSensitive") == &Value::Bool(true);
        let mut compile = |list: Vec<String>, kind: &str| -> Vec<Pattern> {
            list.into_iter()
                .filter_map(|text| {
                    let regex_body = text
                        .strip_prefix('/')
                        .and_then(|rest| rest.strip_suffix('/'))
                        .filter(|body| !body.is_empty());
                    match regex_body {
                        Some(body) => match RegexBuilder::new(body)
                            .case_insensitive(!case_sensitive)
                            .size_limit(1 << 20)
                            .build()
                        {
                            Ok(regex) => Some(Pattern::Regex(regex)),
                            Err(error) => {
                                problems
                                    .push(format!("Filters.{kind}: invalid regex {text}: {error}"));
                                None
                            }
                        },
                        None if case_sensitive => Some(Pattern::Text(text)),
                        None => Some(Pattern::Text(text.to_lowercase())),
                    }
                })
                .collect()
        };
        let include = compile(strings(js::get(raw, "Include")), "Include");
        let exclude = compile(strings(js::get(raw, "Exclude")), "Exclude");
        let mut fields = strings(js::get(raw, "Fields"));
        for field in &fields {
            if !KNOWN_FIELDS.contains(&field.as_str()) {
                problems.push(format!(
                    "Filters.Fields: unknown field \"{field}\" (known: {})",
                    KNOWN_FIELDS.join(", ")
                ));
            }
        }
        fields.retain(|f| KNOWN_FIELDS.contains(&f.as_str()));
        if fields.is_empty() {
            fields = DEFAULT_FIELDS.map(String::from).to_vec();
        }
        let age = js::get(raw, "MaxAgeHours");
        let max_age_hours = match age {
            Value::Null => None,
            other => match other.as_f64().filter(|h| h.is_finite() && *h > 0.0) {
                Some(hours) => Some(hours),
                None => {
                    problems.push("Filters.MaxAgeHours must be a positive number".into());
                    None
                }
            },
        };
        if include.is_empty() && exclude.is_empty() && max_age_hours.is_none() {
            return (None, problems);
        }
        (
            Some(Self {
                include,
                exclude,
                fields,
                case_sensitive,
                max_age_hours,
            }),
            problems,
        )
    }

    fn haystack(&self, entry: &Value) -> String {
        let mut out = String::new();
        for field in &self.fields {
            let value = js::get(entry, field);
            let parts: Vec<String> = match value {
                Value::Array(items) => items.iter().map(js::to_string_or_empty).collect(),
                Value::Null => Vec::new(),
                other => vec![js::to_string_or_empty(other)],
            };
            for part in parts {
                out.push_str(&part);
                out.push('\n');
            }
        }
        if self.case_sensitive {
            out
        } else {
            out.to_lowercase()
        }
    }

    fn matches(pattern: &Pattern, haystack: &str) -> bool {
        match pattern {
            Pattern::Text(text) => haystack.contains(text.as_str()),
            Pattern::Regex(regex) => regex.is_match(haystack),
        }
    }

    /// `now_ms` is passed in so tests are deterministic.
    pub fn accepts(&self, entry: &Value, now_ms: i64) -> bool {
        if let Some(hours) = self.max_age_hours
            && let Some(date) = js::get(entry, "isoDate").as_str()
            && let Ok(date) = chrono::DateTime::parse_from_rfc3339(date)
            && (now_ms - date.timestamp_millis()) as f64 > hours * 3_600_000.0
        {
            return false;
        }
        if self.include.is_empty() && self.exclude.is_empty() {
            return true;
        }
        let haystack = self.haystack(entry);
        if !self.include.is_empty() && !self.include.iter().any(|p| Self::matches(p, &haystack)) {
            return false;
        }
        !self.exclude.iter().any(|p| Self::matches(p, &haystack))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;

    fn iso(hours_ago: i64) -> String {
        chrono::DateTime::from_timestamp_millis(NOW - hours_ago * 3_600_000)
            .unwrap()
            .to_rfc3339()
    }

    #[test]
    fn empty_config_is_none() {
        assert!(Filter::parse(&Value::Null).0.is_none());
        assert!(Filter::parse(&json!({ "Include": [] })).0.is_none());
    }

    #[test]
    fn include_exclude_substring_case_insensitive() {
        let (filter, problems) = Filter::parse(&json!({
            "Include": ["Patch Notes", "update"], "Exclude": "sponsored"
        }));
        assert!(problems.is_empty());
        let filter = filter.unwrap();
        assert!(filter.accepts(&json!({ "title": "New PATCH notes" }), NOW));
        assert!(filter.accepts(&json!({ "title": "x", "categories": ["Update"] }), NOW));
        assert!(!filter.accepts(&json!({ "title": "Update (Sponsored)" }), NOW));
        assert!(!filter.accepts(&json!({ "title": "Other news" }), NOW));
        // `link` is not searched by default.
        assert!(!filter.accepts(&json!({ "title": "x", "link": "https://a/update" }), NOW));
    }

    #[test]
    fn regex_and_case_sensitive() {
        let (filter, _) = Filter::parse(&json!({
            "Include": ["/\\bv\\d+\\.\\d+/"], "CaseSensitive": true, "Exclude": ["BETA"]
        }));
        let filter = filter.unwrap();
        assert!(filter.accepts(&json!({ "title": "Release v2.10 beta" }), NOW));
        assert!(!filter.accepts(&json!({ "title": "Release v2.10 BETA" }), NOW));
        assert!(!filter.accepts(&json!({ "title": "Release 2" }), NOW));
    }

    #[test]
    fn bad_parts_are_reported_and_ignored() {
        let (filter, problems) = Filter::parse(&json!({
            "Include": ["/(/"], "Exclude": ["x"], "Fields": ["nope"], "MaxAgeHours": -1
        }));
        assert_eq!(problems.len(), 3, "{problems:?}");
        let filter = filter.unwrap();
        assert!(filter.accepts(&json!({ "title": "a" }), NOW));
        assert!(!filter.accepts(&json!({ "title": "x" }), NOW));
    }

    #[test]
    fn max_age() {
        let (filter, _) = Filter::parse(&json!({ "MaxAgeHours": 24 }));
        let filter = filter.unwrap();
        assert!(filter.accepts(&json!({ "isoDate": iso(2) }), NOW));
        assert!(!filter.accepts(&json!({ "isoDate": iso(48) }), NOW));
        assert!(filter.accepts(&json!({ "title": "undated" }), NOW));
    }
}
