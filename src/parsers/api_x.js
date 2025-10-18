// src/parsers/api_x.js
const { parseDate } = require("./utils");
const { stripHtml } = require("string-strip-html");

/**
 * Konwertuje pojedynczy wpis z dowolnego API JSON na ustandaryzowany format.
 * Działa uniwersalnie — wystarczy, że API zwraca obiekty z typowymi polami (title, url, content itp.)
 * @param {object} rawEntry Surowy obiekt wpisu z API.
 * @returns {object} Ustandaryzowany obiekt wpisu.
 */
function standardizeEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null;

  const title =
    rawEntry.title ||
    rawEntry.name ||
    rawEntry.headline ||
    rawEntry.caption ||
    "Brak tytułu";

  const link =
    rawEntry.url ||
    rawEntry.link ||
    rawEntry.permalink ||
    (rawEntry.id ? `#${rawEntry.id}` : null);

  const description =
    rawEntry.summary ||
    rawEntry.description ||
    rawEntry.body ||
    rawEntry.text ||
    rawEntry.content ||
    "";

  const dateString =
    rawEntry.date ||
    rawEntry.created_at ||
    rawEntry.updated_at ||
    rawEntry.published_at ||
    rawEntry.timestamp ||
    null;

  const image =
    rawEntry.image ||
    rawEntry.thumbnail ||
    rawEntry.banner ||
    rawEntry.media_url ||
    rawEntry.preview_image ||
    null;

  const author =
    rawEntry.author?.name ||
    rawEntry.author ||
    rawEntry.user?.name ||
    rawEntry.user ||
    rawEntry.by ||
    null;

  const contentSnippet =
    typeof description === "string"
      ? stripHtml(description).result.substring(0, 500).trim()
      : "Brak opisu.";

  return {
    title,
    link,
    contentSnippet,
    isoDate: parseDate(dateString || new Date().toISOString()),
    enclosure: image || null,
    author,
    guid: rawEntry.id || link || title,
    categories: rawEntry.tags || rawEntry.categories || [],
  };
}

/**
 * Parsuje dane z niestandardowego API JSON (np. Steam, Reddit, custom blog).
 * @param {string} feedUrl URL API.
 * @param {object} httpClient Instancja axios.
 * @returns {Promise<Array>} Lista ustandaryzowanych wpisów.
 */
async function parseApiX(feedUrl, httpClient) {
  try {
    const res = await httpClient.get(feedUrl, {
      headers: { Accept: "application/json, text/json" },
      timeout: 15000,
    });

    const rawData = res.data;
    let rawItems = [];

    // --- 1️⃣ Główna tablica ---
    if (Array.isArray(rawData)) {
      rawItems = rawData;
    }
    // --- 2️⃣ Typowe klucze zawierające listy ---
    else if (typeof rawData === "object" && rawData !== null) {
      rawItems =
        rawData.items ||
        rawData.posts ||
        rawData.entries ||
        rawData.articles ||
        rawData.results ||
        rawData.children ||
        rawData.data ||
        rawData.response ||
        [];

      // --- 3️⃣ Szukanie zagnieżdżonej tablicy (feed.entries, data.items itd.) ---
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        for (const key of Object.keys(rawData)) {
          const val = rawData[key];
          if (Array.isArray(val) && val.length > 0) {
            rawItems = val;
            break;
          } else if (typeof val === "object") {
            const sub = Object.values(val).find((v) => Array.isArray(v) && v.length > 0);
            if (sub) {
              rawItems = sub;
              break;
            }
          }
        }
      }
    }

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      console.warn(`[ApiX] Brak wpisów w ${feedUrl}`);
      return [];
    }

    const items = rawItems
      .map(standardizeEntry)
      .filter((x) => x && x.link && x.title); // eliminujemy puste

    if (!items.length) {
      console.warn(`[ApiX] Nie udało się sparsować żadnych poprawnych wpisów z ${feedUrl}`);
    }

    return items;
  } catch (error) {
    console.error(`[ApiX] Błąd podczas parsowania ${feedUrl}: ${error.message}`);
    return [];
  }
}

module.exports = { parseApiX };