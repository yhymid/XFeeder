(function () {
  "use strict";

  const FEED_KEYS = ["RSS", "Feeds", "URLs", "Sources"];
  const NAV_ITEMS = [
    { id: "overview", label: "Start" },
    { id: "channels", label: "Kanały" },
    { id: "integrations", label: "Ustawienia" },
    { id: "advanced", label: "Advanced" },
  ];
  const MODE_OPTIONS = ["get", "post", "put", "delete", "fetch", "stealthy-fetch"];
  const RUNTIME_OPTIONS = ["cli", "shell"];
  const WAIT_SELECTOR_STATES = ["attached", "visible", "hidden", "detached"];
  const ROOT_CHANNEL_DEFAULTS = {
    TimeChecker: 30,
    RequestSend: 5,
  };
  const RESERVED_CONFIG_KEYS = new Set([
    "Settings",
    "Auth",
    "Proxy",
    "Scrapling",
    "ChannelDefaults",
    "DefaultChannel",
    "Matrix",
  ]);
  const CHANNEL_HINT_KEYS = new Set([
    ...FEED_KEYS,
    "Webhook",
    "Thread",
    "Discord",
    "Matrix",
    "TimeChecker",
    "RequestSend",
  ]);

  let uidCounter = 0;
  let refs = {};

  const state = {
    config: {},
    channelGroups: [],
    envFile: "",
    envExample: "",
    cacheSummary: { preview: [] },
    meta: {},
    warnings: [],
    activeTab: "overview",
    dirtyConfig: false,
    dirtyEnv: false,
    flash: { tone: "", text: "" },
    loading: true,
    loadedChannelGroupKeys: [],
    auth: {
      required: false,
      authenticated: true,
      mode: "local-open",
    },
    loginPassword: "",
    loginSubmitting: false,
  };

  document.addEventListener("DOMContentLoaded", bootstrap);

  function nextId(prefix = "id") {
    uidCounter += 1;
    return `${prefix}-${Date.now()}-${uidCounter}`;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function ensureObject(parent, key) {
    if (!isPlainObject(parent[key])) {
      parent[key] = {};
    }
    return parent[key];
  }

  function ensureArray(parent, key) {
    if (!Array.isArray(parent[key])) {
      parent[key] = [];
    }
    return parent[key];
  }

  function hasMatrixDeliveryTargetClient(matrixConfig) {
    return Boolean(
      matrixConfig &&
      typeof matrixConfig === "object" &&
      matrixConfig.Enabled !== false &&
      String(matrixConfig.Homeserver || "").trim() &&
      String(matrixConfig.AccessToken || "").trim() &&
      String(matrixConfig.RoomID || "").trim()
    );
  }

  function getEffectiveMatrixConfig(channelData) {
    const globalMatrix = isPlainObject(state.config.Matrix) ? state.config.Matrix : null;
    const localMatrix = isPlainObject(channelData?.Matrix) ? channelData.Matrix : null;
    if (!globalMatrix && !localMatrix) return null;
    return {
      ...(globalMatrix || {}),
      ...(localMatrix || {}),
    };
  }

  function normalizeStringList(value) {
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    return list
      .map((item) => String(item == null ? "" : item).trim())
      .filter(Boolean);
  }

  function normalizeNumberList(value) {
    return normalizeStringList(value)
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  }

  function detectFeedKey(channelData) {
    for (const key of FEED_KEYS) {
      if (Array.isArray(channelData?.[key]) || typeof channelData?.[key] === "string") {
        return key;
      }
    }
    return "RSS";
  }

  function extractFeeds(channelData) {
    const key = detectFeedKey(channelData);
    return {
      feedsKey: key,
      feeds: normalizeStringList(channelData?.[key]),
    };
  }

  function looksLikeChannelEntry(value) {
    if (typeof value === "string") {
      return true;
    }

    if (Array.isArray(value)) {
      return value.every((item) => typeof item === "string");
    }

    if (!isPlainObject(value)) {
      return false;
    }

    return Object.keys(value).some((key) => CHANNEL_HINT_KEYS.has(key));
  }

  function isChannelGroupConfigEntry(key, value) {
    if (RESERVED_CONFIG_KEYS.has(key)) {
      return false;
    }

    if (Array.isArray(value)) {
      return value.length === 0 ? /^channels/i.test(key) : value.every((entry) => looksLikeChannelEntry(entry));
    }

    if (!isPlainObject(value)) {
      return false;
    }

    const entries = Object.values(value);
    return entries.length === 0 ? /^channels/i.test(key) : entries.every((entry) => looksLikeChannelEntry(entry));
  }

  function normalizeChannelEntry(name, data) {
    const safeData = isPlainObject(data) ? deepClone(data) : {};
    const { feedsKey, feeds } = extractFeeds(safeData);
    return {
      id: nextId("channel"),
      name: name || "",
      feedsKey,
      feeds,
      data: safeData,
    };
  }

  function normalizeChannelGroups(rawConfig) {
    return Object.entries(rawConfig || {})
      .filter(([key, value]) => isChannelGroupConfigEntry(key, value))
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return {
            id: nextId("group"),
            key,
            mode: "array",
            channels: value.map((entry) => normalizeChannelEntry("", entry)),
          };
        }

        const objectValue = isPlainObject(value) ? value : {};
        return {
          id: nextId("group"),
          key,
          mode: "object",
          channels: Object.entries(objectValue).map(([name, entry]) => normalizeChannelEntry(name, entry)),
        };
      });
  }

  function serializeChannelEntry(channel) {
    const next = isPlainObject(channel.data) ? deepClone(channel.data) : {};
    for (const key of FEED_KEYS) {
      delete next[key];
    }
    next[channel.feedsKey || "RSS"] = normalizeStringList(channel.feeds);
    return next;
  }

  function serializeChannelGroups(groups) {
    const output = {};
    const usedKeys = new Set();

    for (const group of groups) {
      let rawKey = String(group.key || "").trim();
      if (!rawKey) {
        rawKey = suggestNextGroupKey(usedKeys);
      }
      while (usedKeys.has(rawKey)) {
        rawKey = `${rawKey}_copy`;
      }
      usedKeys.add(rawKey);

      if (group.mode === "object") {
        const objectValue = {};
        group.channels.forEach((channel, index) => {
          const baseName = String(channel.name || "").trim() || `channel${index + 1}`;
          let channelName = baseName;
          let suffix = 2;
          while (Object.prototype.hasOwnProperty.call(objectValue, channelName)) {
            channelName = `${baseName}_${suffix}`;
            suffix += 1;
          }
          objectValue[channelName] = serializeChannelEntry(channel);
        });
        output[rawKey] = objectValue;
        continue;
      }

      output[rawKey] = group.channels.map((channel) => serializeChannelEntry(channel));
    }

    return output;
  }

  function buildConfigForSave() {
    const nextConfig = deepClone(state.config || {});
    for (const key of Object.keys(nextConfig)) {
      if (state.loadedChannelGroupKeys.includes(key) || isChannelGroupConfigEntry(key, nextConfig[key])) {
        delete nextConfig[key];
      }
    }
    Object.assign(nextConfig, serializeChannelGroups(state.channelGroups));
    return nextConfig;
  }

  function loadConfigIntoState(rawConfig) {
    state.config = deepClone(rawConfig || {});
    state.channelGroups = normalizeChannelGroups(rawConfig || {});
    state.loadedChannelGroupKeys = state.channelGroups.map((group) => group.key);
  }

  function suggestNextGroupKey(usedKeys = new Set(state.channelGroups.map((group) => group.key))) {
    let index = 1;
    while (usedKeys.has(index === 1 ? "channels" : `channels${index}`)) {
      index += 1;
    }
    return index === 1 ? "channels" : `channels${index}`;
  }

  function createDefaultChannel() {
    const defaults = isPlainObject(state.config.ChannelDefaults)
      ? state.config.ChannelDefaults
      : ROOT_CHANNEL_DEFAULTS;
    return {
      id: nextId("channel"),
      name: "",
      feedsKey: "RSS",
      feeds: [],
      data: {
        Webhook: "",
        Thread: "",
        TimeChecker: defaults.TimeChecker || ROOT_CHANNEL_DEFAULTS.TimeChecker,
        RequestSend: defaults.RequestSend || ROOT_CHANNEL_DEFAULTS.RequestSend,
      },
    };
  }

  async function bootstrap() {
    state.loading = true;
    render();
    await loadAuthState();
    if (state.auth.required && !state.auth.authenticated) {
      state.loading = false;
      render();
      return;
    }
    await reloadFromDisk();
  }

  async function request(method, url, payload) {
    const response = await fetch(url, {
      method,
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });

    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      if (data?.auth) {
        state.auth = data.auth;
      }
      const error = new Error(data?.error || "Logowanie wymagane.");
      error.code = "AUTH_REQUIRED";
      throw error;
    }
    if (!response.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data;
  }

  async function loadAuthState() {
    try {
      const response = await fetch("/api/auth-state", { method: "GET" });
      const data = await response.json().catch(() => ({}));
      state.auth = data?.auth || state.auth;
    } catch (error) {
      state.flash = { tone: "error", text: error.message };
    }
  }

  async function login() {
    try {
      state.loginSubmitting = true;
      render();
      const data = await request("POST", "/api/login", { password: state.loginPassword });
      state.auth = data.auth || {
        required: false,
        authenticated: true,
        mode: "local-open",
      };
      state.loginPassword = "";
      await reloadFromDisk();
      state.flash = { tone: "", text: "Dashboard odblokowany." };
    } catch (error) {
      state.flash = { tone: "error", text: error.message };
      state.loading = false;
      render();
    } finally {
      state.loginSubmitting = false;
      render();
    }
  }

  async function logout() {
    try {
      await request("POST", "/api/logout", {});
    } catch (error) {
      state.flash = { tone: "error", text: error.message };
    } finally {
      state.auth = {
        required: state.auth.required,
        authenticated: false,
        mode: state.auth.mode,
      };
      state.loading = false;
      render();
    }
  }

  async function reloadFromDisk() {
    try {
      state.loading = true;
      render();
      const data = await request("GET", "/api/state");
      loadConfigIntoState(data.config || {});
      state.envFile = data.envFile || "";
      state.envExample = data.envExample || "";
      state.cacheSummary = data.cacheSummary || { preview: [] };
      state.meta = data.meta || {};
      state.warnings = Array.isArray(data.warnings) ? data.warnings : [];
      state.auth = data.auth || state.auth;
      state.dirtyConfig = false;
      state.dirtyEnv = false;
      state.flash = { tone: "", text: "" };
    } catch (error) {
      state.flash = { tone: "error", text: error.message };
    } finally {
      state.loading = false;
      render();
    }
  }

  async function saveConfig() {
    try {
      const savedState = await request("PUT", "/api/config", buildConfigForSave());
      loadConfigIntoState(savedState.config || {});
      state.envFile = savedState.envFile || state.envFile;
      state.envExample = savedState.envExample || state.envExample;
      state.cacheSummary = savedState.cacheSummary || state.cacheSummary;
      state.meta = savedState.meta || state.meta;
      state.warnings = Array.isArray(savedState.warnings) ? savedState.warnings : [];
      state.auth = savedState.auth || state.auth;
      state.dirtyConfig = false;
      state.flash = { tone: "", text: "Config zapisany." };
      render();
    } catch (error) {
      state.flash = { tone: "error", text: error.message };
      syncChrome();
    }
  }

  async function saveEnv() {
    try {
      const savedState = await request("PUT", "/api/env", { content: state.envFile });
      state.envExample = savedState.envExample || state.envExample;
      state.meta = savedState.meta || state.meta;
      state.auth = savedState.auth || state.auth;
      state.dirtyEnv = false;
      state.flash = { tone: "", text: ".env zapisany." };
      render();
    } catch (error) {
      state.flash = { tone: "error", text: error.message };
      syncChrome();
    }
  }

  function markConfigDirty(message) {
    state.dirtyConfig = true;
    if (message) {
      state.flash = { tone: "", text: message };
    }
    syncChrome();
  }

  function markEnvDirty() {
    state.dirtyEnv = true;
    syncChrome();
  }

  function computeOverviewStats() {
    const config = buildConfigForSave();
    const groups = state.channelGroups.map((group) => ({
      key: group.key,
      mode: group.mode,
      count: group.channels.length,
    }));
    const totalChannels = state.channelGroups.reduce((sum, group) => sum + group.channels.length, 0);
    const totalFeeds = state.channelGroups.reduce((sum, group) => {
      return sum + group.channels.reduce((innerSum, channel) => innerSum + normalizeStringList(channel.feeds).length, 0);
    }, 0);
    const envRefs = Array.from(collectEnvRefsClient(config)).sort();

    return {
      groups,
      totalChannelGroups: groups.length,
      totalChannels,
      totalFeeds,
      envRefs,
    };
  }

  function collectEnvRefsClient(value, bucket = new Set()) {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        bucket.add(match[1]);
      }
      return bucket;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => collectEnvRefsClient(item, bucket));
      return bucket;
    }

    if (value && typeof value === "object") {
      Object.values(value).forEach((item) => collectEnvRefsClient(item, bucket));
    }

    return bucket;
  }

  function deriveWarnings() {
    const warnings = [];

    state.channelGroups.forEach((group) => {
      if (!group.channels.length) {
        warnings.push(`${group.key}: grupa nie ma kanałów.`);
      }

      group.channels.forEach((channel, index) => {
        const label = group.mode === "object"
          ? `${group.key}.${channel.name || `channel${index + 1}`}`
          : `${group.key}[${index}]`;

        const hasFeeds = normalizeStringList(channel.feeds).length > 0;
        const hasWebhook = typeof channel.data.Webhook === "string" && channel.data.Webhook.trim();
        const hasDiscord = isPlainObject(channel.data.Discord);
        const hasMatrix = hasMatrixDeliveryTargetClient(getEffectiveMatrixConfig(channel.data));

        if (!hasFeeds && !hasDiscord) {
          warnings.push(`${label}: brak feedów i brak źródła Discord.`);
        }

        if (!hasWebhook && !hasMatrix) {
          warnings.push(`${label}: brak targetu dostarczenia.`);
        }
      });
    });

    return warnings.concat(state.warnings || []);
  }

  function render() {
    const root = document.getElementById("app");
    root.innerHTML = "";

    if (state.auth.required && !state.auth.authenticated) {
      root.append(renderLoginShell());
      return;
    }

    const shell = el("div", { className: "shell" });
    shell.append(buildTopbar(), buildMain());
    root.append(shell);
    syncChrome();
  }

  function syncChrome() {
    if (refs.saveButton) {
      refs.saveButton.disabled = !state.dirtyConfig || state.loading;
    }
    if (refs.reloadButton) {
      refs.reloadButton.disabled = state.loading;
    }
    if (refs.statusBadge) {
      refs.statusBadge.textContent = state.loading
        ? "Ładowanie..."
        : state.dirtyConfig
          ? "Niezapisane zmiany"
          : "Config zsynchronizowany";
    }
    if (refs.flash) {
      refs.flash.textContent = state.flash?.text || "";
      refs.flash.dataset.tone = state.flash?.tone || "";
    }
  }

  function renderLoginShell() {
    const wrapper = el("div", { className: "login-shell" });
    const input = el("input", {
      attrs: {
        type: "password",
        placeholder: "Hasło dashboardu",
      },
      onInput: (event) => {
        state.loginPassword = event.target.value;
      },
    });
    input.value = state.loginPassword || "";

    const form = el("form", {
      className: "login-card stack",
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!state.loginSubmitting) {
        login();
      }
    });

    form.append(
      el("div", { className: "eyebrow", text: "XFeeder / Secure Dashboard" }),
      el("h1", { text: "Zaloguj się do dashboardu" }),
      el("p", {
        className: "lede",
        text: "Panel jest zabezpieczony hasłem. Po zalogowaniu możesz edytować config, .env i podgląd cache bez wystawiania tych danych publicznie.",
      }),
      el("div", { className: "field full" }, [
        el("label", { text: "Hasło" }),
        input,
      ]),
      el("div", { className: "inline-actions" }, [
        el("button", {
          className: "button",
          text: state.loginSubmitting ? "Logowanie..." : "Wejdź do panelu",
          attrs: {
            type: "submit",
          },
        }),
      ]),
      el("div", {
        className: "micro-status",
        text: "Tip: na VPS trzymaj dashboard za reverse proxy i ustaw XFEEDER_DASHBOARD_PASSWORD.",
      }),
      el("div", {
        className: "flash",
        attrs: {
          "data-tone": state.flash?.tone || "",
        },
        text: state.flash?.text || "",
      })
    );

    wrapper.append(form);
    return wrapper;
  }

  function buildTopbar() {
    const topbar = el("div", { className: "topbar" });
    const inner = el("div", { className: "topbar-inner" });
    const stats = computeOverviewStats();
    const host = state.meta?.host === "127.0.0.1" ? "localhost" : state.meta?.host || "localhost";
    const location = `${host}:${state.meta?.port || 3000}`;
    const authLabel = state.auth.required ? "chroniony hasłem" : "lokalny dostęp";

    refs = {};

    const masthead = el("div", { className: "masthead" }, [
      el("div", {}, [
        el("div", { className: "eyebrow", text: "XFeeder / Local Dashboard" }),
        el("h1", { text: "XFeeder" }),
        el("p", {
          className: "lede",
          text:
            "Najpierw dodajesz kanały i feedy. Potem ustawiasz delivery. Techniczne rzeczy są schowane głębiej, żeby codzienna praca była prostsza.",
        }),
        el("div", {
          className: "micro-status",
          text: `Adres: http://${location} · ${stats.totalChannels} kanałów · ${stats.totalFeeds} feedów · ${authLabel}`,
        }),
      ]),
      el("div", { className: "stack" }, [
        el("div", { className: "toolbar" }, [
          (refs.statusBadge = el("div", { className: "status-badge" })),
          (refs.saveButton = el("button", {
            className: "button",
            text: "Zapisz",
            onClick: saveConfig,
          })),
          (refs.reloadButton = el("button", {
            className: "ghost-button",
            text: "Odśwież",
            onClick: reloadFromDisk,
          })),
          state.auth.required
            ? el("button", {
                className: "ghost-button",
                text: "Wyloguj",
                onClick: logout,
              })
            : null,
        ]),
        (refs.flash = el("div", { className: "flash" })),
      ]),
    ]);

    const nav = el("div", { className: "nav" });
    NAV_ITEMS.forEach((item) => {
      nav.append(el("button", {
        text: item.label,
        className: item.id === state.activeTab ? "is-active" : "",
        onClick: () => {
          state.activeTab = item.id;
          render();
        },
      }));
    });

    inner.append(masthead, nav);
    topbar.append(inner);
    return topbar;
  }

  function buildMain() {
    const main = el("main", { className: "main" });
    if (state.loading) {
      main.append(el("div", { className: "hero-card" }, [
        el("h2", { text: "Ładuje konfigurację..." }),
      ]));
      return main;
    }

    if (state.activeTab === "overview") {
      main.append(renderOverview());
    } else if (state.activeTab === "channels") {
      main.append(renderChannels());
    } else {
      main.append(state.activeTab === "integrations" ? renderIntegrations() : renderAdvanced());
    }

    return main;
  }

  function renderOverview() {
    const wrapper = el("div", { className: "tile-grid tile-grid-3" });
    const stats = computeOverviewStats();
    const warnings = deriveWarnings();
    const host = state.meta?.host === "127.0.0.1" ? "localhost" : state.meta?.host || "localhost";
    const location = `http://${host}:${state.meta?.port || 3000}`;
    const securityMode = state.meta?.security?.passwordRequired ? "Hasło aktywne" : "Tylko lokalnie";

    wrapper.append(
      tileCard({
        title: "Adres lokalny",
        value: location,
        note: "Tu otwierasz dashboard w przeglądarce.",
      }),
      tileCard({
        title: "Grupy kanałów",
        value: String(stats.totalChannelGroups),
        note: "Sekcji kanałów w configu.",
      }),
      tileCard({
        title: "Kanały",
        value: String(stats.totalChannels),
        note: "Kanałów gotowych do sprawdzania.",
      }),
      tileCard({
        title: "Feedy",
        value: String(stats.totalFeeds),
        note: "Adresów RSS, Atom i podobnych źródeł.",
      }),
      tileCard({
        title: "Cache wpisów",
        value: String(state.cacheSummary?.totalItems || 0),
        note: "Zapamiętanych elementów w cache.",
      }),
      tileCard({
        title: "Bezpieczeństwo",
        value: securityMode,
        note: state.meta?.security?.passwordRequired
          ? "Panel wpuszcza dopiero po logowaniu i nie wystawia configu anonimowo."
          : "Dostęp bez hasła tylko z lokalnego hosta. Na VPS ustaw hasło i reverse proxy.",
      }),
      tileCard({
        title: "Reload worker",
        value: "Automatyczny",
        note: state.meta?.configReload || "Worker podnosi config i .env z dysku w kolejnym cyklu.",
      }),
      tileCard({
        title: "Referencje env",
        value: String((stats.envRefs || []).length),
        note: (stats.envRefs || []).length
          ? `${stats.envRefs.slice(0, 2).join(", ")}${stats.envRefs.length > 2 ? ` +${stats.envRefs.length - 2}` : ""}`
          : "Brak odwołań do .env.",
      }),
      tileCard({
        title: "Od czego zacząć",
        children: [
          el("ol", { className: "plain-list flow-list tile-list-rich" }, [
            el("li", { text: "Wejdź w Kanały i dodaj feedy oraz webhook dla miejsca, gdzie mają wpadać wpisy." }),
            el("li", { text: "W Ustawieniach ustaw tylko to, czego naprawdę potrzebujesz: logi, proxy, globalny Matrix albo globalne Auth dla Discord source." }),
            el("li", { text: "Do Advanced zaglądaj dopiero wtedy, gdy chcesz ruszać Scrapling, .env, cache albo surowy JSON." }),
          ]),
        ],
      }),
      tileCard({
        title: "Na co uważać",
        children: [
          warnings.length
            ? el("ul", { className: "warning-list tile-list-rich" }, warnings.map((warning) => el("li", { text: warning })))
            : el("div", { className: "empty-state" }, [el("span", { text: "Brak oczywistych ostrzeżeń." })]),
        ],
      }),
      tileCard({
        title: "Grupy kanałów",
        children: [
          stats.groups.length
            ? el("ul", { className: "tile-list" }, stats.groups.slice(0, 6).map((group) => el("li", {}, [
                el("strong", { text: group.key }),
                el("span", {
                  className: "muted",
                  text: `${group.count} kanałów · tryb ${group.mode}`,
                }),
              ])).concat(
                stats.groups.length > 6
                  ? [el("li", {}, [el("span", { className: "muted", text: `I jeszcze ${stats.groups.length - 6} grup.` })])]
                  : []
              ))
            : el("div", { className: "empty-state" }, [el("span", { text: "Nie ma jeszcze żadnych grup kanałów." })]),
        ],
      })
    );

    return wrapper;
  }

  function renderChannels() {
    const wrapper = el("div", { className: "stack" });
    const defaults = ensureObject(state.config, "ChannelDefaults");
    const defaultInterval = defaults.TimeChecker || ROOT_CHANNEL_DEFAULTS.TimeChecker;
    const defaultBurst = defaults.RequestSend || ROOT_CHANNEL_DEFAULTS.RequestSend;

    wrapper.append(el("section", { className: "card tile-card tile-span-all" }, [
      el("div", { className: "simple-header" }, [
        el("div", {}, [
          el("h2", { text: "Kanały" }),
          el("p", {
            className: "card-subtitle section-note",
            text: "Każda grupa i kanał działa teraz bardziej jak osobny kafelek. Rozwijasz tylko to, czego akurat potrzebujesz.",
          }),
        ]),
      ]),
      el("div", { className: "mini-tile-grid" }, [
        miniTile("Grupy", String(state.channelGroups.length)),
        miniTile("Interwał domyślny", `${defaultInterval} min`),
        miniTile("Burst domyślny", `${defaultBurst} wpisów`),
      ]),
      el("div", { className: "inline-actions" }, [
        el("button", {
          className: "button",
          text: "Dodaj grupę kanałów",
          onClick: () => {
            state.channelGroups.push({
              id: nextId("group"),
              key: suggestNextGroupKey(),
              mode: "array",
              channels: [createDefaultChannel()],
            });
            markConfigDirty("Dodano grupę kanałów.");
            render();
          },
        }),
      ]),
      renderFoldedCard({
        title: "Domyślne tempo nowych kanałów",
        meta: `co ${defaultInterval} min · max ${defaultBurst} wpisów`,
        open: false,
        className: "tile-fold inline-fold",
        content: el("div", { className: "stack" }, [
          summaryList([
            ["Nowe kanały sprawdzaj co", `${defaultInterval} minut`],
            ["Na jeden cykl wyślij max", `${defaultBurst} wpisów`],
          ]),
          el("div", { className: "field-grid compact-grid" }, [
            numberField({
              label: "Sprawdzaj co (min)",
              object: defaults,
              key: "TimeChecker",
              allowNull: false,
              onDirty: () => markConfigDirty(),
            }),
            numberField({
              label: "Maks. wpisów na cykl",
              object: defaults,
              key: "RequestSend",
              allowNull: false,
              onDirty: () => markConfigDirty(),
            }),
          ]),
        ]),
      }),
    ]));

    if (!state.channelGroups.length) {
      wrapper.append(el("div", { className: "empty-state", text: "Nie ma jeszcze żadnych grup kanałów. Dodaj pierwszą." }));
      return wrapper;
    }

    const groupsGrid = el("div", { className: "tile-grid tile-grid-3 channel-groups-grid" });
    state.channelGroups.forEach((group) => {
      groupsGrid.append(renderChannelGroup(group));
    });
    wrapper.append(groupsGrid);

    return wrapper;
  }

  function renderChannelGroup(group) {
    const section = el("details", { className: "compact-section group-tile" });
    if (state.channelGroups.indexOf(group) === 0) {
      section.open = true;
    }

    const totalFeeds = group.channels.reduce((sum, channel) => sum + normalizeStringList(channel.feeds).length, 0);
    section.append(el("summary", { className: "compact-summary" }, [
      el("div", {}, [
        el("strong", { text: group.key || "Nowa grupa" }),
        el("div", {
          className: "compact-meta",
          text: `${group.channels.length} kanałów · ${totalFeeds} feedów · ${group.mode === "object" ? "nazwy własne" : "lista"}`,
        }),
      ]),
    ]));

    const channelStack = el("div", { className: "tile-grid tile-grid-2 channel-cards-grid" });
    group.channels.forEach((channel, index) => {
      channelStack.append(renderChannelCard(group, channel, index));
    });

    section.append(el("div", { className: "section-body stack" }, [
      el("div", { className: "field-grid compact-grid" }, [
        textField({
          label: "Nazwa grupy w configu",
          value: group.key,
          onInput: (value) => {
            group.key = value;
            markConfigDirty();
          },
        }),
        selectField({
          label: "Układ grupy",
          value: group.mode,
          options: [
            { value: "array", label: "Prosta lista" },
            { value: "object", label: "Nazwane kanały" },
          ],
          onInput: (value) => {
            group.mode = value;
            if (value === "object") {
              group.channels.forEach((channel, index) => {
                if (!String(channel.name || "").trim()) {
                  channel.name = `channel${index + 1}`;
                }
              });
            }
            markConfigDirty();
            render();
          },
        }),
      ]),
      el("div", { className: "inline-actions" }, [
        el("button", {
          className: "button",
          text: "Dodaj kanał",
          onClick: () => {
            group.channels.push(createDefaultChannel());
            if (group.mode === "object") {
              group.channels[group.channels.length - 1].name = `channel${group.channels.length}`;
            }
            markConfigDirty("Dodano kanał.");
            render();
          },
        }),
      ]),
      group.channels.length
        ? channelStack
        : el("div", { className: "empty-state", text: "Ta grupa nie ma jeszcze żadnych kanałów." }),
      el("div", { className: "management-strip" }, [
        el("span", {
          className: "muted",
          text: "Usuwanie grupy jest opcją rzadką, więc zostawiłem ją na samym dole.",
        }),
        el("button", {
          className: "ghost-button",
          text: "Usuń grupę",
          onClick: () => {
            state.channelGroups = state.channelGroups.filter((entry) => entry.id !== group.id);
            markConfigDirty("Usunięto grupę.");
            render();
          },
        }),
      ]),
    ]));
    return section;
  }

  function renderChannelCard(group, channel, index) {
    const card = el("details", { className: "channel-card compact-section channel-tile" });
    const title = group.mode === "object"
      ? (channel.name || `channel${index + 1}`)
      : `Kanał #${index + 1}`;
    const feedCount = normalizeStringList(channel.feeds).length;

    card.append(el("summary", { className: "compact-summary" }, [
      el("div", {}, [
        el("strong", { text: title }),
        el("div", {
          className: "compact-meta",
          text: `${feedCount} feedów · ${describeChannelTargets(channel)}`,
        }),
      ]),
    ]));

    const topFields = [];
    if (group.mode === "object") {
      topFields.push(textField({
        label: "Nazwa kanału",
        value: channel.name,
        onInput: (value) => {
          channel.name = value;
          markConfigDirty();
        },
      }));
    }
    topFields.push(
      textField({
        label: "Webhook Discord",
        value: channel.data.Webhook || "",
        onInput: (value) => {
          channel.data.Webhook = value;
          markConfigDirty();
        },
        placeholder: "https://discord.com/api/webhooks/...",
      }),
      textField({
        label: "ID wątku (opcjonalnie)",
        value: channel.data.Thread || "",
        onInput: (value) => {
          channel.data.Thread = value;
          markConfigDirty();
        },
      })
    );

    card.append(el("div", { className: "section-body stack" }, [
      el("div", { className: "field-grid compact-grid" }, topFields),
      listEditor({
        label: "Feedy / URL-e",
        description: "",
        values: channel.feeds,
        placeholder: "https://example.com/feed.xml",
        onChange: (values) => {
          channel.feeds = values;
          markConfigDirty();
        },
      }),
      el("div", { className: "tile-grid tile-grid-2 channel-detail-grid" }, [
        el("section", { className: "sub-card stack" }, [
          el("div", { className: "simple-header" }, [
            el("div", {}, [
              el("h3", { text: "Tempo i format" }),
              el("p", {
                className: "card-subtitle section-note",
                text: "To są ustawienia, które zwykle ruszasz dopiero po pierwszym uruchomieniu.",
              }),
            ]),
          ]),
          summaryList([
            ["Sprawdzaj co", `${channel.data.TimeChecker || ROOT_CHANNEL_DEFAULTS.TimeChecker} minut`],
            ["Na jeden cykl wyślij max", `${channel.data.RequestSend || ROOT_CHANNEL_DEFAULTS.RequestSend} wpisów`],
            ["Pole z URL-ami", channel.feedsKey],
          ]),
          el("div", { className: "field-grid compact-grid" }, [
            numberField({
              label: "Sprawdzaj co (min)",
              object: channel.data,
              key: "TimeChecker",
              allowNull: false,
              onDirty: () => markConfigDirty(),
            }),
            numberField({
              label: "Maks. wpisów na cykl",
              object: channel.data,
              key: "RequestSend",
              allowNull: false,
              onDirty: () => markConfigDirty(),
            }),
            selectField({
              label: "Pole z URL-ami",
              value: channel.feedsKey,
              options: FEED_KEYS.map((key) => ({ value: key, label: key })),
              onInput: (value) => {
                channel.feedsKey = value;
                markConfigDirty();
              },
            }),
          ]),
        ]),
        renderChannelTargetCards(group, channel, index),
      ]),
    ]));
    return card;
  }

  function renderChannelTargetCards(group, channel, index) {
    const stack = el("section", { className: "sub-card stack more-options-tile" });
    stack.append(el("div", { className: "simple-header" }, [
      el("div", {}, [
        el("h3", { text: "Więcej opcji" }),
        el("p", {
          className: "card-subtitle section-note",
          text: "Discord source, Matrix dla tego kanału i surowy JSON siedzą tutaj, żeby główny widok był spokojniejszy.",
        }),
      ]),
    ]));

    const discordCard = el("div", { className: "inner-card stack" });
    const hasDiscord = isPlainObject(channel.data.Discord);
    discordCard.append(el("div", { className: "simple-header" }, [
      el("div", {}, [
        el("h3", { text: "Czytaj z Discorda" }),
        el("p", {
          className: "card-subtitle section-note",
          text: "Włącz tylko wtedy, gdy ten kanał ma czytać wiadomości z Discorda. Token może odziedziczyć się z globalnego Auth.",
        }),
      ]),
      hasDiscord
        ? el("button", {
            className: "ghost-button",
            text: "Wyłącz",
            onClick: () => {
              delete channel.data.Discord;
              markConfigDirty("Usunięto źródło Discord.");
              render();
            },
          })
        : el("button", {
            className: "ghost-button",
            text: "Włącz",
            onClick: () => {
              channel.data.Discord = {
                ChannelIDs: [],
                Webhook: channel.data.Webhook || "",
                Thread: channel.data.Thread || "",
              };
              markConfigDirty("Dodano źródło Discord.");
              render();
            },
          }),
    ]));

    if (hasDiscord) {
      const discord = channel.data.Discord;
      discordCard.append(el("div", { className: "field-grid" }, [
        textField({
          label: "Webhook dla Discord source",
          value: discord.Webhook || "",
          onInput: (value) => {
            discord.Webhook = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "Thread dla Discord source",
          value: discord.Thread || "",
          onInput: (value) => {
            discord.Thread = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "Token",
          value: discord.Token || "",
          onInput: (value) => {
            discord.Token = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "GuildID",
          value: discord.GuildID || "",
          onInput: (value) => {
            discord.GuildID = value;
            markConfigDirty();
          },
        }),
        numberField({
          label: "Limit",
          object: discord,
          key: "Limit",
          allowNull: true,
          onDirty: () => markConfigDirty(),
        }),
        numberField({
          label: "Timeout",
          object: discord,
          key: "Timeout",
          allowNull: true,
          onDirty: () => markConfigDirty(),
        }),
      ]));
      discordCard.append(listEditor({
        label: "ChannelIDs",
        description: "Kanały Discord, z których parser ma pobierać wiadomości.",
        values: Array.isArray(discord.ChannelIDs)
          ? discord.ChannelIDs.map((item) => String(item))
          : discord.ChannelIDs
            ? [String(discord.ChannelIDs)]
            : [],
        placeholder: "123456789012345678",
        onChange: (values) => {
          discord.ChannelIDs = values;
          markConfigDirty();
        },
      }));
      discordCard.append(el("div", { className: "field-grid" }, [
        textAreaField({
          label: "cookie",
          value: discord.cookie || "",
          onInput: (value) => {
            discord.cookie = value;
            markConfigDirty();
          },
          rows: 3,
          monospace: true,
          full: true,
        }),
        textAreaField({
          label: "x-super-properties",
          value: discord["x-super-properties"] || "",
          onInput: (value) => {
            discord["x-super-properties"] = value;
            markConfigDirty();
          },
          rows: 3,
          monospace: true,
          full: true,
        }),
      ]));
    }

    const matrixCard = el("div", { className: "inner-card stack" });
    const hasMatrix = isPlainObject(channel.data.Matrix);
    matrixCard.append(el("div", { className: "simple-header" }, [
      el("div", {}, [
        el("h3", { text: "Wysyłka do Matrix" }),
        el("p", {
          className: "card-subtitle section-note",
          text: "Możesz zostawić tylko override dla tego kanału. Gdy nic nie wpiszesz, kanał skorzysta z globalnego Matrix z zakładki Ustawienia.",
        }),
      ]),
      hasMatrix
        ? el("button", {
            className: "ghost-button",
            text: "Wyłącz",
            onClick: () => {
              delete channel.data.Matrix;
              markConfigDirty("Usunięto override Matrix.");
              render();
            },
          })
        : el("button", {
            className: "ghost-button",
            text: "Włącz",
            onClick: () => {
              channel.data.Matrix = {
                Enabled: true,
                RoomID: "",
              };
              markConfigDirty("Dodano override Matrix.");
              render();
            },
          }),
    ]));

    if (hasMatrix) {
      const matrix = channel.data.Matrix;
      matrixCard.append(el("div", { className: "field-grid" }, [
        toggleField({
          label: "Matrix aktywny",
          checked: matrix.Enabled !== false,
          onInput: (checked) => {
            matrix.Enabled = checked;
            markConfigDirty();
          },
        }),
        textField({
          label: "Homeserver",
          value: matrix.Homeserver || "",
          onInput: (value) => {
            matrix.Homeserver = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "AccessToken",
          value: matrix.AccessToken || "",
          onInput: (value) => {
            matrix.AccessToken = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "RoomID",
          value: matrix.RoomID || "",
          onInput: (value) => {
            matrix.RoomID = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "MsgType",
          value: matrix.MsgType || "",
          onInput: (value) => {
            matrix.MsgType = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "Comment",
          value: matrix.Comment || "",
          onInput: (value) => {
            matrix.Comment = value;
            markConfigDirty();
          },
        }),
      ]));
    }

    stack.append(
      discordCard,
      matrixCard,
      renderChannelRawEditor(channel),
      el("div", { className: "management-strip" }, [
        el("span", {
          className: "muted",
          text: "Duplikowanie i usuwanie zostawiłem tutaj, żeby nie zaśmiecać codziennego widoku kanału.",
        }),
        el("div", { className: "inline-actions" }, [
          el("button", {
            className: "ghost-button",
            text: "Duplikuj kanał",
            onClick: () => {
              const copy = normalizeChannelEntry(channel.name, serializeChannelEntry(channel));
              copy.feeds = deepClone(channel.feeds);
              copy.feedsKey = channel.feedsKey;
              group.channels.splice(index + 1, 0, copy);
              markConfigDirty("Zduplikowano kanał.");
              render();
            },
          }),
          el("button", {
            className: "ghost-button",
            text: "Usuń kanał",
            onClick: () => {
              group.channels = group.channels.filter((entry) => entry.id !== channel.id);
              markConfigDirty("Usunięto kanał.");
              render();
            },
          }),
        ]),
      ])
    );
    return stack;
  }

  function renderChannelRawEditor(channel) {
    const details = el("details", { className: "compact-section inner-details" });
    const summary = el("summary", { className: "compact-summary", text: "Raw JSON kanału" });
    const textarea = el("textarea", {
      className: "code",
      attrs: { rows: 10 },
    });
    textarea.value = JSON.stringify(serializeChannelEntry(channel), null, 2);
    const hint = el("div", {
      className: "hint",
      text: "Wklej pełny obiekt kanału. Dashboard spróbuje przepiąć feedy i zwykłe pola z powrotem do widoku formularzowego.",
    });
    const applyButton = el("button", {
      className: "button",
      text: "Zastosuj JSON kanału",
      onClick: () => {
        try {
          const parsed = JSON.parse(textarea.value || "{}");
          const nextChannel = normalizeChannelEntry(channel.name, parsed);
          channel.data = nextChannel.data;
          channel.feeds = nextChannel.feeds;
          channel.feedsKey = nextChannel.feedsKey;
          markConfigDirty("Zaktualizowano kanał z raw JSON.");
          render();
        } catch (error) {
          state.flash = { tone: "error", text: `JSON kanału: ${error.message}` };
          syncChrome();
        }
      },
    });

    details.append(summary, hint, textarea, el("div", { className: "inline-actions" }, [applyButton]));
    return details;
  }

  function renderIntegrations() {
    const wrapper = el("div", { className: "tile-grid tile-grid-3 settings-grid" });
    const settings = ensureObject(state.config, "Settings");
    const auth = ensureObject(state.config, "Auth");
    const proxy = ensureObject(state.config, "Proxy");
    const matrix = ensureObject(state.config, "Matrix");

    wrapper.append(el("section", { className: "card tile-card tile-span-all" }, [
      el("div", { className: "simple-header" }, [
        el("div", {}, [
          el("h2", { text: "Ustawienia" }),
          el("p", {
            className: "card-subtitle section-note",
            text: "To jest wersja bardziej kafelkowa. Codzienne rzeczy mają własne sekcje, a cięższe dalej są schowane głębiej.",
          }),
        ]),
      ]),
      el("div", { className: "mini-tile-grid" }, [
        miniTile("Logi", settings.Logs === true ? "on" : "off"),
        miniTile("Proxy", proxy.Enabled ? "on" : "off"),
        miniTile("Matrix", matrix.Enabled !== false ? "on" : "off"),
      ]),
      el("div", { className: "field-grid compact-grid" }, [
        toggleField({
          label: "Włącz logi",
          checked: settings.Logs === true,
          onInput: (checked) => {
            settings.Logs = checked;
            markConfigDirty();
          },
          description: "Włącza podstawowe logowanie pracy feedera.",
        }),
      ]),
    ]));

    wrapper.append(renderFoldedCard({
      title: "Proxy",
      meta: proxy.Enabled ? "włączone" : "wyłączone",
      open: false,
      className: "settings-tile",
      content: el("div", { className: "field-grid compact-grid" }, [
        toggleField({
          label: "Proxy.Enabled",
          checked: proxy.Enabled === true,
          onInput: (checked) => {
            proxy.Enabled = checked;
            markConfigDirty();
          },
        }),
        textField({
          label: "Proxy.Url",
          value: proxy.Url || "",
          onInput: (value) => {
            proxy.Url = value;
            markConfigDirty();
          },
          placeholder: "http://127.0.0.1:8080",
        }),
      ]),
    }));

    wrapper.append(renderFoldedCard({
      title: "Global Matrix",
      meta: matrix.Enabled !== false ? "aktywny" : "wyłączony",
      open: false,
      className: "settings-tile",
      content: el("div", { className: "field-grid compact-grid" }, [
        toggleField({
          label: "Matrix.Enabled",
          checked: matrix.Enabled !== false,
          onInput: (checked) => {
            matrix.Enabled = checked;
            markConfigDirty();
          },
        }),
        textField({
          label: "Homeserver",
          value: matrix.Homeserver || "",
          onInput: (value) => {
            matrix.Homeserver = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "AccessToken",
          value: matrix.AccessToken || "",
          onInput: (value) => {
            matrix.AccessToken = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "RoomID",
          value: matrix.RoomID || "",
          onInput: (value) => {
            matrix.RoomID = value;
            markConfigDirty();
          },
        }),
        textField({
          label: "MsgType",
          value: matrix.MsgType || "",
          onInput: (value) => {
            matrix.MsgType = value;
            markConfigDirty();
          },
        }),
      ]),
    }));

    wrapper.append(renderFoldedCard({
      title: "Auth / Discord credentials",
      meta: "pomocnicze",
      open: false,
      className: "settings-tile",
      content: el("div", { className: "stack" }, [
        el("p", {
          className: "hint",
          text: "Te dane są globalnym źródłem dla parsera Discord. Kanał może je odziedziczyć albo nadpisać własnymi polami w sekcji Discord source.",
        }),
        el("div", { className: "field-grid" }, [
          textField({
            label: "Auth.Token",
            value: auth.Token || "",
            onInput: (value) => {
              auth.Token = value;
              markConfigDirty();
            },
          }),
          textAreaField({
            label: "Auth.x-super-properties",
            value: auth["x-super-properties"] || "",
            onInput: (value) => {
              auth["x-super-properties"] = value;
              markConfigDirty();
            },
            rows: 4,
            monospace: true,
            full: true,
          }),
          textAreaField({
            label: "Auth.cookie",
            value: auth.cookie || "",
            onInput: (value) => {
              auth.cookie = value;
              markConfigDirty();
            },
            rows: 4,
            monospace: true,
            full: true,
          }),
        ]),
      ]),
    }));

    return wrapper;
  }

  function renderScrapling() {
    const wrapper = el("div", { className: "tile-grid tile-grid-2 scrapling-grid" });
    const scrapling = ensureObject(state.config, "Scrapling");
    const antiBot = ensureObject(scrapling, "AntiBot");
    const defaultOptions = ensureObject(scrapling, "DefaultOptions");
    const perUrlConfig = ensureObject(scrapling, "PerUrlConfig");
    const profileCount = Object.keys(perUrlConfig).length;

    wrapper.append(el("section", { className: "card tile-card tile-span-all" }, [
      el("div", { className: "simple-header" }, [
        el("div", {}, [
          el("h3", { text: "Scrapling" }),
          el("p", {
            className: "card-subtitle section-note",
            text: "Tu siedzi cała część anti-bot, tryby fetchowania i profile per URL. Rozbiłem to na osobne sekcje, żeby było lżej do czytania.",
          }),
        ]),
      ]),
      el("div", { className: "mini-tile-grid" }, [
        miniTile("Status", scrapling.Enabled !== false ? "aktywny" : "off"),
        miniTile("Tryb", scrapling.PreferredMode || "cli"),
        miniTile("Fallback", String(Array.isArray(scrapling.FallbackStatusCodes) ? scrapling.FallbackStatusCodes.length : 0)),
        miniTile("Profile URL", String(profileCount)),
      ]),
    ]));

    wrapper.append(renderFoldedCard({
      title: "Scrapling podstawy",
      meta: scrapling.Enabled !== false ? "aktywny" : "wyłączony",
      open: false,
      className: "scrapling-tile",
      content: el("div", { className: "stack" }, [
        el("div", { className: "field-grid compact-grid" }, [
          toggleField({
            label: "Enabled",
            checked: scrapling.Enabled !== false,
            onInput: (checked) => {
              scrapling.Enabled = checked;
              markConfigDirty();
            },
          }),
          toggleField({
            label: "ForceGlobal",
            checked: scrapling.ForceGlobal === true,
            onInput: (checked) => {
              scrapling.ForceGlobal = checked;
              markConfigDirty();
            },
          }),
          toggleField({
            label: "AutoFallback",
            checked: scrapling.AutoFallback !== false,
            onInput: (checked) => {
              scrapling.AutoFallback = checked;
              markConfigDirty();
            },
          }),
          toggleField({
            label: "AutoUseShellForAdvancedOptions",
            checked: scrapling.AutoUseShellForAdvancedOptions !== false,
            onInput: (checked) => {
              scrapling.AutoUseShellForAdvancedOptions = checked;
              markConfigDirty();
            },
          }),
          selectField({
            label: "PreferredMode",
            value: scrapling.PreferredMode || "cli",
            options: RUNTIME_OPTIONS.map((value) => ({ value, label: value })),
            onInput: (value) => {
              scrapling.PreferredMode = value;
              markConfigDirty();
            },
          }),
        ]),
        listEditor({
          label: "FallbackStatusCodes",
          description: "Statusy HTTP, po których downloader powinien próbować Scrapling fallback.",
          values: Array.isArray(scrapling.FallbackStatusCodes)
            ? scrapling.FallbackStatusCodes.map((value) => String(value))
            : [],
          placeholder: "403",
          onChange: (values) => {
            scrapling.FallbackStatusCodes = values
              .map((value) => Number(value))
              .filter((value) => Number.isFinite(value));
            markConfigDirty();
          },
        }),
      ]),
    }));

    wrapper.append(renderFoldedCard({
      title: "AntiBot",
      meta: "heurystyki",
      open: false,
      className: "scrapling-tile",
      content: renderAntiBotCard(antiBot),
    }));
    wrapper.append(renderFoldedCard({
      title: "DefaultOptions",
      meta: "fetch defaults",
      open: false,
      className: "scrapling-tile",
      content: renderDefaultOptionsCard(defaultOptions),
    }));
    wrapper.append(renderFoldedCard({
      title: "PerUrlConfig",
      meta: `${profileCount} profili`,
      open: false,
      className: "scrapling-tile",
      content: renderPerUrlProfiles(perUrlConfig),
    }));

    return wrapper;
  }

  function renderAntiBotCard(antiBot) {
    return el("section", { className: "card" }, [
      el("div", { className: "card-header" }, [
        el("div", {}, [
          el("h3", { text: "AntiBot" }),
          el("p", {
            className: "card-subtitle section-note",
            text: "Detekcja challenge pages, kolejność trybów i czułość heurystyk.",
          }),
        ]),
      ]),
      el("div", { className: "field-grid" }, [
        toggleField({
          label: "Enabled",
          checked: antiBot.Enabled !== false,
          onInput: (checked) => {
            antiBot.Enabled = checked;
            markConfigDirty();
          },
        }),
        toggleField({
          label: "LogDecisions",
          checked: antiBot.LogDecisions === true,
          onInput: (checked) => {
            antiBot.LogDecisions = checked;
            markConfigDirty();
          },
        }),
        toggleField({
          label: "PreferStealthOnSignals",
          checked: antiBot.PreferStealthOnSignals !== false,
          onInput: (checked) => {
            antiBot.PreferStealthOnSignals = checked;
            markConfigDirty();
          },
        }),
        toggleField({
          label: "TreatCloudflareAsSignal",
          checked: antiBot.TreatCloudflareAsSignal !== false,
          onInput: (checked) => {
            antiBot.TreatCloudflareAsSignal = checked;
            markConfigDirty();
          },
        }),
        numberField({
          label: "MinBodyBytes",
          object: antiBot,
          key: "MinBodyBytes",
          allowNull: true,
          onDirty: () => markConfigDirty(),
        }),
        numberField({
          label: "MinConfidence",
          object: antiBot,
          key: "MinConfidence",
          allowNull: true,
          onDirty: () => markConfigDirty(),
        }),
        numberField({
          label: "MaxAttempts",
          object: antiBot,
          key: "MaxAttempts",
          allowNull: true,
          onDirty: () => markConfigDirty(),
        }),
      ]),
      listEditor({
        label: "ModeOrder",
        values: normalizeStringList(antiBot.ModeOrder),
        placeholder: "stealthy-fetch",
        onChange: (values) => {
          antiBot.ModeOrder = values;
          markConfigDirty();
        },
      }),
      listEditor({
        label: "StatusCodes",
        values: Array.isArray(antiBot.StatusCodes) ? antiBot.StatusCodes.map(String) : [],
        placeholder: "403",
        onChange: (values) => {
          antiBot.StatusCodes = values.map(Number).filter((value) => Number.isFinite(value));
          markConfigDirty();
        },
      }),
      listEditor({
        label: "HeaderKeys",
        values: normalizeStringList(antiBot.HeaderKeys),
        placeholder: "cf-mitigated",
        onChange: (values) => {
          antiBot.HeaderKeys = values;
          markConfigDirty();
        },
      }),
      listEditor({
        label: "BodySignatures",
        values: normalizeStringList(antiBot.BodySignatures),
        placeholder: "just a moment",
        onChange: (values) => {
          antiBot.BodySignatures = values;
          markConfigDirty();
        },
      }),
      listEditor({
        label: "TitleSignatures",
        values: normalizeStringList(antiBot.TitleSignatures),
        placeholder: "access denied",
        onChange: (values) => {
          antiBot.TitleSignatures = values;
          markConfigDirty();
        },
      }),
    ]);
  }

  function renderDefaultOptionsCard(defaultOptions) {
    const card = el("section", { className: "card" });
    card.append(el("div", { className: "card-header" }, [
      el("div", {}, [
        el("h3", { text: "DefaultOptions" }),
        el("p", {
          className: "card-subtitle section-note",
          text: "Najczęściej używane pola mają formularz, a całość można zawsze dociąć raw JSON-em.",
        }),
      ]),
    ]));

    card.append(el("div", { className: "field-grid" }, [
      selectField({
        label: "runtimeMode",
        value: defaultOptions.runtimeMode || "",
        options: [{ value: "", label: "brak" }].concat(RUNTIME_OPTIONS.map((value) => ({ value, label: value }))),
        onInput: (value) => {
          defaultOptions.runtimeMode = value || null;
          markConfigDirty();
        },
      }),
      selectField({
        label: "extractMode",
        value: defaultOptions.extractMode || "",
        options: [{ value: "", label: "brak" }].concat(MODE_OPTIONS.map((value) => ({ value, label: value }))),
        onInput: (value) => {
          defaultOptions.extractMode = value || null;
          markConfigDirty();
        },
      }),
      selectField({
        label: "mode",
        value: defaultOptions.mode || "",
        options: [{ value: "", label: "brak" }].concat(MODE_OPTIONS.map((value) => ({ value, label: value }))),
        onInput: (value) => {
          defaultOptions.mode = value || null;
          markConfigDirty();
        },
      }),
      textField({
        label: "waitSelector",
        value: defaultOptions.waitSelector || "",
        onInput: (value) => {
          defaultOptions.waitSelector = value || null;
          markConfigDirty();
        },
      }),
      selectField({
        label: "waitSelectorState",
        value: defaultOptions.waitSelectorState || "",
        options: [{ value: "", label: "brak" }].concat(WAIT_SELECTOR_STATES.map((value) => ({ value, label: value }))),
        onInput: (value) => {
          defaultOptions.waitSelectorState = value || null;
          markConfigDirty();
        },
      }),
      textField({
        label: "locale",
        value: defaultOptions.locale || "",
        onInput: (value) => {
          defaultOptions.locale = value || null;
          markConfigDirty();
        },
      }),
      textField({
        label: "proxy",
        value: defaultOptions.proxy || "",
        onInput: (value) => {
          defaultOptions.proxy = value || null;
          markConfigDirty();
        },
      }),
      textField({
        label: "impersonate",
        value: defaultOptions.impersonate || "",
        onInput: (value) => {
          defaultOptions.impersonate = value || null;
          markConfigDirty();
        },
      }),
      textField({
        label: "cookies",
        value: defaultOptions.cookies || "",
        onInput: (value) => {
          defaultOptions.cookies = value;
          markConfigDirty();
        },
      }),
      numberField({
        label: "timeoutSeconds",
        object: defaultOptions,
        key: "timeoutSeconds",
        allowNull: true,
        onDirty: () => markConfigDirty(),
      }),
      numberField({
        label: "timeoutMs",
        object: defaultOptions,
        key: "timeoutMs",
        allowNull: true,
        onDirty: () => markConfigDirty(),
      }),
      numberField({
        label: "timeout",
        object: defaultOptions,
        key: "timeout",
        allowNull: true,
        onDirty: () => markConfigDirty(),
      }),
      numberField({
        label: "wait",
        object: defaultOptions,
        key: "wait",
        allowNull: true,
        onDirty: () => markConfigDirty(),
      }),
      numberField({
        label: "maxPages",
        object: defaultOptions,
        key: "maxPages",
        allowNull: true,
        onDirty: () => markConfigDirty(),
      }),
      toggleField({
        label: "headless",
        checked: defaultOptions.headless === true,
        onInput: (checked) => {
          defaultOptions.headless = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "networkIdle",
        checked: defaultOptions.networkIdle === true,
        onInput: (checked) => {
          defaultOptions.networkIdle = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "disableResources",
        checked: defaultOptions.disableResources === true,
        onInput: (checked) => {
          defaultOptions.disableResources = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "dnsOverHttps",
        checked: defaultOptions.dnsOverHttps === true,
        onInput: (checked) => {
          defaultOptions.dnsOverHttps = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "blockAds",
        checked: defaultOptions.blockAds === true,
        onInput: (checked) => {
          defaultOptions.blockAds = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "blockWebrtc",
        checked: defaultOptions.blockWebrtc === true,
        onInput: (checked) => {
          defaultOptions.blockWebrtc = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "solveCloudflare",
        checked: defaultOptions.solveCloudflare === true,
        onInput: (checked) => {
          defaultOptions.solveCloudflare = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "solveCaptcha",
        checked: defaultOptions.solveCaptcha === true,
        onInput: (checked) => {
          defaultOptions.solveCaptcha = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "allowWebgl",
        checked: defaultOptions.allowWebgl !== false,
        onInput: (checked) => {
          defaultOptions.allowWebgl = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "hideCanvas",
        checked: defaultOptions.hideCanvas === true,
        onInput: (checked) => {
          defaultOptions.hideCanvas = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "realChrome",
        checked: defaultOptions.realChrome === true,
        onInput: (checked) => {
          defaultOptions.realChrome = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "googleSearch",
        checked: defaultOptions.googleSearch === true,
        onInput: (checked) => {
          defaultOptions.googleSearch = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "followRedirects",
        checked: defaultOptions.followRedirects !== false,
        onInput: (checked) => {
          defaultOptions.followRedirects = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "verify",
        checked: defaultOptions.verify !== false,
        onInput: (checked) => {
          defaultOptions.verify = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "stealthyHeaders",
        checked: defaultOptions.stealthyHeaders === true,
        onInput: (checked) => {
          defaultOptions.stealthyHeaders = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "aiTargeted",
        checked: defaultOptions.aiTargeted === true,
        onInput: (checked) => {
          defaultOptions.aiTargeted = checked;
          markConfigDirty();
        },
      }),
    ]));

    card.append(renderJsonApplyField({
      title: "Zaawansowane pola DefaultOptions",
      value: defaultOptions,
      description: "Pełny JSON dla DefaultOptions. Przydatne dla `headers`, `extraHeaders`, `params`, `auth`, `jsonData`, `proxyRotator` i innych rzadkich pól.",
      onApply: (parsed) => {
        state.config.Scrapling.DefaultOptions = parsed;
        markConfigDirty("Zaktualizowano DefaultOptions z raw JSON.");
        render();
      },
    }));

    return card;
  }

  function renderPerUrlProfiles(perUrlConfig) {
    const card = el("section", { className: "card" });
    const profiles = Object.entries(perUrlConfig).map(([url, value]) => ({
      id: nextId("profile"),
      url,
      data: isPlainObject(value) ? value : {},
    }));

    card.append(el("div", { className: "card-header" }, [
      el("div", {}, [
        el("h3", { text: "PerUrlConfig" }),
        el("p", {
          className: "card-subtitle section-note",
          text: "Dedykowane profile dla konkretnych URL-i. Każdy profil ma szybkie pola i własny raw JSON.",
        }),
      ]),
      el("button", {
        className: "button",
        text: "Dodaj profil URL",
        onClick: () => {
          perUrlConfig[`https://example.com/feed-${Object.keys(perUrlConfig).length + 1}`] = {
            enabled: true,
            mode: "fetch",
          };
          markConfigDirty("Dodano profil URL.");
          render();
        },
      }),
    ]));

    if (!profiles.length) {
      card.append(el("div", { className: "empty-state", text: "Brak profili PerUrlConfig." }));
      return card;
    }

    const stack = el("div", { className: "stack" });
    profiles.forEach((profile) => {
      stack.append(renderPerUrlProfile(perUrlConfig, profile));
    });
    card.append(stack);
    return card;
  }

  function renderPerUrlProfile(container, profile) {
    const profileCard = el("details", { className: "profile-card compact-section" });
    const data = profile.data;
    const htmlParseOptions = ensureObject(data, "htmlParseOptions");
    const antiBot = ensureObject(data, "antiBot");

    profileCard.append(el("summary", { className: "compact-summary" }, [
      el("div", {}, [
        el("strong", { text: profile.url }),
        el("div", {
          className: "compact-meta",
          text: `${data.mode || data.extractMode || "brak trybu"} · ${data.enabled !== false ? "aktywny" : "wyłączony"}`,
        }),
      ]),
    ]));

    const body = el("div", { className: "section-body stack" }, [
      el("p", {
        className: "section-note muted",
        text: "Profil URL z szybkim dostępem do kluczowych przełączników Scrapling.",
      }),
      el("div", { className: "field-grid" }, [
      textFieldWithAction({
        label: "URL klucza profilu",
        value: profile.url,
        buttonLabel: "Zastosuj URL",
        onApply: (value) => {
          const trimmed = value.trim();
          if (!trimmed || trimmed === profile.url) return;
          delete container[profile.url];
          container[trimmed] = data;
          markConfigDirty("Zmieniono klucz URL profilu.");
          render();
        },
      }),
      toggleField({
        label: "enabled",
        checked: data.enabled !== false,
        onInput: (checked) => {
          data.enabled = checked;
          markConfigDirty();
        },
      }),
      selectField({
        label: "runtimeMode",
        value: data.runtimeMode || "",
        options: [{ value: "", label: "brak" }].concat(RUNTIME_OPTIONS.map((value) => ({ value, label: value }))),
        onInput: (value) => {
          data.runtimeMode = value || null;
          markConfigDirty();
        },
      }),
      selectField({
        label: "extractMode",
        value: data.extractMode || "",
        options: [{ value: "", label: "brak" }].concat(MODE_OPTIONS.map((value) => ({ value, label: value }))),
        onInput: (value) => {
          data.extractMode = value || null;
          markConfigDirty();
        },
      }),
      selectField({
        label: "mode",
        value: data.mode || "",
        options: [{ value: "", label: "brak" }].concat(MODE_OPTIONS.map((value) => ({ value, label: value }))),
        onInput: (value) => {
          data.mode = value || null;
          markConfigDirty();
        },
      }),
      numberField({
        label: "timeoutMs",
        object: data,
        key: "timeoutMs",
        allowNull: true,
        onDirty: () => markConfigDirty(),
      }),
      numberField({
        label: "wait",
        object: data,
        key: "wait",
        allowNull: true,
        onDirty: () => markConfigDirty(),
      }),
      numberField({
        label: "maxPages",
        object: data,
        key: "maxPages",
        allowNull: true,
        onDirty: () => markConfigDirty(),
      }),
      textField({
        label: "waitSelector",
        value: data.waitSelector || "",
        onInput: (value) => {
          data.waitSelector = value || null;
          markConfigDirty();
        },
      }),
      selectField({
        label: "waitSelectorState",
        value: data.waitSelectorState || "",
        options: [{ value: "", label: "brak" }].concat(WAIT_SELECTOR_STATES.map((value) => ({ value, label: value }))),
        onInput: (value) => {
          data.waitSelectorState = value || null;
          markConfigDirty();
        },
      }),
      textField({
        label: "proxy",
        value: data.proxy || "",
        onInput: (value) => {
          data.proxy = value || null;
          markConfigDirty();
        },
      }),
      textField({
        label: "locale",
        value: data.locale || "",
        onInput: (value) => {
          data.locale = value || null;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "headless",
        checked: data.headless === true,
        onInput: (checked) => {
          data.headless = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "networkIdle",
        checked: data.networkIdle === true,
        onInput: (checked) => {
          data.networkIdle = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "disableResources",
        checked: data.disableResources === true,
        onInput: (checked) => {
          data.disableResources = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "dnsOverHttps",
        checked: data.dnsOverHttps === true,
        onInput: (checked) => {
          data.dnsOverHttps = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "solveCloudflare",
        checked: data.solveCloudflare === true,
        onInput: (checked) => {
          data.solveCloudflare = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "solveCaptcha",
        checked: data.solveCaptcha === true,
        onInput: (checked) => {
          data.solveCaptcha = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "blockAds",
        checked: data.blockAds === true,
        onInput: (checked) => {
          data.blockAds = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "blockWebrtc",
        checked: data.blockWebrtc === true,
        onInput: (checked) => {
          data.blockWebrtc = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "allowWebgl",
        checked: data.allowWebgl !== false,
        onInput: (checked) => {
          data.allowWebgl = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "hideCanvas",
        checked: data.hideCanvas === true,
        onInput: (checked) => {
          data.hideCanvas = checked;
          markConfigDirty();
        },
      }),
      toggleField({
        label: "realChrome",
        checked: data.realChrome === true,
        onInput: (checked) => {
          data.realChrome = checked;
          markConfigDirty();
        },
      }),
      ]),
      el("div", { className: "grid cols-2" }, [
      el("div", { className: "sub-card" }, [
        el("h3", { text: "htmlParseOptions" }),
        el("div", { className: "field-grid" }, [
          textField({
            label: "itemSelector",
            value: htmlParseOptions.itemSelector || "",
            onInput: (value) => {
              htmlParseOptions.itemSelector = value;
              markConfigDirty();
            },
          }),
          textField({
            label: "titleSelector",
            value: htmlParseOptions.titleSelector || "",
            onInput: (value) => {
              htmlParseOptions.titleSelector = value;
              markConfigDirty();
            },
          }),
          textField({
            label: "linkSelector",
            value: htmlParseOptions.linkSelector || "",
            onInput: (value) => {
              htmlParseOptions.linkSelector = value;
              markConfigDirty();
            },
          }),
        ]),
      ]),
      el("div", { className: "sub-card" }, [
        el("h3", { text: "antiBot override" }),
        el("div", { className: "field-grid" }, [
          numberField({
            label: "MinBodyBytes",
            object: antiBot,
            key: "MinBodyBytes",
            allowNull: true,
            onDirty: () => markConfigDirty(),
          }),
          numberField({
            label: "MinConfidence",
            object: antiBot,
            key: "MinConfidence",
            allowNull: true,
            onDirty: () => markConfigDirty(),
          }),
        ]),
        listEditor({
          label: "ModeOrder",
          values: normalizeStringList(antiBot.ModeOrder),
          placeholder: "fetch",
          onChange: (values) => {
            antiBot.ModeOrder = values;
            markConfigDirty();
          },
        }),
      ]),
      ]),
      renderJsonApplyField({
        title: "Pełny raw JSON profilu",
        value: data,
        description: "Tu wrzucisz wszystkie niestandardowe pola profilu, jeśli quick form nie wystarcza.",
        onApply: (parsed) => {
          container[profile.url] = parsed;
          markConfigDirty("Zaktualizowano profil URL z raw JSON.");
          render();
        },
      }),
      el("div", { className: "management-strip" }, [
        el("span", { className: "muted", text: "Usunięcie profilu zostawiłem na dole, bo to rzadsza akcja." }),
        el("button", {
          className: "ghost-button",
          text: "Usuń profil",
          onClick: () => {
            delete container[profile.url];
            markConfigDirty("Usunięto profil URL.");
            render();
          },
        }),
      ]),
    ]);

    profileCard.append(body);
    return profileCard;
  }

  function renderAdvanced() {
    const wrapper = el("div", { className: "tile-grid tile-grid-3 advanced-grid" });
    const fullConfig = buildConfigForSave();
    const scrapling = ensureObject(state.config, "Scrapling");
    const perUrlConfig = ensureObject(scrapling, "PerUrlConfig");
    const envRefs = computeOverviewStats().envRefs || [];

    wrapper.append(el("section", { className: "card tile-card tile-span-all" }, [
      el("div", { className: "simple-header" }, [
        el("div", {}, [
          el("h2", { text: "Advanced" }),
          el("p", {
            className: "card-subtitle section-note",
            text: "Tutaj są wszystkie rzeczy techniczne: Scrapling, surowy config, `.env` i cache. Ułożyłem to jak spokojny panel techniczny, a nie jedną długą listę.",
          }),
        ]),
      ]),
      el("div", { className: "mini-tile-grid" }, [
        miniTile("Scrapling", scrapling.Enabled !== false ? "on" : "off"),
        miniTile("Profile URL", String(Object.keys(perUrlConfig).length)),
        miniTile(".env refs", String(envRefs.length)),
        miniTile("Cache", `${state.cacheSummary?.totalItems || 0}`),
      ]),
    ]));

    wrapper.append(
      tileCard({
        title: "Scrapling",
        value: scrapling.Enabled !== false ? "Aktywny" : "Wyłączony",
        note: "Anti-bot, tryby fetchowania i profile per URL.",
      }),
      tileCard({
        title: "config.json",
        value: "Raw JSON",
        note: "Pełny podgląd i ręczna edycja całego configu.",
      }),
      tileCard({
        title: ".env",
        value: state.dirtyEnv ? "Niezapisane zmiany" : "Gotowe",
        note: envRefs.length ? `Referencje: ${envRefs.slice(0, 2).join(", ")}${envRefs.length > 2 ? ` +${envRefs.length - 2}` : ""}` : "Brak aktywnych referencji.",
      }),
      tileCard({
        title: "Cache",
        value: `${state.cacheSummary?.totalItems || 0}`,
        note: "Podgląd zapamiętanych wpisów i bucketów.",
      })
    );

    wrapper.append(renderFoldedCard({
      title: "Scrapling",
      meta: "opcje zaawansowane",
      open: false,
      className: "advanced-tile",
      content: renderScrapling(),
    }));

    wrapper.append(renderFoldedCard({
      title: "Pełny config.json",
      meta: "raw JSON",
      open: false,
      className: "advanced-tile",
      content: renderJsonApplyField({
        title: "Pełny config.json",
        value: fullConfig,
        description: "Po zastosowaniu dashboard przeładuje wszystkie zakładki z nowego JSON-a, ale plik zapiszesz dopiero przyciskiem `Zapisz`.",
        onApply: (parsed) => {
          loadConfigIntoState(parsed);
          markConfigDirty("Wczytano nowy JSON do dashboardu.");
          render();
        },
        rows: 24,
      }),
    }));

    wrapper.append(renderFoldedCard({
      title: ".env",
      meta: state.dirtyEnv ? "niezapisane zmiany" : "plik środowiskowy",
      open: false,
      className: "advanced-tile",
      content: el("div", { className: "stack" }, [
        el("div", { className: "inline-actions" }, [
          el("button", {
            className: "button",
            text: "Zapisz .env",
            onClick: saveEnv,
          }),
        ]),
        textAreaField({
          label: "Bieżący plik .env",
          value: state.envFile,
          onInput: (value) => {
            state.envFile = value;
            markEnvDirty();
          },
          rows: 18,
          monospace: true,
          full: true,
        }),
        textAreaField({
          label: "Podgląd .env.example",
          value: state.envExample || "",
          onInput: function noop() {},
          rows: 10,
          monospace: true,
          readOnly: true,
          full: true,
        }),
      ]),
    }));

    wrapper.append(renderFoldedCard({
      title: "Cache preview",
      meta: `${state.cacheSummary?.totalItems || 0} wpisów`,
      open: false,
      className: "advanced-tile",
      content: state.cacheSummary?.preview?.length
        ? renderCacheTable(state.cacheSummary.preview)
        : el("div", { className: "empty-state", text: "Cache jest pusty." }),
    }));

    return wrapper;
  }

  function describeChannelTargets(channel) {
    const parts = [];
    if (typeof channel?.data?.Webhook === "string" && channel.data.Webhook.trim()) {
      parts.push("webhook");
    }
    if (hasMatrixDeliveryTargetClient(getEffectiveMatrixConfig(channel?.data))) {
      parts.push("matrix");
    }
    if (isPlainObject(channel?.data?.Discord)) {
      parts.push("discord source");
    }
    return parts.join(" + ") || "brak targetu";
  }

  function summaryList(rows) {
    const list = el("div", { className: "summary-list" });
    rows.forEach(([label, value]) => {
      list.append(el("div", { className: "summary-row" }, [
        el("span", { className: "summary-label", text: label }),
        el("span", { className: "summary-value", text: value }),
      ]));
    });
    return list;
  }

  function miniTile(label, value) {
    return el("div", { className: "mini-tile" }, [
      el("span", { className: "mini-tile-label", text: label }),
      el("strong", { className: "mini-tile-value", text: value }),
    ]);
  }

  function tileCard({ title, value = "", note = "", children = [], wide = false }) {
    const content = [];
    if (title) {
      content.push(el("div", { className: "tile-title", text: title }));
    }
    if (value) {
      content.push(el("div", { className: "tile-value" }, [
        el("strong", { text: value }),
      ]));
    }
    if (note) {
      content.push(el("div", { className: "tile-note", text: note }));
    }
    if (!Array.isArray(children)) {
      children = [children];
    }
    content.push(...children.filter(Boolean));
    return el("section", { className: `card tile-card${wide ? " tile-span-all" : ""}` }, content);
  }

  function renderFoldedCard({ title, meta = "", open = false, content, className = "" }) {
    const details = el("details", { className: `compact-section${className ? ` ${className}` : ""}` });
    if (open) details.open = true;
    details.append(el("summary", { className: "compact-summary" }, [
      el("div", {}, [
        el("strong", { text: title }),
        meta ? el("div", { className: "compact-meta", text: meta }) : null,
      ].filter(Boolean)),
    ]));
    details.append(el("div", { className: "section-body stack" }, [content]));
    return details;
  }

  function renderCacheTable(rows) {
    const table = el("table", { className: "cache-table" });
    table.append(el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Kanał" }),
        el("th", { text: "Bucket" }),
        el("th", { text: "Ilość" }),
      ]),
    ]));
    const body = el("tbody");
    rows.forEach((row) => {
      body.append(el("tr", {}, [
        el("td", { text: row.channel }),
        el("td", { text: row.bucket }),
        el("td", { text: String(row.count) }),
      ]));
    });
    table.append(body);
    return table;
  }

  function renderJsonApplyField({ title, value, description, onApply, rows = 10 }) {
    const details = el("details");
    const textarea = el("textarea", {
      className: "code",
      attrs: { rows: String(rows) },
    });
    textarea.value = JSON.stringify(value == null ? {} : value, null, 2);
    const hint = el("div", { className: "hint", text: description || "" });
    const applyButton = el("button", {
      className: "button",
      text: "Zastosuj JSON",
      onClick: () => {
        try {
          const parsed = JSON.parse(textarea.value || "{}");
          onApply(parsed);
        } catch (error) {
          state.flash = { tone: "error", text: `${title}: ${error.message}` };
          syncChrome();
        }
      },
    });

    details.append(
      el("summary", { text: title }),
      hint,
      textarea,
      el("div", { className: "inline-actions" }, [applyButton])
    );
    return details;
  }

  function textField({ label, value, onInput, placeholder = "", full = false }) {
    return fieldWrapper(label, "", full, el("input", {
      attrs: {
        type: "text",
        value: value || "",
        placeholder,
      },
      onInput: (event) => onInput(event.target.value),
    }));
  }

  function textFieldWithAction({ label, value, buttonLabel, onApply, placeholder = "", full = false }) {
    const input = el("input", {
      attrs: {
        type: "text",
        value: value || "",
        placeholder,
      },
    });

    const actionRow = el("div", { className: "inline-actions" }, [
      input,
      el("button", {
        className: "button",
        text: buttonLabel,
        onClick: () => onApply(input.value),
      }),
    ]);

    return fieldWrapper(label, "", full, actionRow);
  }

  function textAreaField({ label, value, onInput, rows = 6, full = false, monospace = false, readOnly = false }) {
    const textarea = el("textarea", {
      className: monospace ? "code" : "",
      attrs: { rows: String(rows) },
      onInput: readOnly ? undefined : (event) => onInput(event.target.value),
    });
    textarea.value = value || "";
    if (readOnly) textarea.readOnly = true;
    return fieldWrapper(label, "", full, textarea);
  }

  function numberField({ label, object, key, allowNull = true, onDirty }) {
    const input = el("input", {
      attrs: {
        type: "number",
        value: object[key] == null ? "" : String(object[key]),
      },
      onInput: (event) => {
        const raw = event.target.value.trim();
        object[key] = raw === ""
          ? (allowNull ? null : 0)
          : Number(raw);
        onDirty();
      },
    });
    return fieldWrapper(label, "", false, input);
  }

  function selectField({ label, value, options, onInput }) {
    const select = el("select", {
      onInput: (event) => onInput(event.target.value),
    });
    options.forEach((option) => {
      const node = el("option", {
        attrs: { value: option.value },
        text: option.label,
      });
      if (option.value === value) node.selected = true;
      select.append(node);
    });
    return fieldWrapper(label, "", false, select);
  }

  function toggleField({ label, checked, onInput, description = "" }) {
    const input = el("input", {
      attrs: { type: "checkbox" },
      onInput: (event) => onInput(event.target.checked),
    });
    input.checked = Boolean(checked);
    return el("div", { className: "toggle" }, [
      input,
      el("div", { className: "toggle-copy" }, [
        el("strong", { text: label }),
        description ? el("span", { className: "muted", text: description }) : null,
      ].filter(Boolean)),
    ]);
  }

  function listEditor({ label, description = "", values, onChange, placeholder = "" }) {
    const container = el("div", { className: "field full" });
    container.append(el("label", { text: label }));
    if (description) {
      container.append(el("div", { className: "hint", text: description }));
    }

    const list = el("div", { className: "list-editor" });

    function rerenderRows() {
      list.innerHTML = "";
      values.forEach((value, index) => {
        list.append(el("div", { className: "list-row" }, [
          el("input", {
            attrs: {
              type: "text",
              value: value || "",
              placeholder,
            },
            onInput: (event) => {
              values[index] = event.target.value;
              onChange(normalizeStringList(values));
            },
          }),
          el("button", {
            className: "ghost-button",
            text: "Usuń",
            onClick: () => {
              values.splice(index, 1);
              onChange(normalizeStringList(values));
              rerenderRows();
            },
          }),
        ]));
      });
    }

    rerenderRows();
    container.append(list);
    container.append(el("div", { className: "inline-actions" }, [
      el("button", {
        className: "button",
        text: "Dodaj pozycję",
        onClick: () => {
          values.push("");
          rerenderRows();
        },
      }),
    ]));
    return container;
  }

  function fieldWrapper(label, description, full, control) {
    const wrapper = el("div", { className: `field${full ? " full" : ""}` });
    wrapper.append(el("label", { text: label }));
    wrapper.append(control);
    if (description) {
      wrapper.append(el("div", { className: "hint", text: description }));
    }
    return wrapper;
  }

  function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text != null) node.textContent = options.text;
    if (options.html != null) node.innerHTML = options.html;
    if (options.attrs) {
      Object.entries(options.attrs).forEach(([key, value]) => {
        node.setAttribute(key, value);
      });
    }
    if (options.onClick) node.addEventListener("click", options.onClick);
    if (options.onInput) node.addEventListener("input", options.onInput);
    if (!Array.isArray(children)) {
      children = [children];
    }
    children.filter(Boolean).forEach((child) => {
      if (typeof child === "string") {
        node.append(document.createTextNode(child));
      } else {
        node.append(child);
      }
    });
    return node;
  }
})();
