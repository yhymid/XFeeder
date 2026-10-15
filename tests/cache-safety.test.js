"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCacheStore } = require('../src/core/cache-store');
const { tempDir } = require('./helpers/temp-dir.cjs');
const { serve } = require('./fixtures/network.cjs');

for (const [label, bytes] of [
  ['truncated JSON', Buffer.from('{"delivered":["known-entry"')],
  ['malformed JSON', Buffer.from('{invalid}\xff', 'latin1')],
  ['wrong root', Buffer.from('null')],
]) {
  test(`C3-05: ${label} preserves original bytes, quarantines, and blocks restart`, t => {
    const dir = tempDir(t), file = path.join(dir, 'cache.json');
    fs.writeFileSync(file, bytes);
    for (let restart = 0; restart < 2; restart++) {
      assert.throws(() => createCacheStore(file), { code: 'CACHE_UNSAFE' });
      assert.deepEqual(fs.readFileSync(file), bytes);
    }
    const copies = fs.readdirSync(dir).filter(name => name.startsWith('cache.json.corrupt-'));
    assert.equal(copies.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, copies[0])), bytes);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, copies[0])).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    fs.unlinkSync(file);
    assert.throws(() => createCacheStore(file), { code: 'CACHE_UNSAFE' });
    assert.equal(fs.existsSync(file), false, 'deleting the corrupt original cannot silently reset delivery history');
  });
}

test('C3-05: valid cache roundtrip is unchanged; a caught reload failure cannot save empty state', t => {
  const file = path.join(tempDir(t), 'cache.json');
  const expected = { channel: { 'feed::webhook': ['already-delivered'] } };
  fs.writeFileSync(file, JSON.stringify(expected));
  const store = createCacheStore(file);
  assert.deepEqual(store.getState(), expected);
  store.save();
  assert.deepEqual(createCacheStore(file).getState(), expected);
  const corrupt = Buffer.from('{');
  fs.writeFileSync(file, corrupt);
  assert.throws(() => store.load(), { code: 'CACHE_UNSAFE' });
  for (const action of [() => store.save(), () => store.replaceState({}), () => store.getChannelBucket('channel')])
    assert.throws(action, { code: 'CACHE_UNSAFE' });
  assert.deepEqual(fs.readFileSync(file), corrupt);
  // An explicit restore, not deletion, unlocks the existing store.
  fs.writeFileSync(file, JSON.stringify(expected));
  assert.deepEqual(store.load(), expected);
  store.save();
  assert.deepEqual(createCacheStore(file).getState(), expected);
});

test('C3-05: unreadable cache path fails closed instead of becoming an empty cache', t => {
  const file = path.join(tempDir(t), 'cache.json');
  fs.mkdirSync(file);
  assert.throws(() => createCacheStore(file), { code: 'CACHE_UNSAFE' });
  assert.ok(fs.statSync(file).isDirectory());
});

test('C3-05: fresh installation with no cache or quarantine still starts empty', t => {
  const file = path.join(tempDir(t), 'cache.json');
  const store = createCacheStore(file);
  assert.deepEqual(store.getState(), {});
  store.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
});

test('C3-05: repeated CLI restarts with corrupted cache never fetch or deliver', { timeout: 15000 }, async t => {
  const dir = tempDir(t), file = path.join(dir, 'cache.json'), config = path.join(dir, 'config.json');
  const server = await serve(t, (_req, res) => res.end('unexpected request'));
  fs.writeFileSync(file, '{"history":');
  fs.writeFileSync(config, JSON.stringify({ Settings: { Logs: false }, Proxy: { Enabled: false }, Scrapling: { Enabled: false }, channels: [{ RSS: [server.url], Webhook: `${server.url}/webhook` }] }));
  for (let i = 0; i < 2; i++) {
    const result = await new Promise((resolve, reject) => {
      const entry = path.resolve(__dirname, '../main.js');
      const logger = path.resolve(__dirname, '../src/core/terminal-log.js');
      // Run the real CLI, disabling only its repository-wide terminal log hook.
      const script = `require.cache[require.resolve(${JSON.stringify(logger)})] = { exports: { installTerminalLog() {}, setTerminalLogEnabled() {} } }; process.argv = ${JSON.stringify([process.execPath, entry, '--once', '--config', config, '--cache', file])}; require(${JSON.stringify(entry)});`;
      const child = spawn(process.execPath, ['-e', script], { cwd: dir, timeout: 5000 });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /delivery is blocked to prevent duplicates/);
  }
  assert.equal(server.requests.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"history":');
});
