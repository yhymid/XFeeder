import { state } from "../state.js";
import { hostname } from "../model.mjs";
import {
  el,
  icon,
  button,
  badge,
  statusBadge,
  heading,
  stack,
  empty,
  input,
  select,
  dialog,
  relative,
} from "../ui.js";
export function activityDetail(event) {
  dialog(
    event.message,
    stack(
      statusBadge(event.status),
      el(
        "dl",
        { class: "metadata" },
        [
          ["Time", new Date(event.time).toLocaleString()],
          ["Channel", event.channel || "Unassigned"],
          ["Source", event.source || "Not recorded"],
          [
            "Destination",
            event.target === "webhook"
              ? "Discord"
              : event.target || "Not recorded",
          ],
          [
            "Duration",
            event.durationMs !== null
              ? `${event.durationMs} ms`
              : "Not recorded",
          ],
          ["Execution", event.dryRun ? "Dry run" : "Worker"],
        ].map(([key, value]) =>
          el("div", {}, [el("dt", { text: key }), el("dd", { text: value })]),
        ),
      ),
      el("h3", { text: "Technical details" }),
      el("pre", {
        class: "code",
        text: JSON.stringify(event.details, null, 2),
      }),
      el("p", {
        class: "muted",
        text: "Sanitized event metadata. Response bodies and credentials are excluded.",
      }),
    ),
    { drawer: true },
  );
}
export function activityList(items, compact = false) {
  if (!items.length)
    return empty(
      "No activity in this period",
      "Enable Expert diagnostics in Settings to record structured worker activity. Try a wider time range.",
    );
  return el(
    "div",
    { class: `activity-list${compact ? " compact" : ""}` },
    items.map((event) =>
      el(
        "button",
        {
          type: "button",
          class: "activity-row",
          onClick: () => activityDetail(event),
        },
        [
          el(
            "span",
            { class: `event-icon ${event.status}` },
            icon(event.status === "success" ? "check" : event.status),
          ),
          el("div", { class: "event-copy" }, [
            el("strong", { text: event.message }),
            el("span", { class: "muted" }, [
              event.channel || "Worker",
              event.source ? ` · ${hostname(event.source)}` : "",
              event.target
                ? ` · ${event.target === "webhook" ? "Discord" : "Telegram"}`
                : "",
              event.dryRun ? " · Dry run" : "",
            ]),
          ]),
          !compact && badge(event.type),
          !compact &&
            el("span", {
              class: "event-duration muted",
              text: event.durationMs !== null ? `${event.durationMs} ms` : "—",
            }),
          el("time", {
            class: "muted nowrap",
            datetime: event.time,
            title: new Date(event.time).toLocaleString(),
            text: relative(event.time),
          }),
          icon("chevron"),
        ],
      ),
    ),
  );
}
export function renderActivity() {
  const filters = state.activityFilters,
    all = state.activity?.items || [];
  const results = el("div"),
    counter = el("span", { class: "muted" });
  const update = () => {
    const start = Date.now() - Number(filters.hours) * 3600000;
    const items = all.filter(
      (e) =>
        Date.parse(e.time) >= start &&
        (!filters.status || e.status === filters.status) &&
        (!filters.type || e.type === filters.type) &&
        (!filters.channel || e.channel === filters.channel) &&
        `${e.message} ${e.channel} ${e.source} ${e.event}`
          .toLowerCase()
          .includes(filters.search.toLowerCase()),
    );
    results.replaceChildren(activityList(items));
    counter.textContent = `${items.length} events`;
  };
  const set = (key) => (v) => {
    filters[key] = v;
    update();
  };
  update();
  return stack(
    heading(
      "Activity",
      "Feed checks, deliveries and worker events.",
      button(
        "Refresh activity",
        () => document.dispatchEvent(new Event("refresh-activity")),
        { glyph: "refresh" },
      ),
    ),
    el("div", { class: "toolbar" }, [
      input("Search activity", filters.search, set("search"), {
        type: "search",
        placeholder: "Search activity…",
      }),
      el("div", { class: "filter-fields activity-filters" }, [
        select(
          "Status",
          filters.status,
          [
            ["", "All statuses"],
            ["success", "Success"],
            ["warning", "Warning"],
            ["error", "Error"],
          ],
          set("status"),
        ),
        select(
          "Channel",
          filters.channel,
          [
            ["", "All channels"],
            ...[...new Set(all.map((e) => e.channel).filter(Boolean))].sort(),
          ],
          set("channel"),
        ),
        select(
          "Event",
          filters.type,
          [
            ["", "All events"],
            ["delivery", "Delivery"],
            ["fetch", "Fetch"],
            ["parse", "Parse"],
            ["worker", "Worker"],
          ],
          set("type"),
        ),
        select(
          "Time range",
          filters.hours,
          [
            ["1", "Last hour"],
            ["24", "Last 24 hours"],
            ["168", "Last 7 days"],
          ],
          set("hours"),
        ),
      ]),
    ]),
    state.activityError &&
      el("p", { class: "callout warning", text: state.activityError }),
    el("div", { class: "list-meta" }, [
      counter,
      el("span", {
        class: "muted",
        text: "Newest first · refreshes every 30s",
      }),
    ]),
    el("section", { class: "card table-card" }, results),
    el("p", {
      class: "muted footnote",
      text: `Showing events available in the last 2 MB of the terminal log (up to 1,000 records). ${state.activity?.summary?.observedSince ? `Coverage starts ${new Date(state.activity.summary.observedSince).toLocaleString()}.` : "No structured worker events have been recorded."} Filters apply to this available history.`,
    }),
  );
}
