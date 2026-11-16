//! Small helpers that reproduce the JavaScript value semantics the original
//! implementation relied on (truthiness, string coercion, UTF-16 lengths).
//! Cache identities and delivery payloads must stay byte-compatible with the
//! state written by the Node.js versions, so these rules are kept exact.

use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

pub static NULL: Value = Value::Null;

/// JavaScript truthiness for a JSON value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value[key]` with `undefined` mapped to `null`.
pub fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&NULL)
}

/// `value?.a?.b?.c`.
pub fn path<'a>(value: &'a Value, keys: &[&str]) -> &'a Value {
    let mut current = value;
    for key in keys {
        current = get(current, key);
    }
    current
}

/// `a || b || c`: the first truthy candidate, otherwise the last one.
pub fn or<'a>(candidates: &[&'a Value]) -> &'a Value {
    for candidate in candidates {
        if truthy(candidate) {
            return candidate;
        }
    }
    candidates.last().copied().unwrap_or(&NULL)
}

/// First truthy candidate as an owned value, or `fallback`.
pub fn or_else(candidates: &[&Value], fallback: Value) -> Value {
    for candidate in candidates {
        if truthy(candidate) {
            return (*candidate).clone();
        }
    }
    fallback
}

fn number_to_string(number: &serde_json::Number) -> String {
    if let Some(int) = number.as_i64() {
        return int.to_string();
    }
    if let Some(int) = number.as_u64() {
        return int.to_string();
    }
    match number.as_f64() {
        Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => format!("{float:.0}"),
        Some(float) => float.to_string(),
        None => number.to_string(),
    }
}

/// `String(value)`.
pub fn to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    to_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(value || "")`.
pub fn to_string_or_empty(value: &Value) -> String {
    if truthy(value) {
        to_string(value)
    } else {
        String::new()
    }
}

/// Non-empty string after trimming, mirroring `typeof x === "string" && x.trim()`.
pub fn trimmed_str(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// `Number(value)` for the cases the application uses.
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => parse_js_number(text).unwrap_or(f64::NAN),
        Value::Array(items) => match items.len() {
            0 => 0.0,
            1 => to_number(&items[0]),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `Number("...")` string conversion: `None` stands for `NaN`.
pub fn parse_js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let lower = trimmed.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    match trimmed {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let valid = trimmed
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.' | b'e' | b'E'));
    if !valid || !trimmed.bytes().any(|byte| byte.is_ascii_digit()) {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

/// Build a JSON number, preferring integers so serialization matches JS.
pub fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// `string.length` (UTF-16 code units).
pub fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `string.slice(0, max)` measured in UTF-16 code units. A surrogate pair is
/// never split, so the result is always valid UTF-8.
pub fn prefix16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if units + width > max {
            return &text[..index];
        }
        units += width;
    }
    text
}

/// Collapse every whitespace run into one space (`replace(/\s+/g, " ")`).
pub fn collapse_ws(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut pending = false;
    for ch in text.chars() {
        if is_js_whitespace(ch) {
            pending = true;
        } else {
            if pending {
                output.push(' ');
                pending = false;
            }
            output.push(ch);
        }
    }
    if pending {
        output.push(' ');
    }
    output
}

pub fn is_js_whitespace(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{feff}'
}

/// `string.trim()` using the JavaScript whitespace set.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// Deterministic serialization with sorted object keys (`stableStringify`).
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(stable_stringify).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            // JavaScript sorts by UTF-16 code units; identical to byte order
            // for the ASCII field names used in fingerprints.
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String(key.clone()),
                        stable_stringify(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_matches_javascript() {
        assert!(!truthy(&json!("")));
        assert!(!truthy(&json!(0)));
        assert!(!truthy(&Value::Null));
        assert!(truthy(&json!("0")));
        assert!(truthy(&json!([])));
        assert!(truthy(&json!({})));
    }

    #[test]
    fn string_coercion() {
        assert_eq!(to_string(&json!(12)), "12");
        assert_eq!(to_string(&json!(1.5)), "1.5");
        assert_eq!(to_string(&json!(["a", null, 2])), "a,,2");
        assert_eq!(to_string(&json!({"a": 1})), "[object Object]");
    }

    #[test]
    fn number_parsing() {
        assert_eq!(parse_js_number(" 42 "), Some(42.0));
        assert_eq!(parse_js_number("1e3"), Some(1000.0));
        assert_eq!(parse_js_number("0x10"), Some(16.0));
        assert_eq!(parse_js_number("12abc"), None);
        assert_eq!(parse_js_number(""), Some(0.0));
    }

    #[test]
    fn utf16_prefix_keeps_pairs_intact() {
        assert_eq!(prefix16("a😀b", 2), "a");
        assert_eq!(prefix16("a😀b", 3), "a😀");
        assert_eq!(len16("a😀b"), 4);
    }

    #[test]
    fn stable_stringify_sorts_keys() {
        assert_eq!(
            stable_stringify(&json!({"b": 1, "a": [true, null, "x"]})),
            r#"{"a":[true,null,"x"],"b":1}"#
        );
    }
}
