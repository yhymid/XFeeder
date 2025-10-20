# XFeeder 1.3 Workshop — Tworzenie własnych pluginów i parserów

Poniżej kompletna dokumentacja tworzenia rozszerzeń do XFeeder w systemie “Workshop”. Zawiera: strukturę plików, API, format danych, szablony, przykłady, debugowanie i dobre praktyki.

---

## Spis treści
- 1) Gdzie umieścić pliki i jak działa loader
- 2) Interfejs API pluginów (XFeederAPI)
- 3) Interfejs parsera: test(url, ctx) i parse(url, ctx)
- 4) Wymagany format elementu wyjściowego (Item)
- 5) Minimalny szablon pluginu
- 6) Przykład: parser JSON API
- 7) Przykład: plugin z KV storage
- 8) Rejestrowanie wielu parserów w jednym pluginie
- 9) Oddzielenie logiki: plugin + parser.js
- 10) Schematy niestandardowe (np. apix://)
- 11) Debugowanie i dobre praktyki
- 12) FAQ i najczęstsze problemy

---

## 1) Gdzie umieścić pliki i jak działa loader

- Ścieżka: wszystkie wtyczki umieszczamy w katalogu:
  - `src/workshop`
- Nazewnictwo: loader ładuje wyłącznie pliki kończące się na:
  - `.plugin.js` (np. `twitter.plugin.js`, `apix-custom.plugin.js`)
- Pliki pomocnicze:
  - Możesz trzymać dodatkowe moduły (np. `parser.js`, `utils.js`) obok, ale loader automatycznie wczytuje tylko `.plugin.js`
  - W pluginie możesz `require("./parser")` swoich pomocniczych plików
- Loader:
  - Nie tworzy katalogów
  - Loguje: `[Workshop] Załadowano plugin: <id> (<plik>)`
  - Obsługuje `module.exports.enabled = false` aby wyłączyć dany plugin
- Pipeline:
  - Na starcie XFeeder woła pluginy → pluginy rejestrują parsery przez `api.registerParser(...)`
  - XFeeder buduje kolejkę: najpierw pluginowe parsery (posortowane po priority), potem wbudowane:
    - YouTube(10), Atom(20), XML(30), JSON(40), ApiX(50), RSS(60), Fallback(90)

---

## 2) Interfejs API pluginów (XFeederAPI)

Do funkcji `init(api)` / `register(api)` wtyczki przekazywany jest obiekt `api`:

- `id: string` — identyfikator pluginu (z `mod.id` lub z nazwy pliku)
- `http.get(url)` — HTTP GET z fallbackami (używa tego samego klienta co XFeeder)
- `utils`:
  - `parseDate(input)` → ISO 8601 lub `null`
  - `stripHtml(html)` → `{ result: "oczyszczony tekst" }`
- `send(webhookUrl, threadId, entry)` — wysyłka do Discorda (Components V2)
  - Uwaga: parsery zazwyczaj nie wysyłają same — XFeeder zrobi to po deduplikacji i wg configu
- `config` — pełny `config.json` (tylko do odczytu)
- `log(...args)`, `warn(...args)`, `error(...args)` — logger z prefiksem `[WS:<pluginId>]`
- `kv` — prosty storage per-plugin (plik: `src/workshop/workshop-cache.json`)
  - `kv.get(key, default?)`
  - `kv.set(key, value)`
  - `kv.push(key, value, limit = 1000)` — FIFO na listy (np. historia GUID-ów)
- `registerParser(def)` — rejestracja parsera; `def` opisany niżej

---

## 3) Interfejs parsera: test(url, ctx) i parse(url, ctx)

`registerParser({ name, priority?, test?, parse })`:

- `name: string` — nazwa do logów
- `priority?: number` — kolejność w pipeline (niższa = wcześniej). Dla orientacji:
  - Wbudowane: YouTube(10), Atom(20), XML(30), JSON(40), ApiX(50), RSS(60), Fallback(90)
- `test?(url, ctx): boolean | Promise<boolean>` — opcjonalny filtr; jeśli zwróci `false`, `parse` nie będzie wołane
- `parse(url, ctx): Promise<Array<Item>>` — główna logika parsera

`ctx` przekazywany do `test/parse`:
- `ctx.get` — to samo co `api.http.get` (HTTP GET z fallbackiem/proxy/timeout)
- `ctx.api` — pełne XFeederAPI (np. `ctx.api.kv`, `ctx.api.utils`)

---

## 4) Wymagany format elementu wyjściowego (Item)

Parser powinien zwracać tablicę obiektów:
```json
{
  "title": "string",
  "link": "string",
  "contentSnippet": "string",
  "isoDate": "string|null (ISO 8601)",
  "enclosure": "string|null",
  "author": "string|null",
  "guid": "string",
  "categories": ["string", "..."]
}
```

Wskazówki:
- `title`: jeśli brak, użyj `"Brak tytułu"`
- `link`: wymagany (XFeeder deduplikuje po link dla feedów; po guid dla Discord-a)
- `contentSnippet`: bez HTML, skróć (~500–800 znaków)
- `isoDate`: użyj `utils.parseDate(...)` aby ujednolicić formaty
- `guid`: stabilny identyfikator (preferuj ID z API; fallback: link)
- `enclosure`: URL obrazka/miniatury (opcjonalne)
- `categories`: tagi/kategorie (opcjonalne)

---

## 5) Minimalny szablon pluginu

Plik: `src/workshop/my-custom.plugin.js`
```js
module.exports.id = "my-custom";
module.exports.enabled = true;

module.exports.init = function (api) {
  api.registerParser({
    name: "my-custom-parser",
    priority: 55, // przed RSS(60), po JSON(40–50)
    test: (url) => {
      try {
        const u = new URL(url);
        return u.hostname.endsWith("example.com") && u.pathname.includes("/feed");
      } catch {
        return false;
      }
    },
    parse: async (url, ctx) => {
      const res = await ctx.get(url);
      const data = res.data;
      const list = Array.isArray(data?.items) ? data.items : [];
      const { stripHtml, parseDate } = api.utils;

      const items = list.map((it) => {
        const title = it.title || "Brak tytułu";
        const link = it.url || it.link;
        const desc = stripHtml(it.description || it.content || "").result.trim();
        return {
          title,
          link,
          contentSnippet: desc.substring(0, 500),
          isoDate: parseDate(it.published_at || it.date),
          enclosure: it.image || null,
          author: it.author || null,
          guid: it.id || link || title,
          categories: it.tags || []
        };
      });

      return items.filter((x) => x && x.link);
    }
  });
};
```

---

## 6) Przykład: parser JSON API

Plik: `src/workshop/apix-custom.plugin.js`
```js
module.exports = {
  id: "apix-custom",
  enabled: true,
  init(api) {
    api.registerParser({
      name: "apix-custom",
      priority: 48, // tuż przed wbudowanym ApiX(50)/RSS(60)
      test: (url) => url.startsWith("apix://") || url.endsWith(".json") || url.includes("/api/"),
      parse: async (url, ctx) => {
        let target = url;
        if (url.startsWith("apix://")) {
          const raw = url.replace("apix://", "");
          target = decodeURIComponent(raw);
          if (!/^https?:\/\//i.test(target)) target = "https://" + target;
        }

        const res = await ctx.get(target);
        const rawData = res.data;
        let itemsSrc = [];

        if (Array.isArray(rawData)) {
          itemsSrc = rawData;
        } else if (rawData && typeof rawData === "object") {
          itemsSrc =
            rawData.items || rawData.posts || rawData.entries || rawData.articles ||
            rawData.results || rawData.children || rawData.data || rawData.response || [];

          if (!Array.isArray(itemsSrc) || itemsSrc.length === 0) {
            for (const val of Object.values(rawData)) {
              if (Array.isArray(val) && val.length) { itemsSrc = val; break; }
            }
          }
        }

        const { stripHtml, parseDate } = api.utils;
        const items = itemsSrc.map((entry) => {
          const title = entry.title || entry.name || "Brak tytułu";
          const link = entry.url || entry.link || entry.permalink;
          if (!link) return null;

          const desc = entry.summary || entry.description || entry.body || entry.text || entry.content || "";
          const contentSnippet = stripHtml(desc).result.trim().substring(0, 500);

          const dateStr =
            entry.date || entry.created_at || entry.updated_at || entry.published_at || entry.timestamp;

          const image =
            entry.image || entry.thumbnail || entry.banner || entry.media_url || entry.preview_image || null;

          const author =
            entry.author?.name || entry.author || entry.user?.name || entry.user || entry.by || null;

          return {
            title,
            link,
            contentSnippet,
            isoDate: parseDate(dateStr || new Date().toISOString()),
            enclosure: image,
            author,
            guid: entry.id || link || title,
            categories: entry.tags || entry.categories || []
          };
        }).filter(Boolean);

        return items;
      }
    });
  }
};
```

---

## 7) Przykład: plugin z KV storage

Plik: `src/workshop/kv-example.plugin.js`
```js
module.exports = {
  id: "kv-example",
  init(api) {
    api.registerParser({
      name: "kv-example-parser",
      priority: 57,
      test: (url) => url.includes("kv-source.example"),
      parse: async (url, ctx) => {
        const res = await ctx.get(url);
        const list = Array.isArray(res.data?.items) ? res.data.items : [];
        const items = list.map((it) => ({
          title: it.title || "Brak tytułu",
          link: it.url,
          contentSnippet: (it.summary || "").slice(0, 500),
          isoDate: api.utils.parseDate(it.date),
          enclosure: it.image || null,
          author: it.author || null,
          guid: it.id || it.url,
          categories: it.tags || []
        }));

        // zapisz ostatnie GUID-y (max 500)
        for (const row of items) {
          api.kv.push("recent_guids", row.guid, 500);
        }

        // przykładowe metadane
        const lastSeen = api.kv.get("last_seen_at");
        api.kv.set("last_seen_at", Date.now());

        api.log("Zaindeksowano", items.length, "wpisów. LastSeen:", lastSeen);
        return items;
      }
    });
  }
};
```

---

## 8) Rejestrowanie wielu parserów w jednym pluginie

```js
module.exports.init = (api) => {
  api.registerParser({
    name: "posts-parser",
    priority: 45,
    test: (url) => url.includes("/posts"),
    parse: async (url, ctx) => { /* ... */ return []; }
  });

  api.registerParser({
    name: "comments-parser",
    priority: 46,
    test: (url) => url.includes("/comments"),
    parse: async (url, ctx) => { /* ... */ return []; }
  });
};
```

---

## 9) Oddzielenie logiki: plugin + parser.js

- Trzymaj logikę parsowania w osobnym pliku i importuj do pluginu.

`src/workshop/my-parser.js`:
```js
module.exports.build = (api) => ({
  name: "my-separated-parser",
  priority: 52,
  test: (url) => url.includes("separated.example"),
  parse: async (url, ctx) => {
    const res = await ctx.get(url);
    const data = res.data;
    const { stripHtml, parseDate } = api.utils;

    const list = Array.isArray(data?.items) ? data.items : [];
    return list.map((it) => ({
      title: it.title || "Brak tytułu",
      link: it.url || it.link,
      contentSnippet: stripHtml(it.description || "").result.trim().substring(0, 500),
      isoDate: parseDate(it.date),
      enclosure: it.image || null,
      author: it.author || null,
      guid: it.id || it.url,
      categories: it.tags || []
    })).filter((x) => x.link);
  }
});
```

`src/workshop/my-separated.plugin.js`:
```js
const builder = require("./my-parser");

module.exports = {
  id: "my-separated",
  init(api) {
    const parser = builder.build(api);
    api.registerParser(parser);
  }
};
```

---

## 10) Schematy niestandardowe (np. apix://)

- Możesz wprowadzić własny schemat URL, np. `apix://<url-encoded-http-url>` aby wymusić użycie konkretnego parsera.
- W `test(url)` sprawdzaj `url.startsWith("apix://")`.
- W `parse(url)` zdekoduj i zamień na prawdziwy `https://...` przed `ctx.get`.

Fragment:
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

## 11) Debugowanie i dobre praktyki

- `test(url)` filtruj agresywnie — pozwala szybciej pominąć niepasujące źródła
- Stabilny `guid` i `link` — to podstawa deduplikacji
- `contentSnippet` bez HTML (`stripHtml`) i rozsądnie skrócony
- `isoDate` zawsze przez `parseDate` (obsłuży ISO/RFC/Unix)
- `ctx.get` zamiast własnego axios — masz spójne nagłówki, proxy, retry
- Nie wysyłaj sam — pozwól XFeeder sterować kolejką i cache
- Logi: `api.log/warn/error` zrozumiale opisuj problem
- Błędy w parse: łap wyjątki i zwracaj `[]` gdy źródło jest tymczasowo niedostępne
- Wydajność:
  - filtruj/limituj po stronie API jeśli się da
  - nie zwracaj tysięcy elementów naraz (zazwyczaj 50–200 wystarczy)
- Priorytety:
  - jeśli parser ma “przejąć” konkretne URL-e przed wbudowanymi — ustaw `priority` < 60 (przed RSS)
  - jeśli ma być ostatecznym ratunkiem — ustaw > 90 (po Fallback)

---

## 12) FAQ i najczęstsze problemy

- “Plugin nie ładuje się”
  - Czy plik kończy się na `.plugin.js`?
  - Czy znajduje się w `src/workshop`?
  - Czy `enabled` nie jest `false`?
  - Sprawdź logi: `[Workshop] Załadowano plugin: ...`
- “test(url) nigdy nie trafia”
  - Czy URL faktycznie jest w `channelConfig.RSS` w `config.json`?
  - Sprawdź domenę/ścieżkę przez `new URL(url)` i warunki `test`
- “Deduplikacja nie działa”
  - Dla feedów deduplikacja jest po `link`; upewnij się, że `link` jest stabilny (bez losowych query)
  - Jeśli musisz — ustaw stały `guid`
- “Jak dodać konfigurację tylko dla pluginu?”
  - `config.Workshop.Plugins.<pluginId>` i odczyt w pluginie:
    ```js
    const myCfg = api.config?.Workshop?.Plugins?.["apix-custom"] || {};
    ```
- “Czy mogę mieć wiele parserów w jednym pluginie?”
  - Tak — wywołaj `api.registerParser(...)` wiele razy

---