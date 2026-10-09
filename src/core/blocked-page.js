"use strict";

const cheerio = require("cheerio");
const interstitial = /^(?:(?:one|just) a?\s*moment(?:,? please)?|checking (?:your browser|if (?:the )?site connection is secure)|(?:please )?verify (?:that )?you are (?:a )?human|are you human|attention required|access denied|request blocked|(?:403\s*[-:|]?\s*)?forbidden|(?:404\s*[-:|]?\s*)?(?:page )?not found|(?:503\s*[-:|]?\s*)?service unavailable|(?:500\s*[-:|]?\s*)?internal server error|(?:502\s*[-:|]?\s*)?bad gateway|security (?:check|verification)|error 1020)(?:[.!…\s]*)(?:[|—-]\s*(?:cloudflare|security check))?$/i;

// Document-level guard, independent of whether a browser fallback is enabled.
// Do not scan feed entry titles or article prose for words such as "captcha".
function isBlockedPage(body, { status, headers = {} } = {}) {
  if (Number(status) >= 400) return true;
  const mitigated = Object.entries(headers).find(([key]) => key.toLowerCase() === "cf-mitigated");
  if (String(mitigated?.[1]).toLowerCase() === "challenge") return true;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body !== "string") return false;
  const source = body.replace(/^\uFEFF/, "").trim();
  if (/^[{[]/.test(source) || /^(?:<\?xml[^>]*>\s*)?<(?:rss|feed|rdf:RDF)\b/i.test(source)) return false;
  if (!/<(?:!doctype\s+html|html|head|title|body|h1|form)\b/i.test(source)) return interstitial.test(source);
  const $ = cheerio.load(source);
  const labels = [$("head title").first().text(), $("body h1").first().text()];
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  if (bodyText.length <= 240) labels.push(bodyText);

  if (labels.some((label) => interstitial.test(label.replace(/\s+/g, " ").trim()))) return true;
  // Structural challenge markers; mentioning them in an article is harmless.
  return $("script[src*='/cdn-cgi/challenge-platform/'], form#challenge-form, form[action*='/cdn-cgi/'], #cf-challenge-running, #challenge-running").length > 0;
}

module.exports = { isBlockedPage };
