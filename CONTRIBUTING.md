# Contributing to XFeeder

XFeeder 3.0 is developed on `3.0-dev`; package version strings still reference 2.2.0 until release preparation. Discuss large design changes before implementing them. Prefer focused, reversible changes with one behavior per commit.

## Setup

Install supported Node.js (CI: 22, 24, 26), clone the repository and run:

```sh
npm ci
npm run deps:check
npm test
```

Use test fixture configs and dummy tokens. Never check in a live `.env`, credentials, `cache.json`, feed state, telemetry snapshots, `node_modules` or Scrapling virtualenv. For browser testing see `src/extensions/Scrapling/readme.md` and `npm run test:scrapling-browser`; a browser smoke test requires a prepared Python/browser environment.

## Development workflow

Make a narrow branch from the current `3.0-dev`; if coordinating simultaneous agents, coordinate file ownership to avoid overwriting each other's work. Add/adjust `node:test` regression cases, then run npm test and relevant specific smoke tests. Allow CI to finish before claiming full compatibility.

Preserve cache identity and destination-aware deduplication, shutdown behavior, cancellation, GET/POST retry distinctions, default serial scheduling and supported legacy configs. Do not change Python/npm lockfiles by hand. Use `npm run deps:refresh -- <name> <version>` with registry access, then review all transitive changes.

For architecture and security contracts see `ARCHITECTURE.md` and `SECURITY.md`. Include a concise description, linked issue, tests, compatibility impact and rollback notes with each pull request.

## Documentation and releases

Update README and relevant docs when user-facing behavior changes. Releases must be built from a reviewed ref using `npm run release:archive` and validated without bundling private state or browser binaries. Do not change `main` or publish a release from a passing unit test alone.
