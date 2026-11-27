# Sterowniki

[← Spis](README.pl.md) · [English](drivers.md)

Sprawdzone **2026-11-23** z domowego łącza, a kolumna 🖥 z VPS-a XFeedera (IP z centrum danych).

- Żaden producent GPU nie publikuje oficjalnego RSS ze sterownikami. Mesa to jedyny prawdziwy feed.
- Endpoint NVIDII to jej własny backend stron ze sterownikami. Nie ma publicznej dokumentacji.
- AMD i Intel to oficjalne strony renderowane po stronie serwera, więc mogą się czasem psuć. Trzymaj selektory w jednym miejscu i testuj je na zapisanych kopiach.

## Podsumowanie

| Sterownik | Oficjalne źródło | Format | Stałe id | User-Agent | Dom | 🖥 VPS |
|---|---|---|---|---|---|---|
| NVIDIA GeForce Game Ready | [DriverManualLookup, Game Ready](https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=120&pfid=929&osID=57&languageCode=1033&isWHQL=1&dch=1&sort1=0&numberOfResults=3) | JSON | `downloadInfo.ID` | dowolny | ✅ | ✅ |
| NVIDIA Studio | to samo, z `upCRD=1` i **bez** `isWHQL` | JSON | `ID` | dowolny | ✅ | nietestowane (ten sam host) |
| NVIDIA Linux x64 | [DriverManualLookup, Linux](https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=120&pfid=985&osID=12&languageCode=1033&isWHQL=0&numberOfResults=6&sort1=1) | JSON | `ID`, `DisplayVersion` | dowolny | ✅ | nietestowane (ten sam host) |
| AMD Radeon (Adrenalin) | https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/radeon-rx-9000-series/amd-radeon-rx-9070-xt.html | HTML | wersja, np. `26.11.2` | dom: tylko przeglądarka; VPS: dowolny | ✅ | ✅ |
| AMD Chipset | https://www.amd.com/en/support/downloads/drivers.html/chipsets/am5/x870e.html | HTML | rewizja, np. `8.09.28.1124` | jak wyżej | ✅ | nietestowane (ten sam host) |
| Intel Arc | https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html | HTML | wersja + id mirrora | dom: **tylko UA bota** (UA przeglądarki dostaje 403) | ✅ | ❌ **403 z każdym UA** |
| Intel Arc Pro | https://www.intel.com/content/www/us/en/download/741626/intel-arc-pro-graphics-windows.html | HTML (starszy układ) | wersja | jak Arc | ✅ | ❌ prawdopodobnie tak samo |
| Mesa | https://mesa3d.org/news/index.xml | **RSS**: XFeeder czyta go już dziś | `guid` | dowolny | ✅ | ✅ (stary adres `www.` odpowiada 308) |
| Intel compute-runtime (Linux) | https://github.com/intel/compute-runtime/releases.atom | **Atom** | — | dowolny | ✅ | — |

## NVIDIA

Parametry:

| Parametr | Wartość |
|---|---|
| `psid` / `pfid` | seria produktów / GPU. `120/929` = RTX 30 / RTX 3080. Każde obecne GPU dostaje ten sam sterownik Game Ready, więc wystarczy jeden model na rodzinę. |
| `osID` | 57 = Windows 10/11 64-bit, 135 = Windows 11, 12 = Linux 64-bit |
| Game Ready | `isWHQL=1` |
| Studio | `upCRD=1` **bez** `isWHQL`. Wpisy Studio są zapisane z `IsWHQL=0`, więc `isWHQL=1&upCRD=1` nic nie zwraca. |
| `isWHQL=0` | Game Ready i Studio razem |

- Tabele wartości:
  - systemy operacyjne: `https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=4`
  - GPU w serii: `…?TypeID=3&ParentID=120`
- Pola są w `IDS[0].downloadInfo`: `ID`, `Name`, `Version`, `DisplayVersion` (Linux), `ReleaseDateTime` („Thu Nov 12, 2026”), `DetailsURL`, `DownloadURL`, `DownloadURLFileSize`, `IsBeta`, `IsWHQL`, `IsCRD`, `IsRecommended`, `IsFeaturePreview`, `ReleaseNotes`, `BannerURL`.
- **Każde pole tekstowe jest zakodowane procentowo.** `ReleaseNotes` po zdekodowaniu to HTML z nagłówkiem i listami „Fixed Gaming / General Bugs”: gotowe najważniejsze zmiany.
- Gdy nic nie znajdzie, API i tak odpowiada HTTP 200, z `Success:"0"`. To znaczy „brak danych”, nie błąd.
- Gałęzie Linuksa: `IsRecommended=1` = produkcyjna, `IsFeaturePreview=1` = gałąź z nowymi funkcjami, `IsBeta=1` = beta. Używaj `DisplayVersion`, bo `Version` jest zniekształcone („595.1120”).
- **Nie używaj:**
  - `download.nvidia.com/XFree86/Linux-x86_64/latest.txt`: nieaktualny; pokazywał 580.126.09, gdy było już 620.73.04.
  - Kategorii „Announcements” na forum NVIDII: ostatni post w lutym 2024.
  - RSS newsów GeForce: zwracał 504.

## AMD

- Bez API i bez RSS. Na stronie produktu znajdź blok „AMD Software: Adrenalin Edition”, a potem wartości po etykietach „Revision Number”, „File Size” i „Release Date”.
- Release notes: `https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-<maj>-<min>-<patch>.html` (kropki zamienione na myślniki). Ma sekcje Highlights / New Game Support / Fixed Issues / Known Issues jako listy. Używaj `href` linku; jego `title` jest błędny.
- Release notes chipsetu: `RN-RYZEN-CHIPSET-<wersja z myślnikami>.html`. Jeden pakiet obejmuje każdy chipset Ryzen.
- W 1 z 4 pobrań z domu brakowało bloku sterownika. **Brak bloku znaczy „brak danych”, nigdy „sterownik usunięty”.**
- Strona z indeksem release notes wymaga JavaScriptu (Coveo), więc się nie nadaje.

## Intel

- Nowy układ (Arc): „Version 32.0.101.9175 WHQL Certified / November 4, 2026”.
- Stary układ (Arc Pro): „Date 9/25/2026 / Version 32.0.101.8976 - Q3.26 (Latest)”. Parser musi obsłużyć oba.
- Linki:
  - `https://downloadmirror.intel.com/<mirrorId>/gfx_win_101.<build>.exe`
  - `…/ReleaseNotes_<build>_WHQL.pdf`: najważniejsze zmiany są **tylko w tym PDF-ie**
  - `…/readme.txt`: wersja + data buildu, tanie drugie sprawdzenie
- **Z VPS-a obie strony zwracają 403** z UA przeglądarki i z UA XFeedera. Opcje: zapasowa przeglądarka Scrapling w XFeederze albo inne oficjalne źródło (jeszcze nie znalezione).
- Nie nadają się: feed danych DSA (ZIP z DLL-em) i stary RSS społeczności (przeniesiony).

## Linux

- Release notes Mesy: `https://docs.mesa3d.org/relnotes/<wersja>.html`. Archiwa: https://archive.mesa3d.org/.
- **Unikaj** `gitlab.freedesktop.org`: serwuje stronę antybotową (Anubis).
- Release notes oprogramowania AMD dla Linuksa nie są jeszcze zbadane.
