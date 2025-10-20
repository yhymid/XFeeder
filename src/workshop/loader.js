// src/workshop/loader.js
const fs = require("fs");
const path = require("path");

function loadWorkshop(baseApi, dir = path.resolve(__dirname)) {
  // domyślnie ładuje z katalogu, w którym znajduje się ten plik: src/workshop
  const parsers = [];
  const plugins = [];

  // jeśli katalog nie istnieje — nie tworzymy go, tylko pomijamy ładowanie
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.warn(`[Workshop] Katalog nie istnieje: ${dir} — pomijam ładowanie pluginów.`);
    return { parsers: [], plugins: [] };
  }

  // KV store per plugin (workshop-cache.json w src/workshop)
  function makeKV(pluginId) {
    const kvPath = path.join(dir, "workshop-cache.json");
    let store = {};
    try {
      if (fs.existsSync(kvPath)) {
        store = JSON.parse(fs.readFileSync(kvPath, "utf8"));
      }
    } catch {
      store = {};
    }
    if (!store[pluginId]) store[pluginId] = {};

    function save() {
      // tworzymy tylko plik w istniejącym katalogu (nie katalog)
      fs.writeFileSync(kvPath, JSON.stringify(store, null, 2), "utf8");
    }

    return {
      get: (key, defVal = undefined) =>
        Object.prototype.hasOwnProperty.call(store[pluginId], key)
          ? store[pluginId][key]
          : defVal,
      set: (key, val) => {
        store[pluginId][key] = val;
        save();
      },
      push: (key, val, limit = 1000) => {
        if (!Array.isArray(store[pluginId][key])) store[pluginId][key] = [];
        store[pluginId][key].unshift(val);
        if (limit && store[pluginId][key].length > limit) {
          store[pluginId][key].length = limit;
        }
        save();
      },
    };
  }

  function makePluginApi(pluginId) {
    return {
      id: pluginId,
      // HTTP
      http: { get: baseApi.get },
      // Utils
      utils: baseApi.utils,
      // Wysyłka
      send: baseApi.send,
      // Config (read-only)
      config: baseApi.config,
      // Logi namespacowane
      log: (...a) => console.log(`[WS:${pluginId}]`, ...a),
      warn: (...a) => console.warn(`[WS:${pluginId}]`, ...a),
      error: (...a) => console.error(`[WS:${pluginId}]`, ...a),
      // KV storage
      kv: makeKV(pluginId),
      // Rejestracja parserów
      registerParser: (def) => {
        if (!def || typeof def.parse !== "function") {
          throw new Error("registerParser: def.parse musi być funkcją");
        }
        parsers.push({
          name: def.name || `${pluginId}-parser`,
          priority: def.priority ?? 50,
          test: def.test || (() => true),
          parse: def.parse,
        });
      },
    };
  }

  // ŁADUJEMY TYLKO pliki kończące się na .plugin.js
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.plugin\.js$/i.test(d.name))
    .map((d) => d.name);

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const mod = require(path.resolve(full));
      const id = mod.id || path.basename(file, ".plugin.js");

      if (mod.enabled === false) {
        console.log(`[Workshop] Plugin wyłączony (enabled:false): ${id} – pomijam`);
        continue;
      }

      const api = makePluginApi(id);

      if (typeof mod.init === "function") {
        mod.init(api);
      } else if (typeof mod.register === "function") {
        mod.register(api);
      } else if (mod.parsers && Array.isArray(mod.parsers)) {
        for (const p of mod.parsers) api.registerParser(p);
      } else if (typeof mod === "function") {
        // eksport jako funkcja przyjmująca api
        const out = mod(api);
        if (out?.parse) api.registerParser(out);
      }

      plugins.push({ id, file });
      console.log(`[Workshop] Załadowano plugin: ${id} (${file})`);
    } catch (e) {
      console.warn(`[Workshop] Błąd ładowania ${file}: ${e.message}`);
    }
  }

  parsers.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  console.log(`[Workshop] Parserów: ${parsers.length}`);

  return { parsers, plugins };
}

module.exports = { loadWorkshop };