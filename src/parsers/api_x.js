// src/parsers/api_x.js - Generic API JSON parser
const { parseDate } = require("./utils");
const { stripHtml } = require("string-strip-html");

/**
 * Converts a single API entry to standardized format.
 * Works universally - just needs objects with typical fields (title, url, content, etc.)
 * 
 * @param {object} rawEntry - Raw entry object from API
 * @returns {object|null} Standardized entry object or null
 */
function standardizeEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null;

  const title =
    rawEntry.title ||
    rawEntry.name ||
    rawEntry.headline ||
    rawEntry.caption ||
    "No title";

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
      : "No description.";

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
 * Parses data from custom JSON APIs (Steam, Reddit, custom blogs, etc.)
 * 
 * @param {string} feedUrl - API URL
 * @param {object} httpClient - HTTP client with get method
 * @returns {Promise<Array>} Array of standardized entries
 */
async function parseApiX(feedUrl, httpClient) {
  try {
    const res = await httpClient.get(feedUrl, {
      headers: { Accept: "application/json, text/json" },
      timeout: 15000,
    });

    const rawData = res.data;
    let rawItems = [];

    // --- 1) Main array ---
    if (Array.isArray(rawData)) {
      rawItems = rawData;
    }
    // --- 2) Typical keys containing lists ---
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

      // --- 3) Search for nested arrays (feed.entries, data.items, etc.) ---
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
      console.warn(`[ApiX] No entries in ${feedUrl}`);
      return [];
    }

    const items = rawItems
      .map(standardizeEntry)
      .filter((x) => x && x.link && x.title);

    if (!items.length) {
      console.warn(`[ApiX] Failed to parse any valid entries from ${feedUrl}`);
    }

    return items;
  } catch (error) {
    console.error(`[ApiX] Error parsing ${feedUrl}: ${error.message}`);
    return [];
  }
}

module.exports = { parseApiX };