// src/message.js - Discord webhook sender (Components V2 format)
const axios = require("axios");

const COMPONENTS_V2_FLAG = 1 << 15;
const MAX_COMPONENT_TEXT = 1800;
const MAX_BUTTON_LABEL = 80;
const MAX_MEDIA_ITEMS = 10;
const MAX_429_RETRIES = 3;
const MIN_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 15000;

/**
 * Sends an entry to Discord channel via webhook (Components V2).
 * No fallback to classic embeds (removed in v2.x line).
 *
 * @param {string} webhookUrl - Full webhook URL
 * @param {string|null} threadId - Thread ID or "null"
 * @param {object} entry - Standardized entry object
 */
async function sendMessage(webhookUrl, threadId, entry) {
  try {
    let urlObj;
    try {
      urlObj = new URL(webhookUrl);
    } catch (e) {
      throw new Error("Invalid webhookUrl: " + webhookUrl);
    }

    urlObj.searchParams.set("with_components", "true");
    if (threadId && threadId !== "null") {
      urlObj.searchParams.set("thread_id", threadId);
    }

    const container = { type: 17, components: [] };

    // --- YOUTUBE ---
    if (entry.link && (entry.link.includes("youtube.com") || entry.link.includes("youtu.be"))) {
      addText(container, `📺 ${entry.title || "New video"}`);
      addText(container, entry.link);

      const thumb = entry.enclosure || getYouTubeThumbnailFromLink(entry.link);
      addMediaGallery(container, [
        { media: { url: thumb }, description: entry.title || "Thumbnail" },
      ]);
      addButton(container, "Open on YouTube", entry.link);

      await postToWebhook(urlObj.toString(), {
        flags: COMPONENTS_V2_FLAG,
        components: [container],
      });
      console.log(`[ComponentsV2] Sent (YouTube): ${entry.title}`);
      return;
    }

    // --- DISCORD (priority) ---
    if (entry.categories?.includes("discord")) {
      const username = entry.author || "User";
      const timestamp = entry.isoDate ? new Date(entry.isoDate).toLocaleString("en-US") : "";

      addText(container, `💬 New message from **${username}**`);
      addText(container, entry.contentSnippet);

      const mediaItems = [];
      if (entry.enclosure) mediaItems.push({ media: { url: entry.enclosure }, description: username });
      if (entry.embedThumbnail) mediaItems.push({ media: { url: entry.embedThumbnail }, description: "Embed" });
      if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
        mediaItems.push(
          ...entry.attachments.slice(0, MAX_MEDIA_ITEMS).map((url) => ({
            media: { url },
            description: username,
          }))
        );
      }
      addMediaGallery(container, mediaItems);

      if (entry.referenced) {
        addText(
          container,
          `↪️ *Reply to: ${entry.referenced.author || "Anonymous"} — "${truncate(entry.referenced.content, 100)}"*`
        );
      }

      addText(container, `👤 ${username} • 🕒 ${timestamp}`);
      addButton(container, "Open", entry.link);

      await postToWebhook(urlObj.toString(), {
        flags: COMPONENTS_V2_FLAG,
        components: [container],
      });
      console.log(`[ComponentsV2] Sent (Discord message from ${username})`);
      return;
    }

    // --- DISCORD MESSAGE (generic, content fallback — still Components) ---
    if (entry.attachments || entry.content || entry.referenced) {
      const username = entry.author?.username || entry.author || "User";
      const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString("en-US") : "";

      addText(container, `💬 New message from **${username}**`);
      addText(container, entry.content);

      if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
        addMediaGallery(
          container,
          entry.attachments.slice(0, MAX_MEDIA_ITEMS).map((url) => ({
            media: { url },
            description: username,
          }))
        );
      }

      if (entry.referenced) {
        addText(
          container,
          `↪️ *Reply to: ${entry.referenced.author || "Anonymous"} — "${truncate(entry.referenced.content, 100)}"*`
        );
      }

      addText(container, `👤 ${username} • 🕒 ${timestamp}`);
      addButton(container, "Open", entry.link);

      await postToWebhook(urlObj.toString(), {
        flags: COMPONENTS_V2_FLAG,
        components: [container],
      });
      console.log(`[ComponentsV2] Sent (Discord message from ${username})`);
      return;
    }

    // --- RSS / ATOM / JSON ---
    addText(container, `📰 **${entry.title || "New entry"}**`);
    addText(container, truncate(entry.contentSnippet, 800));

    addMediaGallery(container, [
      { media: { url: entry.enclosure }, description: entry.title || "Media" },
    ]);

    if (entry.author || entry.isoDate) {
      const ts = entry.isoDate ? new Date(entry.isoDate).toLocaleString("en-US") : "";
      addText(container, `👤 ${entry.author || "Anonymous"} • 🕒 ${ts}`);
    }

    addButton(container, "Open", entry.link);

    await postToWebhook(urlObj.toString(), {
      flags: COMPONENTS_V2_FLAG,
      components: [container],
    });
    console.log(`[ComponentsV2] Sent: ${entry.title || entry.link || "(no title)"}`);
  } catch (err) {
    if (err.response) {
      console.error(`[ComponentsV2] Send error: ${err.response.status}`, err.response.data);
    } else {
      console.error(`[ComponentsV2] Error:`, err.message);
    }
    throw err;
  }
}

/**
 * Posts payload to webhook URL with 429 retry support.
 *
 * @param {string} url - Full webhook URL with query params
 * @param {object} payload - Request body
 * @returns {Promise<object>} Axios response
 */
async function postToWebhook(url, payload) {
  const sanitizedPayload = sanitizePayload(payload);

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt += 1) {
    try {
      return await axios.post(url, sanitizedPayload, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const is429 = err?.response?.status === 429;
      if (!is429 || attempt >= MAX_429_RETRIES) {
        throw err;
      }

      const waitMs = getRetryDelayMs(err.response, attempt);
      console.warn(
        `[ComponentsV2] Rate limited (429), retry ${attempt + 1}/${MAX_429_RETRIES}, wait=${waitMs}ms`
      );
      await sleep(waitMs);
    }
  }
}

function sanitizePayload(payload) {
  const rootComponents = Array.isArray(payload?.components) ? payload.components : [];
  const sanitizedContainers = [];

  for (const container of rootComponents) {
    if (!container || container.type !== 17 || !Array.isArray(container.components)) continue;

    const sanitizedComponents = [];
    for (const component of container.components) {
      if (!component || typeof component !== "object") continue;

      if (component.type === 10) {
        const content = safeText(component.content, MAX_COMPONENT_TEXT);
        if (content) sanitizedComponents.push({ type: 10, content });
        continue;
      }

      if (component.type === 12 && Array.isArray(component.items)) {
        const items = component.items
          .map((item) => sanitizeMediaItem(item))
          .filter(Boolean)
          .slice(0, MAX_MEDIA_ITEMS);
        if (items.length > 0) sanitizedComponents.push({ type: 12, items });
        continue;
      }

      if (component.type === 1 && Array.isArray(component.components)) {
        const buttons = component.components
          .map((btn) => sanitizeLinkButton(btn))
          .filter(Boolean)
          .slice(0, 1);
        if (buttons.length > 0) sanitizedComponents.push({ type: 1, components: buttons });
      }
    }

    if (sanitizedComponents.length > 0) {
      sanitizedContainers.push({ type: 17, components: sanitizedComponents });
    }
  }

  if (sanitizedContainers.length === 0) {
    throw new Error("Components payload is empty after sanitization.");
  }

  return {
    flags: payload?.flags ?? COMPONENTS_V2_FLAG,
    components: sanitizedContainers,
  };
}

function sanitizeMediaItem(item) {
  const url = item?.media?.url || item?.url || "";
  if (!isHttpUrl(url)) return null;

  const description = safeText(item?.description || "", 200);
  if (description) {
    return { media: { url }, description };
  }
  return { media: { url } };
}

function sanitizeLinkButton(button) {
  const url = button?.url || "";
  if (!isHttpUrl(url)) return null;

  const label = safeText(button?.label || "Open", MAX_BUTTON_LABEL);
  if (!label) return null;

  return {
    type: 2,
    style: 5,
    label,
    url,
  };
}

function addText(container, text) {
  const content = safeText(text, MAX_COMPONENT_TEXT);
  if (!content) return;
  container.components.push({ type: 10, content });
}

function addMediaGallery(container, items) {
  const safeItems = (Array.isArray(items) ? items : [])
    .map((item) => sanitizeMediaItem(item))
    .filter(Boolean)
    .slice(0, MAX_MEDIA_ITEMS);
  if (safeItems.length === 0) return;
  container.components.push({ type: 12, items: safeItems });
}

function addButton(container, label, url) {
  const safeButton = sanitizeLinkButton({ label, url });
  if (!safeButton) return;
  container.components.push({ type: 1, components: [safeButton] });
}

function isHttpUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getRetryDelayMs(response, attempt) {
  const fromBody = Number(response?.data?.retry_after);
  if (Number.isFinite(fromBody) && fromBody > 0) {
    // Discord usually gives retry_after in seconds (float).
    return clampDelay(fromBody * 1000);
  }

  const fromResetAfter = Number(response?.headers?.["x-ratelimit-reset-after"]);
  if (Number.isFinite(fromResetAfter) && fromResetAfter > 0) {
    return clampDelay(fromResetAfter * 1000);
  }

  const fromRetryAfter = Number(response?.headers?.["retry-after"]);
  if (Number.isFinite(fromRetryAfter) && fromRetryAfter > 0) {
    return clampDelay(fromRetryAfter < 100 ? fromRetryAfter * 1000 : fromRetryAfter);
  }

  return clampDelay(MIN_RETRY_DELAY_MS * Math.pow(2, attempt));
}

function clampDelay(ms) {
  return Math.max(MIN_RETRY_DELAY_MS, Math.min(MAX_RETRY_DELAY_MS, Math.ceil(ms)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncates string to specified length with ellipsis.
 *
 * @param {string} str - Input string
 * @param {number} n - Max length
 * @returns {string} Truncated string
 */
function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n).trim() + "..." : str;
}

function safeText(value, maxLen) {
  if (value === null || value === undefined) return "";
  const str = String(value).replace(/\u0000/g, "").trim();
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3).trimEnd()}...`;
}

/**
 * Extracts YouTube thumbnail URL from video link.
 *
 * @param {string} link - YouTube video URL
 * @returns {string|null} Thumbnail URL or null
 */
function getYouTubeThumbnailFromLink(link) {
  if (!link) return null;
  const m = link.match(/(?:v=|\/)([A-Za-z0-9_-]{11})/);
  if (m) return `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`;
  return null;
}

module.exports = { sendMessage };
