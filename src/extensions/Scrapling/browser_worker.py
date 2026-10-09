"""Persistent browser-session worker for XFeeder's Scrapling adapter."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import signal
import sys
import traceback
from collections import OrderedDict
from urllib.parse import urlsplit

PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr
MAX_SESSIONS = 4
sessions = OrderedDict()
stopping = False


def as_dict(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None
    return None


def as_list(value):
    if value is None:
        return None
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
        return [item.strip() for item in text.split(",") if item.strip()]
    return [value]


def as_set(value):
    values = as_list(value)
    if values is None:
        return None
    cleaned = {str(item).strip() for item in values if str(item).strip()}
    return cleaned or None


def as_headers(value):
    if isinstance(value, dict):
        return {str(key): str(item) for key, item in value.items() if item is not None}
    result = {}
    for item in as_list(value) or []:
        text = str(item)
        if ":" in text:
            key, header_value = text.split(":", 1)
            result[key.strip()] = header_value.strip()
    return result or None


def as_browser_cookies(value, default_url):
    if isinstance(value, list):
        result = []
        for item in value:
            if not isinstance(item, dict) or "name" not in item or "value" not in item:
                continue
            cookie = dict(item)
            cookie["name"] = str(cookie["name"])
            cookie["value"] = str(cookie["value"])
            if "url" not in cookie and "domain" not in cookie:
                cookie["url"] = default_url
            result.append(cookie)
        return result or None
    if isinstance(value, dict):
        return [
            {"name": str(key), "value": str(item), "url": default_url}
            for key, item in value.items()
            if item is not None
        ] or None
    if isinstance(value, str):
        result = []
        for part in value.split(";"):
            part = part.strip()
            if "=" in part:
                key, item = part.split("=", 1)
                result.append({"name": key.strip(), "value": item.strip(), "url": default_url})
        return result or None
    return None


def load_callable(value, default_name):
    if value is None:
        return None
    function_name = default_name
    code = None
    if isinstance(value, str):
        source = value.strip()
        if not source:
            return None
        if os.path.exists(source):
            with open(source, "r", encoding="utf-8") as handle:
                code = handle.read()
        else:
            code = source
    elif isinstance(value, dict):
        function_name = str(value.get("function") or value.get("name") or default_name)
        if value.get("code") is not None:
            code = str(value["code"])
        else:
            source_path = value.get("path") or value.get("file")
            if source_path and os.path.exists(str(source_path)):
                with open(str(source_path), "r", encoding="utf-8") as handle:
                    code = handle.read()
    if not code:
        return None
    namespace = {}
    exec(code, namespace, namespace)
    candidate = namespace.get(function_name)
    if callable(candidate):
        return candidate
    fallback = namespace.get(default_name)
    return fallback if callable(fallback) else None


def browser_options(options, url):
    from scrapling.engines.toolbelt.proxy_rotation import ProxyRotator

    proxy_rotator = None
    raw_rotator = as_list(options.get("proxyRotator", options.get("proxy_rotator")))
    if raw_rotator:
        proxies = []
        for proxy in raw_rotator:
            if isinstance(proxy, str) and proxy.strip():
                proxies.append(proxy.strip())
            elif isinstance(proxy, dict) and proxy.get("server"):
                entry = {"server": str(proxy["server"])}
                if proxy.get("username") is not None:
                    entry["username"] = str(proxy["username"])
                if proxy.get("password") is not None:
                    entry["password"] = str(proxy["password"])
                proxies.append(entry)
        if proxies:
            proxy_rotator = ProxyRotator(proxies)

    additional_args = as_dict(options.get("additionalArgs", options.get("additional_args")))
    selector_config = as_dict(options.get("selectorConfig", options.get("selector_config")))

    result = {
        "headless": options.get("headless", True),
        "disable_resources": options.get("disableResources", options.get("disable_resources", False)),
        "blocked_domains": as_set(options.get("blockedDomains", options.get("blocked_domains"))),
        "cookies": as_browser_cookies(options.get("cookies"), url),
        "useragent": options.get("useragent", options.get("userAgent")),
        "network_idle": options.get("networkIdle", options.get("network_idle", False)),
        "load_dom": options.get("loadDom", options.get("load_dom", True)),
        "timeout": options.get("timeoutMs", options.get("timeout_ms", options.get("timeout", 30000))),
        "wait": options.get("wait", 0),
        "page_action": load_callable(options.get("pageAction", options.get("page_action")), "page_action"),
        "page_setup": load_callable(options.get("pageSetup", options.get("page_setup")), "page_setup"),
        "wait_selector": options.get("waitSelector", options.get("wait_selector")),
        "wait_selector_state": options.get("waitSelectorState", options.get("wait_selector_state")),
        "init_script": options.get("initScript", options.get("init_script")),
        "google_search": options.get("googleSearch", options.get("google_search", True)),
        "locale": options.get("locale"),
        "timezone_id": options.get("timezoneId", options.get("timezone_id")),
        "cdp_url": options.get("cdpUrl", options.get("cdp_url")),
        "user_data_dir": options.get("userDataDir", options.get("user_data_dir")),
        "extra_flags": as_list(options.get("extraFlags", options.get("extra_flags"))),
        "additional_args": additional_args,
        "selector_config": selector_config,
        "real_chrome": options.get("realChrome", options.get("real_chrome", False)),
        "proxy": options.get("proxy"),
        "extra_headers": as_headers(options.get("extraHeaders", options.get("extra_headers", options.get("headers")))),
        "dns_over_https": options.get("dnsOverHttps", options.get("dns_over_https", False)),
        "block_ads": options.get("blockAds", options.get("block_ads", False)) or options.get("aiTargeted", False),
        "retries": options.get("retries"),
        "retry_delay": options.get("retryDelay", options.get("retry_delay")),
        "capture_xhr": options.get("captureXhr", options.get("capture_xhr")),
        "executable_path": options.get("executablePath", options.get("executable_path")),
        "max_pages": options.get("maxPages", options.get("max_pages")),
        "proxy_rotator": proxy_rotator,
    }
    return {key: value for key, value in result.items() if value is not None}


def get_session(mode, url, options):
    from scrapling.fetchers import DynamicSession, StealthySession

    parsed = urlsplit(url)
    origin = f"{parsed.scheme}://{parsed.netloc}".lower()
    config = browser_options(options, url)
    session_options = {
        key: value
        for key, value in options.items()
        if key not in {
            "url",
            "mode",
            "extractMode",
            "fetchMode",
            "runtimeMode",
            "transport",
            "includeResponseMetadata",
            "cssSelector",
            "antiBot",
        }
    }
    # Session identity includes the exact browser options to avoid sharing cookies or
    # browser state between distinct per-URL configurations on the same host.
    identity_source = json.dumps(
        {
            "mode": mode,
            "origin": origin,
            "cookieScopeUrl": url if options.get("cookies") else "",
            "options": session_options,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    key = hashlib.sha256(identity_source.encode("utf-8")).hexdigest()
    if key in sessions:
        session = sessions.pop(key)
        sessions[key] = session
        return session

    while len(sessions) >= MAX_SESSIONS:
        _, old_session = sessions.popitem(last=False)
        with contextlib.suppress(Exception):
            old_session.close()

    session_class = StealthySession if mode == "stealthy-fetch" else DynamicSession
    session = session_class(**config)
    session.start()
    sessions[key] = session
    return session


def close_sessions():
    while sessions:
        _, session = sessions.popitem(last=False)
        with contextlib.suppress(Exception):
            session.close()


def handle_request(request):
    request_id = request.get("id")
    if request.get("action") == "shutdown":
        close_sessions()
        return {"id": request_id, "closed": True}

    mode = request.get("mode")
    url = request.get("url")
    options = request.get("options") or {}
    if mode not in {"fetch", "stealthy-fetch"}:
        raise ValueError(f"Unsupported persistent browser mode: {mode}")
    if not isinstance(url, str) or not url:
        raise ValueError("Persistent browser request requires a URL")

    session = get_session(mode, url, options)
    response = session.fetch(url)
    html = getattr(response, "html", None)
    if html is None:
        body = getattr(response, "body", None)
        html = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body or "")
    status = getattr(response, "status", None)
    try:
        status = int(status) if status is not None else None
    except Exception:
        status = None
    headers = getattr(response, "headers", {})
    try:
        headers = {str(key): str(value) for key, value in dict(headers or {}).items()}
    except Exception:
        headers = {}
    return {
        "id": request_id,
        "html": str(html or ""),
        "status": status,
        "headers": headers,
        "url": str(getattr(response, "url", url) or url),
    }


def write_response(response):
    PROTOCOL_OUT.write(json.dumps(response, ensure_ascii=False) + "\n")
    PROTOCOL_OUT.flush()


def main():
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            request_id = request.get("id")
            is_shutdown = request.get("action") == "shutdown"
            with contextlib.redirect_stdout(sys.stderr):
                response = handle_request(request)
            write_response(response)
            if is_shutdown:
                return
        except Exception as error:
            if stopping:
                return
            traceback.print_exc(file=sys.stderr)
            write_response({"id": request.get("id"), "error": str(error)})
    close_sessions()


if __name__ == "__main__":
    def terminate(_signal, _frame):
        global stopping
        stopping = True
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    try:
        main()
    finally:
        close_sessions()
