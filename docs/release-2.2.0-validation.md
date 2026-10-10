# XFeeder 2.2.0 — release validation

Date: 2026-10-09. Git base: `2053e8efdd9cb30650b619e70cb9ef7a4f197ec5`
on `main` of `https://github.com/yhymid/XFeeder`. Source was imported from the
current developed 2.2.0 workspace; Git history alone did not define the feature set.
No 3.0 branch, refactor or task was started. Publication is a separate owner action.

Follow-up: [2026-10-10 security/hygiene audit](security-audit-2.2.0.md) adds the
explicit non-CA TLS fixture, credential guards and a 162-test regression pass.
The counts below describe the original release candidate.

## Scope classification

- Current/intended: generic RSS/Atom/JSON, YouTube, Discord source and delivery,
  Telegram, conditional HTTP, per-destination cache, diagnostics and safe run modes.
- New 2.2.0: Network Usage Control, Friendly Mode, runtime metrics, Network UI,
  Scrapling Resource Saving, dashboard redesign and challenge-page protection.
- Regressions fixed: duplicate delivery-cache IDs, persistence before send delay,
  interstitials reaching HTML parsers, browser fallback ignoring disabled policy,
  and a UI regression test depending on a private local config.
- Legacy to remove: the retired destinations/protocol-specific integration listed
  in the release notes. Their adapters, configuration branches, environment keys
  and compatibility tests are absent. Unsupported configuration sections produce
  generic, explicit warnings and are not executed.

## Validation

| Check | Result |
| --- | --- |
| Original main baseline | 5 passed, 0 failed, 0 skipped |
| Final `npm test`, Node 26.10.0 | 161 passed, 0 failed, 0 skipped |
| Final full suite, Node 20.18.1 | 161 passed, 0 failed, 0 skipped |
| Real pinned Scrapling 0.4.15 / Chromium | 7 passed, 0 failed, 0 skipped |
| Dashboard browser script | PASS, desktop/mobile, authentication and editing |
| Network browser script | PASS, presets, Custom, revisions, real worker/offline status |
| `node main.js --check-config` | Exit 0, distributed example with placeholder environment values; 2 channels, no warnings |
| Syntax | 86 JS/CJS/MJS files plus Python worker: PASS |
| HTTPS reverse proxy | Real loopback TLS proxy: login, Secure cookie, Network update, origin rejection, logout |
| Archive guard | Tracks source/examples; rejects forcibly tracked secrets and ignored artifacts |
| Network smoke/benchmark | See `network-benchmark.md`; loopback only |

The suite includes shared budgets, Potato/Medium/asymmetric Custom, Friendly Mode,
retry/429/Retry-After, encoded byte accounting, throttling-aware timeout/cancellation,
shutdown, conditional fetch, independent destination state and API access control.
Challenge regressions verify parser rejection, titleless pages, disabled fallback,
failed browser challenges, cached pending entries and byte-for-byte unchanged
persisted cache. Generic configuration tests verify unsupported sections do not
become executable channel groups. A separate manual check confirmed readable
warnings for retired root and per-channel configuration.

No real destination messages were sent. Tests use temporary configuration and local
HTTP/TLS fixtures. Chromium and Python were supplied from external test environments,
not copied into the release. The test TLS key is a deliberately public localhost
fixture, never a production credential.

Initial release validation exposed three failures: two duplicate-cache regressions
and a UI test requiring a developer config file. These were repaired; no failing
assertions were disabled. Tests exclusively enforcing retired integrations were
removed/replaced following the explicit release scope correction. The browser edit
scenario was updated to verify and acknowledge the new unsupported-section warning
for its deliberately unknown metadata; its final rerun passed.

## Runtime and compatibility

`package.json` and lockfile are 2.2.0. Minimum Node is 20.18.1, matching the already
locked Cheerio/Undici engine requirements. The public main's `>=18` declaration was
inaccurate; this release does not impose the development workspace's Node 22 floor.
Both the minimum version and Node 26 were exercised. Existing configurations without
`network` retain Unlimited, Friendly Mode off and the default resource-saving policy.
Generic channel fields and unknown sections are preserved for review; unsupported
sections are reported rather than interpreted as destinations.

## Repository hygiene

- Expanded `.gitignore` for Node/Python environments, `.env` variants (except the
  example), config/cache defaults, atomic temp files, logs/debug capture, coverage,
  browser caches/reports, benchmark output, release artifacts and editor files.
- Audited `git ls-files` and `git status --ignored`. Original main tracked 49 files,
  332,563 source bytes, and no generated/private files requiring `git rm --cached`.
  Its checkout occupied approximately 1.9 MB including Git metadata.
- The development workspace occupied 455,933,880 bytes including local artifacts;
  it was left intact. Only source/examples/fixtures were imported. No `.venv`,
  `.env`, private config, cache, dependency tree or browser binary was copied.
- The XFeeder-owned Scrapling adapter and both Python dependency manifests remain.
  Its optional third-party upstream checkout is excluded, as are Python caches.
- Historical local benchmark JSON files are not shipped. Reviewed results live in
  Markdown; raw run output and artifact manifests remain outside the repository.
- Archive creation uses a Git ref, not a filesystem copy. The builder rejects any
  tracked forbidden or ignored file, gitlink or symlink. Nested Git metadata cannot
  be included. It emits exact source/archive sizes and the ten largest files.
- Test-created logs/dependencies are removed from the final release checkout after
  validation. The archive is independently extracted and checked before tagging.

## Known limits

Unlimited has measurable transport overhead; the stress result is documented,
not represented as zero or universally negligible. Upload reserves known buffered
bodies before dispatch; streams, multipart and redirect replay are unshaped.
Python/browser traffic has resource/concurrency policy but no Node bandwidth cap
or fabricated byte totals. Application throttling is not router QoS. Live external
provider delivery, Windows/macOS and external CDP were not tested in this Linux run.
A successful independent destination send cannot make a multi-destination operation
atomic. Runtime logs require normal operator rotation/retention.

## Local packaging and owner publication

After a clean regression pass, commit the source and archive the commit:

```bash
npm run release:archive -- HEAD /tmp/xfeeder-release-artifacts/XFeeder-2.2.0.tar.gz
```

An annotated `v2.2.0` tag is created only after final validation. The source archive
is deterministic for a given commit with the same Git/gzip toolchain. Exact file
counts, source/compressed sizes, largest files and SHA-256 are in the external
artifact manifest/checksum, avoiding a self-referential archive size in source docs.
The preparer does not push. From the prepared checkout, the owner runs:

```bash
git push origin main
git push origin v2.2.0
gh release create v2.2.0 /tmp/xfeeder-release-artifacts/XFeeder-2.2.0.tar.gz \
  --verify-tag \
  --title "XFeeder 2.2.0 — Final Big Tweaks Before 3.0" \
  --notes-file RELEASE_NOTES_2.2.0.md
```
