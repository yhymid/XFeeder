const { WebhookClient, EmbedBuilder } = require("discord.js");

/**
 * Wysyła wiadomość na Discorda w formie embeda.
 * @param {string} webhookUrl - URL webhooka Discord.
 * @param {string|null} threadId - ID wątku lub null.
 * @param {Object} entry - Wpis RSS do wysłania.
 * @param {string} entry.title - Tytuł wpisu.
 * @param {string} entry.link - Link do wpisu.
 * @param {string} [entry.contentSnippet] - Krótki opis (opcjonalnie).
 * @param {string} [entry.isoDate] - Data wpisu (opcjonalnie).
 */
async function sendMessage(webhookUrl, threadId, entry) {
  try {
    const webhookClient = new WebhookClient({ url: webhookUrl });

    const embed = new EmbedBuilder()
      .setTitle(entry.title || "Nowy wpis")
      .setURL(entry.link)
      .setColor(0x00aaff)
      .setDescription(entry.contentSnippet ? entry.contentSnippet.slice(0, 200) + "..." : "Brak opisu.")
      .setFooter({ text: "RSS Feed Bot" })
      .setTimestamp(entry.isoDate ? new Date(entry.isoDate) : new Date());

    await webhookClient.send({
      embeds: [embed],
      threadId: threadId !== "null" ? threadId : undefined,
    });

    console.log(`[Embed] Wysłano: ${entry.title}`);
  } catch (err) {
    console.error("[Embed] Błąd przy wysyłaniu wiadomości:", err.message);
  }
}

module.exports = { sendMessage };