"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestDashboard } = require('./helpers/dashboard.cjs');

for (const password of ['', 'synthetic-password']) {
  test(`C3-03: DNS rebinding and hostile origins are rejected (${password ? 'password' : 'local'})`, async t => {
    const f = await startTestDashboard(t, { password });
    for (const headers of [
      { Host: 'attacker.example', Origin: 'http://attacker.example' },
      { Host: 'attacker.example' },
      { Host: '127.0.0.1:1' },
      { Origin: 'https://attacker.example' },
      { Host: 'attacker.example', 'X-Forwarded-Host': new URL(f.base).host },
    ]) {
      const response = await f.request('/api/state', { headers });
      assert.equal(response.status, 403);
      assert.equal(response.data.config, undefined);
    }
    const port = new URL(f.base).port;
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const response = await f.request('/api/health', { headers: { Host: `${host}:${port}`, Origin: `http://${host}:${port}` } });
      assert.equal(response.status, 200);
    }
    assert.equal((await f.request('/api/login', { method: 'POST', json: { password } })).status, 403);
  });
}

test('C3-03: authenticated state and env writes never echo env secrets; POSIX permissions stay private', async t => {
  const f = await startTestDashboard(t, { config: { channels: [], note: '${ABSENT_SECRET}' }, envContent: 'PRIVATE_TOKEN=never-return-this-value\nEMPTY=\n' });
  const login = await f.login();
  const headers = { Cookie: login.headers['set-cookie'][0].split(';')[0], Origin: f.origin };
  const state = await f.request('/api/state', { headers });
  assert.deepEqual(state.data.envStatus, { PRIVATE_TOKEN: 'configured', EMPTY: 'missing', ABSENT_SECRET: 'missing' });
  assert.equal(state.data.envFile, undefined);
  assert.ok(!state.text.includes('never-return-this-value'));
  for (const existingMode of [0o644, 0o600]) {
    fs.chmodSync(path.join(f.dir, '.env'), existingMode);
    const saved = await f.request('/api/env', { method: 'PUT', headers, json: { content: 'PRIVATE_TOKEN=replacement-value' } });
    assert.equal(saved.status, 200);
    assert.ok(!saved.text.includes('replacement-value'));
    assert.equal(saved.data.envStatus.PRIVATE_TOKEN, 'configured');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.dir, '.env')).mode & 0o777, 0o600);
  }
});

test('C3-03: login attempt limit is bounded, includes malformed bodies, ignores forwarded identity and expires', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await startTestDashboard(t);
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await f.request('/api/login', { method: 'POST', headers: { Origin: f.origin, 'X-Forwarded-For': `192.0.2.${attempt}` }, body: attempt === 0 ? '{' : JSON.stringify({ password: 'wrong' }) });
    assert.equal(response.status, attempt === 0 ? 400 : 401);
  }
  const blocked = await f.login();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '60');
  assert.equal(blocked.headers['set-cookie'], undefined);
  assert.equal((await f.request('/api/health')).status, 200);
  now += 60001;
  assert.equal((await f.login()).status, 200);
});


test('X3-11: external reverse proxy cannot enable passwordless mode on a loopback backend', async t => {
  const { startDashboard } = require('../src/dashboard/server');
  const fixture = await startTestDashboard(t, { password: '' });
  const previous = process.env.XFEEDER_DASHBOARD_PASSWORD;
  try {
    delete process.env.XFEEDER_DASHBOARD_PASSWORD;
    for (const publicOrigin of [
      'https://feeds.example.invalid',
      'http://feeds.example.invalid:3000',
      'https://192.0.2.20:8443',
    ]) {
      assert.throws(
        () => startDashboard({ host: '127.0.0.1', port: 0, dataDir: fixture.dir, publicOrigin }),
        /public origin is non-loopback.*XFEEDER_DASHBOARD_PASSWORD/,
        publicOrigin,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.XFEEDER_DASHBOARD_PASSWORD;
    else process.env.XFEEDER_DASHBOARD_PASSWORD = previous;
  }
});

test('X3-11: loopback public origin keeps passwordless local-only mode', async t => {
  const dashboard = await startTestDashboard(t, {
    password: '',
    publicOrigin: 'https://localhost:3443',
  });
  const health = await dashboard.request('/api/health', {
    headers: { Host: 'localhost:3443', Origin: dashboard.origin },
  });
  assert.equal(health.status, 200);
  const state = await dashboard.request('/api/state', {
    headers: { Host: 'localhost:3443', Origin: dashboard.origin },
  });
  assert.equal(state.status, 200);
  assert.equal(state.data.auth.mode, 'local-open');
});
