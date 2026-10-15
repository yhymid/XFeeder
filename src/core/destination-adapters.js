"use strict";

// Keep destination transport and provider-specific payload formatting owned by
// existing senders. This registry does not decide retry, dedup or persistence.
function createDestinationAdapters({ sendMessage, sendTelegramMessage } = {}) {
  return Object.freeze({
    webhook: Object.freeze({
      kind: "webhook",
      send(targetConfig, entry) {
        if (typeof sendMessage !== "function")
          throw new TypeError("Discord webhook sender is not available");
        return sendMessage(targetConfig.webhookUrl, targetConfig.threadId, entry);
      },
    }),
    telegram: Object.freeze({
      kind: "telegram",
      send(targetConfig, entry) {
        if (typeof sendTelegramMessage !== "function")
          throw new TypeError("Telegram sender is not available");
        return sendTelegramMessage(targetConfig.telegramConfig, entry);
      },
    }),
  });
}

module.exports = { createDestinationAdapters };
