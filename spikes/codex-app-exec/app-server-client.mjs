import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { codexSpawnSpec } from '../../src/core/codex-process.mjs';
import { ENVIRONMENT_ID, SensitiveValue, redact } from './spike-support.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

export class AppServerClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #notifications = [];
  #waiters = [];
  #stderr = '';
  #secrets;

  constructor(child, secrets) {
    this.#child = child;
    this.#secrets = secrets;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.#stderr += redact(chunk, secrets); });
    child.once('exit', (code, signal) => {
      const error = new Error(`app-server arrêté prématurément (code=${code}, signal=${signal})`);
      for (const { reject, timer } of this.#pending.values()) { clearTimeout(timer); reject(error); }
      this.#pending.clear();
      for (const waiter of this.#waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
      this.#waiters.length = 0;
    });
  }

  static async start({ accessToken, codexHome, command = 'codex' }) {
    if (!(accessToken instanceof SensitiveValue)) throw new Error('accessToken doit être encapsulé');
    await fs.mkdir(codexHome, { recursive: true });
    const args = [
      'app-server', '--listen', 'stdio://', '--enable', 'deferred_executor',
      '-c', 'model_provider="openai_chatgpt_plan"',
      '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
      '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
      '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
      '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
      '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
      '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
    ];
    const spec = codexSpawnSpec(command, args);
    const env = { ...process.env, CODEX_HOME: codexHome, ACCESS_TOKEN: accessToken.reveal() };
    for (const name of ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZUREAI_OPENAI_API_KEY']) delete env[name];
    const child = spawn(spec.file, spec.args, {
      cwd: os.tmpdir(),
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    child.stdin.setDefaultEncoding('utf8');
    const client = new AppServerClient(child, [accessToken]);
    await client.request('initialize', {
      clientInfo: { name: 'codex_playbook_lab', title: 'Codex Playbook Lab', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized', {});
    return client;
  }

  get stderr() { return this.#stderr; }
  get notifications() { return [...this.#notifications]; }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.#stderr += `${redact(line, this.#secrets)}\n`; return; }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`app-server RPC ${pending.method}: ${redact(message.error, this.#secrets)}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#respondToServerRequest(message);
      return;
    }
    if (!message.method) return;
    this.#notifications.push(message);
    const remaining = [];
    for (const waiter of this.#waiters) {
      if (waiter.method === message.method && waiter.predicate(message.params ?? {})) {
        clearTimeout(waiter.timer);
        waiter.resolve(message.params ?? {});
      } else remaining.push(waiter);
    }
    this.#waiters = remaining;
  }

  #respondToServerRequest(message) {
    const method = String(message.method);
    const result = method.includes('Approval') || method.includes('approval')
      ? { decision: 'decline' }
      : {};
    this.#child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timeout RPC ${method} après ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.#child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitForNotification(method, predicate = () => true, timeoutMs = 300_000) {
    const existing = this.#notifications.find((event) => event.method === method && predicate(event.params ?? {}));
    if (existing) return Promise.resolve(existing.params ?? {});
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`Timeout notification ${method} après ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  async addEnvironment(execServerUrl, environmentId = ENVIRONMENT_ID, authBearerToken) {
    if (!(authBearerToken instanceof SensitiveValue)) {
      throw new Error('Le capability-token exec-server doit être encapsulé');
    }
    this.#secrets.push(authBearerToken);
    await this.request('environment/add', {
      environmentId,
      execServerUrl,
      authBearerToken: authBearerToken.reveal(),
      connectTimeoutMs: 30_000,
    });
    const info = await this.request('environment/info', { environmentId });
    return info;
  }

  async startThread({ model, cwd = '/workspace', developerInstructions = null, environmentId = ENVIRONMENT_ID }) {
    const response = await this.request('thread/start', {
      model,
      modelProvider: 'openai_chatgpt_plan',
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: true,
      developerInstructions,
      environments: [{ environmentId, cwd, runtimeWorkspaceRoots: [cwd] }],
    }, 60_000);
    return response.thread.id;
  }

  async startLocalThread({ model, cwd, developerInstructions = null }) {
    const response = await this.request('thread/start', {
      model,
      modelProvider: 'openai_chatgpt_plan',
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      developerInstructions,
      environments: [],
    }, 60_000);
    return response.thread.id;
  }

  async runTurn({ threadId, text, model, effort = 'medium', sandboxPolicy = { type: 'externalSandbox', networkAccess: 'restricted' } }) {
    const started = Date.now();
    const response = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      model,
      effort,
      sandboxPolicy,
      approvalPolicy: 'never',
    }, 60_000);
    const turnId = response.turn.id;
    const completed = await this.waitForNotification(
      'turn/completed',
      (params) => params.turn?.id === turnId,
      600_000,
    );
    return { turn: completed.turn, durationMs: Date.now() - started };
  }

  async close() {
    if (this.#child.exitCode !== null) return;
    this.#child.stdin.end();
    await Promise.race([
      new Promise((resolve) => this.#child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (this.#child.exitCode === null) this.#child.kill();
  }
}

export async function createTemporaryCodexHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-server-home-'));
}
