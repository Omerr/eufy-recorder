import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface InstanceLock {
  stopFile: string;
  release: () => Promise<void>;
}

/** One realtime client per persisted FCM identity. */
export async function acquireInstance(stateDir: string, mode: string): Promise<InstanceLock> {
  await mkdir(stateDir, { recursive: true });
  const directory = path.join(stateDir, 'recorder-lock');
  const ownerFile = path.join(directory, 'owner.json');
  const nonce = randomUUID();
  const stopFile = path.join(stateDir, `stop-${nonce}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid: number; nonce: string; mode?: string };
      try { owner = JSON.parse(await readFile(ownerFile, 'utf8')); }
      catch {
        // A concurrent launcher may still be writing its ownership record.
        if (attempt < 3) { await delay(200); continue; }
        throw new Error('Recorder lock has no readable owner. Check running recorder processes before removing it.');
      }
      if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== 'string') {
        throw new Error('Invalid recorder lock owner; leaving the lock unchanged.');
      }
      let alive = true;
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        else throw error;
      }
      if (alive) throw new Error(`Recorder already running (${owner.mode || 'realtime'}, PID ${owner.pid}). Run Stop-Recorder.ps1 before starting another realtime command.`);
      // Serialize recovery so two launchers cannot remove a successor's lock.
      const reclaim = path.join(stateDir, 'recorder-reclaim');
      try { await mkdir(reclaim); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { await delay(200); continue; }
        throw error;
      }
      try {
        let current: { pid: number; nonce: string };
        try { current = JSON.parse(await readFile(ownerFile, 'utf8')); }
        catch { continue; }
        if (current.nonce !== owner.nonce || current.pid !== owner.pid) continue;
        try { process.kill(current.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          await rm(directory, { recursive: true });
        }
      } finally {
        await rm(reclaim, { recursive: true });
      }
      continue;
    }
    try {
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, mode, nonce, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      stopFile,
      release: async () => {
        try {
          const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
          if (owner.nonce === nonce) await rm(directory, { recursive: true });
          await rm(stopFile, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      },
    };
  }
  throw new Error('Recorder lock changed repeatedly; retry after other launchers finish.');
}
