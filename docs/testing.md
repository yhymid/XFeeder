# Test harness — X3-02

X3-01 was skipped at the maintainer's request. Development is on `3.0-dev`,
starting from the prepared 2.2.0 source commit
`3c5654e751bbbae414d0185e288e716d5a9541a7`, not the older local `v2.2.0` tag.
The tag is unchanged. No release publication is part of this task.

The package version stays `2.2.0` for this test-only step. A future release task
will choose a 3.0 prerelease version; unfinished work is not labelled stable 3.0.0.
No runtime modules, dependency versions, configuration formats or Node requirements
are changed here.

## Commands

```sh
npm ci
npm test
npm run test:coverage
node main.js --check-config --config tests/fixtures/config/minimal.json
```

Use `npm test -- --test-name-pattern=pattern` to select tests by name. The runner
enumerates and sorts top-level `tests/*.test.js` in JavaScript and passes explicit
absolute file paths to Node, without a shell glob or a shell subprocess. It uses
the same Node executable as the caller. An empty test directory or a failing test
returns nonzero. Helpers, fixtures and optional browser scripts are not discovered
as unit tests.

## Isolation and fixtures

- Each Node test worker starts in a temporary working directory. The reporting
  process stays in the project directory so coverage paths remain usable.
- Only OS path/locale/terminal environment variables are inherited. Tests set
  synthetic tokens themselves. Application settings, proxy overrides, TLS
  overrides, `NODE_OPTIONS` and Git steering variables are not inherited.
  Global/system Git configuration is disabled for fixture repositories.
- A preload guard allows only loopback TCP connections. It catches accidental
  outbound HTTP/HTTPS, `fetch`, TLS and raw TCP, including redirects. The existing
  per-test HTTP mocks are retained. This is a guard for trusted tests, not a
  security sandbox: native subprocesses and deliberately bypassing the guard are
  outside its scope.
- Existing config/cache/dashboard tests use explicit temporary paths and
  `dataDir`. Keep doing this: changing cwd does not constrain absolute paths or
  module-relative dashboard defaults. Never point a test at a user's config,
  `.env` or cache. The ordinary suite does not run real providers or browsers.
- `tests/helpers/temp-dir.cjs` supplies `tempDir(t)` with `t.after` cleanup.
  The runner also removes its temporary root on completion/failure.
- Reuse `serve(t, handler, tls?)` and `readBody` in
  `tests/fixtures/network.cjs`: the server binds to `127.0.0.1` on a random port,
  records requests and closes sockets during test cleanup. Handler failures fail
  the test. Its delay/deferred and detector mocks remain available.
- Reuse `tests/fixtures/feeds.cjs`, challenge HTML and the documented public TLS
  test fixture. `tests/fixtures/config/minimal.json` is an empty, secret-free
  CLI validation config with Scrapling disabled; it performs no feed requests.

The isolation contract is tested with synthetic caller config/cache/env files,
ambient credentials and Git variables, forbidden network calls, local HTTP,
temporary cleanup, paths containing spaces, deliberate test failure and LCOV paths.
No new parser/config/delivery behavior tests from later X3 tasks were added.

## Coverage

`npm run test:coverage` uses Node's built-in experimental coverage and writes a
text summary plus `coverage/lcov.info` (ignored by Git). No coverage dependency
is installed. The command supports the existing minimum Node 20.18.1.

On runtimes that expose `--test-coverage-include`, the summary includes loaded
modules under `src/`, excluding test/helper code. Node 20.18.1 does not expose
that option; it reports all loaded project files, including tests, and prints
that limitation. Compare the `src/` LCOV records on that version rather than
treating the mixed total as production coverage. Unloaded files are not counted;
this is not a claim of whole-project or browser UI coverage.

The approximate 80% branch target is a later coverage goal, not a new failing
global gate or a reason to refactor production code in X3-02. Expand meaningful
fixtures and behavior coverage in X3-03 through X3-07. CI/runtime matrix work
belongs to X3-09; browser smoke tests retain their existing separate npm scripts.

## References

- [Node test runner, coverage and hooks](https://nodejs.org/api/test.html)
- [Node filesystem temporary directories](https://nodejs.org/api/fs.html#fsmkdtempsyncprefix-options)
- [Node 20.18.1 test-runner documentation](https://github.com/nodejs/node/blob/v20.18.1/doc/api/test.md)

Runtime capability checks and actual Node 20.18.1/26 validation determine which
coverage flags are used, rather than assuming the latest documentation applies
to every supported runtime.

## X3-02 validation (2026-10-11)

- `npm test`, Node 26.11.1: 187 passed, 0 failed, 0 skipped.
- `npm run test:coverage`, Node 26.11.1: 187 passed; loaded `src/` modules:
  81.17% lines, 71.96% branches, 83.02% functions. The 80% branch goal is not met yet.
- `node scripts/test.cjs --coverage`, Node 20.18.1: 187 passed, 0 failed,
  0 skipped; fallback coverage and LCOV path regression passed.
- `node main.js --check-config --config tests/fixtures/config/minimal.json`:
  passed, zero channels/warnings and no network requests.
- Syntax and `git diff --check`: passed. No files under `src/` changed.
- Native Windows/macOS execution and the Node 22/24 CI matrix were not performed
  in this task. Optional browser smoke suites were not rerun for this harness-only change.

Changed files: `package.json`, `scripts/test.cjs`, `tests/helpers/setup.cjs`,
`tests/helpers/temp-dir.cjs`, `tests/fixtures/config/minimal.json`,
`tests/test-harness.test.js`, `tests/config-loader.test.js`,
`tests/challenge-page.test.js`, and this document.
