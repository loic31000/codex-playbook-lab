import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { REQUIRED_DIRECT_SCOPES, SensitiveValue, redact } from './spike-support.mjs';

export const ISSUER = 'https://auth.openai.com';
export const AUTHORIZATION_ENDPOINT = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
export const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
export const RESOURCE = 'https://api.openai.com/v1';
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const REQUESTED_SCOPES = [
  'openid', 'profile', 'email', 'offline_access', ...REQUIRED_DIRECT_SCOPES,
];

function stateDirectory() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'CodexPlaybookLab', 'app-exec-oauth');
}

export function oauthPaths() {
  const root = stateDirectory();
  return {
    root,
    metadata: path.join(root, 'profile.json'),
    encryptedCredentials: path.join(root, 'credentials.dpapi'),
    host: path.join(root, 'host.json'),
  };
}

export function requireNoApiKeyEnvironment(env = process.env) {
  const names = ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZUREAI_OPENAI_API_KEY'];
  const present = names.filter((name) => typeof env[name] === 'string' && env[name].trim());
  if (present.length) throw new Error(`API key interdite pour ce spike : ${present.join(', ')}`);
}

async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

function runPowerShellWithInput(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Protection DPAPI impossible (code ${code}) : ${redact(stderr)}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

export async function dpapiProtect(plaintext) {
  if (process.platform !== 'win32') throw new Error('Ce spike implémente uniquement le stockage DPAPI Windows');
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$encoded=[Console]::In.ReadToEnd()',
    '$plain=[Convert]::FromBase64String($encoded)',
    '$cipher=[System.Security.Cryptography.ProtectedData]::Protect($plain,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($cipher))',
  ].join(';');
  return runPowerShellWithInput(script, Buffer.from(plaintext, 'utf8').toString('base64'));
}

export async function dpapiUnprotect(ciphertext) {
  if (process.platform !== 'win32') throw new Error('Ce spike implémente uniquement le stockage DPAPI Windows');
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$encoded=[Console]::In.ReadToEnd()',
    '$cipher=[Convert]::FromBase64String($encoded)',
    '$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($plain))',
  ].join(';');
  const encoded = await runPowerShellWithInput(script, ciphertext);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function getOrCreateHostId() {
  const { host } = oauthPaths();
  try {
    const saved = await readJson(host);
    if (/^urn:uuid:[0-9a-f-]{36}$/i.test(saved.ext_agent_host_id)) return saved.ext_agent_host_id;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const value = `urn:uuid:${crypto.randomUUID()}`;
  await atomicWrite(host, `${JSON.stringify({ ext_agent_host_id: value }, null, 2)}\n`);
  return value;
}

async function saveSession(metadata, tokens) {
  const files = oauthPaths();
  const plaintext = JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
  });
  const encrypted = await dpapiProtect(plaintext);
  await atomicWrite(files.encryptedCredentials, `${encrypted}\n`);
  await atomicWrite(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function loadSession() {
  const files = oauthPaths();
  const [metadata, encrypted] = await Promise.all([
    readJson(files.metadata),
    fs.readFile(files.encryptedCredentials, 'utf8'),
  ]);
  const tokens = JSON.parse(await dpapiUnprotect(encrypted.trim()));
  return { metadata, tokens };
}

export function buildAuthorizationUrl({ clientId, hostId, redirectUri, state, nonce, challenge, idTokenHint }) {
  const parameters = new URLSearchParams({
    client_id: clientId,
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: REQUESTED_SCOPES.join(' '),
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  if (clientId === DYNAMIC_CLIENT_ID) parameters.set('agent_name_hint', 'codex_playbook_lab');
  else if (idTokenHint) parameters.set('id_token_hint', idTokenHint);
  return `${AUTHORIZATION_ENDPOINT}?${parameters}`;
}

async function postToken(form) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OAuth HTTP ${response.status} : ${redact(body)}`);
  return body;
}

async function validateIdToken(idToken, clientId, nonce) {
  const options = { issuer: ISSUER, audience: clientId };
  const { payload } = await jwtVerify(idToken, createRemoteJWKSet(new URL(JWKS_URI)), options);
  if (!payload.sub) throw new Error('ID token OAuth sans subject');
  if (nonce !== null && payload.nonce !== nonce) throw new Error('Nonce OIDC invalide');
  return payload;
}

function tokenSetFromResponse(data, fallbackIdToken = null) {
  const idToken = data.id_token ?? fallbackIdToken;
  for (const [name, value] of Object.entries({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    id_token: idToken,
  })) {
    if (typeof value !== 'string' || !value) throw new Error(`Réponse OAuth sans ${name}`);
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token, id_token: idToken };
}

function metadataFromResponse(data, { clientId, hostId, subject, fallbackScopes = [] }) {
  const scopes = String(data.scope ?? fallbackScopes.join(' ')).split(/\s+/).filter(Boolean).sort();
  const missing = REQUESTED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new Error(`Scopes ChatGPT-plan non accordés : ${missing.join(', ')}`);
  const expiresIn = Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Réponse OAuth sans expires_in valide');
  return {
    version: 1,
    client_id: clientId,
    ext_agent_host_id: hostId,
    subject,
    scopes,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    earliest_refresh_at: data.earliest_refresh_at ?? null,
    saved_at: new Date().toISOString(),
  };
}

function openBrowser(url) {
  const script = 'Start-Process -FilePath ([Console]::In.ReadToEnd())';
  return runPowerShellWithInput(script, url);
}

async function waitForCallback(transaction, timeoutMs = 300_000) {
  let finish;
  let timeout;
  const callback = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Authorization received. You can close this window.');
    finish.resolve(Object.fromEntries(url.searchParams));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const url = buildAuthorizationUrl({ ...transaction, redirectUri });
  try {
    await openBrowser(url);
    return { redirectUri, result: await Promise.race([
      callback,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timeout OAuth après 5 minutes')), timeoutMs);
      }),
    ]) };
  } finally {
    clearTimeout(timeout);
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function signIn() {
  requireNoApiKeyEnvironment();
  const hostId = await getOrCreateHostId();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const { redirectUri, result } = await waitForCallback({
    clientId: DYNAMIC_CLIENT_ID, hostId, state, nonce, challenge,
  });
  if (result.state !== state) throw new Error('State OAuth invalide');
  if (result.error) throw new Error(`Autorisation OAuth refusée : ${redact(result.error)}`);
  const clientId = result.client_id;
  if (!result.code || !clientId || clientId === DYNAMIC_CLIENT_ID) throw new Error('Callback OAuth incomplet');
  const data = await postToken({
    grant_type: 'authorization_code', client_id: clientId, code: result.code,
    code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE,
  });
  const tokens = tokenSetFromResponse(data);
  const identity = await validateIdToken(tokens.id_token, clientId, nonce);
  const metadata = metadataFromResponse(data, { clientId, hostId, subject: identity.sub });
  await saveSession(metadata, tokens);
  return { metadata, accessToken: new SensitiveValue(tokens.access_token, 'oauth-access-token') };
}

export async function getChatgptPlanCredential({ interactive = false, refreshMarginSeconds = 60 } = {}) {
  requireNoApiKeyEnvironment();
  let session;
  try { session = await loadSession(); }
  catch (error) {
    if (!interactive || error.code !== 'ENOENT') throw error;
    return signIn();
  }
  if (session.metadata.expires_at > Math.floor(Date.now() / 1000) + refreshMarginSeconds) {
    return { metadata: session.metadata, accessToken: new SensitiveValue(session.tokens.access_token, 'oauth-access-token') };
  }
  const data = await postToken({
    grant_type: 'refresh_token',
    client_id: session.metadata.client_id,
    refresh_token: session.tokens.refresh_token,
    resource: RESOURCE,
  });
  const tokens = tokenSetFromResponse(data, session.tokens.id_token);
  if (data.id_token) {
    const identity = await validateIdToken(tokens.id_token, session.metadata.client_id, null);
    if (identity.sub !== session.metadata.subject) throw new Error('Le refresh OAuth a changé d’identité');
  }
  const metadata = metadataFromResponse(data, {
    clientId: session.metadata.client_id,
    hostId: session.metadata.ext_agent_host_id,
    subject: session.metadata.subject,
    fallbackScopes: session.metadata.scopes,
  });
  await saveSession(metadata, tokens);
  return { metadata, accessToken: new SensitiveValue(tokens.access_token, 'oauth-access-token') };
}
