import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FragmentRecordingHandle, MediaFragment } from '@mega-yfue/eufy-sdk';
import { captureClip, captureWithRetries, extendWindow, type CaptureOptions } from '../src/recording.ts';

// A real, two-second H.264 fragmented MP4, generated from a blue 64x64 image.
const fixture = await readFile(new URL('./fixtures/video.mp4', import.meta.url));
const boundaries: number[] = [];
let end = fixture.length;
for (let position = 0; position < fixture.length;) {
  const size = fixture.readUInt32BE(position);
  const kind = fixture.toString('ascii', position + 4, position + 8);
  if (kind === 'moof') boundaries.push(position);
  if (kind === 'mfra') end = position;
  assert.ok(size >= 8);
  position += size;
}
assert.equal(boundaries.length, 2);
const init = fixture.subarray(0, boundaries[0]);
const first = fixture.subarray(boundaries[0], boundaries[1]);
const second = fixture.subarray(boundaries[1], end);

function source(generator: () => AsyncGenerator<MediaFragment>, stop = () => {}): FragmentRecordingHandle {
  return Object.assign(new EventEmitter(), { stop, [Symbol.asyncIterator]: generator }) as FragmentRecordingHandle;
}

async function options(t: { after: (fn: () => Promise<void>) => void }): Promise<CaptureOptions> {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'eufy-recorder-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const now = Date.now();
  return {
    camera: 'Front / door', trigger: 'test', outputDir, triggeredAt: now,
    firstFragmentTimeoutMs: 5000,
    window: { until: now + 5000, hardStop: now + 10000 },
    signal: new AbortController().signal, log: () => {},
  };
}

test('writes real MP4 fragments immediately and preserves them after a transport failure', async (t) => {
  const opts = await options(t);
  let savedWhileSourceWasAlive = false;
  const input = source(async function* () {
    yield { init, data: first, keyframe: true };
    const [folder] = await readdir(opts.outputDir);
    const written = await readFile(path.join(opts.outputDir, folder, 'clip.mp4'));
    assert.deepEqual(written, Buffer.concat([init, first]));
    savedWhileSourceWasAlive = true;
    throw new Error('camera disconnected');
  });
  await assert.rejects(captureClip(() => input, opts), /camera disconnected/);
  assert.ok(savedWhileSourceWasAlive);
  const [folder] = await readdir(opts.outputDir);
  assert.deepEqual(await readFile(path.join(opts.outputDir, folder, 'clip.mp4')), Buffer.concat([init, first]));
  const metadata = JSON.parse(await readFile(path.join(opts.outputDir, folder, 'recording.json'), 'utf8'));
  assert.equal(metadata.fragments, 1);
  assert.equal(metadata.outcome, 'failed');
  assert.equal(metadata.error, 'camera disconnected');
});

test('appends multiple fragments with one MP4 header', async (t) => {
  const opts = await options(t);
  const input = source(async function* () {
    yield { init, data: Buffer.alloc(0), keyframe: true };
    yield { data: first, keyframe: true };
    yield { data: second, keyframe: true };
  });
  const filename = await captureClip(() => input, opts);
  assert.deepEqual(await readFile(filename), Buffer.concat([init, first, second]));
  const metadata = JSON.parse(await readFile(path.join(path.dirname(filename), 'recording.json'), 'utf8'));
  assert.equal(metadata.fragments, 2);
  assert.equal(metadata.outcome, 'stream-ended');
});

test('a stalled source times out even when its stop method cannot unblock it', async (t) => {
  const opts = await options(t);
  opts.firstFragmentTimeoutMs = 30;
  let stopped = false;
  const input = source(async function* () {
    await new Promise(() => {});
    yield { init, data: first, keyframe: true };
  }, () => { stopped = true; });
  await assert.rejects(captureClip(() => input, opts), /No video fragment/);
  assert.ok(stopped);
});

test('shutdown flushes the source tail and labels the clip interrupted', async (t) => {
  const opts = await options(t);
  const controller = new AbortController();
  opts.signal = controller.signal;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const input = source(async function* () {
    yield { init, data: first, keyframe: true };
    controller.abort();
    await waiting;
    yield { data: second, keyframe: true };
  }, () => release());
  const filename = await captureClip(() => input, opts);
  assert.deepEqual(await readFile(filename), Buffer.concat([init, first, second]));
  const metadata = JSON.parse(await readFile(path.join(path.dirname(filename), 'recording.json'), 'utf8'));
  assert.equal(metadata.outcome, 'interrupted');
});

test('repeated motion extends a clip within the battery time limit', () => {
  const window = { until: 30_000, hardStop: 120_000 };
  extendWindow(window, 20_000, 30);
  assert.equal(window.until, 50_000);
  extendWindow(window, 110_000, 30);
  assert.equal(window.until, 120_000);
  extendWindow(window, 1000, 30);
  assert.equal(window.until, 120_000);
});

test('reconnects after an empty first connection and saves the next stream', async (t) => {
  const opts = await options(t);
  let attempts = 0;
  const filename = await captureWithRetries(() => {
    attempts++;
    return source(async function* () {
      if (attempts === 1) return;
      yield { init, data: first, keyframe: true };
    });
  }, opts, 3, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(await readFile(filename), Buffer.concat([init, first]));
});
