# Changelog

All notable changes to this project are documented in this file.

## [2.1.0] - 2026-02-19

### Added
- Added `.env` placeholder support in config files (`${ENV_VAR}`) through `src/config-loader.js`.
- Added global Scrapling mode via `Scrapling.ForceGlobal`.
- Added additional Scrapling options support:
  `wait`, `waitSelector`, `waitSelectorState`, `blockedDomains`, `retries`, `retryDelay`.
- Added Scrapling version compatibility warning (recommended `>=0.4.0`).
- Added `.env.example` with required secret placeholders.

### Changed
- Bumped project version from `2.0.0` to `2.1.0`.
- Updated all project user-agent/version markers from `2.0` to `2.1`.
- Improved Scrapling CLI/shell invocation safety and argument handling.
- Updated docs and examples to match current runtime behavior.

### Removed
- Removed FreshRSS support entirely:
  - Deleted `src/parsers/freshrss.js`.
  - Removed FreshRSS pipeline handling from `main.js`.
  - Removed FreshRSS config sections and env variables from templates.

### Fixed
- Fixed potential crash when no channels are configured.
- Fixed workshop directory handling to respect `Workshop.Dir`.
- Fixed/standardized Scrapling timeout behavior per mode:
  request modes in seconds, browser modes in milliseconds.

## [2.0.0]

### Added
- New unified downloader-first feed pipeline.
- Workshop parser system improvements and KV storage.
- Discord Components V2 message delivery.

