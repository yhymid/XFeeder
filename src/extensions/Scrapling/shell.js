"use strict";

const { execFile } = require("child_process");
const cheerio = require("cheerio");
const { normalizeMode } = require("./cli");

function runPy(pythonCmd, code, optionsJson, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      pythonCmd,
      ["-c", code, optionsJson],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const stderrText = String(stderr || "").trim();
          if (stderrText) return reject(new Error(stderrText));
          const raw = String(err.message || "Scrapling shell command failed").replace(/\s+/g, " ").trim();
          const short = raw.length > 260 ? `${raw.slice(0, 260)}...` : raw;
          return reject(new Error(short));
        }
        resolve(String(stdout || ""));
      }
    );
  });
}

function normalizeInput(mode, options) {
  const normalized = { ...options };
  normalized.mode = normalizeMode(mode);
  return normalized;
}

function applyCssSelector(html, selector) {
  const css = String(selector || "").trim();
  if (!css) return String(html || "");
  try {
    const $ = cheerio.load(String(html || ""));
    const chunks = [];
    $(css).each((_, el) => {
      chunks.push($.html(el));
    });
    return chunks.join("\n");
  } catch {
    return String(html || "");
  }
}

async function fetch(pythonCmd, {
  mode = "stealthy-fetch",
  url,
  timeout = 60,
  ...options
} = {}) {
  if (!url) throw new Error("Scrapling shell fetch requires URL");

  const payload = normalizeInput(mode, { ...options, url });

const py = `
import json
import os
import sys
from scrapling.fetchers import Fetcher, DynamicFetcher, StealthyFetcher, ProxyRotator

opts = json.loads(sys.argv[1])
mode = opts.get("mode", "get")
url = opts["url"]

def to_headers(value):
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        out = {}
        for item in value:
            s = str(item)
            if ":" in s:
                k, v = s.split(":", 1)
                out[k.strip()] = v.strip()
        return out or None
    if isinstance(value, str) and ":" in value:
        k, v = value.split(":", 1)
        return {k.strip(): v.strip()}
    return None

def to_params(value):
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        out = {}
        for item in value:
            s = str(item)
            if "=" in s:
                k, v = s.split("=", 1)
                out[k.strip()] = v.strip()
        return out or None
    if isinstance(value, str) and "=" in value:
        k, v = value.split("=", 1)
        return {k.strip(): v.strip()}
    return None

def to_http_cookies(value):
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        out = {}
        for item in value:
            if isinstance(item, dict) and "name" in item and "value" in item:
                out[str(item.get("name"))] = str(item.get("value"))
        return out or None
    if isinstance(value, str):
        out = {}
        for chunk in value.split(";"):
            chunk = chunk.strip()
            if not chunk or "=" not in chunk:
                continue
            k, v = chunk.split("=", 1)
            out[k.strip()] = v.strip()
        return out or None
    return None

def to_browser_cookies(value, default_url):
    if value is None:
        return None
    if isinstance(value, list):
        out = []
        for item in value:
            if not isinstance(item, dict):
                continue
            if "name" not in item or "value" not in item:
                continue
            cookie = dict(item)
            cookie["name"] = str(cookie["name"])
            cookie["value"] = str(cookie["value"])
            if "url" not in cookie and "domain" not in cookie:
                cookie["url"] = default_url
            out.append(cookie)
        return out or None
    if isinstance(value, dict):
        return [
            {"name": str(k), "value": str(v), "url": default_url}
            for k, v in value.items()
            if v is not None
        ] or None
    if isinstance(value, str):
        out = []
        for chunk in value.split(";"):
            chunk = chunk.strip()
            if not chunk or "=" not in chunk:
                continue
            k, v = chunk.split("=", 1)
            out.append({"name": k.strip(), "value": v.strip(), "url": default_url})
        return out or None
    return None

def to_json(value):
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            return json.loads(s)
        except Exception:
            return None
    return None

def to_list(value):
    if value is None:
        return None
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.startswith("["):
            parsed = to_json(s)
            if isinstance(parsed, list):
                return parsed
        return [item.strip() for item in s.split(",") if item.strip()]
    return [value]

def to_set(value):
    values = to_list(value)
    if values is None:
        return None
    out = {str(item).strip() for item in values if str(item).strip()}
    return out or None

def to_proxy_auth(value):
    if value is None:
        return None
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return (str(value[0]), str(value[1]))
    if isinstance(value, str) and ":" in value:
        user, pwd = value.split(":", 1)
        return (user, pwd)
    return None

def to_proxy_rotator(value):
    proxies = to_list(value)
    if not proxies:
        return None
    cleaned = []
    for proxy in proxies:
        if isinstance(proxy, str):
            p = proxy.strip()
            if p:
                cleaned.append(p)
            continue
        if isinstance(proxy, dict):
            server = proxy.get("server")
            if not server:
                continue
            obj = {"server": str(server)}
            if proxy.get("username") is not None:
                obj["username"] = str(proxy.get("username"))
            if proxy.get("password") is not None:
                obj["password"] = str(proxy.get("password"))
            cleaned.append(obj)
    if not cleaned:
        return None
    return ProxyRotator(cleaned)

def load_callable(value, default_name):
    if value is None:
        return None

    func_name = default_name
    code = None

    if isinstance(value, str):
        source = value.strip()
        if not source:
            return None
        if os.path.exists(source):
            with open(source, "r", encoding="utf-8") as fh:
                code = fh.read()
        else:
            code = source
    elif isinstance(value, dict):
        func_name = str(value.get("function") or value.get("name") or default_name)
        source = value.get("code")
        path = value.get("path") or value.get("file")
        if source is not None:
            code = str(source)
        elif path and os.path.exists(str(path)):
            with open(str(path), "r", encoding="utf-8") as fh:
                code = fh.read()
    if not code:
        return None

    namespace = {}
    exec(code, namespace, namespace)
    candidate = namespace.get(func_name)
    if callable(candidate):
        return candidate
    fallback = namespace.get(default_name)
    if callable(fallback):
        return fallback
    return None

def normalize_output_headers(value):
    if value is None:
        return {}
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items() if k is not None and v is not None}
    try:
        as_dict = dict(value)
        return {str(k): str(v) for k, v in as_dict.items() if k is not None and v is not None}
    except Exception:
        return {}

def first(*keys, default=None):
    for key in keys:
        if key in opts and opts[key] is not None:
            return opts[key]
    return default

if mode in {"get", "post", "put", "delete"}:
    kwargs = {
        "headers": to_headers(first("headers")),
        "cookies": to_http_cookies(first("cookies")),
        "timeout": first("timeoutSeconds", "timeout_seconds", "timeout", default=30),
        "proxy": first("proxy"),
        "params": to_params(first("params")),
        "follow_redirects": first("followRedirects", "follow_redirects", default="safe"),
        "verify": first("verify", default=True),
        "impersonate": first("impersonate"),
        "useragent": first("useragent", "userAgent"),
        "stealthy_headers": first("stealthyHeaders", "stealthy_headers", default=True),
        "retries": first("retries"),
        "retry_delay": first("retryDelay", "retry_delay"),
        "http3": first("http3"),
        "proxy_auth": to_proxy_auth(first("proxyAuth", "proxy_auth")),
        "proxies": first("proxies"),
        "max_redirects": first("maxRedirects", "max_redirects"),
        "cert": first("cert"),
        "selector_config": to_json(first("selectorConfig", "selector_config")),
        "proxy_rotator": to_proxy_rotator(first("proxyRotator", "proxy_rotator")),
        "auth": to_proxy_auth(first("auth")),
    }
    kwargs = {k: v for k, v in kwargs.items() if v is not None}

    if mode in {"post", "put"}:
        if "data" in opts and opts["data"] not in (None, ""):
            kwargs["data"] = opts["data"]
        if "jsonData" in opts and opts["jsonData"] not in (None, ""):
            kwargs["json"] = opts["jsonData"]
        elif "json" in opts and opts["json"] not in (None, ""):
            kwargs["json"] = opts["json"]

    page = getattr(Fetcher, mode)(url, **kwargs)
else:
    kwargs = {
        "headless": first("headless", default=True),
        "disable_resources": first("disableResources", "disable_resources", default=False),
        "blocked_domains": to_set(first("blockedDomains", "blocked_domains")),
        "cookies": to_browser_cookies(first("cookies"), url),
        "useragent": first("useragent", "userAgent"),
        "network_idle": first("networkIdle", "network_idle", default=False),
        "load_dom": first("loadDom", "load_dom", default=True),
        "timeout": first("timeoutMs", "timeout_ms", "timeout", default=30000),
        "wait": first("wait", default=0),
        "page_action": load_callable(first("pageAction", "page_action"), "page_action"),
        "page_setup": load_callable(first("pageSetup", "page_setup"), "page_setup"),
        "wait_selector": first("waitSelector", "wait_selector"),
        "wait_selector_state": first("waitSelectorState", "wait_selector_state"),
        "init_script": first("initScript", "init_script"),
        "google_search": first("googleSearch", "google_search", default=True),
        "locale": first("locale"),
        "timezone_id": first("timezoneId", "timezone_id"),
        "cdp_url": first("cdpUrl", "cdp_url"),
        "user_data_dir": first("userDataDir", "user_data_dir"),
        "extra_flags": to_list(first("extraFlags", "extra_flags")),
        "additional_args": to_json(first("additionalArgs", "additional_args")),
        "selector_config": to_json(first("selectorConfig", "selector_config")),
        "real_chrome": first("realChrome", "real_chrome", default=False),
        "proxy": first("proxy"),
        "extra_headers": to_headers(first("extraHeaders", "headers")),
        "dns_over_https": first("dnsOverHttps", "dns_over_https", default=False),
        "block_ads": first("blockAds", "block_ads", default=False),
        "retries": first("retries"),
        "retry_delay": first("retryDelay", "retry_delay"),
        "capture_xhr": first("captureXhr", "capture_xhr"),
        "executable_path": first("executablePath", "executable_path"),
        "max_pages": first("maxPages", "max_pages"),
        "proxy_rotator": to_proxy_rotator(first("proxyRotator", "proxy_rotator")),
    }
    kwargs = {k: v for k, v in kwargs.items() if v is not None}

    if first("aiTargeted", default=False):
        kwargs["block_ads"] = True

    if mode == "stealthy-fetch":
        kwargs["block_webrtc"] = first("blockWebrtc", "block_webrtc", default=False)
        kwargs["solve_cloudflare"] = first("solveCloudflare", "solve_cloudflare", "solveCaptcha", default=False)
        kwargs["allow_webgl"] = first("allowWebgl", "allow_webgl", default=True)
        kwargs["hide_canvas"] = first("hideCanvas", "hide_canvas", default=False)
        page = StealthyFetcher.fetch(url, **kwargs)
    else:
        page = DynamicFetcher.fetch(url, **kwargs)

out = None
if hasattr(page, "html"):
    out = page.html
if (out is None or out == "") and hasattr(page, "body"):
    body = page.body
    if isinstance(body, (bytes, bytearray)):
        out = body.decode("utf-8", errors="replace")
    elif body is not None:
        out = str(body)
if (out is None or out == "") and hasattr(page, "text"):
    try:
        out = str(page.text)
    except Exception:
        out = None
if out is None:
    out = str(page)
status = getattr(page, "status", None)
try:
    status = int(status) if status is not None else 200
except Exception:
    status = 200

result = {
    "html": out if out is not None else "",
    "status": status,
    "headers": normalize_output_headers(getattr(page, "headers", {})),
    "url": str(getattr(page, "url", url)),
}
print(json.dumps(result, ensure_ascii=False))
`;

  const rawOutput = await runPy(
    pythonCmd,
    py,
    JSON.stringify(payload),
    Math.max(5000, Number(timeout) * 1000)
  );

  let parsed = null;
  let html = "";
  let status = 200;
  let headers = {};
  let resolvedUrl = String(url);

  const trimmed = String(rawOutput || "").trim();
  if (trimmed) {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const candidates = lines.length > 1 ? [lines[lines.length - 1], trimmed] : [trimmed];
    for (const candidate of candidates) {
      try {
        parsed = JSON.parse(candidate);
        break;
      } catch {}
    }
    if (!parsed) {
      html = trimmed;
    }
  }

  if (parsed && typeof parsed === "object") {
    html = typeof parsed.html === "string" ? parsed.html : String(parsed.html || "");
    status = Number.isFinite(Number(parsed.status)) ? Number(parsed.status) : 200;
    headers = (parsed.headers && typeof parsed.headers === "object") ? parsed.headers : {};
    if (parsed.url != null && String(parsed.url).trim()) resolvedUrl = String(parsed.url);
  }

  if (payload.cssSelector) {
    html = applyCssSelector(html, payload.cssSelector);
  }

  return { html, status, headers, url: resolvedUrl, fetchMode: payload.mode, runtime: "shell", elapsed: null };
}

module.exports = { fetch };
