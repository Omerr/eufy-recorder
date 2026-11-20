import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Device } from '@mega-yfue/eufy-sdk';
import { yeelightOn, validateCameraAudio, cameraAudio } from '../src/actions.ts';

for (const power of ['on', 'off']) {
  test(`Yeelight ${power === 'on' ? 'leaves an already-on lamp unchanged' : 'turns on an off lamp without toggling'}`, async (t) => {
    const methods: { method: string; params: unknown[] }[] = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (bytes) => {
        buffer += bytes.toString();
        while (buffer.includes('\r\n')) {
          const index = buffer.indexOf('\r\n');
          const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 2);
          methods.push({ method: request.method, params: request.params });
          socket.write(JSON.stringify({ id: request.id, result: request.method === 'get_prop' ? [power] : ['ok'] }) + '\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const result = await yeelightOn('127.0.0.1', address.port);
    if (power === 'on') {
      assert.equal(result, 'already on'); assert.equal(methods.length, 1);
    } else {
      assert.equal(result, 'turned on');
      assert.deepEqual(methods[1], { method: 'set_power', params: ['on', 'smooth', 300] });
    }
  });
}

test('oversized camera audio frames fail before opening the speaker', () => {
  const frame = (length: number) => {
    const bytes = Buffer.alloc(length);
    bytes[0] = 255; bytes[1] = 241;
    bytes[2] = (1 << 6) | (8 << 2);
    bytes[3] = (1 << 6) | ((length >> 11) & 3);
    bytes[4] = (length >> 3) & 255; bytes[5] = (length & 7) << 5;
    return bytes;
  };
  assert.equal(validateCameraAudio(frame(400)), 1);
  assert.throws(() => validateCameraAudio(frame(700)), /camera limit/);
  assert.throws(() => validateCameraAudio(frame(400).subarray(0, 300)), /incomplete/);
});

test('camera playback waits for real live video before opening talkback and releases both handles', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eufy-speech-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audio = Buffer.alloc(40);
  audio[0] = 255; audio[1] = 241; audio[2] = (1 << 6) | (8 << 2); audio[3] = 1 << 6; audio[4] = 40 >> 3;
  const filename = path.join(directory, 'speech.aac');
  await writeFile(filename, audio);
  let liveStopped = false, talkStopped = false, talkCalls = 0;
  const live = Object.assign(new EventEmitter(), { stop: () => { liveStopped = true; } });
  const talk = Object.assign(new EventEmitter(), {
    codec: 'aac-lc',
    stop: async () => { talkStopped = true; talk.emit('stop'); },
    writable: () => new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) { callback(); setImmediate(() => talk.emit('finished')); },
    }),
  });
  const device = { camera: () => ({ live: async () => live, talkback: async () => { talkCalls++; return talk; } }) } as unknown as Device;
  const playing = cameraAudio(device, filename, AbortSignal.timeout(3000));
  while (!live.listenerCount('video')) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(talkCalls, 0);
  live.emit('video', { keyframe: false });
  assert.equal(talkCalls, 0);
  live.emit('video', { keyframe: true });
  assert.equal(await playing, 'audio sent to camera');
  assert.equal(talkCalls, 1);
  assert.ok(liveStopped);
  assert.ok(talkStopped);
});
