# XFeeder 2.2.0 repository security and hygiene audit

Audit date: 2026-10-10. Scope: the release checkout, current tracked source,
its distribution archive, all locally stored Git blobs and commit/tag metadata.
Public origin refs were fetched before history inspection. No release was published.
This is a repository disclosure audit, not a penetration test of the application.

## Acceptance

- Tracked real secrets: **0**
- Tracked user configuration: **0**
- Tracked runtime cache/state: **0**
- Tracked local environments: **0**
- Tracked production private keys: **0**

One deliberately public private key is permitted, at
`tests/fixtures/tls/localhost-test-key.pem`. Its matching certificate and
[fixture documentation](../tests/fixtures/tls/README.md) explain its restricted use.
Examples contain placeholders; tests use synthetic tokens/passwords. No live
credential or user data was found in tracked source. Sensitive findings are not
printed as values in the audit evidence.

## Current tree and ignore rules

Inspected `git status`, `git status --ignored`, `git ls-files`, and
`git ls-files -ci --exclude-standard`. No private/generated tracked file needed
`git rm --cached`. Local dependencies/logs created by verification are removed
from the final release checkout, without deleting the user's original environment.

The original development workspace had no tracked files; its `.gitignore` has also
been brought into line. Its existing user configuration, environment and runtime
files remain on disk and are ignored. It is separate from the release checkout.

Rules cover environment/user config, caches, runtime snapshots, debug/logs,
Node/Python environments, upstream checkout, editor files, browser profiles,
saved authentication/cookies, local database files/journals, directory environments,
cloud/tooling directories, `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc`, `.envrc`,
and root secrets/credentials/auth JSON. There are no source database fixtures or
required package-manager configuration files conflicting with these exclusions.

PEM/key/bundle files are ignored. The two exact public test fixture paths are the
only PEM exceptions; only one is a private key. `.env.example`, config examples,
lockfiles, documentation, source code and required fixtures remain publishable.
The archive builder independently rejects private credential/key/database paths,
even if force-added; it also enforces actual ignore rules.

## History inspection

The initial audit covered the complete non-shallow history through release commit
`dd864b4acc1aa004c9b6e7fa0d902f13208aad28`: **44 commits, 331 blobs (2,960,066 bytes)**,
plus **45 commit/tag metadata objects**. All local objects were enumerated, including
objects outside current refs; historical paths were reconstructed across refs and
reflogs. `git fsck --full --no-reflogs` reported no issue. Origin fetch introduced
no additional history.

Searches covered credential filenames, private key markers, provider tokens,
credential-bearing URLs, webhook URLs, cookie/session/secret/password assignments,
and known credential formats. All 34 distinct candidate matches were reviewed:
placeholder/example strings, synthetic test credentials, code identifiers and the
old deliberately public localhost fixture. Historical paths contain no private
user config, actual environment file, cache/database, local environment or debug
output; `.env.example` and `debug/.gitkeep` are intended exceptions.

Two non-placeholder credential values from the separate local development
configuration/environment were also compared against every historical blob, without
printing their values. Neither appeared in history.

No real committed secret was identified, so no credential revocation or destructive
history rewrite is indicated by this audit. This finding concerns the available
repository history; it cannot establish what existed in inaccessible, deleted
external refs or prove how a key was used outside this repository.

## TLS finding and correction

The old certificate had `CA:TRUE`, and tests explicitly trusted it per-client.
It was not loaded by runtime or deployment examples and was never installed into a
trust store by repository code. The old key's external provenance cannot be inferred
from PEM contents alone, so this audit generated a **new pair solely for tests**.

The replacement has `CA:FALSE`, serverAuth usage, and only localhost/127.0.0.1 SANs.
Its names explicitly include `test`. Both consumers are tests binding to loopback;
no production module or deployment example reads it. Tests trust the exact leaf
through local `ca` options, not a global/system CA setting. The regression verifies
key/certificate matching, localhost identity, rejection of unrelated hosts and
rejection by a default client without explicit trust.

Ephemeral issuance on every test run was considered. The supported Node 20 crypto
API cannot issue X.509 certificates; adding an OpenSSL executable requirement or an
npm certificate library solely for this purpose would reduce portability or enlarge
the dependency set. A documented static non-CA fixture was retained instead.

## Validation and publication boundary

The targeted archive/TLS/network suite passed **36/36** before the additional ignore
regression. The final full suite passed **162/162**, with **0 failed and 0 skipped**,
on Node 26.10.0 and Node 20.18.1. `node main.js --check-config` passes with the
distributed example and placeholder environment values. No production architecture
or delivery behavior changed. Browser suites were not repeated for this hygiene-only
change; their previous 2.2.0 results remain in the release validation report.

The audited source archive is built from the new audit commit and independently
checked against its tracked file list/content. Exact commit, counts, sizes and hash
are in its external manifest. Previous archives and the original `v2.2.0` tag do not
contain this follow-up. The original tag is deliberately not rewritten: the owner
must explicitly authorize updating it before publishing the audited commit as
`v2.2.0`. No push, tag replacement, history rewrite or GitHub Release was performed.
