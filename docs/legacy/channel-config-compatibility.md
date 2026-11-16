# Channel configuration compatibility — X3-04

This records the existing 2.2.0 configuration behavior on `3.0-dev` before
schema validation and migration. X3-04 adds tests, a synthetic fixture and this
document. Production modules, dependencies, the package version and the Node
minimum are unchanged.

## Behavior protected by tests

| Input or setting | Current result |
| --- | --- |
| Missing channel options | `TimeChecker: 30` minutes, `RequestSend: 5`, empty `Webhook`, null `Thread`, `Discord` and `Telegram` |
| `ChannelDefaults` / `DefaultChannel` | Prefer `ChannelDefaults`, including an empty object; otherwise use `DefaultChannel` |
| Local channel options | Override scalar defaults; shallow-merge nested Discord and Telegram options |
| Root `Auth` | Supplies Discord source credentials; local Discord fields override them |
| Root `Telegram` | Supplies delivery settings; channel/default Telegram fields override them |
| Empty local Telegram token or chat string | Fall back to root Telegram values |
| `channels`, `channels2`, nonempty custom groups | Accept arrays or named objects; preserve group/entry order and assign a global index |
| String / URL-array shorthand | Inherit channel defaults and populate `Feeds` |
| Reserved root sections | Never become channel groups, even when their shape resembles one |
| `RSS`, `Feeds`, `URLs`, `Sources` | Merge in that order, trim strings, discard blanks/non-strings and deduplicate exact URLs |
| Feed aliases in defaults | Local value replaces the same alias; other default aliases still contribute |
| Webhook only / Telegram only / both | Recognized independently; normalized settings reach the matching injected send function |
| `Telegram.Enabled: false` | Disable Telegram, retaining any webhook; feed-only channels with no webhook still fetch but do not deliver or update delivery cache |
| Missing feed URL | Warn unless a Discord source is configured; incomplete Discord sources warn about missing IDs/token |
| Interval / send limit | Convert with `Number`, floor positive values, use defaults for nonpositive/nonfinite values |
| Threads | Top-level null/empty/`"null"` become null, other values become strings; Telegram threads require positive safe integers |
| Telegram timeout | Positive numeric values floor to at least 1 ms; invalid/nonpositive values use 15000 ms |
| Explicit cache identity | `CacheKey`, then `Key`, then `ID`; duplicate keys generate a warning |
| Named channel identity | Group plus channel name |
| Anonymous channel identity | Stable across channel reordering and changes to token, interval or send limit |
| `Scrapling.PerUrlConfig` | Remains a separate root section, selected by exact URL; does not create channel entries |

The tests freeze representative input to check collection and validation do not
mutate it. They do not promise deep copies of every unknown option.

`RequestSend` limits **pending entries per source**, after checking delivery
state. Each feed and the Discord source gets its own limit. The first N pending
entries are selected, then dispatched in reverse selection order, only to their
still-pending destinations. This is not a channel-wide send count.
The runner tests use in-memory fetch/send/cache functions and replace only the
captured sleep dependency, restoring module exports/cache immediately. They make
no real provider requests and do not wait for delivery delays.

## Known limitations retained for migration

- One malformed entry excludes the entire group, including valid siblings.
  `validateChannels()` sees only collected channels, so it cannot diagnose those
  skipped entries. This task does not introduce schema rejection or recovery.
- Shorthand URL recognition requires an HTTP(S) prefix before trimming. Feed
  strings inside channel objects are only trimmed, without URL validation.
- Per-feed objects such as `{ "url": "...", "RequestSend": 1 }` are discarded.
  Existing per-URL Scrapling options remain supported separately; their resource
  policy precedence also has coverage in `tests/scrapling-resources.test.js`.
- A channel's `Enabled` field and `Discord.Enabled` do not disable processing.
  `Telegram: false`, null, or `Enabled: "false"` does not disable inherited
  Telegram settings; only boolean `Telegram.Enabled: false` does.
- Numeric booleans are coerced; a positive fraction below 1 normalizes to 0.
  The runner and scheduler subsequently apply their `|| 5` / `|| 30` fallbacks.
- Discord `ChannelIDs` discard non-string IDs but do not deduplicate strings.
  A blank local Discord token overrides a valid root token and triggers a warning.
- Source inspection also shows that the validator checks the top-level `Webhook`
  while the runner accepts `Discord.Webhook` for Discord-source delivery. A null
  `Discord.Thread` falls back to the channel thread in that path. These mismatches
  are recorded here, not corrected or given a new compatibility guarantee.

These observations describe the custom loader rather than a new schema. Research
references: [JSON data model](https://www.json.org/json-en.html),
[Node strict assertions](https://nodejs.org/api/assert.html), and
[JSON Schema overview](https://json-schema.org/overview/what-is-jsonschema).
No JSON Schema dependency is added in X3-04.

## Validation — 2026-10-11

- 32 new tests: 27 configuration cases and 5 runner option cases.
- Targeted configuration tests: 35 passed, 0 failed, 0 skipped on Node 20.18.1
  (32 new plus 3 existing). The same cases passed on Node 26.11.1.
- Full `npm test` on Node 26.11.1: 240 passed, 0 failed, 0 skipped.
- `node main.js --check-config --config tests/fixtures/config/channel-groups.json`:
  4 channels, zero warnings; no network requests.
- Syntax checks and `git diff --check`: passed.

Changed files: `tests/channel-config-compatibility.test.js`,
`tests/channel-options.test.js`, `tests/fixtures/config/channel-groups.json`, and
this document. All fixture credentials and endpoints are synthetic.

Deferred: feed parsing cases (X3-05), wider delivery regressions (X3-06), schema
validation (X3-29) and legacy migration (X3-30). None is implemented here.
