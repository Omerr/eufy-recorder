import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { publishNtfy, validateNtfy, type Notification } from '../src/ntfy.ts';

const notification: Notification = {
  title: 'Low camera battery: דלת',
  message: 'דלת: 25% battery remaining.',
  priority: 4, tags: ['battery', 'warning'],
};

test('sends Unicode names and optional bearer authentication to an ntfy-compatible server', async (t) => {
  let received: unknown;
  let authorization: string | undefined;
  let url: string | undefined;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    url = request.url;
    const buffers: Buffer[] = [];
    for await (const data of request) buffers.push(Buffer.from(data));
    received = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await publishNtfy({ server: `http://127.0.0.1:${address.port}/`, topic: 'camera-tests' }, notification, { token: 'local-test-token' });
  assert.equal(url, '/');
  assert.equal(authorization, 'Bearer local-test-token');
  assert.deepEqual(received, { topic: 'camera-tests', ...notification });
});

test('HTTP failures remain failures and private response bodies are omitted', async () => {
  const fakeFetch: typeof fetch = async () => new Response('private server information', { status: 403 });
  await assert.rejects(
    publishNtfy({ server: 'https://ntfy.example', topic: 'cameras' }, notification, { fetch: fakeFetch }),
    (error: Error) => /HTTP 403/.test(error.message) && !error.message.includes('private server'),
  );
});

test('an unconfigured topic cannot accidentally publish', async () => {
  let called = false;
  const fakeFetch: typeof fetch = async () => { called = true; return new Response('{}'); };
  await assert.rejects(publishNtfy({ server: 'https://ntfy.example', topic: '' }, notification, { fetch: fakeFetch }), /Configure ntfy/);
  assert.equal(called, false);
});

test('rejects malformed topic names and credentials embedded in URLs', () => {
  assert.throws(() => validateNtfy({ server: 'https://ntfy.example', topic: 'topic/extra' }), /topic/);
  assert.throws(() => validateNtfy({ server: 'https://user:password@ntfy.example', topic: 'cameras' }), /credentials/);
  assert.throws(() => validateNtfy({ server: 'ftp://ntfy.example', topic: 'cameras' }), /HTTP/);
});
