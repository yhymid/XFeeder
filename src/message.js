// src/message.js
const axios = require("axios");

/**
 * Wysyła wpis do kanału Discord poprzez webhook (Components V2).
 * Brak fallbacku do embedów (embedy usunięte w całości).
 *
 * @param {string} webhookUrl - pełny URL webhooka
 * @param {string|null} threadId - id wątku lub "null"
 * @param {object} entry - ustandaryzowany obiekt wpisu (title, link, contentSnippet, enclosure, attachments, author, timestamp, etc.)
 */
async function sendMessage(webhookUrl, threadId, entry) {
  try {
    let urlObj;
    try {
      urlObj = new URL(webhookUrl);
    } catch (e) {
      throw new Error("Nieprawidłowy webhookUrl: " + webhookUrl);
    }

    urlObj.searchParams.set("with_components", "true");
    if (threadId && threadId !== "null") {
      urlObj.searchParams.set("thread_id", threadId);
    }

    const container = { type: 17, components: [] };

    // --- YOUTUBE ---
    if (entry.link && (entry.link.includes("youtube.com") || entry.link.includes("youtu.be"))) {
      container.components.push({ type: 10, content: `📺 ${entry.title || "Nowy film"}` });
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
        components: [{ type: 2, style: 5, label: "Otwórz na YouTube", url: entry.link }]
      });

      const payload = { flags: 1 << 15, components: [container] };
      await postToWebhook(urlObj.toString(), payload);
      console.log(`[ComponentsV2] Wysłano (YouTube): ${entry.title}`);
      return;
    }

    // --- DISCORD (priorytet) ---
    if (entry.categories?.includes("discord")) {
      const username = entry.author || "Użytkownik";
      const timestamp = entry.isoDate ? new Date(entry.isoDate).toLocaleString("pl-PL") : "";

      container.components.push({ type: 10, content: `💬 Wykryto nową wiadomość od **${username}**` });

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
          content: `↪️ *Odpowiedź do: ${entry.referenced.author || "Anonim"} — "${truncate(entry.referenced.content, 100)}"*`
        });
      }

      container.components.push({ type: 10, content: `👤 ${username} • 🕒 ${timestamp}` });

      if (entry.link) {
        container.components.push({
          type: 1,
          components: [{ type: 2, style: 5, label: "Otwórz", url: entry.link }]
        });
      }

      await postToWebhook(urlObj.toString(), { flags: 1 << 15, components: [container] });
      console.log(`[ComponentsV2] Wysłano (Discord message od ${username})`);
      return;
    }

    // --- DISCORD MESSAGE (generyczne, fallback treści – nadal Components) ---
    if (entry.attachments || entry.content || entry.referenced) {
      const username = entry.author?.username || entry.author || "Użytkownik";
      const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString("pl-PL") : "";

      container.components.push({ type: 10, content: `💬 Wykryto nową wiadomość od **${username}**` });

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
          content: `↪️ *Odpowiedź do: ${entry.referenced.author || "Anonim"} — "${truncate(entry.referenced.content, 100)}"*`
        });
      }

      container.components.push({ type: 10, content: `👤 ${username} • 🕒 ${timestamp}` });

      if (entry.link) {
        container.components.push({
          type: 1,
          components: [{ type: 2, style: 5, label: "Otwórz", url: entry.link }]
        });
      }

      const payload = { flags: 1 << 15, components: [container] };
      await postToWebhook(urlObj.toString(), payload);
      console.log(`[ComponentsV2] Wysłano (Discord message od ${username})`);
      return;
    }

    // --- RSS / ATOM / JSON ---
    container.components.push({ type: 10, content: `📰 **${entry.title || "Nowy wpis"}**` });

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
        content: `👤 ${entry.author || "Anonim"} • 🕒 ${entry.isoDate ? new Date(entry.isoDate).toLocaleString("pl-PL") : ""}`
      });
    }

    if (entry.link) {
      container.components.push({
        type: 1,
        components: [{ type: 2, style: 5, label: "Otwórz", url: entry.link }]
      });
    }

    const payload = { flags: 1 << 15, components: [container] };
    await postToWebhook(urlObj.toString(), payload);
    console.log(`[ComponentsV2] Wysłano: ${entry.title || entry.link || "(brak tytułu)"}`);
  } catch (err) {
    if (err.response) console.error(`[ComponentsV2] Błąd przy wysyłaniu wpisu: ${err.response.status}`, err.response.data);
    else console.error(`[ComponentsV2] Błąd:`, err.message);
  }
}

async function postToWebhook(url, payload) {
  return axios.post(url, payload, { headers: { "Content-Type": "application/json" } });
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n).trim() + "..." : str;
}

function getYouTubeThumbnailFromLink(link) {
  if (!link) return null;
  const m = link.match(/(?:v=|\/)([A-Za-z0-9_-]{11})/);
  if (m) return `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`;
  return null;
}

module.exports = { sendMessage };