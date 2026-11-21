import { createHash, createHmac } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';

export interface RouterClient {
  mac: string;
  band: '2.4 GHz' | '5 GHz';
  associated: boolean;
  authorized: boolean;
  name?: string;
}
export interface HouseholdConfig {
  enabled: boolean;
  mode?: 'router' | 'hybrid' | 'events';
  pollSeconds: number;
  awayGraceSeconds: number;
  people: { id: string; name: string; macs: string[] }[];
}
export const defaultHousehold: HouseholdConfig = {
  enabled: false, mode: 'router', pollSeconds: 60, awayGraceSeconds: 180,
  people: [{ id: 'person-1', name: 'Person 1', macs: [] }, { id: 'person-2', name: 'Person 2', macs: [] }],
};
export const normalizeMac = (value: string) => value.trim().replaceAll('-', ':').toLowerCase();
export function validateHousehold(value: HouseholdConfig): void {
  if (typeof value.enabled !== 'boolean' || (value.mode !== undefined && !['router', 'hybrid', 'events'].includes(value.mode)) || !Number.isInteger(value.pollSeconds) || value.pollSeconds < 15 || value.pollSeconds > 300 ||
    !Number.isInteger(value.awayGraceSeconds) || value.awayGraceSeconds < 60 || value.awayGraceSeconds > 1800 ||
    !Array.isArray(value.people) || value.people.length < 1 || value.people.length > 20) throw new Error('Invalid household router settings.');
  const ids = new Set<string>();
  const owners = new Map<string, string>();
  for (const person of value.people) {
    if (!person || typeof person.id !== 'string' || !person.id || ids.has(person.id) || typeof person.name !== 'string' || !person.name.trim() ||
      !Array.isArray(person.macs) || person.macs.some((mac) => typeof mac !== 'string' || !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(normalizeMac(mac)))) {
      throw new Error('Each household person needs a unique ID, name, and valid MAC addresses.');
    }
    ids.add(person.id);
    for (const raw of person.macs) {
      const mac = normalizeMac(raw);
      if (owners.has(mac) && owners.get(mac) !== person.id) throw new Error('Two people cannot share the same phone Wi-Fi address.');
      owners.set(mac, person.id);
    }
  }
}

const flag = (value: unknown): boolean => {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error('Router association flags are missing or invalid.');
};
export function parseRouterClients(value: unknown): RouterClient[] {
  if (!value || typeof value !== 'object') throw new Error('Router did not return a client snapshot.');
  const data = value as Record<string, unknown>;
  const output: RouterClient[] = [];
  for (const [key, band] of [['data2_4', '2.4 GHz'], ['data5', '5 GHz']] as const) {
    if (!Array.isArray(data[key]) || data[key].length > 1024) throw new Error('Router snapshot must contain both Wi-Fi bands.');
    for (const raw of data[key]) {
      if (!raw || typeof raw !== 'object' || typeof raw.mac !== 'string') throw new Error('Invalid router client entry.');
      const mac = normalizeMac(raw.mac);
      if (!/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac)) throw new Error('Invalid router client address.');
      output.push({ mac, band, associated: flag(raw.associated), authorized: flag(raw.authorized) });
    }
  }
  return output;
}

export class RouterAuthError extends Error {}
export class HotboxClient {
  private address: URL;
  private username: string;
  private password: string;
  private sessionFile: string;
  private fetcher: typeof fetch;
  private cookies = new Map<string, string>();
  private loaded = false;
  private authRejected = false;
  private signal?: AbortSignal;
  private labels = new Map<string, string>();
  private labelsAt = 0;
  constructor(options: { address: string; username: string; password: string; sessionFile: string; fetch?: typeof fetch; signal?: AbortSignal }) {
    this.address = new URL(options.address);
    if (!['http:', 'https:'].includes(this.address.protocol) || this.address.username || this.address.password) throw new Error('Invalid local router address.');
    this.username = options.username; this.password = options.password;
    this.sessionFile = options.sessionFile; this.fetcher = options.fetch || fetch;
    this.signal = options.signal;
  }
  private async request(route: string, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extra, Referer: new URL('/index.html', this.address).toString(), 'Cache-Control': 'no-cache' };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => key + '=' + value).join('; ');
    if (this.cookies.has('XSRF-TOKEN')) headers['X-XSRF-TOKEN'] = decodeURIComponent(this.cookies.get('XSRF-TOKEN')!);
    const timeout = AbortSignal.timeout(7000);
    const response = await this.fetcher(new URL(route, this.address), { headers, redirect: 'manual', signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0], at = pair.indexOf('=');
      if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Router response is unexpectedly large.');
    return { status: response.status, text };
  }
  private async save(): Promise<void> {
    const temporary = `${this.sessionFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ cookies: [...this.cookies], savedAt: Date.now() }), { mode: 0o600 });
    await rename(temporary, this.sessionFile);
  }
  private async login(): Promise<void> {
    if (this.authRejected) throw new RouterAuthError('Router login needs local review; automatic login attempts are paused.');
    this.cookies.clear();
    await this.request('/');
    const loader = await this.request('/uxfwk.session.loader.js');
    const nonce = loader.text.match(/\bnonce\s*:\s*['"]([^'"]+)['"]/);
    if (!nonce) throw new Error('Router login challenge is unavailable.');
    const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const hmac = (value: string) => createHmac('sha256', nonce[1]).update(sha(Buffer.from(value, 'latin1'))).digest('hex');
    const credential = sha(hmac(this.username) + hmac(this.password));
    const response = await this.request('/index.html', { Authorization: 'Digest ' + credential });
    if (response.status !== 200 || /g_loginContext\s*=\s*true/.test(response.text) || !this.cookies.has('SESSIONID')) {
      this.authRejected = true;
      throw new RouterAuthError('Router login was rejected. Check credentials locally before restarting.');
    }
    await this.save();
  }
  async clients(): Promise<RouterClient[]> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const saved = JSON.parse(await readFile(this.sessionFile, 'utf8'));
        if (Array.isArray(saved.cookies)) this.cookies = new Map(saved.cookies);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (this.authRejected) throw new RouterAuthError('Router login attempts are paused.');
    let response = this.cookies.size ? await this.request('/ss-json/fgw.devicesDetailed.json') : null;
    if (!response || [401, 403, 302, 303, 307].includes(response.status)) {
      await this.login();
      response = await this.request('/ss-json/fgw.devicesDetailed.json');
    }
    if (response.status !== 200) throw new Error('Router client list is unavailable.');
    const output = parseRouterClients(JSON.parse(response.text));
    if (Date.now() - this.labelsAt > 300_000) {
      this.labelsAt = Date.now();
      try {
        const details = await this.request('/ss-json/fgw.common/fgw.common.devicesWifi.json?bypass=0');
        if (details.status === 200) {
          const data = JSON.parse(details.text);
          if (Array.isArray(data.devices)) {
            for (const item of data.devices) if (typeof item.mac === 'string' && typeof item.name === 'string') {
              this.labels.set(normalizeMac(item.mac), item.name.slice(0, 120));
            }
          }
        }
      } catch { /* Names are optional; only association data determines presence. */ }
    }
    await this.save();
    return output.map((client) => ({ ...client, name: this.labels.get(client.mac) }));
  }
}

export interface HouseholdSnapshot {
  state: 'home' | 'away' | 'unknown';
  reason: string;
  checkedAt: number;
  people: { id: string; name: string; state: 'home' | 'away' | 'unknown' }[];
  clients: RouterClient[];
}
export class HouseholdTracker {
  private absentSince: number | null = null;
  private identities = '';
  observe(clients: RouterClient[], settings: HouseholdConfig, now = Date.now()): HouseholdSnapshot {
    const identities = JSON.stringify(settings.people.map((person) => ({ id: person.id, macs: [...new Set(person.macs.map(normalizeMac))].sort() })));
    if (identities !== this.identities) { this.absentSince = null; this.identities = identities; }
    const connected = new Set(clients.filter((client) => client.associated).map((client) => client.mac));
    const people = settings.people.map((person) => ({
      id: person.id, name: person.name,
      state: !person.macs.length ? 'unknown' as const : person.macs.some((mac) => connected.has(normalizeMac(mac))) ? 'home' as const : 'away' as const,
    }));
    let state: HouseholdSnapshot['state'] = 'unknown', reason = 'Choose the Wi-Fi addresses for every household phone.';
    if (people.some((person) => person.state === 'home')) {
      state = 'home'; reason = 'At least one household phone is associated with home Wi-Fi.'; this.absentSince = null;
    } else if (people.every((person) => person.state === 'away')) {
      this.absentSince ??= now;
      if (now - this.absentSince >= settings.awayGraceSeconds * 1000) { state = 'away'; reason = 'All household phones are absent after the grace period.'; }
      else reason = 'Waiting for the all-away grace period.';
    } else this.absentSince = null;
    return { state, reason, checkedAt: now, people, clients };
  }
  unavailable(settings: HouseholdConfig, now = Date.now()): HouseholdSnapshot {
    this.absentSince = null;
    return { state: 'unknown', reason: 'Router data is unavailable.', checkedAt: now, people: settings.people.map(({ id, name }) => ({ id, name, state: 'unknown' })), clients: [] };
  }
}

export class RouterPresence {
  private client: Pick<HotboxClient, 'clients'> | null;
  private settings: () => HouseholdConfig;
  private publish: (state: HouseholdSnapshot['state'], snapshot: HouseholdSnapshot | null) => void;
  private log: (message: string) => void;
  private signal: AbortSignal;
  private tracker = new HouseholdTracker();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private current: HouseholdSnapshot | null = null;
  private wasEnabled = false;
  constructor(options: {
    client: Pick<HotboxClient, 'clients'> | null; settings: () => HouseholdConfig;
    publish: (state: HouseholdSnapshot['state'], snapshot: HouseholdSnapshot | null) => void;
    log: (message: string) => void; signal: AbortSignal;
  }) {
    this.client = options.client; this.settings = options.settings;
    this.publish = options.publish; this.log = options.log; this.signal = options.signal;
    this.signal.addEventListener('abort', () => { if (this.timer) clearTimeout(this.timer); }, { once: true });
  }
  status(): HouseholdSnapshot | null { return this.current; }
  refresh(forceRead = false): Promise<void> {
    if (this.pending) return this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.pending = (async () => {
      const settings = this.settings();
      if (this.wasEnabled !== settings.enabled) { this.publish('unknown', null); this.tracker.unavailable(settings); }
      this.wasEnabled = settings.enabled;
      if (this.signal.aborted || (!settings.enabled && !forceRead)) return;
      try {
        if (!this.client) throw new Error('Local router credentials are missing.');
        const clients = await this.client.clients();
        this.current = this.tracker.observe(clients, this.settings());
      } catch {
        if (this.signal.aborted) return;
        this.current = this.tracker.unavailable(this.settings());
      }
      if (this.settings().enabled && this.current && !this.signal.aborted) {
        this.publish(this.current.state, this.current);
        const members = this.current.people.map((person) => `${person.id}=${person.state}`).join(', ');
        this.log(`Router observation: ${this.current.state}; ${members}; ${this.current.reason}`);
      }
    })().finally(() => {
      this.pending = undefined;
      if (!this.signal.aborted && this.settings().enabled) this.timer = setTimeout(() => { void this.refresh(); }, this.settings().pollSeconds * 1000);
    });
    return this.pending;
  }
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.pending;
  }
}
