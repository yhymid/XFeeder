"use strict";

const { hasMatrixDeliveryTarget } = require("../matrix");
const { SEND_DELAY_MS, getCacheKey, pushCache, sleep } = require("../core/normalize");
const { getChannelLabel } = require("../core/channel-config");

function hasWebhookTarget(webhookUrl) {
  return typeof webhookUrl === "string" && webhookUrl.trim().length > 0;
}

function resolveFeedTargets(channelConfig) {
  return {
    webhookUrl: channelConfig.Webhook,
    threadId: channelConfig.Thread,
    matrixConfig: channelConfig.Matrix,
  };
}

function resolveDiscordTargets(channelConfig) {
  return {
    webhookUrl: channelConfig.Discord?.Webhook || channelConfig.Webhook,
    threadId: channelConfig.Discord?.Thread ?? channelConfig.Thread,
    matrixConfig: channelConfig.Matrix,
  };
}

function getTargetDescriptors(targetConfig = {}) {
  const targets = [];

  if (hasWebhookTarget(targetConfig.webhookUrl)) {
    targets.push({ kind: "webhook" });
  }

  if (hasMatrixDeliveryTarget(targetConfig.matrixConfig)) {
    targets.push({ kind: "matrix" });
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
    channelCache[bucketName] = pushCache(channelCache[bucketName], ids);
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
  sendMessage,
  sendMatrixMessage,
  dryRun,
} = {}) {
  const entryLabel = entry?.title || entry?.link || entry?.guid || "unknown";

  if (dryRun) {
    console.log(`[Dry Run] ${channelLabel}: ${contextLabel} -> ${target.kind}: ${entryLabel}`);
    return true;
  }

  if (target.kind === "webhook") {
    try {
      await sendMessage(targetConfig.webhookUrl, targetConfig.threadId, entry);
      return true;
    } catch (err) {
      console.error(
        `[Channel ${index + 1}] ${channelLabel} send failed (${contextLabel} -> webhook): ${entryLabel}: ${err.message}`
      );
      return false;
    }
  }

  if (target.kind === "matrix") {
    try {
      await sendMatrixMessage(targetConfig.matrixConfig, entry);
      return true;
    } catch (err) {
      console.error(
        `[Channel ${index + 1}] ${channelLabel} send failed (${contextLabel} -> matrix): ${entryLabel}: ${err.message}`
      );
      return false;
    }
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
  sendMatrixMessage,
  dryRun = false,
} = {}) {
  async function checkFeedsForChannel(index, channelConfig) {
    const cache = cacheStore.getState();
    const channelLabel = getChannelLabel(channelConfig);
    const channelCache = cacheStore.getChannelBucket(channelConfig.cacheKey || index);

    if (channelConfig.Discord) {
      try {
        const discordMsgs = await parseDiscord(channelConfig.Discord);
        const targetConfig = resolveDiscordTargets(channelConfig);
        const sourceBucket = "discord";

        if (!hasAnyTarget(targetConfig)) {
          console.warn(`[Channel ${index + 1}] ${channelLabel}: Discord source has no delivery target configured.`);
          return cache;
        }

        const pendingDiscordMsgs = collectPendingEntries(
          channelCache,
          sourceBucket,
          discordMsgs,
          targetConfig,
          (entry) => getCacheKey(entry) || entry?.guid || ""
        );

        if (pendingDiscordMsgs.length > 0) {
          const toSend = pendingDiscordMsgs.slice(0, channelConfig.RequestSend || 5);
          const successfulByBucket = {};

          for (const entry of toSend.reverse()) {
            const entryKey = getCacheKey(entry) || entry?.guid || "";
            const pendingTargets = getPendingTargets(channelCache, sourceBucket, entryKey, targetConfig);

            for (const target of pendingTargets) {
              try {
                const delivered = await deliverToTarget({
                  index,
                  channelLabel,
                  contextLabel: "Discord source",
                  target,
                  targetConfig,
                  entry,
                  sendMessage,
                  sendMatrixMessage,
                  dryRun,
                });

                if (delivered && entryKey) {
                  const bucketName = getTargetBucketName(sourceBucket, target.kind);
                  if (!Array.isArray(successfulByBucket[bucketName])) {
                    successfulByBucket[bucketName] = [];
                  }
                  successfulByBucket[bucketName].push(entryKey);
                }
              } finally {
                await sleep(SEND_DELAY_MS);
              }
            }
          }

          const changed = applySuccessfulDeliveries(channelCache, successfulByBucket);
          if (changed && !dryRun) {
            cacheStore.save();
          }

          const { completed, partial } = summarizeEntryCompletion(
            channelCache,
            sourceBucket,
            targetConfig,
            toSend,
            (entry) => getCacheKey(entry) || entry?.guid || ""
          );
          console.log(
            `[Channel ${index + 1}] ${channelLabel}: Discord source completed ${completed}/${toSend.length} entries. Partial: ${partial}.`
          );
        }
      } catch (err) {
        console.error(`[Channel ${index + 1}] ${channelLabel} Discord Error: ${err.message}`);
      }
    }

    if (channelConfig.RSS && Array.isArray(channelConfig.RSS)) {
      for (const feedUrl of channelConfig.RSS) {
        try {
          const items = await fetchFeed(feedUrl);
          if (!items.length) continue;

          const targetConfig = resolveFeedTargets(channelConfig);
          if (!hasAnyTarget(targetConfig)) {
            console.warn(`[Channel ${index + 1}] ${channelLabel}: Feed ${feedUrl} has no delivery target configured.`);
            continue;
          }

          const pendingItems = collectPendingEntries(
            channelCache,
            feedUrl,
            items,
            targetConfig,
            (entry) => getCacheKey(entry)
          );

          if (pendingItems.length > 0) {
            const toSend = pendingItems.slice(0, channelConfig.RequestSend || 5);
            const successfulByBucket = {};

            for (const entry of toSend.reverse()) {
              const entryKey = getCacheKey(entry);
              const pendingTargets = getPendingTargets(channelCache, feedUrl, entryKey, targetConfig);

              for (const target of pendingTargets) {
                try {
                  const delivered = await deliverToTarget({
                    index,
                    channelLabel,
                    contextLabel: feedUrl,
                    target,
                    targetConfig,
                    entry,
                    sendMessage,
                    sendMatrixMessage,
                    dryRun,
                  });

                  if (delivered && entryKey) {
                    const bucketName = getTargetBucketName(feedUrl, target.kind);
                    if (!Array.isArray(successfulByBucket[bucketName])) {
                      successfulByBucket[bucketName] = [];
                    }
                    successfulByBucket[bucketName].push(entryKey);
                  }
                } finally {
                  await sleep(SEND_DELAY_MS);
                }
              }
            }

            const changed = applySuccessfulDeliveries(channelCache, successfulByBucket);
            if (changed && !dryRun) {
              cacheStore.save();
            }

            const { completed, partial } = summarizeEntryCompletion(
              channelCache,
              feedUrl,
              targetConfig,
              toSend,
              (entry) => getCacheKey(entry)
            );
            console.log(
              `[Channel ${index + 1}] ${channelLabel}: ${feedUrl} completed ${completed}/${toSend.length} entries. Partial: ${partial}.`
            );
          }
        } catch (err) {
          console.error(`[Channel ${index + 1}] ${channelLabel} RSS Error ${feedUrl}: ${err.message}`);
        }
      }
    }

    return cache;
  }

  return {
    checkFeedsForChannel,
  };
}

module.exports = {
  createChannelRunner,
};
