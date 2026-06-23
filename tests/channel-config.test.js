const assert = require("node:assert/strict");
const test = require("node:test");

const { collectConfiguredChannels, validateChannels } = require("../src/core/channel-config");

test("collectConfiguredChannels merges global Auth and Matrix into channels", () => {
  const config = {
    Auth: {
      Token: "global-token",
      "x-super-properties": "global-xsp",
      cookie: "global-cookie",
    },
    Matrix: {
      Enabled: true,
      Homeserver: "https://matrix.example.org",
      AccessToken: "matrix-token",
      RoomID: "!global:matrix.example.org",
      MsgType: "m.notice",
    },
    channels: {
      feed: {
        Webhook: "https://discord.com/api/webhooks/example",
        Feeds: ["https://example.com/feed.xml"],
        Discord: {
          ChannelIDs: ["123"],
        },
        Matrix: {
          RoomID: "!override:matrix.example.org",
        },
      },
    },
  };

  const [channel] = collectConfiguredChannels(config);
  assert.equal(channel.Discord.Token, "global-token");
  assert.equal(channel.Discord["x-super-properties"], "global-xsp");
  assert.equal(channel.Discord.cookie, "global-cookie");
  assert.equal(channel.Matrix.Homeserver, "https://matrix.example.org");
  assert.equal(channel.Matrix.RoomID, "!override:matrix.example.org");
  assert.ok(channel.cacheKey);
  assert.equal(validateChannels([channel]).length, 0);
});

test("validateChannels warns when Matrix is enabled but incomplete", () => {
  const config = {
    Matrix: {
      Enabled: true,
      Homeserver: "https://matrix.example.org",
    },
    channels: {
      feed: {
        Feeds: ["https://example.com/feed.xml"],
      },
    },
  };

  const [channel] = collectConfiguredChannels(config);
  const warnings = validateChannels([channel]);
  assert.ok(warnings.some((warning) => warning.includes("Matrix is enabled but Homeserver, AccessToken or RoomID is missing")));
  assert.ok(warnings.some((warning) => warning.includes("missing delivery target")));
});
