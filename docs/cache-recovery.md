# Cache corruption and recovery — C3-05

Malformed/truncated JSON or a non-object cache root stops startup with
`CACHE_UNSAFE`. XFeeder does not replace it with an empty delivery history. The
original stays at its path; a byte-for-byte copy is exclusively created as
`<cache>.corrupt-<sha256>` with mode 0600. The stable hash prevents repeated
restarts from filling disk with identical quarantines. Failure to preserve or
verify quarantine also blocks startup; no cache overwrite is attempted.

An existing store whose reload fails refuses subsequent reads/mutations/saves
until a valid file is explicitly restored and loaded. A missing cache with a
matching quarantine in its directory is not treated as a fresh installation.
This prevents deleting the corrupt original from silently enabling mass resend.
A genuinely new installation with neither cache nor quarantine still starts
normally. Cache schema and successful delivery behavior remain unchanged.

To recover: stop the worker, preserve the original/quarantine, restore a verified
backup containing the delivery history, then restart. Do not replace it with `{}`
unless you explicitly intend to discard delivery history and accept resends.
Keep the quarantine until recovery is verified. It contains private runtime data,
is ignored by Git and rejected by the release packager, including custom cache
paths. The dashboard must not be used to infer that an unreadable cache is empty.

This guard is not a transactional StateStore or a multi-writer lock. It detects
corruption when loading/reloading; external edits after a successful load are
not continuously monitored. Existing atomic save behavior is retained. An
operator-supplied valid but incomplete backup cannot be identified automatically.
Tests cover repeated CLI startups failing before any source/delivery request.
