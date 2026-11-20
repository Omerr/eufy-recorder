import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  HotboxClient, HouseholdTracker, RouterPresence, parseRouterClients, validateHousehold,
  type HouseholdConfig, type RouterClient,
} from '../src/router.ts';

const mac = (suffix: string) => '02:' + '00:'.repeat(4) + suffix;
const client = (suffix: string): RouterClient => ({ mac: mac(suffix), associated: true, authorized: true, band: '5 GHz' });
const settings = (): HouseholdConfig => ({ enabled: true, pollSeconds: 60, awayGraceSeconds: 180, people: [
  { id: 'one', name: 'Person 1', macs: [mac('01')] }, { id: 'two', name: 'Person 2', macs: [mac('02')] },
] });

test('router snapshots require both Wi-Fi bands and valid association flags', () => {
  assert.throws(() => parseRouterClients({ data2_4: [] }), /both Wi-Fi bands/);
  assert.throws(() => parseRouterClients({ data2_4: [{ mac: mac('01'), associated: 'unknown', authorized: 1 }], data5: [] }), /flags/);
  const rows = parseRouterClients({ data2_4: [], data5: [{ mac: mac('01').toUpperCase(), associated: '1', authorized: '1' }] });
  assert.equal(rows[0].associated, true); assert.equal(rows[0].mac, mac('01'));
});

test('either household phone means home, while all-away requires consecutive absence', () => {
  const tracker = new HouseholdTracker(), config = settings();
  assert.equal(tracker.observe([client('01')], config, 0).state, 'home');
  assert.equal(tracker.observe([], config, 1000).state, 'unknown');
  assert.equal(tracker.observe([], config, 180_999).state, 'unknown');
  assert.equal(tracker.observe([], config, 181_000).state, 'away');
  assert.equal(tracker.observe([client('02')], config, 182_000).state, 'home');
  assert.equal(tracker.observe([], config, 183_000).state, 'unknown');
});

test('unregistered household members and router failures cannot produce an away state', () => {
  const tracker = new HouseholdTracker(), config = settings(); config.people[1].macs = [];
  assert.equal(tracker.observe([client('01')], config, 0).state, 'home');
  assert.equal(tracker.observe([], config, 1_000_000).state, 'unknown');
  config.people[1].macs = [mac('02')];
  tracker.observe([], config, 2_000_000);
  assert.equal(tracker.observe([], config, 2_180_000).state, 'away');
  assert.equal(tracker.unavailable(config, 2_181_000).state, 'unknown');
  assert.equal(tracker.observe([], config, 2_182_000).state, 'unknown');
});

test('changing phone identities restarts the away grace period', () => {
  const tracker = new HouseholdTracker(), config = settings();
  tracker.observe([], config, 0);
  assert.equal(tracker.observe([], config, 180_000).state, 'away');
  config.people[1].macs = [mac('03')];
  assert.equal(tracker.observe([], config, 181_000).state, 'unknown');
});

test('household configuration rejects shared phone identities and excessive polling', () => {
  const config = settings(); config.people[1].macs = config.people[0].macs;
  assert.throws(() => validateHousehold(config), /cannot share/);
  config.people[1].macs = [mac('02')]; config.pollSeconds = 1;
  assert.throws(() => validateHousehold(config), /settings/);
});

test('router login uses the firmware challenge, session cookie, and CSRF header', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eufy-router-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let logins = 0;
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const hmac = (value: string) => createHmac('sha256', 'example-nonce').update(sha(value)).digest('hex');
  const fetcher: typeof fetch = async (url, options) => {
    const route = new URL(String(url)).pathname;
    const headers = new Headers(options?.headers);
    if (route === '/') return new Response('login', { status: 401 });
    if (route === '/uxfwk.session.loader.js') return new Response("nonce: 'example-nonce'");
    if (route === '/index.html') {
      logins++;
      assert.equal(headers.get('Authorization'), 'Digest ' + sha(hmac('example-user') + hmac('example-password')));
      return new Response('authenticated app', { headers: [['Set-Cookie', 'SESSIONID=example-session; HttpOnly'], ['Set-Cookie', 'XSRF-TOKEN=example-csrf']] });
    }
    assert.match(headers.get('Cookie') || '', /SESSIONID=example-session/);
    assert.equal(headers.get('X-XSRF-TOKEN'), 'example-csrf');
    if (route.includes('devicesWifi')) return new Response(JSON.stringify({ devices: [{ mac: mac('01'), name: 'Example phone' }, { mac: mac('02'), name: 'Cached device' }] }));
    return new Response(JSON.stringify({ data2_4: [], data5: [{ mac: mac('01'), associated: '1', authorized: '1' }] }));
  };
  const router = new HotboxClient({ address: 'http://router.example', username: 'example-user', password: 'example-password', sessionFile: path.join(directory, 'session.json'), fetch: fetcher });
  const first = await router.clients();
  assert.equal(first.length, 1); assert.equal(first[0].name, 'Example phone');
  await router.clients(); assert.equal(logins, 1);
});

test('bad router credentials are not repeatedly retried', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eufy-router-auth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let logins = 0;
  const fetcher: typeof fetch = async (url) => {
    const route = new URL(String(url)).pathname;
    if (route === '/uxfwk.session.loader.js') return new Response("nonce: 'example-nonce'");
    if (route === '/index.html') logins++;
    return new Response('login', { status: 401 });
  };
  const router = new HotboxClient({ address: 'http://router.example', username: 'example', password: 'example', sessionFile: path.join(directory, 'session.json'), fetch: fetcher });
  await assert.rejects(router.clients(), /rejected/);
  await assert.rejects(router.clients(), /paused/);
  assert.equal(logins, 1);
});

test('router monitoring publishes unknown on read failure', async () => {
  const abort = new AbortController(); let fail = false;
  const states: string[] = [];
  const router = new RouterPresence({ client: { clients: async () => { if (fail) throw new Error('offline'); return [client('01')]; } }, settings,
    publish: (state) => states.push(state), signal: abort.signal, log: () => {} });
  await router.refresh(); assert.equal(states.at(-1), 'home');
  fail = true; await router.refresh(); assert.equal(states.at(-1), 'unknown');
  abort.abort(); await router.stop();
});
