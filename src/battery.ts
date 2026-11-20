import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Notification } from './ntfy.ts';

export interface BatteryConfig {
  enabled: boolean;
  checkIntervalMinutes: number;
  lowPercent: number;
  criticalPercent: number;
  recoverPercent: number;
  reminderHours: number;
}

export const defaultBattery: BatteryConfig = {
  enabled: true,
  checkIntervalMinutes: 30,
  lowPercent: 30,
  criticalPercent: 10,
  recoverPercent: 35,
  reminderHours: 24,
};

type Severity = 'low' | 'critical';
interface Status {
  name: string;
  level: number | null;
  charging: boolean | null;
  observedAt: number;
  low: boolean;
  reportedLow: boolean;
  lastSentAt?: number;
  lastSeverity?: Severity;
  lastAttemptAt?: number;
  lastAttemptSeverity?: Severity;
}

export function batteryPercent(value: unknown): number | null {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function validateBattery(value: BatteryConfig): void {
  if (typeof value.enabled !== 'boolean') throw new Error('battery.enabled must be true or false.');
  for (const key of ['criticalPercent', 'lowPercent', 'recoverPercent'] as const) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100) {
      throw new Error(`battery.${key} must be an integer from 0 to 100.`);
    }
  }
  if (!(value.criticalPercent < value.lowPercent && value.lowPercent < value.recoverPercent)) {
    throw new Error('Battery thresholds must satisfy criticalPercent < lowPercent < recoverPercent.');
  }
  if (!Number.isInteger(value.checkIntervalMinutes) || value.checkIntervalMinutes < 5 || value.checkIntervalMinutes > 1440) {
    throw new Error('battery.checkIntervalMinutes must be an integer from 5 to 1440.');
  }
  if (!Number.isFinite(value.reminderHours) || value.reminderHours < 1 || value.reminderHours > 720) {
    throw new Error('battery.reminderHours must be from 1 to 720.');
  }
}

export class BatteryMonitor {
  private states: Record<string, Status> = {};
  private currentRun = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private settings: BatteryConfig;
  private filename: string;
  private notify: (notification: Notification) => Promise<void>;
  private log: (message: string) => void;

  constructor(options: {
    settings: BatteryConfig;
    filename: string;
    notify: (notification: Notification) => Promise<void>;
    log: (message: string) => void;
  }) {
    validateBattery(options.settings);
    this.settings = options.settings;
    this.filename = options.filename;
    this.notify = options.notify;
    this.log = options.log;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.filename, 'utf8'));
      if (saved.version !== 1 || !saved.cameras || typeof saved.cameras !== 'object' || Array.isArray(saved.cameras)) {
        throw new Error('Unexpected battery-state format.');
      }
      for (const [sn, raw] of Object.entries(saved.cameras)) {
        const state = raw as Status;
        if (!state || typeof state.name !== 'string' || !Number.isFinite(state.observedAt) ||
          !(state.level === null || (typeof state.level === 'number' && batteryPercent(state.level) !== null)) ||
          !(state.charging === null || typeof state.charging === 'boolean') ||
          typeof state.low !== 'boolean' || typeof state.reportedLow !== 'boolean' ||
          [state.lastSentAt, state.lastAttemptAt].some((n) => n !== undefined && !Number.isFinite(n)) ||
          [state.lastSeverity, state.lastAttemptSeverity].some((s) => s !== undefined && !['low', 'critical'].includes(s))) {
          throw new Error('Invalid camera entry in battery state.');
        }
        this.states[sn] = state;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  observe(sn: string, name: string, level: unknown, charging: unknown, now = Date.now(), observedAt = now): Promise<void> {
    return this.enqueue(async () => {
      const percentage = batteryPercent(level);
      const previous = this.states[sn];
      if (previous && observedAt < previous.observedAt) {
        this.currentRun.add(sn);
        await this.evaluate(previous, now);
        await this.save();
        return;
      }
      const state: Status = {
        ...previous,
        name, level: percentage,
        charging: typeof charging === 'boolean' ? charging : null,
        observedAt,
        low: previous?.low || false,
        reportedLow: percentage === null ? previous?.reportedLow || false : false,
      };
      if (percentage !== null) {
        if (percentage <= this.settings.lowPercent) state.low = true;
        if (percentage >= this.settings.recoverPercent) {
          state.low = false;
          delete state.lastSentAt;
          delete state.lastSeverity;
          delete state.lastAttemptAt;
          delete state.lastAttemptSeverity;
        }
      }
      this.states[sn] = state;
      this.currentRun.add(sn);
      this.log(`${name}: battery ${percentage === null ? 'unknown' : `${percentage}%`}${state.charging === true ? ' (charging)' : ''}`);
      await this.evaluate(state, now);
      await this.save();
    });
  }

  reportedLow(sn: string, name: string, now = Date.now()): Promise<void> {
    return this.enqueue(async () => {
      const state: Status = {
        ...this.states[sn], name, level: null, charging: null,
        observedAt: now, low: true, reportedLow: true,
      };
      this.states[sn] = state;
      this.currentRun.add(sn);
      await this.evaluate(state, now);
      await this.save();
    });
  }

  tick(now = Date.now()): Promise<void> {
    return this.enqueue(async () => {
      // Old entries from removed cameras cannot generate reminders after restart.
      for (const sn of this.currentRun) await this.evaluate(this.states[sn], now);
      await this.save();
    });
  }

  flush(): Promise<void> { return this.queue; }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  private async evaluate(state: Status, now: number): Promise<void> {
    if (!state.low || (state.level === null && !state.reportedLow)) return;
    const severity: Severity = state.level !== null && state.level <= this.settings.criticalPercent ? 'critical' : 'low';
    const escalation = severity === 'critical' && state.lastSeverity !== 'critical';
    const reminder = state.lastSentAt === undefined || now - state.lastSentAt >= this.settings.reminderHours * 3_600_000;
    if (!escalation && !reminder) return;
    // Failed deliveries stay pending, with a five-minute retry backoff per severity.
    if (state.lastAttemptSeverity === severity && state.lastAttemptAt !== undefined && now - state.lastAttemptAt < 300_000) return;
    state.lastAttemptAt = now;
    state.lastAttemptSeverity = severity;
    const level = state.level === null ? 'eufy reported a low battery; percentage unavailable' : `${state.level}% battery remaining`;
    const ageMinutes = Math.max(0, Math.floor((now - state.observedAt) / 60_000));
    try {
      await this.notify({
        title: `${severity === 'critical' ? 'Critical' : 'Low'} camera battery: ${state.name}`,
        message: `${state.name}: ${level}.${state.charging === true ? ' Charging is reported.' : ''} Check the camera and charge it if needed. Last observed by this recorder ${ageMinutes} minute(s) ago; eufy reports can be delayed.`,
        priority: severity === 'critical' ? 5 : 4,
        tags: ['battery', 'warning'],
      });
      state.lastSentAt = now;
      state.lastSeverity = severity;
      this.log(`${state.name}: ${severity} battery notification delivered`);
    } catch (error) {
      this.log(`${state.name}: battery notification failed; will retry (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, cameras: this.states }, null, 2), { mode: 0o600 });
    await rename(temporary, this.filename);
  }
}
