// src/parsers/fallback.js - Emergency HTML parser (Web Scraping)
const cheerio = require("cheerio");
const { parseDate } = require("./utils");
const { URL } = require("url");

/**
 * Fallback parser that extracts data from HTML meta tags.
 * Used when all other parsers fail.
 * 
 * @param {string} feedUrl - URL to parse
 * @param {object} httpClient - HTTP client with get method
 * @returns {Promise<Array>} Array with single item or empty
 */
async function parseFallback(feedUrl, httpClient) {
  try {
    const res = await httpClient.get(feedUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) XFeeder/2.0 (Fallback)",
      },
      timeout: 10000,
    });

    const html = res.data;
    const $ = cheerio.load(html);
    const base = new URL(feedUrl);

    // Extract title
    const title =
      $('meta[property="og:title"]').attr("content") ||
      $('meta[name="twitter:title"]').attr("content") ||
      $("title").first().text().trim() ||
      "No title";

    // Extract URL
    const url =
      $('meta[property="og:url"]').attr("content") ||
      $('meta[name="twitter:url"]').attr("content") ||
      base.href;

    // Extract description
    let description =
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      $('meta[name="twitter:description"]').attr("content") ||
      $("article p").first().text().trim() ||
      "No description.";

    // Extract image
    let image =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('link[rel*="icon"]').attr("href") ||
      null;

    // Fix relative image URLs
    if (image && image.startsWith("/")) {
      image = `${base.origin}${image}`;
    }

    // Extract author
    const author =
      $('meta[name="author"]').attr("content") ||
      $('meta[property="article:author"]').attr("content") ||
      $("a[rel=author]").text() ||
      null;

    // Extract date
    const dateRaw =
      $('meta[property="article:published_time"]').attr("content") ||
      $('time[datetime]').attr("datetime") ||
      null;

    const isoDate = parseDate(dateRaw || new Date().toISOString());
    description = description.replace(/\s+/g, " ").substring(0, 500).trim();

    if (!title || !url) {
      console.warn(`[Fallback Parser] Failed to extract data from ${feedUrl}`);
      return [];
    }

    console.log(`[Fallback Parser] HTML fallback OK → ${feedUrl}`);

    return [{
      title,
      link: url,
      contentSnippet: description,
      isoDate,
      enclosure: image || null,
      author,
      guid: url,
      categories: [],
    }];
  } catch (err) {
    console.warn(`[Fallback Parser] Error for ${feedUrl}: ${err.message}`);
    return [];
  }
}

module.exports = { parseFallback };