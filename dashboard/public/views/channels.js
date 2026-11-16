import { state, changed, navigate } from "../state.js";
import {
  channels,
  groups,
  toData,
  effective,
  feeds,
  putChannel,
  removeChannel,
  duplicateChannel,
  uniqueName,
  FEED_KEYS,
  safeUrl,
  hostname,
  sourceType,
  channelStatus,
  clone,
  hasTelegram,
} from "../model.mjs";
import { request } from "../api.js";
import {
  el,
  icon,
  button,
  badge,
  statusBadge,
  heading,
  card,
  stack,
  grid,
  empty,
  input,
  select,
  toggle,
  secret,
  disclosure,
  toast,
  dialog,
  confirm,
  menu,
  relative,
  jsonEditor,
} from "../ui.js";

export function openChannel(channel) {
  state.tab = "General";
  navigate("channels", channel.id);
}
export async function deleteChannel(channel) {
  if (
    !(await confirm(
      `Delete ${channel.name}?`,
      `Remove this channel and its ${channel.feeds.length} sources from the configuration? The change takes effect after Save changes.`,
      { label: "Delete channel", danger: true },
    ))
  )
    return;
  removeChannel(state.config, channel);
  changed();
  navigate("channels");
  document.dispatchEvent(new Event("render-view"));
  toast("Channel removed from draft");
}
export function duplicate(channel) {
  const id = duplicateChannel(state.config, channel);
  changed();
  navigate("channels", id);
  toast("Channel duplicated in draft");
}
export async function testChannel(channel) {
  try {
    const result = await request("POST", "/api/validate", state.config);
    const issues = [
      ...result.errors,
      ...result.warnings.filter((w) =>
        w.startsWith(`[Config] ${channel.label}:`),
      ),
    ];
    const invalid = channel.feeds.filter((url) => {
      try {
        return !/^https?:$/.test(new URL(url).protocol);
      } catch {
        return !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(url);
      }
    });
    if (invalid.length)
      issues.push(
        `${invalid.length} source URLs need a valid HTTP or HTTPS address.`,
      );
    dialog(
      `Test configuration · ${channel.name}`,
      stack(
        statusBadge(issues.length ? "warning" : "success"),
        el("p", {
          text: issues.length
            ? "Review the following configuration issues."
            : "Source addresses, schedule and delivery settings passed validation.",
        }),
        ...issues.map((text) => el("p", { class: "callout warning", text })),
        el("p", {
          class: "muted",
          text: "Configuration check only. No feeds are fetched and no messages are sent. To test fetching and parsing, run npm run start:dry-run on the host.",
        }),
      ),
    );
  } catch (error) {
    toast(error.message, "error");
  }
}
function channelMenu(channel) {
  return menu(`Actions for ${channel.name}`, [
    ["Edit", () => openChannel(channel)],
    ["Duplicate", () => duplicate(channel)],
    ["Test configuration", () => testChannel(channel)],
    ["Delete", () => deleteChannel(channel), true],
  ]);
}
export function channelTable(rows, { compact = false } = {}) {
  if (!rows.length)
    return empty(
      "No channels found",
      "Try another search or add a channel.",
      button("Add channel", addChannel, { glyph: "plus" }),
    );
  const table = el("table", { class: "channel-table" }, [
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        [
          "Channel",
          "Group",
          "Sources",
          "Destinations",
          "Schedule",
          "Last check",
          "Status",
          "",
        ].map((text) => el("th", { scope: "col", text })),
      ),
    ),
  ]);
  const tbody = el("tbody");
  for (const channel of rows) {
    const status = channelStatus(channel, state.activity, state.warnings);
    const last = state.activity?.channels?.[channel.label]?.lastCheck;
    const name = button(channel.name, () => openChannel(channel), {
      kind: "text-link",
    });
    tbody.append(
      el(
        "tr",
        {
          class: "channel-row",
          onClick: (e) => {
            if (!e.target.closest("button")) openChannel(channel);
          },
        },
        [
          el(
            "td",
            {},
            el("div", { class: "channel-title" }, [
              el("span", {
                class: `status-dot ${status}`,
                "aria-hidden": "true",
              }),
              el("div", {}, [
                name,
                el("small", {
                  class: "muted channel-domain",
                  text: channel.feeds.length
                    ? hostname(channel.feeds[0])
                    : channel.data.Discord
                      ? "Discord source"
                      : "No sources",
                }),
              ]),
            ]),
          ),
          el("td", { "data-label": "Group" }, badge(channel.group)),
          el(
            "td",
            { "data-label": "Sources" },
            `${channel.feeds.length} feeds`,
          ),
          el(
            "td",
            { "data-label": "Destinations" },
            el(
              "div",
              { class: "badges" },
              channel.targets.length
                ? channel.targets.map((t) => badge(t))
                : badge("None", "warning"),
            ),
          ),
          el(
            "td",
            { "data-label": "Schedule", class: "nowrap" },
            `Every ${channel.interval} min`,
          ),
          el(
            "td",
            {
              "data-label": "Last check",
              class: "muted nowrap",
              title: last || "",
            },
            relative(last),
          ),
          el("td", { "data-label": "Status" }, statusBadge(status)),
          el(
            "td",
            { class: "row-menu" },
            compact
              ? button(`Open ${channel.name}`, () => openChannel(channel), {
                  glyph: "chevron",
                  iconOnly: true,
                  kind: "quiet",
                })
              : channelMenu(channel),
          ),
        ],
      ),
    );
  }
  table.append(tbody);
  return el("div", { class: "table-wrap" }, table);
}
export function renderChannels() {
  const filters = state.channelFilters,
    all = channels(state.config);
  const results = el("div"),
    counter = el("span", { class: "muted" });
  const update = () => {
    const query = filters.search.toLowerCase();
    let rows = all.filter(
      (c) =>
        `${c.name} ${c.group} ${c.feeds.join(" ")}`
          .toLowerCase()
          .includes(query) &&
        (!filters.group || c.group === filters.group) &&
        (!filters.status ||
          channelStatus(c, state.activity, state.warnings) ===
            filters.status) &&
        (!filters.destination ||
          (filters.destination === "None"
            ? !c.targets.length
            : c.targets.includes(filters.destination))),
    );
    rows.sort((a, b) =>
      filters.sort === "feeds"
        ? b.feeds.length - a.feeds.length
        : filters.sort === "last"
          ? (Date.parse(state.activity?.channels?.[b.label]?.lastCheck) || 0) -
            (Date.parse(state.activity?.channels?.[a.label]?.lastCheck) || 0)
          : a.name.localeCompare(b.name),
    );
    counter.textContent = `${rows.length} of ${all.length} channels`;
    results.replaceChildren(channelTable(rows));
  };
  const set = (key) => (value) => {
    filters[key] = value;
    update();
  };
  const groupSelect = select(
    "Group",
    filters.group,
    [["", "All groups"], ...groups(state.config).map(([k]) => k)],
    set("group"),
  );
  const filterRow = el("div", { class: "filter-fields" }, [
    groupSelect,
    select(
      "Status",
      filters.status,
      [
        ["", "All statuses"],
        ["healthy", "Healthy"],
        ["warning", "Warning"],
        ["error", "Error"],
        ["unknown", "Unknown"],
      ],
      set("status"),
    ),
    select(
      "Destination",
      filters.destination,
      [["", "All destinations"], "Discord", "Telegram", "None"],
      set("destination"),
    ),
    select(
      "Sort by",
      filters.sort,
      [
        ["name", "Name"],
        ["last", "Last check"],
        ["feeds", "Feed count"],
      ],
      set("sort"),
    ),
  ]);
  const chips = el("div", {
    class: "chips",
    "aria-label": "Quick group filter",
  });
  for (const group of ["", ...groups(state.config).map(([k]) => k)]) {
    const chip = button(
      group || "All channels",
      () => {
        filters.group = group;
        groupSelect.querySelector("select").value = group;
        chips
          .querySelectorAll("button")
          .forEach((b) => b.setAttribute("aria-pressed", b === chip));
        update();
      },
      { kind: "chip", "aria-pressed": String(filters.group === group) },
    );
    chips.append(chip);
  }
  update();
  return stack(
    heading(
      "Channels",
      "Sources, schedules and delivery targets.",
      button("Add channel", addChannel, { kind: "primary", glyph: "plus" }),
    ),
    el("div", { class: "toolbar" }, [
      input("Search channels", filters.search, set("search"), {
        placeholder: "Search channels or feed URLs…",
        type: "search",
      }),
      button("Filters", () => filterRow.classList.toggle("mobile-open"), {
        kind: "mobile-filters",
      }),
      filterRow,
    ]),
    chips,
    el("div", { class: "list-meta" }, [
      counter,
      button("Manage groups", manageGroups, { kind: "quiet" }),
    ]),
    el("section", { class: "card table-card" }, results),
    el("p", {
      class: "muted footnote",
      text: "Group → Channel → Sources → Destinations. Each channel checks its sources on a shared schedule.",
    }),
  );
}
function manageGroups() {
  const list = stack(
    ...groups(state.config).map(([group, value]) =>
      el("div", { class: "management-row" }, [
        el("div", {}, [
          el("strong", { text: group }),
          el("small", {
            class: "muted",
            text: `${Object.keys(value).length} channels · ${Array.isArray(value) ? "ordered" : "named"}`,
          }),
        ]),
        button(
          "Delete group",
          async () => {
            if (
              await confirm(
                `Delete group ${group}?`,
                `This removes all ${Object.keys(value).length} channels in this group from the draft.`,
                { label: "Delete group", danger: true },
              )
            ) {
              delete state.config[group];
              changed();
              node.close();
              document.dispatchEvent(new Event("render-view"));
            }
          },
          { kind: "danger-text" },
        ),
      ]),
    ),
  );
  const node = dialog("Manage groups", list);
}
export function telegramFields(data, onChange, { inherited = false } = {}) {
  const set = (key) => (value) => {
    data[key] = value;
    onChange();
  };
  return stack(
    toggle("Enabled", data.Enabled !== false, set("Enabled")),
    grid(
      secret(
        "Bot token",
        data.BotToken,
        set("BotToken"),
        inherited ? "Empty inherits the global token" : "",
      ),
      input("Chat ID or @channel", data.ChatID, set("ChatID"), {
        placeholder: inherited ? "Inherit global chat" : "-100… or @channel",
      }),
      input(
        "Forum topic ID",
        data.MessageThreadID,
        (v) => set("MessageThreadID")(v ? Number(v) : null),
        { type: "number", min: "1", hint: "Optional" },
      ),
      input(
        "Request timeout (ms)",
        data.TimeoutMs,
        (v) => set("TimeoutMs")(v ? Number(v) : null),
        { type: "number", min: "1", placeholder: "15000" },
      ),
    ),
    toggle(
      "Disable link previews",
      data.DisableWebPagePreview === true,
      set("DisableWebPagePreview"),
    ),
  );
}
function deliveryFields(data, update) {
  const wrapper = stack();
  const render = () => {
    const current = effective(state.config, data).Telegram;
    const mode =
      data.Telegram?.Enabled === false
        ? "disabled"
        : data.Telegram
          ? "custom"
          : "inherit";
    const tg = card(
      "Telegram",
      stack(
        select(
          "Delivery settings",
          mode,
          [
            ["inherit", "Inherit global settings"],
            ["custom", "Custom override"],
            ["disabled", "Disabled for this channel"],
          ],
          (value) => {
            if (value === "inherit") delete data.Telegram;
            else
              data.Telegram =
                value === "disabled"
                  ? { ...data.Telegram, Enabled: false }
                  : { ...data.Telegram, Enabled: true };
            update();
            render();
          },
        ),
        mode === "custom" &&
          telegramFields(
            data.Telegram,
            () => {
              update();
            },
            { inherited: true },
          ),
      ),
      badge(
        mode === "disabled"
          ? "Disabled"
          : hasTelegram(current)
            ? mode === "inherit"
              ? "Inherited"
              : "Configured"
            : "Missing",
        hasTelegram(current) ? "" : "warning",
      ),
    );
    wrapper.replaceChildren(
      card(
        "Discord webhook",
        grid(
          secret(
            "Webhook URL or env reference",
            data.Webhook,
            (v) => {
              data.Webhook = v;
              update();
            },
            "Empty inherits the channel default, if configured",
          ),
          input(
            "Thread ID",
            data.Thread,
            (v) => {
              data.Thread = v || null;
              update();
            },
            { hint: "Optional forum or thread destination" },
          ),
        ),
        badge(effective(state.config, data).Webhook ? "Configured" : "Missing"),
      ),
      tg,
    );
  };
  render();
  return wrapper;
}
function scheduleFields(data, update) {
  const defaults = effective(state.config, data);
  return grid(
    input(
      "Check every (minutes)",
      data.TimeChecker ?? "",
      (v) => {
        if (v === "") delete data.TimeChecker;
        else data.TimeChecker = Number(v);
        update();
      },
      {
        type: "number",
        min: "1",
        step: "1",
        placeholder: String(defaults.TimeChecker || 30),
        hint: "Empty inherits the default schedule",
      },
    ),
    input(
      "Max new entries per cycle",
      data.RequestSend ?? "",
      (v) => {
        if (v === "") delete data.RequestSend;
        else data.RequestSend = Number(v);
        update();
      },
      {
        type: "number",
        min: "1",
        step: "1",
        placeholder: String(defaults.RequestSend || 5),
      },
    ),
  );
}
function addSources(data, update, currentUrl, edit) {
  let text = currentUrl || "";
  const error = el("p", { class: "error-text", role: "alert" });
  const node = dialog(
    currentUrl ? "Edit source" : "Add sources",
    [
      input("Source URLs", text, (v) => (text = v), {
        rows: "5",
        placeholder: "https://example.com/feed\nhttps://example.org/atom.xml",
        hint: "Paste one or more URLs, one per line.",
      }),
      error,
    ],
    {
      actions: [
        button("Cancel", () => node.close()),
        button(
          currentUrl ? "Apply source" : "Add sources",
          () => {
            const urls = [
              ...new Set(
                text
                  .split(/\r?\n/)
                  .map((v) => v.trim())
                  .filter(Boolean),
              ),
            ];
            if (
              !urls.length ||
              urls.some((v) => {
                try {
                  return !/^https?:$/.test(new URL(v).protocol);
                } catch {
                  return !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v);
                }
              })
            ) {
              error.textContent =
                "Enter valid HTTP/HTTPS URLs or environment references.";
              return;
            }
            if (edit) edit(urls);
            else {
              const key = FEED_KEYS.find((k) => data[k] !== undefined) || "RSS";
              const existing = Array.isArray(data[key])
                ? data[key]
                : data[key]
                  ? [data[key]]
                  : [];
              data[key] = [...new Set([...existing, ...urls])];
            }
            update();
            node.close();
          },
          { kind: "primary" },
        ),
      ],
    },
  );
}
function sourcesFields(data, update, channel) {
  const wrapper = stack();
  const materialize = () => {
    const defaults =
      state.config.ChannelDefaults || state.config.DefaultChannel || {};
    for (const k of FEED_KEYS)
      if (data[k] === undefined && defaults[k] !== undefined)
        data[k] = clone(defaults[k]);
  };
  const mutateUrl = (url, replacement) => {
    materialize();
    for (const key of FEED_KEYS) {
      if (data[key] === undefined) continue;
      const original = data[key],
        list = (Array.isArray(original) ? original : [original]).flatMap((v) =>
          v === url ? replacement : [v],
        );
      data[key] =
        typeof original === "string" && list.length === 1 ? list[0] : list;
    }
  };
  const render = () => {
    const list = feeds(effective(state.config, data));
    wrapper.replaceChildren(
      ...list.map((url) => {
        const event = state.activity?.items?.find(
          (e) =>
            e.source === safeUrl(url) &&
            (!e.channel || e.channel === channel.label),
        );
        return el("div", { class: "source-row" }, [
          el("span", { class: "source-icon" }, icon("globe")),
          el("div", { class: "source-copy" }, [
            el("strong", { text: hostname(url) }),
            el("span", {
              class: "muted ellipsis",
              text: safeUrl(url),
              title: safeUrl(url),
            }),
            el("small", {
              class: "muted",
              text: event
                ? `${event.message} · ${relative(event.time)}${event.details?.parser ? ` · ${event.details.parser}` : ""}${event.durationMs !== null ? ` · ${event.durationMs} ms` : ""}`
                : "No recent source activity",
            }),
          ]),
          badge(event?.details?.parser || sourceType(url)),
          menu(`Actions for ${hostname(url)}`, [
            [
              "Edit URL",
              () =>
                addSources(
                  data,
                  () => {
                    update();
                    render();
                  },
                  url,
                  (urls) => mutateUrl(url, urls),
                ),
            ],
            ["Test configuration", () => testChannel(channel)],
            [
              "Remove source",
              async () => {
                if (
                  await confirm(
                    "Remove source?",
                    `Remove ${safeUrl(url)} from this channel?`,
                    { label: "Remove source", danger: true },
                  )
                ) {
                  mutateUrl(url, []);
                  update();
                  render();
                }
              },
              true,
            ],
          ]),
        ]);
      }),
      !list.length &&
        empty(
          "No sources yet",
          "Add a feed URL or enable a Discord source in Advanced.",
        ),
      button(
        "Add source",
        () => {
          materialize();
          addSources(data, () => {
            update();
            render();
          });
        },
        { glyph: "plus" },
      ),
    );
  };
  render();
  return wrapper;
}
function discordSourceFields(data, update) {
  const wrapper = stack();
  const render = () => {
    const discord = data.Discord;
    wrapper.replaceChildren(
      toggle(
        "Read messages from Discord",
        Boolean(discord),
        (enabled) => {
          if (enabled) data.Discord = { ChannelIDs: [] };
          else delete data.Discord;
          update();
          render();
        },
        "A source integration; delivery is configured separately.",
      ),
    );
    if (!discord) return;
    const set = (key) => (value) => {
      discord[key] = value;
      update();
    };
    wrapper.append(
      grid(
        input(
          "Channel IDs",
          (discord.ChannelIDs || [discord.ChannelID || ""]).join("\n"),
          (value) => {
            discord.ChannelIDs = value.split(/\s+/).filter(Boolean);
            delete discord.ChannelID;
            update();
          },
          { rows: "3" },
        ),
        input("Server ID", discord.GuildID, set("GuildID")),
        secret(
          "Source token",
          discord.Token,
          set("Token"),
          "Empty inherits global Discord credentials",
        ),
        secret(
          "Source cookie",
          discord.cookie,
          set("cookie"),
          "Empty inherits global credentials",
        ),
        secret(
          "Client properties",
          discord["x-super-properties"],
          set("x-super-properties"),
        ),
        secret("Source delivery webhook", discord.Webhook, set("Webhook")),
        input("Source delivery thread", discord.Thread, set("Thread")),
        input(
          "Message limit",
          discord.Limit,
          (v) => set("Limit")(v ? Number(v) : null),
          { type: "number", min: "1" },
        ),
        input(
          "Source timeout",
          discord.Timeout,
          (v) => set("Timeout")(v ? Number(v) : null),
          { type: "number", min: "1" },
        ),
      ),
    );
  };
  render();
  return wrapper;
}
export function renderDetail(channel) {
  if (!channel)
    return stack(
      heading("Channel not found", "It may have been removed or renamed."),
      button("Back to channels", () => navigate("channels"), { glyph: "back" }),
    );
  let data = toData(channel.raw);
  const update = () => {
    state.config[channel.group][channel.key] = clone(data);
    changed();
  };
  const content = el("div", { class: "detail-body" });
  const tabs = el("div", {
    class: "tabs",
    role: "tablist",
    "aria-label": "Channel settings",
  });
  const renderTab = (tab) => {
    state.tab = tab;
    tabs.querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-selected", String(b.textContent === tab));
      b.tabIndex = b.textContent === tab ? 0 : -1;
    });
    content.id = `panel-${tab}`;
    content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-labelledby", `tab-${tab}`);
    if (tab === "General") {
      const draft = state.organizationDrafts.get(channel.id);
      let group = draft?.group ?? channel.group,
        name = draft?.name ?? channel.key;
      const organizationChanged = () => {
        if (group === channel.group && name === channel.key)
          state.organizationDrafts.delete(channel.id);
        else state.organizationDrafts.set(channel.id, { group, name });
        changed();
      };
      content.replaceChildren(
        card(
          "Basics",
          stack(
            grid(
              input(
                "Group",
                group,
                (v) => {
                  group = v;
                  organizationChanged();
                },
                { list: "group-options" },
              ),
              channel.objectGroup &&
                input("Channel name", name, (v) => {
                  name = v;
                  organizationChanged();
                }),
            ),
            groupList(),
            button("Apply group / name", () => {
              try {
                const id = putChannel(state.config, channel, data, {
                  group,
                  name,
                });
                state.organizationDrafts.delete(channel.id);
                changed();
                navigate("channels", id);
                toast("Channel organization updated");
              } catch (e) {
                toast(e.message, "error");
              }
            }),
          ),
        ),
        card("Schedule", scheduleFields(data, update)),
      );
    } else if (tab === "Sources")
      content.replaceChildren(
        card(
          "Feed sources",
          sourcesFields(data, update, channel),
          badge(`${channel.feeds.length} feeds`),
        ),
      );
    else if (tab === "Delivery")
      content.replaceChildren(deliveryFields(data, update));
    else {
      const key = FEED_KEYS.find((k) => data[k] !== undefined) || "RSS";
      content.replaceChildren(
        stack(
          disclosure("Read from Discord", () =>
            discordSourceFields(data, update),
          ),
          card(
            "Source storage",
            select("URL field key", key, FEED_KEYS, (value) => {
              const list = feeds(data);
              for (const k of FEED_KEYS) delete data[k];
              data[value] = list;
              update();
            }),
            null,
            "Changing this field explicitly merges the local URL aliases. Other channel fields remain intact.",
          ),
          jsonEditor(
            "Raw channel JSON",
            () => data,
            (parsed) => {
              data = parsed;
              update();
              renderTab("Advanced");
            },
          ),
          button("Delete channel", () => deleteChannel(channel), {
            kind: "danger-text",
          }),
        ),
      );
    }
  };
  for (const tab of ["General", "Sources", "Delivery", "Advanced"])
    tabs.append(
      button(tab, () => renderTab(tab), {
        role: "tab",
        id: `tab-${tab}`,
        "aria-controls": `panel-${tab}`,
      }),
    );
  tabs.addEventListener("keydown", (e) => {
    const items = [...tabs.querySelectorAll("button")],
      i = items.indexOf(document.activeElement);
    let next;
    if (e.key === "ArrowRight") next = (i + 1) % items.length;
    if (e.key === "ArrowLeft") next = (i + items.length - 1) % items.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = items.length - 1;
    if (next !== undefined) {
      e.preventDefault();
      items[next].click();
      items[next].focus();
    }
  });
  renderTab(state.tab);
  return stack(
    button("All channels", () => navigate("channels"), {
      glyph: "back",
      kind: "back-link quiet",
    }),
    heading(
      channel.name,
      `${channel.feeds.length} feeds · ${channel.targets.join(" + ") || "No destinations"} · Every ${channel.interval} min`,
      el("div", { class: "actions" }, [
        statusBadge(channelStatus(channel, state.activity, state.warnings)),
        button("Test", () => testChannel(channel)),
        button("Duplicate", () => duplicate(channel)),
        channelMenu(channel),
      ]),
    ),
    tabs,
    content,
  );
}
function groupList() {
  return el(
    "datalist",
    { id: "group-options" },
    groups(state.config).map(([key]) => el("option", { value: key })),
  );
}
export function addChannel() {
  const data = {
    RSS: [],
    TimeChecker:
      Number(
        (state.config.ChannelDefaults || state.config.DefaultChannel)
          ?.TimeChecker,
      ) || 30,
    RequestSend:
      Number(
        (state.config.ChannelDefaults || state.config.DefaultChannel)
          ?.RequestSend,
      ) || 5,
  };
  let group = groups(state.config)[0]?.[0] || "channels",
    name = "",
    urls = "",
    mode = "array";
  const touch = () => {
    state.editorDirty = true;
    changed();
  };
  const error = el("p", { class: "error-text", role: "alert" });
  const nameField = input(
    "Channel name",
    name,
    (v) => {
      name = v;
      touch();
    },
    { placeholder: "Required for named groups" },
  );
  const modeSelect = select(
    "New group structure",
    mode,
    [
      ["array", "Ordered channels"],
      ["object", "Named channels"],
    ],
    (v) => {
      mode = v;
      syncGroup();
      touch();
    },
  );
  const syncGroup = () => {
    modeSelect.hidden = Object.hasOwn(state.config, group);
    nameField.hidden =
      Array.isArray(state.config[group]) ||
      (!Object.hasOwn(state.config, group) && mode === "array");
  };
  const addUrlInput = input(
    "Source URLs",
    urls,
    (v) => {
      urls = v;
      touch();
    },
    {
      rows: "3",
      placeholder:
        "https://example.com/feed\nPaste multiple URLs, one per line",
    },
  );
  let node;
  const content = stack(
    el("p", {
      class: "muted",
      text: "Group → Channel → Sources → Destinations",
    }),
    card(
      "1 · Basics",
      stack(
        input(
          "Group",
          group,
          (v) => {
            group = v;
            syncGroup();
            touch();
          },
          { list: "group-options" },
        ),
        groupList(),
        modeSelect,
        nameField,
        addUrlInput,
        button("Add URL", () => {
          const area = addUrlInput.querySelector("textarea");
          area.value += area.value ? "\n" : "";
          area.focus();
          area.setSelectionRange(area.value.length, area.value.length);
        }),
      ),
    ),
    card("2 · Delivery", deliveryFields(data, touch)),
    card("3 · Schedule", scheduleFields(data, touch)),
    disclosure("Advanced options", () =>
      stack(
        select("URL field key", "RSS", FEED_KEYS, (key) => {
          const list = feeds(data);
          for (const k of FEED_KEYS) delete data[k];
          data[key] = list;
          touch();
        }),
        discordSourceFields(data, touch),
      ),
    ),
    error,
  );
  const close = async () => {
    if (
      !state.editorDirty ||
      (await confirm(
        "Discard new channel?",
        "The new channel has not been added to your draft.",
        { label: "Discard", danger: true },
      ))
    )
      node.close();
  };
  node = dialog("Add channel", content, {
    drawer: true,
    canClose: async () =>
      !state.editorDirty ||
      (await confirm(
        "Discard new channel?",
        "The new channel has not been added to your draft.",
        { label: "Discard", danger: true },
      )),
    onClose: () => {
      state.editorDirty = false;
      changed();
    },
    actions: [
      button("Cancel", close),
      button(
        "Create channel",
        () => {
          try {
            const list = [
              ...new Set(
                urls
                  .split(/\r?\n/)
                  .map((v) => v.trim())
                  .filter(Boolean),
              ),
            ];
            if (!list.length && !data.Discord)
              throw new Error(
                "Add at least one source URL or a Discord source.",
              );
            for (const url of list) {
              if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(url)) continue;
              try {
                if (/^https?:$/.test(new URL(url).protocol)) continue;
              } catch {}
              throw new Error("Source URLs must use HTTP or HTTPS.");
            }
            if (
              !(
                data.TimeChecker > 0 &&
                Number.isInteger(data.TimeChecker) &&
                data.RequestSend > 0 &&
                Number.isInteger(data.RequestSend)
              )
            )
              throw new Error(
                "Schedule values must be positive whole numbers.",
              );
            data[FEED_KEYS.find((k) => data[k] !== undefined) || "RSS"] = list;
            const id = putChannel(state.config, null, data, {
              group: group.trim(),
              name: name.trim(),
              mode,
            });
            state.editorDirty = false;
            node.close();
            changed();
            navigate("channels", id);
            toast("Channel created in draft");
          } catch (e) {
            error.textContent = e.message;
          }
        },
        { kind: "primary" },
      ),
    ],
  });
  syncGroup();
}
