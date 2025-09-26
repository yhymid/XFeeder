const axios = require("axios");

/**
 * Parser wiadomości z kanału Discord.
 * @param {object} discordConfig konfiguracja z config.json
 * @returns {Promise<Array>} lista wiadomości w formacie feeda
 */
async function parseDiscord(discordConfig, httpClient = axios) {
  const messages = [];

  // Sprawdź czy konfiguracja Discord istnieje
  if (!discordConfig || !discordConfig.Token) {
    console.error('[Discord parser] Brak konfiguracji Discord lub tokenu');
    return [];
  }

  // Pobierz listę kanałów do monitorowania
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

/**
 * Pobiera listę channelIDs z konfiguracji
 */
function getChannelIds(discordConfig) {
  const channelIds = [];
  
  // Obsługa różnych formatów konfiguracji
  if (discordConfig.ChannelIDs) {
    if (Array.isArray(discordConfig.ChannelIDs)) {
      channelIds.push(...discordConfig.ChannelIDs);
    } else if (typeof discordConfig.ChannelIDs === 'string') {
      channelIds.push(discordConfig.ChannelIDs);
    }
  }
  
  // Obsługa starego formatu GuildID dla kompatybilności wstecznej
  if (discordConfig.GuildID && channelIds.length === 0) {
    if (Array.isArray(discordConfig.GuildID)) {
      channelIds.push(...discordConfig.GuildID);
    } else {
      channelIds.push(discordConfig.GuildID);
    }
  }
  
  // Filtruj puste wartości
  return channelIds.filter(id => id && id.trim() !== '');
}

/**
 * Pobiera wiadomości z pojedynczego kanału
 */
async function fetchChannelMessages(channelId, discordConfig, httpClient) {
  const url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=${discordConfig.Limit || 50}`;
  
  const headers = {
    "accept": "*/*",
    "accept-language": "pl",
    "authorization": discordConfig.Token,
    "priority": "u=1, i",
    "sec-ch-ua": '"Not:A-Brand";v="24", "Chromium";v="134"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-debug-options": "bugReporterEnabled",
    "x-discord-locale": "en-US",
    "x-discord-timezone": "Europe/Warsaw",
    "x-super-properties": discordConfig["x-super-properties"],
    "cookie": discordConfig.cookie,
    "referer": `https://discord.com/channels/${discordConfig.GuildID || 'unknown'}/${channelId}`,
    "Referrer-Policy": "strict-origin-when-cross-origin"
  };

  const res = await httpClient.get(url, { 
    headers, 
    timeout: discordConfig.Timeout || 15000 
  });

  const channelMessages = [];
  
  for (const msg of res.data) {
    // Pobierz obrazki z załączników
    let imageUrl = null;
    if (msg.attachments && msg.attachments.length > 0) {
      const imageAttachment = msg.attachments.find(att => 
        att.content_type && att.content_type.startsWith('image/')
      );
      if (imageAttachment) {
        imageUrl = imageAttachment.url;
      }
    }
    
    // Pobierz obrazki z embedów
    if (!imageUrl && msg.embeds && msg.embeds.length > 0) {
      const imageEmbed = msg.embeds.find(embed => 
        embed.thumbnail || embed.image
      );
      if (imageEmbed) {
        imageUrl = imageEmbed.thumbnail?.url || imageEmbed.image?.url;
      }
    }

    channelMessages.push({
      guid: msg.id,
      title: msg.content ? 
        (msg.content.length > 80 ? msg.content.substring(0, 80) + '...' : msg.content) 
        : `Wiadomość od ${msg.author.global_name || msg.author.username}`,
      link: `https://discord.com/channels/${discordConfig.GuildID}/${msg.channel_id}/${msg.id}`,
      contentSnippet: msg.content || "(brak treści)",
      isoDate: msg.timestamp || new Date().toISOString(),
      author: msg.author.global_name || msg.author.username || "Unknown",
      enclosure: imageUrl,
      categories: ['discord'],
      // Dodatkowe informacje
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

module.exports = { parseDiscord };