import type { HouseholdConfig, HouseholdSnapshot } from './router.ts';

export type PresenceState = 'home' | 'away' | 'unknown';
export type ReportSource = 'geofence' | 'maps-notification';
interface PhoneReport { state: PresenceState; source: ReportSource; receivedAt: number }
export interface PhonePresenceSnapshot {
  state: PresenceState;
  reason: string;
  receivedAt: number | null;
  people: { id: string; name: string; state: PresenceState; source: ReportSource | 'router' | null; receivedAt: number | null }[];
}

export class Presence {
  private value: PresenceState = 'unknown';
  private receivedAt: number | null = null;
  private settings?: HouseholdConfig;
  private maxAgeMinutes = 15;
  private identities = '';
  private reports = new Map<string, PhoneReport>();
  private router: HouseholdSnapshot | null = null;
  private awaySince: number | null = null;

  configure(settings: HouseholdConfig, maxAgeMinutes: number): void {
    const identities = JSON.stringify({ ...settings, mode: settings.mode || 'router', maxAgeMinutes });
    if (identities !== this.identities) {
      this.reports.clear(); this.router = null; this.awaySince = null;
      // Preserve the initial legacy value supplied before the engine is constructed.
      if (this.identities) { this.value = 'unknown'; this.receivedAt = null; }
      this.identities = identities;
    }
    this.settings = structuredClone(settings); this.maxAgeMinutes = maxAgeMinutes;
  }

  update(state: PresenceState, now = Date.now()): void {
    if (!['home', 'away', 'unknown'].includes(state)) throw new Error('Presence must be home, away, or unknown.');
    this.value = state; this.receivedAt = now;
  }

  report(person: string, state: PresenceState, source: ReportSource, now = Date.now()): void {
    if (this.settings?.mode !== 'hybrid') throw new Error('Select phone reports with router home detection first.');
    if (!this.settings.people.some((member) => member.id === person)) throw new Error('Choose a registered household person.');
    if (!['home', 'away', 'unknown'].includes(state) || !['geofence', 'maps-notification'].includes(source)) throw new Error('Invalid phone presence report.');
    // Expired evidence must break the grace period even if nobody queried it meanwhile.
    this.details(this.maxAgeMinutes, now);
    this.reports.set(person, { state, source, receivedAt: now });
    this.details(this.maxAgeMinutes, now);
  }

  observeRouter(snapshot: HouseholdSnapshot | null, now = Date.now()): void {
    if (this.settings?.mode === 'hybrid') this.details(this.maxAgeMinutes, now);
    this.router = snapshot;
    if (this.settings?.mode === 'hybrid') this.details(this.maxAgeMinutes, now);
  }

  details(maxAgeMinutes = this.maxAgeMinutes, now = Date.now()): PhonePresenceSnapshot | null {
    const settings = this.settings;
    if (settings?.mode !== 'hybrid') return null;
    const fresh = (at: number, limit: number) => now >= at && now - at <= limit;
    const router = settings.enabled && this.router && fresh(this.router.checkedAt, settings.pollSeconds * 3 * 1000) ? this.router : null;
    const people = settings.people.map(({ id, name }) => {
      const report = this.reports.get(id);
      // Positive Wi-Fi evidence overrides an away report. Absence never establishes away.
      if (router?.people.some((person) => person.id === id && person.state === 'home')) {
        return { id, name, state: 'home' as const, source: 'router' as const, receivedAt: router.checkedAt };
      }
      const valid = report && fresh(report.receivedAt, maxAgeMinutes * 60_000);
      return { id, name, state: valid ? report.state : 'unknown' as const, source: report?.source || null, receivedAt: report?.receivedAt ?? null };
    });
    const receivedAt = people.reduce<number | null>((latest, person) => person.receivedAt === null ? latest : Math.max(latest ?? person.receivedAt, person.receivedAt), null);
    let state: PresenceState = 'unknown', reason = 'Waiting for fresh reports from every person.';
    if (people.some((person) => person.state === 'home')) {
      state = 'home'; reason = 'At least one person has home evidence.'; this.awaySince = null;
    } else if (people.length && people.every((person) => person.state === 'away')) {
      this.awaySince ??= now;
      if (now - this.awaySince >= settings.awayGraceSeconds * 1000) {
        state = 'away'; reason = 'Every person reported away and the grace period has elapsed.';
      } else reason = 'Waiting for the all-away grace period.';
    } else this.awaySince = null;
    return { state, reason, receivedAt, people };
  }

  snapshot(maxAgeMinutes: number, now = Date.now()): { state: PresenceState; receivedAt: number | null } {
    const household = this.details(maxAgeMinutes, now);
    if (household) return { state: household.state, receivedAt: household.receivedAt };
    const fresh = this.receivedAt !== null && now >= this.receivedAt && now - this.receivedAt <= maxAgeMinutes * 60_000;
    return { state: fresh ? this.value : 'unknown', receivedAt: this.receivedAt };
  }
}
