import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eufy-launcher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(path.join(root, 'Start-Recorder.ps1'), path.join(directory, 'Start-Recorder.ps1'));
  await copyFile(path.join(root, 'recorder.example.json'), path.join(directory, 'recorder.example.json'));
  await copyFile(path.join(root, 'automation.example.json'), path.join(directory, 'automation.example.json'));
  return directory;
}

function launch(directory: string, mode: string, prompts: string) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `${prompts}\n& ${quote(path.join(directory, 'Start-Recorder.ps1'))} ${mode}`,
  ], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, LOCALAPPDATA: path.join(directory, 'appdata') },
  });
}

test('ntfy setup works before camera setup and creates the missing config', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await workspace(t);
  const result = launch(directory, 'ntfy-setup', `
    function global:Read-Host {
      param([string]$Prompt, [switch]$AsSecureString)
      if ($AsSecureString) { return (New-Object System.Security.SecureString) }
      if ($Prompt -like 'ntfy server*') { return 'https://ntfy.example' }
      if ($Prompt -like 'ntfy topic*') { return 'camera-test-topic' }
      throw "Unexpected prompt: $Prompt"
    }
  `);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const config = JSON.parse((await readFile(path.join(directory, 'recorder.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(config.ntfy.server, 'https://ntfy.example');
  assert.equal(config.ntfy.topic, 'camera-test-topic');
  assert.deepEqual(config.cameras, []);
  assert.match(result.stdout, /Subscribe to https:\/\/ntfy\.example\/camera-test-topic/);
});

test('camera setup confirms country and preserves a previously configured ntfy topic', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await workspace(t);
  const config = JSON.parse(await readFile(path.join(directory, 'recorder.example.json'), 'utf8'));
  config.ntfy = { server: 'https://ntfy.example', topic: 'keep-this-topic' };
  await writeFile(path.join(directory, 'recorder.json'), JSON.stringify(config));
  await mkdir(path.join(directory, 'node_modules', '@mega-yfue', 'eufy-sdk'), { recursive: true });
  await mkdir(path.join(directory, 'src'));
  // Replace the camera client only in this temporary test workspace; no login is made.
  await writeFile(path.join(directory, 'src', 'cli.ts'), 'console.log("Local setup probe finished.");');
  const result = launch(directory, 'setup', `
    function global:Read-Host {
      param([string]$Prompt, [switch]$AsSecureString)
      if ($AsSecureString) { return (ConvertTo-SecureString 'test-only-password' -AsPlainText -Force) }
      if ($Prompt -like 'Two-letter country*') { return 'US' }
      if ($Prompt -eq 'Eufy account email') { return 'test@example.invalid' }
      throw "Unexpected prompt: $Prompt"
    }
  `);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saved = JSON.parse((await readFile(path.join(directory, 'recorder.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(saved.countryCode, 'US');
  assert.equal(saved.ntfy.topic, 'keep-this-topic');
  assert.equal(saved.battery.lowPercent, 30);
  assert.match(result.stdout, /Local setup probe finished/);
});

test('an encrypted automation token survives file newlines and loads into a child process', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await workspace(t);
  let result = launch(directory, 'automation-setup', '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  await mkdir(path.join(directory, 'node_modules', '@mega-yfue', 'eufy-sdk'), { recursive: true });
  await mkdir(path.join(directory, 'src'));
  await writeFile(path.join(directory, 'src', 'cli.ts'), 'if(process.env.EUFY_AUTOMATION_TOKEN?.length!==64)process.exit(1);console.log("api-token-ready");');
  result = launch(directory, 'ntfy-test', '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /api-token-ready/);
});

test('Yoto setup dispatches its internal login command without changing the validated mode', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await workspace(t);
  await copyFile(path.join(directory, 'recorder.example.json'), path.join(directory, 'recorder.json'));
  await mkdir(path.join(directory, 'node_modules', '@mega-yfue', 'eufy-sdk'), { recursive: true });
  await mkdir(path.join(directory, 'src'));
  await writeFile(path.join(directory, 'src', 'cli.ts'), 'if(process.argv[2]!=="yoto-login"||process.env.YOTO_CLIENT_ID!=="example-client")process.exit(1);console.log("yoto-login-dispatched");');
  const result = launch(directory, 'yoto-setup', `
    function global:Read-Host {
      param([string]$Prompt)
      if ($Prompt -eq 'Yoto public OAuth client ID') { return 'example-client' }
      throw "Unexpected prompt: $Prompt"
    }
  `);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /yoto-login-dispatched/);
});

test('readiness queries the running API without camera credentials and reports blockers', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await workspace(t);
  const setup = launch(directory, 'automation-setup', '');
  assert.equal(setup.status, 0, setup.stderr);
  const result = launch(directory, 'readiness', `
    function global:Invoke-RestMethod {
      param($Uri, $Method, $Headers, $ContentType, $Body, $TimeoutSec)
      if ($Uri -notlike '*/api/readiness' -or $Method -ne 'Post' -or $Body -ne '{}') { throw 'Unexpected API call' }
      if (-not $Headers.Authorization.StartsWith('Bearer ')) { throw 'Missing API authentication' }
      return [pscustomobject]@{ checkedAt='example-time'; ready=$false; note='No device action was run.'; checks=@(
        [pscustomobject]@{ name='Lamp'; status='ok'; detail='reachable; light off (standby)' },
        [pscustomobject]@{ name='Yoto'; status='failed'; detail='No live player reply.' }
      ) }
    }
  `);
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /off \(standby\)/);
  assert.match(result.stdout, /\[FAILED\] Yoto/);
});
