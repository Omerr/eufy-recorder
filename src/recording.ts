import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FragmentRecordingHandle } from '@mega-yfue/eufy-sdk';

export interface RecordingWindow {
  until: number;
  hardStop: number;
}

export interface CaptureOptions {
  camera: string;
  trigger: string;
  outputDir: string;
  triggeredAt: number;
  firstFragmentTimeoutMs: number;
  window: RecordingWindow;
  signal: AbortSignal;
  log: (message: string) => void;
}

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'camera';
}

export function extendWindow(window: RecordingWindow, now: number, seconds: number): void {
  window.until = Math.min(window.hardStop, Math.max(window.until, now + seconds * 1000));
}

/** Re-open a failed event connection while the original recording window remains open. */
export async function captureWithRetries(
  makeSource: () => FragmentRecordingHandle,
  options: CaptureOptions,
  attempts = 3,
  retryDelayMs = 750,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try { return await captureClip(makeSource, options); }
    catch (error) {
      const deadline = Math.min(options.window.until, options.window.hardStop, options.triggeredAt + options.firstFragmentTimeoutMs);
      if (options.signal.aborted || attempt >= attempts || Date.now() + retryDelayMs + 2000 >= deadline) throw error;
      options.log(`${options.camera}: connection failed; retrying (${attempt + 1}/${attempts})`);
      await delay(retryDelayMs, undefined, { signal: options.signal });
    }
  }
}

/** Persist each complete fragment before requesting the next one. */
export async function captureClip(
  makeSource: () => FragmentRecordingHandle,
  options: CaptureOptions,
): Promise<string> {
  const stamp = new Date(options.triggeredAt).toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}_${safeName(options.camera)}_${randomUUID().slice(0, 8)}`;
  const directory = path.join(options.outputDir, base);
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'clip.mp4');
  const file = await open(filename, 'wx');
  const metadata = {
    camera: options.camera,
    trigger: options.trigger,
    triggeredAt: new Date(options.triggeredAt).toISOString(),
    firstFragmentAt: null as string | null,
    firstFragmentDelayMs: null as number | null,
    endedAt: '',
    fragments: 0,
    bytes: 0,
    outcome: 'recording',
    error: null as string | null,
  };
  let source: FragmentRecordingHandle | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let failure: Error | undefined;
  let initialized = false;
  let forceEnd!: () => void;
  const forced = new Promise<IteratorResult<never>>((resolve) => {
    forceEnd = () => resolve({ done: true, value: undefined });
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    source?.stop();
    // A stalled transport must not keep the recorder alive indefinitely.
    forceTimer = setTimeout(forceEnd, 2000);
  };
  const aborted = () => stop();
  const checkDeadline = () => {
    const now = Date.now();
    if (!metadata.fragments && now - options.triggeredAt >= options.firstFragmentTimeoutMs) {
      failure = new Error('No video fragment arrived before the timeout.');
      stop();
    } else if (now >= Math.min(options.window.until, options.window.hardStop)) {
      stop();
    }
  };

  try {
    if (options.signal.aborted) throw new Error('Recording cancelled before connection.');
    source = makeSource();
    source.on('budget', (notice) => {
      if (!stopping && Date.now() < Math.min(options.window.until, options.window.hardStop)) {
        notice.extend();
      }
    });
    options.signal.addEventListener('abort', aborted, { once: true });
    timer = setInterval(checkDeadline, 200);
    const iterator = source[Symbol.asyncIterator]();
    while (true) {
      const item = await Promise.race([iterator.next(), forced]);
      if (item.done) break;
      const fragment = item.value;
      if (fragment.init?.length) {
        if (initialized) throw new Error('Unexpected second MP4 initialization segment.');
        await file.writeFile(fragment.init);
        metadata.bytes += fragment.init.length;
        initialized = true;
      }
      if (!fragment.data.length) continue;
      if (!initialized) throw new Error('Video arrived without an MP4 initialization segment.');
      await file.writeFile(fragment.data);
      await file.sync();
      metadata.bytes += fragment.data.length;
      metadata.fragments++;
      if (!metadata.firstFragmentAt) {
        metadata.firstFragmentAt = new Date().toISOString();
        metadata.firstFragmentDelayMs = Date.now() - options.triggeredAt;
        options.log(`${options.camera}: first video fragment saved after ${metadata.firstFragmentDelayMs} ms`);
      }
    }
    if (failure) throw failure;
    if (!metadata.fragments) throw new Error('The stream ended without saving video.');
    metadata.outcome = options.signal.aborted ? 'interrupted' : stopping ? 'complete' : 'stream-ended';
    if (metadata.outcome === 'stream-ended') {
      options.log(`${options.camera}: stream ended early; keeping ${metadata.fragments} saved fragments`);
    }
  } catch (error) {
    metadata.outcome = 'failed';
    metadata.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    if (forceTimer) clearTimeout(forceTimer);
    options.signal.removeEventListener('abort', aborted);
    source?.stop();
    await file.close();
    metadata.endedAt = new Date().toISOString();
    await writeFile(path.join(directory, 'recording.json'), JSON.stringify(metadata, null, 2));
    options.log(`${options.camera}: ${metadata.outcome}, ${metadata.fragments} fragments, ${filename}`);
  }
  return filename;
}
