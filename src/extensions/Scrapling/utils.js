"use strict";

const cheerio = require("cheerio");

const DEFAULT_BLOCKED_STATUS_CODES = [403, 429, 503];
const DEFAULT_BLOCKED_HEADER_KEYS = [
  "cf-mitigated",
  "x-datadome",
  "x-akamai-transformed",
  "akamai-grn",
  "x-sucuri-id",
  "x-distil-captcha",
  "x-bot-score*",
];
const DEFAULT_BODY_SIGNATURES = [
  "just a moment",
  "checking your browser",
  "attention required",
  "error 1020",
  "cf-chl",
  "turnstile",
  "datadome",
  "akamai bot manager",
  "captcha",
  "verify you are human",
  "are you human",
  "access denied",
  "request blocked",
  "challenge page",
  "bot manager",
];
const DEFAULT_TITLE_SIGNATURES = [
  "just a moment",
  "attention required",
  "access denied",
  "error 1020",
  "404 |",
  "| 404",
  "not found",
  "verify you are human",
  "are you human",
  "challenge",
  "captcha",
  "datadome",
];

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])
  );
}

function isProtectedStatus(status) {
  return [403, 429, 503].includes(Number(status));
}

function isCloudflareProtected(headers = {}) {
  const h = normalizeHeaders(headers);
  return Boolean(h["cf-ray"] || h["cf-cache-status"] || h["server"]?.toLowerCase().includes("cloudflare"));
}

function matchBlockedHeaders(headers = {}, extraHeaderKeys = []) {
  const normalized = normalizeHeaders(headers);
  const keys = [...DEFAULT_BLOCKED_HEADER_KEYS, ...ensureArray(extraHeaderKeys)]
    .map((k) => String(k || "").toLowerCase())
    .filter(Boolean);
  const matches = [];

  for (const key of keys) {
    if (key.endsWith("*")) {
      const prefix = key.slice(0, -1);
      const hasPrefix = Object.keys(normalized).some((k) => k.startsWith(prefix));
      if (hasPrefix) matches.push(key);
      continue;
    }
    if (normalized[key] !== undefined) matches.push(key);
  }

  return { matched: matches.length > 0, matches };
}

function hasBlockedHeaders(headers = {}, extraHeaderKeys = []) {
  return matchBlockedHeaders(headers, extraHeaderKeys).matched;
}

function ensureArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function detectChallengeByBody(body = "", extraSignatures = []) {
  const text = String(body || "").toLowerCase();
  if (!text) return false;
  const signatures = [...DEFAULT_BODY_SIGNATURES, ...ensureArray(extraSignatures)];
  return signatures.some((sig) => {
    if (!sig) return false;
    if (sig instanceof RegExp) return sig.test(text);
    return text.includes(String(sig).toLowerCase());
  });
}

function extractTitle(body = "") {
  const match = String(body || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function detectChallengeByTitle(title = "", extraSignatures = []) {
  const value = String(title || "").toLowerCase().trim();
  if (!value) return false;
  const signatures = [...DEFAULT_TITLE_SIGNATURES, ...ensureArray(extraSignatures)];
  return signatures.some((sig) => {
    if (!sig) return false;
    if (sig instanceof RegExp) return sig.test(value);
    return value.includes(String(sig).toLowerCase());
  });
}

function analyzeAntiBotSignals({
  status = null,
  headers = {},
  body = "",
  statusCodes = DEFAULT_BLOCKED_STATUS_CODES,
  headerKeys = [],
  bodySignatures = [],
  titleSignatures = [],
  minBodyBytes = 0,
  minConfidence = 40,
  treatCloudflareAsSignal = true,
} = {}) {
  const payload = body == null ? "" : String(body);
  const title = extractTitle(payload);
  const bodyBytes = Buffer.byteLength(payload, "utf8");
  const blockedStatusSet = new Set(
    ensureArray(statusCodes).map((s) => Number(s)).filter((n) => Number.isFinite(n))
  );

  const statusBlocked = status != null && blockedStatusSet.has(Number(status));
  const cloudflare = treatCloudflareAsSignal !== false && isCloudflareProtected(headers);
  const headerResult = matchBlockedHeaders(headers, headerKeys);
  const headerBlocked = headerResult.matched;
  const bodyBlocked = detectChallengeByBody(payload, bodySignatures);
  const titleBlocked = detectChallengeByTitle(title, titleSignatures);
  const bodyTooSmall = Number(minBodyBytes) > 0 && bodyBytes > 0 && bodyBytes < Number(minBodyBytes);

  const reasons = [];
  if (statusBlocked) reasons.push(`status:${status}`);
  if (cloudflare) reasons.push("header:cloudflare");
  if (headerBlocked) reasons.push(`header:antibot:${headerResult.matches.join("|")}`);
  if (bodyBlocked) reasons.push("body:challenge");
  if (titleBlocked) reasons.push("title:challenge");
  if (bodyTooSmall) reasons.push(`body:small:${bodyBytes}`);

  const hasStrongSignals = statusBlocked || headerBlocked || bodyBlocked || titleBlocked;
  const smallBodySuspicious = bodyTooSmall && (hasStrongSignals || cloudflare);

  // Weighted confidence to reduce false positives on normal pages behind Cloudflare.
  let score = 0;
  if (statusBlocked) score += 60;
  if (headerBlocked) score += 45;
  if (bodyBlocked) score += 45;
  if (titleBlocked) score += 35;
  if (bodyTooSmall) score += 20;
  if (cloudflare) score += 10;
  if (smallBodySuspicious) score += 20;
  score = Math.max(0, Math.min(100, score));

  const confidenceFloor = Number.isFinite(Number(minConfidence))
    ? Math.max(0, Math.min(100, Number(minConfidence)))
    : 40;

  const blocked = hasStrongSignals || bodyTooSmall || smallBodySuspicious || score >= confidenceFloor;

  return {
    blocked,
    reasons,
    score,
    minConfidence: confidenceFloor,
    bodyBytes,
    title,
    statusBlocked,
    cloudflare,
    headerBlocked,
    headerMatches: headerResult.matches,
    bodyBlocked,
    titleBlocked,
    bodyTooSmall,
  };
}

function detectFeedFormat(body) {
  const s = String(body || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.startsWith("{") || s.startsWith("[")) return "json";
  if (s.includes("<rss") || s.includes("<item")) return "rss";
  if (s.includes("<feed") || s.includes("<entry")) return "atom";
  if (s.includes("<html") || s.includes("<!doctype html")) return "html";
  return "unknown";
}

function htmlToFeedItems(html, options = {}) {
  const $ = cheerio.load(String(html || ""));
  const itemSelector = options.itemSelector || "article, .post, .entry, li";
  const titleSelector = options.titleSelector || "h1, h2, h3, .title, .entry-title";
  const linkSelector = options.linkSelector || "a[href]";
  const dateSelector = options.dateSelector || "time[datetime], time, .date, .published";
  const authorSelector = options.authorSelector || ".author, [rel='author']";

  const items = [];
  $(itemSelector).each((_, el) => {
    const node = $(el);
    const title = node.find(titleSelector).first().text().trim() || "No title";
    const link = node.find(linkSelector).first().attr("href") || null;
    const contentSnippet = node.text().replace(/\s+/g, " ").trim().slice(0, 500);
    const isoDate = node.find(dateSelector).first().attr("datetime") || new Date().toISOString();
    const author = node.find(authorSelector).first().text().trim() || null;
    const img = node.find("img").first().attr("src") || null;
    if (!title && !link) return;
    items.push({ title, link, contentSnippet, isoDate, enclosure: img, author, guid: link || `${title}-${items.length}`, categories: [] });
  });

  if (items.length > 0) return items;

  const pageTitle = $("title").first().text().trim() || "No title";
  const ogUrl = $("meta[property='og:url']").attr("content") || null;
  const desc = $("meta[name='description']").attr("content") || "";
  if (!pageTitle && !ogUrl) return [];
  return [{ title: pageTitle, link: ogUrl, contentSnippet: String(desc).slice(0, 500), isoDate: new Date().toISOString(), enclosure: $("meta[property='og:image']").attr("content") || null, author: null, guid: ogUrl || pageTitle, categories: ["html-fallback"] }];
}

module.exports = {
  DEFAULT_BLOCKED_STATUS_CODES,
  DEFAULT_BLOCKED_HEADER_KEYS,
  DEFAULT_BODY_SIGNATURES,
  DEFAULT_TITLE_SIGNATURES,
  isProtectedStatus,
  isCloudflareProtected,
  matchBlockedHeaders,
  hasBlockedHeaders,
  detectChallengeByBody,
  detectChallengeByTitle,
  analyzeAntiBotSignals,
  detectFeedFormat,
  htmlToFeedItems,
};
