const { WebhookClient, EmbedBuilder } = require("discord.js");

async function sendMessage(webhookUrl, threadId, entry) {
  try {
    const webhookClient = new WebhookClient({ url: webhookUrl });

    const embed = new EmbedBuilder()
      .setTitle(entry.title || "Nowy wpis")
      .setURL(entry.link)
      .setColor(0x00aaff)
      .setDescription(entry.contentSnippet ? entry.contentSnippet.slice(0, 200) + "..." : "Brak opisu.")
      .setFooter({ text: entry.author ? `Autor: ${entry.author}` : "RSS Bot" })
      .setTimestamp(entry.isoDate ? new Date(entry.isoDate) : new Date());

    if (entry.enclosure) embed.setImage(entry.enclosure);

    await webhookClient.send({
      embeds: [embed],
      threadId: threadId !== "null" ? threadId : undefined,
    });

    console.log(`[Embed] Wysłano: ${entry.title}`);
  } catch (err) {
    console.error("[Embed] Błąd przy wysyłaniu:", err.message);
  }
}

module.exports = { sendMessage };
