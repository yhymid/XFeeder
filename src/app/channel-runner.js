"use strict";

const { SEND_DELAY_MS, pushCache } = require("../core/normalize");
const { normalizeEntries } = require("../core/normalized-entry");
const { createDestinationAdapters } = require("../core/destination-adapters");
const { getChannelLabel, hasTelegramDeliveryTarget } = require("../core/channel-config");
const { context } = require("../network/context");
const { isCancelled, throwIfAborted, sleep: abortableSleep } = require("../network/abort");
const { expert, sanitizeText, sanitizeUrl } = require("../core/diagnostics");

function hasWebhookTarget(webhookUrl) {
  return typeof webhookUrl === "string" && webhookUrl.trim().length > 0;
}

function resolveFeedTargets(channelConfig) {
  return {
    webhookUrl: channelConfig.Webhook,
    threadId: channelConfig.Thread,
    telegramConfig: channelConfig.Telegram,
  };
}

function resolveDiscordTargets(channelConfig) {
  return {
    webhookUrl: channelConfig.Discord?.Webhook || channelConfig.Webhook,
    threadId: channelConfig.Discord?.Thread ?? channelConfig.Thread,
    telegramConfig: channelConfig.Telegram,
  };
}

function getTargetDescriptors(targetConfig = {}) {
  const targets = [];

  if (hasWebhookTarget(targetConfig.webhookUrl)) {
    targets.push({ kind: "webhook" });
  }

  if (hasTelegramDeliveryTarget(targetConfig.telegramConfig)) {
    targets.push({ kind: "telegram" });
  }


  return targets;
}

function hasAnyTarget(targetConfig = {}) {
  return getTargetDescriptors(targetConfig).length > 0;
}

function getTargetBucketName(sourceBucket, targetKind) {
  return `${sourceBucket}::${targetKind}`;
}

function ensureBucket(channelCache, bucketName) {
  if (!Array.isArray(channelCache[bucketName])) {
    channelCache[bucketName] = [];
  }
  return channelCache[bucketName];
}

function migrateLegacyBucket(channelCache, sourceBucket, targets) {
  const legacyBucket = Array.isArray(channelCache[sourceBucket]) ? channelCache[sourceBucket] : null;
  if (!legacyBucket || legacyBucket.length === 0) return;

  for (const target of targets) {
    const bucketName = getTargetBucketName(sourceBucket, target.kind);
    if (!Array.isArray(channelCache[bucketName]) || channelCache[bucketName].length === 0) {
      channelCache[bucketName] = pushCache([], legacyBucket);
    }
  }
}

function getPendingTargets(channelCache, sourceBucket, entryKey, targetConfig) {
  const targets = getTargetDescriptors(targetConfig);
  migrateLegacyBucket(channelCache, sourceBucket, targets);
  return targets.filter((target) => {
    const bucketName = getTargetBucketName(sourceBucket, target.kind);
    const bucket = ensureBucket(channelCache, bucketName);
    return !entryKey || !bucket.includes(entryKey);
  });
}

function applySuccessfulDeliveries(channelCache, updates = {}) {
  let changed = false;

  for (const [bucketName, ids] of Object.entries(updates)) {
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const existing = Array.isArray(channelCache[bucketName]) ? channelCache[bucketName] : [];
    const fresh = [...new Set(ids)].filter(id => !existing.includes(id));
    if (!fresh.length) continue;
    channelCache[bucketName] = pushCache(existing, fresh);
    changed = true;
  }

  return changed;
}

async function deliverToTarget({
  index,
  channelLabel,
  contextLabel,
  target,
  targetConfig,
  entry,
  destinationAdapters,
  dryRun,
} = {}) {
  throwIfAborted(context().signal);
  const entryLabel = entry?.title || entry?.link || entry?.guid || "unknown";
  const startedAt = Date.now();
  expert("delivery.begin", {
    channel: channelLabel,
    source: contextLabel,
    target: target.kind,
    dryRun,
    entry: { title: entry?.title || null, link: entry?.link || null, guid: entry?.guid || null },
  });

  if (dryRun) {
    console.log(`[Dry Run] ${channelLabel}: ${sanitizeUrl(contextLabel)} -> ${target.kind}: ${sanitizeText(entryLabel)}`);
    expert("delivery.simulated", { channel: channelLabel, target: target.kind, durationMs: Date.now() - startedAt });
    return true;
  }

  const adapter = destinationAdapters[target.kind];
  if (!adapter) return false;

  try {
    await adapter.send(targetConfig, entry);
    expert("delivery.complete", { channel: channelLabel, target: target.kind, durationMs: Date.now() - startedAt });
    return true;
  } catch (err) {
    if (err?.code === "CACHE_UNSAFE" || isCancelled(err) || context().signal?.aborted) throw err;
    context().onFailure?.(err);
    console.error(
      `[Channel ${index + 1}] ${channelLabel} send failed (${sanitizeUrl(contextLabel)} -> ${target.kind}): ${sanitizeText(entryLabel)}: ${sanitizeText(err.message)}`
    );
    expert("delivery.failed", { channel: channelLabel, target: target.kind, durationMs: Date.now() - startedAt, error: err });
    return false;
  }

  return false;
}

function collectPendingEntries(channelCache, sourceBucket, entries, targetConfig, getEntryKey) {
  return entries.filter((entry) => {
    const entryKey = getEntryKey(entry);
    const pendingTargets = getPendingTargets(channelCache, sourceBucket, entryKey, targetConfig);
    return pendingTargets.length > 0;
  });
}

function summarizeEntryCompletion(channelCache, sourceBucket, targetConfig, entries, getEntryKey) {
  let completed = 0;
  let partial = 0;

  for (const entry of entries) {
    const entryKey = getEntryKey(entry);
    if (!entryKey) continue;

    const pendingTargets = getPendingTargets(channelCache, sourceBucket, entryKey, targetConfig);
    const allTargets = getTargetDescriptors(targetConfig).length;

    if (pendingTargets.length === 0) {
      completed += 1;
    } else if (pendingTargets.length < allTargets) {
      partial += 1;
    }
  }

  return { completed, partial };
}

function createChannelRunner({
  cacheStore,
  fetchFeed,
  parseDiscord,
  sendMessage,
  sendTelegramMessage,
  dryRun = false,
} = {}) {
  const destinationAdapters = createDestinationAdapters({ sendMessage, sendTelegramMessage });

  async function checkFeedsForChannel(index, channelConfig) {
    throwIfAborted(context().signal);
    const startedAt = Date.now();
    const cache = cacheStore.getState();
    const channelLabel = getChannelLabel(channelConfig);
    // Do not create delivery state until there are entries to consider.
    let channelCache = cache[channelConfig.cacheKey || index];
    // Simulated successes and legacy bucket migration must not alter live state.
    if (dryRun) channelCache = structuredClone(channelCache || {});
    expert("channel.process.begin", {
      index: index + 1,
      channel: channelLabel,
      feedCount: Array.isArray(channelConfig.RSS) ? channelConfig.RSS.length : 0,
      hasDiscordSource: Boolean(channelConfig.Discord),
      targets: getTargetDescriptors(resolveFeedTargets(channelConfig)).map(({ kind }) => kind),
      dryRun,
    });

    if (channelConfig.Discord) {
      try {
        expert("discord.source.begin", { channel: channelLabel });
        const discordMsgs = normalizeEntries(await parseDiscord(channelConfig.Discord), { sourceType: "discord" });
        expert("discord.source.complete", { channel: channelLabel, itemCount: discordMsgs.length });
        const targetConfig = resolveDiscordTargets(channelConfig);
        const sourceBucket = "discord";

        if (!hasAnyTarget(targetConfig)) {
          console.warn(`[Channel ${index + 1}] ${channelLabel}: Discord source has no delivery target configured.`);
          expert("discord.source.skipped", { channel: channelLabel, reason: "no delivery target" });
          expert("channel.process.complete", { index: index + 1, channel: channelLabel, durationMs: Date.now() - startedAt });
          return cache;
        }

        if (discordMsgs.length) channelCache ||= cacheStore.getChannelBucket(channelConfig.cacheKey || index);
        const pendingDiscordMsgs = collectPendingEntries(
          channelCache,
          sourceBucket,
          discordMsgs,
          targetConfig,
          (entry) => entry.identity
        );
        expert("discord.source.pending", {
          channel: channelLabel,
          fetched: discordMsgs.length,
          pending: pendingDiscordMsgs.length,
          selected: Math.min(pendingDiscordMsgs.length, channelConfig.RequestSend || 5),
        });

        if (pendingDiscordMsgs.length > 0) {
          const toSend = pendingDiscordMsgs.slice(0, channelConfig.RequestSend || 5);
          const successfulByBucket = {};

          for (const entry of toSend.reverse()) {
            const entryKey = entry.identity;
            const pendingTargets = getPendingTargets(channelCache, sourceBucket, entryKey, targetConfig);

            for (const target of pendingTargets) {
              try {
                const delivered = await deliverToTarget({
                  index,
                  channelLabel,
                  contextLabel: "Discord source",
                  target,
                  targetConfig,
                  entry: entry.raw,
                  destinationAdapters,
                  dryRun,
                });

                if (delivered && entryKey) {
                  const bucketName = getTargetBucketName(sourceBucket, target.kind);
                  if (!Array.isArray(successfulByBucket[bucketName])) {
                    successfulByBucket[bucketName] = [];
                  }
                  successfulByBucket[bucketName].push(entryKey);
                  if (applySuccessfulDeliveries(channelCache, { [bucketName]: [entryKey] }) && !dryRun) await cacheStore.save();
                }
              } finally {
                if (!dryRun) await abortableSleep(SEND_DELAY_MS, context().signal);
              }
            }
          }

          const changed = applySuccessfulDeliveries(channelCache, successfulByBucket);
          if (changed && !dryRun) {
            await cacheStore.save();
          }

          const { completed, partial } = summarizeEntryCompletion(
            channelCache,
            sourceBucket,
            targetConfig,
            toSend,
            (entry) => entry.identity
          );
          console.log(
            `[Channel ${index + 1}] ${channelLabel}: Discord source completed ${completed}/${toSend.length} entries. Partial: ${partial}.`
          );
        }
      } catch (err) {
      if (err?.code === "CACHE_UNSAFE" || isCancelled(err) || context().signal?.aborted) throw err;
      context().onFailure?.(err);
        console.error(`[Channel ${index + 1}] ${channelLabel} Discord Error: ${sanitizeText(err.message)}`);
        expert("discord.source.failed", { channel: channelLabel, error: err });
      }
    }

    if (channelConfig.RSS && Array.isArray(channelConfig.RSS)) {
      for (const feedUrl of channelConfig.RSS) {
        throwIfAborted(context().signal);
        try {
          expert("channel.feed.begin", { index: index + 1, channel: channelLabel, url: feedUrl });
          const items = normalizeEntries(await fetchFeed(feedUrl));
          expert("channel.feed.fetched", { index: index + 1, channel: channelLabel, url: feedUrl, itemCount: items.length });
          if (!items.length) {
            expert("channel.feed.empty", { index: index + 1, channel: channelLabel, url: feedUrl });
            continue;
          }

          const targetConfig = resolveFeedTargets(channelConfig);
          if (!hasAnyTarget(targetConfig)) {
            console.warn(`[Channel ${index + 1}] ${channelLabel}: Feed ${sanitizeUrl(feedUrl)} has no delivery target configured.`);
            expert("channel.feed.skipped", { index: index + 1, channel: channelLabel, url: feedUrl, reason: "no delivery target" });
            continue;
          }

          channelCache ||= cacheStore.getChannelBucket(channelConfig.cacheKey || index);
          const pendingItems = collectPendingEntries(
            channelCache,
            feedUrl,
            items,
            targetConfig,
            (entry) => entry.identity
          );
          expert("channel.feed.pending", {
            index: index + 1,
            channel: channelLabel,
            url: feedUrl,
            fetched: items.length,
            pending: pendingItems.length,
            selected: Math.min(pendingItems.length, channelConfig.RequestSend || 5),
          });

          if (pendingItems.length > 0) {
            const toSend = pendingItems.slice(0, channelConfig.RequestSend || 5);
            const successfulByBucket = {};

            for (const entry of toSend.reverse()) {
              const entryKey = entry.identity;
              const pendingTargets = getPendingTargets(channelCache, feedUrl, entryKey, targetConfig);

              for (const target of pendingTargets) {
                try {
                  const delivered = await deliverToTarget({
                    index,
                    channelLabel,
                    contextLabel: feedUrl,
                    target,
                    targetConfig,
                    entry: entry.raw,
                    destinationAdapters,
                    dryRun,
                  });

                  if (delivered && entryKey) {
                    const bucketName = getTargetBucketName(feedUrl, target.kind);
                    if (!Array.isArray(successfulByBucket[bucketName])) {
                      successfulByBucket[bucketName] = [];
                    }
                    successfulByBucket[bucketName].push(entryKey);
                  if (applySuccessfulDeliveries(channelCache, { [bucketName]: [entryKey] }) && !dryRun) await cacheStore.save();
                  }
                } finally {
                  if (!dryRun) await abortableSleep(SEND_DELAY_MS, context().signal);
                }
              }
            }

            const changed = applySuccessfulDeliveries(channelCache, successfulByBucket);
            if (changed && !dryRun) {
              await cacheStore.save();
            }

            const { completed, partial } = summarizeEntryCompletion(
              channelCache,
              feedUrl,
              targetConfig,
              toSend,
              (entry) => entry.identity
            );
            console.log(
              `[Channel ${index + 1}] ${channelLabel}: ${sanitizeUrl(feedUrl)} completed ${completed}/${toSend.length} entries. Partial: ${partial}.`
            );
            expert("channel.feed.delivery_summary", {
              index: index + 1,
              channel: channelLabel,
              url: feedUrl,
              completed,
              selected: toSend.length,
              partial,
              dryRun,
            });
          }
        } catch (err) {
      if (err?.code === "CACHE_UNSAFE" || isCancelled(err) || context().signal?.aborted) throw err;
      context().onFailure?.(err);
          console.error(`[Channel ${index + 1}] ${channelLabel} RSS Error ${sanitizeUrl(feedUrl)}: ${sanitizeText(err.message)}`);
          expert("channel.feed.failed", { index: index + 1, channel: channelLabel, url: feedUrl, error: err });
        }
      }
    }

    expert("channel.process.complete", { index: index + 1, channel: channelLabel, durationMs: Date.now() - startedAt });
    return cache;
  }

  return {
    checkFeedsForChannel,
  };
}

module.exports = {
  createChannelRunner,
};
