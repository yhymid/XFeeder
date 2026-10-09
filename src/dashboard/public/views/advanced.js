import { state, changed, envDirty } from "../state.js";
import { clone, isObject, safeUrl } from "../model.mjs";
import {
  el,
  button,
  badge,
  heading,
  card,
  stack,
  grid,
  input,
  select,
  secret,
  disclosure,
  toast,
  dialog,
  confirm,
  jsonEditor,
  empty,
} from "../ui.js";

const modes = ["get", "post", "put", "delete", "fetch", "stealthy-fetch"];
const runtime = [
  ["runtimeMode", "Runtime", ["cli", "shell"]],
  ["extractMode", "Extraction mode", modes],
  ["mode", "Fetch mode", modes],
  ["timeoutSeconds", "Timeout (seconds)", "number"],
  ["timeoutMs", "Timeout (ms)", "number"],
  ["timeout", "Legacy timeout", "number"],
  ["maxPages", "Maximum pages", "number"],
  ["proxy", "Proxy URL", "secret"],
  ["impersonate", "Browser impersonation", "text"],
  ["cookies", "Cookies", "secret"],
  ["followRedirects", "Follow redirects", "boolean"],
  ["verify", "Verify TLS certificates", "boolean"],
  ["stealthyHeaders", "Stealth headers", "boolean"],
  ["aiTargeted", "AI extraction", "boolean"],
];
const browser = [
  ["headless", "Headless browser", "boolean"],
  ["wait", "Wait after load (ms)", "number"],
  ["networkIdle", "Wait for network idle", "boolean"],
  ["waitSelector", "Wait for selector", "text"],
  [
    "waitSelectorState",
    "Selector state",
    ["attached", "visible", "hidden", "detached"],
  ],
  ["disableResources", "Disable extra resources", "boolean"],
  ["dnsOverHttps", "DNS over HTTPS", "boolean"],
  ["blockAds", "Block ads", "boolean"],
  ["blockWebrtc", "Block WebRTC", "boolean"],
  ["solveCloudflare", "Solve Cloudflare challenges", "boolean"],
  ["solveCaptcha", "Solve CAPTCHA", "boolean"],
  ["allowWebgl", "Allow WebGL", "boolean"],
  ["hideCanvas", "Hide canvas fingerprint", "boolean"],
  ["realChrome", "Use installed Chrome", "boolean"],
  ["googleSearch", "Google search referrer", "boolean"],
  ["locale", "Browser locale", "text"],
];
const anti = [
  ["Enabled", "Enable detection", "boolean"],
  ["LogDecisions", "Log fallback decisions", "boolean"],
  ["PreferStealthOnSignals", "Prefer stealth for challenges", "boolean"],
  ["TreatCloudflareAsSignal", "Detect Cloudflare signals", "boolean"],
  ["MaxAttempts", "Maximum attempts", "number"],
  ["MinBodyBytes", "Minimum response bytes", "number"],
  ["MinConfidence", "Minimum confidence (%)", "number"],
  ["ModeOrder", "Fetch mode order", "list"],
  ["StatusCodes", "Fallback HTTP statuses", "numbers"],
  ["HeaderKeys", "Response header signals", "list"],
  ["BodySignatures", "Response body signals", "list"],
  ["TitleSignatures", "Page title signals", "list"],
];
function schemaFields(data, schema, update) {
  return grid(
    ...schema.map(([key, label, type]) => {
      const set = (value) => {
        if (value === undefined) delete data[key];
        else data[key] = value;
        update();
      };
      if (Array.isArray(type))
        return select(
          label,
          data[key] || "",
          [["", "Use default"], ...type],
          (v) => set(v || undefined),
        );
      if (type === "boolean")
        return select(
          label,
          data[key] === undefined ? "" : String(data[key]),
          [
            ["", "Use default"],
            ["true", "Enabled"],
            ["false", "Disabled"],
          ],
          (v) => set(v === "" ? undefined : v === "true"),
        );
      if (type === "secret") return secret(label, data[key], set);
      if (type === "number")
        return input(
          label,
          data[key],
          (v) => set(v === "" ? undefined : Number(v)),
          { type: "number" },
        );
      if (type === "list" || type === "numbers")
        return input(
          label,
          Array.isArray(data[key]) ? data[key].join("\n") : data[key] || "",
          (v) =>
            set(
              v
                .split(/\r?\n/)
                .map((x) => x.trim())
                .filter(Boolean)
                .map((x) => (type === "numbers" ? Number(x) : x)),
            ),
          { rows: "3", hint: "One value per line" },
        );
      return input(label, data[key], set);
    }),
  );
}
function scrapling() {
  let data = clone(state.config.Scrapling || {});
  const update = () => {
    state.config.Scrapling = clone(data);
    changed();
  };
  const drafts = new Map();
  const sub = (key, schema) => {
    if (!drafts.has(key)) drafts.set(key, clone(data[key] || {}));
    const value = drafts.get(key);
    return schemaFields(value, schema, () => {
      data[key] = value;
      update();
    });
  };
  const wrapper = stack();
  const render = () =>
    wrapper.replaceChildren(
      disclosure("General", () =>
        schemaFields(
          data,
          [
            ["Enabled", "Enable Scrapling", "boolean"],
            ["ForceGlobal", "Use for all sources", "boolean"],
            ["AutoFallback", "Automatic fallback", "boolean"],
            [
              "AutoUseShellForAdvancedOptions",
              "Use shell for advanced options",
              "boolean",
            ],
            ["PersistentBrowserSessions", "Reuse browser sessions", "boolean"],
            ["PreferredMode", "Preferred runtime", ["cli", "shell"]],
            ["FallbackStatusCodes", "Fallback HTTP statuses", "numbers"],
          ],
          update,
        ),
      ),
      disclosure("Runtime / fetch mode", () => sub("DefaultOptions", runtime)),
      disclosure("Anti-bot behavior", () => sub("AntiBot", anti)),
      disclosure("Browser behavior", () => sub("DefaultOptions", browser)),
      disclosure(
        "Per-URL profiles",
        () => profiles(data, update),
        `${Object.keys(data.PerUrlConfig || {}).length} profiles`,
      ),
      jsonEditor(
        "Raw Scrapling JSON",
        () => data,
        (value) => {
          data = value;
          drafts.clear();
          update();
          render();
        },
      ),
    );
  render();
  return wrapper;
}
function profiles(scrapling, update) {
  const container = stack();
  const render = () => {
    const data = scrapling.PerUrlConfig || {};
    container.replaceChildren(
      button(
        "Add URL profile",
        () => {
          let url = "";
          const error = el("p", { class: "error-text", role: "alert" });
          const node = dialog(
            "Add URL profile",
            [input("Profile URL", url, (v) => (url = v)), error],
            {
              actions: [
                button("Cancel", () => node.close()),
                button(
                  "Add profile",
                  () => {
                    try {
                      const parsed = new URL(url);
                      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
                      if (Object.hasOwn(data, url)) {
                        error.textContent =
                          "A profile already exists for this URL.";
                        return;
                      }
                      scrapling.PerUrlConfig = {
                        ...data,
                        [url]: { enabled: true },
                      };
                      update();
                      node.close();
                      render();
                    } catch {
                      error.textContent = "Enter a valid HTTP or HTTPS URL.";
                    }
                  },
                  { kind: "primary" },
                ),
              ],
            },
          );
        },
        { glyph: "plus" },
      ),
      ...Object.entries(data).map(([url, raw]) =>
        disclosure(safeUrl(url), () => {
          const profile = clone(isObject(raw) ? raw : {}),
            commit = () => {
              data[url] = profile;
              scrapling.PerUrlConfig = data;
              update();
            };
          let newUrl = url;
          return stack(
            input("Profile URL", url, (v) => (newUrl = v)),
            button("Apply URL", () => {
              try {
                const parsed = new URL(newUrl);
                if (!/^https?:$/.test(parsed.protocol))
                  throw new Error("Use HTTP or HTTPS.");
                if (newUrl !== url && Object.hasOwn(data, newUrl))
                  throw new Error("This profile already exists.");
                if (newUrl !== url) {
                  data[newUrl] = data[url];
                  delete data[url];
                  scrapling.PerUrlConfig = data;
                  update();
                  render();
                }
              } catch (e) {
                toast(e.message, "error");
              }
            }),
            schemaFields(
              profile,
              [["enabled", "Enable profile", "boolean"]],
              commit,
            ),
            disclosure("Runtime / fetch", () =>
              schemaFields(profile, runtime, commit),
            ),
            disclosure("Browser", () => schemaFields(profile, browser, commit)),
            disclosure("HTML parsing", () => {
              const value = clone(profile.htmlParseOptions || {});
              return schemaFields(
                value,
                [
                  ["itemSelector", "Item selector", "text"],
                  ["titleSelector", "Title selector", "text"],
                  ["linkSelector", "Link selector", "text"],
                ],
                () => {
                  profile.htmlParseOptions = value;
                  commit();
                },
              );
            }),
            disclosure("Anti-bot overrides", () => {
              const value = clone(profile.antiBot || {});
              return schemaFields(value, anti, () => {
                profile.antiBot = value;
                commit();
              });
            }),
            jsonEditor(
              `Full profile JSON · ${safeUrl(url)}`,
              () => data[url],
              (value) => {
                data[url] = value;
                scrapling.PerUrlConfig = data;
                update();
                render();
              },
            ),
            button(
              "Delete profile",
              async () => {
                if (
                  await confirm(
                    "Delete URL profile?",
                    `Remove the profile for ${safeUrl(url)}?`,
                    { label: "Delete profile", danger: true },
                  )
                ) {
                  delete data[url];
                  scrapling.PerUrlConfig = data;
                  update();
                  render();
                }
              },
              { kind: "danger-text" },
            ),
          );
        }),
      ),
    );
  };
  render();
  return container;
}
function rawConfig() {
  return disclosure(
    "Raw config.json",
    () => {
      const area = el("textarea", {
        class: "code",
        rows: "22",
        "aria-label": "Raw config.json",
        spellcheck: "false",
        value: state.rawDraft ?? JSON.stringify(state.config, null, 2),
        onInput: (e) => {
          state.rawDraft = e.target.value;
          changed();
        },
      });
      const error = el("p", { class: "error-text", role: "alert" });
      const parse = () => {
        const value = JSON.parse(area.value);
        if (!isObject(value)) throw new Error();
        return value;
      };
      return [
        el("p", {
          class: "muted",
          text: "This editor may expose configuration secrets. Apply JSON to the form, then use Save changes.",
        }),
        area,
        error,
        el("div", { class: "actions" }, [
          button("Validate JSON", () => {
            try {
              parse();
              error.textContent = "";
              toast("Valid JSON");
            } catch {
              error.textContent =
                "Invalid JSON. Check the syntax and use an object as the root.";
            }
          }),
          button("Apply to form", async () => {
            try {
              const value = parse();
              if (
                await confirm(
                  "Replace form with raw JSON?",
                  "This replaces all local configuration fields with this JSON. Environment edits are saved separately.",
                  { label: "Apply JSON" },
                )
              ) {
                state.config = value;
                state.rawDraft = null;
                state.jsonDrafts.clear();
                state.organizationDrafts.clear();
                changed();
                document.dispatchEvent(new Event("render-view"));
                toast("JSON applied to form");
              }
            } catch {
              error.textContent =
                "Invalid JSON. Check the syntax and use an object as the root.";
            }
          }),
          button("Reset editor", async () => {
            if (
              await confirm(
                "Reset raw editor?",
                "Replace the raw draft with the current form values?",
                { label: "Reset editor" },
              )
            ) {
              area.value = JSON.stringify(state.config, null, 2);
              state.rawDraft = null;
              changed();
            }
          }),
        ]),
      ];
    },
    "Expert editor",
  );
}
function environment() {
  const preview = () =>
    el("pre", {
      class: "code env-preview",
      text:
        state.env
          .split(/\r?\n/)
          .filter((line) =>
            /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line),
          )
          .map((line) => `${line.slice(0, line.indexOf("="))}=••••••••`)
          .join("\n") || "No environment variables configured.",
    });
  const wrapper = stack();
  const render = () =>
    wrapper.replaceChildren(
      el("p", {
        class: "muted",
        text: "Values are masked. Environment changes have a separate save action.",
      }),
      preview(),
      el("div", { class: "actions" }, [
        button("Edit raw .env", () => {
          const area = el("textarea", {
            class: "code",
            rows: "20",
            "aria-label": "Raw .env",
            spellcheck: "false",
            value: state.env,
            onInput: (e) => {
              state.env = e.target.value;
              changed();
            },
          });
          const save = button(
            "Save .env",
            () => document.dispatchEvent(new Event("save-env")),
            { kind: "primary", disabled: !envDirty() },
          );
          const sync = () => {
            save.disabled = !envDirty() || state.busy;
          };
          document.addEventListener("config-changed", sync);
          const node = dialog(
            "Edit raw .env",
            [
              el("p", {
                class: "callout warning",
                text: "Raw mode displays secrets. Save .env writes only the environment file; configuration changes remain in your draft.",
              }),
              area,
            ],
            {
              drawer: true,
              actions: [button("Close editor", () => node.close()), save],
              onClose: () => {
                document.removeEventListener("config-changed", sync);
                render();
              },
            },
          );
        }),
        button(
          "Save .env",
          () => document.dispatchEvent(new Event("save-env")),
          { kind: "primary", disabled: !envDirty(), "data-env-save": "true" },
        ),
        envDirty() && badge("Environment unsaved", "warning"),
      ]),
    );
  render();
  return wrapper;
}
export function renderAdvanced() {
  const cache = state.cache;
  return stack(
    heading(
      "Advanced",
      "Runtime options, raw configuration and system details.",
    ),
    card("Scrapling", scrapling(), badge("Expert options")),
    rawConfig(),
    disclosure("Environment variables", environment, "Values masked"),
    disclosure(
      "Cache",
      () =>
        cache?.preview?.length
          ? el(
              "div",
              { class: "table-wrap" },
              el("table", {}, [
                el(
                  "thead",
                  {},
                  el(
                    "tr",
                    {},
                    ["Channel", "Bucket", "Entries"].map((text) =>
                      el("th", { scope: "col", text }),
                    ),
                  ),
                ),
                el(
                  "tbody",
                  {},
                  cache.preview.map((row) =>
                    el(
                      "tr",
                      {},
                      [
                        row.channel,
                        /^https?:/.test(row.bucket)
                          ? safeUrl(row.bucket)
                          : row.bucket,
                        row.count,
                      ].map((text) => el("td", { text })),
                    ),
                  ),
                ),
              ]),
            )
          : empty(
              "Cache is empty",
              "Delivered entry IDs appear here after worker runs.",
            ),
      `${cache?.totalItems || 0} entries · ${cache?.totalBuckets || 0} buckets`,
    ),
    disclosure("System", () =>
      el(
        "dl",
        { class: "metadata" },
        [
          ["Version", `XFeeder ${state.meta.appVersion || "2.2.0"}`],
          ["Dashboard", `${state.meta.host}:${state.meta.port}`],
          ["Authentication", state.auth.mode || "local-open"],
          ["Configuration", state.meta.configPath],
          ["Environment", state.meta.envPath],
          ["Cache", state.meta.cachePath],
          ["Worker reload", state.meta.configReload],
        ].map(([k, v]) =>
          el("div", {}, [el("dt", { text: k }), el("dd", { text: v })]),
        ),
      ),
    ),
  );
}
