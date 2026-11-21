import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Presence } from '../src/presence.ts';
import type { HouseholdConfig, HouseholdSnapshot } from '../src/router.ts';

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
