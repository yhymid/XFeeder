import { clone } from "./model.mjs";
export const state = {
  config: {},
  revision: null,
  original: "{}",
  env: "",
  envStatus: {},
  originalEnv: "",
  rawDraft: null,
  editorDirty: false,
  jsonDrafts: new Map(),
  organizationDrafts: new Map(),
  meta: {},
  auth: {},
  cache: {},
  warnings: [],
  errors: [],
  activity: null,
  activityError: "",
  loading: true,
  busy: false,
  view: "overview",
  channelId: null,
  tab: "General",
  collapsed: false,
  channelFilters: {
    search: "",
    group: "",
    status: "",
    destination: "",
    sort: "name",
  },
  activityFilters: {
    search: "",
    status: "",
    channel: "",
    type: "",
    hours: "24",
  },
};
export const configDirty = () =>
  JSON.stringify(state.config) !== state.original;
export const envDirty = () => state.env !== state.originalEnv;
export const rawDirty = () =>
  state.rawDraft !== null &&
  state.rawDraft !== JSON.stringify(state.config, null, 2);
export const dirty = () =>
  configDirty() ||
  envDirty() ||
  rawDirty() ||
  state.editorDirty ||
  state.jsonDrafts.size > 0 ||
  state.organizationDrafts.size > 0;
export function acceptConfig(payload) {
  state.revision = payload.revision;
  state.config = clone(payload.config);
  state.original = JSON.stringify(payload.config);
  state.warnings = payload.warnings || [];
  state.errors = payload.errors || [];
  state.rawDraft = null;
  state.jsonDrafts.clear();
  state.organizationDrafts.clear();
}
export function acceptState(payload) {
  acceptConfig(payload);
  state.envStatus = payload.envStatus || {};
  state.env = "";
  state.originalEnv = state.env;
  state.meta = payload.meta;
  state.auth = payload.auth;
  state.cache = payload.cacheSummary;
}
export const changed = () =>
  document.dispatchEvent(new CustomEvent("config-changed"));
export const navigate = (view, channelId = null) => {
  location.hash = channelId
    ? `channels/${encodeURIComponent(channelId)}`
    : view;
};
