// src/workshop/loader.js - Plugin loader for Workshop system
const fs = require("fs");
const path = require("path");

/**
 * Loads all Workshop plugins from specified directory.
 * Only loads files ending with .plugin.js
 * 
 * @param {object} baseApi - Base API object with get, send, utils, config
 * @param {string} dir - Directory path to load plugins from
 * @returns {object} Object with parsers and plugins arrays
 */
function loadWorkshop(baseApi, dir = path.resolve(__dirname)) {
  const parsers = [];
  const plugins = [];

  // If directory doesn't exist — skip loading (don't create it)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.warn(`[Workshop] Directory not found: ${dir} — skipping plugin loading.`);
    return { parsers: [], plugins: [] };
  }

  /**
   * Creates KV store for a plugin (persisted to workshop-cache.json)
   * @param {string} pluginId - Plugin identifier
   * @returns {object} KV store methods: get, set, push
   */
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
      // Only create file in existing directory (not the directory itself)
      fs.writeFileSync(kvPath, JSON.stringify(store, null, 2), "utf8");
    }

    return {
      /**
       * Gets value from KV store
       * @param {string} key - Key to retrieve
       * @param {any} defVal - Default value if key doesn't exist
       * @returns {any} Stored value or default
       */
      get: (key, defVal = undefined) =>
        Object.prototype.hasOwnProperty.call(store[pluginId], key)
          ? store[pluginId][key]
          : defVal,
      
      /**
       * Sets value in KV store
       * @param {string} key - Key to set
       * @param {any} val - Value to store
       */
      set: (key, val) => {
        store[pluginId][key] = val;
        save();
      },
      
      /**
       * Pushes value to array in KV store (FIFO with limit)
       * @param {string} key - Key for array
       * @param {any} val - Value to prepend
       * @param {number} limit - Max array length (default 1000)
       */
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

  /**
   * Creates API object for a specific plugin
   * @param {string} pluginId - Plugin identifier
   * @returns {object} Plugin API
   */
  function makePluginApi(pluginId) {
    return {
      id: pluginId,
      
      // HTTP client
      http: { get: baseApi.get },
      
      // Utility functions
      utils: baseApi.utils,
      
      // Discord sender
      send: baseApi.send,
      
      // Config (read-only)
      config: baseApi.config,
      
      // Namespaced logging
      log: (...a) => console.log(`[WS:${pluginId}]`, ...a),
      warn: (...a) => console.warn(`[WS:${pluginId}]`, ...a),
      error: (...a) => console.error(`[WS:${pluginId}]`, ...a),
      
      // KV storage
      kv: makeKV(pluginId),
      
      /**
       * Registers a parser with the Workshop system
       * @param {object} def - Parser definition with name, priority, test, parse
       */
      registerParser: (def) => {
        if (!def || typeof def.parse !== "function") {
          throw new Error("registerParser: def.parse must be a function");
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

  // Load only files ending with .plugin.js
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.plugin\.js$/i.test(d.name))
    .map((d) => d.name);

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const mod = require(path.resolve(full));
      const id = mod.id || path.basename(file, ".plugin.js");

      // Skip disabled plugins
      if (mod.enabled === false) {
        console.log(`[Workshop] Plugin disabled (enabled:false): ${id} — skipping`);
        continue;
      }

      const api = makePluginApi(id);

      // Support multiple plugin formats
      if (typeof mod.init === "function") {
        mod.init(api);
      } else if (typeof mod.register === "function") {
        mod.register(api);
      } else if (mod.parsers && Array.isArray(mod.parsers)) {
        for (const p of mod.parsers) api.registerParser(p);
      } else if (typeof mod === "function") {
        // Export as function accepting api
        const out = mod(api);
        if (out?.parse) api.registerParser(out);
      }

      plugins.push({ id, file });
      console.log(`[Workshop] Plugin loaded: ${id} (${file})`);
    } catch (e) {
      console.warn(`[Workshop] Error loading ${file}: ${e.message}`);
    }
  }

  // Sort parsers by priority (lower = higher priority)
  parsers.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  console.log(`[Workshop] Total parsers: ${parsers.length}`);

  return { parsers, plugins };
}

module.exports = { loadWorkshop };