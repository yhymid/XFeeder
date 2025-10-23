// main.js - Główny plik aplikacji XFeeder 1.3 (Core Stability Pack)
"use strict";

const fs = require("fs");
const path = require("path");
const { sendMessage } = require("./src/message");

// Import klienta HTTP z fallbackiem + per-host cooldown
const clientMod = require("./src/client");
const getWithFallback = clientMod.getWithFallback;
const isHostOnCooldown = clientMod.isHostOnCooldown || (() => false);
const getHostCooldown = clientMod.getHostCooldown || (() => null);

// Import parserów wbudowanych
const { parseRSS } = require("./src/parsers/rss");
const { parseAtom } = require("./src/parsers/atom");
const { parseYouTube } = require("./src/parsers/youtube");
const { parseXML } = require("./src/parsers/xml");
const { parseJSON } = require("./src/parsers/json");
const { parseApiX } = require("./src/parsers/api_x");
const { parseFallback } = require("./src/parsers/fallback");
const { parseDiscord } = require("./src/parsers/discord");

// Workshop (loader)
const { loadWorkshop } = require("./src/workshop/loader");

// Utils do XFeederAPI
const { stripHtml } = require("string-strip-html");
const { parseDate } = require("./src/parsers/utils");

// ------------------------------------------------------------
// Zaawansowany Logger (CrashLog.txt, ErrorLog.txt, WarnLog.txt) z opcją wyłączenia przez Settings.Logs
// ------------------------------------------------------------
const LOG_FILES = {
  WARN: path.resolve("./WarnLog.txt"),
  ERROR: path.resolve("./ErrorLog.txt"),
  CRASH: path.resolve("./CrashLog.txt"),
};
const SENSITIVE_KEYS = [
  "token",
  "webhook",
  "authorization",
  "cookie",
  "x-super-properties",
  "password",
  "secret",
  "apikey",
  "api_key",
  "bearer",
];

// Domyślnie logi do plików włączone — zaktualizujemy po wczytaniu config
let LOG_ENABLED = true;

const origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function redactString(str) {
  if (!str || typeof str !== "string") return str;
  let s = str;
  // webhooki Discord
  s = s.replace(
    /https?:\/\/(?:ptb\.|canary\.)?discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_\-\.]+/gi,
    "[REDACTED_WEBHOOK]"
  );
  // Authorization / token w tekście
  s = s.replace(
    /(authorization|token|cookie|x-super-properties|apikey|api_key|secret)\s*[:=]\s*([^\s,]+)/gi,
    (m, k) => `${k}: [REDACTED]`
  );
  return s;
}
function redact(obj) {
  if (obj == null) return obj;
  if (typeof obj === "string") return redactString(obj);
  if (Array.isArray(obj)) return obj.map((v) => redact(v));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      if (SENSITIVE_KEYS.some((s) => lower.includes(s))) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return obj;
}
function pickHeaders(h) {
  if (!h) return undefined;
  const keys = [
    "content-type",
    "content-length",
    "date",
    "cf-ray",
    "server",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "retry-after",
  ];
  const out = {};
  for (const k of keys) {
    const v = h[k] ?? h[k.toLowerCase()] ?? h[k.toUpperCase()];
    if (v != null) out[k.toLowerCase()] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
function pickHttpError(err) {
  if (!err) return undefined;
  const e = {
    name: err.name,
    message: err.message,
    code: err.code,
  };
  if (err.config) {
    e.request = {
      url: err.config.url,
      method: err.config.method,
      headers: redact(err.config.headers),
      timeout: err.config.timeout,
    };
  }
  if (err.response) {
    e.response = {
      status: err.response.status,
      statusText: err.response.statusText,
      headers: pickHeaders(err.response.headers),
      data: (() => {
        try {
          const d = typeof err.response.data === "string" ? err.response.data : JSON.stringify(err.response.data);
          const trimmed = d.length > 2000 ? d.slice(0, 2000) + "...(trimmed)" : d;
          return redactString(trimmed);
        } catch {
          return "[unserializable]";
        }
      })(),
    };
  }
  if (err.stack) {
    e.stack = err.stack.split("\n").slice(0, 10).join("\n");
  }
  return e;
}
function codeContext(depth = 2) {
  const stack = new Error().stack?.split("\n").slice(depth) || [];
  const line = stack[0]?.trim();
  return { at: line, stack: stack.slice(0, 8).join("\n") };
}
function appendFileSafe(file, text) {
  try {
    fs.appendFileSync(file, text, "utf8");
  } catch (e) {
    origConsole.error("[Logger] Append error:", e.message);
  }
}
function writeLog(level, message, context) {
  const ts = new Date().toISOString();
  const base = {
    ts,
    level,
    message: redactString(message || ""),
    code: codeContext(4),
    context: redact(context || {}),
  };
  const block =
    "-----\n" +
    `[${ts}] [${level}] ${base.message}\n` +
    (base.code?.at ? `at: ${base.code.at}\n` : "") +
    (base.code?.stack ? `stack:\n${base.code.stack}\n` : "") +
    (base.context ? `context:\n${JSON.stringify(base.context, null, 2)}\n` : "") +
    "-----\n";
  // Konsola
  if (level === "WARN") origConsole.warn(`[WARN] ${message}`);
  else if (level === "ERROR") origConsole.error(`[ERROR] ${message}`);
  else origConsole.error(`[CRASH] ${message}`);
  // Plik (jeśli włączone w Settings.Logs)
  if (LOG_ENABLED) {
    if (level === "WARN") appendFileSafe(LOG_FILES.WARN, block);
    else if (level === "ERROR") appendFileSafe(LOG_FILES.ERROR, block);
    else appendFileSafe(LOG_FILES.CRASH, block);
  }
}
const Logger = {
  warn: (msg, ctx) => writeLog("WARN", msg, ctx),
  error: (msg, ctx) => writeLog("ERROR", msg, ctx),
  crash: (msg, err, ctx) => {
    const merged = Object.assign({}, ctx || {}, { error: pickHttpError(err) || redact(err) });
    writeLog("CRASH", msg, merged);
  },
};

// Podmiana konsoli, by ostrzeżenia/błędy z zewnętrznych modułów też trafiły do logów
console.warn = (...args) => {
  try {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    Logger.warn(redactString(msg), { origin: "console.warn" });
  } catch {
    origConsole.warn(...args);
  }
};
console.error = (...args) => {
  try {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    Logger.error(redactString(msg), { origin: "console.error" });
  } catch {
    origConsole.error(...args);
  }
};

// ------------------------------------------------------------
// KONFIGURACJA (nowy config.json)
// ------------------------------------------------------------
let config;
try {
  config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
  LOG_ENABLED = config.Settings?.Logs !== false;
} catch (e) {
  Logger.crash("Nie udało się wczytać config.json", e, { file: "./config.json" });
  process.exit(1);
}

const GLOBAL_AUTH = config.Auth || {};

// ------------------------------------------------------------
// CACHE
// ------------------------------------------------------------
let cache = {};
const cacheFile = "./cache.json";
if (fs.existsSync(cacheFile)) {
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    origConsole.log(`[Cache] Załadowano (${Object.keys(cache).length} kanałów)`);
  } catch (e) {
    Logger.warn("Błąd przy wczytywaniu cache.json – tworzę nowy", { file: cacheFile, error: e?.message });
    cache = {};
  }
}
function saveCache() {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    Logger.error("Nie udało się zapisać cache.json", { file: cacheFile, error: e?.message });
  }
}

// ------------------------------------------------------------
// USTAWIENIA STABILNOŚCI + HELPERY
// ------------------------------------------------------------
const MAX_CACHE_PER_KEY = config.Settings?.MaxCachePerKey ?? 2000;
const SEND_DELAY_MS = config.Settings?.DelayBetweenSendsMs ?? 350;
const PARSER_TIMEOUT_MS = config.Settings?.ParserTimeoutMs ?? 15000;
const FETCH_CONCURRENCY = config.Settings?.FetchConcurrency ?? 3;
const delayBetweenChannels = config.Settings?.DelayBetweenChannelsMs ?? 30000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(promise, ms, label = "operation") {
  let t;
  const err = new Error(`Timeout: ${label} > ${ms}ms`);
  return Promise.race([
    promise,
    new Promise((_, rej) => (t = setTimeout(() => rej(err), ms))),
  ]).finally(() => clearTimeout(t));
}

function normalizeLink(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const rm = new Set(["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_name","fbclid","gclid","yclid","mc_cid","mc_eid","ref"]);
    for (const k of Array.from(url.searchParams.keys())) {
      if (k.toLowerCase().startsWith("utm_") || rm.has(k)) url.searchParams.delete(k);
    }
    return url.toString();
  } catch {
    return u;
  }
}

function pushCache(list, ids) {
  const prev = Array.isArray(list) ? list : [];
  const merged = [...ids, ...prev];
  if (merged.length > MAX_CACHE_PER_KEY) merged.length = MAX_CACHE_PER_KEY;
  return merged;
}

async function mapWithLimit(arr, limit, iteratee) {
  const ret = new Array(arr.length);
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) break;
      try { ret[idx] = await iteratee(arr[idx], idx); }
      catch (e) { ret[idx] = e; }
    }
  });
  await Promise.allSettled(workers);
  return ret;
}

// ------------------------------------------------------------
// XFeederAPI + WORKSHOP
// ------------------------------------------------------------
const XFeederAPI = {
  get: getWithFallback,
  send: sendMessage,
  utils: { parseDate, stripHtml },
  config,
};

const workshopEnabled = config.Workshop?.Enabled !== false;
const workshopDir = "src/workshop";

let workshopParsers = [];
if (workshopEnabled) {
  try {
    const loaded = loadWorkshop(
      { get: getWithFallback, send: sendMessage, utils: { parseDate, stripHtml }, config },
      workshopDir
    );
    workshopParsers = loaded.parsers || [];
  } catch (e) {
    Logger.error("[Workshop] Błąd inicjalizacji", { error: e?.message });
  }
} else {
  origConsole.log("[Workshop] Wyłączony w configu.");
}

// ------------------------------------------------------------
// FUNKCJE POMOCNICZE pod nowy config: wiele bloków Discord + merge Auth
// ------------------------------------------------------------
function getDiscordBlocks(channelConfig) {
  const out = [];
  if (!channelConfig || typeof channelConfig !== "object") return out;

  if (channelConfig.Discord) {
    if (Array.isArray(channelConfig.Discord)) {
      out.push(...channelConfig.Discord);
    } else if (typeof channelConfig.Discord === "object") {
      out.push(channelConfig.Discord);
    }
  }
  for (const key of Object.keys(channelConfig)) {
    if (/^Discord\d+$/i.test(key) && channelConfig[key] && typeof channelConfig[key] === "object") {
      out.push(channelConfig[key]);
    }
  }
  return out;
}

function mergeAuth(discordBlock) {
  return {
    ...discordBlock,
    Token: discordBlock.Token || GLOBAL_AUTH.Token,
    "x-super-properties": discordBlock["x-super-properties"] || GLOBAL_AUTH["x-super-properties"],
    cookie: discordBlock.cookie || GLOBAL_AUTH.cookie,
  };
}

function discordCacheKey(block) {
  const base =
    (block.GuildID && `g:${block.GuildID}`) ||
    (Array.isArray(block.ChannelIDs) && block.ChannelIDs.length && `ch:${block.ChannelIDs.join(",")}`) ||
    (block.Webhook && `wh:${String(block.Webhook).slice(-10)}`) ||
    "discord";
  return `discord:${base}`;
}

// ------------------------------------------------------------
// RSS Parser (używany tylko do parseString)
// ------------------------------------------------------------
const Parser = require("rss-parser");
const rssParser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) XFeeder/1.3",
    "Accept":
      "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

// ------------------------------------------------------------
// PIPELINE PARSERÓW
// ------------------------------------------------------------
function buildParsersPipeline() {
  const builtins = [
    { name: "parseYouTube", priority: 10, parse: (u, ctx) => parseYouTube(u, { get: ctx.get }) },
    { name: "parseAtom", priority: 20, parse: (u, ctx) => parseAtom(u, { get: ctx.get }) },
    { name: "parseXML", priority: 30, parse: (u, ctx) => parseXML(u, { get: ctx.get }) },
    { name: "parseJSON", priority: 40, parse: (u, ctx) => parseJSON(u, { get: ctx.get }) },
    { name: "parseApiX", priority: 50, parse: (u, ctx) => parseApiX(u, { get: ctx.get }) },
    { name: "parseRSS", priority: 60, parse: (u, ctx) => parseRSS(u, { get: ctx.get }) },
    { name: "parseFallback", priority: 90, parse: (u, ctx) => parseFallback(u, { get: ctx.get }) },
  ];
  const combined = [...workshopParsers, ...builtins].sort(
    (a, b) => (a.priority ?? 50) - (b.priority ?? 50)
  );
  return combined;
}

// ------------------------------------------------------------
// POBIERANIE FEEDA (z timeoutami, conditional i fallbackami)
// ------------------------------------------------------------
async function fetchFeed(url) {
  try {
    const host = new URL(url).host;
    if (host && isHostOnCooldown(url)) {
      const cd = getHostCooldown(url);
      const remain = Math.ceil((cd.until - Date.now()) / 1000);
      Logger.warn("Pomijam pobieranie — host na cooldownie", {
        url,
        host,
        cooldown: { remain_s: remain, reason: cd?.reason || cd?.status },
      });
      return [];
    }
  } catch {}

  const ctx = { get: getWithFallback, api: XFeederAPI };
  const parsers = buildParsersPipeline();

  // 1) Pluginy + wbudowane (z timeoutem)
  for (const p of parsers) {
    try {
      if (typeof p.test === "function") {
        const ok = await withTimeout(p.test(url, ctx), PARSER_TIMEOUT_MS, `test:${p.name}`);
        if (!ok) continue;
      }
      const parsed = await withTimeout(p.parse(url, ctx), PARSER_TIMEOUTMS, `parse:${p.name}`);
      if (parsed && parsed.length) {
        origConsole.log(`[Parser:${p.name}] Sukces (${parsed.length}) → ${url}`);
        return parsed;
      }
    } catch (err) {
      Logger.error(`[Parser:${p.name}] Błąd parsowania`, {
        url,
        parser: p.name,
        error: pickHttpError(err),
      });
    }
  }

  // 2) Axios-regex fallback
  try {
    const res = await getWithFallback(url, {
      headers: { Accept: "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8" },
      timeout: 15000
    });
    if (res && res.status === 200 && typeof res.data === "string" && res.data.includes("<item")) {
      const matches = [...res.data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      const items = matches.map((m) => {
        const getTag = (tag) =>
          (m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "").trim();
        return {
          title: getTag("title") || "Brak tytułu",
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
        origConsole.log(`[Axios-regex] Sukces (${items.length}) → ${url}`);
        return items;
      }
    }
  } catch (err) {
    Logger.error(`[Axios-regex] Błąd fallbacku`, {
      url,
      error: pickHttpError(err),
    });
  }

  // 3) rss-parser (bez własnego HTTP) — parseString
  try {
    const res = await getWithFallback(url, {
      headers: { Accept: "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8" },
      timeout: 15000
    });
    if (res && typeof res.data === "string") {
      const feed = await rssParser.parseString(res.data);
      if (feed?.items?.length) {
        const items = feed.items.map((entry) => ({
          title: entry.title || "Brak tytułu",
          link: entry.link,
          contentSnippet: entry.contentSnippet || entry.content || "",
          isoDate: entry.isoDate || entry.pubDate || null,
          enclosure: entry.enclosure?.url || null,
          author: entry.creator || entry.author || null,
          guid: entry.guid || entry.link,
          categories: entry.categories || [],
        }));
        origConsole.log(`[RSSParser] Sukces (${items.length}) → ${url}`);
        return items;
      }
    }
  } catch (err) {
    Logger.error(`[RSSParser] Błąd parseString`, { url, error: pickHttpError(err) });
  }

  Logger.warn("Brak danych z feeda", { url, reason: "Wszystkie parsery zwróciły pusty wynik" });
  return [];
}

// ------------------------------------------------------------
// SPRAWDZANIE KANAŁU
// ------------------------------------------------------------
async function checkFeedsForChannel(index, channelConfig) {
  if (!cache[index]) cache[index] = {};

  if (channelConfig.RSS && !channelConfig.Webhook) {
    Logger.warn("Brak Webhook dla kanału z RSS — nic nie zostanie wysłane", {
      channelIndex: index,
      config: {
        Thread: channelConfig.Thread ?? null,
        RequestSend: channelConfig.RequestSend ?? null,
        TimeChecker: channelConfig.TimeChecker ?? null,
      },
    });
  }

  const discordBlocks = getDiscordBlocks(channelConfig);
  // HTTP adapter dla Discord parsera (wspólny client z cooldownem/proxy)
  const discordHttp = { get: (url, opts = {}) => getWithFallback(url, opts) };

  for (const dBlockRaw of discordBlocks) {
    const dBlock = mergeAuth(dBlockRaw);
    const cacheKey = discordCacheKey(dBlock);

    try {
      const discordMsgs = await parseDiscord(dBlock, discordHttp);
      if (!Array.isArray(discordMsgs)) continue;

      if (!cache[index][cacheKey]) cache[index][cacheKey] = [];

      const newMsgs = discordMsgs.filter((msg) => !cache[index][cacheKey].includes(msg.guid));

      if (newMsgs.length > 0) {
        const reqSend = dBlock.RequestSend ?? channelConfig.RequestSend ?? 5;
        const toSend = newMsgs.slice(0, reqSend);

        for (const entry of toSend.reverse()) {
          try {
            await sendMessage(
              dBlock.Webhook || channelConfig.Webhook,
              dBlock.Thread || channelConfig.Thread,
              entry
            );
            await sleep(SEND_DELAY_MS);
          } catch (err) {
            Logger.error("Nie udało się wysłać wiadomości Discord (blok DiscordX)", {
              channelIndex: index,
              cacheKey,
              entry: { guid: entry.guid, link: entry.link, title: entry.title },
              webhookSet: !!(dBlock.Webhook || channelConfig.Webhook),
              thread: dBlock.Thread || channelConfig.Thread || null,
              error: pickHttpError(err),
            });
          }
        }

        cache[index][cacheKey] = pushCache(
          cache[index][cacheKey],
          newMsgs.map((m) => m.guid)
        );
        saveCache();
        origConsole.log(`[Kanał ${index + 1}] Wysłano ${toSend.length} (Discord blok: ${cacheKey}).`);
      } else {
        Logger.warn("Brak nowych wiadomości do wysłania (Discord blok)", {
          channelIndex: index,
          cacheKey,
          reason: "deduplikacja / brak zmian",
          lastKnown: cache[index][cacheKey]?.slice(0, 3) || [],
        });
      }
    } catch (err) {
      Logger.error("Discord Error przy pobieraniu wiadomości (blok)", {
        channelIndex: index,
        cacheKey,
        error: pickHttpError(err),
        config: {
          GuildID: dBlock.GuildID || null,
          Limit: dBlock.Limit || null,
        },
      });
    }
  }

  // --- RSS/ATOM/YT/JSON/API ---
  if (channelConfig.RSS && Array.isArray(channelConfig.RSS) && channelConfig.RSS.length) {
    const list = channelConfig.RSS.slice();

    await mapWithLimit(list, FETCH_CONCURRENCY, async (feedUrl) => {
      try {
        const items = await fetchFeed(feedUrl);
        if (!items.length) {
          Logger.warn("Brak nowych danych z feeda", {
            channelIndex: index,
            feedUrl,
            reason: "fetchFeed zwrócił []",
          });
          return;
        }

        if (!cache[index][feedUrl]) cache[index][feedUrl] = [];

        const newItems = items.filter((i) => {
          const key = normalizeLink(i.link || i.guid || "");
          return key && !cache[index][feedUrl].includes(key);
        });

        if (newItems.length > 0) {
          const reqSend = channelConfig.RequestSend ?? 5;
          const toSend = newItems.slice(0, reqSend);

          for (const entry of toSend.reverse()) {
            try {
              if (!channelConfig.Webhook) {
                Logger.warn("Pominięto wysyłkę: brak Webhook w configu kanału", {
                  channelIndex: index,
                  feedUrl,
                  entry: { link: entry.link, guid: entry.guid, title: entry.title },
                });
                continue;
              }
              await sendMessage(
                channelConfig.Webhook,
                channelConfig.Thread,
                entry
              );
              await sleep(SEND_DELAY_MS);
            } catch (err) {
              Logger.error("Nie udało się wysłać wpisu na Discord (RSS/Atom/API)", {
                channelIndex: index,
                feedUrl,
                entry: {
                  link: entry.link,
                  guid: entry.guid,
                  title: entry.title,
                  isoDate: entry.isoDate,
                },
                webhookSet: !!channelConfig.Webhook,
                thread: channelConfig.Thread ?? null,
                error: pickHttpError(err),
              });
            }
          }

          cache[index][feedUrl] = pushCache(
            cache[index][feedUrl],
            newItems.map((i) => normalizeLink(i.link || i.guid || ""))
          );
          saveCache();
          origConsole.log(
            `[Kanał ${index + 1}] Wysłano ${toSend.length} wpisów z ${feedUrl}.`
          );
        }
      } catch (err) {
        Logger.error("Błąd obsługi feeda RSS/ATOM/JSON", {
          channelIndex: index,
          feedUrl,
          error: pickHttpError(err),
        });
      }
    });
  }
}

// ------------------------------------------------------------
// KOLEJKOWANIE (zbiera channels, channels2, channels3, ...)
// ------------------------------------------------------------
let allChannels = [];
for (const key of Object.keys(config)) {
  if (key.toLowerCase().startsWith("channels")) allChannels = allChannels.concat(config[key]);
}

origConsole.log(`[System] Kanałów do obsługi: ${allChannels.length}`);

let lastCheck = new Array(allChannels.length).fill(0);
let currentIndex = 0;

async function processNextChannel() {
  if (!allChannels.length) {
    Logger.warn("Brak kanałów w configu", { reason: "channels* puste" });
    setTimeout(processNextChannel, delayBetweenChannels);
    return;
  }

  const channel = allChannels[currentIndex];
  const now = Date.now();
  const minutes = channel.TimeChecker || 30;
  const minDelay = minutes * 60 * 1000;

  if (now - lastCheck[currentIndex] >= minDelay) {
    origConsole.log(
      `[Kolejka] Sprawdzam kanał ${currentIndex + 1}/${allChannels.length}`
    );
    try {
      await checkFeedsForChannel(currentIndex, channel);
      lastCheck[currentIndex] = Date.now();
    } catch (err) {
      Logger.error("Błąd w trakcie obsługi kanału", {
        channelIndex: currentIndex,
        error: pickHttpError(err),
      });
    }
  }

  currentIndex = (currentIndex + 1) % allChannels.length;
  setTimeout(processNextChannel, delayBetweenChannels);
}

processNextChannel();

// ------------------------------------------------------------
// ZAMYKANIE I OBSŁUGA KRYTYCZNYCH BŁĘDÓW
// ------------------------------------------------------------
process.on("SIGINT", () => {
  origConsole.log("\n[Shutdown] Zapisuję cache i zamykam...");
  try {
    saveCache();
  } catch (e) {
    Logger.error("Błąd zapisu cache przy zamykaniu", { error: e?.message });
  }
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  Logger.crash("uncaughtException", error, {});
  try { saveCache(); } catch {}
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  Logger.crash("unhandledRejection", err, {});
  try { saveCache(); } catch {}
  process.exit(1);
});

origConsole.log(`🚀 XFeeder v${require("./package.json").version} uruchomiony!`);