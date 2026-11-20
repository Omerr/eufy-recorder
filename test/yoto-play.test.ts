import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { connectAsync } from 'mqtt';
import { yotoPlay } from '../src/actions.ts';

for (const state of ['playing', 'stopped', 'unknown']) {
  test(`Yoto handles ${state} playback without delayed or duplicate commands`, async () => {
    const commands: string[] = []; let closed = false;
    const client = Object.assign(new EventEmitter(), {
      subscribeAsync: async () => [], endAsync: async () => { closed = true; },
      publish: (topic: string, payload: string, _options: unknown, callback?: (error?: Error) => void) => {
        commands.push(topic);
        queueMicrotask(() => {
          callback?.();
          if (topic.endsWith('/events/request')) client.emit('message', 'device/example-player/data/events', Buffer.from(JSON.stringify({ playbackStatus: state })));
          if (topic.endsWith('/volume/set')) client.emit('message', 'device/example-player/response', Buffer.from(JSON.stringify({ status: { volume: 'OK', req_body: payload } })));
          if (topic.endsWith('/card/start')) client.emit('message', 'device/example-player/response', Buffer.from(JSON.stringify({ status: { card: 'OK', req_body: payload } })));
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
