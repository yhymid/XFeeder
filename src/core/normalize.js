"use strict";

const crypto = require("crypto");

const SEND_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLink(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const removeParams = new Set([
      "utm_source", "utm_medium", "utm_campaign", "utm_term",
      "utm_content", "utm_name", "fbclid", "gclid", "yclid",
      "mc_cid", "mc_eid", "ref",
    ]);
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith("utm_") || removeParams.has(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return u;
  }
}

function getCacheKey(item) {
  const directKey = normalizeLink(item.link || item.guid || "");
  if (directKey) return directKey;

  const fallback = [
    item?.title,
    item?.isoDate,
    item?.author,
    item?.contentSnippet,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!fallback) return "";
  return `hash:${crypto.createHash("sha1").update(fallback).digest("hex").slice(0, 20)}`;
}

function pushCache(list, ids, limit = 2000) {
  const prev = Array.isArray(list) ? list : [];
  const merged = [...ids, ...prev];
  if (merged.length > limit) merged.length = limit;
  return merged;
}

module.exports = {
  SEND_DELAY_MS,
  sleep,
  normalizeLink,
  getCacheKey,
  pushCache,
};
