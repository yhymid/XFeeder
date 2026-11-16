import { state, changed } from "./state.js";
import { isObject } from "./model.mjs";
let uid = 0;
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on"))
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (["value", "checked", "disabled", "hidden"].includes(key))
      node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of [children]
    .flat(Infinity)
    .filter((v) => v !== null && v !== undefined && v !== false))
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  return node;
}
const icons = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  channels:
    '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  activity: '<path d="M2 12h4l3-8 5 16 3-8h5"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  advanced: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-2-15-4 18"/>',
  rss: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4m0 4h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5m0 4h.01"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 7M4 12l2 7a7 7 0 0 0 12-2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  collapse:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18m7-13-4 4 4 4"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c6 6 6 12 0 18-6-6-6-12 0-18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4L22 2ZM11 13 22 2"/>',
  logout: '<path d="M10 4H4v16h6m5-12 4 4-4 4m-7-4h11"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
};
export function icon(name) {
  const span = el("span", { class: "icon", "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.globe}</svg>`;
  return span;
}
export function button(
  label,
  action,
  { kind = "", glyph, iconOnly = false, ...props } = {},
) {
  return el(
    "button",
    {
      type: "button",
      class: `button ${kind}${iconOnly ? " icon-button" : ""}`,
      title: iconOnly ? label : null,
      "aria-label": iconOnly ? label : null,
      onClick: action,
      ...props,
    },
    [glyph && icon(glyph), !iconOnly && label],
  );
}
export function badge(label, tone = "") {
  return el("span", { class: `badge ${tone}` }, label);
}
export function statusBadge(status = "unknown") {
  const label =
    {
      healthy: "Healthy",
      success: "Success",
      warning: "Warning",
      error: "Error",
      unknown: "Unknown",
    }[status] || status;
  return el("span", { class: `status ${status}` }, [
    icon({ healthy: "check", success: "check" }[status] || status),
    label,
  ]);
}
export function heading(title, subtitle, action) {
  return el("header", { class: "page-heading" }, [
    el("div", {}, [
      el("h1", { text: title, tabindex: "-1" }),
      el("p", { text: subtitle }),
    ]),
    action,
  ]);
}
export function card(title, children, action, subtitle) {
  return el("section", { class: "card" }, [
    el("div", { class: "card-heading" }, [
      el("div", {}, [
        el("h2", { text: title }),
        subtitle && el("p", { text: subtitle, class: "muted" }),
      ]),
      action,
    ]),
    children,
  ]);
}
export const stack = (...children) => el("div", { class: "stack" }, children);
export const grid = (...children) =>
  el("div", { class: "field-grid" }, children);
export const empty = (title, description, action) =>
  el("div", { class: "empty-state" }, [
    icon("rss"),
    el("strong", { text: title }),
    el("p", { text: description }),
    action,
  ]);
export function field(label, control, hint = "") {
  const id = control.id || `field-${++uid}`;
  control.id = id;
  return el("div", { class: "field" }, [
    el("label", { for: id, text: label }),
    control,
    hint && el("small", { class: "muted", text: hint }),
  ]);
}
export function input(label, value, onChange, options = {}) {
  return field(
    label,
    el(options.rows ? "textarea" : "input", {
      type: options.type || "text",
      value: value ?? "",
      onInput: (e) => onChange(e.target.value),
      ...options,
    }),
    options.hint,
  );
}
export function select(label, value, choices, onChange) {
  const control = el(
    "select",
    { "aria-label": label, onChange: (e) => onChange(e.target.value) },
    choices.map((c) => {
      const [v, text] = Array.isArray(c) ? c : [c, c];
      return el("option", { value: v, text });
    }),
  );
  control.value = value;
  return field(label, control);
}
export function toggle(label, checked, onChange, hint = "") {
  return el("label", { class: "toggle" }, [
    el("div", {}, [
      el("strong", { text: label }),
      hint && el("small", { class: "muted", text: hint }),
    ]),
    el("input", {
      type: "checkbox",
      role: "switch",
      checked,
      onChange: (e) => onChange(e.target.checked),
    }),
  ]);
}
export function secret(label, value, onChange, hint = "") {
  const envRef = (v) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v);
  const source = el("small", { class: "muted" });
  const control = el("input", {
    type: envRef(value) ? "text" : "password",
    value: value || "",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": label,
    onInput: (e) => {
      onChange(e.target.value);
      control.type = envRef(e.target.value) ? "text" : "password";
      reveal.textContent = "Reveal";
      update();
    },
  });
  const update = () => {
    reveal.disabled = envRef(control.value);
    source.textContent = envRef(control.value)
      ? `ENV · ${control.value.slice(2, -1)} · from environment`
      : control.value
        ? "Override · stored in configuration"
        : hint || "Not configured";
  };
  const reveal = button(
    "Reveal",
    () => {
      control.type = control.type === "password" ? "text" : "password";
      reveal.textContent = control.type === "password" ? "Reveal" : "Hide";
    },
    { kind: "quiet", "aria-label": `Reveal ${label}` },
  );
  const copy = button(
    "Copy",
    async () => {
      try {
        await navigator.clipboard.writeText(control.value);
        toast("Copied to clipboard");
      } catch {
        toast(
          "Clipboard unavailable. Reveal and select the value to copy.",
          "error",
        );
      }
    },
    { kind: "quiet", "aria-label": `Copy ${label}` },
  );
  update();
  const wrapper = field(label, control);
  wrapper.replaceChildren(
    wrapper.firstChild,
    el("div", { class: "secret-input" }, [control, reveal, copy]),
    source,
  );
  return wrapper;
}
export function disclosure(title, content, meta = "") {
  const node = el("details", { class: "disclosure" }, [
    el("summary", {}, [
      el("span", {}, title),
      meta && el("small", { class: "muted", text: meta }),
    ]),
  ]);
  if (typeof content === "function")
    node.addEventListener("toggle", () => {
      if (node.open && node.childElementCount === 1)
        node.append(el("div", { class: "disclosure-body stack" }, content()));
    });
  else node.append(el("div", { class: "disclosure-body stack" }, content));
  return node;
}
export function toast(message, tone = "") {
  const root = document.querySelector("#toasts");
  if (!root) return;
  const item = el(
    "div",
    { class: `toast ${tone}`, role: tone === "error" ? "alert" : "status" },
    [
      icon(tone === "error" ? "error" : "check"),
      el("span", { text: message }),
      button("Dismiss notification", () => item.remove(), {
        glyph: "close",
        iconOnly: true,
        kind: "quiet",
      }),
    ],
  );
  while (root.childElementCount >= 2) root.firstElementChild.remove();
  root.append(item);
  setTimeout(() => item.remove(), tone === "error" ? 10000 : 5000);
}
export function dialog(
  title,
  content,
  {
    actions = [],
    drawer = false,
    onClose,
    canClose = () => true,
    alert = false,
  } = {},
) {
  const previous = document.activeElement;
  const node = el("dialog", {
    class: drawer ? "dialog drawer" : "dialog",
    "aria-labelledby": `dialog-${++uid}`,
    role: alert ? "alertdialog" : "dialog",
  });
  const close = async () => {
    if (await canClose()) node.close();
  };
  node.append(
    el("header", { class: "dialog-heading" }, [
      el("h2", { id: `dialog-${uid}`, text: title }),
      button("Close dialog", close, {
        glyph: "close",
        iconOnly: true,
        kind: "quiet",
      }),
    ]),
    el("div", { class: "dialog-body stack" }, content),
    actions.length && el("footer", { class: "dialog-actions" }, actions),
  );
  node.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  node.addEventListener("close", () => {
    onClose?.();
    node.remove();
    if (previous?.isConnected) previous.focus();
    else document.querySelector("h1")?.focus();
  });
  document.body.append(node);
  node.showModal();
  return node;
}
export function confirm(
  title,
  message,
  { label = "Confirm", danger = false } = {},
) {
  return new Promise((resolve) => {
    let result = false;
    const node = dialog(
      title,
      typeof message === "string" ? el("p", { text: message }) : message,
      {
        alert: true,
        actions: [
          button("Cancel", () => node.close()),
          button(
            label,
            () => {
              result = true;
              node.close();
            },
            { kind: danger ? "danger" : "primary" },
          ),
        ],
        onClose: () => resolve(result),
      },
    );
    node.querySelector(".dialog-actions button").focus();
  });
}
export function menu(label, actions) {
  const trigger = button(
    label,
    () => {
      const content = el("div", { class: "action-list" });
      let node;
      for (const [text, action, danger] of actions)
        content.append(
          button(
            text,
            () => {
              node.close();
              action();
            },
            { kind: danger ? "danger-text" : "quiet" },
          ),
        );
      node = dialog(label, content);
    },
    { glyph: "more", iconOnly: true, kind: "quiet", "aria-haspopup": "dialog" },
  );
  return trigger;
}
export function relative(time) {
  if (!time) return "Not observed";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(time)) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function jsonEditor(
  title,
  getValue,
  onApply,
  {
    hint = "Raw JSON may contain secrets. Changes are applied locally before saving.",
    onDraft,
  } = {},
) {
  return disclosure(title, () => {
    const draftKey = `${state.view}:${state.channelId || ""}:${title}`;
    const initial = JSON.stringify(getValue(), null, 2);
    const area = el("textarea", {
      class: "code",
      rows: "14",
      "aria-label": title,
      spellcheck: "false",
      value: state.jsonDrafts.get(draftKey) ?? initial,
      onInput: (e) => {
        if (e.target.value === initial) state.jsonDrafts.delete(draftKey);
        else state.jsonDrafts.set(draftKey, e.target.value);
        onDraft?.(e.target.value);
        changed();
      },
    });
    const error = el("p", { class: "error-text", role: "alert" });
    const parse = () => {
      const value = JSON.parse(area.value);
      if (!isObject(value)) throw new Error("Enter a JSON object.");
      return value;
    };
    return [
      el("p", { class: "muted", text: hint }),
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
                "Apply JSON to form?",
                "This will replace the current form values. Review your JSON before continuing.",
                { label: "Apply JSON" },
              )
            ) {
              state.jsonDrafts.delete(draftKey);
              onApply(value);
              onDraft?.(null);
              changed();
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
              "Replace this JSON draft with the current form values?",
              { label: "Reset editor" },
            )
          ) {
            area.value = JSON.stringify(getValue(), null, 2);
            state.jsonDrafts.delete(draftKey);
            error.textContent = "";
            changed();
          }
        }),
      ]),
    ];
  });
}
