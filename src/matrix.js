"use strict";

const axios = require("axios");
const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_LENGTH = 3500;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value, maxLength = MAX_BODY_LENGTH) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeMatrixConfig(matrixConfig = {}) {
  const timeout = Number(matrixConfig.Timeout || matrixConfig.TimeoutMs);
  return {
    enabled: matrixConfig.Enabled !== false,
    homeserver: String(matrixConfig.Homeserver || "").replace(/\/+$/, ""),
    accessToken: String(matrixConfig.AccessToken || "").trim(),
    roomId: String(matrixConfig.RoomID || "").trim(),
    msgtype: String(matrixConfig.MsgType || "m.notice").trim() || "m.notice",
    timeout: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_TIMEOUT_MS,
  };
}

function hasMatrixDeliveryTarget(matrixConfig = {}) {
  const normalized = normalizeMatrixConfig(matrixConfig);
  return Boolean(
    normalized.enabled &&
    normalized.homeserver &&
    normalized.accessToken &&
    normalized.roomId
  );
}

function buildMatrixMessage(entry, msgtype) {
  const title = truncate(entry?.title || "New entry", 200);
  const snippet = truncate(entry?.contentSnippet || entry?.content || "", 1200);
  const meta = [entry?.author, entry?.isoDate].filter(Boolean).join(" | ");
  const link = typeof entry?.link === "string" ? entry.link.trim() : "";

  const lines = [title, meta, snippet, link].filter(Boolean);
  const safeTitle = escapeHtml(title);
  const safeMeta = escapeHtml(meta);
  const safeSnippet = escapeHtml(snippet).replace(/\n/g, "<br>");
  const safeLink = link ? `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>` : "";
  const htmlParts = [
    safeTitle ? `<strong>${safeTitle}</strong>` : "",
    safeMeta ? `<p>${safeMeta}</p>` : "",
    safeSnippet ? `<p>${safeSnippet}</p>` : "",
    safeLink ? `<p>${safeLink}</p>` : "",
  ].filter(Boolean);

  return {
    msgtype,
    body: lines.join("\n"),
    format: "org.matrix.custom.html",
    formatted_body: htmlParts.join(""),
  };
}

async function sendMatrixMessage(matrixConfig, entry) {
  const normalized = normalizeMatrixConfig(matrixConfig);
  if (!normalized.enabled) {
    throw new Error("Matrix target is disabled.");
  }
  if (!normalized.homeserver) {
    throw new Error("Matrix homeserver is missing.");
  }
  if (!normalized.accessToken) {
    throw new Error("Matrix access token is missing.");
  }
  if (!normalized.roomId) {
    throw new Error("Matrix room ID is missing.");
  }

  const txnId = `xfeeder-${Date.now()}-${crypto.randomUUID()}`;
  const url =
    `${normalized.homeserver}/_matrix/client/v3/rooms/` +
    `${encodeURIComponent(normalized.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;

  const payload = buildMatrixMessage(entry, normalized.msgtype);

  await axios.put(url, payload, {
    timeout: normalized.timeout,
    headers: {
      Authorization: `Bearer ${normalized.accessToken}`,
      "Content-Type": "application/json",
    },
  });
}

module.exports = {
  hasMatrixDeliveryTarget,
  normalizeMatrixConfig,
  sendMatrixMessage,
};
