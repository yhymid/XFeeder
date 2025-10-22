// src/parsers/fallback.js - Awaryjny parser HTML (Web Scraping)
const cheerio = require("cheerio");
const { parseDate } = require("./utils");
const { URL } = require("url");

async function parseFallback(feedUrl, httpClient) {
  try {
    const res = await httpClient.get(feedUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) XFeeder/1.3 (Fallback)",
      },
      timeout: 10000,
    });

    const html = res.data;
    const $ = cheerio.load(html);
    const base = new URL(feedUrl);

    const title =
      $('meta[property="og:title"]').attr("content") ||
      $('meta[name="twitter:title"]').attr("content") ||
      $("title").first().text().trim() ||
      "Brak tytułu";

    const url =
      $('meta[property="og:url"]').attr("content") ||
      $('meta[name="twitter:url"]').attr("content") ||
      base.href;

    let description =
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      $('meta[name="twitter:description"]').attr("content") ||
      $("article p").first().text().trim() ||
      "Brak opisu.";

    let image =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('link[rel*="icon"]').attr("href") ||
      null;

    if (image && image.startsWith("/")) {
      image = `${base.origin}${image}`;
    }

    const author =
      $('meta[name="author"]').attr("content") ||
      $('meta[property="article:author"]').attr("content") ||
      $("a[rel=author]").text() ||
      null;

    const dateRaw =
      $('meta[property="article:published_time"]').attr("content") ||
      $('time[datetime]').attr("datetime") ||
      null;

    const isoDate = parseDate(dateRaw || new Date().toISOString());
    description = description.replace(/\s+/g, " ").substring(0, 500).trim();

    if (!title || !url) {
      console.warn(`[Fallback Parser] Nie udało się wyciągnąć danych z ${feedUrl}`);
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
    console.warn(`[Fallback Parser] Błąd dla ${feedUrl}: ${err.message}`);
    return [];
  }
}

module.exports = { parseFallback };