# Źródła XFeedera: skąd brać aktualizacje gier, sterowników i aplikacji

[English](README.md) · **Polski**

W tej gałęzi **nie ma kodu bota**. Jest tu posegregowana baza linków do śledzenia aktualizacji: patch notes, sterowniki, darmowe gry, listy zmian silników i narzędzi AI. Przy każdym wpisie są: skąd pochodzą dane, w jakim formacie, jak je filtrować i czy działały przy ostatnim sprawdzeniu.

Kod bota jest w gałęziach [`main`](https://github.com/yhymid/XFeeder/tree/main) i [`Beta`](https://github.com/yhymid/XFeeder/tree/Beta).

Szczegółowe pliki są po angielsku, bo adresy, pola i formaty i tak są angielskie. Ten plik to polski spis treści.

## Spis treści

| Plik | Co jest w środku | Wpisów |
|---|---|---|
| [games/steam.md](games/steam.md) | Gry na Steamie: trzy źródła Steama, odróżnianie łatek od newsów, obrazki i wszystkie gry ze sprawdzonym AppID | 195 gier |
| [games/publishers.md](games/publishers.md) | Gry spoza Steama albo z lepszym źródłem niż Steam: Riot, Blizzard, Mojang, HoYoverse, EA, Ubisoft, Activision, Epic, Bungie, Jagex, GGG, Wargaming, Square Enix i inni | 49 gier |
| [free-stuff.md](free-stuff.md) | Darmowe gry: Epic, Steam (do zatrzymania i darmowe weekendy), GOG, Xbox PC Game Pass (nowe / wkrótce / znikające / EA Play) | 4 sklepy |
| [drivers.md](drivers.md) | NVIDIA Game Ready / Studio / Linux, AMD Radeon i chipset, Intel Arc i Arc Pro, Mesa | 9 źródeł |
| [ai.md](ai.md) | Claude, ChatGPT / OpenAI, Gemini, GitHub Copilot, Cursor, Ollama, OpenClaw, Grok, Artificial Analysis | 17 źródeł |
| [game-dev.md](game-dev.md) | Unreal Engine, Unity, Roblox, Blender, OBS Studio, Godot (4.x / 3.x, stabilne / testowe), s&box | 7 narzędzi |
| [notes/feed-quirks.md](notes/feed-quirks.md) | Dziwactwa prawdziwych feedów: formaty, daty, blokady, limity odpytywania | — |

## Zasady bazy

1. **Najpierw źródła oficjalne.** Kanał, API albo strona wydawcy zawsze są na pierwszym miejscu. Kanały społeczności mogą zniknąć w każdej chwili, więc są tylko zapasem i są tak oznaczone.
2. **Każdy link został otwarty.** W wierszu jest kod HTTP i data sprawdzenia. Niesprawdzone przypuszczenia mają ❓ albo „not tested”.
3. **Żadnych danych skopiowanych z innych botów.** Istnieją podobne boty na Discorda, ale nic tutaj nie pochodzi z ich stron, katalogów, tekstów ani ikon. Każde źródło należy do wydawcy.
4. **Tylko publiczne zapytania GET.** Bez logowania, kluczy API, prywatnych API i obchodzenia płatnych dostępów.

## Oznaczenia

| Znak | Znaczenie |
|---|---|
| ✅ 200 | otwarte w dniu sprawdzenia, zwróciło to, co opisano |
| ⚠️ | działa, ale jest kruche: format często się zmienia albo dane są niepełne |
| ❌ | brak oficjalnego źródła albo blokada |
| ❓ | jeszcze niezbadane |
| ↪ | przekierowanie: trzeba wpisać nowy adres |
| **RSS / Atom** | XFeeder czyta to już dziś, najwyżej z wpisem w `Filters` |
| JSON / NEXT / HTML / MD | potrzebny adapter w XFeederze (planowany): czysty JSON, JSON w `__NEXT_DATA__`, lista w HTML albo lista zmian w Markdown |

## Jak użyć linku w XFeederze już teraz

Każdy wiersz oznaczony **RSS** albo **Atom** wpisujesz po prostu do listy feedów kanału w `config.json`. Jeśli wiersz podaje filtr, dodajesz też filtr:

```json
{
  "Webhook": "${DISCORD_WEBHOOK_MAIN}",
  "RSS": ["https://github.com/ollama/ollama/releases.atom"],
  "Filters": { "Exclude": ["/-rc\\d+/"], "Fields": ["title"] }
}
```

Każda gra ze Steama działa tak samo, przez RSS sklepu: `https://store.steampowered.com/feeds/news/app/<AppID>/`.

Źródła JSON, HTML i Markdown są tu opisane, żeby mogły z nich korzystać planowane trackery XFeedera.

## Aktualizowanie

- Ostatnie pełne sprawdzenie: **2026-11-23**.
- Gdy link przestanie działać, dopisz w jego wierszu nowy status i datę zamiast go kasować. Dzięki temu widać historię.
- Przy nowym źródle zapisz: adres, format, jak odróżnić łatki od innych postów, stały identyfikator do rozpoznawania duplikatów, otrzymany kod HTTP i źródło zapasowe.
