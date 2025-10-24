// src/parsers/Downloader.js
"use strict";

const { getWithFallback } = require("../client");

function buildAccept(accept) {
  // Proste profile Accept — wybór nagłówka wg wskazania
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
 * Downloader — pobiera zawartość URL (bez żadnych plików tymczasowych).
 *  - Obsługuje 304 (brak zmian) jako sukces notModified: true
 *  - Dla schematów nie-http/https zwraca ok:false i reason: "UNSUPPORTED_PROTOCOL"
 *
 * @param {string} url
 * @param {{accept?: 'auto'|'xml'|'json'|'html', headers?: object, timeout?: number}} opts
 * @returns {Promise<{ok:boolean, status?:number, headers?:object, data?:any, contentType?:string, notModified?:boolean, reason?:string, error?:Error}>}
 */
async function download(url, opts = {}) {
  // Guard: schematy nie-http/https
  let u;
  try {
    u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "UNSUPPORTED_PROTOCOL" };
    }
  } catch {
    // nieprawidłowy URL -> pozwólmy getWithFallback wyrzucić czytelny błąd
  }

  const headers = {
    Accept: buildAccept(opts.accept),
    ...(opts.headers || {}),
  };

  try {
    const res = await getWithFallback(url, { headers, timeout: opts.timeout });
    // 304 traktujemy jako brak zmian (bez błędu)
    if (res?.status === 304) {
      return { ok: true, status: 304, headers: res.headers || {}, data: "", notModified: true };
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
    return { ok: false, error: err, status: err?.response?.status };
  }
}

module.exports = { download };