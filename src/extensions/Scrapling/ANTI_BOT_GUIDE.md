# XFeeder + Scrapling Anti-Bot Guide

Ten dokument opisuje praktyczne wdrozenie Anti-Bot w XFeederze po integracji Scrapling.

## 1) Co robi pipeline XFeedera

Sciezka `src/parsers/downloader.js` dziala etapowo:

1. Klasyczny HTTP (`getWithFallback`).
2. Analiza odpowiedzi (status + naglowki + body + title + rozmiar body).
3. Jesli sygnaly wskazuja blokade: eskalacja trybow Scrapling (`ModeOrder`) z adaptacyjnym priorytetem `stealthy-fetch` dla sygnalow Cloudflare/WAF, walidacja kazdej proby i zatrzymanie na pierwszym realnym sukcesie.

Wazne: walidacja nie ufa samemu `status=200`. To kluczowe przy stronach challenge/soft-block.

## 2) Logika Anti-Bot (aktualna)

Konfiguracja `Scrapling.AntiBot`:

- `Enabled`
- `LogDecisions`
- `PreferStealthOnSignals`
- `ModeOrder`
- `StatusCodes`
- `HeaderKeys`
- `BodySignatures`
- `TitleSignatures`
- `MinBodyBytes`
- `MinConfidence`
- `TreatCloudflareAsSignal`
- `MaxAttempts`

Detekcja w `src/extensions/Scrapling/utils.js`:

- sygnaly "mocne": `statusBlocked`, `headerBlocked`, `bodyBlocked`, `titleBlocked`
- sygnaly "slabe": `cloudflare` marker i `bodyTooSmall`
- wynik: `score` (0-100) i `blocked` na bazie sygnalow + progu `MinConfidence`

To ogranicza false-positive dla normalnych stron hostowanych za Cloudflare (same naglowki Cloudflare nie sa juz traktowane jako twardy blok).

## 3) Dlaczego tak (dowody z upstream)

Problemy raportowane w Scrapling:

- Issue #46/#47: challenge przechodzi, ale strona nie jest gotowa -> potrzebny `wait_selector`.
- Issue #100: edge-case embedded Turnstile.
- Issue #126: problemy page-pool przy duzej rownoleglosci.
- Issue #191: sukces poczatkowy, potem kolejne blokady Cloudflare (stabilnosc sesji/proxy).
- Issue #261: ciche porazki typu `HTTP 200` + fake 404 / prawie puste body.
- Discussion #73 (DataDome): wykrywalnosc mimo stealth.
- Discussion #266: roznica miedzy basic Cloudflare i enterprise Cloudflare.

Wniosek praktyczny dla XFeedera:

- nie ufac samemu kodowi HTTP,
- zawsze walidowac content shape,
- traktowac anti-bot jako flow per-domena (nie one-size-fits-all).

## 4) Profile startowe

### A) Cloudflare basic

- `ModeOrder`: `["fetch", "stealthy-fetch"]`
- `MaxAttempts`: `2` lub `3`
- `solveCloudflare: true`
- `timeoutMs >= 60000`
- `waitSelector` na element docelowy

### B) Embedded/niestandardowy Turnstile

- `ModeOrder`: `["stealthy-fetch"]`
- `timeoutMs`: `90000-120000`
- `waitSelector` obowiazkowo
- `MinConfidence`: podniesc (np. `50`) by odfiltrowac pseudo-sukcesy

### C) Ciezsze WAF (DataDome/Akamai)

- `ModeOrder`: `["fetch", "stealthy-fetch"]`
- `dnsOverHttps: true`, `blockAds: true`
- dobre proxy (residential/mobile), rotacja (`proxyRotator`) i ograniczenie rate
- per-url tuning sygnatur (`BodySignatures`, `TitleSignatures`)

## 5) Runtime i opcje Scrapling

- `runtimeMode: "cli"` -> 1:1 zgodnosc z `scrapling extract ...`.
- `runtimeMode: "shell"` -> rozszerzone opcje API fetcherow (np. `proxyRotator`, `maxPages`, dodatkowe mapowania snake_case/camelCase).

Dla domen trudnych anti-bot preferuj `shell` + `stealthy-fetch` + per-url config.

## 6) Diagnostyka w produkcji

Wlacz:

- `Scrapling.AntiBot.LogDecisions = true`

Obserwuj:

- `score` i `reasons` z decyzji anti-bot,
- czy odpowiedz ma realny content (title, body length, expected selectors),
- czy blokady rosna wraz z czasem (sygnal stalego fingerprintu/IP),
- czy retry/fallback nie powoduje zbyt duzego kosztu i opoznienia.

## 7) Ograniczenia

Anti-Bot nie gwarantuje 100% bypassu, szczegolnie dla enterprise WAF.
Czesto potrzeba:

- lepszej klasy proxy,
- wolniejszego tempa,
- oddzielnych profili per domena,
- czasem zewnetrznego stacku anty-bot.
