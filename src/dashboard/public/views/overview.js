import { state, navigate } from "../state.js";
import { channels } from "../model.mjs";
import {
  el,
  icon,
  button,
  badge,
  heading,
  card,
  stack,
  statusBadge,
  relative,
} from "../ui.js";
import { channelTable, addChannel, openChannel } from "./channels.js";
import { activityList } from "./activity.js";
export function renderOverview() {
  const all = channels(state.config),
    summary = state.activity?.summary;
  const issues = [...state.errors, ...state.warnings];
  const health = issues.length ? "warning" : summary?.health || "unknown";
  const status = {
    healthy: "Healthy",
    warning: "Attention needed",
    unknown: "Unknown",
  }[health];
  const metric = (label, value, note, glyph) =>
    el("section", { class: "card metric" }, [
      el("div", { class: "metric-label" }, [
        el("span", { text: label }),
        icon(glyph),
      ]),
      el("strong", { class: "metric-value", text: value ?? "—" }),
      el("span", { class: "muted", text: note }),
    ]);
  const attention = issues.length
    ? stack(
        ...issues.slice(0, 6).map((warning) => {
          const channel = all.find((c) =>
            warning.startsWith(`[Config] ${c.label}:`),
          );
          const human = warning
            .replace(/^\[Config\]\s*/, "")
            .replace(channel?.label || "___", channel?.name || "___")
            .replace(
              "missing delivery target (Webhook or complete Telegram config).",
              "Add a Discord webhook or complete Telegram settings.",
            )
            .replace(
              "missing feed sources or Discord source.",
              "Add a source URL or enable a Discord source.",
            )
            .replace(
              "Telegram is enabled but BotToken or ChatID is missing.",
              "Telegram needs a bot token and chat ID.",
            );
          return el("div", { class: "attention-row" }, [
            icon("warning"),
            el("span", { text: human }),
            button(
              "Fix",
              () => (channel ? openChannel(channel) : navigate("settings")),
              { kind: "quiet" },
            ),
          ]);
        }),
        issues.length > 6 &&
          button(
            `View all ${issues.length} issues`,
            () => navigate("channels"),
            { kind: "quiet" },
          ),
      )
    : el("div", { class: "no-issues" }, [
        icon("check"),
        el("span", { text: "No configuration issues" }),
        el("span", {
          class: "muted",
          text: "Sources and delivery settings are configured.",
        }),
      ]);
  const recent = (state.activity?.items || [])
    .filter((e) => !e.event.startsWith("channel.process"))
    .slice(0, 8);
  return stack(
    heading(
      "Overview",
      "Monitor feeds, deliveries and configuration health.",
      button("Add channel", addChannel, { kind: "primary", glyph: "plus" }),
    ),
    el("section", { class: `card system-health ${health}` }, [
      el(
        "div",
        { class: "health-symbol" },
        icon(health === "healthy" ? "check" : health),
      ),
      el("div", { class: "health-copy" }, [
        el("div", { class: "eyebrow", text: "System health" }),
        el("h2", { text: status }),
        el("p", {
          class: "muted",
          text: summary?.lastActivityAt
            ? `Last worker activity ${relative(summary.lastActivityAt)}`
            : "No recent worker activity available",
        }),
      ]),
      el("div", { class: "health-meta" }, [
        el("span", {
          text: `${all.length} channels · ${all.reduce((n, c) => n + c.feeds.length, 0)} feeds`,
        }),
        button("View activity", () => navigate("activity"), {
          kind: "quiet",
          glyph: "arrow",
        }),
      ]),
    ]),
    el("div", { class: "metrics" }, [
      metric(
        "Channels",
        all.length,
        `${new Set(all.map((c) => c.group)).size} groups`,
        "channels",
      ),
      metric(
        "Feeds",
        all.reduce((n, c) => n + c.feeds.length, 0),
        "Configured source URLs",
        "rss",
      ),
      metric(
        "Deliveries · 24h",
        summary?.deliveries24h,
        "Observed in available log",
        "send",
      ),
      metric(
        "Errors · 24h",
        summary?.errors24h,
        "Observed in available log",
        "activity",
      ),
    ]),
    card(
      "Attention needed",
      attention,
      issues.length
        ? badge(`${issues.length} issues`, "warning")
        : badge("Configuration checked"),
    ),
    el("section", { class: "card table-card" }, [
      el("div", { class: "card-heading" }, [
        el("h2", { text: "Channels snapshot" }),
        button("View all channels", () => navigate("channels"), {
          kind: "quiet",
          glyph: "arrow",
        }),
      ]),
      channelTable(all.slice(0, 6), { compact: true }),
    ]),
    el("section", { class: "card table-card" }, [
      el("div", { class: "card-heading" }, [
        el("div", {}, [
          el("h2", { text: "Recent activity" }),
          el("p", {
            class: "muted",
            text: "Latest events in the available log",
          }),
        ]),
        button("View activity", () => navigate("activity"), {
          kind: "quiet",
          glyph: "arrow",
        }),
      ]),
      activityList(recent, true),
    ]),
    el("p", {
      class: "muted footnote",
      text: "Worker health comes from Expert diagnostics. The dashboard being reachable does not mean the worker is running.",
    }),
  );
}
