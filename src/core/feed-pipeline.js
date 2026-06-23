"use strict";

const Parser = require("rss-parser");
const { getScrapling } = require("../extensions/Scrapling");

function createDefaultParser() {
  return new Parser({
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) XFeeder/2.1",
      "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
}

function createFeedPipeline({
  config,
  getConfig,
  download,
  getWithFallback,
  postWithFallback,
  builtInParsers = [],
  parser = createDefaultParser(),
} = {}) {
  function createParserHttpClient(url, downloadResult) {
    async function get(requestUrl, opts = {}) {
      if (downloadResult?.ok && requestUrl === url) {
        return {
          status: downloadResult.status || 200,
          data: downloadResult.data,
          headers: downloadResult.headers || {},
        };
      }

      return getWithFallback(requestUrl, opts);
    }

    return {
      get,
      post: postWithFallback,
      http: {
        get,
        post: postWithFallback,
      },
    };
  }

  async function fetchFeed(url) {
    let items = [];
    const activeConfig = typeof getConfig === "function" ? getConfig() : (config || {});

    const dl = await download(url, { accept: "auto" });
    if (dl.ok && dl.notModified) {
      return [];
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
            console.log(`[Scrapling HTML] Success (${parsed.length}) → ${url}`);
            return parsed;
          }
        }
      } catch (err) {
        console.warn(`[Scrapling HTML] Error for ${url}: ${err.message}`);
      }
    }

    const parserHttpClient = createParserHttpClient(url, dl);
    for (const builtInParser of builtInParsers) {
      try {
        const parsed = await builtInParser(url, parserHttpClient);
        if (parsed && parsed.length) {
          console.log(`[Parser:${builtInParser.name}] Success (${parsed.length}) → ${url}`);
          return parsed;
        }
      } catch (err) {
        console.warn(`[Parser:${builtInParser.name}] Error: ${err.message}`);
      }
    }

    try {
      if (dl.ok && typeof dl.data === "string" && dl.data.includes("<item")) {
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
          console.log(`[Downloader/regex] Success (${items.length}) → ${url}`);
          return items;
        }
      } else if (!dl.ok) {
        const res = await getWithFallback(url, {
          headers: {
            "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        if (res && res.status === 304) return [];
        if (res && res.status === 200 && typeof res.data === "string" && res.data.includes("<item")) {
          const matches = [...res.data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
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
            console.log(`[Axios-regex] Success (${items.length}) → ${url}`);
            return items;
          }
        }
      }
    } catch (err) {
      console.warn(`[Axios-regex] Error for ${url}: ${err.message}`);
    }

    try {
      if (dl.ok && typeof dl.data === "string" && dl.data.trim()) {
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
          console.log(`[RSSParser] Success (${items.length}) → ${url}`);
          return items;
        }
      } else {
        const res = await getWithFallback(url, {
          headers: {
            "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        if (res && res.status === 304) return [];
        if (res && typeof res.data === "string" && res.data.trim()) {
          const feed = await parser.parseString(res.data);
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
            console.log(`[RSSParser] Success (${items.length}) → ${url}`);
            return items;
          }
        }
      }
    } catch (err) {
      console.warn(`[RSSParser] Error for ${url}: ${err.message}`);
    }

    console.error(`⚠️ No data from ${url}`);
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
