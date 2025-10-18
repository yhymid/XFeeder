// src/message.js
const axios = require("axios");

/**
 * Wysyła wpis do kanału Discord poprzez webhook (Components V2).
 * Zamiast embedów korzystamy z Container (type:17) i Text Display / Media Gallery.
 *
 * @param {string} webhookUrl - pełny URL webhooka
 * @param {string|null} threadId - id wątku lub "null"
 * @param {object} entry - ustandaryzowany obiekt wpisu (title, link, contentSnippet, enclosure, attachments, author, timestamp, etc.)
 */
async function sendMessage(webhookUrl, threadId, entry) {
  try {
    // Przygotuj URL webhooka i query params
    let urlObj;
    try {
      urlObj = new URL(webhookUrl);
    } catch (e) {
      // jeśli webhookUrl np. ma spacje lub coś - rzuć czytelny błąd
      throw new Error("Nieprawidłowy webhookUrl: " + webhookUrl);
    }

    // Jeżeli wysyłamy komponenty, z parametrem with_components=true (wymagane)
    urlObj.searchParams.set("with_components", "true");
    if (threadId && threadId !== "null") {
      urlObj.searchParams.set("thread_id", threadId);
    }

    // Zbuduj główny container (bez accent_color -> brak kolorowego paska po lewej)
    const container = {
      type: 17,
      components: []
    };

    // --- YOUTUBE: tytuł + link (link jako Text Display -> Discord może unfurlować player) ---
    if (entry.link && (entry.link.includes("youtube.com") || entry.link.includes("youtu.be"))) {
      // Tytuł (Text Display)
      container.components.push({
        type: 10,
        content: `📺 ${entry.title || "Nowy film"}`
      });

      // Link jako oddzielny Text Display - to pozwala na automatyczne unfurl (player).
      container.components.push({
        type: 10,
        content: entry.link
      });

      // Miniaturka (jeśli mamy) - Media Gallery z jednym elementem
      const thumb = entry.enclosure || getYouTubeThumbnailFromLink(entry.link);
      if (thumb) {
        container.components.push({
          type: 12,
          items: [
            {
              media: { url: thumb },
              description: entry.title || "Thumbnail"
            }
          ]
        });
      }

      // Przycisk "Otwórz" (link button)
      container.components.push({
        type: 1,
        components: [
          {
            type: 2,
            style: 5, // link
            label: "Otwórz na YouTube",
            url: entry.link
          }
        ]
      });

      const payload = {
        flags: 1 << 15, // IS_COMPONENTS_V2
        components: [container]
      };

      await postToWebhook(urlObj.toString(), payload);
      console.log(`[ComponentsV2] Wysłano (YouTube): ${entry.title}`);
      return;
    }

// --- DISCORD MESSAGE (parseDiscord result) ---
if (entry.attachments || entry.content || entry.referenced) {
  const username = entry.author?.username || "Użytkownik";
  const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString("pl-PL") : "";

  // Nagłówek zamiast kopiowanego tytułu
  container.components.push({
    type: 10,
    content: `💬 Wykryto nową wiadomość od **${username}**`
  });

  // Treść wiadomości (jeśli jest)
  if (entry.content) {
    container.components.push({
      type: 10,
      content: entry.content
    });
  }

  // Załączniki
  if (entry.attachments && entry.attachments.length > 0) {
    container.components.push({
      type: 12,
      items: entry.attachments.slice(0, 10).map((url) => ({
        media: { url },
        description: username
      }))
    });
  }

  // Odpowiedź do kogoś
  if (entry.referenced) {
    container.components.push({
      type: 10,
      content: `↪️ *Odpowiedź do: ${entry.referenced.author || "Anonim"} — "${truncate(entry.referenced.content, 100)}"*`
    });
  }

  // Stopka (data)
  container.components.push({
    type: 10,
    content: `👤 ${username} • 🕒 ${timestamp}`
  });

  // Przycisk do oryginalnej wiadomości (jeśli masz URL)
  if (entry.link) {
    container.components.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "Otwórz",
          url: entry.link
        }
      ]
    });
  }

  const payload = {
    flags: 1 << 15,
    components: [container]
  };

  await postToWebhook(urlObj.toString(), payload);
  console.log(`[ComponentsV2] Wysłano (Discord message od ${username})`);
  return;
}



    // ------------------------
    // DISCORD MESSAGE (Opcja 2A!)
    // ------------------------
    if (entry.categories?.includes("discord")) {
      const username = entry.author || "Użytkownik";
      const timestamp = entry.isoDate ? new Date(entry.isoDate).toLocaleString("pl-PL") : "";

      container.components.push({
        type: 10,
        content: `💬 Wykryto nową wiadomość od **${username}**`
      });

      container.components.push({
        type: 10,
        content: entry.contentSnippet ? entry.contentSnippet : "(załącznik)"
      });

      const mediaItems = [];
      if (entry.enclosure) {
        mediaItems.push({
          media: { url: entry.enclosure },
          description: username
        });
      }

      if (entry.discordData?.embeds && entry.discordData.embeds > 0 && entry.embedThumbnail) {
        mediaItems.push({
          media: { url: entry.embedThumbnail },
          description: "Embed"
        });
      }

      if (mediaItems.length > 0) {
        container.components.push({
          type: 12,
          items: mediaItems
        });
      }

      container.components.push({
        type: 10,
        content: `👤 ${username} • 🕒 ${timestamp}`
      });

      if (entry.link) {
        container.components.push({
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Otwórz",
              url: entry.link
            }
          ]
        });
      }

      await postToWebhook(urlObj.toString(), { flags: 1 << 15, components: [container] });
      console.log(`[ComponentsV2] Wysłano (Discord message od ${username})`);
      return;
    }


    // --- RSS / ATOM / JSON (artykuły, commity, newsy) ---
    // Tytuł
    container.components.push({
      type: 10,
      content: `📰 **${entry.title || "Nowy wpis"}**`
    });

    // Skrót treści
    if (entry.contentSnippet) {
      container.components.push({
        type: 10,
        content: truncate(entry.contentSnippet, 800)
      });
    }

    // Media (enclosure) -> Media Gallery
    if (entry.enclosure) {
      container.components.push({
        type: 12,
        items: [
          {
            media: { url: entry.enclosure },
            description: entry.title || "Media"
          }
        ]
      });
    }

    // Autor / data
    if (entry.author || entry.isoDate) {
      container.components.push({
        type: 10,
        content: `👤 ${entry.author || "Anonim"} • 🕒 ${entry.isoDate ? new Date(entry.isoDate).toLocaleString("pl-PL") : ""}`
      });
    }

    // Link button
    if (entry.link) {
      container.components.push({
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Otwórz",
            url: entry.link
          }
        ]
      });
    }

    const payload = {
      flags: 1 << 15,
      components: [container]
    };

    await postToWebhook(urlObj.toString(), payload);
    console.log(`[ComponentsV2] Wysłano: ${entry.title || entry.link || "(brak tytułu)"}`);
  } catch (err) {
    if (err.response) {
      console.error(`[ComponentsV2] Błąd przy wysyłaniu wpisu: ${err.response.status}`, err.response.data);
    } else {
      console.error(`[ComponentsV2] Błąd:`, err.message);
    }
  }
}

async function postToWebhook(url, payload) {
  return axios.post(url, payload, { headers: { "Content-Type": "application/json" } });
}

/** helper: skracanie tekstu */
function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n).trim() + "..." : str;
}

/** helper: wyciągnij miniaturkę YT z linka (jeśli brak enclosure) */
function getYouTubeThumbnailFromLink(link) {
  if (!link) return null;
  const m = link.match(/(?:v=|\/)([A-Za-z0-9_-]{11})/);
  if (m) return `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`;
  return null;
}

module.exports = { sendMessage };