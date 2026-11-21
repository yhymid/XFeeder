# Wdrożenie

[English](deployment.md) · **Polski**

Buduj na docelowej maszynie (albo na takiej z tą samą lub starszą glibc). Plik zbudowany
na dystrybucji rolling-release może nie wystartować na starszym Ubuntu/Debianie przez
wersje symboli glibc.

## Budowanie ze źródeł

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
git clone https://github.com/yhymid/XFeeder.git
cd XFeeder
cargo build --release --locked
install -m 0755 target/release/xfeeder /usr/local/bin/xfeeder   # albo zostaw na miejscu
```

## Folder z danymi

Trzymaj `config.json`, `.env` i `cache.json` razem, czytelne tylko dla użytkownika
usługi (`chmod 600`). Wszystko inne XFeeder tworzy tam sam:

| Plik | Kto zapisuje | Co zawiera |
|---|---|---|
| `config.json` | Ty, dashboard | Kanały i ustawienia ([przewodnik konfiguracji](configuration.pl.md)). |
| `.env` | Ty, dashboard | Adresy webhooków, tokeny i inne sekrety. |
| `cache.json` | worker | Historia wysyłek: które wpisy każdy cel już dostał. **Rób kopię.** Bez niej każdy feed zaczyna od nowa: jego obecne wpisy są oznaczane jako widziane (poza najnowszymi `FirstRunSend`). |
| `cache.feeds.json` | worker | Stan feedów: walidatory (ETag, Last-Modified), ostatnia kopia, kondycja. Można usunąć. |
| `sent.json` | worker | ID wiadomości i wpisy 2000 najnowszych postów na Discordzie, do edycji (`rerender`, `SteamMerge`). Bez adresów webhooków. |
| `clearance.json` | worker | Zapisane ciasteczka Cloudflare (`Scrapling.ReuseClearance`). Usuń, żeby zapomnieć wszystkie. |
| `config.json.*-runtime.json` | worker | Migawki telemetrii dla dashboardu, nadpisywane co 2 s. |
| `requests/` | dashboard | Prośby czekające na workera (Sprawdź teraz, Zapomnij); opróżniany co 30 s. |
| `diagnostics/` | worker | Pliki zdarzeń i raporty (`Settings.Diagnostics`). |
| `scrapling/` | worker, Ty | Skrypt przeglądarki i jego `.venv` ([Scrapling](../scrapling/README.pl.md)). |
| `config.json.bak`, `.env.bak` | dashboard | Poprzednia wersja po zapisie z dashboardu. |
| `*.corrupt-*` | worker | Kopia pliku stanu, którego nie dało się odczytać. Zob. niżej. |

Gdy `cache.json` nie da się odczytać, worker kopiuje go do `cache.json.corrupt-<sha256>` i
nie startuje, żeby nic nie poszło dwa razy. Przywróć dobrą kopię i uruchom go ponownie.

## systemd

Szablony: [`deploy/systemd/xfeeder.service.example`](../deploy/systemd/xfeeder.service.example)
i [`xfeeder-dashboard.service.example`](../deploy/systemd/xfeeder-dashboard.service.example).

```sh
sudo cp deploy/systemd/xfeeder.service.example /etc/systemd/system/xfeeder.service
sudoedit /etc/systemd/system/xfeeder.service   # ścieżki, User=
sudo systemctl daemon-reload
sudo systemctl enable --now xfeeder
journalctl -u xfeeder -f
```

Uruchamiaj dokładnie **jednego** workera na jeden `cache.json`.

### Dashboard

```sh
sudo cp deploy/systemd/xfeeder-dashboard.service.example /etc/systemd/system/xfeeder-dashboard.service
sudoedit /etc/systemd/system/xfeeder-dashboard.service   # te same ścieżki i User= co worker
sudo usermod -aG systemd-journal xfeeder                 # opcjonalnie: strona Logi czyta dziennik
sudo systemctl daemon-reload
sudo systemctl enable --now xfeeder-dashboard
```

Usługa dashboardu jest przypięta do workera (`PartOf=` i `WantedBy=xfeeder.service`):
po włączeniu startuje przy starcie systemu razem z `xfeeder` oraz zatrzymuje się i
restartuje razem z nim. Czyta `config.json` i `.env` z katalogu danych, więc uruchamiaj
ją jako ten sam użytkownik co worker. Widzi workera uruchomionego przez systemd i zamiast
przycisków start/stop pokazuje polecenie `systemctl`.

Usługa nasłuchuje na `127.0.0.1:3000` serwera. Bez `XFEEDER_DASHBOARD_PASSWORD` odmawia
adresu innego niż lokalny, więc jest dostępna tylko przez SSH. Ze swojego komputera:

```sh
SSH_KEY=~/.ssh/moj_klucz scripts/dashboard-tunnel.sh user@serwer        # port lokalny 3000
SSH_KEY=~/.ssh/moj_klucz scripts/dashboard-tunnel.sh user@serwer 8080   # inny port lokalny
# Dashboard: http://127.0.0.1:3000/  (Ctrl+C zamyka)
```

Tunel działa na pierwszym planie; po zamknięciu nic nie zostaje uruchomione. Wszystko,
co potrafi dashboard, opisuje [przewodnik po dashboardzie](dashboard.pl.md).

## Sprawdzenie przed startem

```sh
xfeeder --check-config --config /ścieżka/config.json
xfeeder --dry-run --once --config /ścieżka/config.json --cache /ścieżka/cache.json
```

Próba wypisuje każdy wpis, który zostałby wysłany; przy istniejącym cache powinna
pokazać tylko naprawdę nowe wpisy.

## Aktualizacja

```sh
cp cache.json cache.json.before-update           # w folderze z danymi
git pull && cargo build --release --locked
sudo install -m 0755 target/release/xfeeder /usr/local/bin/xfeeder
sudo systemctl restart xfeeder                   # restartuje też dashboard
journalctl -u xfeeder -n 50
```
