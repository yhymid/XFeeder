"use strict";

const { parseDotEnv } = (() => {
  // loadDotEnv resolves placeholders but does not export the parser; status
  // checks need only a strict, read-only map of .env key/value lines.
  const parse = content => {
    const result = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const val = match[2].trim();
      result[match[1]] = val.length >= 2 &&
        ((val[0] === "'" && val.at(-1) === "'") ||
         (val[0] === '"' && val.at(-1) === '"')) ? val.slice(1, -1) : val;
    }
    return result;
  };
  return { parseDotEnv: parse };
})();

const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED = /^(?:NODE_|LD_|DYLD_|BASH_ENV$|ENV$|PATH$|HOME$|SHELL$|XFEEDER_DASHBOARD_|npm_)/i;

function referencedNames(config) {
  const names = new Set();
  function visit(node) {
    if (typeof node === "string") {
      for (const match of node.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
        names.add(match[1]);
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  }
  visit(config);
  return names;
}

function secretStatus(config, envText, processValues = process.env) {
  const parsed = parseDotEnv(envText);
  const names = new Set([...referencedNames(config), ...Object.keys(parsed)]);
  return Object.fromEntries([...names].filter(x => SECRET_KEY.test(x)).sort()
    .map(name => [name, String(processValues[name] ?? parsed[name] ?? "") !== ""
      ? "Configured" : "Missing"]));
}

function replaceSecretLine(envText, name, value) {
  if (!SECRET_KEY.test(name) || RESERVED.test(name))
    throw Object.assign(new Error("Secret name is not allowed"), { code: "INVALID_SECRET_NAME" });
  if (typeof value !== "string" || !value || value.length > 8192 ||
      /[\x00-\x1f\x7f]/.test(value) || value.trim() !== value ||
      ((value.startsWith('"') && value.endsWith('"')) ||
       (value.startsWith("'") && value.endsWith("'")))) {
    throw Object.assign(new Error("Secret value must be a nonempty single line"),
      { code: "INVALID_SECRET_VALUE" });
  }
  const content = String(envText || "");
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const prefix = new RegExp("^(\\s*" + name + "\\s*=\\s*)(.*)$");
  let matches = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(prefix);
    if (match) { lines[i] = match[1] + value; matches++; }
  }
  if (matches > 1) throw Object.assign(new Error("Duplicate environment key must be resolved first"),
    { code: "DUPLICATE_SECRET_NAME" });
  if (!matches) {
    if (lines.at(-1) === "") lines.pop();
    lines.push(name + "=" + value);
  }
  return lines.join(lineEnding).replace(/(?:\r?\n)*$/, "") + lineEnding;
}
module.exports = { secretStatus, referencedNames, replaceSecretLine, SECRET_KEY, RESERVED };
