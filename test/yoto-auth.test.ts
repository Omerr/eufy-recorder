import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { YotoAuth } from '../src/yoto-auth.ts';

test('Yoto refreshes one time for concurrent callers and saves the rotated refresh token', async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), 'eufy-yoto-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'session.json');
  await writeFile(file, JSON.stringify({ clientId: 'example-client', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0 }));
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    calls++; assert.equal(new URLSearchParams(String(options?.body)).get('refresh_token'), 'old-refresh');
    return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }));
  };
  const auth = new YotoAuth(file, fetcher);
  assert.deepEqual(await Promise.all([auth.accessToken(), auth.accessToken()]), ['new-access', 'new-access']);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).refreshToken, 'new-refresh');
  assert.equal(await auth.accessToken(), 'new-access');
  assert.equal(calls, 1);
});
