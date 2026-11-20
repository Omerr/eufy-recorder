import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireInstance } from '../src/instance.ts';

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'eufy-instance-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('blocks a second realtime client while allowing restart after release', async (t) => {
  const root = await directory(t);
  const first = await acquireInstance(root, 'watch');
  await assert.rejects(acquireInstance(root, 'record'), /already running/);
  await first.release();
  const second = await acquireInstance(root, 'events');
  await second.release();
});

test('recovers ownership after a previous recorder process has exited', async (t) => {
  const root = await directory(t);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(exited.status, 0);
  await mkdir(path.join(root, 'recorder-lock'));
  await writeFile(path.join(root, 'recorder-lock', 'owner.json'), JSON.stringify({ pid: exited.pid, nonce: 'old-run', mode: 'watch' }));
  const current = await acquireInstance(root, 'watch');
  const owner = JSON.parse(await readFile(path.join(root, 'recorder-lock', 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.nonce, 'old-run');
  await current.release();
});

test('parallel recovery of a stale lock admits only one client', async (t) => {
  const root = await directory(t);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(exited.status, 0);
  await mkdir(path.join(root, 'recorder-lock'));
  await writeFile(path.join(root, 'recorder-lock', 'owner.json'), JSON.stringify({ pid: exited.pid, nonce: 'old-run', mode: 'watch' }));
  const results = await Promise.allSettled([acquireInstance(root, 'watch'), acquireInstance(root, 'watch')]);
  const admitted = results.filter((result) => result.status === 'fulfilled');
  assert.equal(admitted.length, 1);
  if (admitted[0].status === 'fulfilled') await admitted[0].value.release();
});
