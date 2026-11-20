import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Presence, AutomationEngine, automationConfig } from '../src/automation.ts';
import { startAutomationApi } from '../src/automation-api.ts';

test('automation API authenticates updates, preserves private recorder settings, and simulates without acting', async (t) => {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const directory = await mkdtemp(path.join(tmpdir(), 'eufy-api-test-'));
  const configFile = path.join(directory, 'recorder.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(configFile, JSON.stringify({ cameras: ['private-camera'], ntfy: { topic: 'private-test-topic' } }));
  const config = automationConfig({
    enabled: true, api: { host: '127.0.0.1', port: address.port, tokenEnv: 'EXAMPLE_TOKEN' },
    devices: { lamp: { type: 'yeelight', host: 'light.local' }, voice: { type: 'eufy-audio', camera: 'private-camera', file: 'audio/test.aac' } },
    rules: [{ id: 'evening', enabled: true, cameras: ['private-camera'], events: ['personDetected'], after: '17:00', presence: 'away', cooldownSeconds: 120, actions: [{ device: 'lamp' }] }],
  });
  let executions = 0;
  const presence = new Presence();
  const abort = new AbortController();
  const engine = new AutomationEngine({ settings: config, presence, execute: async () => { executions++; return 'ok'; }, log: () => {}, signal: abort.signal });
  const token = 'local-test-'.repeat(5);
  const server = await startAutomationApi({ engine, presence, configFile, token, signal: abort.signal, log: () => {} });
  t.after(() => { abort.abort(); server.close(); });
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/config')).status, 401);
  assert.match(await (await fetch(base)).text(), /Eufy events/);
  assert.equal((await (await fetch(base + '/api/state', { headers })).json()).presence.state, 'unknown');
  const preview = await fetch(base + '/api/simulate', { method: 'POST', headers, body: JSON.stringify({ kind: 'personDetected', camera: 'private-camera', presence: 'away', at: '2026-11-20T18:00:00Z' }) });
  assert.equal((await preview.json()).decisions[0].matches, true);
  assert.equal(executions, 0);
  assert.equal(presence.snapshot(15).state, 'unknown');
  assert.equal((await fetch(base + '/api/test', { method: 'POST', body: '{"device":"lamp"}' })).status, 401);
  assert.equal(executions, 0);
  assert.equal((await fetch(base + '/api/test', { method: 'POST', headers, body: '{"device":"lamp"}' })).status, 200);
  assert.equal(executions, 1);
  assert.equal((await fetch(base + '/api/speaker-test', { method: 'POST', body: '{"device":"voice"}' })).status, 401);
  const armed = await fetch(base + '/api/speaker-test', { method: 'POST', headers, body: '{"device":"voice","expiresInSeconds":30}' });
  assert.equal(armed.status, 200);
  assert.equal((await armed.json()).state, 'armed');
  assert.equal(executions, 1);
  const cancelled = await fetch(base + '/api/speaker-test', { method: 'DELETE', headers });
  assert.equal(cancelled.status, 200);
  assert.equal(engine.speakerTestStatus()?.state, 'cancelled');
  assert.equal((await fetch(base + '/api/presence', { method: 'POST', headers, body: '{"state":"away"}' })).status, 200);
  assert.equal(presence.snapshot(15).state, 'away');
  config.rules[0].after = '18:00';
  assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify(config) })).status, 200);
  const saved = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(saved.ntfy.topic, 'private-test-topic');
  assert.deepEqual(saved.cameras, ['private-camera']);
  assert.equal(saved.automations.rules[0].after, '18:00');
  const invalid = await fetch(base + '/api/presence', { method: 'POST', headers, body: '{"state":"maybe"}' });
  assert.equal(invalid.status, 400);
  const householdConfig = structuredClone(config);
  householdConfig.household.enabled = true;
  assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify(householdConfig) })).status, 200);
  assert.equal(presence.snapshot(15).state, 'unknown');
  assert.equal((await fetch(base + '/api/presence', { method: 'POST', headers, body: '{"state":"away"}' })).status, 400);
  assert.equal(presence.snapshot(15).state, 'unknown');
});
