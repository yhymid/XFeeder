import { state, changed, rawDirty } from "../state.js";
import { request } from "../api.js";
import {
  el,
  card,
  stack,
  grid,
  input,
  select,
  toggle,
  disclosure,
  button,
} from "../ui.js";

const choices = [
  ["potato", "Potato — 10 Kbps"],
  ["low", "Low — 2 Mbps"],
  ["medium", "Medium — 10 Mbps"],
  ["high", "High — 50 Mbps"],
  ["very-high", "Very High — 100 Mbps"],
  ["unlimited", "Unlimited"],
  ["custom", "Custom"],
];
const rate = (bytes) =>
  bytes == null
    ? "Unavailable"
    : `${((bytes * 8) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })} Mbps`;
export function renderNetwork() {
  const value = structuredClone(state.config.network || {});
  let runtime = null,
    saving = false,
    pending = false,
    timer;
  const originalNetwork = () => JSON.parse(state.original).network || {};
  const isDirty = () =>
    JSON.stringify(value) !== JSON.stringify(originalNetwork());
  const errors = el("p", { class: "error-text", role: "alert" });
  const status = el("p", {
    class: "muted",
    role: "status",
    "data-network-status": "",
  });
  const metrics = el("p", { class: "muted", "data-network-metrics": "" });
  const help = el("p", { class: "muted" });
  const validate = () => {
    const issues = [];
    for (const [key, label] of [
      ["downloadLimitMbps", "Download"],
      ["uploadLimitMbps", "Upload"],
    ]) {
      const v = value[key];
      if (
        v != null &&
        (!Number.isFinite(v) ||
          v <= 0 ||
          v > 1000000 ||
          Math.round(v * 125000) < 1)
      )
        issues.push(
          `${label}: enter a positive limit in Mbps, up to 1,000,000.`,
        );
    }
    if (
      value.bandwidthProfile === "custom" &&
      value.downloadLimitMbps == null &&
      value.uploadLimitMbps == null
    )
      issues.push(
        "Enter at least one custom limit. Leave the other blank for unlimited.",
      );
    if (
      value.maxConcurrentRequests != null &&
      (!Number.isInteger(value.maxConcurrentRequests) ||
        value.maxConcurrentRequests < 1 ||
        value.maxConcurrentRequests > 10000)
    )
      issues.push(
        "Maximum concurrent requests: enter a whole number from 1 to 10,000.",
      );
    return issues;
  };
  const update = (edit = true) => {
    if (edit) {
      state.config.network = structuredClone(value);
      changed();
    }
    const issues = validate();
    errors.textContent = issues.join(" ");
    save.disabled = saving || state.busy || !isDirty() || issues.length > 0;
    save.textContent = saving ? "Saving network…" : "Save network";
    custom.hidden = value.bandwidthProfile !== "custom";
    help.textContent =
      value.bandwidthProfile === "potato"
        ? "Potato is extremely slow. Large feeds can take many minutes to download."
        : (value.bandwidthProfile || "unlimited") === "unlimited"
          ? "Unlimited preserves unrestricted XFeeder bandwidth."
          : "The download limit is shared by XFeeder HTTP requests.";
    status.textContent = isDirty()
      ? "Unsaved network changes"
      : runtime?.available
        ? runtime.applied
          ? "Saved · Applied by worker"
          : "Saved · Waiting for worker to apply"
        : "Saved · Worker status unavailable";
  };
  const nullableNumber = (v) => (v.trim() === "" ? null : Number(v));
  const custom = grid(
    input(
      "Download limit (Mbps)",
      value.downloadLimitMbps,
      (v) => {
        value.downloadLimitMbps = nullableNumber(v);
        update();
      },
      {
        type: "number",
        min: "0.000008",
        max: "1000000",
        step: "any",
        hint: "Leave blank for unlimited download.",
      },
    ),
    input(
      "Upload limit (Mbps)",
      value.uploadLimitMbps,
      (v) => {
        value.uploadLimitMbps = nullableNumber(v);
        update();
      },
      {
        type: "number",
        min: "0.000008",
        max: "1000000",
        step: "any",
        hint: "Paces supported messages before sending. Leave blank for unlimited upload.",
      },
    ),
  );
  const save = button(
    "Save network",
    async () => {
      if (saving || state.busy || validate().length) return;
      if (rawDirty() || state.jsonDrafts.size) {
        errors.textContent =
          "Apply or reset your JSON drafts before saving network settings.";
        return;
      }
      saving = true;
      state.busy = true;
      changed();
      update(false);
      const snapshot = structuredClone(value);
      try {
        const response = await request(
          "PUT",
          "/api/settings/network",
          snapshot,
          { "If-Match": `"${state.revision}"` },
        );
        const original = JSON.parse(state.original);
        original.network = snapshot;
        state.original = JSON.stringify(original);
        state.revision = response.revision;
        runtime = response.runtime;
        changed();
      } catch (error) {
        pending = error.message;
      } finally {
        saving = false;
        state.busy = false;
        changed();
        update(false);
        if (pending) {
          errors.textContent = pending;
          pending = false;
        }
      }
    },
    { kind: "primary" },
  );
  const root = card(
    "Network",
    stack(
      select(
        "Bandwidth Limit",
        value.bandwidthProfile || "unlimited",
        choices,
        (v) => {
          value.bandwidthProfile = v;
          update();
        },
      ),
      help,
      custom,
      toggle(
        "Network Friendly Mode",
        value.networkFriendlyMode === true,
        (v) => {
          value.networkFriendlyMode = v;
          update();
        },
        "Zmniejsza wpływ XFeedera na sieć podczas jednoczesnego grania, streamowania, przeglądania Internetu lub pobierania plików.",
      ),
      disclosure("Advanced network settings", () =>
        stack(
          input(
            "Maximum concurrent requests",
            value.maxConcurrentRequests,
            (v) => {
              value.maxConcurrentRequests = nullableNumber(v);
              update();
            },
            {
              type: "number",
              min: "1",
              max: "10000",
              step: "1",
              hint: "Blank: 2 with Friendly Mode, otherwise unchanged.",
            },
          ),
          toggle(
            "Scrapling Resource Saving",
            value.scraplingResourceSaving !== false,
            (v) => {
              value.scraplingResourceSaving = v;
              update();
            },
            "Reduce browser resources. Some pages may need a per-URL override.",
          ),
          el("p", {
            class: "muted",
            text: "Browser bandwidth is not limited here; browser byte counts are unavailable. Streaming, multipart and redirected uploads are not paced. Friendly Mode does not guarantee lower ping or replace router QoS.",
          }),
        ),
      ),
      errors,
      el("div", { class: "actions" }, [save, status]),
      metrics,
    ),
  );
  async function refresh() {
    if (!root.isConnected) return;
    if (document.visibilityState === "visible") {
      try {
        runtime = await request("GET", "/api/network/metrics");
        const m = runtime.metrics;
        metrics.textContent = runtime.available
          ? `Profile: ${m.profile} · Approx. download: ${rate(m.downloadBytesPerSecond)} · Approx. upload: ${rate(m.uploadBytesPerSecond)} · Active requests: ${m.activeHttpRequests} · Scrapling: ${m.activeScraplingTasks}`
          : "Current transfer and active requests: unavailable while the worker is offline.";
      } catch {
        runtime = null;
        metrics.textContent = "Could not refresh worker status.";
      }
      if (root.isConnected) update(false);
    }
    if (root.isConnected) timer = setTimeout(refresh, 3000);
  }
  // This view may be replaced on navigation; the next callback stops itself.
  timer = setTimeout(refresh, 0);
  update(false);
  return root;
}
