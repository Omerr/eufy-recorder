import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const history = process.argv.includes('--history');
const messageIndex = process.argv.indexOf('--message');
const roots = new Set([
  '.gitignore', 'LICENSE', 'README.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'recorder.example.json', 'automation.example.json',
  'Start-Recorder.ps1', 'Stop-Recorder.ps1', 'Run-Background.ps1', 'Install-Startup.ps1',
]);
const fixtureHash = '838cda29ae2a70671c3e3ee4e56edb12e654b461cddb1aec344434eee6d462bb';
const allowed = (name) => roots.has(name) ||
  /^src\/[a-zA-Z0-9_/-]+\.ts$/.test(name) ||
  /^test\/[a-zA-Z0-9_/-]+\.test\.ts$/.test(name) ||
  /^scripts\/[a-zA-Z0-9_-]+\.mjs$/.test(name) ||
  /^docs\/[a-zA-Z0-9_/-]+\.md$/.test(name) ||
  /^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/.test(name) ||
  ['.githooks/pre-commit', '.githooks/pre-push', '.githooks/commit-msg', 'test/fixtures/video.mp4'].includes(name);

// Runtime values are used locally for comparison and never printed or committed.
const privateValues = [];
const localFile = path.resolve('recorder.json');
if (existsSync(localFile)) {
  const config = JSON.parse(readFileSync(localFile, 'utf8').replace(/^\uFEFF/, ''));
  function visit(value, key = '') {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
    if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => visit(v, k));
    if (typeof value === 'string' && value.length >= 6 && /camera|serial|topic|password|token|ssid|mac|deviceId/i.test(key) && !value.startsWith('env:')) {
      privateValues.push(value);
    }
  }
  visit(config);
}
const patterns = [
  ['camera serial', /\bT[0-9A-Z]{15}\b/g],
  ['live notification topic', /\beufy-[a-f0-9]{32}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['private network address', /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g],
  ['personal home path', /(?:\/home\/(?!example\b|runner\b)[a-zA-Z0-9_-]+|C:\\Users\\(?!Example\b|Public\b)[a-zA-Z0-9_-]+)/g],
];
const findings = [];
const seen = new Set();
function check(name, bytes, metadata = false) {
  const identity = name + ':' + createHash('sha256').update(bytes).digest('hex');
  if (seen.has(identity)) return;
  seen.add(identity);
  if (!metadata && !allowed(name)) { findings.push(`${name}: file is outside the public source allowlist`); return; }
  if (name === 'test/fixtures/video.mp4') {
    if (createHash('sha256').update(bytes).digest('hex') !== fixtureHash) findings.push(`${name}: synthetic fixture hash changed`);
    return;
  }
  if (bytes.includes(0)) { findings.push(`${name}: unexpected binary content`); return; }
  const text = bytes.toString('utf8');
  for (const value of privateValues) if (text.includes(value)) findings.push(`${name}: matches a local private configuration value`);
  for (const [label, expression] of patterns) {
    expression.lastIndex = 0;
    if (expression.test(text)) findings.push(`${name}: possible ${label}`);
  }
  const emails = text.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  for (const raw of emails) {
    const email = raw.replace(/^'+/, '');
    if (!/@(?:example\.(?:com|net|org|invalid)|(?:[a-z0-9-]+\.)?example|users\.noreply\.github\.com)$/.test(email) && email !== 'noreply@github.com') {
      findings.push(`${name}: possible personal email address`);
    }
  }
}

if (messageIndex >= 0) {
  check('commit message', readFileSync(process.argv[messageIndex + 1]), true);
} else if (history) {
  const objects = git('rev-list', '--objects', '--all').toString().trim().split('\n').filter(Boolean);
  for (const row of objects) {
    const at = row.indexOf(' ');
    if (at < 0) continue;
    const oid = row.slice(0, at), name = row.slice(at + 1);
    if (git('cat-file', '-t', oid).toString().trim() === 'blob') check(name, git('cat-file', 'blob', oid));
  }
  for (const email of git('log', '--all', '--format=%ae%n%ce').toString().split('\n').filter(Boolean)) {
    if (!/@users\.noreply\.github\.com$/.test(email) && email !== 'noreply@github.com') findings.push('Commit metadata: use a GitHub noreply email address');
  }
  check('commit metadata', git('log', '--all', '--format=%an%n%ae%n%cn%n%ce%n%B'), true);
} else {
  for (const name of git('ls-files', '-z').toString().split('\0').filter(Boolean)) {
    check(name, git('show', `:${name}`));
  }
}
if (findings.length) {
  console.error('Public-source check blocked publication:');
  for (const finding of new Set(findings)) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Public-source check passed (${seen.size} file versions inspected).`);
}
