"use strict";

const fs = require("fs");
const path = require("path");

const LOG_DIRECTORY = path.resolve(__dirname, "../../debug");
const LOG_PATH = path.join(LOG_DIRECTORY, "terminal.txt");

let installed = false;
let enabled = false;
let fileDescriptor = null;
let processLabel = "xfeeder";

function writeLog(value) {
  if (fileDescriptor === null) return;

  try {
    fs.writeSync(fileDescriptor, value);
  } catch (error) {
    enabled = false;
    const warning = `[Terminal Log] Could not write ${LOG_PATH}: ${error.message}\n`;
    try {
      fs.writeSync(2, warning);
    } catch {
      // Keep logging failures from interrupting the application.
    }
  }
}

function setTerminalLogEnabled(nextEnabled) {
  const shouldEnable = nextEnabled === true;
  if (enabled === shouldEnable) return;

  const timestamp = new Date().toISOString();
  writeLog(`\n----- ${timestamp} ${processLabel} terminal capture ${shouldEnable ? "started" : "paused"} (pid=${process.pid}) -----\n`);
  enabled = shouldEnable;
}

function installTerminalLog({ enabled: initiallyEnabled = true, label = "xfeeder" } = {}) {
  if (!installed) {
    processLabel = String(label || "xfeeder").replace(/[\r\n]/g, " ");

    try {
      fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
      fileDescriptor = fs.openSync(LOG_PATH, "a");

      for (const [stream, streamName] of [[process.stdout, "stdout"], [process.stderr, "stderr"]]) {
        const originalWrite = stream.write;
        stream.write = function writeWithTerminalCapture(chunk, encoding, callback) {
          if (enabled && fileDescriptor !== null) {
            try {
              const output = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
              const prefix = Buffer.from(`[${new Date().toISOString()}][${processLabel}][${streamName}] `);
              fs.writeSync(fileDescriptor, Buffer.concat([prefix, output]));
            } catch (error) {
              enabled = false;
              const warning = `[Terminal Log] Could not write ${LOG_PATH}: ${error.message}\n`;
              try {
                fs.writeSync(2, warning);
              } catch {
                // Keep logging failures from interrupting the application.
              }
            }
          }

          return originalWrite.call(this, chunk, encoding, callback);
        };
      }

      process.on("exit", () => {
        if (enabled) {
          writeLog(`\n----- ${new Date().toISOString()} ${processLabel} terminal capture ended (pid=${process.pid}) -----\n`);
        }
        if (fileDescriptor !== null) {
          try {
            fs.closeSync(fileDescriptor);
          } catch {
            // The operating system will close the descriptor when the process exits.
          }
        }
      });
      installed = true;
    } catch (error) {
      const warning = `[Terminal Log] Could not initialize ${LOG_PATH}: ${error.message}\n`;
      try {
        fs.writeSync(2, warning);
      } catch {
        // Keep logging failures from interrupting the application.
      }
      return false;
    }
  }

  setTerminalLogEnabled(initiallyEnabled);
  return true;
}

module.exports = {
  installTerminalLog,
  setTerminalLogEnabled,
  terminalLogPath: LOG_PATH,
};
