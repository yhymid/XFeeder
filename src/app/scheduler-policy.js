"use strict";

// The queue uses stable channel keys for its *cursor*, not just array offsets.
// This matters after a config reload reorders channels between two rotations.
// Scheduler backoff/delivery state remain keyed by the same legacy cache key.
function queueKey(channel, index) {
  return String(channel?.cacheKey || index);
}

function nextChannelIndex(channels, expectedKey, fallbackIndex = 0) {
  if (!channels.length) return 0;
  if (expectedKey !== null && expectedKey !== undefined) {
    // Duplicate cache keys are a configuration warning, but must not
    // trap the cursor on their first occurrence forever. Preserve the
    // intended offset if it still points at the expected identity.
    const bounded = (fallbackIndex % channels.length + channels.length) % channels.length;
    if (queueKey(channels[bounded], bounded) === expectedKey) return bounded;
    const index = channels.findIndex((channel, position) =>
      queueKey(channel, position) === expectedKey);
    if (index !== -1) return index;
  }
  return (fallbackIndex % channels.length + channels.length) % channels.length;
}

function validateQueueDelay(delayMs) {
  // Never allow a bad programmatic option to create a hot setTimeout(0) loop.
  // This is an application scheduling delay, not an HTTP retry duration.
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 2147000000)
    throw new RangeError("delayBetweenChannels must be an integer from 1 to 2147000000 milliseconds");
  return delayMs;
}

module.exports = { queueKey, nextChannelIndex, validateQueueDelay };
