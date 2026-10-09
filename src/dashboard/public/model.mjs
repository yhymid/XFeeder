// Shared, pure configuration helpers: browser UI and Node compatibility tests.
export const FEED_KEYS = ["RSS", "Feeds", "URLs", "Sources"];
const RESERVED = new Set([
  "network",
  "Settings",
  "Auth",
  "Proxy",
  "Scrapling",
  "ChannelDefaults",
  "DefaultChannel",
  "Telegram",
]);
const HINTS = new Set([
  ...FEED_KEYS,
  "Webhook",
  "Thread",
  "Discord",
  "Telegram",
  "TimeChecker",
  "RequestSend",
  "ID",
  "Key",
  "CacheKey",
]);
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const toData = (value) =>
  isObject(value)
    ? clone(value)
    : { Feeds: typeof value === "string" ? [value] : clone(value || []) };
const looksLikeChannel = (value) =>
  (typeof value === "string" && /^https?:\/\//i.test(value)) ||
  (Array.isArray(value)
    ? value.every((v) => typeof v === "string" && /^https?:\/\//i.test(v))
    : isObject(value) && Object.keys(value).some((k) => HINTS.has(k)));
export function groups(config) {
  return Object.entries(config).filter(
    ([k, v]) =>
      !RESERVED.has(k) &&
      (Array.isArray(v) || isObject(v)) &&
      (Object.keys(v).length
        ? Object.values(v).every(looksLikeChannel)
        : /^channels/i.test(k)),
  );
}
export function feeds(data) {
  return [
    ...new Set(
      FEED_KEYS.flatMap((key) =>
        (Array.isArray(data[key]) ? data[key] : [data[key]])
          .filter((v) => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ),
  ];
}
export function effective(config, raw) {
  const defaults = config.ChannelDefaults || config.DefaultChannel || {};
  const data = toData(raw),
    merged = { ...defaults, ...data };
  for (const key of ["Discord", "Telegram"])
    if (defaults[key] || data[key])
      merged[key] = { ...defaults[key], ...data[key] };
  const telegram = merged.Telegram;
  if (config.Telegram || telegram) {
    merged.Telegram = { ...config.Telegram, ...telegram };
    for (const k of ["BotToken", "ChatID"])
      if (typeof telegram?.[k] === "string" && !telegram[k].trim())
        merged.Telegram[k] = config.Telegram?.[k] || "";
  }
  return merged;
}
export const hasTelegram = (t) =>
  Boolean(
    t &&
      t.Enabled !== false &&
      String(t.BotToken || "").trim() &&
      String(t.ChatID || "").trim(),
  );
export function channels(config) {
  let globalIndex = 0;
  return groups(config).flatMap(([group, value]) =>
    Object.entries(value).map(([key, raw], index) => {
      const data = effective(config, raw),
        objectGroup = !Array.isArray(value);
      const channel = {
        id: JSON.stringify([group, key]),
        group,
        key,
        index,
        raw,
        data,
        objectGroup,
        name: objectGroup ? key : `${group} #${index + 1}`,
        label: objectGroup ? key : `${group}#${globalIndex + 1}`,
        feeds: feeds(data),
        interval: Number(data.TimeChecker) || 30,
        targets: [
          data.Webhook || data.Discord?.Webhook ? "Discord" : "",
          hasTelegram(data.Telegram) ? "Telegram" : "",
        ].filter(Boolean),
      };
      globalIndex++;
      return channel;
    }),
  );
}
export function uniqueName(value, base) {
  let name = base,
    i = 2;
  while (Object.hasOwn(value, name)) name = `${base} ${i++}`;
  return name;
}
export function putChannel(
  config,
  channel,
  value,
  { group = channel?.group, name = channel?.key, mode = "array" } = {},
) {
  if (
    !group?.trim() ||
    RESERVED.has(group) ||
    ["__proto__", "constructor", "prototype"].includes(group)
  )
    throw new Error("Choose a valid, non-reserved group name.");
  if (
    Object.hasOwn(config, group) &&
    !groups(config).some(([k]) => k === group) &&
    !(channel?.group === group)
  )
    throw new Error(
      "This name is already used by another configuration field.",
    );
  const target = config[group] ?? (mode === "object" ? {} : []);
  if (
    !Array.isArray(target) &&
    (!name?.trim() || ["__proto__", "constructor", "prototype"].includes(name))
  )
    throw new Error("Enter a valid channel name.");
  if (
    !Array.isArray(target) &&
    Object.hasOwn(target, name) &&
    !(channel?.group === group && channel?.key === name)
  )
    throw new Error("A channel with this name already exists.");
  if (
    channel &&
    group === channel.group &&
    (Array.isArray(target) || name === channel.key)
  ) {
    target[channel.key] = clone(value);
    return JSON.stringify([group, channel.key]);
  }
  if (channel) removeChannel(config, channel);
  config[group] = target;
  const key = Array.isArray(target) ? String(target.length) : name;
  target[key] = clone(value);
  return JSON.stringify([group, key]);
}
export function removeChannel(config, channel) {
  const target = config[channel.group];
  if (Array.isArray(target)) target.splice(Number(channel.key), 1);
  else delete target[channel.key];
  // Nonstandard empty groups cannot be distinguished from unrelated root metadata by the worker.
  if (!Object.keys(target).length && !/^channels/i.test(channel.group))
    delete config[channel.group];
}
export function duplicateChannel(config, channel) {
  const copy = toData(channel.raw);
  for (const key of ["ID", "Key", "CacheKey"]) {
    if (typeof copy[key] === "string" && copy[key]) {
      const used = new Set(
        channels(config)
          .flatMap((c) => [c.data.ID, c.data.Key, c.data.CacheKey])
          .filter(Boolean),
      );
      let id = `${copy[key]}-copy`,
        i = 2;
      while (used.has(id)) id = `${copy[key]}-copy-${i++}`;
      copy[key] = id;
    }
  }
  return putChannel(config, null, copy, {
    group: channel.group,
    name: uniqueName(config[channel.group], `${channel.name} copy`),
  });
}
export function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname
      .replace(/(\/webhooks\/)[^/]+\/[^/]+/i, "$1[REDACTED]")
      .replace(/\/bot[^/]+/i, "/bot[REDACTED]");
    return url.toString();
  } catch {
    return value?.startsWith("${") ? value : "Source URL";
  }
}
export function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Source";
  }
}
export function sourceType(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return "YouTube";
  if (/discord\.com/.test(url)) return "Discord";
  if (/atom/i.test(url)) return "Atom";
  if (/\.json|\/api\//i.test(url)) return "JSON";
  if (/rss|feed|\.xml/i.test(url)) return "RSS";
  return "Web";
}
export function channelStatus(channel, activity, warnings = []) {
  if (warnings.some((w) => w.startsWith(`[Config] ${channel.label}:`)))
    return "warning";
  const record = activity?.channels?.[channel.label];
  if (
    !record?.lastCheck ||
    Date.now() - Date.parse(record.lastCheck) >
      Math.max(180000, channel.interval * 120000)
  )
    return "unknown";
  return record.status;
}
