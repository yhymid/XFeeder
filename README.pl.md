<div align="center">

# XFeeder

[English](README.md) · **Polski**

**Newsy, aktualizacje gier, commity i filmy na Discordzie i Telegramie w chwili, gdy się pojawią.**

</div>

XFeeder to jeden program działający na Twoim serwerze. Każdy kanał w `config.json` ma listę
feedów (RSS, Atom, JSON Feed, YouTube, GitHub, Steam) i miejsce, gdzie trafiają posty
(webhook Discorda, czat na Telegramie). XFeeder sprawdza każdy feed co ustalony czas,
zostawia to, co przechodzi przez filtry kanału, wysyła wpisy, których jeszcze nie wysłał,
i zapisuje je na dysku, więc po restarcie nic nie przychodzi drugi raz. Zmiany w
`config.json` i `.env` działają bez restartu; panel WWW pokazuje i zmienia te same ustawienia.

<div align="center">

![Rust](https://img.shields.io/badge/Rust-1.88%2B-orange?logo=rust)
![Version](https://img.shields.io/badge/version-3.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

<table>
  <tr>
    <td align="center"><img src="docs/showcase/blogs-v2.jpg" width="260" height="411" alt="Wpisy z blogów na Discordzie"><br><sub>Blogi</sub></td>
    <td align="center"><img src="docs/showcase/github-commits-v2.jpg" width="260" height="411" alt="Commity z GitHuba na Discordzie"><br><sub>Commity z GitHuba</sub></td>
    <td align="center"><img src="docs/showcase/valve-tracker-v2.jpg" width="260" height="411" alt="Aktualizacje Valve / Counter-Strike 2 na Discordzie"><br><sub>Valve tracker</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/showcase/facepunch-tracker-v2.jpg" width="260" height="411" alt="Aktualizacje Facepunch s&amp;box na Discordzie"><br><sub>Facepunch tracker</sub></td>
    <td align="center"><img src="docs/showcase/steam-v2.jpg" width="260" height="411" alt="Ogłoszenia ze Steama na Discordzie"><br><sub>Newsy ze Steama</sub></td>
    <td align="center"><img src="docs/showcase/youtube-v2.jpg" width="260" height="411" alt="Nowe filmy z YouTube na Discordzie"><br><sub>YouTube</sub></td>
  </tr>
</table>

## Dlaczego XFeeder

- **Jeden mały plik.** Napisany w Rust: bez Node.js, nic nie trzeba instalować obok. Obrazy Dockera są opcjonalne ([docs/docker.pl.md](docs/docker.pl.md)).
- **Lekki.** Około 35 MB pamięci i 1,5 % CPU przy 10 kanałach i 32 feedach.
- **Nigdy nie wysyła dwa razy.** Historia wysyłek jest zapisywana osobno dla każdego celu
  i przetrwa awarie oraz restarty; nowy feed nie zasypuje kanału starymi wpisami.
- **Przechodzi przez Cloudflare.** Strony blokujące boty są pobierane prawdziwą przeglądarką
  (Scrapling) albo przez FlareSolverr, i tylko wtedy, gdy faktycznie blokują.
- **Dobrze wygląda na Discordzie.** Karty z obrazkiem, autorem i datą (Components V2), posty
  w wątkach forum; na Telegramie też ze zdjęciami.
- **Ty decydujesz, co idzie.** Filtry na kanał (słowa albo regex, maksymalny wiek wpisu)
  i interwały sprawdzania.
- **Bez restartów.** Zmiany w `config.json` i `.env` działają same.
- **Pokazuje, co jest wolne.** Diagnostyka 24/7 mierzy czas od publikacji do Discorda
  i podpowiada, co zmienić.
- **Panel WWW** bez JavaScriptu: kanały, posty, logi, wykresy i diagnostyka; edycja
  ustawień, sprawdzenie kanału od razu albo ponowne wysłanie wpisu.

**Źródła:** RSS, Atom, JSON Feed, kanały YouTube, GitHub (commity, issue, pull requesty,
wydania, gałęzie), newsy ze Steama i SteamDB, każda strona, która linkuje swój feed, kanały Discorda.
**Cele:** webhooki Discorda (kanały i wątki forum), Telegram (czaty, kanały, tematy).

## Szybka instalacja

Najprościej: pobierz `XFeeder.zip` z [Releases](https://github.com/yhymid/XFeeder/releases/latest),
rozpakuj i postępuj według `Instruction.pl.md` w środku (gotowy plik dla Linuksa x86_64). Ze źródeł:

```sh
cargo build --release
cp target/release/xfeeder .
cp config.json.example config.json
cp .env.example .env                  # tu wpisujesz adresy webhooków i tokeny
./xfeeder --check-config              # sprawdzenie configu
./xfeeder --dry-run --once            # próba: pobiera wszystko, nic nie wysyła
./xfeeder                             # uruchomienie
```

Najmniejszy działający `config.json`:

```json
{
  "channels": {
    "news": {
      "Webhook": "${DISCORD_WEBHOOK}",
      "RSS": ["https://example.com/feed.xml"]
    }
  }
}
```

Aktualizacja z 2.x: zostaw `config.json`, `.env` i `cache.json` i uruchom `xfeeder` w tym
samym folderze; nic nie zostanie wysłane ponownie.

## Instalacja w Dockerze

```sh
git clone https://github.com/yhymid/XFeeder && cd XFeeder
mkdir -p data
cp config.json.example data/config.json   # potem go edytuj
cp .env.example data/.env                 # webhooki, tokeny
sudo chown -R 65532:65532 data            # obrazy działają jako UID 65532
docker compose build && docker compose up -d
```

Trzy obrazy: `slim` (~17 MB), `scrapling` (z przeglądarką dla stron za Cloudflare) i `full`
(z SteamCMD dla `steampics://`). Szczegóły: [docs/docker.pl.md](docs/docker.pl.md).

## Omijanie Cloudflare

Każdy feed jest najpierw pobierany zwykłym zapytaniem. Dopiero gdy strona odpowie blokadą albo
stroną z wyzwaniem („Just a moment…”), XFeeder otwiera prawdziwą przeglądarkę przez
[Scrapling](scrapling/README.pl.md) albo pyta FlareSolverr, a zdobyte ciasteczko może
wykorzystać w zwykłych zapytaniach. Zmierzone na produkcji: boop.pl przez przeglądarkę to
około 26 s, z ciasteczkiem 8–11 ms. Przechodzi automatyczne sprawdzenie Cloudflare, nie
CAPTCHA, którą musi rozwiązać człowiek. Jak to działa: [docs/architecture.pl.md](docs/architecture.pl.md#jak-pobierane-są-strony-za-cloudflare);
krok po kroku: [przewodnik konfiguracji, poziom 3](docs/configuration.pl.md#poziom-3-trudny-strony-które-blokują-boty-cloudflare).

## Bez duplikatów

Każdy wpis dostaje identyfikator: klucz od źródła, a jeśli go nie ma, link bez parametrów
śledzących, guid albo skrót treści. Identyfikatory potwierdzonych wysyłek są zapisywane osobno
dla kanału i celu zaraz po każdej wysyłce, więc restart, awaria, poprawiony wpis ani link z
`?utm_source=` nie wysyłają niczego ponownie. Nowy feed nie wysyła starych wpisów albo tylko
najnowsze `FirstRunSend`. Przykłady i ograniczenia:
[docs/architecture.pl.md](docs/architecture.pl.md#jak-działa-nigdy-nie-wysyła-dwa-razy).

## Dokumentacja

| | |
|---|---|
| [Konfiguracja](docs/configuration.pl.md) | Ustawienie łatwe → średnie → trudne (Cloudflare) i opis każdej opcji |
| [Dashboard](docs/dashboard.pl.md) | Każda strona panelu WWW, dostęp przez SSH, bezpieczeństwo |
| [Docker](docs/docker.pl.md) | Trzy obrazy, folder danych, panel i buildy Steama w Dockerze |
| [Wdrożenie](docs/deployment.pl.md) | Budowanie na serwerze i uruchamianie przez systemd ([pliki unit](deploy/systemd)) |
| [Scrapling](scrapling/README.pl.md) | Instalacja przeglądarki dla stron blokujących boty |
| [Architektura](docs/architecture.pl.md) | Jak zorganizowany jest kod, jak XFeeder unika duplikatów, jak pobiera strony za Cloudflare |
| [Plan rozwoju](docs/roadmap.pl.md) | Co wzięto z podobnych projektów i co może dojść |
| [Lista zmian](CHANGELOG.md) | Co się zmieniło, z pomiarami (po angielsku) |

## Licencja

[MIT](LICENSE)
