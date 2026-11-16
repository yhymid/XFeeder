# Security policy

## Reporting

Use GitHub's private vulnerability reporting for this repository, or contact
the maintainer privately. Never include real tokens, webhook URLs or `.env`
contents in a report.

## Boundaries

- `config.json`, `.env`, caches and telemetry snapshots are written with mode
  `0600`; keep the data directory private and out of web roots.
- The dashboard binds to `127.0.0.1` by default. Exposing it (non-loopback host
  or `XFEEDER_DASHBOARD_PUBLIC_ORIGIN`) requires `XFEEDER_DASHBOARD_PASSWORD`;
  put it behind HTTPS. Host and Origin headers are verified and state-changing
  requests need a matching origin.
- `network.outboundPolicy: "public-only"` blocks private/LAN targets (DNS is
  checked at connect time) and disables proxy and Scrapling for untrusted feed
  lists. It does not replace a firewall.
- Logs and activity events redact webhook tokens, bot tokens and sensitive
  query parameters; channel and feed identifiers in telemetry are hashed.
- A corrupt or unwritable cache stops delivery instead of risking duplicates.
  Restore from a backup; the corrupt file is kept as `*.corrupt-<sha256>`.
- Feed content is untrusted. Run one worker per cache.
