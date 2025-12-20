// src/parsers/freshrss.js - FreshRSS parser via Fever API (with proper chronological order)
const crypto = require("crypto");

let freshConfig = null;
let apiHash = null;
let configLoaded = false;

/**
 * Loads FreshRSS configuration from config.json
 * 
 * @returns {object|null} FreshRSS config or null
 */
function loadConfig() {
  if (configLoaded) return freshConfig;
  configLoaded = true;

  try {
    const fs = require("fs");
    const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
    freshConfig = config.FreshRSS || null;

    if (freshConfig?.feverKey) {
      apiHash = freshConfig.feverKey;
    } else if (freshConfig?.Username && freshConfig?.Password) {
      apiHash = crypto.createHash("md5")
        .update(`${freshConfig.Username}:${freshConfig.Password}`)
        .digest("hex");
    }
  } catch (err) {
    console.error("[FreshRSS] Configuration error:", err.message);
  }

  return freshConfig;
}

/**
 * Checks if URL is a FreshRSS URL
 * 
 * @param {string} url - URL to check
 * @returns {boolean} True if FreshRSS URL
 */
function isFreshRSSUrl(url) {
  return typeof url === "string" && url.startsWith("freshrss://");
}

/**
 * Makes POST request to Fever API
 * 
 * @param {string} endpoint - API endpoint
 * @param {object} httpClient - HTTP client with post method
 * @returns {Promise<object>} API response data
 */
async function feverPost(endpoint, httpClient) {
  const config = loadConfig();
  if (!config) throw new Error("Missing FreshRSS in config.json");
  if (!apiHash) throw new Error("Missing feverKey in config.json");

  const baseUrl = config.Url.replace(/\/$/, "");
  const url = `${baseUrl}/api/fever.php?api&${endpoint}`;

  const res = await httpClient.post(url, `api_key=${apiHash}`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });

  if (!res.data?.auth) {
    throw new Error("Fever: authorization failed");
  }

  return res.data;
}

/**
 * Maps Fever item to standardized format
 * 
 * @param {object} item - Fever item
 * @param {Array} feeds - Array of feeds for author lookup
 * @returns {object} Standardized item
 */
function mapItem(item, feeds) {
  const feed = feeds.find(f => f.id === item.feed_id);

  let image = null;
  if (item.html) {
    const m = item.html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) image = m[1];
  }

  const content = (item.html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

  return {
    title: item.title || "No title",
    link: item.url || null,
    contentSnippet: content,
    isoDate: item.created_on_time
      ? new Date(item.created_on_time * 1000).toISOString()
      : new Date().toISOString(),
    enclosure: image,
    author: feed?.title || null,
    guid: `freshrss-${item.id}`,
    categories: ["freshrss"],
    // Keep timestamp for sorting
    _timestamp: item.created_on_time || 0,
  };
}

/**
 * Parses FreshRSS feed via Fever API
 * 
 * @param {string} feedUrl - FreshRSS URL (freshrss://all, freshrss://feed/123, etc.)
 * @param {object} ctx - Context with http client
 * @returns {Promise<Array>} Array of parsed items
 */
async function parseFreshRSS(feedUrl, ctx) {
  const config = loadConfig();
  if (!config?.Enabled) return [];

  const http = ctx?.http || ctx;
  if (!http?.post) {
    console.error("[FreshRSS] Missing http.post");
    return [];
  }

  const path = feedUrl.replace("freshrss://", "");
  const [type, id] = path.split("/");

  console.log(`[FreshRSS] ${feedUrl}`);

  try {
    const feedsData = await feverPost("feeds", http);
    const feeds = feedsData.feeds || [];

    let items = [];

    if (type === "all") {
      const data = await feverPost("items", http);
      items = data.items || [];

    } else if (type === "feed") {
      if (!id) throw new Error("Missing feed ID");
      const data = await feverPost(`items&feed_ids=${id}`, http);
      items = data.items || [];

    } else if (type === "group") {
      if (!id) throw new Error("Missing group ID");

      const groupsData = await feverPost("feeds&groups", http);
      const mapping = (groupsData.feeds_groups || [])
        .find(fg => String(fg.group_id) === String(id));

      if (!mapping) {
        console.warn(`[FreshRSS] Group not found: ${id}`);
        return [];
      }

      const feedIds = mapping.feed_ids;
      const groupName = (groupsData.groups || [])
        .find(g => String(g.id) === String(id))?.title || id;

      console.log(`[FreshRSS] Group "${groupName}" → feed_ids=${feedIds}`);

      const data = await feverPost(`items&feed_ids=${feedIds}`, http);
      items = data.items || [];

    } else if (type === "saved") {
      const savedData = await feverPost("saved_item_ids", http);
      const ids = savedData.saved_item_ids || "";
      if (!ids) return [];
      const data = await feverPost(`items&with_ids=${ids.split(",").slice(0, 50).join(",")}`, http);
      items = data.items || [];

    } else {
      console.warn(`[FreshRSS] Unknown type: ${type}`);
      return [];
    }

    // Map items
    let result = items
      .map(i => mapItem(i, feeds))
      .filter(i => i.link);

    // Sort by date - newest first
    result.sort((a, b) => b._timestamp - a._timestamp);

    // Remove helper _timestamp field
    result = result.map(({ _timestamp, ...rest }) => rest);

    console.log(`[FreshRSS] ✓ ${result.length} items (sorted chronologically)`);
    return result;

  } catch (err) {
    console.error(`[FreshRSS] ✗ ${err.message}`);
    return [];
  }
}

module.exports = {
  parseFreshRSS,
  isFreshRSSUrl,
  /**
   * Gets all feeds from FreshRSS
   * @param {object} http - HTTP client
   * @returns {Promise<Array>} Array of feeds
   */
  getFeeds: async (http) => {
    const data = await feverPost("feeds", http);
    return data.feeds || [];
  }
};