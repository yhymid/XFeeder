# 3.0-alpha parity review — 18 October 2026

The supported development line is **3.0-alpha**. The completed **3.0-dev**
branch is a historical comparison target only; **main** remains the 2.2.x
stable source. The future sequence is 3.0-beta, 3.0-rc and 3.0.

## Git tree audit

Before reconciliation: 241 byte-identical files, four files only in
3.0-dev, nine differing shared files, and no files unique to alpha.
Git histories had diverged (four alpha-only commits and 24 dev-only commits).
This review retains the alpha-specific version, npm lock, entrypoint header
and branch identity instead of merging the dev history wholesale.

Changes ported from the reviewed dev tree:

- Worker control server/UI: authenticated same-origin Start/Stop/Restart,
  only for dashboard-owned children, plus the PID/telemetry safety check.
- Discord delivery: webhook wait=true, provider acknowledgment latency
  logging and separate warning for slow delivery cache persistence.
- Collapsed sidebar status layout fixes and responsive action buttons.
- Worker control and Discord confirmation regression tests.
- Public Linux alpha installation/testing guide and corresponding change
  rationale.
- An additional post-install CI gate: build a source-controlled runtime
  archive, verify its extracted entrypoints/config/npm lock and publish the
  resulting artifact **to the workflow run** only.

Intentionally preserved or adapted:

- Alpha's `3.0.0-alpha.0` package.json / package-lock.json, no npm pin churn.
- Alpha README identity and CLI entrypoint comment.
- CI release stage runs on the **3.0-alpha** branch rather than 3.0-dev.
- **No automatic tag creation or GitHub release publication.** Existing
  v3.0.0-alpha.0 prerelease is immutable; use a separately reviewed next
  prerelease version when appropriate.
- Main and completed 3.0-dev are not modified.

## Key remaining operational limits

Worker control is not a cross-process lock. Do not run a terminal/systemd
worker and dashboard-managed worker against the same cache during startup;
the PID/heartbeat check reduces but cannot eliminate the race. The dashboard
must be secured before allowing remote administration. A slow cache fsync is
not the same thing as a slow Discord provider response.

The green dev CI demonstrated this feature set in its original branch,
but alpha must pass its **own** GitHub Actions for these changes to be
considered verified on the target branch.
