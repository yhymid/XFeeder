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

## Runtime compatibility: explicitly NOT migrated

X3-29 is **schema/validation only**. Current production configs without
`schemaVersion` or with `schemaVersion: 1` continue through the old
loader, env resolution, channel normalization and cache identity logic.
Their file contents are never rewritten.

A structurally valid v2 draft can be checked by the validator and dashboard,
but **cannot yet be started by the worker**. The loader fails closed with
`CONFIG_MIGRATION_REQUIRED`. The dashboard similarly rejects saving a valid
v2 draft as the active worker configuration (HTTP 409). Invalid drafts
produce path-aware validation errors. Unsupported versions fail explicitly.
This avoids silently starting a worker with zero channels under the new
lowercase keys.

X3-30 will implement the explicit `read -> migrate -> validate ->
resolve secrets -> runtime normalize` pipeline, a deterministic
`migrateConfig` API, preview-only CLI command, and fixtures. It should
retain legacy secrets, IDs and cache-key identities and must not change
old configuration files without explicit opt-in. X3-31 will review secrets
exposure through the dashboard independently.

## Regression

`tests/config-schema-v2.test.js` checks valid drafts, detailed paths,
unknown fields, required values, strict types and versions, safe errors,
legacy loader behavior, CLI fail-closed behavior and dashboard save refusal.
Full Node 22/24/26 CI and Scrapling browser smoke remain release gates.

Reference:
- https://json-schema.org/draft/2020-12/json-schema-validation
- https://ajv.js.org/
