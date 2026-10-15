"use strict";

const axios = require("axios");
const { networkAdapter } = require("./http-adapter");
const { context } = require("./context");

// X3-17 is an HTTP *boundary*, not a transport rewrite. All requests still
// pass through the proven Axios adapter, which owns network admission,
// pacing, byte accounting, deadlines, streaming and cancellation.
function createManagedClient(defaults = {}) {
  return axios.create({ ...defaults, adapter: networkAdapter });
}

// Delivery providers intentionally keep Axios's static post() boundary:
// replacing it with a separate instance would alter provider test seams and
// could silently change proxy/timeout/response handling. No implicit POST
// retry is introduced here (a possibly accepted delivery must not be replayed).
function postManaged(url, data, options = {}) {
  return axios.post(url, data, {
    ...options,
    signal: options.signal === undefined ? context().signal : options.signal,
    adapter: networkAdapter,
  });
}

module.exports = {
  createManagedClient,
  postManaged,
};
