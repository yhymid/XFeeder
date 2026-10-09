"use strict";
const { waiting } = require("./context");
const { throwIfAborted } = require("./abort");

// Axios has already serialized JSON before invoking our adapter. Reserve bytes
// before opening a socket, leaving data, multipart boundaries and headers intact.
// Unknown-length streams/FormData are deliberately not advertised as shaped.
function bodySize(data) {
  if (data == null) return 0;
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return null;
}
async function reserveUpload(network, config, signal) {
  const bytes = bodySize(config.data);
  if (bytes === null) return false;
  if (config.maxBodyLength >= 0 && bytes > config.maxBodyLength) return false; // Axios rejects before writing.
  if (bytes)
    await waiting(
      network.upload.consume(bytes, { signal }),
      "bandwidth:upload",
    );
  throwIfAborted(signal);
  return true;
}
module.exports = { bodySize, reserveUpload };
