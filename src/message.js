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
    const webhookClient = new WebhookClient({ url: webhookUrl });
    const targetThreadId = threadId && threadId !== "null" ? threadId : undefined;

    // ------------------------
    // 1. Wariant YouTube
    // ------------------------
    if (entry.link && (entry.link.includes("youtube.com") || entry.link.includes("youtu.be"))) {
      const videoDescription = entry.contentSnippet
        ? entry.contentSnippet.slice(0, 100).trim() +
          (entry.contentSnippet.length > 100 ? "..." : "")
        : "Brak opisu.";

      await webhookClient.send({
        content: `📺 **Nowy film** ${entry.title}:\n\n> ${videoDescription}\n\n${entry.link}`,
        threadId: targetThreadId,
      });
      console.log(`[YouTube Link] Wysłano: ${entry.title}`);
      return;
    }

    // ------------------------
    // 2. Wariant Discord Message (z attachments)
    // ------------------------
    if (entry.attachments && entry.attachments.length > 0) {
      const embed = new EmbedBuilder()
        .setTitle(entry.author?.username || "Nowa wiadomość")
        .setDescription(entry.content || "(brak treści)")
        .setColor(0x5865f2) // kolor Discord
        .setTimestamp(entry.timestamp ? new Date(entry.timestamp) : new Date());

      // Obsłuż pierwszy załącznik jako obraz
      const firstAttachment = entry.attachments[0];
      if (firstAttachment.match(/\.(jpg|jpeg|png|gif|webp|bmp)(\?.*)?$/i)) {
        embed.setImage(firstAttachment);
      } else {
        embed.setThumbnail(firstAttachment);
      }

      await webhookClient.send({
        embeds: [embed],
        threadId: targetThreadId,
      });

      console.log(`[Discord] Wysłano wiadomość z załącznikiem od ${entry.author?.username}`);
      return;
    }

    // ------------------------
    // 3. Wariant RSS/ATOM/JSON (artykuły, newsy, commit-y)
    // ------------------------
    const finalDescription = entry.contentSnippet
      ? entry.contentSnippet.slice(0, 4096)
      : "Brak opisu.";

    const embed = new EmbedBuilder()
      .setTitle(entry.title || "Nowy wpis")
      .setURL(entry.link)
      .setColor(0x00aaff)
      .setDescription(finalDescription)
      .setFooter({ text: entry.author ? `Autor: ${entry.author}` : "RSS Bot" })
      .setTimestamp(entry.isoDate ? new Date(entry.isoDate) : new Date());

    if (entry.enclosure) {
      const isImage = entry.enclosure.match(/\.(jpg|jpeg|png|gif|webp|bmp)(\?.*)?$/i);
      if (isImage) {
        embed.setImage(entry.enclosure);
      } else {
        embed.setThumbnail(entry.enclosure);
      }
    }

    await webhookClient.send({
      embeds: [embed],
      threadId: targetThreadId,
    });

    console.log(
      `[Embed] Wysłano: ${entry.title}${entry.enclosure ? " z obrazkiem/miniaturą" : ""}`
    );
  } catch (err) {
    console.error(`[Embed] Błąd przy wysyłaniu wpisu "${entry.title}":`, err.message);
  }
}

module.exports = { sendMessage };