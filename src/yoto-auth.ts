import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

interface YotoSession {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class YotoAuth {
  private filename: string;
  private fetcher: typeof fetch;
  private refreshing?: Promise<string>;
  constructor(filename: string, fetcher: typeof fetch = fetch) { this.filename = filename; this.fetcher = fetcher; }

  async accessToken(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.loadOrRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async loadOrRefresh(): Promise<string> {
    let saved: YotoSession;
    try { saved = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch { throw new Error('Connect Yoto with Start-Recorder.ps1 yoto-setup first.'); }
    if (saved.accessToken && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now() + 60_000) return saved.accessToken;
    if (!saved.clientId || !saved.refreshToken) throw new Error('Yoto login needs renewal.');
    const token = await this.exchange({ grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.refreshToken });
    await this.save(saved.clientId, token);
    return token.access_token;
  }
  private async exchange(fields: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const response = await this.fetcher('https://login.yotoplay.com/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Yoto authentication failed (HTTP ${response.status}).`); }
    const token = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
    if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      throw new Error('Yoto did not return a renewable session; check offline_access permissions.');
    }
    return token;
  }
  private async save(clientId: string, token: { access_token: string; refresh_token: string; expires_in: number }): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const data: YotoSession = { clientId, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 };
    const temporary = `${this.filename}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    // Yoto refresh tokens are single-use; persist the replacement before returning it.
    await rename(temporary, this.filename);
  }

  async login(clientId: string, log: (message: string) => void): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(clientId)) throw new Error('Enter the public client ID from the Yoto developer portal.');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    const redirectUri = 'http://127.0.0.1:8787/callback';
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    const server = createServer((request, response) => {
      const url = new URL(request.url || '/', redirectUri);
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid callback.'); return; }
      const code = url.searchParams.get('code');
      if (!code) { response.writeHead(400).end('Authorization was not completed.'); rejectCode(new Error('Yoto authorization was not completed.')); return; }
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Yoto login received. Return to your terminal.');
      resolveCode(code);
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(8787, '127.0.0.1', resolve); });
    const timeout = setTimeout(() => rejectCode(new Error('Yoto login timed out.')), 5 * 60_000);
    try {
      const url = new URL('https://login.yotoplay.com/authorize');
      url.search = new URLSearchParams({
        audience: 'https://api.yotoplay.com', scope: 'family:devices:control family:library:view offline_access',
        response_type: 'code', client_id: clientId, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirectUri, state,
      }).toString();
      log('Open this URL in a browser on this Windows PC:');
      log(url.toString());
      const code = await codePromise;
      const token = await this.exchange({ grant_type: 'authorization_code', client_id: clientId, code_verifier: verifier, code, redirect_uri: redirectUri });
      await this.save(clientId, token);
      log('Yoto account connected. Session saved locally.');
    } finally {
      clearTimeout(timeout);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
