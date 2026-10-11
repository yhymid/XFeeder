"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, beforeEach } = require("node:test");
const { loadConfig, loadDotEnv } = require("../src/config-loader");
const { tempDir } = require("./helpers/temp-dir.cjs");

const fixtures = path.join(__dirname, "fixtures/config");
const names = ["X3_CONFIG_TOKEN", "X3_CONFIG_EMPTY", "X3_CONFIG_MISSING", "X3_CONFIG_NUMBER", "X3_CONFIG_BOOLEAN"];
beforeEach(t => {
  const previous = names.map(name => [name, process.env[name]]);
  for (const name of names) delete process.env[name];
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
});

function files(t, config = { Settings: { token: "${X3_CONFIG_TOKEN}" } }, env) {
  const directory = tempDir(t);
  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");
  fs.writeFileSync(configPath, JSON.stringify(config));
  if (env !== undefined) fs.writeFileSync(envPath, env);
  return { directory, configPath, envPath };
}

test("loadConfig substitutes complete variables recursively while preserving literals and types", t => {
  const config = JSON.parse(fs.readFileSync(path.join(fixtures, "substitution.json"), "utf8"));
  const f = files(t, config, "X3_CONFIG_TOKEN=synthetic-value\nX3_CONFIG_NUMBER=42\nX3_CONFIG_BOOLEAN=false\n");
  const before = fs.readFileSync(f.configPath, "utf8");
  assert.deepEqual(loadConfig(f.configPath), { Settings: {
    token: "synthetic-value", nested: [{ token: "synthetic-value" }, ["synthetic-value"], 42, false, null],
    number: "42", boolean: "false", embedded: "prefix-${X3_CONFIG_TOKEN}",
    multiple: "${X3_CONFIG_TOKEN}/${X3_CONFIG_NUMBER}", fallback: "${X3_CONFIG_MISSING:-default}",
    invalid: "${BAD-NAME}", "${X3_CONFIG_TOKEN}": "unchanged key",
  } });
  assert.equal(fs.readFileSync(f.configPath, "utf8"), before, "Loading must not rewrite config");
});

test("loadConfig resolves missing and explicitly empty variables to empty strings", t => {
  const f = files(t, { Settings: { missing: "${X3_CONFIG_MISSING}", empty: "${X3_CONFIG_EMPTY}" } }, "X3_CONFIG_EMPTY=\n");
  assert.deepEqual(loadConfig(f.configPath).Settings, { missing: "", empty: "" });
});

test("loadConfig gives process.env precedence, including an empty override", t => {
  const f = files(t, { Settings: { token: "${X3_CONFIG_TOKEN}", empty: "${X3_CONFIG_EMPTY}" } },
    "X3_CONFIG_TOKEN=file-value\nX3_CONFIG_EMPTY=file-value\n");
  process.env.X3_CONFIG_TOKEN = "process-value";
  process.env.X3_CONFIG_EMPTY = "";
  assert.deepEqual(loadConfig(f.configPath).Settings, { token: "process-value", empty: "" });
});

test("loadConfig works without .env using process variables and empty missing values", t => {
  const f = files(t, { Settings: { token: "${X3_CONFIG_TOKEN}", missing: "${X3_CONFIG_MISSING}" } });
  process.env.X3_CONFIG_TOKEN = "process-only";
  assert.deepEqual(loadConfig(f.configPath).Settings, { token: "process-only", missing: "" });
  assert.equal(fs.existsSync(f.envPath), false, "Missing .env must not be created");
});

test("dotenv loading never populates process.env or recursively expands values", t => {
  const f = files(t, undefined, "X3_CONFIG_TOKEN=${X3_CONFIG_NUMBER}\nX3_CONFIG_NUMBER=42\n");
  assert.equal(loadDotEnv(f.envPath).X3_CONFIG_TOKEN, "${X3_CONFIG_NUMBER}");
  assert.equal(loadConfig(f.configPath).Settings.token, "${X3_CONFIG_NUMBER}");
  assert.equal(process.env.X3_CONFIG_TOKEN, undefined);
  assert.equal(process.env.X3_CONFIG_NUMBER, undefined);
});

for (const newline of ["\n", "\r\n"]) {
  test(`loadDotEnv parses quotes, whitespace, duplicate keys and ${newline === "\n" ? "LF" : "CRLF"}`, t => {
    const syntax = fs.readFileSync(path.join(fixtures, "dotenv-valid.txt"), "utf8").replace(/\r?\n/g, newline);
    const f = files(t, undefined, syntax);
    assert.deepEqual(loadDotEnv(f.envPath), {
      X3_ENV_PLAIN: "plain value", X3_ENV_SINGLE: "  quoted whitespace  ", X3_ENV_DOUBLE: "double quoted",
      X3_ENV_EMPTY: "", X3_ENV_SINGLE_EMPTY: "", X3_ENV_DOUBLE_EMPTY: "",
      X3_ENV_EQUALS: "one=two=three", X3_ENV_DUPLICATE: "last", X3_ENV_INLINE: "value # retained",
      X3_ENV_ESCAPE: "line\\nnext", _X3_ENV_1: "underscore",
    });
  });
}

test("malformed dotenv lines are skipped and unmatched quotes stay literal", t => {
  const malformed = fs.readFileSync(path.join(fixtures, "dotenv-malformed.txt"), "utf8");
  const f = files(t, { Settings: { token: "${X3_CONFIG_TOKEN}" } }, malformed);
  assert.deepEqual(loadDotEnv(f.envPath), { X3_CONFIG_TOKEN: "still-valid", X3_ENV_UNCLOSED: '"unfinished', X3_ENV_MISMATCH: "'mismatched\"" });
  assert.equal(loadConfig(f.configPath).Settings.token, "still-valid");
});

for (const content of ["", "  \n# only a comment\n\t\n"]) {
  test(`loadConfig accepts ${content ? "comment-only" : "empty"} .env`, t => {
    const f = files(t, undefined, content);
    assert.deepEqual(loadDotEnv(f.envPath), {});
    assert.equal(loadConfig(f.configPath).Settings.token, "");
  });
}

test("loadConfig reloads edited .env in the same process even with unchanged mtime", t => {
  const f = files(t, undefined, "X3_CONFIG_TOKEN=first\n");
  const time = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(f.envPath, time, time);
  const before = fs.statSync(f.envPath).mtimeMs;
  assert.equal(loadConfig(f.configPath).Settings.token, "first");
  fs.writeFileSync(f.envPath, "X3_CONFIG_TOKEN=later\n");
  fs.utimesSync(f.envPath, time, time);
  assert.equal(fs.statSync(f.envPath).mtimeMs, before);
  assert.equal(loadConfig(f.configPath).Settings.token, "later");
});

test("loadConfig reloads JSON and process.env without restarting the module", t => {
  const f = files(t);
  process.env.X3_CONFIG_TOKEN = "first";
  assert.equal(loadConfig(f.configPath).Settings.token, "first");
  fs.writeFileSync(f.configPath, JSON.stringify({ Settings: { renamed: "${X3_CONFIG_TOKEN}" } }));
  process.env.X3_CONFIG_TOKEN = "updated";
  assert.deepEqual(loadConfig(f.configPath).Settings, { renamed: "updated" });
  delete process.env.X3_CONFIG_TOKEN;
  assert.deepEqual(loadConfig(f.configPath).Settings, { renamed: "" });
});

test("loadConfig forgets removed env keys and handles deletion and recreation of .env", t => {
  const f = files(t, undefined, "X3_CONFIG_TOKEN=first\n");
  assert.equal(loadConfig(f.configPath).Settings.token, "first");
  fs.writeFileSync(f.envPath, "X3_CONFIG_NUMBER=42\n");
  assert.equal(loadConfig(f.configPath).Settings.token, "");
  fs.unlinkSync(f.envPath);
  assert.deepEqual(loadDotEnv(f.envPath), {});
  assert.equal(loadConfig(f.configPath).Settings.token, "");
  fs.writeFileSync(f.envPath, "X3_CONFIG_TOKEN=recreated\n");
  assert.equal(loadConfig(f.configPath).Settings.token, "recreated");
});

test("each config loads its own sibling .env without leaking across directories", t => {
  const first = files(t, undefined, "X3_CONFIG_TOKEN=first\n");
  const second = files(t, undefined, "X3_CONFIG_TOKEN=second\n");
  const missing = files(t);
  assert.equal(loadConfig(first.configPath).Settings.token, "first");
  assert.equal(loadConfig(second.configPath).Settings.token, "second");
  assert.equal(loadConfig(missing.configPath).Settings.token, "");
  assert.equal(loadConfig(first.configPath).Settings.token, "first");
});

test("loadDotEnv caches by path/mtime and supports explicit reload without sharing returned objects", t => {
  const f = files(t, undefined, "X3_CONFIG_TOKEN=first\n");
  const time = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(f.envPath, time, time);
  const initial = loadDotEnv(f.envPath);
  initial.X3_CONFIG_TOKEN = "caller-mutation";
  assert.equal(loadDotEnv(f.envPath).X3_CONFIG_TOKEN, "first");
  fs.writeFileSync(f.envPath, "X3_CONFIG_TOKEN=later\n");
  fs.utimesSync(f.envPath, time, time);
  assert.equal(loadDotEnv(f.envPath).X3_CONFIG_TOKEN, "first");
  assert.equal(loadDotEnv(f.envPath, { reload: true }).X3_CONFIG_TOKEN, "later");
  fs.writeFileSync(f.envPath, "X3_CONFIG_TOKEN=newer\n");
  fs.utimesSync(f.envPath, time, new Date("2020-01-01T00:00:02Z"));
  assert.equal(loadDotEnv(f.envPath).X3_CONFIG_TOKEN, "newer");
});

test("loadDotEnv does not reuse another file's cache when mtimes match", t => {
  const first = files(t, undefined, "X3_CONFIG_TOKEN=first\n");
  const second = files(t, undefined, "X3_CONFIG_TOKEN=other\n");
  const time = new Date("2020-01-01T00:00:00Z");
  for (const f of [first, second]) fs.utimesSync(f.envPath, time, time);
  assert.equal(loadDotEnv(first.envPath).X3_CONFIG_TOKEN, "first");
  assert.equal(loadDotEnv(second.envPath).X3_CONFIG_TOKEN, "other");
  assert.equal(loadDotEnv(first.envPath).X3_CONFIG_TOKEN, "first");
});

for (const broken of ["", '{"Settings":', '{"Settings":{},}']) {
  test(`malformed JSON is rejected and can be repaired (${JSON.stringify(broken)})`, t => {
    const f = files(t, undefined, "X3_CONFIG_TOKEN=valid-env\n");
    fs.writeFileSync(f.configPath, broken);
    assert.throws(() => loadConfig(f.configPath), SyntaxError);
    assert.equal(fs.readFileSync(f.configPath, "utf8"), broken);
    fs.writeFileSync(f.configPath, JSON.stringify({ Settings: { token: "${X3_CONFIG_TOKEN}" } }));
    assert.equal(loadConfig(f.configPath).Settings.token, "valid-env");
  });
}

test("missing config throws ENOENT rather than creating or substituting a configuration", t => {
  const configPath = path.join(tempDir(t), "missing.json");
  assert.throws(() => loadConfig(configPath), { code: "ENOENT" });
  assert.equal(fs.existsSync(configPath), false);
});

test("unreadable .env is treated as empty and subsequent loads can recover", t => {
  const f = files(t, undefined, "X3_CONFIG_TOKEN=recovered\n");
  const read = fs.readFileSync;
  const mock = t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === f.envPath) throw Object.assign(new Error("fixture permission failure"), { code: "EACCES" });
    return read(file, ...args);
  });
  assert.equal(loadConfig(f.configPath).Settings.token, "");
  mock.mock.restore();
  assert.equal(loadConfig(f.configPath).Settings.token, "recovered");
});
