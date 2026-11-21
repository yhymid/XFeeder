# Profile feedów

[English](README.md) · **Polski**

Trzy zestawy prawdziwych feedów, które XFeeder obsługuje na produkcji, każdy z zapisaną
próbką (5 wpisów) w `tests/fixtures/profiles/<profil>/`:

| Profil | Feedy | Co sprawdza |
|---|---|---|
| `news` | onet, boop, gry-wideo, lowcygier | RSS 2.0, załączniki, miniatury WordPressa, Cloudflare |
| `games` | newsy Steam, grupa Steam, SteamDB, YouTube | notatki aktualizacji w HTML, brakujące obrazki, miniatury filmów |
| `dev` | commity i aktywność z GitHuba, Gitea, FMHY tracker | avatary, HTML aktywności, linki względne |

**Sprawdzenie na żywo** (pobiera teraz, przez Scrapling/solver/proxy z `config.json`):

```sh
xfeeder preview --profile news            # wpisy, podpowiedzi, czasy
xfeeder preview --profile games --bench 5 --items 0
```

**Test regresji bez sieci** (tylko próbki, część `cargo test`): każda próbka jest
parsowana i porównywana z `tests/fixtures/profiles/<profil>.expected.json`. Zmiana w tym,
co XFeeder odczytuje z którejkolwiek strony, kończy test błędem ze wskazaniem pola. Gdy
zmiana jest zamierzona:

```sh
XFEEDER_UPDATE_SNAPSHOTS=1 cargo test profile
git diff tests/fixtures/profiles/   # przejrzyj, co się zmieniło
```

Żeby odświeżyć próbkę, pobierz feed jeszcze raz i zostaw pierwsze 5 wpisów.
