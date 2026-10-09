# Network Usage Control — benchmark wydania 2.2.0

Pomiar: 9 października 2026, Linux, Node 26.10.0, benchmark v3 w wariancie
standardowym. Pełne wyniki walidacji opisuje [raport wydania](release-2.2.0-validation.md).
Nie uruchamiano testów ani przeglądarek równolegle z benchmarkiem.

## Metoda

`npm run benchmark:network` używa wyłącznie fixture HTTP na loopback, bez proxy.
Każda próba działa w świeżym procesie z `--expose-gc`; serwer ma osobny proces,
więc CPU/pamięć dotyczą klienta. Baseline i Unlimited mają te same ustawienia
Axios. Każda z trzech par ma sześć naprzemiennych prób, ze zmianą kolejności.
Raportowane wyniki są medianami. Rozgrzewka i wstępne GC są poza pomiarem.

- Strumień: 24 odpowiedzi po 16 MiB, 12 odpowiedzi rozgrzewki.
- Buforowanie: 768 odpowiedzi po 256 KiB, 96 odpowiedzi rozgrzewki.
- RSS: 96 odpowiedzi po 219029 B, po 100 wpisów; 12 odpowiedzi rozgrzewki.
  Obejmuje rzeczywisty parser RSS, bez schedulera, cache i dostarczania.
- Profile ograniczane: pojedyncze próby Potato, Medium, Custom upload i mieszanego
  Custom. Oprócz pomiaru istnieją deterministyczne testy token bucket.

Opcja `--steady` zwiększa rozgrzewkę buforowania do 1536 odpowiedzi, a pomiar
do 3072 odpowiedzi; nie była używana w tej serii. RSS pamięci jest próbkowane
co 10 ms i raportowane jako przyrost po rozgrzewce, nie całkowite zużycie procesu.

## Wyniki

| Obciążenie Unlimited | Narzut czasu | Narzut CPU | Dodatkowy CPU/odpowiedź |
| --- | --- | --- | --- |
| Strumień 16 MiB | 6.81% | 5.12% | 1.4947 ms |
| Buforowanie 256 KiB | 9.83% | 9.43% | 0.1669 ms |
| Pobranie i parsowanie RSS | 0.46% | -5.27% | -0.3514 ms |

| Profil | Limit DL/UL Mbps | Zmierzony DL/UL Mbps | Czas ms | CPU ms | Przyrost peak RSS MiB |
| --- | --- | --- | --- | --- | --- |
| potato | 0.01/— | 0.01/0 | 3999.87 | 90.16 | 0.38 |
| medium | 10/— | 10.0378/0 | 2507.11 | 126.03 | 5.93 |
| custom-upload | 2/0.2 | 0/0.1998 | 2402.59 | 63.99 | 0.25 |
| custom | 2/0.2 | 0.7949/0.159 | 1509.65 | 52.27 | 0.38 |


Ujemne różnice mogą wynikać z rozrzutu pomiarów; nie dowodzą przyspieszenia.
Unlimited ma mierzalny koszt transportu. Wynik dla parsera RSS nie zastępuje
pomiaru transportu i nie dowodzi uniwersalnie pomijalnego narzutu.

Wartości Mbps są dziesiętne. Mieszany Custom obejmuje oczekiwanie na upload przed
odpowiedzią, dlatego nie jest pomiarem nasyconego downloadu. Rezerwacja uploadu
odbywa się dla całego znanego body przed wysłaniem, więc chwilowe bursty są możliwe.
Loopback nie odwzorowuje opóźnień i konkurencji w WAN.

## Regresje funkcjonalne

Pełny suite obejmuje współdzielenie download/upload między żądaniami,
Friendly Mode, zmiany profilu aktywnego transferu, retry/429/Retry-After,
throttling-aware timeouty, backpressure, przerwane odpowiedzi i shutdown.
Testy Network API i Chromium sprawdzają presety, niezależny Custom, rewizje,
rzeczywisty stan workera i status offline. Realne testy Scrapling sprawdzają
403 → browser fallback, zasoby, per-URL override i sprzątanie procesów.

Zliczane są zakodowane body HTTP, nie cały ruch interfejsu. Strumieniowy/multipart
upload i replay przekierowań nie podlegają pacingowi. Ruch Pythona/przeglądarki
ma politykę zasobów i współbieżności, ale nie limit Node ani szacowane liczniki
bajtów. Windows/macOS, zewnętrzne CDP i żywe dostarczenia do providerów nie były
testowane. [Adaptive Mode pozostaje decyzją badawczą](network-adaptive-decision.md).

## Odtworzenie

```bash
npm ci
mkdir -p benchmark-results
node scripts/benchmark-network.cjs > benchmark-results/network-2.2.0.json
```

Surowy JSON zawiera wszystkie próbki, mediany, zakresy i metadane runtime.
Lokalne wyniki są ignorowane przez Git i nie wchodzą do source release.
