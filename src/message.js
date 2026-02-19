// src/message.js - Discord webhook sender (Components V2 format)
const axios = require("axios");

/**
 * Sends an entry to Discord channel via webhook (Components V2).
 * No fallback to classic embeds (removed in v2.x line).
 *
 * @param {string} webhookUrl - Full webhook URL
 * @param {string|null} threadId - Thread ID or "null"
 * @param {object} entry - Standardized entry object (title, link, contentSnippet, enclosure, attachments, author, timestamp, etc.)
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
      container.components.push({ type: 10, content: `📺 ${entry.title || "New video"}` });
      container.components.push({ type: 10, content: entry.link });

      const thumb = entry.enclosure || getYouTubeThumbnailFromLink(entry.link);
      if (thumb) {
        container.components.push({
          type: 12,
          items: [{ media: { url: thumb }, description: entry.title || "Thumbnail" }]
        });
      }

      container.components.push({
        type: 1,
        components: [{ type: 2, style: 5, label: "Open on YouTube", url: entry.link }]
      });

      const payload = { flags: 1 << 15, components: [container] };
      await postToWebhook(urlObj.toString(), payload);
      console.log(`[ComponentsV2] Sent (YouTube): ${entry.title}`);
      return;
    }

    // --- DISCORD (priority) ---
    if (entry.categories?.includes("discord")) {
      const username = entry.author || "User";
      const timestamp = entry.isoDate ? new Date(entry.isoDate).toLocaleString("en-US") : "";

      container.components.push({ type: 10, content: `💬 New message from **${username}**` });

      if (entry.contentSnippet) {
        container.components.push({ type: 10, content: entry.contentSnippet });
      }

      const mediaItems = [];
      if (entry.enclosure) mediaItems.push({ media: { url: entry.enclosure }, description: username });
      if (entry.embedThumbnail) mediaItems.push({ media: { url: entry.embedThumbnail }, description: "Embed" });
      if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
        mediaItems.push(...entry.attachments.slice(0, 10).map((url) => ({
          media: { url }, description: username
        })));
      }
      if (mediaItems.length > 0) container.components.push({ type: 12, items: mediaItems });

      if (entry.referenced) {
        container.components.push({
          type: 10,
          content: `↪️ *Reply to: ${entry.referenced.author || "Anonymous"} — "${truncate(entry.referenced.content, 100)}"*`
        });
      }

      container.components.push({ type: 10, content: `👤 ${username} • 🕒 ${timestamp}` });

      if (entry.link) {
        container.components.push({
          type: 1,
          components: [{ type: 2, style: 5, label: "Open", url: entry.link }]
        });
      }

      await postToWebhook(urlObj.toString(), { flags: 1 << 15, components: [container] });
      console.log(`[ComponentsV2] Sent (Discord message from ${username})`);
      return;
    }

    // --- DISCORD MESSAGE (generic, content fallback — still Components) ---
    if (entry.attachments || entry.content || entry.referenced) {
      const username = entry.author?.username || entry.author || "User";
      const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString("en-US") : "";

      container.components.push({ type: 10, content: `💬 New message from **${username}**` });

      if (entry.content) container.components.push({ type: 10, content: entry.content });

      if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
        container.components.push({
          type: 12,
          items: entry.attachments.slice(0, 10).map((url) => ({ media: { url }, description: username }))
        });
      }

      if (entry.referenced) {
        container.components.push({
          type: 10,
          content: `↪️ *Reply to: ${entry.referenced.author || "Anonymous"} — "${truncate(entry.referenced.content, 100)}"*`
        });
      }

      container.components.push({ type: 10, content: `👤 ${username} • 🕒 ${timestamp}` });

      if (entry.link) {
        container.components.push({
          type: 1,
          components: [{ type: 2, style: 5, label: "Open", url: entry.link }]
        });
      }

      const payload = { flags: 1 << 15, components: [container] };
      await postToWebhook(urlObj.toString(), payload);
      console.log(`[ComponentsV2] Sent (Discord message from ${username})`);
      return;
    }

    // --- RSS / ATOM / JSON ---
    container.components.push({ type: 10, content: `📰 **${entry.title || "New entry"}**` });

    if (entry.contentSnippet) {
      container.components.push({ type: 10, content: truncate(entry.contentSnippet, 800) });
    }

    if (entry.enclosure) {
      container.components.push({
        type: 12,
        items: [{ media: { url: entry.enclosure }, description: entry.title || "Media" }]
      });
    }

    if (entry.author || entry.isoDate) {
      container.components.push({
        type: 10,
        content: `👤 ${entry.author || "Anonymous"} • 🕒 ${entry.isoDate ? new Date(entry.isoDate).toLocaleString("en-US") : ""}`
      });
    }

    if (entry.link) {
      container.components.push({
        type: 1,
        components: [{ type: 2, style: 5, label: "Open", url: entry.link }]
      });
    }

    const payload = { flags: 1 << 15, components: [container] };
    await postToWebhook(urlObj.toString(), payload);
    console.log(`[ComponentsV2] Sent: ${entry.title || entry.link || "(no title)"}`);
  } catch (err) {
    if (err.response) {
      console.error(`[ComponentsV2] Send error: ${err.response.status}`, err.response.data);
    } else {
      console.error(`[ComponentsV2] Error:`, err.message);
    }
  }
}

/**
 * Posts payload to webhook URL.
 * 
 * @param {string} url - Full webhook URL with query params
 * @param {object} payload - Request body
 * @returns {Promise<object>} Axios response
 */
async function postToWebhook(url, payload) {
  return axios.post(url, payload, { headers: { "Content-Type": "application/json" } });
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
