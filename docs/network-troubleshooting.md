# Network Usage Control — rozwiązywanie problemów

## Po aktualizacji

Istniejące konfiguracje bez `network` zachowują **Unlimited** i dotychczasową
współbieżność. Nie jest wymagana migracja plików. Uruchom `node main.js --check-config`.
Ustawienia są dostępne w **Settings → Network**, a także w JSON:
[pełny model konfiguracji](network-control.md).

## Potato pobiera feed bardzo długo

10 Kbps to 1250 bajtów/s, nie 10 KB/s. Feed 1 MB może potrzebować około 13 minut,
a kilka równoległych feedów dzieli ten sam budżet. To zamierzone. Wybierz Low,
Medium lub własny limit. Timeout idle pomija oczekiwanie na limiter, ale jawny
całkowity deadline nadal może przerwać transfer.

## Zapisano, ale profil nie jest jeszcze zastosowany

Dashboard i worker to oddzielne procesy. Worker obserwuje zmiany konfiguracji co
sekundę; metryki publikuje co 2 sekundy, a widok odczytuje je co 3 sekundy.
Daj im kilka sekund. „Applied by worker” oznacza zgodność zapisanego profilu
z ostatnim świeżym snapshotem rzeczywistego workera.

Przy „Worker status unavailable” sprawdź, czy worker działa w trybie kolejki,
czy dashboard i worker korzystają z tego samego katalogu/config.json oraz czy
konto workera może zapisywać plik `config.json.network-runtime.json` obok konfiguracji.
Plik ma tryb 0600; dashboard powinien działać jako ten sam użytkownik lub otrzymać
odpowiednio nadane prawa do odczytu. Brak, błąd odczytu lub snapshot starszy niż
6,5 sekundy daje „unavailable”, a nie sztuczne zerowe transfery. `--once` i
`--check-config` nie uruchamiają tego raportowania. Liczniki resetują się z procesem.
Obsługiwany jest jeden worker na plik konfiguracji.

## Konflikt zapisu

Inny edytor/karta zmienił konfigurację. API odrzuca starą rewizję (HTTP 412),
zachowując lokalny draft. Skopiuj potrzebne zmiany, odśwież z dysku i nanieś je
na nową wersję. „Save network” zapisuje tylko sieć, pozostawiając inne lokalne
zmiany niezapisane; górny „Save changes” zapisuje cały formularz.

## Upload nadal wysyła krótkie bursty

Custom upload kontroluje wspólny budżet **przed wysłaniem** znanego body, a następnie
przekazuje niezmieniony JSON/Buffer. Jest to pacing wiadomości, nie rozciąganie
każdego pakietu. Dla małych wiadomości Discord/Telegram jest prosty i przewidywalny.
Limit downloadu i uploadu są niezależne. Presety poza Custom pozostawiają upload
bez limitu. Stream, FormData/multipart i wewnętrzne ponowne wysłanie body przy
redirect nie są pace'owane; te ograniczenia są jawne w API i Advanced.
Nie traktuj tego ustawienia jako dokładnego limitu całego uploadu hosta.

## Metryki różnią się od monitora systemowego

XFeeder liczy zakodowane body odpowiedzi odczytane przez transport i body żądań
przekazane transportowi. Nie liczy nagłówków, TLS, retransmisji TCP ani ponowień
body wewnątrz redirectów. Upload nie oznacza potwierdzenia odbioru przez serwer.
Retry HTTP jest nowym transferem i jest liczony raz dla każdej rzeczywistej próby.
Gzip jest liczony przed dekompresją. Transfery są przybliżeniem z pięciosekundowego
okna, więc zanikają stopniowo po ustaniu ruchu. Bufory socketu mogą wyprzedzać limiter.

Bajty przeglądarki Scrapling są **niedostępne**, nie zero i nie „oszczędzone bajty”.
Ruch Chromium/Pythona nie przechodzi przez limiter Node. Resource Saving i bramka
współbieżności ograniczają jego aktywność innymi sposobami. Jeśli strona wymaga
CSS/WebSocketów, użyj [wyłączenia lub override per URL](scrapling-resource-saving.md).

## Friendly Mode nie gwarantuje niskiego pingu

Friendly zmniejsza współbieżność oraz rozsuwa ciężkie zadania/retry. Nie jest QoS
routera ani systemu, nie nadaje priorytetów pakietom gier i nie kontroluje innych
aplikacji. Automatyczne wykrywanie obciążenia nie zostało włączone:
[TDR dla TASK 14](network-adaptive-decision.md).

## Diagnostyka i testy

```bash
npm test
node main.js --check-config
npm run benchmark:network
PLAYWRIGHT_MODULE=/path/to/playwright-core XFEEDER_BROWSER_PATH=/path/to/chromium npm run test:network-browser
```

Benchmark korzysta wyłącznie z loopback i raportuje konfigurację, przybliżone
pasmo, odchylenie, CPU i pamięć. Czasy CPU obejmują klienta i lokalny serwer.
Nie uruchamiaj innych obciążających testów w tym samym czasie. Wynik na loopback
nie jest gwarancją pasma na Wi-Fi/Internet; interpretację opisuje
[raport benchmarku](network-benchmark.md).
