"use strict";

const axios = require("axios");
const { networkAdapter } = require("./network/http-adapter");
const { context } = require("./network/context");
const { isCancelled } = require("./network/abort");

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TEXT_LENGTH = 4096;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlLimited(value, maxLength) {
  const input = String(value || "").replace(/\s+/g, " ").trim();
  let output = "";
  let truncated = false;

  for (const character of input) {
    const escaped = escapeHtml(character);
    if (output.length + escaped.length > maxLength) {
      truncated = true;
      break;
    }
    output += escaped;
  }

  if (truncated && output.length < maxLength) output += "…";
  return output;
}

function normalizeTelegramConfig(telegramConfig = {}) {
  const source = telegramConfig && typeof telegramConfig === "object" ? telegramConfig : {};
  const threadId = Number(source.MessageThreadID);
  const timeout = Number(source.TimeoutMs);

  return {
    enabled: source.Enabled !== false,
    botToken: String(source.BotToken || "").trim(),
    chatId: String(source.ChatID ?? "").trim(),
    messageThreadId: Number.isSafeInteger(threadId) && threadId > 0 ? threadId : null,
    disableWebPagePreview: source.DisableWebPagePreview === true,
    timeout: Number.isFinite(timeout) && timeout > 0 ? Math.max(1, Math.floor(timeout)) : DEFAULT_TIMEOUT_MS,
  };
}

function hasTelegramDeliveryTarget(telegramConfig = {}) {
  const normalized = normalizeTelegramConfig(telegramConfig);
  return Boolean(normalized.enabled && normalized.botToken && normalized.chatId);
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function buildTelegramMessage(entry = {}) {
  const title = escapeHtmlLimited(entry.title || "New entry", 480);
  const snippet = escapeHtmlLimited(entry.contentSnippet || entry.content || "", 2600);
  const meta = escapeHtmlLimited([entry.author, entry.isoDate].filter(Boolean).join(" · "), 320);
  const link = safeHttpUrl(entry.link);
  const attachments = Array.isArray(entry.attachments)
    ? entry.attachments.map(safeHttpUrl).filter(Boolean).slice(0, 2)
    : [];
  const enclosure = safeHttpUrl(entry.enclosure);
  if (enclosure && !attachments.includes(enclosure) && attachments.length < 2) {
    attachments.push(enclosure);
  }

  const parts = [`<b>${title}</b>`, meta, snippet].filter(Boolean);
  const appendIfItFits = (part) => {
    const next = [...parts, part].join("\n\n");
    if (next.length <= MAX_TEXT_LENGTH) parts.push(part);
  };

  if (link) appendIfItFits(`<a href="${escapeHtml(link)}">Open article</a>`);
  attachments.forEach((url, index) => {
    appendIfItFits(`<a href="${escapeHtml(url)}">Attachment ${index + 1}</a>`);
  });

  const text = parts.join("\n\n");
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error("Telegram message exceeds the 4096-character limit.");
  }
  return text;
}

async function sendTelegramMessage(telegramConfig, entry) {
  const config = normalizeTelegramConfig(telegramConfig);
  if (!config.enabled) throw new Error("Telegram target is disabled.");
  if (!config.botToken) throw new Error("Telegram bot token is missing.");
  if (!config.chatId) throw new Error("Telegram chat ID is missing.");

  const payload = {
    chat_id: config.chatId,
    text: buildTelegramMessage(entry),
    parse_mode: "HTML",
  };
  if (config.messageThreadId) payload.message_thread_id = config.messageThreadId;
  if (config.disableWebPagePreview) {
    payload.link_preview_options = { is_disabled: true };
  }

  let response;
  try {
    response = await axios.post(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      payload,
      {
        timeout: config.timeout,
        adapter: networkAdapter, signal: context().signal,
        xfeederDefaultTimeout: telegramConfig?.TimeoutMs == null ? DEFAULT_TIMEOUT_MS : undefined,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    if (isCancelled(error) || context().signal?.aborted) throw error;
    const description = error?.response?.data?.description;
    if (description) throw new Error(`Telegram API error: ${description}`);
    const status = error?.response?.status;
    if (status) throw new Error(`Telegram API request failed with HTTP ${status}.`);
    throw new Error(`Telegram API request failed (${error?.code || "network error"}).`);
  }

  if (response?.data?.ok === false) {
    throw new Error(`Telegram API error: ${response.data.description || "request was rejected"}`);
  }
  return response?.data?.result;
}

module.exports = {
  buildTelegramMessage,
  hasTelegramDeliveryTarget,
  normalizeTelegramConfig,
  sendTelegramMessage,
};
