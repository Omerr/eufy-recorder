import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '../scripts/check-public.mjs');
async function repo(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eufy-public-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('config', 'user.name', 'Example');
  git('config', 'user.email', '1+example@users.noreply.github.com');
  await mkdir(path.join(directory, 'scripts'));
  await copyFile(source, path.join(directory, 'scripts/check-public.mjs'));
  const check = (...args: string[]) => spawnSync(process.execPath, ['scripts/check-public.mjs', ...args], { cwd: directory, encoding: 'utf8' });
  return { directory, git, check };
}

test('private runtime files remain blocked even when force-added to Git', async (t) => {
  const { directory, git, check } = await repo(t);
  await writeFile(path.join(directory, 'recorder.json'), '{}');
  git('add', 'recorder.json');
  const result = check('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the public source allowlist/);
});

test('a leaked camera serial in a permitted source file is rejected without printing it', async (t) => {
  const { directory, git, check } = await repo(t);
  const serial = 'T' + '0'.repeat(15);
  await writeFile(path.join(directory, 'README.md'), serial);
  git('add', 'README.md');
  const result = check('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /camera serial/);
  assert.ok(!result.stderr.includes(serial));
});

test('public source passes, while a secret hidden in a historical commit message is blocked', async (t) => {
  const { directory, git, check } = await repo(t);
  await writeFile(path.join(directory, 'README.md'), 'Public camera recorder example.');
  git('add', 'README.md');
  assert.equal(check('--staged').status, 0);
  git('commit', '-qm', 'Private topic ' + 'eufy-' + 'a'.repeat(32));
  const result = check('--history');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit metadata/);
});

test('opaque API keys and values from an external local denylist cannot be published', async (t) => {
  const { directory, git, check } = await repo(t);
  await writeFile(path.join(directory, 'README.md'), 'a'.repeat(64));
  git('add', 'README.md');
  assert.match(check('--staged').stderr, /opaque access key/);
  const denied = path.join(directory, 'private.local.json');
  await writeFile(denied, JSON.stringify(['synthetic-private-network']));
  git('config', 'privacy.denylist', denied);
  await writeFile(path.join(directory, 'README.md'), 'Synthetic-Private-Network');
  git('add', 'README.md');
  assert.match(check('--staged').stderr, /local private configuration value/);
});
