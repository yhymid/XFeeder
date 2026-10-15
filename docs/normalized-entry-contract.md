# X3-14 — NormalizedEntry and identity compatibility

## Design and research

XFeeder's existing v2.2 cache relies on a specific identity algorithm:
`src/core/normalize.js:getCacheKey` prefers a tracking-stripped URL in
`link`, then `guid`, then a stable hash of title/date/author/snippet.
This is **not** universally identical to source specifications: Atom defines
`atom:id` as a permanent entry identifier, and JSON Feed v1.1 defines
`item.id` as the unique identity within the feed.

Standards reviewed:
- https://www.rfc-editor.org/info/rfc4287/ (Atom `atom:id`).
- https://www.jsonfeed.org/version/1.1/ (JSON Feed `id`).

A standards-first change to identity precedence would treat old delivered
entries as new and could resend notifications. **X3-14 explicitly preserves
XFeeder's established precedence** until a separately reviewed migration with
deduplication-safe fixtures is approved. Source parsers continue to map their
own identifiers to legacy fields; there is no parser rewrite here.

## Internal domain envelope

`src/core/normalized-entry.js` provides `normalizeEntry(raw, options)`
and `normalizeEntries(rawArray, options)`. A NormalizedEntry has:
- `sourceType` (`feed` or `discord`), and `identity` derived by the
  existing `getCacheKey` function, including the Discord guid fallback.
- Common read-only descriptor fields: title, link, guid, contentSnippet,
  isoDate, author, enclosure, categories.
- `raw`: the **identical original source entry object**, passed unchanged
  to Discord and Telegram delivery. This protects attachments, reply content,
  `discordData`, custom fields and future source-specific payload extensions.

The envelope is shallowly frozen; its `raw` and arrays are not recursively
frozen. The envelope is **ephemeral**, used inside `channel-runner` for
pending selection, delivery-target state checks and completion summaries.
No NormalizedEntry descriptor is serialized into `cache.json` or feed
snapshots. Parser outputs, HTTP transport and channel config are unchanged.

## Critical invariants

1. Link > guid > content-hash legacy identity. Tracking removal and empty
   identity semantics are unchanged; do not introduce new prefixes, hashes
   or source identifiers in persisted keys.
2. No deduplication in the normalization step: preserve source ordering and
   duplicates for the existing delivery stage to filter against current
   destination state.
3. Destination state is scoped per channel, source bucket and delivery target.
   A successful webhook does not mark Telegram as delivered.
4. Successful deliveries update their target bucket and persist immediately.
   A failure or cancellation must not mark a target complete.
5. Existing `RequestSend`, reverse-order delivery and batch duplicate
   suppression remain unchanged.
6. Dry runs do not send, save delivery state or migrate live legacy buckets.
7. Original entry object reaches delivery adapters (identity never substitutes
   for the payload). Extra fields are not discarded.
8. Existing legacy source-only buckets remain readable and are migrated by the
   same channel-runner logic as before, without resending delivered items.
9. A keyless entry is not silently discarded or considered delivered.
10. 304 replay uses the unmodified cached feed entries, not serialized
    normalization descriptors.

## Regression evidence and limitations

- `tests/normalized-entry.test.js` covers link/GUID/hash parity, field
  preservation, duplicate ordering, keyless data and invalid entry types.
- `tests/delivery-state.test.js` verifies real delivery gets the original
  object and existing legacy cache keys remain effective for both Discord
  and feed sources. Earlier delivery-state tests protect partial success,
  per-destination retry, batch duplicates, RequestSend, cancellation and dry-run.

This is a compatibility-first foundation for later X3-15/X3-16 adapters.
It does not normalize malformed dates, HTML, enclosure shapes or category
objects, which may be source-specific. Changing identity precedence or
introducing cross-feed de-duplication is a separate, potentially
data-migrating decision, not part of X3-14.
