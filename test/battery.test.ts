import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BatteryMonitor, batteryPercent, defaultBattery, validateBattery } from '../src/battery.ts';
import type { Notification } from '../src/ntfy.ts';

const hour = 3_600_000;

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eufy-battery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notifications: Notification[] = [];
  const filename = path.join(directory, 'battery-status.json');
  const create = (notify = async (notification: Notification) => { notifications.push(notification); }) => new BatteryMonitor({
    settings: defaultBattery, filename, notify, log: () => {},
  });
  return { notifications, filename, create };
}

test('battery warnings repeat daily, escalate immediately, and reset after charging', async (t) => {
  const { create, notifications } = await harness(t);
  const monitor = create();
  await monitor.load();
  await monitor.observe('front', 'Front door', 31, false, 0);
  assert.equal(notifications.length, 0);
  await monitor.observe('front', 'Front door', 30, false, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].priority, 4);
  await monitor.observe('front', 'Front door', 29, false, hour);
  await monitor.observe('front', 'Front door', 32, true, 2 * hour);
  await monitor.observe('front', 'Front door', 29, false, 3 * hour);
  assert.equal(notifications.length, 1, 'small fluctuations must not cause duplicate alerts');
  await monitor.observe('front', 'Front door', 10, false, 4 * hour);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].priority, 5);
  await monitor.tick(27 * hour);
  assert.equal(notifications.length, 2);
  await monitor.tick(28 * hour);
  assert.equal(notifications.length, 3);
  await monitor.observe('front', 'Front door', 35, true, 29 * hour);
  await monitor.observe('front', 'Front door', 30, false, 30 * hour);
  assert.equal(notifications.length, 4, 'a new low-battery episode must alert immediately');
});

test('successful delivery history survives restart and removed cameras stay silent', async (t) => {
  const { create, notifications } = await harness(t);
  const first = create();
  await first.load();
  await first.observe('front', 'Front door', 25, false, 0);
  await first.observe('removed', 'Old camera', 20, false, 0);
  assert.equal(notifications.length, 2);
  const restarted = create();
  await restarted.load();
  await restarted.observe('front', 'Front door', 24, false, hour);
  assert.equal(notifications.length, 2);
  await restarted.tick(24 * hour);
  assert.equal(notifications.length, 3);
  assert.match(notifications[2].title, /Front door/);
});

test('failed delivery is retried without suppressing a later critical warning', async (t) => {
  const { create } = await harness(t);
  let attempts = 0;
  const monitor = create(async () => { attempts++; throw new Error('ntfy offline'); });
  await monitor.load();
  await monitor.observe('front', 'Front door', 20, false, 0);
  await monitor.tick(60_000);
  assert.equal(attempts, 1);
  await monitor.tick(300_000);
  assert.equal(attempts, 2);
  await monitor.observe('front', 'Front door', 10, false, 301_000);
  assert.equal(attempts, 3, 'critical severity bypasses the lower-severity retry delay');
  await monitor.tick(302_000);
  assert.equal(attempts, 3);
});

test('parallel battery events produce one warning per camera', async (t) => {
  const { create, notifications } = await harness(t);
  const monitor = create();
  await monitor.load();
  await Promise.all([
    monitor.observe('front', 'Front door', 29, false, 0),
    monitor.observe('front', 'Front door', 28, false, 0),
    monitor.reportedLow('front', 'Front door', 0),
    monitor.observe('back', 'Back door', 25, false, 0),
  ]);
  assert.equal(notifications.length, 2);
});

test('unknown readings stay unknown; explicit eufy low-battery events can still warn', async (t) => {
  const { create, notifications } = await harness(t);
  const monitor = create();
  await monitor.load();
  await monitor.observe('front', 'Front door', undefined, undefined, 0);
  await monitor.observe('front', 'Front door', null, false, 1);
  assert.equal(notifications.length, 0);
  await monitor.reportedLow('front', 'Front door', 2);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /percentage unavailable/);
  assert.doesNotMatch(notifications[0].message, /0%/);
});

test('a stale cached high percentage cannot erase a newer low-battery event', async (t) => {
  const { create, notifications } = await harness(t);
  const monitor = create();
  await monitor.load();
  await monitor.reportedLow('front', 'Front door', 1000);
  await monitor.observe('front', 'Front door', 90, false, 2000, 500);
  await monitor.tick(24 * hour + 1000);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1].message, /percentage unavailable/);
});

test('zero is a critical reading and malformed values are unknown', () => {
  assert.equal(batteryPercent(0), 0);
  assert.equal(batteryPercent('30'), 30);
  for (const value of [undefined, null, '', ' ', '30%', NaN, Infinity, -1, 101, false]) {
    assert.equal(batteryPercent(value), null);
  }
});

test('rejects invalid threshold order and check intervals', () => {
  assert.throws(() => validateBattery({ ...defaultBattery, criticalPercent: 40 }), /thresholds/);
  assert.throws(() => validateBattery({ ...defaultBattery, recoverPercent: 30 }), /thresholds/);
  assert.throws(() => validateBattery({ ...defaultBattery, checkIntervalMinutes: 0 }), /checkIntervalMinutes/);
});
