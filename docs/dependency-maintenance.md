# X3 — Patch/minor dependency maintenance

## Current state (2026-10-15)

The committed Node lock already resolves Axios 1.20.0, Cheerio 1.2.0,
WS 8.21.0, and other compatible versions within the existing manifest
ranges. The Python lock pins Scrapling 0.4.15 and the Playwright/Patchright
Chromium drivers at 1.63.0.

An upstream patch of follow-redirects 1.16.1 was published recently, while
the checked-in lock contains 1.16.0. **It has not been installed or
committed as part of this change.** Do not modify npm integrity values
manually, copy opaque lock metadata from search results, or claim that a
dependency upgrade passed browser tests when it has not.

Upstream references:
- https://www.npmjs.com/package/follow-redirects?activeTab=versions
- https://www.npmjs.com/package/axios
- https://pypi.org/project/scrapling/

## Reproducible Node upgrade, with registry access

Use a working Node 22, 24 or 26 installation, from the repo root:

    npm run deps:check
    npm run deps:refresh -- follow-redirects 1.16.1
    npm ci
    npm test
    npm audit --audit-level=high

The refresh helper only accepts a **currently declared direct dependency**
and an exact stable SemVer version newer than the installed locked version,
still inside the existing caret range. It runs npm in a child process with
literal arguments, disabled lifecycle scripts, no package audit during the
resolution step, and the standard npm registry lock integrity generation.
After resolution it re-checks lockfile parity. Review the full diff in both
package.json and package-lock.json before committing. No push, merge, release
or version publish is automated.

CI repeats npm ci, tests, npm audit and the cross-lock check on Node
22/24/26. The existing real Scrapling browser job must also pass.

The offline dependency guard enforces:
- Manifest/lock root direct dependency parity.
- Caret SemVer bounds including pre-1.0 special cases.
- Each locked direct dependency has a registry tarball URL and SHA-512
  integrity field.
- Python requirements pin Scrapling to the same version as its transitive
  lock and installer version assertion.
- Every Python lock entry uses an exact version; Playwright and Patchright
  both exist, and package names are unique.

**Limit:** Static checks verify pin consistency, not package authorship,
absence of vulnerabilities or runtime semantics. npm audit, package
signatures, license review, vulnerability advisories, browser acceptance
tests and careful code review still matter.

## Python upgrade process

The installer deliberately uses a **full pinned transitive Python lock**
with pip --no-deps and pip check. Never update a single Python pin
in isolation without resolving the entire dependency set. On the CI-supported
Python 3.14 runtime, regenerate a lock from requirements.txt using an
approved Python resolver, review its transitive changes and markers,
and verify wheels on all supported OS/Python versions.

Then run:

    npm run deps:check
    npm run scrapling:install
    npm run scrapling:check
    npm run test:scrapling-browser

Repeat the actual browser and shell session acceptance tests in a clean
environment; an offline lock syntax check alone is insufficient.
Windows-only marker packages must remain correctly specified. If the
browser package versions change, their matching Chromium installations
are required. Do not force a Python upgrade into an existing .venv, and
do not update all package majors in a single commit.

## Sequencing and known limitations

Do **one** dependency or tightly coupled group at a time to preserve
bisection and regression diagnosis. Leave main/release tags unchanged
until CI and manual release review pass.

The task-pack source uses X3-28 for Node dependency modernization and
X3-27 for Scrapling packaging; the conversation previously referred to
this maintenance follow-up as X3-25. This document describes the
dependency-maintenance work and does not redefine the original roadmap's
metrics-registry X3-25 task.
