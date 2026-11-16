import { state, changed } from "../state.js";
import { hasTelegram, clone } from "../model.mjs";
import {
  el,
  heading,
  card,
  stack,
  grid,
  input,
  toggle,
  secret,
  badge,
  disclosure,
} from "../ui.js";
import { telegramFields } from "./channels.js";
import { renderNetwork } from "./network.js";
function section(key) {
  const value = clone(state.config[key] || {});
  const update = () => {
    state.config[key] = clone(value);
    changed();
  };
  return [value, update];
}
export function renderSettings() {
  const [settings, saveSettings] = section("Settings"),
    [proxy, saveProxy] = section("Proxy"),
    [telegram, saveTelegram] = section("Telegram"),
    [auth, saveAuth] = section("Auth");
  const defaultKey = state.config.ChannelDefaults
    ? "ChannelDefaults"
    : state.config.DefaultChannel
      ? "DefaultChannel"
      : "ChannelDefaults";
  const [defaults, saveDefaults] = section(defaultKey);
  const tgBadge = badge(
    hasTelegram(telegram)
      ? "Configured"
      : telegram.Enabled === false
        ? "Disabled"
        : "Missing token / chat",
    hasTelegram(telegram) ? "" : "warning",
  );
  const updateTelegram = () => {
    saveTelegram();
    tgBadge.className = `badge ${hasTelegram(telegram) || telegram.Enabled === false ? "" : "warning"}`;
    tgBadge.textContent = hasTelegram(telegram)
      ? "Configured"
      : telegram.Enabled === false
        ? "Disabled"
        : !telegram.BotToken
          ? "Missing token"
          : "Missing chat";
  };
  return stack(
    heading("Settings", "Defaults and integrations for your feed worker."),
    renderNetwork(),
    card(
      "General",
      stack(
        toggle(
          "Save terminal logs",
          settings.Logs === true,
          (v) => {
            settings.Logs = v;
            saveSettings();
          },
          "Capture worker output in the terminal log.",
        ),
        toggle(
          "Expert diagnostics",
          settings.DebugExpert === true,
          (v) => {
            settings.DebugExpert = v;
            saveSettings();
          },
          "Record structured events for Activity and worker health.",
        ),
        el("hr"),
        el("h3", { text: "Default channel schedule" }),
        grid(
          input(
            "Check every (minutes)",
            defaults.TimeChecker,
            (v) => {
              defaults.TimeChecker = Number(v);
              saveDefaults();
            },
            { type: "number", min: "1", step: "1", placeholder: "30" },
          ),
          input(
            "Max entries per cycle",
            defaults.RequestSend,
            (v) => {
              defaults.RequestSend = Number(v);
              saveDefaults();
            },
            { type: "number", min: "1", step: "1", placeholder: "5" },
          ),
        ),
      ),
    ),
    card(
      "Telegram",
      telegramFields(telegram, updateTelegram),
      tgBadge,
      "Channels inherit these values unless they set an override.",
    ),
    card(
      "Proxy",
      stack(
        toggle("Use a proxy", proxy.Enabled === true, (v) => {
          proxy.Enabled = v;
          saveProxy();
        }),
        secret(
          "Proxy URL",
          proxy.Url,
          (v) => {
            proxy.Url = v;
            saveProxy();
          },
          "HTTP or HTTPS proxy address; credentials are masked.",
        ),
      ),
    ),
    disclosure("Discord credentials", () =>
      stack(
        el("p", {
          class: "muted",
          text: "Credentials for reading Discord messages. Channels can inherit or override these values.",
        }),
        grid(
          secret("Discord token", auth.Token, (v) => {
            auth.Token = v;
            saveAuth();
          }),
          secret("Client properties", auth["x-super-properties"], (v) => {
            auth["x-super-properties"] = v;
            saveAuth();
          }),
          secret("Session cookie", auth.cookie, (v) => {
            auth.cookie = v;
            saveAuth();
          }),
        ),
      ),
    ),
  );
}
