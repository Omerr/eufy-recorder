import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneRecordings } from '../src/retention.ts';

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'eufy-retention-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function clip(root: string, iso: string, id: string, bytes = 100, complete = true) {
  const directory = path.join(root, `${iso.replace(/[:.]/g, '-')}_ExampleCamera_${id}`);
  await mkdir(directory);
  const file = await open(path.join(directory, 'clip.mp4'), 'wx');
  await file.truncate(bytes);
  await file.close();
  if (complete) await writeFile(path.join(directory, 'recording.json'), JSON.stringify({
    camera: 'ExampleCamera', triggeredAt: iso, endedAt: iso, outcome: 'complete',
  }));
  return directory;
}

test('removes expired completed clips while preserving recent clips and active recordings', async (t) => {
  const root = await workspace(t);
  const old = await clip(root, '2026-10-01T00:00:00.000Z', '00000001');
  const active = await clip(root, '2026-10-01T00:00:01.000Z', '00000002', 100, false);
  const recent = await clip(root, '2026-11-19T00:00:00.000Z', '00000003');
  assert.equal(await pruneRecordings(root, { maxDays: 14, maxGB: 10 }, Date.parse('2026-11-20')), 1);
  await assert.rejects(access(old));
  await access(active);
  await access(recent);
});

test('enforces the byte budget by deleting the oldest completed clip first', async (t) => {
  const root = await workspace(t);
  const old = await clip(root, '2026-11-18T00:00:00.000Z', '00000001', 6_000_000);
  const recent = await clip(root, '2026-11-19T00:00:00.000Z', '00000002', 6_000_000);
  assert.equal(await pruneRecordings(root, { maxDays: 14, maxGB: 0.01 }, Date.parse('2026-11-20')), 1);
  await assert.rejects(access(old));
  await access(recent);
});

test('leaves unrelated folders and clips with extra user files untouched', async (t) => {
  const root = await workspace(t);
  const withNotes = await clip(root, '2026-10-01T00:00:00.000Z', '00000001');
  await writeFile(path.join(withNotes, 'keep.txt'), 'user notes');
  const unrelated = path.join(root, 'family-videos');
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, 'recording.json'), '{}');
  assert.equal(await pruneRecordings(root, { maxDays: 14, maxGB: 10 }, Date.parse('2026-11-20')), 0);
  await access(withNotes);
  await access(unrelated);
});
