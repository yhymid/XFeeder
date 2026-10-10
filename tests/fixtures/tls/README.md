# Public localhost TLS test identity — NEVER DEPLOY

`localhost-test-key.pem` is a **deliberately public private key**. It is not a
credential and provides no security against anyone who can read this repository.
Never use it for a deployed service, production dashboard or any real user data.
Never import its certificate into a system/browser trust store or configure it
through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` or a global TLS trust override.

This new pair was generated solely for this fixture during the 2026-10-10 security
audit. It replaces the previous generically named pair whose certificate had
`CA:TRUE`. The replacement is self-signed with **CA:FALSE**, serverAuth only,
and subject alternatives limited to `localhost` and `127.0.0.1`.

Only `tests/network-integration.test.js` and `tests/reverse-proxy.test.js` load it.
Their servers bind to `127.0.0.1` on ephemeral ports. Production source and deployment
examples do not load it. Tests explicitly trust this exact leaf certificate via
per-client `ca` options; this is a local trust anchor for those requests only,
not a globally trusted CA. A regression verifies that a default HTTPS client
rejects it, that the key matches, and that the certificate is not a CA.

Node 20's standard crypto API cannot issue X.509 certificates. Generating a new
certificate every test run would add an OpenSSL executable requirement or another
npm dependency. This fixed fixture keeps tests portable without either dependency;
OpenSSL is needed only when a maintainer replaces the fixture.

Reproduction (creates a new, different public test key):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -subj '/CN=localhost/OU=PUBLIC TEST FIXTURE - NEVER DEPLOY' \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
  -addext 'extendedKeyUsage=serverAuth' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout tests/fixtures/tls/localhost-test-key.pem \
  -out tests/fixtures/tls/localhost-test-cert.pem
```

The only private PEM allowed by `.gitignore` and the release packager is this exact
fixture path. Other PEM/key/bundle paths remain excluded. Exceptions must never be
broadened to an entire directory. Historical copies of the old public test fixture
are not production credentials; changing a fixture does not establish provenance
for keys outside this repository.
