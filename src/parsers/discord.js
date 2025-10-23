// src/parsers/discord.js
const axios = require("axios");

/**
 * Parser wiadomości z kanału Discord.
 * @param {object} discordConfig konfiguracja z config.json
 * @param {object} httpClient klient HTTP z metodą .get (domyślnie axios; w core przekazywany jest getWithFallback)
 * @returns {Promise<Array>} lista wiadomości w formacie feeda
 */
async function parseDiscord(discordConfig, httpClient = axios) {
  const messages = [];

  if (!discordConfig || !discordConfig.Token) {
    console.error('[Discord parser] Brak konfiguracji Discord lub tokenu');
    return [];
  }

  const channelIds = getChannelIds(discordConfig);
  if (channelIds.length === 0) {
    console.error('[Discord parser] Brak ChannelIDs; dodaj "ChannelIDs" (GuildID nie jest ID kanału).');
    return [];
  }

  console.log(`[Discord parser] Sprawdzanie ${channelIds.length} kanałów...`);

  for (const channelId of channelIds) {
    try {
      const channelMessages = await fetchChannelMessages(channelId, discordConfig, httpClient);
      messages.push(...channelMessages);
    } catch (err) {
      console.error(`[Discord parser] Błąd kanału ${channelId}:`, err.message);
    }
  }

  console.log(`[Discord parser] Znaleziono ${messages.length} wiadomości`);
  return messages;
}

function getChannelIds(discordConfig) {
  const channelIds = [];
  if (Array.isArray(discordConfig.ChannelIDs)) {
    channelIds.push(...discordConfig.ChannelIDs.filter((x) => typeof x === "string" && x.trim()));
  } else if (typeof discordConfig.ChannelIDs === "string" && discordConfig.ChannelIDs.trim()) {
    channelIds.push(discordConfig.ChannelIDs.trim());
  }
  // Opcjonalnie wspieraj singular "ChannelID"
  if (!channelIds.length && typeof discordConfig.ChannelID === "string" && discordConfig.ChannelID.trim()) {
    channelIds.push(discordConfig.ChannelID.trim());
  }
  return channelIds;
}

async function fetchChannelMessages(channelId, discordConfig, httpClient) {
  const url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=${discordConfig.Limit || 50}`;
  
  const headers = {
    "authorization": discordConfig.Token,
    "accept": "*/*",
    "accept-language": "pl",
    "referer": `https://discord.com/channels/${discordConfig.GuildID || 'unknown'}/${channelId}`,
    "x-discord-locale": "en-US",
    "x-discord-timezone": "Europe/Warsaw",
    "cookie": discordConfig.cookie,
    "x-super-properties": discordConfig["x-super-properties"],
  };

  const res = await httpClient.get(url, { headers, timeout: discordConfig.Timeout || 15000 });
  const channelMessages = [];

  for (const msg of res.data) {
    const attachmentsUrls = (msg.attachments || []).map(a => a?.url).filter(Boolean);
    const embedThumb = extractEmbedThumbnail(msg);

    let imageUrl = null;
    if (attachmentsUrls.length) {
      const imgAttach = (msg.attachments || []).find(a => a?.content_type?.startsWith('image/'));
      imageUrl = imgAttach?.url || null;
    }
    if (!imageUrl && embedThumb) imageUrl = embedThumb;

    const referenced = msg.referenced_message ? {
      author: msg.referenced_message.author?.global_name || msg.referenced_message.author?.username,
      content: msg.referenced_message.content
    } : undefined;

    channelMessages.push({
      guid: msg.id,
      title: msg.content
        ? (msg.content.length > 80 ? msg.content.substring(0, 80) + "..." : msg.content)
        : `Wiadomość od ${msg.author?.global_name || msg.author?.username}`,
      link: `https://discord.com/channels/${msg.guild_id || discordConfig.GuildID}/${msg.channel_id}/${msg.id}`,
      contentSnippet: msg.content || "(brak treści)",
      isoDate: msg.timestamp || new Date().toISOString(),
      author: msg.author?.global_name || msg.author?.username || "Unknown",
      enclosure: imageUrl,
      embedThumbnail: embedThumb,
      attachments: attachmentsUrls,
      referenced,
      categories: ['discord'],
      discordData: {
        messageId: msg.id,
        channelId: msg.channel_id,
        guildId: msg.guild_id,
        authorId: msg.author?.id,
        attachments: msg.attachments?.length || 0,
        embeds: msg.embeds?.length || 0,
        mentions: msg.mentions?.length || 0,
        reactions: msg.reactions?.length || 0
      }
    });
  }

  return channelMessages;
}

/** ✅ Obsługa thumbnail z embeda (YT, Twitter itp.) */
function extractEmbedThumbnail(msg) {
  if (msg.embeds && msg.embeds.length > 0) {
    const embed = msg.embeds.find(e => e.thumbnail || e.image);
    if (embed) {
      return embed.thumbnail?.url || embed.image?.url || null;
    }
  }
  return null;
}

module.exports = { parseDiscord };