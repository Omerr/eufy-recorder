import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { connectAsync } from 'mqtt';
import { yotoPlay } from '../src/actions.ts';

test('manual sleep playback replaces other audio while leaving volume untouched', async () => {
  const commands: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    subscribeAsync: async () => [], endAsync: async () => {},
    publish: (topic: string, payload: string, _options: unknown, callback?: (error?: Error) => void) => {
      commands.push(topic); callback?.();
      queueMicrotask(() => {
        if (topic.endsWith('/events/request')) client.emit('message', 'device/example-player/data/events', Buffer.from('{"playbackStatus":"playing"}'));
        if (topic.endsWith('/card/start')) client.emit('message', 'device/example-player/response', Buffer.from(JSON.stringify({ status: { 'card-play': 'OK', req_body: payload } })));
      });
    },
  });
  const connector = (async () => client) as unknown as typeof connectAsync;
  const result = await yotoPlay({ type: 'yoto', deviceId: 'example-player', tokenEnv: 'EXAMPLE_TOKEN', cardUri: 'https://yoto.io/example-sleep', skipIfPlaying: false }, 'example-token', AbortSignal.timeout(1000), connector);
  assert.match(result, /acknowledged/);
  assert.deepEqual(commands, ['device/example-player/command/events/request', 'device/example-player/command/card/start']);
});

for (const firmware of [false, true]) for (const state of ['playing', 'stopped', 'unknown']) {
  test(`Yoto handles ${state} playback with ${firmware ? "firmware" : "documented"} acknowledgements`, async () => {
    const commands: string[] = []; let closed = false;
    const client = Object.assign(new EventEmitter(), {
      subscribeAsync: async () => [], endAsync: async () => { closed = true; },
      publish: (topic: string, payload: string, _options: unknown, callback?: (error?: Error) => void) => {
        commands.push(topic);
        queueMicrotask(() => {
          callback?.();
          if (topic.endsWith('/events/request')) client.emit('message', 'device/example-player/data/events', Buffer.from(JSON.stringify({ playbackStatus: state })));
          if (topic.endsWith('/volume/set')) client.emit('message', 'device/example-player/response', Buffer.from(JSON.stringify({ status: { [firmware ? 'set-volume' : 'volume']: 'OK', req_body: payload } })));
          if (topic.endsWith('/card/start')) client.emit('message', 'device/example-player/response', Buffer.from(JSON.stringify({ status: { [firmware ? 'card-play' : 'card']: 'OK', req_body: payload } })));
        });
      },
    });
    const connector = (async () => client) as unknown as typeof connectAsync;
    const promise = yotoPlay({ type: 'yoto', deviceId: 'example-player', tokenEnv: 'EXAMPLE_TOKEN', cardUri: 'https://yoto.io/example-card', volume: 20 }, 'example-token', new AbortController().signal, connector);
    if (state === 'unknown') {
      await assert.rejects(promise, /unknown/);
    } else {
      const result = await promise;
      assert.match(result, state === 'playing' ? /preserved/ : /acknowledged/);
    }
    assert.equal(commands.length, state === 'stopped' ? 3 : 1);
    assert.ok(closed);
  });
}

for (const state of ['playing', 'paused', 'stopped']) {
  test(`Yoto readiness reads ${state} status without changing volume or playback`, async () => {
    const commands: string[] = []; let closed = false;
    const client = Object.assign(new EventEmitter(), {
      subscribeAsync: async () => [], endAsync: async () => { closed = true; },
      publish: (topic: string, _payload: string, _options: unknown, callback?: (error?: Error) => void) => {
        commands.push(topic); callback?.();
        queueMicrotask(() => client.emit('message', 'device/example-player/data/events', Buffer.from(JSON.stringify({ playbackStatus: state }))));
      },
    });
    const connector = (async () => client) as unknown as typeof connectAsync;
    const result = await yotoPlay({ type: 'yoto', deviceId: 'example-player', tokenEnv: 'EXAMPLE_TOKEN', cardUri: 'https://yoto.io/example-card', volume: 20, skipIfPlaying: false }, 'example-token', AbortSignal.timeout(1000), connector, true);
    assert.match(result, /reachable/);
    assert.deepEqual(commands, ['device/example-player/command/events/request']);
    assert.ok(closed);
  });
}

test('Yoto retained status cannot pass readiness without a live reply', async () => {
  let closed = false;
  const client = Object.assign(new EventEmitter(), {
    subscribeAsync: async () => [], endAsync: async () => { closed = true; },
    publish: (_topic: string, _payload: string, _options: unknown, callback?: (error?: Error) => void) => {
      callback?.();
      queueMicrotask(() => client.emit('message', 'device/example-player/data/events', Buffer.from('{"playbackStatus":"stopped"}'), { retain: true }));
    },
  });
  const connector = (async () => client) as unknown as typeof connectAsync;
  await assert.rejects(yotoPlay({ type: 'yoto', deviceId: 'example-player', tokenEnv: 'EXAMPLE_TOKEN', cardUri: 'https://yoto.io/example-card' }, 'example-token', AbortSignal.timeout(30), connector, true), /cancelled/);
  assert.ok(closed);
});

test('Yoto ignores an unrelated acknowledgement and surfaces a matching firmware rejection', async () => {
  const commands: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    subscribeAsync: async () => [], endAsync: async () => {},
    publish: (topic: string, payload: string, _options: unknown, callback?: (error?: Error) => void) => {
      commands.push(topic); callback?.();
      queueMicrotask(() => {
        if (topic.endsWith('/events/request')) client.emit('message', 'device/example-player/data/events', Buffer.from('{"playbackStatus":"stopped"}'));
        if (topic.endsWith('/volume/set')) {
          client.emit('message', 'device/example-player/response', Buffer.from(JSON.stringify({ status: { 'set-volume': 'OK', req_body: '{"volume":99}' } })));
          client.emit('message', 'device/example-player/response', Buffer.from(JSON.stringify({ status: { 'set-volume': 'FAIL', req_body: payload } })));
        }
      });
    },
  });
  const connector = (async () => client) as unknown as typeof connectAsync;
  await assert.rejects(yotoPlay({ type: 'yoto', deviceId: 'example-player', tokenEnv: 'EXAMPLE_TOKEN', cardUri: 'https://yoto.io/example-card', volume: 20 }, 'example-token', AbortSignal.timeout(1000), connector), /rejected/);
  assert.ok(!commands.some(topic => topic.endsWith('/card/start')));
});
