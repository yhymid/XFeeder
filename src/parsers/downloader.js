// src/parsers/downloader.js - HTTP downloader for unified fetching
"use strict";

const { getWithFallback } = require("../client");

/**
 * Builds Accept header based on content type hint
 * 
 * @param {string} accept - Content type hint: 'auto', 'xml', 'rss', 'atom', 'json', 'html'
 * @returns {string} Accept header value
 */
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

/**
 * Downloads URL content (no temporary files).
 * - Handles 304 (not modified) as success with notModified: true
 * - For non-http/https schemes returns ok:false with reason: "UNSUPPORTED_PROTOCOL"
 *
 * @param {string} url - URL to download
 * @param {object} opts - Options: accept, headers, timeout
 * @returns {Promise<object>} Result object with ok, status, headers, data, contentType, notModified, reason, error
 */
async function download(url, opts = {}) {
  // Guard: non-http/https schemes
  let u;
  try {
    u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "UNSUPPORTED_PROTOCOL" };
    }
  } catch {
    // Invalid URL -> let getWithFallback throw a readable error
  }

  const headers = {
    Accept: buildAccept(opts.accept),
    ...(opts.headers || {}),
  };

  try {
    const res = await getWithFallback(url, { headers, timeout: opts.timeout });
    
    // Treat 304 as "no changes" (not an error)
    if (res?.status === 304) {
      return {
        ok: true,
        status: 304,
        headers: res.headers || {},
        data: "",
        notModified: true
      };
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
    return {
      ok: false,
      error: err,
      status: err?.response?.status
    };
  }
}

module.exports = { download };