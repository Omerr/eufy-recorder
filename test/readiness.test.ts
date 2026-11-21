import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationConfig, Presence } from '../src/automation.ts';
import { checkReadiness } from '../src/readiness.ts';

test('reachable devices do not hide paused rules or unknown presence', async () => {
  const config = automationConfig({ devices: {
    light: { type: 'yeelight', host: 'lamp.example' },
    music: { type: 'yoto', deviceId: 'example-player', tokenEnv: 'EXAMPLE_TOKEN', cardUri: 'https://yoto.io/example' },
  } });
  const report = await checkReadiness(config, new Presence(), async () => 'reachable; standby', AbortSignal.timeout(1000));
  assert.equal(report.devicesReachable, true);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(c => c.name === 'Household presence')?.status, 'attention');
  assert.equal(report.checks.find(c => c.name === 'Automatic responses')?.status, 'attention');
});

test('one failed device does not discard the other check; failures omit private errors', async () => {
  const config = automationConfig({ devices: {
    light: { type: 'yeelight', host: 'private-address' },
    music: { type: 'yoto', deviceId: 'example-player', tokenEnv: 'EXAMPLE_TOKEN', cardUri: 'https://yoto.io/example' },
  } });
  const report = await checkReadiness(config, new Presence(), async device => {
    if (device.type === 'yeelight') throw new Error('private-address');
    return 'reachable; stopped';
  }, AbortSignal.timeout(1000));
  assert.equal(report.devicesReachable, false);
  assert.equal(report.checks.find(c => c.name === 'light')?.status, 'failed');
  assert.equal(report.checks.find(c => c.name === 'music')?.status, 'ok');
  assert.ok(!JSON.stringify(report).includes('private-address'));
});

test('fresh home presence and enabled response rules can pass the pre-departure check', async () => {
  const config = automationConfig({ enabled: true, devices: { light: { type: 'yeelight', host: 'lamp.example' } },
    rules: [{ id: 'light', enabled: true, cameras: ['example-camera'], events: ['personDetected'], presence: 'away', cooldownSeconds: 120, actions: [{ device: 'light' }] }],
  });
  const presence = new Presence(); presence.update('home');
  const report = await checkReadiness(config, presence, async () => 'reachable; light off (standby)', AbortSignal.timeout(1000));
  assert.equal(report.ready, true);
});
