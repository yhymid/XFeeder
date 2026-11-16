# Scrapling installer validation — XFeeder 2.2.0

Date: 2026-10-10. This follow-up adds optional runtime installation to the audited
2.2.0 candidate. No 3.0 work, push or release tag rewrite was performed.

## Installation contract

- `npm run scrapling:install` locates compatible `python3`, then `python` (Python
  3.11+ for the existing locked IPython), creates the extension's `.venv`, and uses
  that virtualenv's Python/pip for all subsequent package operations.
- `pip install --no-deps -r requirements.lock.txt` retains all existing pins;
  `pip check` rejects inconsistent installations. There is no latest-version fallback.
  The only added pins are Windows-conditional existing transitive requirements:
  [Colorama 0.4.6](https://pypi.org/project/colorama/0.4.6/) and
  [pywin32 311](https://pypi.org/project/pywin32/311/), required by Click/IPython and
  MCP respectively (verified against the installed packages' dependency metadata).
- Both Playwright and Patchright install their required Chromium revision. Their
  pinned 1.63.0 packages share revision 1243 in this run. Browser binaries live in
  the user browser cache, outside source control and release artifacts.
- Verification imports Scrapling 0.4.15, exercises its selector, executes the CLI,
  and launches both browser engines against in-memory local HTML. It does not visit
  an external website or claim universal anti-bot bypass.
- `npm run scrapling:check` verifies the managed installation without installing
  packages or downloading browsers. Broken/partial environments exit nonzero with
  remediation; no existing virtualenv is deleted automatically.
- Detection pairs the selected Python with its corresponding CLI, prefers the local
  environment, supports Windows Scripts paths and uses argument arrays without a shell.
  The installer and runtime never require or create `upstream/`.

## Results

| Check | Result |
| --- | --- |
| Offline installer/detector tests | 15 passed; paths, local/global order, reuse, missing/old Python, failures and absence |
| Full suite, Node 26.10.0 | 177 passed, 0 failed, 0 skipped |
| Full suite, Node 20.18.1 | 177 passed, 0 failed, 0 skipped |
| `node main.js --check-config` | PASS with distributed example and placeholder environment |
| Fresh `npm run scrapling:install` | PASS, newly created local Python 3.14.7 virtualenv |
| Repeated `npm run scrapling:install` | PASS, existing environment reused |
| `npm run scrapling:check` | PASS, Python/venv/dependencies/Scrapling/browser |
| Real managed-runtime Scrapling browser suite | 7 passed, 0 failed, 0 skipped |
| Automatic runtime discovery | Local `.venv/bin/python` and `.venv/bin/scrapling`, version 0.4.15, sessions available |
| Missing optional runtime | Real detector against a directory without venv returns unavailable without throwing |
| `upstream/` absent | Absent throughout installation, detection, regression and browser tests |
| Archive exclusions | Verified untracked artifacts omitted and force-tracked `.venv`/`upstream` rejected |

The real browser suite used the newly installed managed environment and its default
browser cache, without an executable-path override. It covers HTTP-blocked fallback,
resource policies and abort/shutdown process cleanup. Ordinary `npm test` performs
no browser/package downloads and does not require a Python installation.

Linux was exercised end to end. The host distribution is not officially supported
by Playwright/Patchright; their Ubuntu 24.04 fallback binaries nevertheless launched
and passed these tests. Windows path/selection behavior is covered with offline
mocks; native Windows/macOS installations were not run. Missing system libraries
remain an administrator responsibility; the installer never invokes sudo.

The lock pins package versions, not wheel hashes. Different supported Python/OS
combinations select different wheels; unsupported wheel/platform combinations fail
visibly rather than silently selecting unpinned dependencies. Browser OS requirements
still apply. The optional runtime must be installed under the same service user (or
with the same browser-cache environment) that runs XFeeder.

The generated `.venv` remains locally available and ignored. Archive verification
compares committed source with archive members and confirms no local environment,
upstream checkout, cache, secret or browser binary is included. Exact archive size,
SHA-256 and commit are recorded in the external release artifact manifest. The old
`v2.2.0` tag remains unchanged and does not include the audit/installer follow-ups.
