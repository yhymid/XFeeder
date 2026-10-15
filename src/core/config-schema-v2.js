"use strict";

// Draft 2020-12-compatible structural schema. Unsupported legacy conversion
// is deliberately deferred to X3-30; this schema is NOT used to mutate data.
const string = { type: "string", minLength: 1 };
const secret = { type: "string", minLength: 1 };
const url = { type: "string", format: "http-url", minLength: 1 };
const object = (properties, required = []) => ({
  type: "object", additionalProperties: false, properties, required,
});

const CONFIG_SCHEMA_V2 = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/yhymid/XFeeder/schemas/config-v2",
  title: "XFeeder configuration v2",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "settings", "integrations", "channels"],
  properties: {
    schemaVersion: { const: 2 },
    settings: object({
      logs: { type: "boolean" },
      debugExpert: { type: "boolean" },
      maxConcurrentChannels: { type: "integer", minimum: 1, maximum: 8 },
    }),
    integrations: object({
      discord: object({
        token: secret,
        cookie: secret,
        superProperties: secret,
      }),
      telegram: object({
        enabled: { type: "boolean" },
        botToken: secret,
        chatId: string,
        timeoutMs: { type: "integer", minimum: 1, maximum: 2147000000 },
      }),
      proxy: object({
        enabled: { type: "boolean" },
        url,
      }),
      scrapling: object({
        enabled: { type: "boolean" },
        autoFallback: { type: "boolean" },
      }),
    }),
    channels: {
      type: "object",
      propertyNames: { pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$" },
      additionalProperties: { $ref: "#/$defs/channel" },
    },
  },
  $defs: {
    channel: object({
      id: string,
      enabled: { type: "boolean" },
      timeChecker: { type: "integer", minimum: 1 },
      requestSend: { type: "integer", minimum: 1 },
      sources: { type: "array", minItems: 1, items: { oneOf: [
        { $ref: "#/$defs/feedSource" }, { $ref: "#/$defs/discordSource" },
      ] } },
      destinations: { type: "array", minItems: 1, items: { oneOf: [
        { $ref: "#/$defs/webhookDestination" }, { $ref: "#/$defs/telegramDestination" },
      ] } },
    }, ["sources", "destinations"]),
    feedSource: object({ type: { const: "feed" }, url }, ["type", "url"]),
    discordSource: object({
      type: { const: "discord" },
      channelIds: { type: "array", minItems: 1, items: string },
      token: secret,
      guildId: string,
      cookie: secret,
      superProperties: secret,
    }, ["type", "channelIds"]),
    webhookDestination: object({
      type: { const: "webhook" }, url, threadId: string,
    }, ["type", "url"]),
    telegramDestination: object({
      type: { const: "telegram" },
      botToken: secret, chatId: string,
      messageThreadId: { type: "integer", minimum: 1 },
      disableWebPagePreview: { type: "boolean" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 2147000000 },
    }, ["type", "chatId"]),
  },
});

module.exports = { CONFIG_SCHEMA_V2 };
