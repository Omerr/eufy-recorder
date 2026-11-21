import net from 'node:net';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Device } from '@mega-yfue/eufy-sdk';
import { connectAsync } from 'mqtt';
import type { AutomationDevice } from './automation.ts';
import { YotoAuth } from './yoto-auth.ts';
import { yotoCatalog } from './yoto-catalog.ts';

export async function yeelightOn(host: string, port = 55443, signal = AbortSignal.timeout(12_000)): Promise<string> {
  return yeelightRequest(host, port, signal, true);
}

export async function yeelightStatus(host: string, port = 55443, signal = AbortSignal.timeout(12_000)): Promise<string> {
  return yeelightRequest(host, port, signal, false);
}

async function yeelightRequest(host: string, port: number, signal: AbortSignal, turnOn: boolean): Promise<string> {
  try { return await yeelightAttempt(host, port, signal, turnOn); }
  catch (error) {
    if (signal.aborted) throw error;
    await delay(300, undefined, { signal });
    // Retrying is safe: read the current power state again, then set on explicitly.
    return await yeelightAttempt(host, port, signal, turnOn);
  }
}

async function yeelightAttempt(host: string, port: number, signal: AbortSignal, turnOn: boolean): Promise<string> {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(5000, () => socket.destroy(new Error('Yeelight request timed out.')));
  let buffer = '';
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown[]) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const call of pending.values()) call.reject(error); pending.clear(); };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Yeelight connection closed.')));
  socket.on('data', (data) => {
    buffer += data.toString('utf8');
    if (buffer.length > 65_536) { socket.destroy(new Error('Yeelight reply is too large.')); return; }
    while (buffer.includes('\r\n')) {
      const at = buffer.indexOf('\r\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 2);
      try {
        const reply = JSON.parse(line);
        const call = pending.get(reply.id);
        if (!call) continue;
        pending.delete(reply.id);
        if (reply.error || !Array.isArray(reply.result)) call.reject(new Error('Yeelight rejected the command.'));
        else call.resolve(reply.result);
      } catch { fail(new Error('Invalid Yeelight response.')); }
    }
  });
  const aborted = () => socket.destroy(new Error('Yeelight request cancelled or timed out.'));
  signal.addEventListener('abort', aborted, { once: true });
  const request = (method: string, params: unknown[]) => new Promise<unknown[]>((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.write(JSON.stringify({ id, method, params }) + '\r\n');
  });
  try {
    signal.throwIfAborted();
    await once(socket, 'connect', { signal });
    await delay(100, undefined, { signal });
    const power = await request('get_prop', ['power']);
    if (!turnOn && ['on', 'off'].includes(String(power[0]))) return power[0] === 'on' ? 'reachable; light on' : 'reachable; light off (standby)';
    if (power[0] === 'on') return 'already on';
    if (power[0] !== 'off') throw new Error('Yeelight power state is unknown.');
    signal.throwIfAborted();
    const result = await request('set_power', ['on', 'smooth', 300]);
    if (result[0] !== 'ok') throw new Error('Yeelight did not acknowledge power-on.');
    return 'turned on';
  } finally { signal.removeEventListener('abort', aborted); socket.destroy(); }
}

export function validateCameraAudio(bytes: Buffer): number {
  let position = 0, frames = 0;
  while (position < bytes.length) {
    if (position + 7 > bytes.length || bytes[position] !== 255 || (bytes[position + 1] & 0xf0) !== 0xf0) throw new Error('Audio must contain complete AAC ADTS frames.');
    const profile = (bytes[position + 2] >> 6) & 3;
    const rateIndex = (bytes[position + 2] >> 2) & 15;
    const channels = ((bytes[position + 2] & 1) << 2) | (bytes[position + 3] >> 6);
    const length = ((bytes[position + 3] & 3) << 11) | (bytes[position + 4] << 3) | (bytes[position + 5] >> 5);
    if (profile !== 1 || rateIndex !== 8 || channels !== 1) throw new Error('Camera audio must be AAC-LC, 16 kHz, mono.');
    if (length < 7 || position + length > bytes.length) throw new Error('Audio contains an incomplete AAC frame.');
    if (length > 640) throw new Error('An audio frame exceeds the camera limit. Re-encode at 16 kbps.');
    position += length; frames++;
  }
  if (!frames) throw new Error('The audio file contains no AAC frames.');
  return frames;
}

async function openUntilAborted<T>(opening: Promise<T>, signal: AbortSignal, close: (value: T) => void | Promise<void>): Promise<T> {
  void opening.then((value) => { if (signal.aborted) void Promise.resolve(close(value)).catch(() => {}); }, () => {});
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(new Error('Camera audio cancelled.'));
    if (signal.aborted) { cancelled(); return; }
    signal.addEventListener('abort', cancelled, { once: true });
    void opening.then((value) => { signal.removeEventListener('abort', cancelled); resolve(value); }, (error) => { signal.removeEventListener('abort', cancelled); reject(error); });
  });
}

export async function cameraAudio(device: Device | undefined, filename: string, signal: AbortSignal): Promise<string> {
  const camera = device?.camera?.();
  if (!camera?.talkback || !camera.live) throw new Error('This camera has no verified talkback path.');
  const info = await stat(filename);
  if (!info.isFile() || info.size === 0 || info.size > 2_000_000) throw new Error('Choose a short AAC audio file.');
  validateCameraAudio(await readFile(filename));
  signal.throwIfAborted();
  const live = await openUntilAborted(camera.live(), signal, (value) => value.stop());
  try {
    // A transport acknowledgment can precede an audible media session. Start the
    // reverse audio path only after this camera has actually sent a video keyframe.
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => finish(new Error('Camera warm-up cancelled.'));
      const finish = (error?: Error) => {
        signal.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve();
      };
      live.on('video', (frame) => { if (frame.keyframe) finish(); });
      live.on('error', (error) => finish(error));
      live.on('stop', () => finish(new Error('Camera media stopped before playback.')));
      if (signal.aborted) cancelled(); else signal.addEventListener('abort', cancelled, { once: true });
    });
    const talk = await openUntilAborted(camera.talkback(), signal, (value) => value.stop());
    const aborted = () => { void talk.stop().catch(() => {}); };
    signal.addEventListener('abort', aborted, { once: true });
    try {
      signal.throwIfAborted();
      if (talk.codec !== 'aac-lc') throw new Error('This audio adapter requires an AAC-LC speaker.');
      let finished = false;
      const done = new Promise<void>((resolve, reject) => {
        talk.on('finished', () => { finished = true; resolve(); });
        talk.on('error', reject);
        talk.on('stop', () => { if (!finished) reject(new Error('Camera audio stopped before completion.')); });
      });
      await Promise.all([pipeline(createReadStream(filename), talk.writable(), { signal }), done]);
      return 'audio sent to camera';
    } finally { signal.removeEventListener('abort', aborted); await talk.stop(); }
  } finally { live.stop(); }
}

export async function yotoPlay(
  device: Extract<AutomationDevice, { type: 'yoto' }>, accessToken: string, signal: AbortSignal,
  connector: typeof connectAsync = connectAsync, statusOnly = false,
): Promise<string> {
  signal.throwIfAborted();
  const id = device.deviceId;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid Yoto player ID.');
  const client = await connector('wss://aqrphjqbp3u2z-ats.iot.eu-west-2.amazonaws.com/mqtt', {
    username: `${id}?x-amz-customauthorizer-name=PublicJWTAuthorizer`, password: accessToken,
    clientId: `DASH${id}`, port: 443, protocol: 'wss', keepalive: 30,
    ALPNProtocols: ['x-amzn-mqtt-ca'], reconnectPeriod: 0, connectTimeout: 10_000,
    queueQoSZero: false,
  });
  const stop = () => { void client.endAsync(true); };
  signal.addEventListener('abort', stop, { once: true });
  client.on('error', () => {});
  try {
    signal.throwIfAborted();
    const responseTopic = `device/${id}/response`;
    const eventsTopic = `device/${id}/data/events`;
    await client.subscribeAsync([responseTopic, eventsTopic]);
    {
      const status = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Yoto is unreachable: no live status reply. Check its power and Wi-Fi.')), 7000);
        const cancelled = () => finish(new Error('Yoto request cancelled.'));
        const received = (topic: string, bytes: Buffer, packet?: { retain?: boolean }) => {
          if (topic !== eventsTopic || packet?.retain) return;
          try { const value = JSON.parse(bytes.toString()); if (typeof value.playbackStatus === 'string') finish(undefined, value.playbackStatus); } catch {}
        };
        const finish = (error?: Error, state = '') => {
          clearTimeout(timer); client.removeListener('message', received); signal.removeEventListener('abort', cancelled);
          if (error) reject(error); else resolve(state);
        };
        client.on('message', received); signal.addEventListener('abort', cancelled, { once: true });
        if (signal.aborted) { cancelled(); return; }
        client.publish(`device/${id}/command/events/request`, '{}', { qos: 1 }, (error) => { if (error) finish(error); });
      });
      if (statusOnly && ['playing', 'paused', 'stopped'].includes(status)) return `reachable; ${status}${status === 'stopped' ? ' (standby)' : ''}`;
      if (status === 'playing' && device.skipIfPlaying !== false) return 'already playing; current playback preserved';
      if (!['playing', 'paused', 'stopped'].includes(status)) throw new Error('Yoto playback state is unknown.');
    }
    const send = async (resource: string, operation: string, body: object): Promise<void> => {
      signal.throwIfAborted();
      const payload = JSON.stringify(body);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Yoto did not acknowledge ${resource}/${operation}.`)), 7000);
        const cancelled = () => finish(new Error('Yoto command cancelled.'));
        const received = (topic: string, bytes: Buffer) => {
          if (topic !== responseTopic) return;
          try {
            const status = JSON.parse(bytes.toString()).status;
            if (status?.req_body && !isDeepStrictEqual(JSON.parse(status.req_body), body)) return;
            // Player firmware uses these names; the public schema also documents
            // the shorter resource names. Accept both after matching the request.
            const acknowledgement = status?.[resource] ?? status?.[resource === 'card' ? 'card-play' : `${operation}-${resource}`];
            if (acknowledgement === 'OK') finish();
            else if (acknowledgement === 'FAIL') finish(new Error('Yoto rejected the command.'));
          } catch { /* Ignore unrelated player messages. */ }
        };
        const finish = (error?: Error) => {
          clearTimeout(timer); client.removeListener('message', received); signal.removeEventListener('abort', cancelled);
          if (error) reject(error); else resolve();
        };
        client.on('message', received);
        signal.addEventListener('abort', cancelled, { once: true });
        client.publish(`device/${id}/command/${resource}/${operation}`, payload, { qos: 1 }, (error) => { if (error) finish(error); });
      });
    };
    if (device.volume !== undefined) await send('volume', 'set', { volume: device.volume });
    signal.throwIfAborted();
    await send('card', 'start', { uri: device.cardUri });
    return 'Yoto playback acknowledged';
  } finally { signal.removeEventListener('abort', stop); await client.endAsync(true); }
}

export class Actions {
  private root: string;
  private devices: Map<string, Device>;
  private yoto: YotoAuth;
  private busy = new Set<string>();
  private yotoWork: Promise<unknown> = Promise.resolve();
  private async withYoto<T>(operation: () => Promise<T>): Promise<T> {
    // A player uses one MQTT client identity. Serialize probes and playback so
    // a readiness check cannot disconnect an action that is already running.
    const work = this.yotoWork.then(operation, operation);
    this.yotoWork = work.catch(() => {});
    return work;
  }
  constructor(root: string, stateDir: string, devices: Map<string, Device>) {
    this.root = root; this.devices = devices; this.yoto = new YotoAuth(path.join(stateDir, 'yoto-session.json'));
  }
  async yotoChoices(signal: AbortSignal) {
    const token = process.env.YOTO_ACCESS_TOKEN || await this.yoto.accessToken();
    return yotoCatalog(token, signal);
  }
  async checkDevice(device: AutomationDevice, signal: AbortSignal): Promise<string> {
    if (device.type === 'yeelight') return yeelightStatus(device.host, device.port, signal);
    if (device.type === 'yoto') return this.withYoto(async () => yotoPlay(device, process.env[device.tokenEnv] || await this.yoto.accessToken(), signal, connectAsync, true));
    throw new Error('This device needs a manual functional test.');
  }
  async execute(name: string, device: AutomationDevice, signal: AbortSignal): Promise<string> {
    if (this.busy.has(name)) return 'already handling another event';
    this.busy.add(name);
    try {
      switch (device.type) {
        case 'yeelight': return await yeelightOn(device.host, device.port, signal);
        case 'eufy-audio': return await cameraAudio(this.devices.get(device.camera), path.resolve(this.root, device.file), signal);
        case 'yoto': return await this.withYoto(async () => yotoPlay(device, process.env[device.tokenEnv] || await this.yoto.accessToken(), signal));
        case 'webhook': {
          const token = device.tokenEnv ? process.env[device.tokenEnv] : undefined;
          if (device.tokenEnv && !token) throw new Error('Webhook token is not configured.');
          const response = await fetch(device.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(device.body || { action: 'on' }), signal, redirect: 'error',
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error('Webhook rejected the action.');
          return 'webhook acknowledged';
        }
      }
    } finally { this.busy.delete(name); }
  }
}
