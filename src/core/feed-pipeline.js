"use strict";

const { isBlockedPage } = require("./blocked-page");
const Parser = require("rss-parser");
const { context } = require("../network/context");
const { isCancelled, throwIfAborted } = require("../network/abort");
const { getScrapling } = require("../extensions/Scrapling");
const { expert } = require("./diagnostics");
const { createLogger } = require("./logger");
const { errorRecord } = require("./errors");
const logger = createLogger("Feed pipeline");

function createDefaultParser() {
  return new Parser({
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) XFeeder/2.2.0",
      "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
}

function createFeedPipeline({
  config,
  getConfig,
  configPath = "./config.json",
  getFeedValidator,
  getFeedItems,
  setFeedSnapshot,
  download,
  getWithFallback,
  postWithFallback,
  builtInParsers = [],
  parser = createDefaultParser(),
} = {}) {
  function createParserHttpClient(url, downloadResult, requestContext) {
    async function get(requestUrl, opts = {}) {
      if (downloadResult?.ok && requestUrl === url) {
        return {
          status: downloadResult.status ?? null,
          data: downloadResult.data,
          headers: downloadResult.headers || {},
        };
      }

      return getWithFallback(requestUrl, { ...opts, ...requestContext });
    }

    async function post(requestUrl, data, opts = {}) {
      return postWithFallback(requestUrl, data, { ...opts, ...requestContext });
    }

    return {
      get,
      post,
      http: {
        get,
        post,
      },
      ...requestContext,
    };
  }

  async function fetchFeed(url, options = {}) {
    const signal = options.signal || context().signal;
    throwIfAborted(signal);
    let items = [];
    const activeConfig = typeof getConfig === "function" ? getConfig() : (config || {});
    const startedAt = Date.now();

    const requestContext = { configPath, config: activeConfig, signal };
    const validator = typeof getFeedValidator === "function" ? getFeedValidator(url) : null;
    expert("feed.begin", {
      url,
      hasEtag: Boolean(validator?.etag),
      hasLastModified: Boolean(validator?.lastModified),
    });
    const saveSnapshot = async (items, headers = {}) => {
      if (typeof setFeedSnapshot !== "function" || !dl?.ok || dl.status === 304) return;
      const responseHeaders = headers || {};
      const header = (name) => {
        const key = Object.keys(responseHeaders).find((candidate) => candidate.toLowerCase() === name);
        return key ? responseHeaders[key] : "";
      };
      throwIfAborted(signal);
      await setFeedSnapshot(url, {
        etag: header("etag"),
        lastModified: header("last-modified"),
      }, items);
    };
    const dl = await download(url, {
      accept: "auto",
      etag: validator?.etag,
      lastModified: validator?.lastModified,
      ...requestContext,
    });
    const bodyBytes = typeof dl?.data === "string"
      ? Buffer.byteLength(dl.data)
      : (Buffer.isBuffer(dl?.data) ? dl.data.length : null);
    expert("feed.download.complete", {
      url,
      ok: Boolean(dl?.ok),
      status: dl?.status ?? null,
      reason: dl?.reason ?? null,
      contentType: dl?.contentType || "",
      bodyBytes,
      notModified: Boolean(dl?.notModified),
      scrapling: Boolean(dl?.scrapling),
      scraplingMode: dl?.scraplingMode || null,
      scraplingRuntime: dl?.scraplingRuntime || dl?.scraplingRuntimeResolved || null,
      elapsedMs: dl?.elapsed || Date.now() - startedAt,
      antiBot: dl?.antiBotSignals ? {
        blocked: Boolean(dl.antiBotSignals.blocked),
        score: dl.antiBotSignals.score,
        reasons: dl.antiBotSignals.reasons,
      } : null,
    });
    // Never replay or update snapshots/delivery state for an unresolved challenge.
    if (isBlockedPage(dl.data, { status: dl.status, headers: dl.headers }) ||
        ["ANTIBOT_CHALLENGE_UNRESOLVED", "SCRAPLING_BLOCKED"].includes(dl.reason)) {
      context().onFailure?.(new Error("Challenge/error page rejected"));
      expert("feed.blocked_page", { url, status: dl.status, reason: dl.reason });
      return [];
    }
    if (dl.ok && dl.notModified) {
      const cachedItems = typeof getFeedItems === "function" ? getFeedItems(url) : [];
      expert("feed.not_modified", {
        url,
        replayedItems: cachedItems.length,
        durationMs: Date.now() - startedAt,
      });
      return cachedItems;
    }
    if (!dl.ok && ["INVALID_URL", "UNSUPPORTED_PROTOCOL"].includes(dl.reason)) {
      logger.warn("Unsupported feed source", { url, reason: dl.reason });
      expert("feed.unsupported_source", { url, reason: dl.reason, durationMs: Date.now() - startedAt });
      return [];
    }
    if (!dl.ok) {
      context().onFailure?.(dl.error || new Error(dl.reason || "Feed download failed"));
      logger.warn("Feed download failed; replaying saved entries if available", { url, failure: errorRecord(dl.error || new Error(dl.reason || "Request failed"), { context: "source" }) });
      const cachedItems = typeof getFeedItems === "function" ? getFeedItems(url) : [];
      expert("feed.skipped", {
        url,
        reason: dl.reason || dl.error?.message || "request failed",
        replayedItems: cachedItems.length,
        durationMs: Date.now() - startedAt,
      });
      return cachedItems;
    }
    // If Scrapling fetched HTML successfully, parse it immediately with configured selectors.
    if (dl.ok && dl.scrapling && typeof dl.data === "string") {
      try {
        const scrapling = getScrapling(activeConfig || {});
        const format = scrapling.utils.detectFeedFormat(dl.data);
        if (format === "html") {
          const perUrl = scrapling.config.getUrlConfig(url);
          const htmlOptions = perUrl.htmlParseOptions || {};
          const parsed = scrapling.parseHtmlToFeed(dl.data, htmlOptions);
          if (Array.isArray(parsed) && parsed.length) {
            logger.info("Scrapling HTML parsed", { url, count: parsed.length });
            expert("feed.parsed", { url, parser: "scrapling-html", itemCount: parsed.length, durationMs: Date.now() - startedAt });
            await saveSnapshot(parsed, dl.headers);
            return parsed;
          }
        }
      } catch (err) {
        if (err?.code === "CACHE_UNSAFE" || isCancelled(err) || signal?.aborted) throw err;
        logger.warn("Scrapling HTML parser failed", { url, failure: errorRecord(err, { context: "parser" }) });
        expert("feed.parser.failed", { url, parser: "scrapling-html", error: err });
      }
    }

    throwIfAborted(signal);
    const parserHttpClient = createParserHttpClient(url, dl, requestContext);
    for (const builtInParser of builtInParsers) {
      const parserName = builtInParser.name || "anonymous";
      expert("feed.parser.begin", { url, parser: parserName });
      try {
        const parsed = await builtInParser(url, parserHttpClient);
        if (parsed && parsed.length) {
          logger.info("Feed parsed", { url, parser: parserName, count: parsed.length });
          expert("feed.parsed", { url, parser: parserName, itemCount: parsed.length, durationMs: Date.now() - startedAt });
          await saveSnapshot(parsed, dl.headers);
          return parsed;
        }
        expert("feed.parser.no_match", { url, parser: parserName });
      } catch (err) {
        if (err?.code === "CACHE_UNSAFE" || isCancelled(err) || signal?.aborted) throw err;
        logger.warn("Feed parser failed", { parser: parserName, failure: errorRecord(err, { context: "parser" }) });
        expert("feed.parser.failed", { url, parser: parserName, error: err });
      }
    }

    try {
      if (typeof dl.data === "string" && dl.data.includes("<item")) {
        const matches = [...dl.data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
        items = matches.map((match) => {
          const getTag = (tag) =>
            (match[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "").trim();
          return {
            title: getTag("title") || "No title",
            link: getTag("link"),
            contentSnippet: (getTag("description") || "").replace(/<[^>]+>/g, "").substring(0, 400),
            isoDate: getTag("pubDate") || null,
            enclosure: null,
            author: getTag("author") || "",
            guid: getTag("guid") || getTag("link"),
            categories: [],
          };
        });
        if (items.length) {
          logger.info("Regex RSS parsed", { url, count: items.length });
          expert("feed.parsed", { url, parser: "rss-regex", itemCount: items.length, durationMs: Date.now() - startedAt });
          await saveSnapshot(items, dl.headers);
          return items;
        }
      }
    } catch (err) {
        if (err?.code === "CACHE_UNSAFE" || isCancelled(err) || signal?.aborted) throw err;
      logger.warn("Regex RSS parser failed", { url, failure: errorRecord(err, { context: "parser" }) });
      expert("feed.parser.failed", { url, parser: "rss-regex", error: err });
    }

    try {
      if (typeof dl.data === "string" && dl.data.trim()) {
        const feed = await parser.parseString(dl.data);
        if (feed?.items?.length) {
          items = feed.items.map((entry) => ({
            title: entry.title || "No title",
            link: entry.link,
            contentSnippet: entry.contentSnippet || entry.content || "",
            isoDate: entry.isoDate || entry.pubDate || null,
            enclosure: entry.enclosure?.url || null,
            author: entry.creator || entry.author || null,
            guid: entry.guid || entry.link,
            categories: entry.categories || [],
          }));
          logger.info("RSS parser completed", { url, count: items.length });
          expert("feed.parsed", { url, parser: "rss-parser", itemCount: items.length, durationMs: Date.now() - startedAt });
          await saveSnapshot(items, dl.headers);
          return items;
        }
      }
    } catch (err) {
        if (err?.code === "CACHE_UNSAFE" || isCancelled(err) || signal?.aborted) throw err;
      logger.warn("RSS parser failed", { url, failure: errorRecord(err, { context: "parser" }) });
      expert("feed.parser.failed", { url, parser: "rss-parser", error: err });
    }

    logger.error("No data from feed", { url });
    expert("feed.empty", { url, durationMs: Date.now() - startedAt });
    return [];
  }

  return {
    fetchFeed,
  };
}

module.exports = {
  createDefaultParser,
  createFeedPipeline,
};
