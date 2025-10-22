# XFeeder 1.3 Workshop — Jak pisać własne pluginy (prosto i krok po kroku)

Poniżej znajdziesz prostą, praktyczną instrukcję tworzenia pluginów do XFeeder. Zaczynamy od “Quick Start”, potem krótkie wytłumaczenie API, gotowe szablony i częste problemy. Wszystko tak, aby w 3–5 minut uruchomić pierwszy plugin.

---

## Spis treści
- 0) Szybki start (3 minuty)
- 1) Gdzie wkleić pliki i jak działa loader
- 2) Jak wygląda plugin i co dostajesz w api
- 3) Jak zarejestrować parser (test + parse)
- 4) Jaki obiekt zwraca parser (Item) — format
- 5) Szablony do kopiuj-wklej
- 6) Konfiguracja pluginu w config.json
- 7) KV Storage (pamięć wtyczki)
- 8) Wysyłka do Discorda (kiedy i jak)
- 9) Dobre praktyki i debugowanie
- 10) Zaawansowane: niestandardowe schematy URL (np. apix://)
- 11) FAQ i najczęstsze problemy

---

## 0) Szybki start (3 minuty)

1. Utwórz plik w katalogu:
   - src/workshop/hello.plugin.js

2. Wklej szablon:
```js
module.exports = {
  id: "hello",
  enabled: true,
  init(api) {
    api.registerParser({
      name: "hello-parser",
      priority: 55, // przed RSS(60), po JSON(40–50)
      test: (url) => url.includes("example.com/hello"),
      parse: async (url, ctx) => {
        const res = await ctx.get(url);
        const data = res.data || {};
        const title = data.title || "Brak tytułu";
        return [{
          title,
          link: data.url || url,
          contentSnippet: (api.utils.stripHtml(data.description || "").result || "").slice(0, 500),
          isoDate: api.utils.parseDate(data.date || new Date().toISOString()),
          enclosure: data.image || null,
          author: data.author || null,
          guid: data.id || data.url || url,
          categories: data.tags || []
        }];
      }
    });
  }
};
```

3. W config.json dodaj adres pasujący do test:
```json
{
  "channels": [
    {
      "Webhook": "https://discord.com/api/webhooks/XXX/YYY",
      "RSS": ["https://example.com/hello"],
      "TimeChecker": 1,
      "RequestSend": 1
    }
  ],
  "Workshop": { "Enabled": true }
}
```

4. Odpal: node main.js
- W logach zobaczysz załadowanie pluginu i próbę parsowania URL z kanału.

To wszystko — masz działający plugin.

---

## 1) Gdzie wkleić pliki i jak działa loader

- Lokalizacja: wszystkie wtyczki umieszczamy w:
  - src/workshop
- Nazewnictwo: loader ładuje tylko pliki kończące się na:
  - .plugin.js (np. twitter.plugin.js, apix-custom.plugin.js)
- Pliki pomocnicze:
  - Możesz mieć obok własne moduły (parser.js, utils.js) i importować je w pluginie: require("./parser")
  - Loader automatycznie ładuje tylko .plugin.js
- Jak działa:
  - Nie tworzy katalogów i nie skanuje rekurencyjnie (tylko jeden poziom: src/workshop)
  - Loguje: [Workshop] Załadowano plugin: <id> (<plik>)
  - Możesz wyłączyć plugin ustawiając module.exports.enabled = false
- Kolejka parserów:
  - Najpierw parsery z pluginów (posortowane po priority), potem wbudowane:
    - YouTube(10), Atom(20), XML(30), JSON(40), ApiX(50), RSS(60), Fallback(90)

---

## 2) Jak wygląda plugin i co dostajesz w api

Plugin eksportuje obiekt lub funkcję. Najprościej:

```js
module.exports = {
  id: "my-plugin-id",
  enabled: true,       // opcjonalne; domyślnie true
  init(api) {          // lub: register(api), albo eksport funkcji zwracającej parser
    // rejestracja parserów
  }
};
```

W init(api) dostajesz:
- api.id — identyfikator pluginu (z id albo z nazwy pliku)
- api.http.get(url) — HTTP GET ze wspólnymi nagłówkami/proxy/fallbackami XFeedera
- api.utils:
  - parseDate(input) → ISO 8601 lub null
  - stripHtml(html) → { result: "oczyszczony tekst" }
- api.send(webhookUrl, threadId, entry) — ręczna wysyłka do Discorda (patrz sekcja 8)
- api.config — cały config.json (tylko do odczytu)
- api.log / api.warn / api.error — logi z prefiksem [WS:<pluginId>]
- api.kv — prosty storage per-plugin (plik: src/workshop/workshop-cache.json)
  - kv.get(key, default?)
  - kv.set(key, value)
  - kv.push(key, value, limit = 1000) — dopisz na początek z limitem
- api.registerParser(def) — rejestracja parsera (patrz niżej)

Obsługiwane formy pluginów (dowolna z poniższych):
- { id, init(api) { … } }
- { id, register(api) { … } }
- { id, parsers: [ { parse()… }, … ] }
- module.exports = (api) => ({ name, parse, … }) — funkcja zwracająca definicję parsera

---

## 3) Jak zarejestrować parser (test + parse)

Rejestrujesz parser:
```js
api.registerParser({
  name: "nazwa-do-logów",
  priority: 50,          // mniejsza liczba = wcześniej w kolejce
  test: (url, ctx) => true lub false (opcjonalne),
  parse: async (url, ctx) => [Item, Item, ...]
});
```

- priority — użyj, aby “wyprzedzić” parsery wbudowane:
  - < 60 wyprzedzisz RSS; > 90 staniesz się super-fallbackiem
- test(url, ctx) — szybki filtr. Zwróć false, gdy URL Cię nie dotyczy (oszczędza czas)
  - Tip: użyj new URL(url) w try/catch, bo nie każdy wpis w RSS to poprawny URL
- parse(url, ctx) — tu robisz HTTP i mapujesz dane na Item
  - ctx.get — to samo co api.http.get (HTTP GET ze wspólnymi nagłówkami/proxy/cooldownem)
  - ctx.api — pełne XFeederAPI, jeśli potrzebujesz (kv/utils/send/config)

Kiedy Twój parser zwróci tablicę Itemów:
- XFeeder je zdeduplikuje (po link dla feedów; po guid dla Discorda)
- wyśle tyle wpisów, ile ustawia RequestSend w configu, do Webhook i Thread danego kanału
- zapisze do cache (by nie wysyłać tego samego drugi raz)

---

## 4) Jaki obiekt zwraca parser (Item) — format

Każdy element w tablicy to obiekt:
```json
{
  "title": "string",
  "link": "string",
  "contentSnippet": "string",
  "isoDate": "string|null",
  "enclosure": "string|null",
  "author": "string|null",
  "guid": "string",
  "categories": ["string", "..."]
}
```

Wskazówki:
- title — jeśli nie masz, użyj "Brak tytułu"
- link — WYMAGANY (dla feedów deduplikacja po link)
- contentSnippet — bez HTML (użyj stripHtml), skróć do ~500–800 znaków
- isoDate — normalizuj przez parseDate (obsłuży ISO/RFC/Unix)
- guid — stabilny ID z API, a jeśli brak, użyj link
- enclosure — miniatura/obrazek (opcjonalnie)
- categories — tagi (opcjonalnie)

---

## 5) Szablony do kopiuj-wklej

A) Minimalny plugin (JSON z listą items)
```js
module.exports = {
  id: "my-custom",
  init(api) {
    api.registerParser({
      name: "my-custom-parser",
      priority: 55,
      test: (url) => url.includes("/feed.json"),
      parse: async (url, ctx) => {
        const res = await ctx.get(url);
        const list = Array.isArray(res.data?.items) ? res.data.items : [];
        return list.map((it) => ({
          title: it.title || "Brak tytułu",
          link: it.url || it.link,
          contentSnippet: api.utils.stripHtml(it.description || it.content || "").result.slice(0, 500),
          isoDate: api.utils.parseDate(it.date || it.published_at),
          enclosure: it.image || null,
          author: it.author || null,
          guid: it.id || it.url || it.link,
          categories: it.tags || []
        })).filter(x => x && x.link);
      }
    });
  }
};
```

B) Parser z własnym schematem URL (apix://)
```js
module.exports = {
  id: "apix-custom",
  init(api) {
    api.registerParser({
      name: "apix-custom",
      priority: 48,
      test: (url) => url.startsWith("apix://"),
      parse: async (url, ctx) => {
        let target = decodeURIComponent(url.replace("apix://", ""));
        if (!/^https?:\/\//i.test(target)) target = "https://" + target;
        const res = await ctx.get(target);
        const data = res.data || {};
        const items = Array.isArray(data.items) ? data.items : [];
        return items.map(entry => ({
          title: entry.title || entry.name || "Brak tytułu",
          link: entry.url || entry.link,
          contentSnippet: api.utils.stripHtml(entry.description || entry.summary || "").result.slice(0, 500),
          isoDate: api.utils.parseDate(entry.published_at || entry.updated_at),
          enclosure: entry.image || entry.thumbnail || null,
          author: entry.author?.name || entry.author || null,
          guid: entry.id || entry.url || entry.link,
          categories: entry.tags || entry.categories || []
        })).filter(x => x && x.link);
      }
    });
  }
};
```

C) Jeden plugin — wiele parserów
```js
module.exports = {
  id: "multi",
  init(api) {
    api.registerParser({
      name: "posts",
      priority: 45,
      test: (url) => url.includes("/posts"),
      parse: async (url, ctx) => { /* ... */ return []; }
    });
    api.registerParser({
      name: "comments",
      priority: 46,
      test: (url) => url.includes("/comments"),
      parse: async (url, ctx) => { /* ... */ return []; }
    });
  }
};
```

D) Logika w osobnym pliku
- src/workshop/my-parser.js
```js
module.exports.build = (api) => ({
  name: "my-separated-parser",
  priority: 52,
  test: (url) => url.includes("separated.example"),
  parse: async (url, ctx) => {
    const res = await ctx.get(url);
    const data = res.data || {};
    const list = Array.isArray(data.items) ? data.items : [];
    return list.map((it) => ({
      title: it.title || "Brak tytułu",
      link: it.url || it.link,
      contentSnippet: api.utils.stripHtml(it.description || "").result.slice(0, 500),
      isoDate: api.utils.parseDate(it.date),
      enclosure: it.image || null,
      author: it.author || null,
      guid: it.id || it.url,
      categories: it.tags || []
    })).filter(x => x.link);
  }
});
```

- src/workshop/my-separated.plugin.js
```js
const builder = require("./my-parser");
module.exports = {
  id: "my-separated",
  init(api) {
    api.registerParser(builder.build(api));
  }
};
```

---

## 6) Konfiguracja pluginu w config.json

- Własne ustawienia pluginu trzymaj w:
  - config.Workshop.Plugins.<pluginId>
- Odczyt w pluginie:
```js
const myCfg = api.config?.Workshop?.Plugins?.["my-custom"] || {};
```

Przykład (fragment config.json):
```json
{
  "Workshop": {
    "Enabled": true,
    "Plugins": {
      "my-custom": {
        "baseUrl": "https://api.example.com",
        "token": "abc123"
      }
    }
  }
}
```

---

## 7) KV Storage (pamięć wtyczki)

- Automatyczny magazyn w pliku: src/workshop/workshop-cache.json
- Użycie:
```js
const lastRun = api.kv.get("last_run_at");          // odczyt
api.kv.set("last_run_at", Date.now());              // zapis
api.kv.push("recent_ids", someId, 500);             // FIFO z limitem
```

Kiedy używać:
- historia GUID-ów/ID, microlocki, timery, drobne metadane. Nie trzymać dużych datasetów.

---

## 8) Wysyłka do Discorda (kiedy i jak)

- Standardowo parser TYLKO zwraca Itemy — XFeeder sam wyśle (szanując cache, RequestSend, Thread).
- Ręczna wysyłka (rzadkie przypadki: “watcher” spoza kolejki, np. cs2-blog-watcher):
```js
await api.send(webhookUrl, threadIdOrNull, entryObject);
```
- entryObject powinien mieć to samo pole “Item” co wyżej (title/link/contentSnippet/…).
- Uwaga: używanie tokenów użytkownika (self-bot) i wywołań API Discorda poza webhookiem łamie ToS — robisz to na własną odpowiedzialność.

---

## 9) Dobre praktyki i debugowanie

- test(url) filtruj agresywnie (szybszy pipeline)
- Zawsze zwracaj tablicę: [] nawet przy błędzie (złap try/catch)
- Stabilny link/guid — podstawa deduplikacji (unikaj losowych query; jak trzeba — ustaw stały guid)
- contentSnippet bez HTML (stripHtml) i przytnij do ~500–800
- isoDate przez parseDate
- ctx.get zamiast własnego axios — masz proxy, fallback UA, per-host cooldown
- Logi: api.log/warn/error opisuj sensownie — łatwiej diagnozować
- Nie zwracaj tysięcy elementów naraz (50–200 wystarczy)
- Priorytety:
  - < 60 jeśli chcesz przechwycić feed przed RSS
  - > 90 jeśli to ostatnia deska ratunku (po Fallback)
- Debug:
  - sprawdź, czy URL z configu trafia w test(url)
  - loguj długość listy po pobraniu (np. api.log("items:", list.length))
  - jeśli nic nie przychodzi — odpal feed w przeglądarce/curl i zobacz surowe dane

---

## 10) Zaawansowane: niestandardowe schematy URL (np. apix://)

- Możesz wymusić konkretny parser poprzez własny schemat:
  - test: url.startsWith("apix://")
  - parse: zdekoduj do https:// i dopiero ctx.get

Przykład:
```js
test: (url) => url.startsWith("apix://"),
parse: async (url, ctx) => {
  let target = decodeURIComponent(url.replace("apix://", ""));
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  const res = await ctx.get(target);
  // ...
}
```

---

## 11) FAQ i najczęstsze problemy

- Plugin nie ładuje się
  - Czy plik kończy się na .plugin.js?
  - Czy leży bezpośrednio w src/workshop (brak skanowania podkatalogów)?
  - Czy exports.enabled nie jest false?
  - Logi: [Workshop] Załadowano plugin: …

- test(url) nigdy nie trafia
  - Czy dodałeś dokładnie taki URL do channels[*].RSS w config.json?
  - Użyj try/catch przy new URL(url); niektóre wpisy nie są pełnymi URL-ami
  - Dodaj tymczasowo api.log("url", url), by zobaczyć co wpada

- Deduplikacja nie działa
  - Dla feedów deduplikacja jest po link — upewnij się, że link jest stabilny (usuń utm_* po swojej stronie, jeśli możesz)
  - W krytycznych przypadkach ustaw stabilny guid

- Jak dodać konfigurację tylko dla pluginu?
```js
const cfg = api.config?.Workshop?.Plugins?.["twoj-plugin-id"] || {};
```

- Mogę mieć wiele parserów w jednym pluginie?
  - Tak — wywołaj api.registerParser(...) kilka razy

- Czy mogę wysyłać samodzielnie (bez zwracania Itemów)?
  - Możesz, ale to wyjątek (np. ciągłe “watchery”). Standardowo zwracaj Itemy — core zrobi resztę.

---

To wszystko — powodzenia! Jeśli chcesz, podejrzyj istniejące wbudowane parsery (src/parsers/*) i pluginy w src/workshop, żeby zobaczyć, jak mapują różne typy danych do wspólnego formatu Item.