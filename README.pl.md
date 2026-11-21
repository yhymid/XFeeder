<div align="center">

# XFeeder

[English](README.md) · **Polski**

**Newsy, aktualizacje gier, commity i filmy na Discordzie i Telegramie w chwili, gdy się pojawią.**

![Rust](https://img.shields.io/badge/Rust-1.88%2B-orange?logo=rust)
![Version](https://img.shields.io/badge/version-3.0%20beta-blue)
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

- **Jeden mały plik.** Napisany w Rust: bez Node.js, bez Dockera, nic nie trzeba instalować obok.
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

## Szybki start

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

## Dokumentacja

| | |
|---|---|
| [Konfiguracja](docs/configuration.pl.md) | Ustawienie łatwe → średnie → trudne (Cloudflare) i opis każdej opcji |
| [Dashboard](docs/dashboard.pl.md) | Każda strona panelu WWW, dostęp przez SSH, bezpieczeństwo |
| [Wdrożenie](docs/deployment.pl.md) | Budowanie na serwerze i uruchamianie przez systemd ([pliki unit](deploy/systemd)) |
| [Scrapling](scrapling/README.pl.md) | Instalacja przeglądarki dla stron blokujących boty |
| [Architektura](docs/architecture.pl.md) | Jak zorganizowany jest kod |
| [Plan rozwoju](docs/roadmap.pl.md) | Co wzięto z podobnych projektów i co może dojść |
| [Lista zmian](CHANGELOG.md) | Co się zmieniło, z pomiarami (po angielsku) |

Aktualizacja z 2.x: zostaw `config.json`, `.env` i `cache.json` i uruchom `xfeeder` w tym
samym folderze; nic nie zostanie wysłane ponownie.

## Licencja

[MIT](LICENSE)
