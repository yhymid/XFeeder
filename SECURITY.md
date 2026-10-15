# Security policy

## Supported versions

This repository's `3.0-dev` branch is under development and **not** a declared production support or security-update commitment. The current npm manifest reports `2.2.0`. Verify the latest release notes and security status before deploying.

## Reporting vulnerabilities

Please use GitHub's **Report a vulnerability** / private vulnerability reporting option for the repository when available. Otherwise contact the maintainer through a private channel. Do not publish credentials, user data, exploit details or security reports in public issues. Never paste a real bot token, Discord webhook or `.env` file into a report.

Include the affected commit, component, impact, a minimal sanitized reproduction, and relevant environment details. No response SLA or bug-bounty terms are promised here.

## Security boundaries

- Store `config.json`, `.env`, caches and runtime snapshots outside public directories with restrictive permissions; never commit them.
- For a remotely reachable dashboard use a strong `XFEEDER_DASHBOARD_PASSWORD`, HTTPS reverse proxy and exact `XFEEDER_DASHBOARD_PUBLIC_ORIGIN`; keep backend access restricted. Do not trust unsolicited forwarded headers.
- Opt into `network.outboundPolicy="public-only"` when handling untrusted feed URLs. This disables LAN/private targets, proxy connections and Scrapling browser fallback. It does not replace a firewall or protect third-party network clients.
- Set `network.maxResponseBytes` to limit managed Axios response sizes. This limit is not a universal cap on browser/Python traffic.
- Cache integrity failures are fatal to delivery; restore from a verified backup rather than deleting existing state. Run only one worker per delivery cache.
- External feed content is untrusted. Logs/events deliberately omit most sensitive fields, but historical debug logs and user-provided plugins require separate inspection and protection.
- Dependency and Python/Chromium updates must regenerate checked-in lock data and pass all supported CI jobs.

For the audited behavior and limitations see `docs/outbound-security-contract.md`, `docs/dashboard-security-compatibility.md`, `docs/async-state-contract.md`, `docs/dependency-maintenance.md`.
