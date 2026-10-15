# X3-24 — Scrapling upstream-version audit (2026-10-15)

## Result: already current, do not invent an upgrade

As of 2026-10-15, the newest published Scrapling distribution on
[PyPI](https://pypi.org/project/scrapling/) and the upstream
[GitHub releases page](https://github.com/D4Vinci/Scrapling/releases)
is **0.4.15**, published August 23, 2026. The existing XFeeder
`src/extensions/Scrapling/requirements.lock.txt` already pins
`scrapling==0.4.15`. The installer verifies precisely that version,
checks dependency consistency with `pip check`, and launches the
matching Playwright and Patchright Chromium runtimes. The existing
managed-browser CI smoke test passed on the X3-23 baseline.

The upstream 0.4.15 changelog warns of MCP server breaking changes.
XFeeder's browser-backed source retrieval uses the pinned Scrapling
extract/CLI and session interfaces, not its MCP server interface.
There is therefore no reason to change the dependency solely for
a version bump, and no unreviewed `pip install --upgrade` fallback.

## Regression guard

`tests/scrapling-installer.test.js` now verifies:
- Exactly one stable Scrapling version is pinned in the requirements file.
- The installer's real Python import assertion names that same version.
- Playwright and Patchright each have one explicit stable lock pin.

The test is offline and does not alter the user's Python virtualenv.
Future Scrapling upgrades must update the lock, installer verification,
browser compatibility tests and this audit together; installing unpinned
latest versions is deliberately unsupported.

## Deferred X3-25

Python patch/minor upgrades of transitive dependencies should be evaluated
separately from the Scrapling upstream-version audit. Regenerate the full
lock for each targeted Python/OS matrix, verify wheel availability and
`pip check`, and run the **real** managed-browser smoke test before changing
any pinned dependencies. The version audit alone is **not** evidence that
all transitive packages are the newest available.
