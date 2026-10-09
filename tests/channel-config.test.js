const assert = require("node:assert/strict");
const test = require("node:test");
const { collectConfiguredChannels, validateChannels } = require("../src/core/channel-config");
test("channel configuration inherits global auth and Telegram defaults", () => {
  const [channel] = collectConfiguredChannels({
    Auth: { Token:"source-token", "x-super-properties":"fixture", cookie:"cookie" },
    Telegram: {Enabled:true,BotToken:"bot-token",ChatID:"global-chat"},
    channels: {feed:{Feeds:["https://example.com/feed"],Discord:{ChannelIDs:["123"]},Telegram:{ChatID:"local-chat"}}},
  });
  assert.equal(channel.Discord.Token,"source-token");
  assert.equal(channel.Telegram.BotToken,"bot-token");
  assert.equal(channel.Telegram.ChatID,"local-chat");
  assert.equal(validateChannels([channel]).length,0);
});
test("incomplete Telegram destination produces a configuration warning", () => {
  const channels = collectConfiguredChannels({Telegram:{Enabled:true},channels:{feed:{Feeds:["https://example.com/feed"]}}});
  assert.ok(validateChannels(channels).some(message=>message.includes("BotToken or ChatID is missing")));
});

test("unsupported integration objects are reported without being executed as channels", async () => {
  const {unsupportedConfigSections}=require("../src/core/channel-config");
  const config={RetiredDestination:{Endpoint:"https://example.test",Token:"fixture"},channels:[{Feeds:["https://example.test/feed"],RemovedDestination:{Enabled:true,Token:"fixture"}}]};
  assert.equal(collectConfiguredChannels(config).length,1);
  const warnings=unsupportedConfigSections(config);
  assert.ok(warnings.some(message=>message.includes('"RetiredDestination"')));
  assert.ok(warnings.some(message=>message.includes('.RemovedDestination"')));
  assert.ok(warnings.every(message=>message.includes('Discord, Telegram')));
  const model=await import("../src/dashboard/public/model.mjs");
  assert.equal(model.channels(config).length,1);
});
