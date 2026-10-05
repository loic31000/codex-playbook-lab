import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

export const SPIKE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const LAB_ROOT = path.resolve(SPIKE_ROOT, '..', '..');
export const FIXTURE_ROOT = path.join(LAB_ROOT, 'fixtures', 'app-exec-spike-target');
export const LAB_SENTINEL = path.join(LAB_ROOT, 'fixtures', 'app-exec-spike-lab-sentinel.txt');
export const CODEX_VERSION = '0.160.0';
export const IMAGE_NAME = `codex-playbook-app-exec-spike:${CODEX_VERSION}`;
export const ENVIRONMENT_ID = 'docker-target';
export const TARGET_CWD = '/workspace';
export const REQUIRED_DIRECT_SCOPES = ['resource.invoke', 'chatgpt.tokens.use.direct'];
export const FORBIDDEN_SECRET_ENV = /(?:OPENAI_API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|OAUTH|CODEX_API_KEY|GITHUB_TOKEN|GH_TOKEN|SSH_AUTH_SOCK)/i;

export function assertPinnedCodexVersion(versionOutput) {
  const actual = String(versionOutput).trim();
  const expected = `codex-cli ${CODEX_VERSION}`;
  if (actual !== expected) {
    throw new Error(`Ce spike exige ${expected}; version observée : ${actual || 'inconnue'}. Revalidez le routage avant mise à jour.`);
  }
  return actual;
}

export class SensitiveValue {
  #value;

  constructor(value, label = 'credential') {
    if (typeof value !== 'string' || value.length < 16) throw new Error(`${label} absent ou invalide`);
    this.#value = value;
    this.label = label;
  }

  reveal() { return this.#value; }
  toJSON() { return `[REDACTED:${this.label}]`; }
  toString() { return `[REDACTED:${this.label}]`; }
  [util.inspect.custom]() { return this.toString(); }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function treeFingerprint(root) {
  const records = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) records.push(`${relative}\0${sha256(await fs.readFile(absolute))}`);
    }
  }
  await visit(root);
  return sha256(records.join('\n'));
}

export function redact(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    const raw = secret instanceof SensitiveValue ? secret.reveal() : secret;
    if (typeof raw === 'string' && raw) text = text.split(raw).join('[REDACTED]');
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access_token|refresh_token|id_token|OPENAI_API_KEY|ACCESS_TOKEN)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[REDACTED]');
}

export function containsSecret(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return secrets.some((secret) => {
    const raw = secret instanceof SensitiveValue ? secret.reveal() : secret;
    return typeof raw === 'string' && raw.length > 0 && text.includes(raw);
  });
}

export function mountPolicyViolations(mounts, forbiddenRoots) {
  const normalizedRoots = forbiddenRoots.map((root) => path.resolve(root).replaceAll('\\', '/').toLowerCase());
  return mounts.flatMap((mount) => {
    if (mount.Type !== 'bind') return [];
    const source = String(mount.Source ?? '').replaceAll('\\', '/').toLowerCase();
    return normalizedRoots.some((root) => source === root || source.startsWith(`${root}/`)) ? [mount.Source] : [];
  });
}

export function assessSecurityProbe(report) {
  const forbiddenMatches = [
    ...(report.labSentinelMatches ?? []),
    ...(report.fakeOauthMatches ?? []),
    ...(report.fakeAuthMatches ?? []),
    ...(report.realAuthMatches ?? []),
    ...(report.labContentMatches ?? []),
    ...(report.fakeOauthContentMatches ?? []),
    ...(report.fakeAuthContentMatches ?? []),
  ];
  return {
    targetReadable: report.targetReadable === true,
    targetWritable: report.targetWritable === true,
    labInaccessible: forbiddenMatches.length === 0,
    hostHomeInaccessible: report.hostHomeVisible !== true,
    authJsonInaccessible: (report.realAuthMatches ?? []).length === 0,
    oauthInaccessible: (report.secretEnvNames ?? []).length === 0,
    fakeOauthInaccessible: (report.fakeOauthMatches ?? []).length === 0,
    labContentInaccessible: (report.labContentMatches ?? []).length === 0,
    fakeOauthContentInaccessible: (report.fakeOauthContentMatches ?? []).length === 0,
    fakeAuthContentInaccessible: (report.fakeAuthContentMatches ?? []).length === 0,
    dockerSocketInaccessible: report.dockerSocketVisible !== true,
    secretEnvAbsent: (report.secretEnvNames ?? []).length === 0,
  };
}

export function securityProbePassed(report) {
  return Object.values(assessSecurityProbe(report)).every(Boolean);
}

export function safeEvidence(value, secrets = []) {
  if (containsSecret(value, secrets)) throw new Error('Un credential aurait été sérialisé dans les preuves');
  const json = JSON.stringify(value, null, 2);
  if (/Bearer\s+[A-Za-z0-9._~+\/-]{16,}/i.test(json)) throw new Error('Bearer token détecté dans les preuves');
  return `${json}\n`;
}
