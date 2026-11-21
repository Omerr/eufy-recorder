import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationEngine, Presence, automationConfig, type AutomationConfig, type Detection } from '../src/automation.ts';

function settings(): AutomationConfig {
  return automationConfig({
    enabled: true, timeZone: 'UTC', devices: { lamp: { type: 'yeelight', host: 'light.local' }, voice: { type: 'eufy-audio', camera: 'example-camera', file: 'audio/test.aac' } },
    rules: [{ id: 'evening', enabled: true, cameras: ['example-camera'], events: ['personDetected', 'strangerDetected'], after: '17:00', presence: 'away', cooldownSeconds: 120, actions: [{ device: 'lamp' }, { device: 'voice' }] }],
  });
}
const detection = (time = '2026-11-20T18:00:00Z'): Detection => ({ kind: 'personDetected', camera: 'example-camera', at: new Date(time) });

test('manual everyone-away respects rule switches and the configured time window', () => {
  const config = settings(); config.household.mode = 'events';
  const presence = new Presence();
  const engine = new AutomationEngine({ settings: config, presence, signal: new AbortController().signal, execute: async () => 'ok', log: () => {} });
  const now = Date.now(); presence.setManual('away', now);
  assert.equal(engine.preview(detection('2026-11-20T16:59:00Z'), now)[0].matches, false);
  assert.equal(engine.preview(detection(), now)[0].matches, true);
  config.rules[0].enabled = false; engine.configure(config);
  assert.equal(presence.manualStatus().mode, 'away');
  assert.equal(engine.preview(detection(), now)[0].matches, false);
});

test('individual household reports gate actions and a Maps arrival cancels later actions', async () => {
  const config = settings(); config.household.mode = 'hybrid';
  const presence = new Presence(); let now = 1000;
  const calls: string[] = [];
  let started!: () => void;
  const firstAction = new Promise<void>((resolve) => { started = resolve; });
  const engine = new AutomationEngine({ settings: config, presence, signal: new AbortController().signal, now: () => now, log: () => {},
    execute: async (name, device, signal) => {
      calls.push(name); started();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return 'cancelled';
    },
  });
  presence.report('person-1', 'away', 'geofence', now);
  engine.handle(detection()); await engine.flush();
  assert.deepEqual(calls, []);
  presence.report('person-2', 'away', 'maps-notification', now);
  now += 180_000;
  engine.handle(detection()); await firstAction;
  presence.report('person-2', 'home', 'maps-notification', now);
  engine.presenceChanged(); await engine.flush();
  assert.deepEqual(calls, ['lamp']);
});

test('evening rules require fresh away presence and the configured camera', () => {
  const presence = new Presence();
  const engine = new AutomationEngine({ settings: settings(), presence, execute: async () => 'ok', log: () => {}, signal: new AbortController().signal });
  const now = Date.now();
  assert.equal(engine.preview(detection(), now)[0].matches, false);
  presence.update('home', now);
  assert.equal(engine.preview(detection(), now)[0].matches, false);
  presence.update('away', now);
  assert.equal(engine.preview(detection(), now)[0].matches, true);
  assert.equal(engine.preview(detection('2026-11-20T16:59:00Z'), now)[0].matches, false);
  assert.equal(engine.preview(detection('2026-11-20T17:00:00Z'), now)[0].matches, true);
  assert.equal(engine.preview({ ...detection(), camera: 'different-camera' }, now)[0].matches, false);
  assert.equal(engine.preview(detection(), now + 15 * 60_000 + 1)[0].matches, false);
});

test('time windows use the selected time zone including daylight saving and overnight windows', () => {
  const config = settings(); config.timeZone = 'Europe/London'; config.rules[0].presence = 'any';
  const engine = new AutomationEngine({ settings: config, presence: new Presence(), execute: async () => 'ok', log: () => {}, signal: new AbortController().signal });
  assert.equal(engine.preview(detection('2026-07-20T16:30:00Z'))[0].matches, true);
  assert.equal(engine.preview(detection('2026-01-20T16:30:00Z'))[0].matches, false);
  config.rules[0].after = '22:00'; config.rules[0].before = '06:00'; engine.configure(config);
  assert.equal(engine.preview(detection('2026-01-20T23:30:00Z'))[0].matches, true);
  assert.equal(engine.preview(detection('2026-01-21T05:59:00Z'))[0].matches, true);
  assert.equal(engine.preview(detection('2026-01-21T06:00:00Z'))[0].matches, false);
});

test('duplicate person and stranger detections share one cooldown', async () => {
  const presence = new Presence(); let now = Date.now(); presence.update('away', now);
  const calls: string[] = [];
  const engine = new AutomationEngine({ settings: settings(), presence, execute: async (name) => { calls.push(name); return 'ok'; }, log: () => {}, signal: new AbortController().signal, now: () => now });
  engine.handle(detection());
  engine.handle({ ...detection(), kind: 'strangerDetected' });
  await engine.flush();
  assert.deepEqual(calls, ['lamp', 'voice']);
  engine.handle(detection()); await engine.flush();
  assert.equal(calls.length, 2);
  now += 121_000;
  engine.handle(detection()); await engine.flush();
  assert.equal(calls.length, 4);
});

test('returning home cancels the active action and prevents later actions', async () => {
  const presence = new Presence(); presence.update('away');
  const calls: string[] = []; let cancelled = false;
  const engine = new AutomationEngine({ settings: settings(), presence, log: () => {}, signal: new AbortController().signal,
    execute: (name, _device, signal) => {
      calls.push(name);
      return new Promise((resolve) => signal.addEventListener('abort', () => { cancelled = true; resolve('cancelled'); }, { once: true }));
    },
  });
  engine.handle(detection());
  presence.update('home'); engine.presenceChanged();
  await engine.flush();
  assert.ok(cancelled);
  assert.deepEqual(calls, ['lamp']);
});

test('preview can simulate away without changing actual presence or executing actions', () => {
  const presence = new Presence(); let executions = 0;
  const engine = new AutomationEngine({ settings: settings(), presence, execute: async () => { executions++; return 'ok'; }, log: () => {}, signal: new AbortController().signal });
  assert.equal(engine.preview(detection(), Date.now(), 'away')[0].matches, true);
  assert.equal(presence.snapshot(15).state, 'unknown');
  assert.equal(executions, 0);
});

test('unknown device names and invalid clocks are rejected', () => {
  const config = settings(); config.rules[0].after = '25:00';
  assert.throws(() => automationConfig(config), /Invalid automation rule/);
  config.rules[0].after = '17:00'; config.rules[0].actions = [{ device: 'missing' }];
  assert.throws(() => automationConfig(config), /Invalid automation rule/);
});

test('an armed speaker test plays once on the selected camera while normal away-only rules remain blocked', async () => {
  const presence = new Presence(); presence.update('home');
  const config = settings(); config.enabled = false;
  const calls: string[] = [];
  const engine = new AutomationEngine({ settings: config, presence, execute: async (name) => { calls.push(name); return 'audio sent'; }, log: () => {}, signal: new AbortController().signal });
  engine.armSpeakerTest('voice');
  engine.handle({ ...detection(), camera: 'another-camera' });
  engine.handle({ ...detection(), kind: 'motion' });
  assert.equal(calls.length, 0);
  engine.handle(detection()); engine.handle({ ...detection(), kind: 'strangerDetected' });
  await engine.flush();
  assert.deepEqual(calls, ['voice']);
  assert.equal(engine.speakerTestStatus()?.state, 'sent');
  assert.equal(engine.config().enabled, false);
  assert.equal(presence.snapshot(15).state, 'home');
});

test('speaker tests expire and can be cancelled without changing rules', async () => {
  let now = Date.now();
  const calls: string[] = [];
  const engine = new AutomationEngine({ settings: settings(), presence: new Presence(), execute: async (name) => { calls.push(name); return 'ok'; }, log: () => {}, signal: new AbortController().signal, now: () => now });
  engine.armSpeakerTest('voice', 15); now += 15_000;
  engine.handle(detection()); await engine.flush();
  assert.equal(calls.length, 0); assert.equal(engine.speakerTestStatus()?.state, 'expired');
  engine.armSpeakerTest('voice'); engine.cancelSpeakerTest();
  engine.handle(detection()); await engine.flush();
  assert.equal(calls.length, 0); assert.equal(engine.speakerTestStatus()?.state, 'cancelled');
  assert.throws(() => engine.armSpeakerTest('lamp'), /camera audio/);
});
