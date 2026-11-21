import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Presence } from '../src/presence.ts';
import type { HouseholdConfig, HouseholdSnapshot } from '../src/router.ts';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function settings(): HouseholdConfig {
  return { enabled: true, mode: 'hybrid', pollSeconds: 60, awayGraceSeconds: 180,
    people: [{ id: 'one', name: 'Person 1', macs: [] }, { id: 'two', name: 'Person 2', macs: [] }] };
}
function router(now: number, home: string[] = []): HouseholdSnapshot {
  return { state: home.length ? 'home' : 'away', reason: 'Test observation', checkedAt: now, clients: [],
    people: settings().people.map(({ id, name }) => ({ id, name, state: home.includes(id) ? 'home' : 'away' })) };
}
function presence(): Presence { const p = new Presence(); p.configure(settings(), 15); return p; }

test('individual reports require every person to be freshly away through the grace period', () => {
  const p = presence();
  p.observeRouter(router(1000), 1000);
  assert.equal(p.snapshot(15, 1000).state, 'unknown');
  p.report('one', 'away', 'geofence', 1000);
  assert.equal(p.snapshot(15, 200_000).state, 'unknown');
  p.report('two', 'away', 'maps-notification', 200_000);
  assert.equal(p.snapshot(15, 379_999).state, 'unknown');
  assert.equal(p.snapshot(15, 380_000).state, 'away');
  p.report('two', 'home', 'maps-notification', 381_000);
  assert.equal(p.snapshot(15, 381_000).state, 'home');
  p.report('two', 'away', 'maps-notification', 382_000);
  assert.equal(p.snapshot(15, 382_000).state, 'unknown');
});

test('a current Wi-Fi association overrides departure reports; absence cannot establish away', () => {
  const p = presence();
  p.report('one', 'away', 'geofence', 1000); p.report('two', 'away', 'maps-notification', 1000);
  assert.equal(p.snapshot(15, 181_000).state, 'away');
  p.observeRouter(router(182_000, ['two']), 182_000);
  assert.equal(p.snapshot(15, 182_000).state, 'home');
  assert.equal(p.details(15, 182_000)?.people[1].source, 'router');
  p.observeRouter(router(183_000), 183_000);
  assert.equal(p.snapshot(15, 183_000).state, 'unknown');
  assert.equal(p.snapshot(15, 363_000).state, 'away');
  const missing = presence();
  missing.observeRouter(router(1000), 1000);
  assert.equal(missing.snapshot(15, 500_000).state, 'unknown');
});

test('one phone heartbeat cannot renew another person or an old Maps notification', () => {
  const p = presence();
  p.report('one', 'away', 'geofence', 1000); p.report('two', 'away', 'maps-notification', 1000);
  assert.equal(p.snapshot(15, 181_000).state, 'away');
  p.report('one', 'away', 'geofence', 800_000);
  assert.equal(p.snapshot(15, 901_001).state, 'unknown');
  assert.equal(p.details(15, 901_001)?.people[1].state, 'unknown');
  // No intervening queries: the stale interval still breaks the all-away grace.
  p.report('two', 'away', 'maps-notification', 1_000_000);
  assert.equal(p.snapshot(15, 1_000_000).state, 'unknown');
  assert.equal(p.snapshot(15, 1_180_000).state, 'away');
});

test('router evidence expires and disabled monitoring contributes no home evidence', () => {
  const p = presence();
  p.observeRouter(router(1000, ['one']), 1000);
  assert.equal(p.snapshot(15, 1000).state, 'home');
  assert.equal(p.snapshot(15, 181_001).state, 'unknown');
  const disabled = settings(); disabled.enabled = false; p.configure(disabled, 15);
  p.observeRouter(router(200_000, ['one']), 200_000);
  assert.equal(p.snapshot(15, 200_000).state, 'unknown');
});

test('restart, changed configuration, invalid identity, and unknown reports cannot authorize away', () => {
  const p = presence();
  assert.throws(() => p.report('missing', 'away', 'geofence', 1000), /registered/);
  p.report('one', 'away', 'geofence', 1000); p.report('two', 'away', 'maps-notification', 1000);
  assert.equal(p.snapshot(15, 181_000).state, 'away');
  p.report('two', 'unknown', 'maps-notification', 182_000);
  assert.equal(p.snapshot(15, 182_000).state, 'unknown');
  const changed = settings(); changed.people[1].id = 'three'; p.configure(changed, 15);
  assert.equal(p.snapshot(15, 183_000).state, 'unknown');
  assert.equal(presence().snapshot(15, 183_000).state, 'unknown');
  p.update('away', 183_000);
  assert.equal(p.snapshot(15, 183_000).state, 'unknown');
});

test('event states survive long absences and restart, and an arrival ends manual everyone-away', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'presence-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'presence.json');
  const config = settings(); config.mode = 'events'; config.enabled = false;
  const first = new Presence(file); first.configure(config, 15); first.load();
  first.report('one', 'away', 'geofence', 1000);
  first.report('two', 'away', 'maps-notification', 1000);
  const later = 1000 + 24 * 60 * 60_000;
  assert.equal(first.snapshot(15, later).state, 'away');
  const second = new Presence(file); second.configure(config, 15); second.load();
  assert.equal(second.snapshot(15, later).state, 'away');
  second.setManual('away', later);
  const third = new Presence(file); third.configure(config, 15); third.load();
  assert.equal(third.manualStatus().mode, 'away');
  third.report('two', 'home', 'maps-notification', later + 1);
  assert.equal(third.snapshot(15, later + 1).state, 'home');
  assert.equal(third.manualStatus().mode, 'auto');
  const fourth = new Presence(file); fourth.configure(config, 15); fourth.load();
  assert.equal(fourth.manualStatus().mode, 'auto');
  assert.equal(fourth.snapshot(15, later + 2).state, 'home');
});

test('manual controls can arm unknown occupancy, hold home, and return to automatic grace', () => {
  const p = presence();
  p.setManual('away', 1000);
  assert.equal(p.snapshot(15, 1000).state, 'away');
  p.report('one', 'home', 'manual', 2000);
  assert.equal(p.manualStatus().mode, 'auto');
  assert.equal(p.snapshot(15, 2000).state, 'home');
  p.setManual('home', 3000);
  p.report('one', 'away', 'geofence', 4000); p.report('two', 'away', 'maps-notification', 4000);
  assert.equal(p.snapshot(15, 184_000).state, 'home');
  p.setManual('auto', 184_000);
  assert.equal(p.snapshot(15, 184_000).state, 'unknown');
  assert.equal(p.snapshot(15, 364_000).state, 'away');
});

test('unwritable storage keeps the prior state and corrupt saved data cannot arm responses', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'presence-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'presence.json');
  const config = settings(); config.mode = 'events';
  const p = new Presence(file); p.configure(config, 15); p.load();
  p.report('one', 'home', 'manual', 1000);
  await mkdir(file + '.tmp');
  assert.throws(() => p.setManual('away', 2000), /previous state was kept/);
  assert.equal(p.manualStatus().mode, 'auto');
  assert.equal(p.snapshot(15, 2000).state, 'home');
  await writeFile(file, '{invalid');
  const restored = new Presence(file); restored.configure(config, 15);
  assert.throws(() => restored.load(), /could not be loaded/);
  assert.equal(restored.snapshot(15, 2000).state, 'unknown');
});
