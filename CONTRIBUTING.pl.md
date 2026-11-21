# Współtworzenie

[English](CONTRIBUTING.md) · **Polski**

```sh
cargo fmt
cargo clippy --all-targets
cargo test
```

- Zachowaj zgodność `config.json`, `cache.json` i API dashboardu z istniejącymi
  instalacjami. Zmiany tożsamości wpisu albo kluczy cache powodują ponowne wysyłki
  albo utratę historii i wymagają migracji.
- Nigdy nie commituj `.env`, `config.json`, `cache*.json`, `*.runtime.json`, tokenów ani
  adresów webhooków. Korzystaj z danych testowych w `tests/fixtures`.
- Testuj na prawdziwych danych przez `--dry-run --once` (bez wysyłek i bez zapisu cache).
- Jedna zmiana zachowania na commit; opisz wpływ na zgodność.
