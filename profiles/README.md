# Feed profiles

Three sets of real feeds that XFeeder runs in production, each with a saved
sample (5 entries) in `tests/fixtures/profiles/<profile>/`:

| Profile | Feeds | What it covers |
|---|---|---|
| `news` | onet, boop, gry-wideo, lowcygier | RSS 2.0, enclosures, WordPress thumbnails, Cloudflare |
| `games` | Steam news, Steam group, SteamDB, YouTube | HTML patch notes, missing images, video thumbnails |
| `dev` | GitHub commits and activity, Gitea, FMHY tracker | avatars, activity HTML, relative links |

**Live check** (downloads now, through Scrapling/solver/proxy from `config.json`):

```sh
xfeeder preview --profile news            # entries, hints, timings
xfeeder preview --profile games --bench 5 --items 0
```

**Offline regression test** (samples only, part of `cargo test`): every sample
is parsed and compared with `tests/fixtures/profiles/<profile>.expected.json`.
A change in what XFeeder reads from any site fails the test with the exact
field. When the change is intended:

```sh
XFEEDER_UPDATE_SNAPSHOTS=1 cargo test profile
git diff tests/fixtures/profiles/   # review what changed
```

To refresh a sample, download the feed again and keep the first 5 entries.
