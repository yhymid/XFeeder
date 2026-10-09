"use strict";
const axios = require("axios");
const http = require("node:http");
const https = require("node:https");
const redirects = require("follow-redirects");
const { finished } = require("node:stream");
const { DownloadStream } = require("./download-stream");
const { manageIncomingDownload } = require("./incoming-download");
const { getNetwork } = require("./service");
const { reserveUpload } = require("./upload");
const originalAdapter = axios.getAdapter("http");

function timeoutError(phase, ms, config) {
  const error = new axios.AxiosError(
    `${phase} timeout of ${ms}ms exceeded`,
    "ECONNABORTED",
    config,
  );
  error.phase = phase;
  return error;
}

// Wrap Node's raw response before Axios decompresses it. Axios retains its own
// redirect/proxy, status handling, JSON decoding and maxContentLength checks.
function createTransport(config, network, signal, lifecycle) {
  return {
    request(options, callback) {
      const transport =
        config.transport ||
        (config.maxRedirects === 0
          ? options.protocol === "https:"
            ? https
            : http
          : options.protocol === "https:"
            ? redirects.https
            : redirects.http);
      if (config.maxRedirects > 0) options.maxRedirects = config.maxRedirects;
      if (config.beforeRedirect)
        options.beforeRedirects.config = config.beforeRedirect;
      const explicitTimeout =
        config.timeout === config.xfeederDefaultTimeout
          ? undefined
          : config.timeout;
      const setupMs =
        config.setupTimeoutMs ??
        explicitTimeout ??
        network.config.setupTimeoutMs;
      const idleMs =
        config.idleTimeoutMs ?? explicitTimeout ?? network.config.idleTimeoutMs;
      let setupTimer;
      const request = transport.request(options, (raw) => {
        clearTimeout(setupTimer);
        const onIdleTimeout = () => {
          lifecycle.failure = timeoutError("idle", idleMs, config);
          return lifecycle.failure;
        };
        const stream = raw instanceof http.IncomingMessage
          ? manageIncomingDownload(raw, network, signal, idleMs, onIdleTimeout, {
              observeAbort: !lifecycle.managedCancellation,
              onFailure: (error) => {
                lifecycle.failure ??= axios.AxiosError.from(
                  error, error.code, config, lifecycle.request,
                );
              },
            })
          : new DownloadStream(raw, network, signal, idleMs, onIdleTimeout);
        lifecycle.stream = stream;
        callback(stream);
      });
      lifecycle.request = request;
      if (signal.aborted) request.destroy(lifecycle.failure || signal.reason);
      if (setupMs > 0)
        setupTimer = setTimeout(() => {
          lifecycle.failure = timeoutError("setup", setupMs, config);
          request.destroy(lifecycle.failure);
        }, setupMs);
      request.once("error", () => clearTimeout(setupTimer));
      request.once("close", () => clearTimeout(setupTimer));
      // Count the encoded bytes accepted by the transport, not reserved credits
      // or decompressed buffers. follow-redirects' internal replay is out of scope.
      const write = request.write;
      request.write = function (chunk, encoding, callback) {
        const result = write.call(this, chunk, encoding, callback);
        network.metrics.record(
          "upload",
          typeof chunk === "string"
            ? Buffer.byteLength(
                chunk,
                typeof encoding === "string" ? encoding : undefined,
              )
            : chunk.length,
          lifecycle.uploadShaped || network.upload.rate === null,
        );
        return result;
      };
      return request;
    },
  };
}

function validateTimeoutOptions(config) {
  for (const key of ["setupTimeoutMs", "idleTimeoutMs", "deadlineMs"]) {
    const value = config[key];
    if (
      value != null &&
      (!Number.isSafeInteger(value) || value < 0 || value > 2_147_000_000)
    ) {
      throw new axios.AxiosError(
        `${key} must be an integer from 0 to 2147000000`,
        "ERR_BAD_OPTION_VALUE",
        config,
      );
    }
  }
}

async function networkAdapter(config) {
  if (Number(config.httpVersion) === 2)
    throw new axios.AxiosError(
      "Managed network transport supports HTTP/1.x",
      "ERR_NOT_SUPPORT",
      config,
    );
  validateTimeoutOptions(config);
  const network = getNetwork();
  const deadline = config.deadlineMs ?? network.config.requestDeadlineMs;
  const op = network.operation(config.signal, { localAbort: deadline > 0 });
  let release, deadlineTimer, detachFinished;
  const lifecycle = {};
  // The tracked bodyless operation owns cancellation through setup and response
  // consumption, using one subscription instead of separate Axios/stream ones.
  // Bodies, legacy cancellation and custom transports keep Axios cancellation.
  lifecycle.managedCancellation =
    config.data == null && !config.cancelToken && !config.transport;
  let detachAbort;
  if (lifecycle.managedCancellation) {
    const abortRequest = (reason) => {
      const error = reason?.phase ? reason : new axios.CanceledError(
        reason?.message || "Request canceled", config, lifecycle.request,
      );
      lifecycle.failure = error;
      lifecycle.stream?.destroy(error);
      lifecycle.request?.destroy(error);
    };
    if (op.signal === network.controller.signal) op.abort = abortRequest;
    else {
      const abort = () => abortRequest(op.signal.reason);
      op.signal.addEventListener("abort", abort, { once: true });
      detachAbort = () => op.signal.removeEventListener("abort", abort);
    }
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(deadlineTimer);
    detachAbort?.();
    detachFinished?.();
    release?.();
    op.finish();
  };
  try {
    if (deadline > 0)
      deadlineTimer = setTimeout(
        () => op.abort(timeoutError("deadline", deadline, config)),
        deadline,
      );
    release = network.http.tryAcquire(op.signal);
    if (!release) release = await network.acquire("http", op.signal);
    lifecycle.uploadShaped = config.data == null ||
      await reserveUpload(network, config, op.signal);
    const response = await originalAdapter({
      ...config,
      signal: lifecycle.managedCancellation ? undefined : op.signal,
      timeout: 0,
      transport: createTransport(config, network, op.signal, lifecycle),
    });
    response.config = config;
    if (response.data && typeof response.data.pipe === "function") {
      detachFinished = finished(response.data, cleanup);
      response.data.on("error", () => {});
    } else cleanup();
    return response;
  } catch (error) {
    lifecycle.stream?.destroy();
    cleanup();
    // Axios uses CanceledError when our explicit total deadline aborts a request.
    if (op.signal.aborted && op.signal.reason?.phase) throw op.signal.reason;
    if (lifecycle.failure) throw lifecycle.failure;
    throw error;
  }
}
module.exports = { networkAdapter, validateTimeoutOptions };
