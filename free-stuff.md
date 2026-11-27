# Free stuff: free games and Game Pass

[← Index](README.md) · [Polski](free-stuff.pl.md)

Checked **2026-11-23** with anonymous GET requests, market **PL / PLN**. All sources are official store backends. Only Xbox Wire is a real RSS feed; everything else is JSON and needs an adapter.

## Summary

| Store | Official source | What it gives | End date? | Status | Fallback |
|---|---|---|---|---|---|
| Epic Games | https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=PL&allowCountries=PL | current and upcoming free games, PLN prices, images | ✅ start + end | ✅ 200 | https://store.epicgames.com/en-US/free-games |
| Steam: free to keep | `https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json=…` (below) | appids with a 99–100 % discount | ✅ via GetItems | ✅ 200 | `store.steampowered.com/search/results/?maxprice=free&specials=1&infinite=1&cc=pl` |
| Steam: free weekend | https://store.steampowered.com/api/featuredcategories/?cc=pl&l=english + GetItems `free_weekend` | featured free weekends | ✅ | ✅ 200 | — |
| GOG | https://catalog.gog.com/v1/catalog?limit=48&price=between:0,0&discounted=eq:true&productType=in:game,pack,dlc&countryCode=PL&locale=en-US&currencyCode=PLN&order=desc:trending&page=1 | 100 %-off titles | ❌ no end date | ✅ 200 | homepage giveaway block (HTML) |
| Xbox PC Game Pass | `https://catalog.gamepass.com/sigls/v2?id=<LIST>&language=en-us&market=PL` | id lists (no dates) | ❌ compare lists between polls | ✅ 200 | Xbox Wire RSS https://news.xbox.com/en-us/feed/ |
| Prime Gaming / Luna | none: JS app with a private API | — | — | ❌ | — |
| Ubisoft / EA freebies | none public | — | — | ❌ | — |

Community sources are **not** usable without a browser: SteamDB returns 403 to bots, and r/FreeGameFindings RSS returns 404 or 429.

## Epic Games

- The feed **also contains normal sales**. `discountPercentage` is the percentage **you pay**, so free means:
  - a `promotions.promotionalOffers[].promotionalOffers[]` entry with `discountSetting.discountPercentage == 0`,
  - `startDate <= now < endDate`,
  - and `price.totalPrice.discountPrice == 0`.
- Upcoming offers are in `upcomingPromotionalOffers` with the same structure. One game can have several offers, so check them all.
- If `originalPrice == 0`, it is a free-to-play game placed in the promo slot. Label it, or skip it.
- Store link: `https://store.epicgames.com/en-US/p/<slug>`. Take the slug from:
  1. `offerMappings[pageType=productHome].pageSlug`
  2. else `catalogNs.mappings[…].pageSlug`
  3. else `productSlug`
  - Never use `urlSlug` when it is a 32-character hex id.
- Images: `keyImages[type=OfferImageWide]` for the big image, `OfferImageTall` / `Thumbnail` for the small one.
- The offer changes every Thursday at 16:00 UTC. Mystery games around December have not been checked yet.
- Dedupe key: `epic:<id>:<startDate>`.

## Steam

Free to keep. This needs no API key. Use `min_discount_percent: 99`, because **100 is ignored** and returns all 325k items:

```
https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json={"query":{"start":0,"count":50,"filters":{"price_filters":{"min_discount_percent":99},"type_filters":{"include_apps":true,"include_dlc":true}}},"context":{"language":"english","country_code":"PL","steam_realm":1},"data_request":{"include_basic_info":true,"include_assets":true,"include_all_purchase_options":true}}
```

Details for any appid:

```
https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={"ids":[{"appid":<APPID>}],"context":{"language":"english","country_code":"PL","steam_realm":1},"data_request":{"include_assets":true,"include_release":true,"include_platforms":true,"include_all_purchase_options":true,"include_basic_info":true}}
```

GetItems returns:
- `best_purchase_option.final_price_in_cents`, `original_price_in_cents`, `formatted_*` (e.g. "62,69 zł");
- `active_discounts[].discount_end_date` (unix time: "free until");
- `free_weekend {start_time, end_time}`;
- `assets.asset_url_format`, which gives images under `https://shared.akamai.steamstatic.com/store_item_assets/`.

How to tell the offers apart:

| Offer | Condition |
|---|---|
| Free to keep | `final == 0` and `original > 0` |
| Free weekend | the price is not 0, but `free_weekend` is set |
| Free DLC | free to keep, and the item type is not "game" |
| Permanent free-to-play | `is_free` set: **ignore** |

Dedupe key: `steam:<appid>:<discount_end_date | free_weekend.start_time>`.

## GOG

- `price=between:0,0` alone returns permanently free items (demos, F2P), so always add `discounted=eq:true`.
- Free means `price.finalMoney.amount == "0.00"` and `baseMoney.amount > 0`. The link is in `storeLink`.
- The API has no end date, so track when each item was first and last seen.
- `www.gog.com/en/games/ajax/filtered` is **dead** (404).
- The giveaway claim endpoint needs a login (401). Giveaway banners can only be read from the homepage HTML, which has not been checked during a live giveaway.
- Helpers:
  - `https://api.gog.com/products/<id>?locale=en-US`
  - `https://api.gog.com/products/<id>/prices?countryCode=PL`
- Dedupe key: `gog:<id>:<first_seen_date>`.

## Xbox PC Game Pass

The lists contain ids only and no dates, so new items are found by comparing the id set with the previous poll. The **PC lists differ from the console lists**:

| List | PC list id | Console list id |
|---|---|---|
| All PC Game Pass (no EA Play) | `fdd9e2a7-0fee-49f6-ad69-4354098401ff` | `f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e` |
| All, including EA Play | `609d944c-d395-4c0a-9ea4-e9f39b52c1ad` | — |
| Recently added | **`3fdd7f57-7092-4b65-bd40-5a9dac1b2b84`** | `f13cf6b4-57e6-4459-89df-6aec18cf0538` |
| Coming soon | **`4165f752-d702-49c8-886b-fb57936f6bae`** | `095bda36-f5cd-43f2-9ee1-0a72f371fb96` |
| Leaving soon | **`cc7fc951-d00f-410e-9e02-5e4628e04163`** | `393f05bf-e596-4ef6-9487-6d4fa0eab987` |
| EA Play | **`1d33fbb9-b895-4732-a8ca-a55c8b99fa2c`** | `b8900d09-a491-44cc-916e-32b5acae621b` |

- The list ids come from community knowledge, but their titles and contents were checked on 2026-11-23. Microsoft can change them, so warn when a list returns 404 or its `title` changes.
- Titles and images for ids:
  - Endpoint: `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<id1>,<id2>&market=PL&languages=en-us&MS-CV=DGU1mcuYo0WMMp+F.1`.
  - Batch about 10 ids per call; responses are large.
  - Cache the results, because ids never change.
- Fields:
  - `LocalizedProperties[0].ProductTitle` and `ShortDescription`.
  - `Images[]`: the Uri starts with `//`, so prefix `https:`. `TitledHeroArt` is the best image for a post.
  - PC or console: `PlatformDependencies[].PlatformName`, where `Windows.Desktop` means PC.
- Store link: `https://www.xbox.com/en-US/games/store/<slug>/<BigId>`.
- Dedupe key: `gp:<list>:<BigId>`.

## Suggested post

- **Author:** the store name.
- **Title:** "FREE: \<game\>", linked to the store.
- **Body:** a short description.
- **Fields:**
  - "Free until": Discord time `<t:UNIX:F>`, which shows in each reader's own time zone.
  - Original price, crossed out, next to 0 zł.
  - Type: free to keep / free weekend / free DLC / Game Pass.
- **Image:** wide art.
- **Footer:** the source.
