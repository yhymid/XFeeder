// src/message.js
const { WebhookClient, EmbedBuilder } = require("discord.js");

/**
 * Wysyła ustandaryzowany wpis do kanału Discord poprzez webhook.
 * @param {string} webhookUrl Adres URL webhooka.
 * @param {string} threadId ID wątku, jeśli dotyczy (lub "null").
 * @param {object} entry Ustandaryzowany obiekt wpisu z feeda.
 */
async function sendMessage(webhookUrl, threadId, entry) {
  try {
    // Discord.js wymaga, aby URL było podane jako obiekt { url: string }
    const webhookClient = new WebhookClient({ url: webhookUrl });
    // Konwersja 'null' z configa na 'undefined' dla Discord API
    const targetThreadId = threadId && threadId !== "null" ? threadId : undefined;

    // 1. Wariant WIDEO (YouTube lub inne serwisy wideo)
    if (entry.link && (entry.link.includes('youtube.com') || entry.link.includes('youtu.be'))) {
        
        // Używamy opisu jako pierwszych 100 znaków snipetta
        const videoDescription = entry.contentSnippet 
            ? entry.contentSnippet.slice(0, 100).trim() + (entry.contentSnippet.length > 100 ? '...' : '') 
            : 'Brak opisu.';

      await webhookClient.send({
        content: `📺 **Nowy film** ${entry.title}:\n\n> ${videoDescription}\n\n${entry.link}`,
        threadId: targetThreadId,
      });
      console.log(`[YouTube Link] Wysłano: ${entry.title}`);
      return;
    }

    // 2. Wariant ARTYKUŁ / OGÓLNY EMBED

    // Finalny opis: ponieważ contentSnippet jest już przycięty w parserach,
    // użyjemy go w całości, chyba że jest zbyt długi (np. powyżej 500 znaków).
    const finalDescription = entry.contentSnippet 
        ? entry.contentSnippet.slice(0, 4096) // Maksymalny limit dla Discorda to 4096
        : "Brak opisu.";

    const embed = new EmbedBuilder()
      .setTitle(entry.title || "Nowy wpis")
      .setURL(entry.link)
      .setColor(0x00aaff) // Niebieski kolor
      .setDescription(finalDescription)
      .setFooter({ text: entry.author ? `Autor: ${entry.author}` : "RSS Bot" })
      .setTimestamp(entry.isoDate ? new Date(entry.isoDate) : new Date());

    // DODAJ OBRAZEK (ustal priorytet dla dużego obrazka)
    if (entry.enclosure) {
      const isImage = entry.enclosure.match(/\.(jpg|jpeg|png|gif|webp|bmp)(\?.*)?$/i);
      
      // Jeśli to jest wideo lub plik, ustaw jako miniaturę (Discord często nie obsługuje
      // bezpośrednich linków do plików wideo w tagu setImage)
      if (isImage) {
        embed.setImage(entry.enclosure); // Duży obrazek
      } else {
        embed.setThumbnail(entry.enclosure); // Miniatura
      }
    }

    await webhookClient.send({
      embeds: [embed],
      threadId: targetThreadId,
    });

    console.log(`[Embed] Wysłano: ${entry.title}${entry.enclosure ? ' z obrazkiem/mediem' : ''}`);
  } catch (err) {
    console.error(`[Embed] Błąd przy wysyłaniu wpisu "${entry.title}":`, err.message);
  }
}

module.exports = { sendMessage };