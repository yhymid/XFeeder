# X3-29 — Config Schema v2 (structural validation only)

## Scope and version boundary

X3-29 introduces a versioned, Draft 2020-12-compatible JSON Schema object
at `src/core/config-schema-v2.js` and a bounded validator in
`src/core/config-schema.js`. No dependency was added: the validator
implements only the schema keywords used by this contract, **not a
general-purpose JSON Schema engine**. The shape is designed to allow
Ajv or other conforming validators in the future after a separate review.

The v2 draft separates three top-level concerns:

```json
{
  "schemaVersion": 2,
  "settings": { "maxConcurrentChannels": 2 },
  "integrations": { "discord": { "token": "${DISCORD_TOKEN}" } },
  "channels": {
    "news": {
      "sources": [{ "type": "feed", "url": "https://example.org/feed.xml" }],
      "destinations": [{ "type": "webhook", "url": "${DISCORD_WEBHOOK}" }]
    }
  }
}
```

Allowed source types are `feed` (RSS/Atom/JSON parsing remains automatic)
and `discord` (channel IDs). Destination types are `webhook` and
`telegram`. Additional fields are rejected rather than silently lost.
Identifiers have constrained lengths and shapes; source/destination arrays
may not be empty for configured channels.

HTTP URLs may be direct HTTP(S) URLs without userinfo or a single full
`${ENV_VAR}` placeholder. Placeholders are accepted **without
resolving or logging secrets** during structural validation.
The existing runtime URL/SSRF policy remains a separate security boundary.
Arbitrary secrets still belong in the environment, not inline in JSON.

## Standard errors

`validateConfigSchema(config)` returns an immutable-shape response
`{ok, schemaVersion, errors}`. Errors use only:

```json
{
  "path": "channels.news.sources[1].url",
  "code": "invalid_url",
  "message": "Expected an http or https URL"
}
```

No supplied URL, token, header or other input value is reflected in these
messages. Errors are capped at 50 and validation depth at 48 to prevent
unbounded work from malicious/malformed input.

The CLI loader and dashboard validator share this same schema evaluator.
`POST /api/validate` returns existing human-readable `errors` alongside
new structured `issues` for v2. Legacy users still receive the original
warnings/errors from the channel and network validators. The supported
JSON Schema subset includes objects, strict properties, required keys,
arrays, typed scalars, integer bounds, `const`, reference-backed
discriminated source/destination options, and a custom HTTP(S) URL format.

## Runtime compatibility after X3-30

Legacy configs without schemaVersion or with version 1 still use their
original loader and cache identifiers. Existing legacy config files are
never rewritten by startup.

The X3-30 migrator now provides a restricted v1-to-v2 converter with an
explicit preview-only CLI:

    npm run config:migrate
    npm run config:migrate -- --write

The second command creates a separate sibling v2 config file without
overwriting its source. Use --write --in-place only with the automatic
.legacy.bak backup. A migrated channel always retains its historical
delivery cache key through the v2 id field and the runtime CacheKey.

The worker accepts a validated v2 document only when all fields have
a safe mapping back to the existing runtime. Advanced legacy sections
not represented in v2 (for example Network Usage Control or advanced
Scrapling configuration) cause CONFIG_MIGRATION_UNSAFE instead of being
silently dropped. Invalid versions or malformed v2 fail closed.

The dashboard validates v2 with the same converter but its legacy
editor still refuses to write active v2 configs with HTTP 409 and
CONFIG_EDITOR_V2_UNSUPPORTED, pending the X3-32 editor/API migration.
See docs/config-migration.md for exact supported fields, CLI usage,
backup behavior, and rollout constraints. X3-31 reviews secret exposure
independently.

## Regression

`tests/config-schema-v2.test.js` checks valid drafts, detailed paths,
unknown fields, required values, strict types and versions, safe errors,
legacy loader behavior, CLI fail-closed behavior and dashboard save refusal.
Full Node 22/24/26 CI and Scrapling browser smoke remain release gates.

Reference:
- https://json-schema.org/draft/2020-12/json-schema-validation
- https://ajv.js.org/
