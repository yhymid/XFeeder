# XFeeder 3.1 - Tracker Update

[English](Instruction.md) · **Polski**

XFeeder wysyła nowe wpisy z RSS, Atom, JSON Feed, YouTube, GitHuba i Steama na webhooki
Discorda i na Telegram. Ta paczka jest gotowa do uruchomienia: jeden program, nic więcej
nie trzeba instalować.

## Co jest w paczce

| Plik | Co to jest |
|---|---|
| `XFeeder` | Program (Linux x86_64, statyczny: działa na każdej dystrybucji, bez Node.js, bez bibliotek). |
| `config.json.example` | Przykładowa konfiguracja: kanały, feedy i ustawienia. |
| `.env.example` | Przykładowy plik sekretów: adresy webhooków i tokeny. |
| `systemd/` | Pliki usług do uruchomienia XFeedera i dashboardu 24/7. |
| `dashboard-tunnel.sh` | Otwiera dashboard z serwera na Twoim komputerze przez SSH. |
| `scrapling/requirements.lock.txt` | Opcjonalnie: wersje przeglądarki, która przechodzi przez Cloudflare. |
| `CHANGELOG.md`, `LICENSE` | Co się zmieniło w 3.1 i licencja MIT. |

Pełna dokumentacja (opis każdego ustawienia) jest na GitHubie:
<https://github.com/yhymid/XFeeder/tree/main/docs> (pliki `*.pl.md` po polsku).

## 1. Start w pięć minut

```sh
unzip XFeeder.zip -d xfeeder && cd xfeeder
cp config.json.example config.json
cp .env.example .env
chmod 600 .env config.json
```

1. Na Discordzie: **Ustawienia serwera → Integracje → Webhooki → Nowy webhook**, wybierz
   kanał, **Kopiuj adres URL webhooka**.
2. Wpisz go do `.env`:

   ```sh
   DISCORD_WEBHOOK_MAIN=https://discord.com/api/webhooks/123.../abc...
   ```

3. W `config.json`, w `channels` → `main` → `Feeds`, wpisz swoje feedy (linki RSS/Atom,
   `https://www.youtube.com/feeds/videos.xml?channel_id=...`,
   `https://github.com/WLASCICIEL/REPO/commits/main.atom`, ...). Usuń grupę `channels2`,
   jeśli nie potrzebujesz drugiego kanału.
4. Sprawdź i przetestuj:

   ```sh
   ./XFeeder --check-config      # błędy i ostrzeżenia
   ./XFeeder --dry-run --once    # pobiera wszystko, nic nie wysyła
   ```

5. Uruchom:

   ```sh
   ./XFeeder
   ```

Pierwsze sprawdzenie feedu tylko **zapamiętuje** jego obecne wpisy, żeby kanał nie został
zasypany starymi postami. Od tej chwili każdy nowy wpis jest wysyłany. Jeśli chcesz od
razu dostać najnowszy wpis, ustaw `"FirstRunSend": 1` w `Settings`.

Zmiany w `config.json` i `.env` działają same, bez restartu. Zatrzymanie: `Ctrl+C`.

## 2. Praca 24/7 przez systemd (serwer)

```sh
sudo useradd --system --home /var/lib/xfeeder --shell /usr/sbin/nologin xfeeder
sudo install -d -m 0700 -o xfeeder -g xfeeder /var/lib/xfeeder
sudo install -m 0755 XFeeder /usr/local/bin/xfeeder
sudo install -m 0600 -o xfeeder -g xfeeder config.json .env /var/lib/xfeeder/
sudo cp systemd/xfeeder.service systemd/xfeeder-dashboard.service /etc/systemd/system/
sudo usermod -aG systemd-journal xfeeder          # strona Logi w dashboardzie może czytać log
sudo systemctl daemon-reload
sudo systemctl enable --now xfeeder
sudo systemctl enable --now xfeeder-dashboard     # opcjonalnie: dashboard WWW
journalctl -u xfeeder -f                          # log na żywo
```

Usługa dashboardu startuje, zatrzymuje się i restartuje razem z `xfeeder`. Żeby użyć
innego folderu albo użytkownika, najpierw zmień ścieżki i `User=` w obu plikach usług.

Uruchamiaj tylko **jeden** XFeeder na jeden `cache.json`.

## 3. Dashboard

Strona WWW do podglądu i edycji XFeedera: kanały, posty, logi, wykresy, diagnostyka i
ustawienia. Bez JavaScriptu.

- Na własnym komputerze: `./XFeeder dashboard --data-dir .` i otwórz
  <http://127.0.0.1:3000/>.
- Na serwerze nasłuchuje tylko na `127.0.0.1` serwera. Ze swojego komputera:

  ```sh
  SSH_KEY=~/.ssh/twoj_klucz ./dashboard-tunnel.sh user@serwer
  # otwórz http://127.0.0.1:3000/   (Ctrl+C zamyka tunel)
  ```

- Żeby był dostępny z sieci, najpierw ustaw hasło: odkomentuj
  `XFEEDER_DASHBOARD_PASSWORD` w `.env` z własną wartością i ustaw
  `XFEEDER_DASHBOARD_HOST=0.0.0.0`. Za HTTPS także
  `XFEEDER_DASHBOARD_PUBLIC_ORIGIN=https://twoja.domena`. Przy systemd zmień
  `XFEEDER_DASHBOARD_HOST` w `xfeeder-dashboard.service`: wartości ustawione tam mają
  pierwszeństwo przed `.env`.

Przełącznik **EN · PL** w prawym górnym rogu zmienia język.

## 4. Opcjonalnie: strony blokujące boty (Cloudflare)

Większość feedów działa bez tego. Jeśli feed odpowiada `403`, zainstaluj raz przeglądarkę
w folderze z `config.json` (potrzebny Python 3.10+):

```sh
python3 -m venv scrapling/.venv
scrapling/.venv/bin/pip install --no-deps -r scrapling/requirements.lock.txt
scrapling/.venv/bin/python -m playwright install chromium
scrapling/.venv/bin/python -m patchright install chromium
```

Potem w `config.json` ustaw `"Scrapling": { "Enabled": true, ... }` i dodaj blokowany
feed do `Scrapling.PerUrlConfig` z `"fallback": true` (najpierw zwykłe pobranie,
przeglądarka tylko przy blokadzie). Zrestartuj XFeedera.

## 5. Telegram

Utwórz bota przez @BotFather, wpisz `TELEGRAM_BOT_TOKEN` i `TELEGRAM_CHAT_ID` do `.env` i
ustaw `"Telegram": { "Enabled": true, ... }` w `config.json`.

## 6. Aktualizacja

**Z 2.x (Node.js):** zatrzymaj starą wersję, wrzuć `XFeeder` do tego samego folderu i
uruchom. `config.json`, `.env` i `cache.json` są czytane bez zmian; nic nie zostanie
wysłane ponownie. `node_modules`, `package.json` i pliki `.js` nie są już potrzebne.

**Z wersji 3.0 (albo wcześniejszej 3.x):** w `config.json` ani `.env` nic nie trzeba zmieniać i nic starego nie zostanie wysłane ponownie.

```sh
cp cache.json cache.json.backup
sudo install -m 0755 XFeeder /usr/local/bin/xfeeder
sudo systemctl restart xfeeder        # restartuje też dashboard
```

## 7. Polecenia

| Polecenie | Co robi |
|---|---|
| `./XFeeder` | Uruchamia workera (sprawdza feedy i wysyła). |
| `./XFeeder --check-config` | Sprawdza `config.json` i `.env`, potem kończy. |
| `./XFeeder --dry-run --once` | Jedna pełna runda bez wysyłania i zapisywania. |
| `./XFeeder preview <URL>` | Pokazuje, co XFeeder czyta z feedu i ile to trwa. |
| `./XFeeder rerender --apply` | Przebudowuje wysłane posty na Discordzie w obecnym wyglądzie. |
| `./XFeeder dashboard --data-dir .` | Uruchamia dashboard WWW. |
| `./XFeeder --help`, `--version` | Pomoc i wersja. |

## 8. Pliki, które tworzy XFeeder

`cache.json` (co już zostało wysłane; **rób kopię**), `cache.feeds.json` (stan feedów),
`sent.json` (wysłane posty na Discordzie, do edycji), `*.runtime.json` (dane dla
dashboardu), a jeśli włączone: `diagnostics/`, `scrapling/`, `clearance.json`,
`requests/`.

## 9. Częste problemy

| Problem | Rozwiązanie |
|---|---|
| `missing delivery target` | Kanał nie ma webhooka albo nazwy `${...}` nie ma w `.env`. |
| Z nowego feedu nic nie przychodzi | Tak ma być: pierwsze sprawdzenie tylko zapamiętuje. Użyj `FirstRunSend`. |
| Feed zwraca 403 | Strona blokuje boty: zob. punkt 4. |
| `400 Unknown Channel` z Discorda | Webhook albo wątek został usunięty: utwórz nowy webhook. |
| Posty przychodzą z opóźnieniem | Zmniejsz `TimeChecker` (minuty) dla tego kanału albo włącz `Settings.AdaptivePolling`. |
| `Permission denied` przy starcie | `chmod +x XFeeder`. |

Więcej: <https://github.com/yhymid/XFeeder/blob/main/docs/configuration.pl.md>.
