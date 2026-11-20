import net from 'node:net';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Device } from '@mega-yfue/eufy-sdk';
import { connectAsync } from 'mqtt';
import type { AutomationDevice } from './automation.ts';
import { YotoAuth } from './yoto-auth.ts';

export async function yeelightOn(host: string, port = 55443, signal = AbortSignal.timeout(12_000)): Promise<string> {
  try { return await yeelightAttempt(host, port, signal); }
  catch (error) {
    if (signal.aborted) throw error;
    await delay(300, undefined, { signal });
    // Retrying is safe: read the current power state again, then set on explicitly.
    return await yeelightAttempt(host, port, signal);
  }
}

async function yeelightAttempt(host: string, port: number, signal: AbortSignal): Promise<string> {
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

async function cameraAudio(device: Device | undefined, filename: string, signal: AbortSignal): Promise<string> {
  const camera = device?.camera?.();
  if (!camera?.talkback) throw new Error('This camera has no verified talkback path.');
  const info = await stat(filename);
  if (!info.isFile() || info.size === 0 || info.size > 2_000_000) throw new Error('Choose a short AAC audio file.');
  validateCameraAudio(await readFile(filename));
  signal.throwIfAborted();
  const opening = camera.talkback();
  void opening.then((talk) => { if (signal.aborted) void talk.stop().catch(() => {}); }, () => {});
  const talk = await new Promise<Awaited<typeof opening>>((resolve, reject) => {
    const cancelled = () => reject(new Error('Camera audio cancelled.'));
    if (signal.aborted) { cancelled(); return; }
    signal.addEventListener('abort', cancelled, { once: true });
    void opening.then((value) => { signal.removeEventListener('abort', cancelled); resolve(value); }, (error) => { signal.removeEventListener('abort', cancelled); reject(error); });
  });
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
}

export async function yotoPlay(
  device: Extract<AutomationDevice, { type: 'yoto' }>, accessToken: string, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const id = device.deviceId;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid Yoto player ID.');
  const client = await connectAsync('wss://aqrphjqbp3u2z-ats.iot.eu-west-2.amazonaws.com/mqtt', {
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
    await client.subscribeAsync(responseTopic);
    const send = async (resource: string, operation: string, body: object): Promise<void> => {
      signal.throwIfAborted();
      const payload = JSON.stringify(body);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Yoto did not acknowledge the command.')), 7000);
        const cancelled = () => finish(new Error('Yoto command cancelled.'));
        const received = (topic: string, bytes: Buffer) => {
          if (topic !== responseTopic) return;
          try {
            const status = JSON.parse(bytes.toString()).status;
            if (status?.req_body && JSON.stringify(JSON.parse(status.req_body)) !== payload) return;
            if (status?.[resource] === 'OK') finish();
            else if (status?.[resource] === 'FAIL') finish(new Error('Yoto rejected the command.'));
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
  constructor(root: string, stateDir: string, devices: Map<string, Device>) {
    this.root = root; this.devices = devices; this.yoto = new YotoAuth(path.join(stateDir, 'yoto-session.json'));
  }
  async execute(name: string, device: AutomationDevice, signal: AbortSignal): Promise<string> {
    if (this.busy.has(name)) return 'already handling another event';
    this.busy.add(name);
    try {
      switch (device.type) {
        case 'yeelight': return await yeelightOn(device.host, device.port, signal);
        case 'eufy-audio': return await cameraAudio(this.devices.get(device.camera), path.resolve(this.root, device.file), signal);
        case 'yoto': return await yotoPlay(device, process.env[device.tokenEnv] || await this.yoto.accessToken(), signal);
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
