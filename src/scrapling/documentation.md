</details>

---

## 🔧 Pliki do ZMIANY (ISTNIEJĄCE)

### 8. `src/parsers/downloader.js` - ZMIEŃ CAŁY PLIK

**Lokalizacja:** `src/parsers/downloader.js`

**Akcja:** Zastąp CAŁY obecny kod tym nowym kodem:

<details>
<summary>Kliknij aby rozwinąć pełny nowy downloader.js</summary>

```javascript
// src/parsers/downloader.js - HTTP downloader with Scrapling integration
"use strict";

const { getWithFallback } = require("../client");
const { getScrapling } = require("../scrapling");

function buildAccept(accept) {
  switch ((accept || "auto").toLowerCase()) {
    case "xml":
    case "rss":
    case "atom":
      return "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8";
    case "json":
      return "application/feed+json,application/json,text/json;q=0.9,*/*;q=0.8";
    case "html":
      return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    case "auto":
    default:
      return "application/rss+xml,application/atom+xml,application/xml,application/json;q=0.9,*/*;q=0.8";
  }
}

function shouldTryScrapling(response) {
  if (!response) return false;
  
  const scrapling = getScrapling();
  if (!scrapling.enabled) return false;
  
  const status = response?.status || response?.response?.status;
  if (scrapling.utils.isProtectedStatus(status)) {
    console.log(`[Downloader] Status ${status} detected - will try Scrapling`);
    return true;
  }
  
  const headers = response?.headers || response?.response?.headers;
  if (headers && scrapling.utils.isCloudflareProtected(headers)) {
    console.log('[Downloader] Cloudflare detected - will try Scrapling');
    return true;
  }
  
  const errorMessage = response?.message || response?.response?.data || '';
  const protectionIndicators = [
    'cloudflare',
    'cf-ray',
    'access denied',
    'please enable cookies',
    'checking your browser',
    'just a moment',
    'ddos protection',
    'rate limit'
  ];
  
  if (typeof errorMessage === 'string') {
    const lowerMessage = errorMessage.toLowerCase();
    for (const indicator of protectionIndicators) {
      if (lowerMessage.includes(indicator)) {
        console.log(`[Downloader] Protection indicator "${indicator}" found - will try Scrapling`);
        return true;
      }
    }
  }
  
  return false;
}

async function fetchWithScrapling(url, opts = {}) {
  const scrapling = getScrapling();
  
  const scraplingConfig = scrapling.config.getUrlConfig(url);
  
  const scraplingOptions = {
    ...scraplingConfig,
    ...(opts.scrapling || {}),
    headers: opts.headers || {},
    timeout: Math.floor((opts.timeout || 30000) / 1000),
  };
  
  const proxyUrl = opts.proxy || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxyUrl) {
    scraplingOptions.proxy = proxyUrl;
  }
  
  console.log(`[Downloader] Using Scrapling (${scraplingOptions.mode || 'stealthy-fetch'}) for ${url}`);
  
  try {
    const startTime = Date.now();
    const response = await scrapling.fetch(url, scraplingOptions);
    const elapsed = Date.now() - startTime;
    
    console.log(`[Downloader] Scrapling success in ${elapsed}ms`);
    
    let contentType = 'text/html';
    if (response.html) {
      const format = scrapling.utils.detectFeedFormat(response.html);
      if (format === 'rss') contentType = 'application/rss+xml';
      else if (format === 'atom') contentType = 'application/atom+xml';
      else if (format === 'json') contentType = 'application/json';
    }
    
    return {
      ok: true,
      status: response.status || 200,
      headers: response.headers || { 'content-type': contentType },
      data: response.html || response.data,
      contentType,
      scrapling: true,
      scraplingMode: response.fetchMode,
      elapsed: response.elapsed
    };
    
  } catch (err) {
    console.error(`[Downloader] Scrapling failed: ${err.message}`);
    
    return {
      ok: false,
      error: err,
      scraplingFailed: true
    };
  }
}

async function download(url, opts = {}) {
  let u;
  try {
    u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "UNSUPPORTED_PROTOCOL" };
    }
  } catch (err) {
    console.error(`[Downloader] Invalid URL: ${url}`);
    return { ok: false, error: err, reason: "INVALID_URL" };
  }

  const scrapling = getScrapling();
  const forceScrapling = opts.useScrapling || 
                        (scrapling.enabled && scrapling.config.shouldUseScrapling(url));
  
  if (forceScrapling) {
    console.log(`[Downloader] Scrapling explicitly requested for ${url}`);
    const result = await fetchWithScrapling(url, opts);
    if (result.ok) return result;
    if (opts.useScrapling) {
      return result;
    }
  }

  const headers = {
    Accept: buildAccept(opts.accept),
    ...(opts.headers || {}),
  };

  if (opts.etag) {
    headers['If-None-Match'] = opts.etag;
  }
  if (opts.lastModified) {
    headers['If-Modified-Since'] = opts.lastModified;
  }

  try {
    const res = await getWithFallback(url, { 
      headers, 
      timeout: opts.timeout,
      responseType: opts.responseType
    });
    
    if (res?.status === 304) {
      return {
        ok: true,
        status: 304,
        headers: res.headers || {},
        data: "",
        notModified: true
      };
    }

    if (shouldTryScrapling(res)) {
      const scraplingResult = await fetchWithScrapling(url, opts);
      if (scraplingResult.ok) {
        return scraplingResult;
      }
      console.log('[Downloader] Scrapling failed, returning original response');
    }

    const ct = (res?.headers?.["content-type"] || res?.headers?.["Content-Type"] || "").toString();
    
    return {
      ok: true,
      status: res?.status,
      headers: res?.headers || {},
      data: res?.data,
      contentType: ct,
    };
    
  } catch (err) {
    if (shouldTryScrapling(err)) {
      const scraplingResult = await fetchWithScrapling(url, opts);
      if (scraplingResult.ok) {
        return scraplingResult;
      }
    }
    
    return {
      ok: false,
      error: err,
      status: err?.response?.status
    };
  }
}

function parseHtmlToFeedItems(data, url) {
  const scrapling = getScrapling();
  
  if (!data || typeof data !== 'string') return null;
  
  const format = scrapling.utils.detectFeedFormat(data);
  if (format !== 'html') return null;
  
  console.log('[Downloader] Converting HTML to feed items');
  
  const config = scrapling.config.getUrlConfig(url);
  const parseOptions = config.htmlParseOptions || {};
  
  const items = scrapling.parseHtmlToFeed(data, parseOptions);
  
  if (items.length > 0) {
    console.log(`[Downloader] Extracted ${items.length} items from HTML`);
  } else {
    console.warn('[Downloader] No items extracted from HTML');
  }
  
  return items;
}

async function downloadEnhanced(url, opts = {}) {
  const result = await download(url, opts);
  
  if (result.ok && result.scrapling && result.data) {
    const feedItems = parseHtmlToFeedItems(result.data, url);
    if (feedItems && feedItems.length > 0) {
      result.feedItems = feedItems;
      result.isHtmlConverted = true;
    }
  }
  
  return result;
}

const metadataCache = new Map();

async function downloadWithCache(url, opts = {}) {
  const cached = metadataCache.get(url);
  
  if (cached) {
    opts.etag = cached.etag;
    opts.lastModified = cached.lastModified;
  }
  
  const result = await downloadEnhanced(url, opts);
  
  if (result.ok && !result.notModified) {
    const etag = result.headers?.etag || result.headers?.ETag;
    const lastModified = result.headers?.['last-modified'] || result.headers?.['Last-Modified'];
    
    if (etag || lastModified) {
      metadataCache.set(url, { etag, lastModified });
    }
  }
  
  return result;
}

module.exports = { 
  download,
  downloadEnhanced,
  downloadWithCache,
  buildAccept,
  shouldTryScrapling,
  fetchWithScrapling,
  parseHtmlToFeedItems
};