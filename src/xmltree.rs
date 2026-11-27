//! Strict XML → JSON conversion with the shape xml2js produced for XFeeder
//! (`explicitArray: false`, attributes under `ATTR`, text under `VALUE`,
//! text kept as strings), so parser field access is unchanged.
//!
//! Hardened for untrusted feeds: nesting is capped (a deep document would
//! overflow the stack and abort the whole process), anything after the root
//! element is ignored (Cloudflare appends a `<script>` to some feeds), and
//! HTML entities such as `&nbsp;` are resolved instead of failing the whole
//! document; unknown ones stay as written.

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde_json::{Map, Value};

struct Frame {
    name: String,
    attrs: Map<String, Value>,
    children: Map<String, Value>,
    text: String,
    cdata: bool,
}

/// Deeper documents are rejected; real feeds nest fewer than 20 levels.
const MAX_DEPTH: usize = 256;

/// Text stays text: xml2js-style number conversion turned "1.10" into
/// "1.1" and changed the digits of 20-digit ids.
fn convert_text(text: &str) -> Value {
    Value::String(text.to_string())
}

/// `&name;` / `&#NN;` with XML and HTML5 names; unknown names stay literal.
fn entity(name: &str) -> String {
    let written = format!("&{name};");
    quick_xml::escape::unescape_with(&written, quick_xml::escape::resolve_html5_entity)
        .map_or(written.clone(), |s| s.into_owned())
}

fn finish(frame: Frame) -> Value {
    let Frame {
        attrs,
        mut children,
        text,
        cdata,
        ..
    } = frame;
    let whitespace = text.chars().all(char::is_whitespace);
    if !attrs.is_empty() {
        children.insert("ATTR".into(), Value::Object(attrs));
    }
    if whitespace && !cdata {
        if children.is_empty() {
            return Value::String(text);
        }
    } else {
        children.insert("VALUE".into(), convert_text(&text));
    }
    if children.len() == 1 && children.contains_key("VALUE") {
        return children.remove("VALUE").expect("present");
    }
    Value::Object(children)
}

fn attach(parent: &mut Map<String, Value>, name: String, value: Value) {
    match parent.get_mut(&name) {
        None => {
            parent.insert(name, value);
        }
        Some(Value::Array(items)) => items.push(value),
        Some(existing) => {
            let previous = existing.take();
            *existing = Value::Array(vec![previous, value]);
        }
    }
}

pub fn parse(xml: &str) -> Result<Value, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<Frame> = Vec::new();
    let mut root: Option<Value> = None;
    let start = |e: &quick_xml::events::BytesStart| -> Result<Frame, String> {
        let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
        let mut attrs = Map::new();
        for attr in e.attributes() {
            let attr = attr.map_err(|err| err.to_string())?;
            let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
            let raw = String::from_utf8_lossy(&attr.value).into_owned();
            let value =
                quick_xml::escape::unescape_with(&raw, quick_xml::escape::resolve_html5_entity)
                    .map_or_else(|_| raw.clone(), |s| s.into_owned());
            attrs.insert(key, Value::String(value));
        }
        Ok(Frame {
            name,
            attrs,
            children: Map::new(),
            text: String::new(),
            cdata: false,
        })
    };
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => {
                if root.is_some() {
                    break;
                }
                if stack.len() >= MAX_DEPTH {
                    return Err(format!("XML nested deeper than {MAX_DEPTH} levels"));
                }
                stack.push(start(&e)?);
            }
            Event::Empty(e) => {
                if root.is_some() {
                    break;
                }
                let frame = start(&e)?;
                let name = frame.name.clone();
                let value = finish(frame);
                match stack.last_mut() {
                    Some(parent) => attach(&mut parent.children, name, value),
                    None => root = Some(Value::Object(Map::from_iter([(name, value)]))),
                }
            }
            Event::End(_) => {
                let frame = stack.pop().ok_or("Unexpected end tag")?;
                let name = frame.name.clone();
                let value = finish(frame);
                match stack.last_mut() {
                    Some(parent) => attach(&mut parent.children, name, value),
                    None => root = Some(Value::Object(Map::from_iter([(name, value)]))),
                }
            }
            Event::Text(t) => {
                if let Some(frame) = stack.last_mut() {
                    let raw = t.decode().map_err(|e| e.to_string())?;
                    frame.text.push_str(&raw);
                } else if root.is_some() {
                    break;
                }
            }
            Event::GeneralRef(r) => {
                if let Some(frame) = stack.last_mut() {
                    let name = r.decode().map_err(|e| e.to_string())?;
                    frame.text.push_str(&entity(&name));
                }
            }
            Event::CData(c) => {
                if let Some(frame) = stack.last_mut() {
                    frame.text.push_str(&String::from_utf8_lossy(&c));
                    frame.cdata = true;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err("Unclosed root tag".into());
    }
    root.ok_or_else(|| "Non-whitespace before first tag.".into())
}

/// `Array.isArray(x) ? x : [x]` for an optional child.
pub fn as_list(value: &Value) -> Vec<&Value> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn xml2js_shape() {
        let doc = parse(r#"<?xml version="1.0"?><rss version="2.0"><channel><item><title><![CDATA[A & <b>B</b>]]></title><link>https://a</link><enclosure url="https://i.png"/><n>42</n></item><item><title>Two</title><empty></empty></item></channel></rss>"#).unwrap();
        let items = &doc["rss"]["channel"]["item"];
        assert!(items.is_array());
        assert_eq!(items[0]["title"], json!("A & <b>B</b>"));
        assert_eq!(items[0]["enclosure"]["ATTR"]["url"], json!("https://i.png"));
        assert_eq!(items[0]["n"], json!("42"));
        assert_eq!(items[1]["empty"], json!(""));
        assert_eq!(doc["rss"]["ATTR"]["version"], json!("2.0"));
    }

    #[test]
    fn hostile_and_sloppy_documents() {
        // Deep nesting is refused instead of overflowing the stack.
        let deep = "<a>".repeat(100_000);
        assert!(parse(&deep).unwrap_err().contains("deeper"));
        // Cloudflare's script after the root does not break the feed.
        let doc = parse("<feed><title>T &amp; U</title></feed>\n<script>if (a && b) {}</script>")
            .unwrap();
        assert_eq!(doc["feed"]["title"], json!("T & U"));
        // HTML entities resolve; unknown ones stay as written.
        let doc = parse(r#"<rss><t a="x&nbsp;y">caf&eacute;&nbsp;&rarr; &bogus; &#233;</t></rss>"#)
            .unwrap();
        assert_eq!(
            doc["rss"]["t"]["VALUE"],
            json!("caf\u{e9}\u{a0}\u{2192} &bogus; \u{e9}")
        );
        assert_eq!(doc["rss"]["t"]["ATTR"]["a"], json!("x\u{a0}y"));
        // Numbers stay text.
        let doc = parse("<r><v>1.10</v><id>12345678901234567890</id><b>true</b></r>").unwrap();
        assert_eq!(doc["r"]["v"], json!("1.10"));
        assert_eq!(doc["r"]["id"], json!("12345678901234567890"));
        assert_eq!(doc["r"]["b"], json!("true"));
    }

    #[test]
    fn rejects_malformed() {
        assert!(parse("<a><b></a>").is_err());
        assert!(parse("not xml").is_err());
    }
}
