# XFeeder

Lekki feeder RSS/Atom/JSON z wysyłką do Discord webhooków i Matrix oraz prostym dashboardem do edycji `config.json` i `.env`.

## Najważniejsze zmiany w tej wersji

- `--dry-run` i `--once` do bezpiecznych lokalnych testów bez publikacji na produkcję.
- `--check-config` do szybkiej walidacji configu przed wdrożeniem.
- Worker odczytuje `config.json` i `.env` z dysku w kolejnych cyklach, więc zmiany z dashboardu są podchwytywane bez restartu procesu.
- Dashboard ma logowanie hasłem i nie pozwala wystawić zdalnego hosta bez `XFEEDER_DASHBOARD_PASSWORD`.
- Cache działa per target, więc awaria Matrix nie powoduje ponownej wysyłki na webhook, który już dostał wpis.

## Szybki start lokalnie

1. Uzupełnij `config.json` i `.env`.
2. Sprawdź config bez uruchamiania kolejki:

```bash
npm run check-config
```

3. Zrób bezpieczny lokalny przebieg bez publikacji:

```bash
npm run start:dry-run
```

4. Uruchom dashboard lokalnie:

```bash
npm run dashboard
```

Domyślnie dashboard nasłuchuje na `127.0.0.1:3000`.

## Dashboard na VPS

Jeśli dashboard ma być dostępny poza localhost:

1. ustaw `XFEEDER_DASHBOARD_PASSWORD`,
2. trzymaj go za reverse proxy,
3. najlepiej nie wystawiaj go bezpośrednio do internetu.

Przykładowe zmienne w `.env.example`:

```env
XFEEDER_DASHBOARD_PASSWORD=CHOOSE_A_STRONG_PASSWORD
XFEEDER_DASHBOARD_HOST=127.0.0.1
XFEEDER_DASHBOARD_PORT=3000
```

Healthcheck dashboardu:

```text
GET /api/health
```

## Tryby uruchamiania workera

```bash
node main.js
node main.js --once
node main.js --dry-run --once
node main.js --check-config
node main.js --config ./config.json --cache ./cache.json
```

## Skrypty npm

- `npm start` - normalny worker
- `npm run start:once` - pojedynczy przebieg
- `npm run start:dry-run` - bezpieczny lokalny test bez publikacji
- `npm run check-config` - walidacja configu
- `npm run dashboard` - dashboard
- `npm test` - testy jednostkowe

## Wdrożenie na VPS

Najbezpieczniejszy flow:

1. lokalnie `npm run check-config`
2. lokalnie `npm run start:dry-run`
3. po akceptacji wrzutka na VPS
4. restart workera i dashboardu
5. sprawdzenie `/api/health`

## systemd

Przykładowe unity są w katalogu [`deploy/systemd`](./deploy/systemd).
