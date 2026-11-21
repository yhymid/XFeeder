# Zasady bezpieczeństwa

[English](SECURITY.md) · **Polski**

## Zgłaszanie

Użyj prywatnego zgłaszania podatności na GitHubie dla tego repozytorium albo skontaktuj
się prywatnie z opiekunem. Nigdy nie dołączaj do zgłoszenia prawdziwych tokenów, adresów
webhooków ani zawartości `.env`.

## Granice

- `config.json`, `.env`, cache i zrzuty telemetrii są zapisywane z uprawnieniami `0600`;
  trzymaj folder z danymi jako prywatny i poza katalogami serwera WWW.
- Dashboard domyślnie nasłuchuje na `127.0.0.1`. Wystawienie go (host inny niż loopback
  albo `XFEEDER_DASHBOARD_PUBLIC_ORIGIN`) wymaga `XFEEDER_DASHBOARD_PASSWORD`; postaw go
  za HTTPS. Nagłówki Host i Origin są sprawdzane, a żądania zmieniające stan wymagają
  zgodnego originu.
- `network.outboundPolicy: "public-only"` blokuje adresy prywatne i z sieci lokalnej (DNS
  jest sprawdzany przy łączeniu) oraz wyłącza proxy i Scrapling dla niezaufanych list
  feedów. Nie zastępuje firewalla.
- Logi i zdarzenia aktywności maskują tokeny webhooków, tokeny botów i wrażliwe parametry
  adresów; identyfikatory kanałów i feedów w telemetrii są hashowane.
- Uszkodzony albo niezapisywalny cache zatrzymuje wysyłkę, zamiast ryzykować duplikaty.
  Przywróć go z kopii; uszkodzony plik zostaje jako `*.corrupt-<sha256>`.
- Treść feedów jest niezaufana. Uruchamiaj jednego workera na jeden cache.
