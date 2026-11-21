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
usługi (`chmod 600`). Worker tworzy tam też `cache.feeds.json`, `sent.json`, pliki
telemetrii `*.runtime.json` i, jeśli Scrapling jest zainstalowany, folder `scrapling/`.

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

Usługa dashboardu nasłuchuje na `127.0.0.1:3000` serwera. Bez
`XFEEDER_DASHBOARD_PASSWORD` odmawia adresu innego niż lokalny, więc jest
dostępna tylko przez SSH. Ze swojego komputera:

```sh
SSH_KEY=~/.ssh/moj_klucz scripts/dashboard-tunnel.sh user@serwer
# Dashboard: http://127.0.0.1:3000/  (Ctrl+C zamyka)
```

Tunel działa na pierwszym planie; po zamknięciu nic nie zostaje uruchomione.
Dashboard czyta `config.json` i `.env` z katalogu danych, więc uruchamiaj go
jako ten sam użytkownik co worker. Widzi workera uruchomionego przez systemd i
zamiast przycisków start/stop pokazuje polecenie `systemctl`.

Usługa dashboardu jest przypięta do workera (`PartOf=` i
`WantedBy=xfeeder.service`): włącz ją raz przez
`sudo systemctl enable xfeeder-dashboard`, a od tej pory startuje przy starcie
systemu oraz zatrzymuje się i restartuje razem z `xfeeder`. Po aktualizacji
pliku binarnego wystarczy `sudo systemctl restart xfeeder`.

## Sprawdzenie przed startem

```sh
xfeeder --check-config --config /ścieżka/config.json
xfeeder --dry-run --once --config /ścieżka/config.json --cache /ścieżka/cache.json
```

Próba wypisuje każdy wpis, który zostałby wysłany; przy istniejącym cache powinna
pokazać tylko naprawdę nowe wpisy.

## Aktualizacja

```sh
git pull && cargo build --release --locked
sudo systemctl restart xfeeder
```

Przed aktualizacją zrób kopię `cache.json`.
