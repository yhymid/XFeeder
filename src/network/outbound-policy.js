"use strict";

const dns = require("node:dns");
const net = require("node:net");

function blocked(message) {
  const error = new Error(message);
  error.code = "OUTBOUND_TARGET_BLOCKED";
  return error;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && c === 0) ||
                       (b === 0 && c === 2) || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113))
      return false;
    return a >= 1 && a <= 223;
  }
  if (family === 6) {
    // Only native global unicast 2000::/3; exclude documentation and
    // tunnel/translation ranges that can conceal private IPv4 destinations.
    const first = parseInt(address.split(":")[0], 16);
    if (!(first >= 0x2000 && first < 0x4000)) return false;
    const second = parseInt(address.split(":")[1] || "0", 16);
    if (first === 0x2002 ||
        (first === 0x2001 && (second === 0 || second === 0x0db8)))
      return false;
    return true;
  }
  return false;
}

function validatePublicUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw blocked("Outbound URL must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password)
    throw blocked("Outbound URL must use HTTP(S) without userinfo");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".home.arpa") ||
      hostname.endsWith(".invalid") ||
      (net.isIP(hostname) && !isPublicAddress(hostname)))
    throw blocked("Outbound destination is not public");
  return parsed;
}

// DNS lookup is performed at socket-connect time. Returning only validated
// addresses avoids a second unchecked DNS resolution (DNS rebinding/TOCTOU).
function publicLookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const opts = typeof options === "number" ? { family: options } : (options || {});
  const host = hostname.replace(/^\[|\]$/g, "");
  try { validatePublicUrl(`https://${host}/`); }
  catch (error) { queueMicrotask(() => callback(error)); return; }
  dns.lookup(host, { family: opts.family || 0, all: true, verbatim: true }, (error, addresses) => {
    if (error) { callback(error); return; }
    if (!addresses?.length || addresses.some(item => !isPublicAddress(item.address))) {
      callback(blocked("DNS resolved to an internal, mixed or non-public address"));
      return;
    }
    // Node's lookup API supports either an array (all:true) or address/family.
    if (opts.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function applyPublicOnlyPolicy(config) {
  const requested = config.baseURL ? new URL(config.url, config.baseURL).toString() : config.url;
  validatePublicUrl(requested);

  // Proxy agents resolve the ultimate destination outside our DNS lookup.
  // Refuse them instead of offering a false SSRF security guarantee.
  if (config.socketPath || config.transport || config.httpAgent ||
      config.httpsAgent || config.lookup ||
      (config.proxy !== undefined && config.proxy !== false)) {
    throw blocked("public-only requires a direct managed HTTP connection");
  }
  // Followed redirects could reach a different host without validation.
  // Public-only mode deliberately rejects them rather than following them.
  return { ...config, proxy: false, maxRedirects: 0, lookup: publicLookup };
}

module.exports = {
  blocked,
  isPublicAddress,
  validatePublicUrl,
  publicLookup,
  applyPublicOnlyPolicy,
};
