import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { yeelightOn, validateCameraAudio } from '../src/actions.ts';

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
