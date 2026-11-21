import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HouseholdConfig, HouseholdSnapshot } from './router.ts';

export type PresenceState = 'home' | 'away' | 'unknown';
export type ReportSource = 'geofence' | 'maps-notification' | 'manual';
export type ManualPresenceMode = 'auto' | 'home' | 'away';
interface PhoneReport { state: PresenceState; source: ReportSource; receivedAt: number }
export interface PhonePresenceSnapshot {
  state: PresenceState;
  reason: string;
  receivedAt: number | null;
  people: { id: string; name: string; state: PresenceState; source: ReportSource | 'router' | null; receivedAt: number | null }[];
}

const states = ['home', 'away', 'unknown'];
const sources = ['geofence', 'maps-notification', 'manual'];
const modes = ['auto', 'home', 'away'];
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;

export class Presence {
  private value: PresenceState = 'unknown';
  private receivedAt: number | null = null;
  private settings?: HouseholdConfig;
  private maxAgeMinutes = 15;
  private identities = '';
  private reports = new Map<string, PhoneReport>();
  private router: HouseholdSnapshot | null = null;
  private awaySince: number | null = null;
  private manualMode: ManualPresenceMode = 'auto';
  private manualChangedAt: number | null = null;
  private filename?: string;
  private loaded = false;

  constructor(filename?: string) { this.filename = filename; }

  configure(settings: HouseholdConfig, maxAgeMinutes: number): void {
    const identities = JSON.stringify({ mode: settings.mode || 'router', people: settings.people.map(person => person.id).sort() });
    const resetSaved = Boolean(this.identities) && identities !== this.identities;
    if (identities !== this.identities) {
      this.reports.clear(); this.router = null; this.awaySince = null;
      this.manualMode = 'auto'; this.manualChangedAt = null;
      // Preserve an initial legacy value supplied before engine construction.
      if (this.identities) { this.value = 'unknown'; this.receivedAt = null; }
      this.identities = identities;
    } else if (JSON.stringify(settings) !== JSON.stringify(this.settings)) {
      this.router = null; this.awaySince = null;
    }
    this.settings = structuredClone(settings); this.maxAgeMinutes = maxAgeMinutes;
    if (resetSaved) this.persist();
  }

  /** Restore only state belonging to the currently configured people and method. */
  load(): void {
    if (!this.filename) return;
    try {
      const saved = JSON.parse(readFileSync(this.filename, 'utf8').replace(/^\uFEFF/, ''));
      if (saved.version !== 1 || typeof saved.identities !== 'string') throw new Error('Invalid saved presence.');
      if (saved.identities !== this.identities) return;
      if (!Array.isArray(saved.reports) || saved.reports.length > 20 || !modes.includes(saved.manual?.mode) ||
        (saved.manual.changedAt !== null && !timestamp(saved.manual.changedAt)) ||
        (saved.manual.mode !== 'auto' && saved.manual.changedAt === null) ||
        (saved.awaySince !== null && !timestamp(saved.awaySince))) throw new Error('Invalid saved presence.');
      const reports = new Map<string, PhoneReport>();
      for (const report of saved.reports) {
        if (!this.settings?.people.some(person => person.id === report?.person) || reports.has(report.person) ||
          !states.includes(report.state) || !sources.includes(report.source) || !timestamp(report.receivedAt)) throw new Error('Invalid saved presence report.');
        reports.set(report.person, { state: report.state, source: report.source, receivedAt: report.receivedAt });
      }
      this.reports = reports;
      this.manualMode = saved.manual.mode; this.manualChangedAt = saved.manual.changedAt;
      this.awaySince = saved.awaySince;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved presence could not be loaded; use the control page to set it.');
    } finally { this.loaded = true; }
  }

  private persist(): void {
    if (!this.filename || !this.loaded) return;
    const saved = { version: 1, identities: this.identities,
      reports: [...this.reports].map(([person, report]) => ({ person, ...report })),
      manual: this.manualStatus(), awaySince: this.awaySince };
    mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = this.filename + '.tmp';
    writeFileSync(temporary, JSON.stringify(saved) + '\n', { mode: 0o600 });
    renameSync(temporary, this.filename);
  }

  private change(operation: () => void): void {
    const before = { reports: new Map(this.reports), manualMode: this.manualMode, manualChangedAt: this.manualChangedAt, awaySince: this.awaySince };
    try {
      operation();
      // A tiny synchronous write commits before camera events can observe the new state.
      this.persist();
    } catch {
      Object.assign(this, before);
      throw new Error('Presence could not be saved; the previous state was kept.');
    }
  }

  manualStatus(): { mode: ManualPresenceMode; changedAt: number | null } {
    return { mode: this.manualMode, changedAt: this.manualChangedAt };
  }

  setManual(mode: ManualPresenceMode, now = Date.now()): void {
    if (!modes.includes(mode)) throw new Error('Presence mode must be auto, home, or away.');
    this.change(() => {
      this.manualMode = mode; this.manualChangedAt = now; this.awaySince = null;
      this.details(this.maxAgeMinutes, now);
    });
  }

  update(state: PresenceState, now = Date.now()): void {
    if (!states.includes(state)) throw new Error('Presence must be home, away, or unknown.');
    this.value = state; this.receivedAt = now;
  }

  report(person: string, state: PresenceState, source: ReportSource, now = Date.now()): void {
    if (!['hybrid', 'events'].includes(this.settings?.mode || 'router')) throw new Error('Select an individual phone presence method first.');
    if (!this.settings?.people.some(member => member.id === person)) throw new Error('Choose a registered household person.');
    if (!states.includes(state) || !sources.includes(source)) throw new Error('Invalid phone presence report.');
    this.change(() => {
      this.details(this.maxAgeMinutes, now);
      this.reports.set(person, { state, source, receivedAt: now });
      // A new arrival also ends a manually armed absence, even if the old person state was home.
      if (state === 'home' && this.manualMode === 'away') {
        this.manualMode = 'auto'; this.manualChangedAt = now;
      }
      this.details(this.maxAgeMinutes, now);
    });
  }

  observeRouter(snapshot: HouseholdSnapshot | null, now = Date.now()): void {
    this.details(this.maxAgeMinutes, now);
    this.router = snapshot;
    this.details(this.maxAgeMinutes, now);
  }

  details(maxAgeMinutes = this.maxAgeMinutes, now = Date.now()): PhonePresenceSnapshot | null {
    const settings = this.settings;
    if (!settings || !['hybrid', 'events'].includes(settings.mode || 'router')) return null;
    const events = settings.mode === 'events';
    const fresh = (at: number, limit: number) => now >= at && now - at <= limit;
    const router = settings.enabled && this.router && fresh(this.router.checkedAt, settings.pollSeconds * 3 * 1000) ? this.router : null;
    const people = settings.people.map(({ id, name }) => {
      const report = this.reports.get(id);
      if (router?.people.some(person => person.id === id && person.state === 'home')) {
        return { id, name, state: 'home' as const, source: 'router' as const, receivedAt: router.checkedAt };
      }
      const valid = report && (events || fresh(report.receivedAt, maxAgeMinutes * 60_000));
      return { id, name, state: valid ? report.state : 'unknown' as const, source: report?.source || null, receivedAt: report?.receivedAt ?? null };
    });
    const receivedAt = people.reduce<number | null>((latest, person) => person.receivedAt === null ? latest : Math.max(latest ?? person.receivedAt, person.receivedAt), null);
    let state: PresenceState = 'unknown', reason = events ? 'Waiting for a state for every person.' : 'Waiting for fresh reports from every person.';
    if (people.some(person => person.state === 'home')) {
      state = 'home'; reason = events ? 'At least one person is recorded as home.' : 'At least one person has home evidence.'; this.awaySince = null;
    } else if (people.length && people.every(person => person.state === 'away')) {
      if (this.awaySince === null || now < this.awaySince) this.awaySince = now;
      if (now - this.awaySince >= settings.awayGraceSeconds * 1000) {
        state = 'away'; reason = 'Everyone is recorded as away and the grace period has elapsed.';
      } else reason = 'Waiting for the all-away grace period.';
    } else this.awaySince = null;
    if (this.manualMode !== 'auto') {
      return { state: this.manualMode, receivedAt: this.manualChangedAt, people,
        reason: this.manualMode === 'away' ? 'Manually set everyone away. A new arrival returns to Automatic.' : 'Manually set someone home. This holds until you change the mode.' };
    }
    return { state, reason, receivedAt, people };
  }

  snapshot(maxAgeMinutes: number, now = Date.now()): { state: PresenceState; receivedAt: number | null } {
    const household = this.details(maxAgeMinutes, now);
    if (household) return { state: household.state, receivedAt: household.receivedAt };
    if (this.manualMode !== 'auto') return { state: this.manualMode, receivedAt: this.manualChangedAt };
    const fresh = this.receivedAt !== null && now >= this.receivedAt && now - this.receivedAt <= maxAgeMinutes * 60_000;
    return { state: fresh ? this.value : 'unknown', receivedAt: this.receivedAt };
  }
}
