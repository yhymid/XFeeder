const axios = require("axios");

/**
 * Parser wiadomości z kanału Discord.
 * @param {object} discordConfig konfiguracja z config.json
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
    console.error('[Discord parser] Brak channelIDs w konfiguracji');
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
  if (discordConfig.ChannelIDs) {
    if (Array.isArray(discordConfig.ChannelIDs)) channelIds.push(...discordConfig.ChannelIDs);
    else if (typeof discordConfig.ChannelIDs === 'string') channelIds.push(discordConfig.ChannelIDs);
  }
  if (discordConfig.GuildID && channelIds.length === 0) {
    if (Array.isArray(discordConfig.GuildID)) channelIds.push(...discordConfig.GuildID);
    else channelIds.push(discordConfig.GuildID);
  }
  return channelIds.filter(id => id && id.trim() !== '');
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
    let imageUrl = null;
    if (msg.attachments && msg.attachments.length > 0) {
      const imageAttachment = msg.attachments.find(att => att.content_type && att.content_type.startsWith('image/'));
      if (imageAttachment) imageUrl = imageAttachment.url;
    }

    if (!imageUrl) {
      const thumb = extractEmbedThumbnail(msg);
      if (thumb) imageUrl = thumb;
    }

    channelMessages.push({
      guid: msg.id,
      title: msg.content
        ? (msg.content.length > 80 ? msg.content.substring(0, 80) + "..." : msg.content)
        : `Wiadomość od ${msg.author.global_name || msg.author.username}`,
      link: `https://discord.com/channels/${discordConfig.GuildID}/${msg.channel_id}/${msg.id}`,
      contentSnippet: msg.content || "(brak treści)",
      isoDate: msg.timestamp || new Date().toISOString(),
      author: msg.author.global_name || msg.author.username || "Unknown",
      enclosure: imageUrl,
      embedThumbnail: extractEmbedThumbnail(msg),
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
