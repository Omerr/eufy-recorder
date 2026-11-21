import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

export interface SleepLanSettings { host: string; port: number }

export function validateSleepLan(value: SleepLanSettings): void {
  const [first, second] = (value.host || '').split('.').map(Number);
  const privateAddress = first === 10 || first === 127 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
  if (isIP(value.host) !== 4 || !privateAddress || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('Sleep LAN access needs a specific private IPv4 address and valid port.');
  }
}

export async function sleepLanSettings(stateDir: string): Promise<SleepLanSettings | undefined> {
  try {
    const value = JSON.parse((await readFile(path.join(stateDir, 'sleep-lan.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const settings = { host: value.host, port: value.port ?? 8789 };
    validateSleepLan(settings);
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Local Sleep shortcut settings are invalid.');
  }
}

/** A widget can start sleep music without getting access to cameras or settings. */
export function sleepShortcutToken(automationToken: string): string {
  return createHmac('sha256', automationToken).update('eufy-recorder:shortcut:sleep-music:v1').digest('base64url');
}
