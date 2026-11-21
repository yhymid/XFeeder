# XFeeder + Scrapling: przewodnik anty-bot

[English](ANTI_BOT_GUIDE.md) · **Polski**

Praktyczne ustawienie ochrony anty-bot w XFeederze ze Scraplingiem.

## 1) Co robi potok XFeedera

`src/feed.rs` działa etapami:

1. Zwykłe HTTP (GET z ponowieniami przy chwilowych błędach).
2. Analiza odpowiedzi (status, nagłówki, treść, tytuł i rozmiar treści).
3. Jeśli sygnały wskazują blokadę: kolejne tryby Scraplinga (`ModeOrder`), z `stealthy-fetch`
   na początku przy sygnałach Cloudflare/WAF; każda próba jest sprawdzana, a potok
   zatrzymuje się na pierwszym prawdziwym sukcesie.

Ważne: sprawdzanie nie ufa samemu `status=200`. To kluczowe przy stronach z wyzwaniem
i „miękkich” blokadach.

## 2) Logika anty-bot

Pola `Scrapling.AntiBot`:

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

Wykrywanie w `src/scrapling.rs` (powody w logu decyzji):

- sygnały „mocne”: `status:<kod>`, `header:antibot:<nagłówki>`, `body:challenge`, `title:challenge`
- sygnały „słabe”: `header:cloudflare` i `body:small:<bajty>`
- wynik: `score` (0–100) i `blocked` na podstawie sygnałów i progu `MinConfidence`

To ogranicza fałszywe alarmy dla zwykłych stron za Cloudflare (same nagłówki Cloudflare
nie są traktowane jako twarda blokada).

## 3) Dlaczego tak (zgłoszenia w Scraplingu)

- Issue #46/#47: wyzwanie przechodzi, ale strona nie jest gotowa → potrzebny `waitSelector`.
- Issue #100: przypadek brzegowy osadzonego Turnstile.
- Issue #126: problemy puli stron przy dużej równoległości.
- Issue #191: najpierw sukces, potem kolejne blokady Cloudflare (stabilność sesji/proxy).
- Issue #261: ciche porażki typu `HTTP 200` + udawane 404 albo prawie pusta treść.
- Discussion #73 (DataDome): wykrywalność mimo trybu stealth.
- Discussion #266: różnica między podstawowym a enterprise Cloudflare.

Wniosek dla XFeedera:

- nie ufać samemu kodowi HTTP,
- zawsze sprawdzać kształt treści,
- traktować anty-bot osobno dla każdej domeny (nie jedno ustawienie dla wszystkich).

## 4) Profile na start

### A) Podstawowy Cloudflare

- `ModeOrder`: `["fetch", "stealthy-fetch"]`
- `MaxAttempts`: `2` albo `3`
- `solveCloudflare: true`
- `timeoutMs >= 60000`
- `waitSelector` na docelowy element

### B) Osadzony/niestandardowy Turnstile

- `ModeOrder`: `["stealthy-fetch"]`
- `timeoutMs`: `90000-120000`
- `waitSelector` obowiązkowo
- `MinConfidence`: podnieść (np. `50`), żeby odfiltrować pozorne sukcesy

### C) Cięższe WAF (DataDome/Akamai)

- `ModeOrder`: `["fetch", "stealthy-fetch"]`
- `dnsOverHttps: true`, `blockAds: true`
- dobre proxy (residential/mobile), rotacja (`proxyRotator`) i ograniczenie tempa
- dopasowanie sygnatur dla adresu (`BodySignatures`, `TitleSignatures`)

## 5) Szybsza alternatywa

Dla podstawowego Cloudflare `Scrapling.ReuseClearance: true` (tymczasowe) zapisuje
ciasteczko po pierwszym przejściu przeglądarki, a kolejne sprawdzenia idą zwykłym HTTP
(na boop.pl 8–11 ms zamiast ~25 s). Zobacz [README](README.pl.md).

## 6) Diagnostyka na produkcji

Włącz:

- `Scrapling.AntiBot.LogDecisions = true`

Obserwuj:

- `score` i powody decyzji anty-bot,
- czy odpowiedź ma prawdziwą treść (tytuł, długość, oczekiwane elementy),
- czy blokad przybywa z czasem (sygnał stałego odcisku przeglądarki/IP),
- czy ponowienia i ścieżki zapasowe nie kosztują za dużo czasu.

`xfeeder preview <URL> --bench 5` pokazuje, czy feed szedł przez Scrapling i ile to trwało.

## 7) Ograniczenia

Anty-bot nie gwarantuje 100% skuteczności, szczególnie przy enterprise WAF. Często
potrzeba:

- lepszej klasy proxy,
- wolniejszego tempa,
- osobnych profili dla domen,
- czasem zewnętrznego narzędzia anty-bot (np. `Solver` z FlareSolverr).
