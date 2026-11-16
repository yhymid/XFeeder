# Repository and release hygiene — X3-08

X3-08 checks the current `3.0-dev` tree and release packaging. The 2.2.0 release
already removed generated environments from version control; this task preserves
that work and closes the remaining nested browser-directory exclusion gap.
It does not upgrade Scrapling or change the feed/delivery runtime.

## Audit — 2026-10-13

The starting commit `06f05d6` contained 165 tracked files (1,019,169 bytes).
`git status`, `git status --ignored`, `git ls-files` and
`git ls-files -ci --exclude-standard` were inspected. There were no tracked
virtual environments, Node dependencies, Python bytecode, browser binaries,
nested Git repositories/gitlinks, runtime caches, snapshots or debug output.
No tracked file required `git rm --cached`, and no local environment was deleted.

The development checkout has ignored `node_modules/`, `coverage/` and
`debug/terminal.txt`. Those local files are not distribution inputs. The release
builder reads a Git ref, checks all tracked paths before selecting files, and
rejects forbidden entries even when they were force-added to the index.
This is a generated-file audit of the current tree, not a new secret/history scan.

## Output paths and retained source

| Producer | Generated data | Handling |
| --- | --- | --- |
| Node installation | `node_modules/` | Ignored; recipients install dependencies locally |
| Scrapling installer | `src/extensions/Scrapling/.venv/` | Ignored and rejected by the archive builder |
| Python | `__pycache__/`, `.pyc`/`.pyo`/`.pyd`, `.pytest_cache/` | Ignored and rejected by the archive builder |
| Playwright/Patchright | Browser cache, normally outside the checkout or inside an environment | Never distributed; recognized local cache directories excluded at any depth |
| Browser sessions | Configured browser profiles/user data directories | Recognized directory names excluded at any depth; use an external path for other names |
| Feed/cache store | Root `cache.json` and atomic `.tmp` files | Ignored; delivery state never distributed |
| Network metrics | `*.network-runtime.json` and temporary snapshots | Ignored and rejected by the archive builder |
| Dashboard/diagnostics | Root user `config.json`, `.env`, `debug/*.txt`, logs | Ignored; examples and `debug/.gitkeep` remain tracked |
| Tests/benchmarks/releases | Coverage, reports, benchmark output, `release-artifacts/`, `dist/` | Existing exclusions retained |
| Scrapling CLI | Temporary extraction files under `os.tmpdir()` | Outside the source tree; normal completion cleans them up |

The 16 tracked Scrapling files at the start of this task (92,796 bytes) are
XFeeder-owned adapter code, requirements and documentation. All remain intact,
including `browser_worker.py`, `runtime-paths.js`, `detector.js`, the JS wrappers,
`requirements.txt` and `requirements.lock.txt`. The existing optional installer
recreates the environment using pinned requirements; an upstream source checkout
is not needed. Ordinary `npm install` does not invoke that installer automatically.

## Changes

`.gitignore` now excludes `.cache/`, `ms-playwright/`, `browsers/`,
`browser-profiles/` and `user-data-dir/` at any depth, including below the Scrapling
adapter. It also excludes `.local-browsers/`. Previously the first five rules
only matched at the repository root. No tracked source or fixture conflicts with
the expanded rules.

`scripts/package-release.cjs` now independently rejects `browsers` and
`.local-browsers` path components, in addition to its existing environment,
cache, profile and non-regular-entry checks. Both source and runtime packaging
perform the checks before creating an archive. Runtime selection and its empty
generated starter `config.json` are unchanged; that starter contains no user data.
The runtime package still includes LICENSE, examples, adapter code and locked
requirements, while source packages also include docs and tests.

The tests exercise actual temporary Git indexes and archives, including
force-added generated paths and a gitlink representing a nested repository.
They retain positive coverage for required adapter files, examples and deliberately
public TLS fixtures. A private-looking filename in synthetic test data is not a
real credential or an environment to remove from the developer's checkout.

## Verification and reproduction

Run the release-artifact tests with the isolated test setup, then the complete
`npm test` suite and:

```bash
node main.js --check-config --config tests/fixtures/config/channel-groups.json
git ls-files -ci --exclude-standard
git status --ignored --short
node scripts/package-release.cjs HEAD /tmp/xfeeder-x3-08-runtime.tar.gz
node scripts/package-release.cjs HEAD /tmp/xfeeder-x3-08-source.tar.gz --source
```

The builder reports exact member counts, uncompressed file bytes, compressed size
and largest files. The starting source archive was 276,069 bytes and the runtime
archive 129,619 bytes (78 files, 504,299 uncompressed bytes). No large environment
was present to remove. Source growth reflects hygiene rules, tests and documentation;
runtime file contents remain unchanged. Verification also inspects archive members
and a fresh local clone, separately from the developer's ignored dependencies.

Validation: all four release-artifact tests passed on Node 26.11.1 and minimum
Node 20.18.1. The full suite on Node 26 passed 383 tests, with zero failures or
skips. `--check-config` reported four fixture channels and no warnings. Syntax
checks and `git diff --check` passed. The new guard/ignore assertions failed against
the previous implementation before passing with the fix.

## Constraints and deferred work

Arbitrary custom cache paths, `PLAYWRIGHT_BROWSERS_PATH` and `userDataDir` names
cannot all be inferred by ignore rules. Keep them outside the checkout or add a
reviewed local exclusion before use; never force-add generated environments.
Archives reject known generated paths, not arbitrary secrets hidden in source.
No cleanup of the developer's local environment or Git history is performed.
Scrapling upgrades and X3-09 CI are deferred to their numbered tasks.

The approach follows the Python guidance to recreate rather than distribute
[virtual environments](https://docs.python.org/3/library/venv.html), the distinction
between untracked and already tracked files in
[Git ignore rules](https://git-scm.com/docs/gitignore), and the explicit
[npm script lifecycle](https://docs.npmjs.com/cli/v11/using-npm/scripts/).
