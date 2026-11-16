# Config loader compatibility — X3-03

This records the existing 2.2.0 loader behavior on the `3.0-dev` line before
Config Schema v2. X3-03 adds regression tests and synthetic fixtures only;
`src/config-loader.js`, user configuration and dependencies are unchanged.

## Behavior protected by tests

| Input or event | Current result |
| --- | --- |
| Entire `${NAME}` value | Resolve from sibling `.env`, overridden by `process.env` |
| Nested objects and arrays | Resolve values recursively; preserve object keys and native JSON types |
| Missing variable or empty value | Empty string; an empty process variable also overrides a file value |
| Embedded placeholders, invalid names, `${NAME:-default}` | Preserved literally |
| Variable containing another placeholder | No recursive expansion; numeric/boolean env values remain strings |
| Config load | Read JSON and sibling `.env` again, even when the env mtime has not changed |
| Changed process environment | Observed on the next config load without restarting/requiring the module again |
| Removed env key/file, recreated file, another config directory | No stale value leaks into the next config load |
| Direct `loadDotEnv()` calls | Cache by path and mtime; `{ reload: true }` bypasses it; callers receive independent objects |
| Whitespace, matching single/double quotes, LF/CRLF | Trim outer whitespace and matching quotes; keep whitespace inside quotes |
| Duplicate dotenv keys | Last assignment wins |
| Empty/comment-only dotenv | Empty env map |
| Invalid dotenv lines / `export` prefix | Ignored rather than rejected |
| Unmatched quotes, inline `#`, backslash escapes | Kept literally by this simple parser |
| Missing/unreadable `.env` | Empty env map; a later successful load can recover |
| Malformed JSON | Throws `SyntaxError`; does not rewrite the file; a repaired file can load normally |
| Missing config | Throws `ENOENT`; does not create an example or replacement |

Loading dotenv does not populate `process.env`. Tests use temporary directories,
synthetic values, exact environment restoration and deterministic filesystem
timestamps. Read failure is mocked instead of relying on platform permission bits.
The pre-existing loader regression remains part of the suite.

These are compatibility observations, not a new dotenv specification. Consult
[Node's environment-variable documentation](https://nodejs.org/api/environment_variables.html)
and [dotenv's documentation](https://github.com/motdotla/dotenv) before considering
a replacement, but do not assume their parsing rules match XFeeder's custom loader.
The filesystem APIs used for reload tests are documented by
[Node](https://nodejs.org/api/fs.html).

## Validation — 2026-10-11

- Loader suite: 22 passed, 0 failed, 0 skipped on Node 26.11.1 and Node 20.18.1.
  This includes 21 new tests plus the existing loader test.
- Full `npm test`: 208 passed, 0 failed, 0 skipped on Node 26.11.1.
- Targeted built-in Node 26 coverage for `src/config-loader.js`: 100% lines,
  branches and functions. This is a module-specific result, not global coverage.
- `node main.js --check-config --config tests/fixtures/config/minimal.json`:
  passed with zero warnings and no network requests.
- Syntax and `git diff --check`: passed. Production code was not changed.

Changed files: `tests/config-env.test.js`,
`tests/fixtures/config/substitution.json`,
`tests/fixtures/config/dotenv-valid.txt`,
`tests/fixtures/config/dotenv-malformed.txt`, and this document.

Deferred: channel configuration cases belong to X3-04, Config v2 validation to
X3-29, migration to X3-30 and the future secret model to X3-31. None is implemented
here. Existing configuration formats and the current Node minimum remain intact.
