const { WebhookClient, EmbedBuilder } = require("discord.js");

async function sendMessage(webhookUrl, threadId, entry) {
  try {
    const webhookClient = new WebhookClient({ url: webhookUrl });

    // Jeśli to YouTube, wyślij sam link bez embed
    if (entry.link && (entry.link.includes('youtube.com') || entry.link.includes('youtu.be'))) {
      await webhookClient.send({
        content: `📺 **Nowy film**: ${entry.link}`,
        threadId: threadId !== "null" ? threadId : undefined,
      });
      console.log(`[YouTube Link] Wysłano: ${entry.title}`);
      return;
    }

    // Dla innych feedów - normalny embed
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