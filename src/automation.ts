import { defaultHousehold, validateHousehold, type HouseholdConfig } from './router.ts';

export type PresenceState = 'home' | 'away' | 'unknown';
export type DetectionKind = 'motion' | 'personDetected' | 'strangerDetected';
export interface Detection {
  kind: DetectionKind;
  camera: string;
  at: Date;
}
export type AutomationDevice =
  | { type: 'yeelight'; host: string; port?: number }
  | { type: 'eufy-audio'; camera: string; file: string }
  | { type: 'yoto'; deviceId: string; tokenEnv: string; cardUri: string; volume?: number; skipIfPlaying?: boolean }
  | { type: 'webhook'; url: string; tokenEnv?: string; body?: Record<string, unknown> };
export interface AutomationRule {
  id: string;
  enabled: boolean;
  cameras: string[];
  events: DetectionKind[];
  after?: string;
  before?: string;
  presence?: 'home' | 'away' | 'any';
  cooldownSeconds: number;
  actions: { device: string }[];
}
export interface AutomationConfig {
  enabled: boolean;
  timeZone: string;
  presenceMaxAgeMinutes: number;
  api: { host: string; port: number; tokenEnv: string };
  devices: Record<string, AutomationDevice>;
  rules: AutomationRule[];
  household: HouseholdConfig;
}
export const defaultAutomation: AutomationConfig = {
  enabled: false,
  timeZone: 'UTC',
  presenceMaxAgeMinutes: 15,
  api: { host: '127.0.0.1', port: 8788, tokenEnv: 'EUFY_AUTOMATION_TOKEN' },
  devices: {}, rules: [],
  household: defaultHousehold,
};

export function automationConfig(value: Partial<AutomationConfig> | undefined): AutomationConfig {
  const result = {
    ...defaultAutomation, ...value, api: { ...defaultAutomation.api, ...value?.api },
    household: {
      ...defaultHousehold, ...value?.household,
      people: (value?.household?.people || defaultHousehold.people).map((person) => ({ ...person, macs: [...person.macs] })),
    },
  };
  validateAutomation(result);
  return result;
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const envName = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);
const clockTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function validateAutomation(value: AutomationConfig): void {
  validateHousehold(value.household);
  if (typeof value.enabled !== 'boolean') throw new Error('automations.enabled must be true or false.');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); }
  catch { throw new Error('automations.timeZone must be an IANA time zone.'); }
  if (!Number.isFinite(value.presenceMaxAgeMinutes) || value.presenceMaxAgeMinutes < 1 || value.presenceMaxAgeMinutes > 1440) {
    throw new Error('automations.presenceMaxAgeMinutes must be from 1 to 1440.');
  }
  if (!value.api || !nonempty(value.api.host) || ['0.0.0.0', '::'].includes(value.api.host) ||
    !Number.isInteger(value.api.port) || value.api.port < 1 || value.api.port > 65535 || !envName(value.api.tokenEnv)) {
    throw new Error('Automation API needs a specific bind address, valid port, and token environment variable.');
  }
  if (!value.devices || typeof value.devices !== 'object' || Array.isArray(value.devices) || !Array.isArray(value.rules)) {
    throw new Error('automations.devices must be an object and rules must be an array.');
  }
  for (const [name, device] of Object.entries(value.devices)) {
    if (!nonempty(name) || !device || typeof device !== 'object') throw new Error('Invalid automation device.');
    switch (device.type) {
      case 'yeelight':
        if (!nonempty(device.host) || (device.port !== undefined && (!Number.isInteger(device.port) || device.port < 1 || device.port > 65535))) {
          throw new Error(`Device ${name}: invalid Yeelight address.`);
        }
        break;
      case 'eufy-audio':
        if (!nonempty(device.camera) || !nonempty(device.file)) throw new Error(`Device ${name}: camera and audio file required.`);
        break;
      case 'yoto':
        if (!nonempty(device.deviceId) || !envName(device.tokenEnv) || !nonempty(device.cardUri) ||
          (device.volume !== undefined && (!Number.isInteger(device.volume) || device.volume < 0 || device.volume > 100)) ||
          (device.skipIfPlaying !== undefined && typeof device.skipIfPlaying !== 'boolean')) {
          throw new Error(`Device ${name}: Yoto device, token environment variable, card URI, and valid volume required.`);
        }
        break;
      case 'webhook': {
        let url: URL;
        try { url = new URL(device.url); } catch { throw new Error(`Device ${name}: invalid webhook URL.`); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          (device.tokenEnv !== undefined && !envName(device.tokenEnv))) throw new Error(`Device ${name}: invalid webhook settings.`);
        break;
      }
      default: throw new Error(`Device ${name}: unsupported type.`);
    }
  }
  const ids = new Set<string>();
  for (const rule of value.rules) {
    if (!rule || !nonempty(rule.id) || ids.has(rule.id) || typeof rule.enabled !== 'boolean' ||
      !Array.isArray(rule.cameras) || !rule.cameras.length || !rule.cameras.every(nonempty) ||
      !Array.isArray(rule.events) || !rule.events.length || rule.events.some((kind) => !['motion', 'personDetected', 'strangerDetected'].includes(kind)) ||
      !Number.isFinite(rule.cooldownSeconds) || rule.cooldownSeconds < 1 || rule.cooldownSeconds > 86_400 ||
      !Array.isArray(rule.actions) || !rule.actions.length || rule.actions.some((action) => !action || !Object.hasOwn(value.devices, action.device)) ||
      (rule.after !== undefined && !clockTime(rule.after)) || (rule.before !== undefined && !clockTime(rule.before)) ||
      (rule.after !== undefined && rule.after === rule.before) ||
      (rule.presence !== undefined && !['home', 'away', 'any'].includes(rule.presence))) {
      throw new Error(`Invalid automation rule: ${rule?.id || '(unnamed)'}.`);
    }
    ids.add(rule.id);
  }
}

export class Presence {
  private value: PresenceState = 'unknown';
  private receivedAt: number | null = null;
  update(state: PresenceState, now = Date.now()): void {
    if (!['home', 'away', 'unknown'].includes(state)) throw new Error('Presence must be home, away, or unknown.');
    this.value = state;
    this.receivedAt = now;
  }
  snapshot(maxAgeMinutes: number, now = Date.now()): { state: PresenceState; receivedAt: number | null } {
    const fresh = this.receivedAt !== null && now >= this.receivedAt && now - this.receivedAt <= maxAgeMinutes * 60_000;
    return { state: fresh ? this.value : 'unknown', receivedAt: this.receivedAt };
  }
}

function inTimeWindow(rule: AutomationRule, timeZone: string, at: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const now = `${parts.find((part) => part.type === 'hour')!.value}:${parts.find((part) => part.type === 'minute')!.value}`;
  if (rule.after && rule.before && rule.after > rule.before) return now >= rule.after || now < rule.before;
  return (!rule.after || now >= rule.after) && (!rule.before || now < rule.before);
}

export interface RuleDecision { id: string; matches: boolean; reason: string; devices: string[] }
interface SpeakerTest {
  device: string;
  camera: string;
  expiresAt: number;
  state: 'armed' | 'running' | 'sent' | 'failed' | 'expired' | 'cancelled';
  result?: string;
}
export class AutomationEngine {
  private lastRun = new Map<string, number>();
  private active = new Set<string>();
  private pending = new Set<Promise<void>>();
  private settings: AutomationConfig;
  private presence: Presence;
  private execute: (device: string, config: AutomationDevice, signal: AbortSignal) => Promise<string>;
  private log: (message: string) => void;
  private signal: AbortSignal;
  private clock: () => number;
  private running = new Map<string, { event: Detection; controller: AbortController }>();
  private lastEvent: { camera: string; kind: DetectionKind; at: string; decisions: RuleDecision[] } | null = null;
  private speakerTest: SpeakerTest | null = null;
  private speakerTestController?: AbortController;

  constructor(options: {
    settings: AutomationConfig; presence: Presence;
    execute: (device: string, config: AutomationDevice, signal: AbortSignal) => Promise<string>;
    log: (message: string) => void; signal: AbortSignal; now?: () => number;
  }) {
    this.settings = options.settings; this.presence = options.presence;
    this.execute = options.execute; this.log = options.log; this.signal = options.signal;
    this.clock = options.now || Date.now;
  }
  configure(settings: AutomationConfig): void { validateAutomation(settings); this.settings = settings; this.presenceChanged(); }
  config(): AutomationConfig { return this.settings; }
  status() { return this.lastEvent; }
  speakerTestStatus(now = this.clock()): SpeakerTest | null {
    if (this.speakerTest?.state === 'armed' && now >= this.speakerTest.expiresAt) this.speakerTest.state = 'expired';
    return this.speakerTest ? { ...this.speakerTest } : null;
  }
  armSpeakerTest(name: string, seconds = 300): SpeakerTest {
    const device = this.settings.devices[name];
    if (device?.type !== 'eufy-audio') throw new Error('Choose a camera audio device for this test.');
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 300) throw new Error('Test expiry must be from 15 to 300 seconds.');
    if (this.signal.aborted) throw new Error('Recorder is stopping.');
    if (this.speakerTest?.state === 'running') throw new Error('A speaker test is already playing.');
    this.speakerTest = { device: name, camera: device.camera, expiresAt: this.clock() + seconds * 1000, state: 'armed' };
    this.log(`Speaker test: ${name} armed for the next person detection (${seconds} seconds).`);
    return { ...this.speakerTest };
  }
  cancelSpeakerTest(): void {
    this.speakerTestController?.abort();
    if (this.speakerTest && ['armed', 'running'].includes(this.speakerTest.state)) this.speakerTest.state = 'cancelled';
  }
  async testDevice(name: string): Promise<string> {
    const device = this.settings.devices[name];
    if (!device) throw new Error('Unknown device.');
    return this.execute(name, device, AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]));
  }
  presenceChanged(): void {
    for (const [id, running] of this.running) {
      const rule = this.settings.rules.find((item) => item.id === id);
      if (!rule || this.condition(rule, running.event, this.clock())) running.controller.abort();
    }
  }
  preview(event: Detection, now = this.clock(), presenceOverride?: PresenceState): RuleDecision[] {
    return this.settings.rules.map((rule) => {
      let reason = this.condition(rule, event, now, presenceOverride);
      if (!reason && this.active.has(rule.id)) reason = 'already running';
      const last = this.lastRun.get(rule.id);
      if (!reason && last !== undefined && now - last < rule.cooldownSeconds * 1000) reason = 'cooldown';
      return { id: rule.id, matches: !reason, reason: reason || 'matched', devices: rule.actions.map((action) => action.device) };
    });
  }
  handle(event: Detection, now = this.clock()): void {
    const test = this.speakerTestStatus(now);
    if (!this.signal.aborted && test?.state === 'armed' && test.camera === event.camera &&
      ['personDetected', 'strangerDetected'].includes(event.kind)) {
      const current = this.speakerTest!;
      current.state = 'running'; // Consume before awaiting; duplicate events cannot play it twice.
      const device = this.settings.devices[current.device];
      const controller = new AbortController();
      this.speakerTestController = controller;
      const job = (async () => {
        try {
          if (device?.type !== 'eufy-audio' || device.camera !== current.camera) throw new Error('Speaker configuration changed.');
          this.log(`Speaker test: person detected; playing ${current.device}.`);
          current.result = await this.execute(current.device, device, AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(30_000)]));
          if (current.state === 'running') current.state = 'sent';
          this.log(`Speaker test: ${current.state}; ${current.result}`);
        } catch {
          if (current.state === 'running') { current.state = 'failed'; current.result = 'Camera playback failed; inspect the device connection.'; }
          this.log(`Speaker test: ${current.state}.`);
        }
      })().finally(() => { this.pending.delete(job); if (this.speakerTest === current) this.speakerTestController = undefined; });
      this.pending.add(job);
    }
    const decisions = this.preview(event, now);
    this.lastEvent = { camera: event.camera, kind: event.kind, at: event.at.toISOString(), decisions };
    for (const decision of decisions) {
      if (!decision.matches) continue;
      const rule = this.settings.rules.find((item) => item.id === decision.id)!;
      this.lastRun.set(rule.id, now);
      this.active.add(rule.id);
      const job = this.run(rule, event).finally(() => { this.active.delete(rule.id); this.pending.delete(job); });
      this.pending.add(job);
    }
  }
  async flush(): Promise<void> { await Promise.allSettled(this.pending); }
  private condition(rule: AutomationRule, event: Detection, now: number, presenceOverride?: PresenceState): string | null {
    if (this.signal.aborted) return 'stopping';
    if (!this.settings.enabled || !rule.enabled) return 'disabled';
    if (!rule.cameras.includes(event.camera) || !rule.events.includes(event.kind)) return 'different event or camera';
    if (!inTimeWindow(rule, this.settings.timeZone, event.at)) return 'outside time window';
    const expected = rule.presence || 'any';
    if (expected !== 'any' && (presenceOverride ?? this.presence.snapshot(this.settings.presenceMaxAgeMinutes, now).state) !== expected) return 'presence condition not met';
    return null;
  }
  private async run(rule: AutomationRule, event: Detection): Promise<void> {
    this.log(`Automation ${rule.id}: triggered`);
    const controller = new AbortController();
    this.running.set(rule.id, { event, controller });
    try {
    for (const action of rule.actions) {
      const currentRule = this.settings.rules.find((item) => item.id === rule.id);
      // Stop later actions if the phone comes home or the rule is disabled mid-run.
      if (controller.signal.aborted || !currentRule || this.condition(currentRule, event, this.clock())) break;
      const device = this.settings.devices[action.device];
      if (!device) break;
      try {
        const signal = AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(30_000)]);
        const result = await this.execute(action.device, device, signal);
        this.log(`Automation ${rule.id}: ${action.device}: ${result}`);
      } catch {
        this.log(`Automation ${rule.id}: ${action.device}: failed; check the device configuration or connection`);
      }
    }
    } finally { this.running.delete(rule.id); }
  }
}

