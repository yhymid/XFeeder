# Offline feed fixtures

These documents are synthetic X3-05 test inputs. Domains, authors, video IDs and
media URLs are placeholders. Tests inject response bodies or serve loopback HTTP;
they never fetch YouTube, thumbnails, enclosures or article URLs.

| File | Purpose |
| --- | --- |
| `rss.xml` | RSS 2.0, CDATA/HTML content, GUID, enclosure, categories and timezone conversion |
| `atom.xml` | Atom IDs, alternate/enclosure links, entry/feed author and updated/published precedence |
| `json-feed.json` | JSON Feed 1.1 envelope, text/HTML content, URL aliases, image and legacy author fields |
| `youtube.xml` | YouTube Atom namespaces, video ID, thumbnail list and locally built fallback URLs |
| `invalid.xml` | Deliberately mismatched XML and an incomplete item |
| `html.html` | Benign article HTML returned in place of a feed |
| `empty.xml` | Valid RSS channel with no items |
| `malformed-dates.xml` | Invalid date beside a valid item |
| `duplicates.xml` | Repeated GUID with distinct links, and a repeated link with distinct GUIDs |

Stateful HTTP fixtures live directly in `tests/feed-fetch.test.js`: a conditional
200/304 endpoint, a 403 endpoint using the existing challenge-page fixture, and an
endpoint that accepts a request without sending a response. They use the shared
`serve()` helper to allocate a loopback port and clean up sockets. The timeout test
asserts the structured deadline error and released operations, not elapsed time.

JSON responses are decoded before reaching `parseJSON`, matching the HTTP client's
normal behavior. Detection is heuristic, not format validation. Dedicated XML/RSS
parsers reject the empty/invalid fixtures, while the full current parser chain can
turn them into metadata entries through its permissive HTML fallback. That known
limitation is deliberately visible in the pipeline characterization tests.

See [the compatibility record](../../../docs/feed-pipeline-compatibility.md) for
test boundaries, retained limitations and validation results.
