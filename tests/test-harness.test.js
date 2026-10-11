"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempDir } = require("./helpers/temp-dir.cjs");
const { serve } = require("./fixtures/network.cjs");
const { testFiles } = require("../scripts/test.cjs");
const script = path.resolve(__dirname, "../scripts/test.cjs");

function fixture(t, source) {
  const root = path.join(tempDir(t), "project with spaces");
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "fixture.test.js"), source);
  return root;
}

function invoke(root, env = process.env, args = []) {
  return spawnSync(process.execPath, ["-e",
    `process.exitCode = require(${JSON.stringify(script)}).run({ root: ${JSON.stringify(root)}, args: ${JSON.stringify(args)} });`],
  { encoding: "utf8", env, timeout: 15000 });
}

test("harness discovers only test files, including paths with spaces", t => {
  const root = fixture(t, "require('node:test')('fixture', () => {});");
  fs.writeFileSync(path.join(root, "tests", "a.test.js"), "require('node:test')('second', () => {});");
  for (const name of ["browser.cjs", "helper.js"]) fs.writeFileSync(path.join(root, "tests", name), "throw Error('Must not run');");
  assert.deepEqual(testFiles(root).map(file => path.basename(file)), ["a.test.js", "fixture.test.js"]);
  const result = invoke(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("harness failure returns nonzero and removes its temporary working directory", t => {
  const root = fixture(t, `
    const test = require('node:test');
    console.log('TEMP_CWD=' + process.cwd());
    test('deliberate failure', () => { throw Error('EXPECTED_FIXTURE_FAILURE'); });
  `);
  const result = invoke(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /EXPECTED_FIXTURE_FAILURE/);
  const directory = (result.stdout + result.stderr).match(/TEMP_CWD=([^\r\n]+)/)?.[1];
  assert.ok(directory); assert.equal(fs.existsSync(directory), false);
});

test("harness isolates credentials, Git steering and default state paths", t => {
  const root = fixture(t, `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    test('isolated environment and files', () => {
      for (const name of ['EXAMPLE_TOKEN', 'TELEGRAM_BOT_TOKEN', 'HTTP_PROXY', 'XFEEDER_DASHBOARD_PUBLIC_ORIGIN', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) assert.equal(process.env[name], undefined, name);
      assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
      for (const name of ['config.json', '.env', 'cache.json']) {
        assert.equal(fs.existsSync(name), false, name);
        fs.writeFileSync(name, 'TEMPORARY_TEST_STATE');
      }
    });
  `);
  for (const name of ["config.json", ".env", "cache.json"]) fs.writeFileSync(path.join(root, name), "PRESERVE_FIXTURE_STATE");
  const result = invoke(root, { ...process.env, EXAMPLE_TOKEN: "synthetic-token", TELEGRAM_BOT_TOKEN: "synthetic-token",
    HTTP_PROXY: "http://example.invalid", XFEEDER_DASHBOARD_PUBLIC_ORIGIN: "invalid-fixture-origin",
    GIT_DIR: root, GIT_WORK_TREE: root, GIT_INDEX_FILE: path.join(root, "caller-index") });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ["config.json", ".env", "cache.json"]) assert.equal(fs.readFileSync(path.join(root, name), "utf8"), "PRESERVE_FIXTURE_STATE");
});

test("harness blocks external HTTP, HTTPS, fetch, TLS and raw TCP before connecting", async () => {
  assert.ok(process.env.XFEEDER_TEST_ROOT, "Run with npm test so the network guard is preloaded");
  const blocked = { code: "XFEEDER_TEST_NETWORK_BLOCKED" };
  assert.throws(() => require("node:net").connect(80, "example.invalid"), blocked);
  assert.throws(() => require("node:tls").connect({ host: "example.invalid", port: 443 }), blocked);
  assert.throws(() => require("node:http").get("http://example.invalid"), blocked);
  assert.throws(() => require("node:https").get("https://example.invalid"), blocked);
  await assert.rejects(fetch("http://example.invalid"), error => error.cause?.code === blocked.code);
});

test("local server helper records requests and closes sockets after cleanup", async t => {
  let server;
  await t.test("loopback fixture", async child => {
    const local = await serve(child, (_req, res) => res.end("local fixture"));
    server = local.server;
    assert.equal(await (await fetch(local.url + "/feed")).text(), "local fixture");
    assert.equal(local.requests[0].url, "/feed");
    assert.equal(server.address().address, "127.0.0.1");
  });
  assert.equal(server.listening, false);
});

test("temporary directory helper separates fixture data and cleans up", async t => {
  let first, second;
  await t.test("temporary files", child => {
    first = tempDir(child); second = tempDir(child);
    assert.notEqual(first, second);
    fs.writeFileSync(path.join(first, "cache.json"), "FIRST");
    assert.equal(fs.existsSync(path.join(second, "cache.json")), false);
  });
  assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(second), false);
});

test("coverage report contains source paths that resolve from the project directory", t => {
  const root = fixture(t, `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    test('covered source', () => assert.equal(require('../src/answer.js')(true), 42));
  `);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "answer.js"), "module.exports = enabled => enabled ? 42 : 0;\n");
  const result = invoke(root, process.env, ["--coverage"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = fs.readFileSync(path.join(root, "coverage", "lcov.info"), "utf8");
  const sources = [...report.matchAll(/^SF:(.+)$/gm)].map(match => match[1].trim());
  assert.ok(sources.some(source => source.replace(/\\/g, "/").endsWith("src/answer.js")));
  for (const source of sources) assert.ok(fs.existsSync(path.resolve(root, source)), source);
});
