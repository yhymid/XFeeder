# Za darmo: darmowe gry i Game Pass

[← Spis](README.pl.md) · [English](free-stuff.md)

Sprawdzone **2026-11-23** anonimowymi zapytaniami GET, rynek **PL / PLN**. Wszystkie źródła to oficjalne backendy sklepów. Tylko Xbox Wire to prawdziwy feed RSS; cała reszta to JSON i wymaga adaptera.

## Podsumowanie

| Sklep | Oficjalne źródło | Co daje | Data końca? | Stan | Zapasowe |
|---|---|---|---|---|---|
| Epic Games | https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=PL&allowCountries=PL | obecne i nadchodzące darmowe gry, ceny w PLN, obrazki | ✅ początek + koniec | ✅ 200 | https://store.epicgames.com/en-US/free-games |
| Steam: na zawsze | `https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json=…` (niżej) | AppID ze zniżką 99–100 % | ✅ przez GetItems | ✅ 200 | `store.steampowered.com/search/results/?maxprice=free&specials=1&infinite=1&cc=pl` |
| Steam: darmowy weekend | https://store.steampowered.com/api/featuredcategories/?cc=pl&l=english + GetItems `free_weekend` | wyróżnione darmowe weekendy | ✅ | ✅ 200 | — |
| GOG | https://catalog.gog.com/v1/catalog?limit=48&price=between:0,0&discounted=eq:true&productType=in:game,pack,dlc&countryCode=PL&locale=en-US&currencyCode=PLN&order=desc:trending&page=1 | tytuły ze zniżką 100 % | ❌ bez daty końca | ✅ 200 | blok rozdawnictwa na stronie głównej (HTML) |
| Xbox PC Game Pass | `https://catalog.gamepass.com/sigls/v2?id=<LIST>&language=en-us&market=PL` | listy id (bez dat) | ❌ porównywać listy między sprawdzeniami | ✅ 200 | RSS Xbox Wire https://news.xbox.com/en-us/feed/ |
| Prime Gaming / Luna | brak: aplikacja JS z prywatnym API | — | — | ❌ | — |
| Darmowe gry Ubisoftu / EA | brak publicznego | — | — | ❌ | — |

Źródeł społeczności **nie da się** używać bez przeglądarki: SteamDB zwraca botom 403, a RSS r/FreeGameFindings zwraca 404 albo 429.

## Epic Games

- Feed **zawiera też zwykłe promocje**. `discountPercentage` to procent, który **płacisz**, więc „za darmo” oznacza:
  - wpis `promotions.promotionalOffers[].promotionalOffers[]` z `discountSetting.discountPercentage == 0`,
  - `startDate <= teraz < endDate`,
  - oraz `price.totalPrice.discountPrice == 0`.
- Nadchodzące oferty są w `upcomingPromotionalOffers` o tej samej strukturze. Jedna gra może mieć kilka ofert, więc sprawdzaj wszystkie.
- Jeśli `originalPrice == 0`, to gra free-to-play wstawiona w miejsce promocji. Oznacz ją albo pomiń.
- Link do sklepu: `https://store.epicgames.com/en-US/p/<slug>`. Slug weź z:
  1. `offerMappings[pageType=productHome].pageSlug`
  2. a jeśli go nie ma, z `catalogNs.mappings[…].pageSlug`
  3. a jeśli i tego nie ma, z `productSlug`
  - Nigdy nie używaj `urlSlug`, gdy jest 32-znakowym id szesnastkowym.
- Obrazki: `keyImages[type=OfferImageWide]` na duży obrazek, `OfferImageTall` / `Thumbnail` na mały.
- Oferta zmienia się w każdy czwartek o 16:00 UTC. Gier-niespodzianek z okolic grudnia jeszcze nie sprawdzono.
- Klucz do odsiewania duplikatów: `epic:<id>:<startDate>`.

## Steam

Na zawsze za darmo. Nie trzeba klucza API. Używaj `min_discount_percent: 99`, bo **100 jest ignorowane** i zwraca wszystkie 325 tys. pozycji:

```
https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json={"query":{"start":0,"count":50,"filters":{"price_filters":{"min_discount_percent":99},"type_filters":{"include_apps":true,"include_dlc":true}}},"context":{"language":"english","country_code":"PL","steam_realm":1},"data_request":{"include_basic_info":true,"include_assets":true,"include_all_purchase_options":true}}
```

Szczegóły dowolnego AppID:

```
https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={"ids":[{"appid":<APPID>}],"context":{"language":"english","country_code":"PL","steam_realm":1},"data_request":{"include_assets":true,"include_release":true,"include_platforms":true,"include_all_purchase_options":true,"include_basic_info":true}}
```

GetItems zwraca:
- `best_purchase_option.final_price_in_cents`, `original_price_in_cents`, `formatted_*` (np. „62,69 zł”);
- `active_discounts[].discount_end_date` (czas unix: „za darmo do”);
- `free_weekend {start_time, end_time}`;
- `assets.asset_url_format`, który daje obrazki pod `https://shared.akamai.steamstatic.com/store_item_assets/`.

Jak odróżnić oferty:

| Oferta | Warunek |
|---|---|
| Na zawsze za darmo | `final == 0` i `original > 0` |
| Darmowy weekend | cena nie jest 0, ale `free_weekend` jest ustawione |
| Darmowe DLC | na zawsze za darmo, a typ pozycji to nie „game” |
| Stałe free-to-play | ustawione `is_free`: **ignoruj** |

Klucz do odsiewania duplikatów: `steam:<appid>:<discount_end_date | free_weekend.start_time>`.

## GOG

- Samo `price=between:0,0` zwraca pozycje darmowe na stałe (dema, F2P), więc zawsze dodawaj `discounted=eq:true`.
- Za darmo oznacza `price.finalMoney.amount == "0.00"` i `baseMoney.amount > 0`. Link jest w `storeLink`.
- API nie ma daty końca, więc zapisuj, kiedy każdą pozycję zobaczono pierwszy i ostatni raz.
- `www.gog.com/en/games/ajax/filtered` jest **martwe** (404).
- Endpoint odbierania rozdawnictwa wymaga logowania (401). Banery rozdawnictwa da się odczytać tylko z HTML strony głównej, czego nie sprawdzono w czasie trwającego rozdawnictwa.
- Pomocnicze:
  - `https://api.gog.com/products/<id>?locale=en-US`
  - `https://api.gog.com/products/<id>/prices?countryCode=PL`
- Klucz do odsiewania duplikatów: `gog:<id>:<first_seen_date>`.

## Xbox PC Game Pass

Listy zawierają tylko id, bez dat, więc nowe pozycje znajduje się przez porównanie zbioru id z poprzednim sprawdzeniem. **Listy PC różnią się od list konsolowych**:

| Lista | id listy PC | id listy konsolowej |
|---|---|---|
| Cały PC Game Pass (bez EA Play) | `fdd9e2a7-0fee-49f6-ad69-4354098401ff` | `f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e` |
| Wszystko, z EA Play | `609d944c-d395-4c0a-9ea4-e9f39b52c1ad` | — |
| Ostatnio dodane | **`3fdd7f57-7092-4b65-bd40-5a9dac1b2b84`** | `f13cf6b4-57e6-4459-89df-6aec18cf0538` |
| Wkrótce | **`4165f752-d702-49c8-886b-fb57936f6bae`** | `095bda36-f5cd-43f2-9ee1-0a72f371fb96` |
| Wkrótce znikną | **`cc7fc951-d00f-410e-9e02-5e4628e04163`** | `393f05bf-e596-4ef6-9487-6d4fa0eab987` |
| EA Play | **`1d33fbb9-b895-4732-a8ca-a55c8b99fa2c`** | `b8900d09-a491-44cc-916e-32b5acae621b` |

- Id list pochodzą z wiedzy społeczności, ale ich tytuły i zawartość sprawdzono 2026-11-23. Microsoft może je zmienić, więc ostrzegaj, gdy lista zwróci 404 albo zmieni się jej `title`.
- Tytuły i obrazki dla id:
  - Endpoint: `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<id1>,<id2>&market=PL&languages=en-us&MS-CV=DGU1mcuYo0WMMp+F.1`.
  - Około 10 id na wywołanie; odpowiedzi są duże.
  - Zapisuj wyniki, bo id się nie zmieniają.
- Pola:
  - `LocalizedProperties[0].ProductTitle` i `ShortDescription`.
  - `Images[]`: Uri zaczyna się od `//`, więc dodaj `https:`. `TitledHeroArt` to najlepszy obrazek do posta.
  - PC czy konsola: `PlatformDependencies[].PlatformName`, gdzie `Windows.Desktop` oznacza PC.
- Link do sklepu: `https://www.xbox.com/en-US/games/store/<slug>/<BigId>`.
- Klucz do odsiewania duplikatów: `gp:<list>:<BigId>`.

## Proponowany post

- **Autor:** nazwa sklepu.
- **Tytuł:** „ZA DARMO: \<gra\>”, z linkiem do sklepu.
- **Treść:** krótki opis.
- **Pola:**
  - „Za darmo do”: czas Discorda `<t:UNIX:F>`, który każdy czytelnik widzi we własnej strefie czasowej.
  - Cena oryginalna, przekreślona, obok 0 zł.
  - Rodzaj: na zawsze / darmowy weekend / darmowe DLC / Game Pass.
- **Obrazek:** szeroka grafika.
- **Stopka:** źródło.
