import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { AutomationEngine, Presence, automationConfig, type DetectionKind, type PresenceState } from './automation.ts';
import { controlPage } from './control-page.ts';
import type { RouterPresence } from './router.ts';
import type { YotoCatalog } from './yoto-catalog.ts';

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new Error('Request body exceeds 64 KB.');
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use a JSON object.');
  return value;
}

export async function startAutomationApi(options: {
  engine: AutomationEngine; presence: Presence; configFile: string;
  token: string; signal: AbortSignal; log: (message: string) => void;
  router?: RouterPresence;
  yotoChoices?: (signal: AbortSignal) => Promise<YotoCatalog>;
}): Promise<Server> {
  if (options.token.length < 32) throw new Error('Automation API token must have at least 32 characters.');
  const binding = options.engine.config().api;
  const expected = createHash('sha256').update(`Bearer ${options.token}`).digest();
  let saving: Promise<void> = Promise.resolve();
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    const reply = (status: number, value: unknown) => response.writeHead(status).end(JSON.stringify(value));
    if (request.method === 'GET' && request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Frame-Options', 'DENY');
      response.writeHead(200).end(controlPage);
      return;
    }
    const received = createHash('sha256').update(request.headers.authorization || '').digest();
    if (!timingSafeEqual(received, expected)) { reply(401, { error: 'Bearer token required.' }); return; }
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/state') {
        reply(200, { presence: options.presence.snapshot(options.engine.config().presenceMaxAgeMinutes), enabled: options.engine.config().enabled, lastEvent: options.engine.status(), speakerTest: options.engine.speakerTestStatus(), household: options.router?.status() || null });
      } else if (request.method === 'GET' && url.pathname === '/api/config') {
        reply(200, options.engine.config());
      } else if (request.method === 'GET' && url.pathname === '/api/yoto') {
        if (!options.yotoChoices) throw new Error('Yoto is not initialized.');
        reply(200, await options.yotoChoices(AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])));
      } else if (request.method === 'POST' && url.pathname === '/api/presence') {
        if (options.engine.config().household.enabled) throw new Error('Router household presence is active; phone reports cannot override it.');
        const value = await body(request);
        if (!['home', 'away', 'unknown'].includes(value.state as string)) throw new Error('state must be home, away, or unknown.');
        options.presence.update(value.state as PresenceState);
        options.engine.presenceChanged();
        options.log(`Phone presence: ${value.state}`);
        reply(200, options.presence.snapshot(options.engine.config().presenceMaxAgeMinutes));
      } else if (request.method === 'POST' && url.pathname === '/api/simulate') {
        const value = await body(request);
        if (!['motion', 'personDetected', 'strangerDetected'].includes(value.kind as string) || typeof value.camera !== 'string') {
          throw new Error('Supply kind and camera.');
        }
        const at = value.at === undefined ? new Date() : new Date(String(value.at));
        if (!Number.isFinite(at.getTime())) throw new Error('at must be an ISO timestamp.');
        if (value.presence !== undefined && !['home', 'away', 'unknown'].includes(value.presence as string)) throw new Error('Invalid simulation presence.');
        const decisions = options.engine.preview({ kind: value.kind as DetectionKind, camera: value.camera, at }, Date.now(), value.presence as PresenceState | undefined);
        reply(200, { dryRun: true, decisions });
      } else if (request.method === 'POST' && url.pathname === '/api/test') {
        const value = await body(request);
        if (typeof value.device !== 'string') throw new Error('Supply a device name.');
        reply(200, { result: await options.engine.testDevice(value.device) });
      } else if (request.method === 'POST' && url.pathname === '/api/speaker-test') {
        const value = await body(request);
        if (typeof value.device !== 'string') throw new Error('Supply a camera audio device name.');
        reply(200, options.engine.armSpeakerTest(value.device, value.expiresInSeconds === undefined ? 300 : Number(value.expiresInSeconds)));
      } else if (request.method === 'DELETE' && url.pathname === '/api/speaker-test') {
        options.engine.cancelSpeakerTest();
        reply(200, { cancelled: true });
      } else if (request.method === 'POST' && url.pathname === '/api/router/refresh') {
        await body(request);
        if (!options.router) throw new Error('Router monitoring is not initialized.');
        await options.router.refresh(true);
        reply(200, options.router.status());
      } else if (request.method === 'PUT' && url.pathname === '/api/config') {
        const value = automationConfig({ ...options.engine.config(), ...await body(request) });
        if (value.api.host !== binding.host || value.api.port !== binding.port || value.api.tokenEnv !== binding.tokenEnv) throw new Error('Changing API binding or token settings requires editing recorder.json and restarting.');
        const save = saving.then(async () => {
          const original = JSON.parse((await readFile(options.configFile, 'utf8')).replace(/^\uFEFF/, ''));
          original.automations = value;
          const temporary = `${options.configFile}.tmp`;
          await writeFile(temporary, JSON.stringify(original, null, 2) + '\n', { mode: 0o600 });
          await rename(temporary, options.configFile);
          if (JSON.stringify(options.engine.config().household) !== JSON.stringify(value.household)) options.presence.update('unknown');
          options.engine.configure(value);
          void options.router?.refresh().catch(() => options.log('Router presence refresh failed.'));
        });
        saving = save.catch(() => {});
        await save;
        reply(200, { saved: true });
      } else {
        reply(404, { error: 'Unknown endpoint.' });
      }
    } catch (error) {
      if (!response.headersSent) reply(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(binding.port, binding.host, resolve); });
  options.log(`Automation API listening on ${binding.host}:${binding.port}; bearer authentication required.`);
  options.signal.addEventListener('abort', () => { server.close(); server.closeAllConnections(); }, { once: true });
  return server;
}
