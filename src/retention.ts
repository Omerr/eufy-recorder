import { readdir, readFile, lstat, rm } from 'node:fs/promises';
import path from 'node:path';

export interface RetentionConfig {
  maxDays: number;
  maxGB: number;
}

export const defaultRetention: RetentionConfig = { maxDays: 14, maxGB: 10 };

export function validateRetention(settings: RetentionConfig): void {
  if (!Number.isFinite(settings.maxDays) || settings.maxDays < 1 || settings.maxDays > 3650) {
    throw new Error('retention.maxDays must be from 1 to 3650.');
  }
  if (!Number.isFinite(settings.maxGB) || settings.maxGB < 0.01 || settings.maxGB > 10_000) {
    throw new Error('retention.maxGB must be from 0.01 to 10000.');
  }
}

/** Only completed recordings created by this application are eligible for deletion. */
export async function pruneRecordings(root: string, settings: RetentionConfig, now = Date.now()): Promise<number> {
  validateRetention(settings);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const clips: { directory: string; time: number; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-zA-Z0-9_-]+_[a-f0-9]{8}$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const info = JSON.parse(await readFile(path.join(directory, 'recording.json'), 'utf8'));
      const time = Date.parse(info.triggeredAt);
      const end = Date.parse(info.endedAt);
      if (!Number.isFinite(time) || !Number.isFinite(end) || typeof info.camera !== 'string' ||
        !['complete', 'stream-ended', 'interrupted', 'failed'].includes(info.outcome)) continue;
      const names = await readdir(directory);
      // Leave unexpected user files and folders untouched.
      if (names.some((name) => !['clip.mp4', 'recording.json'].includes(name))) continue;
      let size = 0;
      let regular = true;
      for (const name of names) {
        const stat = await lstat(path.join(directory, name));
        if (!stat.isFile()) { regular = false; break; }
        size += stat.size;
      }
      if (regular) clips.push({ directory, time, size });
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  clips.sort((a, b) => a.time - b.time);
  let total = clips.reduce((sum, clip) => sum + clip.size, 0);
  let deleted = 0;
  for (const clip of clips) {
    if (clip.time >= now - settings.maxDays * 86_400_000 && total <= settings.maxGB * 1_000_000_000) break;
    await rm(clip.directory, { recursive: true });
    total -= clip.size;
    deleted++;
  }
  return deleted;
}
