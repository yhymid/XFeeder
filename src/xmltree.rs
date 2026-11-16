//! Strict XML → JSON conversion with the shape xml2js produced for XFeeder
//! (`explicitArray: false`, attributes under `ATTR`, text under `VALUE`,
//! numeric and boolean text converted), so parser field access is unchanged.

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde_json::{Map, Value};

use crate::js;

struct Frame {
    name: String,
    attrs: Map<String, Value>,
    children: Map<String, Value>,
    text: String,
    cdata: bool,
}

fn convert_text(text: &str) -> Value {
    // xml2js parseNumbers: `!isNaN(str)` → parseInt / parseFloat.
    if let Some(number) = js::parse_js_number(text) {
        if number.fract() == 0.0 {
            let trimmed = text.trim();
            let digits: String = trimmed
                .char_indices()
                .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+')))
                .map(|(_, c)| c)
                .collect();
            if let Ok(int) = digits.parse::<f64>() {
                return js::number(int);
            }
        }
        if number.is_finite() {
            return js::number(number);
        }
    }
    if text.eq_ignore_ascii_case("true") {
        return Value::Bool(true);
    }
    if text.eq_ignore_ascii_case("false") {
        return Value::Bool(false);
    }
    Value::String(text.to_string())
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
            #[allow(deprecated)]
            let value = attr
                .unescape_value()
                .map_err(|err| err.to_string())?
                .into_owned();
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
            Event::Start(e) => stack.push(start(&e)?),
            Event::Empty(e) => {
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
                    let text = quick_xml::escape::unescape(&raw).map_err(|e| e.to_string())?;
                    frame.text.push_str(&text);
                } else if !t.iter().all(u8::is_ascii_whitespace) && root.is_some() {
                    return Err("Text data outside of root node.".into());
                }
            }
            Event::GeneralRef(r) => {
                if let Some(frame) = stack.last_mut() {
                    let name = r.decode().map_err(|e| e.to_string())?;
                    let entity = format!("&{name};");
                    let text = quick_xml::escape::unescape(&entity).map_err(|e| e.to_string())?;
                    frame.text.push_str(&text);
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
        assert_eq!(items[0]["n"], json!(42));
        assert_eq!(items[1]["empty"], json!(""));
        assert_eq!(doc["rss"]["ATTR"]["version"], json!("2.0"));
    }

    #[test]
    fn rejects_malformed() {
        assert!(parse("<a><b></a>").is_err());
        assert!(parse("not xml").is_err());
    }
}
