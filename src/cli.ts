import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {
  EufyMega, FileSessionStore, FileFcmStore, LoginStatus,
  type Device, type PushSemanticEvent,
} from '@mega-yfue/eufy-sdk';
import { captureWithRetries, extendWindow, type RecordingWindow } from './recording.ts';
import { BatteryMonitor, batteryPercent, defaultBattery, validateBattery, type BatteryConfig } from './battery.ts';
import { publishNtfy, validateNtfy, type NtfyConfig } from './ntfy.ts';
import { defaultRetention, pruneRecordings, validateRetention, type RetentionConfig } from './retention.ts';
import { acquireInstance, type InstanceLock } from './instance.ts';
import { AutomationEngine, Presence, automationConfig, type AutomationConfig } from './automation.ts';
import { Actions } from './actions.ts';
import { startAutomationApi } from './automation-api.ts';
import { YotoAuth } from './yoto-auth.ts';
import type { Server } from 'node:http';
import { HotboxClient, RouterPresence } from './router.ts';

interface Config {
  countryCode: string;
  cameras: string[];
  outputDir: string;
  clipSeconds: number;
  maxClipSeconds: number;
  firstFragmentTimeoutSeconds: number;
  battery: BatteryConfig;
  ntfy: NtfyConfig;
  retention: RetentionConfig;
  automations: AutomationConfig;
}

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const transportLog = (message: string, ...details: unknown[]) => {
  if (process.env.EUFY_DEBUG !== '1' || !/^\[(live|session|push)/.test(message)) return;
  if (message === '[live] start trace') {
    const detail = details[0] as Record<string, unknown> | undefined;
    const safe = Object.fromEntries(['phase', 'reason', 'stage', 'source', 'action', 'outcome', 'attempts', 'waitedMs', 'silentMs'].flatMap((key) =>
      detail?.[key] !== undefined ? [[key, detail[key]]] : []));
    log(`Transport: ${JSON.stringify(safe)}`);
  } else {
    log(`Transport: ${message}`);
  }
};
const root = path.resolve(import.meta.dirname, '..');
const stateDir = process.env.EUFY_STATE_DIR || path.join(root, 'state');
const args = process.argv.slice(2);
const command = args[0] || 'help';
const flag = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value.`);
  return args[index + 1];
};

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Verification requires an interactive PowerShell terminal.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(question)).trim(); }
  finally { terminal.close(); }
}

async function config(): Promise<Config> {
  let text: string;
  try { text = await readFile(path.join(root, 'recorder.json'), 'utf8'); }
  catch { throw new Error('Run .\\Start-Recorder.ps1 setup to create recorder.json.'); }
  const value = JSON.parse(text.replace(/^\uFEFF/, '')) as Config;
  if (!/^[A-Z]{2}$/.test(value.countryCode)) throw new Error('countryCode must contain two uppercase letters.');
  if (!Array.isArray(value.cameras) || value.cameras.some((sn) => typeof sn !== 'string' || !sn)) {
    throw new Error('cameras must be an array of camera serial numbers.');
  }
  if (typeof value.outputDir !== 'string' || !value.outputDir) throw new Error('outputDir must be a folder path.');
  for (const key of ['clipSeconds', 'maxClipSeconds', 'firstFragmentTimeoutSeconds'] as const) {
    if (!Number.isInteger(value[key]) || value[key] < 5 || value[key] > 120) {
      throw new Error(`${key} must be an integer from 5 to 120.`);
    }
  }
  if (value.clipSeconds > value.maxClipSeconds) throw new Error('clipSeconds must be at most maxClipSeconds.');
  value.battery = { ...defaultBattery, ...value.battery };
  value.ntfy = Object.assign({ server: 'https://ntfy.sh', topic: '' }, value.ntfy);
  validateBattery(value.battery);
  validateNtfy(value.ntfy);
  value.retention = { ...defaultRetention, ...value.retention };
  validateRetention(value.retention);
  value.automations = automationConfig(value.automations);
  value.outputDir = path.resolve(root, value.outputDir);
  return value;
}

async function main(): Promise<void> {
  if (command === 'help' || command === '--help') {
    console.log('Use Start-Recorder.ps1: setup | list | record -Camera SERIAL [-Seconds 30] | events | watch | battery | ntfy-setup | ntfy-test | automation-setup | automation-info | yoto-setup | check');
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) throw new Error('Node.js 24.5.0 or newer is required.');
  if (command === 'check') {
    const probe = path.join(root, `.write-check-${randomBytes(4).toString('hex')}`);
    await writeFile(probe, 'ok', { flag: 'wx' });
    const { unlink } = await import('node:fs/promises');
    await unlink(probe);
    console.log(`OK: native ${process.platform}/${process.arch}, Node ${process.versions.node}, SDK loads, project folder writable.`);
    console.log('No camera login attempted.');
    return;
  }
  if (!['list', 'events', 'record', 'watch', 'battery', 'ntfy-test', 'yoto-login'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const settings = await config();
  if (command === 'yoto-login') {
    await new YotoAuth(path.join(stateDir, 'yoto-session.json')).login(process.env.YOTO_CLIENT_ID || '', log);
    return;
  }
  if (command === 'ntfy-test') {
    await publishNtfy(settings.ntfy, {
      title: 'Eufy recorder notification test',
      message: 'Camera battery notifications can reach this device. This test contains no camera battery reading.',
      priority: 3, tags: ['white_check_mark'],
    }, { token: process.env.NTFY_TOKEN });
    log('ntfy test notification delivered.');
    return;
  }
  if (['watch', 'battery'].includes(command) && !settings.cameras.length) {
    throw new Error('Add the serial numbers from list to cameras in recorder.json before using watch or battery.');
  }
  const serial = flag('--camera');
  const seconds = Number(flag('--seconds') || settings.clipSeconds);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120) throw new Error('--seconds must be from 5 to 120.');
  if (command === 'record' && !serial) throw new Error('record requires --camera SERIAL.');
  if (!process.env.EUFY_EMAIL || !process.env.EUFY_PASSWORD) {
    throw new Error('Run through Start-Recorder.ps1 to load your Windows-encrypted credential.');
  }
  await mkdir(stateDir, { recursive: true });
  const identityPath = path.join(stateDir, 'device-id.txt');
  let identity: string;
  try { identity = (await readFile(identityPath, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    identity = randomBytes(16).toString('hex');
    await writeFile(identityPath, identity, { flag: 'wx', mode: 0o600 });
  }
  const client = new EufyMega({
    email: process.env.EUFY_EMAIL,
    password: process.env.EUFY_PASSWORD,
    countryCode: settings.countryCode,
    openudid: identity,
    store: new FileSessionStore(path.join(stateDir, 'session.json')),
    pushStore: new FileFcmStore(path.join(stateDir, 'push.json')),
    autoRealtime: !['list', 'battery'].includes(command),
    p2pIdleMs: 10_000,
    pollMs: settings.battery.checkIntervalMinutes * 60_000,
    cacheTtlMs: settings.battery.checkIntervalMinutes * 60_000,
    logger: { debug: transportLog, info: () => {}, warn: transportLog, error: transportLog },
  });
  const abort = new AbortController();
  const active = new Map<string, { window: RecordingWindow; done: Promise<void> }>();
  const devices = new Map<string, Device>();
  const phonePresence = new Presence();
  const actions = new Actions(root, stateDir, devices);
  const automations = new AutomationEngine({
    settings: settings.automations, presence: phonePresence,
    execute: (name, device, signal) => actions.execute(name, device, signal), log, signal: abort.signal,
  });
  let automationApi: Server | undefined;
  let routerPresence: RouterPresence | undefined;
  let instance: InstanceLock | undefined;
  let stopTimer: ReturnType<typeof setInterval> | undefined;
  let batteryMonitor: BatteryMonitor | undefined;
  let batteryTimer: ReturnType<typeof setInterval> | undefined;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let cleanup: Promise<void> | undefined;
  const cleanRecordings = (): Promise<void> => {
    if (cleanup) return cleanup;
    cleanup = pruneRecordings(settings.outputDir, settings.retention).then((count) => {
      if (count) log(`Storage cleanup removed ${count} completed recordings.`);
    }).catch((error: Error) => log(`Storage cleanup failed: ${error.message}`)).finally(() => { cleanup = undefined; });
    return cleanup;
  };
  let accepting = false;
  const sampleBattery = async (device: Device): Promise<void> => {
    const reading = device.getProperty('battery');
    const charging = device.battery?.()?.charging;
    await batteryMonitor?.observe(device.sn, device.name, reading?.value, charging, Date.now(), reading?.ts || Date.now());
  };
  client.on('error', (error) => log(`SDK error: ${error.message}`));
  client.on('pushConnect', () => log('Motion notification connection established.'));
  client.on('pushDisconnect', () => {
    if (!abort.signal.aborted) log('Motion notification connection interrupted; reconnecting.');
  });
  client.on('sessionExpired', () => {
    log('Session expired. Restart interactively to complete any required verification.');
    process.exitCode = 1;
    abort.abort();
  });
  const shutdown = () => abort.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const record = (sn: string, trigger: string, duration: number): Promise<void> => {
    const now = Date.now();
    const existing = active.get(sn);
    if (existing) {
      extendWindow(existing.window, now, duration);
      log(`${devices.get(sn)?.name || sn}: extending current clip`);
      return existing.done;
    }
    const device = devices.get(sn);
    const camera = device?.camera?.();
    if (!device || !camera?.recordFragments) return Promise.reject(new Error(`${sn}: fragmented recording is unavailable.`));
    const window: RecordingWindow = {
      until: now + duration * 1000,
      hardStop: now + Math.max(duration, settings.maxClipSeconds) * 1000,
    };
    log(`${device.name}: starting ${trigger} recording`);
    const done = captureWithRetries(() => camera.recordFragments!({ fragmentSeconds: 2 }), {
      camera: device.name || sn,
      trigger,
      outputDir: settings.outputDir,
      triggeredAt: now,
      firstFragmentTimeoutMs: settings.firstFragmentTimeoutSeconds * 1000,
      window,
      signal: abort.signal,
      log,
    }).then(() => {}).finally(() => active.delete(sn));
    active.set(sn, { window, done });
    return done;
  };
  for (const kind of ['motion', 'personDetected', 'strangerDetected'] as const) {
    client.on(kind, (event: PushSemanticEvent) => {
      const sn = event.deviceSn || event.stationSn;
      if (!sn) return;
      log(`${kind}: ${devices.get(sn)?.name || sn}`);
      if (command !== 'watch' || !accepting || abort.signal.aborted || !settings.cameras.includes(sn)) return;
      automations.handle({ kind, camera: sn, at: new Date() });
      void record(sn, kind, settings.clipSeconds).catch((error: Error) => log(`Recording failed: ${error.message}`));
    });
  }
  client.on('propertyChanged', (event) => {
    if (!batteryMonitor || abort.signal.aborted || !settings.cameras.includes(event.deviceSn) || event.property !== 'battery') return;
    const device = devices.get(event.deviceSn);
    if (device) void sampleBattery(device).catch((error: Error) => log(`Battery tracking failed: ${error.message}`));
  });
  client.on('batteryAlert', (event) => {
    const sn = event.deviceSn || event.stationSn;
    if (!batteryMonitor || abort.signal.aborted || event.state !== 'low' || !sn || !settings.cameras.includes(sn)) return;
    void batteryMonitor.reportedLow(sn, devices.get(sn)?.name || sn).catch((error: Error) => log(`Battery tracking failed: ${error.message}`));
  });
  try {
    if (['watch', 'events', 'record'].includes(command)) {
      instance = await acquireInstance(stateDir, command);
      stopTimer = setInterval(() => {
        void access(instance!.stopFile).then(() => abort.abort()).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') log(`Stop request check failed: ${error.message}`);
        });
      }, 1000);
    }
    if (command === 'watch' && settings.battery.enabled) {
      batteryMonitor = new BatteryMonitor({
        settings: settings.battery,
        filename: path.join(stateDir, 'battery-status.json'),
        notify: (notification) => publishNtfy(settings.ntfy, notification, { token: process.env.NTFY_TOKEN, signal: abort.signal }),
        log,
      });
      await batteryMonitor.load();
      if (!settings.ntfy.topic) log('Battery tracking enabled. Run ntfy-setup to enable phone notifications.');
    }
    let result = await client.login();
    while (result.status !== LoginStatus.Ok) {
      if (result.status === LoginStatus.Captcha) {
        const file = path.join(stateDir, 'captcha.png');
        await writeFile(file, Buffer.from(result.image.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
        log(`Open the captcha image: ${file}`);
        result = await client.solveCaptcha(await ask('Captcha characters: '));
      } else if (result.status === LoginStatus.TwoFactor) {
        result = await client.submitVerifyCode(await ask(`Verification code (${result.method}): `));
      } else {
        throw new Error('Unexpected login status.');
      }
    }
    const listed = await client.getDevices();
    for (const item of listed) {
      // Listing reads cloud metadata; only selected devices are resolved for recording.
      if (command === 'list') {
        console.log(`${item.sn}\t${item.name}`);
      } else if (command === 'events' || (command === 'record' ? item.sn === serial : settings.cameras.includes(item.sn))) {
        const device = await client.getDevice(item.sn);
        devices.set(item.sn, device);
        const camera = device.camera?.();
        log(`${item.name}: live=${!!camera?.live}, fragments=${!!camera?.recordFragments}, download=${!!camera?.downloadRecording}`);
      }
    }
    if (command === 'list') return;
    if (command === 'battery') {
      for (const sn of settings.cameras) {
        const device = devices.get(sn);
        if (!device) throw new Error(`${sn}: camera was not found in this account.`);
        const level = batteryPercent(device.getProperty('battery')?.value);
        const charging = device.battery?.()?.charging;
        log(`${device.name}: battery ${level === null ? 'unknown' : `${level}%`}, charging=${charging ?? 'unknown'}`);
      }
      return;
    }
    if (command === 'record') {
      if (!devices.has(serial!)) throw new Error('Camera serial was not found in this account.');
      await record(serial!, 'manual-test', seconds);
      return;
    }
    if (command === 'watch') {
      for (const sn of settings.cameras) {
        if (!devices.get(sn)?.camera?.()?.recordFragments) throw new Error(`${sn}: camera missing or recording unavailable.`);
      }
      await mkdir(settings.outputDir, { recursive: true });
      await access(settings.outputDir);
      await cleanRecordings();
      retentionTimer = setInterval(() => { void cleanRecordings(); }, 60 * 60_000);
      log(`Recording retention: ${settings.retention.maxDays} days, ${settings.retention.maxGB} GB, oldest completed clips removed first.`);
      accepting = true;
      let routerClient: HotboxClient | null = null;
      if (process.env.ROUTER_USER && process.env.ROUTER_PASSWORD !== undefined) {
        try {
          const routerSettings = JSON.parse((await readFile(path.join(stateDir, 'router-settings.json'), 'utf8')).replace(/^\uFEFF/, ''));
          routerClient = new HotboxClient({
            address: routerSettings.address, username: process.env.ROUTER_USER, password: process.env.ROUTER_PASSWORD,
            sessionFile: path.join(stateDir, 'router-session.json'), signal: abort.signal,
          });
        } catch { log('Router settings are unavailable. Run Connect-Router.ps1 locally and restart.'); }
      }
      routerPresence = new RouterPresence({
        client: routerClient, settings: () => automations.config().household,
        publish: (state) => { phonePresence.update(state); automations.presenceChanged(); }, log, signal: abort.signal,
      });
      void routerPresence.refresh().catch(() => log('Router presence initialization failed.'));
      const apiToken = process.env[settings.automations.api.tokenEnv];
      if (apiToken) {
        try {
          automationApi = await startAutomationApi({
            engine: automations, presence: phonePresence, configFile: path.join(root, 'recorder.json'),
            token: apiToken, signal: abort.signal, log, router: routerPresence, yotoChoices: (signal) => actions.yotoChoices(signal),
          });
        } catch (error) {
          // A control API failure must not interrupt security footage recording.
          log(`Automation API unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (settings.automations.enabled) {
        log('Automations are enabled but the presence API token is missing; presence remains unknown.');
      }
      if (batteryMonitor) {
        for (const device of devices.values()) await sampleBattery(device);
        batteryTimer = setInterval(() => {
          if (abort.signal.aborted) return;
          void (async () => {
            for (const device of devices.values()) await sampleBattery(device);
            await batteryMonitor!.tick();
          })().catch((error: Error) => log(`Battery tracking failed: ${error.message}`));
        }, settings.battery.checkIntervalMinutes * 60_000);
        log(`Battery tracking active: warning <=${settings.battery.lowPercent}%, critical <=${settings.battery.criticalPercent}%, checking every ${settings.battery.checkIntervalMinutes} minutes.`);
      }
    }
    const readiness = await client.waitForRealtime({ timeoutMs: 15_000 });
    log(`Event connection: ${readiness.state}; push ready=${readiness.push.ready}, failed=${readiness.push.failed}, pending=${readiness.push.pending}`);
    if (readiness.push.ready === 0) {
      log('Push is not ready. Motion recording is unverified; check for events before relying on it.');
    }
    log(command === 'events' ? 'Listening for detections. Walk in front of a camera. Ctrl+C stops.' : 'Watching selected cameras. Ctrl+C stops.');
    if (!abort.signal.aborted) await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
  } finally {
    accepting = false;
    abort.abort();
    if (stopTimer) clearInterval(stopTimer);
    if (batteryTimer) clearInterval(batteryTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    await cleanup;
    await batteryMonitor?.flush();
    await routerPresence?.stop();
    automationApi?.closeAllConnections();
    await automations.flush();
    await Promise.allSettled([...active.values()].map((item) => item.done));
    await client.disconnect();
    await instance?.release();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
