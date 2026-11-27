# XFeeder w Dockerze

[English](docker.md)

Docker to alternatywa dla zwykłego pliku binarnego ([deployment.pl.md](deployment.pl.md));
obie drogi są wspierane. Trzy obrazy, budowane z [`docker/Dockerfile`](../docker/Dockerfile):

| Obraz | Dodaje | Rozmiar (amd64) | Architektury |
|---|---|---|---|
| `slim` | statyczny plik binarny i certyfikaty CA | ~17 MB | amd64, arm64 |
| `scrapling` | Python, [Scrapling](../scrapling/README.md) i jego Chromium, dla stron za Cloudflare | ~1,6 GB | amd64 (arm64 niesprawdzone) |
| `full` | SteamCMD, dla źródeł `steampics://` | ~1,65 GB | tylko amd64 (SteamCMD jest 32-bitowy x86) |

Zacznij od `slim`. `scrapling` bierz tylko, gdy feed potrzebuje `"Scrapling": true`, a
`full` tylko dla `steampics://`.

## Szybki start

```bash
git clone https://github.com/yhymid/XFeeder && cd XFeeder
mkdir -p data
cp config.json.example data/config.json   # potem go uzupełnij
cp .env.example data/.env                 # webhooki, tokeny
sudo chown -R 65532:65532 data            # obrazy działają jako UID 65532
docker compose build                      # slim; XFEEDER_TARGET=scrapling albo full dla pozostałych
docker compose up -d
docker compose logs -f worker
```

Inne obrazy: `XFEEDER_TARGET=full XFEEDER_IMAGE=xfeeder:full docker compose build`, potem
`XFEEDER_IMAGE=xfeeder:full docker compose up -d` (albo wpisz obie zmienne do `.env` obok
`compose.yaml`).

## Dane

Wszystko jest w `./data`, zamontowanym jako `/data`: `config.json`, `.env`, `cache.json`,
`sent.json`, logi i `steam_pics.json`. Montuj **katalog**, nie pojedyncze pliki: XFeeder
zapisuje plik tymczasowy i zmienia mu nazwę, co na montowaniu pojedynczego pliku się nie
udaje („Device or resource busy”). Przy złym właścicielu worker kończy się przy starcie z
„Permission denied”; napraw to przez `sudo chown -R 65532:65532 data`.

Jeden `cache.json` może używać tylko jeden worker. Worker trzyma blokadę `cache.json.lock`;
drugi, w innym kontenerze albo na hoście, kończy się z „another XFeeder worker is already
using …”.

## Dashboard

```bash
echo 'XFEEDER_DASHBOARD_PASSWORD=wybierz-haslo' >> data/.env
docker compose --profile dashboard up -d
```

Otwórz `http://127.0.0.1:3000` na serwerze albo ze swojego komputera przez
`ssh -L 3000:127.0.0.1:3000 user@serwer`. W kontenerze dashboard słucha na `0.0.0.0`, więc
hasło jest wymagane, a `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` musi dokładnie pasować do adresu w
przeglądarce (`http://127.0.0.1:3000`; `localhost` albo inny port daje `403 Untrusted Host`).
`compose.yaml` wystawia port tylko na `127.0.0.1` i ustawia
`XFEEDER_DASHBOARD_WORKER_CONTROL=off`: worker to osobny kontener, więc uruchamiasz go i
zatrzymujesz przez `docker compose`, a nie przyciskami dashboardu. Zmiany konfiguracji są
wczytywane bez restartu.

## Buildy Steama (`full`)

SteamCMD przy pierwszym uruchomieniu aktualizuje się (~215 MB) do `/home/xfeeder`. Trzymaj
to na wolumenie (odkomentuj `steam-home` w `compose.yaml`), inaczej każdy nowy kontener
pobierze to od nowa. Dla konta Steam (`Settings.SteamPics.Login`) zaloguj się raz w
kontenerze:

```bash
docker compose run --rm -it --entrypoint /usr/games/steamcmd worker +login NAZWA +quit
```

Zatwierdź logowanie w aplikacji Steam Mobile w ciągu około minuty. Sesja zostaje na
wolumenie `steam-home`.

## Zatrzymywanie

`docker compose stop` wysyła SIGTERM; worker kończy bieżące wysyłki, zapisuje stan i się
zamyka (`stop_grace_period: 45s`). Obrazy `scrapling` i `full` działają pod `tini`, który
zamyka też procesy Chromium.

## Czego jeszcze nie ma

- Obrazy na ghcr.io: planowane przy następnym wydaniu; do tego czasu buduj je sam.
- Healthcheck: `slim` nie ma powłoki, więc go nie ma. Sprawdzaj `docker compose logs`.
- arm64 nie jest sprawdzone; `full` na arm64 nie zadziała.
