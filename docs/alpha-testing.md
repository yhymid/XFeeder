# XFeeder 3.0.0-alpha.0 — testy na fizycznym sprzęcie

To wczesny build do **testów użytkowych na Linuxie** (Arch Linux / CachyOS). Nie instaluj go na katalogu działającego XFeeder 2.2.0 i nie używaj do krytycznych dostaw.

## Pobranie i weryfikacja

1. Otwórz [GitHub Releases](https://github.com/yhymid/XFeeder/releases/tag/v3.0.0-alpha.0).
2. Pobierz `XFeeder-3.0.0-alpha.0-linux-runtime.tar.gz` i `SHA256SUMS.txt`.
3. Zweryfikuj i rozpakuj:

```bash
cd ~/Downloads
sha256sum -c SHA256SUMS.txt
mkdir -p ~/Apps
tar -xzf XFeeder-3.0.0-alpha.0-linux-runtime.tar.gz -C ~/Apps
cd ~/Apps/XFeeder-3.0.0-alpha.0
```

Jeżeli pobrałeś również inne pliki do katalogu, weryfikacja może wymagać uruchomienia polecenia z katalogu, w którym znajduje się archiwum.

## Uruchomienie na Arch/CachyOS

Wymagane: Node.js 22 lub 24 (testowany również Node 26), npm, internet do pobrania zależności. Opcjonalnie Python 3.14 oraz przeglądarka dla Scrapling.

```bash
node --version
npm --version
npm ci
cp config.json.example config.json
cp .env.example .env
npm run check-config
npm run start:dry-run
```

**Pusty starter config nie wygeneruje wiadomości.** Edytuj lokalny `config.json` i `.env`, dodaj jeden prawdziwy feed RSS/Atom/JSON oraz własny testowy webhook Discord lub Telegram. Nie umieszczaj sekretów w zgłoszeniach błędów.

Test docelowy:

```bash
npm run start:once
npm run start:once
```

Pierwsze uruchomienie ma wysłać nowe wpisy (limit `RequestSend`); powtórzenie **nie powinno wysyłać tych samych wpisów**. To są prawdziwe wiadomości, dlatego użyj osobnego kanału testowego. Aby przetestować długą pracę:

```bash
npm start
```

W drugim terminalu uruchom:

```bash
cd ~/Apps/XFeeder-3.0.0-alpha.0
XFEEDER_DASHBOARD_PASSWORD='ustaw-silne-wlasne-haslo' npm run dashboard
```

Panel: http://127.0.0.1:3000. Sprawdź aktywność i ustawienia; `/api/live` odpowiada za serwer dashboardu, a `/api/ready` za gotowość workera.

Opcjonalny Scrapling:

```bash
npm run scrapling:install
npm run scrapling:check
```

## Co testować

- Instalacja z **pobranej paczki**, nie z repozytorium.
- Poprawność RSS/Atom/JSON oraz deduplikacji przy dwóch `--once`.
- Restart workera i zachowanie `cache.json` / `cache.feeds.json`.
- Discord i Telegram osobno oraz równocześnie; częściowe błędy.
- Dashboard, Activity, Metrics, zmiany ustawień.
- Proxy, Network Usage Control, `MaxConcurrentChannels`, Scrapling (jeżeli włączone).
- SIGINT (Ctrl+C), czyste zamknięcie bez utraty cache.

**Nie kopiuj starego cache bez kopii bezpieczeństwa.** Przy migracji do alpha najpierw skopiuj `config.json`, `.env`, `cache.json` i `cache.feeds.json` do nowego katalogu oraz zachowaj ich oryginały. Stary format feed snapshotów może zostać zmigrowany.

## Zgłaszanie problemów

Otwórz [GitHub Issues](https://github.com/yhymid/XFeeder/issues) i podaj: `3.0.0-alpha.0`, OS, Node/npm, rodzaj feedu, oczekiwany/faktyczny wynik oraz kroki odtworzenia. Usuń z logów tokeny, adresy webhooków, prywatne feedy i dane kont.

Ten build nie gwarantuje pełnej funkcjonalności 3.0 ani zgodności produkcyjnej. Jego celem jest umożliwienie testów na realnym sprzęcie i zbieranie regresji przed kolejną alphą.
