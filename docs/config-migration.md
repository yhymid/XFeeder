# X3-30 — Safe config migration to schema v2

## Commands

The migrator is preview-only by default:

    npm run config:migrate
    npm run config:migrate -- --config /path/to/config.json

It validates all supported fields without writing files or printing
credential values. To generate a separate file:

    npm run config:migrate -- --write

This creates a sibling config.json.v2.json, leaving the original intact.
Review it, then run:

    node main.js --config config.json.v2.json --check-config

To replace the original only with explicit confirmation:

    npm run config:migrate -- --write --in-place

An exclusive config.json.legacy.bak backup is written before replacement.
Existing backups and output files are never overwritten. The output uses
a private 0600 temporary file and an atomic rename.

## API and safety

migrateConfig(oldConfig) returns a deterministic v2 config (without
mutating the original) and is idempotent on existing v2 inputs.
toLegacyRuntime(v2) validates v2 and produces a semantically compatible
runtime configuration. Existing delivery cache identities survive via
channel.id mapped to runtime CacheKey.

The migration fails closed with CONFIG_MIGRATION_UNSAFE, including precise
field paths, if settings cannot be represented without data loss.

Supported subset:
- Settings: Logs, DebugExpert, MaxConcurrentChannels.
- Auth: Token, cookie, x-super-properties.
- Telegram: Enabled, BotToken, ChatID, TimeoutMs and per-channel thread
  and preview settings.
- Proxy: Enabled, Url.
- Scrapling: Enabled, AutoFallback.
- ChannelDefaults / DefaultChannel: TimeChecker and RequestSend.
- Channel groups: named or anonymous, feeds, one Discord source,
  one Discord webhook and one Telegram destination, interval, burst,
  explicit stable IDs and environment references.

Not supported by this migration: custom Network Usage Control profiles,
advanced Scrapling browser/anti-bot fields and unrelated integration
objects. Unsupported fields are reported rather than silently dropped.
Anonymous channels whose delivery key depends on environment substitution
must be converted to a named/explicit-key channel first. Duplicate cache
IDs are also refused.

V2 cannot currently disable a channel or send to multiple webhooks of one
type through the legacy runtime adapter; such v2 inputs are rejected.

## Dashboard and rollout

The worker can load validated supported v2 files. The existing dashboard
editor still uses legacy uppercase configuration keys, so it intentionally
refuses to save v2 with CONFIG_EDITOR_V2_UNSUPPORTED until X3-32.
The dashboard validation API does use the same runtime conversion checks
as the worker and returns structured issues.

The CLI never restarts the worker, rewrites cache.json/cache.feeds.json,
or changes release tags. Review and back up production data, use the preview,
then run --check-config before switching the service to a new v2 file.

Tests: tests/config-migration.test.js and tests/config-schema-v2.test.js.
