import {
  state,
  acceptState,
  configDirty,
  envDirty,
  rawDirty,
  dirty,
  changed,
} from "./state.js";
import { channels } from "./model.mjs";
import { request } from "./api.js";
import { el, icon, button, badge, toast, confirm, stack, input } from "./ui.js";
import { renderOverview } from "./views/overview.js";
import { renderChannels, renderDetail } from "./views/channels.js";
import { renderActivity } from "./views/activity.js";
import { renderSettings } from "./views/settings.js";
import { renderAdvanced } from "./views/advanced.js";

const app = document.querySelector("#app");
const navigation = [
  ["overview", "Overview"],
  ["channels", "Channels"],
  ["activity", "Activity"],
  ["settings", "Settings"],
  ["advanced", "Advanced"],
];
let workerState = { running: false, externalWorker: false, busy: false };
let validationTimer,
  validationVersion = 0,
  saveButton,
  dirtyLabel,
  viewRoot,
  sidebar,
  mobileTrigger;

window.addEventListener("beforeunload", (event) => {
  if (dirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("hashchange", route);
document.addEventListener("render-view", renderView);
document.addEventListener("config-changed", () => {
  syncChrome();
  scheduleValidation();
});
document.addEventListener("refresh-activity", () => loadActivity(true, true));
document.addEventListener("save-env", saveEnv);

function syncChrome() {
  if (saveButton) {
    saveButton.disabled = !configDirty() || state.busy;
    saveButton.replaceChildren(
      icon("save"),
      state.busy ? "Saving…" : "Save changes",
    );
  }
  if (dirtyLabel) {
    dirtyLabel.textContent =
      [
        configDirty() ? "Configuration unsaved" : "",
        envDirty() ? ".env unsaved" : "",
        rawDirty() || state.jsonDrafts.size ? "JSON not applied" : "",
        state.organizationDrafts.size ? "Name / group not applied" : "",
      ]
        .filter(Boolean)
        .join(" · ") || "All changes saved";
    dirtyLabel.classList.toggle("unsaved", dirty());
    dirtyLabel.title = dirtyLabel.textContent;
  }
  document
    .querySelectorAll("[data-env-save]")
    .forEach((b) => (b.disabled = !envDirty() || state.busy));
}
function scheduleValidation() {
  clearTimeout(validationTimer);
  const version = ++validationVersion;
  if (!state.auth.authenticated || state.loading) return;
  validationTimer = setTimeout(async () => {
    try {
      const result = await request("POST", "/api/validate", state.config);
      if (version !== validationVersion) return;
      state.warnings = result.warnings;
      state.errors = result.errors;
      if (state.view === "overview") renderView();
    } catch {
      /* Save performs authoritative validation and reports API failures. */
    }
  }, 500);
}
function shell() {
  app.replaceChildren();
  const links = el("nav", { "aria-label": "Main navigation" });
  for (const [key, label] of navigation) {
    if (key === "settings") links.append(el("hr"));
    links.append(
      el(
        "a",
        { href: `#${key}`, class: "nav-link", title: label, "data-view": key },
        [icon(key), el("span", { text: label })],
      ),
    );
  }
  sidebar = el("aside", { class: "sidebar", id: "sidebar" }, [
    el(
      "a",
      { href: "#overview", class: "brand", "aria-label": "XFeeder overview" },
      [
        el("span", { class: "brand-icon" }, icon("rss")),
        el("strong", { text: "XFeeder" }),
        badge(`v${state.meta.appVersion || "2.2.0"}`),
      ],
    ),
    el("div", { class: "sidebar-section", text: "Workspace" }),
    links,
    el("div", { class: "sidebar-bottom" }, [
      el("div", { class: "sidebar-status" }, [
        el("span", {
          class: `status-dot ${state.activity?.summary?.health || "unknown"}`,
        }),
        el("span", { text: "System status" }),
        el("small", {
          text:
            state.activity?.summary?.health === "healthy"
              ? "Healthy"
              : state.activity?.summary?.health === "warning"
                ? "Attention needed"
                : "Unknown",
        }),
      ]),
      el("div", { class: "worker-actions", title: "Controls dashboard-managed workers only" }, [
        button("Start", () => workerAction("start"), { kind: "quiet", "data-worker-action": "start" }),
        button("Stop", () => workerAction("stop"), { kind: "quiet", "data-worker-action": "stop" }),
        button("Restart", () => workerAction("restart"), { kind: "quiet", "data-worker-action": "restart" }),
      ]),
      el("div", {
        class: "sidebar-location",
        text: ["127.0.0.1", "localhost", "::1"].includes(state.meta.host)
          ? `Local · :${state.meta.port || 3000}`
          : `${state.meta.host}:${state.meta.port}`,
      }),
      state.auth.required &&
        button("Logout", logout, { kind: "quiet", glyph: "logout" }),
      button(
        "Collapse sidebar",
        () => {
          state.collapsed = !state.collapsed;
          app.classList.toggle("sidebar-collapsed", state.collapsed);
  void refreshWorkerControl();
        },
        { kind: "quiet collapse-button", glyph: "collapse" },
      ),
    ]),
  ]);
  const backdrop = el("button", {
    class: "sidebar-backdrop",
    "aria-label": "Close navigation",
    onClick: closeMobile,
  });
  mobileTrigger = button(
    "Open navigation",
    () => {
      app.classList.toggle("nav-open");
      mobileTrigger.setAttribute(
        "aria-expanded",
        String(app.classList.contains("nav-open")),
      );
      syncMobile();
      sidebar.querySelector("a").focus();
    },
    {
      glyph: "menu",
      iconOnly: true,
      kind: "quiet mobile-nav",
      "aria-controls": "sidebar",
      "aria-expanded": "false",
    },
  );
  dirtyLabel = el("span", { class: "dirty-label", "aria-live": "polite" });
  saveButton = button("Save changes", saveConfig, {
    kind: "primary",
    glyph: "save",
  });
  const topbar = el("header", { class: "topbar" }, [
    el("div", { class: "breadcrumb" }, [
      mobileTrigger,
      el("span", { class: "muted crumb-workspace", text: "Workspace" }),
      el("span", { class: "crumb-divider", text: "/" }),
      el("span", { id: "current-view", text: "Overview" }),
    ]),
    el("div", { class: "topbar-actions" }, [
      dirtyLabel,
      button("Refresh from disk", () => reload(true), {
        glyph: "refresh",
        iconOnly: true,
        kind: "quiet",
      }),
      saveButton,
    ]),
  ]);
  viewRoot = el("main", { id: "main-content", class: "content" });
  app.append(
    el(
      "a",
      {
        href: "#main-content",
        class: "skip-link",
        onClick: (e) => {
          e.preventDefault();
          viewRoot.querySelector("h1")?.focus();
        },
      },
      "Skip to content",
    ),
    sidebar,
    backdrop,
    el("div", { class: "workspace" }, [topbar, viewRoot]),
  );
  app.classList.toggle("sidebar-collapsed", state.collapsed);
  sidebar.addEventListener("keydown", (e) => {
    if (!app.classList.contains("nav-open")) return;
    if (e.key === "Escape") {
      closeMobile();
      mobileTrigger.focus();
    }
    if (e.key === "Tab") {
      const nodes = [...sidebar.querySelectorAll("a,button")].filter(
        (n) => n.offsetParent !== null,
      );
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  syncChrome();
  route();
}
function syncMobile() {
  const mobile = matchMedia("(max-width:760px)").matches;
  if (sidebar) sidebar.inert = mobile && !app.classList.contains("nav-open");
  const workspace = document.querySelector(".workspace");
  if (workspace) workspace.inert = mobile && app.classList.contains("nav-open");
}
function closeMobile() {
  app.classList.remove("nav-open");
  mobileTrigger?.setAttribute("aria-expanded", "false");
  syncMobile();
}
matchMedia("(max-width:760px)").addEventListener("change", syncMobile);
function route() {
  const [view, encoded] = location.hash.slice(1).split("/");
  state.view = navigation.some(([key]) => key === view) ? view : "overview";
  try {
    state.channelId = encoded ? decodeURIComponent(encoded) : null;
  } catch {
    state.channelId = null;
  }
  closeMobile();
  renderView();
}
function renderView() {
  if (!viewRoot) return;
  document.querySelectorAll("[data-view]").forEach((a) => {
    const active = a.dataset.view === state.view;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.querySelector("#current-view").textContent =
    navigation.find(([k]) => k === state.view)?.[1] || "Overview";
  if (state.loading) {
    viewRoot.replaceChildren(
      el("div", { class: "skeleton-heading" }),
      el("div", { class: "skeleton-health" }),
      el(
        "div",
        { class: "metrics" },
        Array.from({ length: 4 }, () => el("div", { class: "skeleton-card" })),
      ),
      el("div", { class: "skeleton-table" }),
    );
    return;
  }
  try {
    const renderers = {
      overview: renderOverview,
      channels: () =>
        state.channelId
          ? renderDetail(
              channels(state.config).find((c) => c.id === state.channelId),
            )
          : renderChannels(),
      activity: renderActivity,
      settings: renderSettings,
      advanced: renderAdvanced,
    };
    viewRoot.replaceChildren(renderers[state.view]());
    syncChrome();
  } catch (error) {
    viewRoot.replaceChildren(
      el("p", {
        class: "callout error",
        text: "This view could not be rendered. Refresh from disk or inspect the configuration in Advanced.",
      }),
    );
    console.error("Dashboard rendering failed:", error.name);
  }
}
async function refreshWorkerControl() {
  try { workerState = await request("GET", "/api/worker/control"); }
  catch { workerState = { running: false, externalWorker: false, busy: true }; }
  for (const action of ["start", "stop", "restart"]) {
    const control = sidebar?.querySelector(`[data-worker-action="${action}"]`);
    if (!control) continue;
    control.disabled = workerState.busy ||
      (action === "start" ? workerState.running || workerState.externalWorker : !workerState.running);
    control.title = workerState.externalWorker
      ? "Worker is externally managed; use its original service manager"
      : action === "start" ? "Start worker" : action === "stop" ? "Gracefully stop worker" : "Restart worker";
  }
}
async function workerAction(action) {
  if (workerState.busy) return;
  if (action !== "start" && !(await confirm(
    action === "stop" ? "Stop XFeeder worker?" : "Restart XFeeder worker?",
    "Active operations will be cancelled and the delivery cache flushed.",
    { label: action === "stop" ? "Stop worker" : "Restart worker", danger: action === "stop" },
  ))) return;
  workerState.busy = true;
  for (const control of sidebar?.querySelectorAll("[data-worker-action]") || []) control.disabled = true;
  try {
    await request("POST", "/api/worker/control", { action });
    toast("Worker " + (action === "start" ? "starting" : action === "stop" ? "stopped" : "restarting"));
  } catch (error) { toast(error.message || "Worker control failed", "error"); }
  finally { await refreshWorkerControl(); }
}

async function reload(ask = false) {
  if (
    ask &&
    dirty() &&
    !(await confirm(
      "Discard unsaved changes?",
      "Refresh from disk replaces configuration, raw JSON and .env drafts with the saved files.",
      { label: "Discard and refresh", danger: true },
    ))
  )
    return;
  state.loading = true;
  renderView();
  try {
    const payload = await request("GET", "/api/state");
    acceptState(payload);
    state.editorDirty = false;
    state.loading = false;
    await loadActivity(false);
    shell();
    if (ask) toast("Reloaded from disk");
  } catch (error) {
    state.loading = false;
    if (error.status === 401) {
      state.auth = error.data.auth;
      renderLogin();
    } else {
      toast(error.message, "error");
      if (!Object.keys(state.meta).length) {
        viewRoot.replaceChildren(
          el("p", {
            class: "callout error",
            text: "Could not load configuration.",
          }),
          button("Retry", () => reload()),
        );
      } else renderView();
    }
  }
}
async function loadActivity(rerender = false, force = false) {
  try {
    state.activity = await request("GET", "/api/activity?limit=1000");
    state.activityError = "";
  } catch (error) {
    if (state.activity?.summary) state.activity.summary.health = "unknown";
    state.activityError =
      "Activity could not be refreshed. Previously loaded events may be stale.";
    if (rerender) toast(state.activityError, "error");
  }
  if (
    rerender &&
    ["activity", "overview", "channels"].includes(state.view) &&
    !state.channelId &&
    !document.querySelector("dialog[open]") &&
    (force ||
      state.view === "overview" ||
      !viewRoot?.contains(document.activeElement))
  ) {
    const active = viewRoot?.contains(document.activeElement)
      ? document.activeElement
      : null;
    const label = active?.getAttribute("aria-label") || active?.textContent;
    renderView();
    if (label)
      [...viewRoot.querySelectorAll("button")]
        .find(
          (button) =>
            (button.getAttribute("aria-label") || button.textContent) === label,
        )
        ?.focus();
  }
  const status = sidebar?.querySelector(".sidebar-status");
  if (status) {
    status.title = `System status: ${state.activity?.summary?.health || "unknown"}`;
    status.setAttribute("aria-label", status.title);
    status.querySelector(".status-dot").className =
      `status-dot ${state.activity?.summary?.health || "unknown"}`;
    status.querySelector("small").textContent =
      state.activity?.summary?.health === "healthy"
        ? "Healthy"
        : state.activity?.summary?.health === "warning"
          ? "Attention needed"
          : "Unknown";
  }
}
async function saveConfig() {
  if (state.busy || !configDirty()) return;
  if (rawDirty() || state.jsonDrafts.size || state.organizationDrafts.size) {
    toast(
      "Apply pending JSON and name / group edits before saving configuration.",
      "error",
    );
    return;
  }
  state.busy = true;
  syncChrome();
  try {
    const snapshot = JSON.stringify(state.config),
      payload = JSON.parse(snapshot);
    const validation = await request("POST", "/api/validate", payload);
    state.warnings = validation.warnings;
    state.errors = validation.errors;
    if (validation.errors.length) {
      toast(validation.errors.join(" "), "error");
      renderView();
      return;
    }
    if (
      validation.warnings.length &&
      !(await confirm(
        "Save with configuration warnings?",
        stack(
          el("p", { text: "These issues will remain after saving:" }),
          ...validation.warnings.map((text) =>
            el("p", { class: "callout warning", text }),
          ),
        ),
        { label: "Save with warnings" },
      ))
    )
      return;
    const result = await request("PUT", "/api/config", payload, {
      "If-Match": `"${state.revision}"`,
      "X-XFeeder-Accept-Warnings": "true",
    });
    // Edits made while a request was in flight remain dirty.
    state.original = JSON.stringify(result.config);
    state.revision = result.revision;
    state.warnings = result.warnings;
    state.errors = result.errors;
    state.meta = result.meta;
    toast(
      envDirty()
        ? "Configuration saved · .env still unsaved"
        : "Configuration saved",
    );
  } catch (error) {
    if (error.data?.warnings) state.warnings = error.data.warnings;
    if (error.data?.errors) state.errors = error.data.errors;
    toast(error.message, "error");
  } finally {
    state.busy = false;
    syncChrome();
    if (state.view === "overview") renderView();
  }
}
async function saveEnv() {
  if (state.busy || !envDirty()) return;
  if (!(await confirm("Replace environment file?", "This replaces the entire .env file. Include every value you want to retain; existing secrets are never downloaded."))) return;
  state.busy = true;
  syncChrome();
  const snapshot = state.env;
  try {
    const result = await request("PUT", "/api/env", { content: snapshot });
    state.envStatus = result.envStatus || {};
    state.originalEnv = "";
    if (state.env === snapshot) state.env = "";
    state.warnings = result.warnings;
    toast(
      configDirty()
        ? "Environment saved · configuration still unsaved"
        : "Environment saved",
    );
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.busy = false;
    changed();
    if (state.view === "advanced" && !document.querySelector("dialog[open]"))
      renderView();
  }
}
async function logout() {
  if (
    dirty() &&
    !(await confirm(
      "Discard changes and logout?",
      "Unsaved configuration and environment changes will be discarded.",
      { label: "Logout", danger: true },
    ))
  )
    return;
  try {
    await request("POST", "/api/logout", {});
    state.config = {};
    state.original = "{}";
    state.env = "";
    state.originalEnv = "";
    state.rawDraft = null;
    state.jsonDrafts.clear();
    state.organizationDrafts.clear();
    state.activity = null;
    state.auth.authenticated = false;
    viewRoot = null;
    renderLogin();
  } catch (error) {
    toast(error.message, "error");
  }
}
function renderLogin() {
  app.className = "";
  let password = "";
  const error = el("p", { class: "error-text", role: "alert" });
  const control = input("Dashboard password", "", (v) => (password = v), {
    type: "password",
    autocomplete: "current-password",
    required: "true",
  });
  const submit = el("button", {
    type: "submit",
    class: "button primary",
    text: "Sign in",
  });
  const form = el(
    "form",
    {
      class: "login-card",
      onSubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const result = await request("POST", "/api/login", { password });
          state.auth = result.auth;
          password = "";
          shell();
          await reload();
        } catch (e) {
          error.textContent = e.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    [
      el("div", { class: "brand" }, [
        el("span", { class: "brand-icon" }, icon("rss")),
        el("strong", { text: "XFeeder" }),
      ]),
      el("h1", { text: "Welcome back" }),
      el("p", {
        class: "muted",
        text: "Sign in to manage your feeds and deliveries.",
      }),
      control,
      error,
      submit,
    ],
  );
  app.replaceChildren(el("main", { class: "login-shell" }, form));
  control.querySelector("input").focus();
}
async function bootstrap() {
  shell();
  try {
    const payload = await request("GET", "/api/auth-state");
    state.auth = payload.auth;
    if (!state.auth.authenticated) {
      state.loading = false;
      renderLogin();
      return;
    }
    await reload();
  } catch (error) {
    toast("Dashboard is unavailable. Try refreshing the page.", "error");
  }
}
setInterval(() => {
  if (
    state.auth.authenticated &&
    !state.loading &&
    document.visibilityState === "visible"
  )
    loadActivity(true);
}, 30000);
bootstrap();
