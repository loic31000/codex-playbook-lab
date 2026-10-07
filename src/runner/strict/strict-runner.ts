import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTargetRef, type TargetRef } from "../../domain/index.js";
import {
  checkedProcess,
  createAbortError,
  runProcess,
  throwIfAborted,
  type ProcessResult,
  type RunProcessOptions,
} from "./process.js";
import {
  captureSourceState,
  captureVolumeWorkspaceState,
  changedFilesBetween,
  sourceStatesEqual,
  type SourceState,
  type WorkspaceState,
} from "./workspace-state.js";

export const SUPPORTED_CODEX_VERSION = "0.160.0";
export const STRICT_RUNNER_IMAGE = `codex-playbook-strict-runner:${SUPPORTED_CODEX_VERSION}`;
export const STRICT_WORKSPACE_PATH = "/workspace";
export const STRICT_RESOURCE_PREFIX = "codex-lab-strict-";

const FORBIDDEN_SECRET_ENV = /(?:OPENAI_API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|OAUTH|CODEX_API_KEY|API_KEY|GITHUB_TOKEN|GH_TOKEN|SSH_AUTH_SOCK)/i;

export interface StrictEnvironmentDefinition {
  readonly id: string;
  readonly program: "docker";
  readonly args: readonly string[];
}

export interface StrictMountFact {
  readonly type: string;
  readonly name: string | null;
  readonly destination: string;
  readonly readWrite: boolean;
}

export interface StrictEnvironmentFacts {
  readonly container: string;
  readonly volume: string;
  readonly image: string;
  readonly mounts: readonly StrictMountFact[];
  readonly environmentNames: readonly string[];
  readonly secretEnvironmentNames: readonly string[];
  readonly networkMode: string;
  readonly publishedPorts: Readonly<Record<string, unknown>>;
  readonly readOnlyRootFilesystem: boolean;
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly initProcessEnabled: boolean;
  readonly capDrop: readonly string[];
  readonly securityOptions: readonly string[];
  readonly user: string;
  readonly pidsLimit: number | null;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly controlTransport: "stdio";
}

export interface StrictWorkspaceResult {
  readonly initial: WorkspaceState;
  readonly final: WorkspaceState;
  readonly changedFiles: readonly string[];
  readonly diff: string | null;
}

export interface StrictRunnerOptions {
  readonly hostCodexVersionOutput: string;
  readonly labRoot: string;
  readonly image?: string;
  readonly forbiddenHostPaths?: readonly string[];
}

export interface PrepareSnapshotInput {
  readonly target: TargetRef;
  readonly targetPath: string;
  readonly signal?: AbortSignal;
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function safeLabel(value: string): string {
  const label = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!label) throw new TypeError("strict runner label must contain an alphanumeric character");
  return label.slice(0, 32);
}

function ownedName(label: string): string {
  return `${STRICT_RESOURCE_PREFIX}${safeLabel(label)}-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function assertOwnedName(value: string): void {
  if (!value.startsWith(STRICT_RESOURCE_PREFIX) || !/^[a-z0-9-]+$/.test(value)) {
    throw new TypeError(`unsafe strict runner resource name: ${value}`);
  }
}

export function assertSupportedCodexVersion(output: string): string {
  const actual = String(output).trim();
  const expected = `codex-cli ${SUPPORTED_CODEX_VERSION}`;
  if (actual !== expected) {
    throw new Error(`Strict runner requires ${expected}; observed ${actual || "unknown"}. Revalidation is required.`);
  }
  return actual;
}

export async function buildStrictRunnerImage(options: {
  readonly dockerDirectory: string;
  readonly image?: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const image = options.image ?? STRICT_RUNNER_IMAGE;
  const context = await fs.mkdtemp(path.join(os.tmpdir(), STRICT_RESOURCE_PREFIX));
  try {
    await Promise.all([
      fs.copyFile(path.join(options.dockerDirectory, "strict-runner.Dockerfile"), path.join(context, "Dockerfile")),
      fs.copyFile(path.join(options.dockerDirectory, "strict-runner-entrypoint.sh"), path.join(context, "strict-runner-entrypoint.sh")),
    ]);
    await checkedProcess("docker", [
      "build", "--pull=false", "--build-arg", `CODEX_VERSION=${SUPPORTED_CODEX_VERSION}`,
      "--tag", image, context,
    ], { signal: options.signal, timeoutMs: 600_000 });
    const versionContainer = ownedName("version");
    try {
      const version = await checkedProcess("docker", [
        "run", "--rm", "--name", versionContainer, "--network", "none",
        "--entrypoint", "codex", image, "--version",
      ], { signal: options.signal, timeoutMs: 30_000 });
      assertSupportedCodexVersion(version.stdout);
    } finally {
      await removeContainer(versionContainer);
    }
  } finally {
    await fs.rm(context, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function removeContainer(name: string): Promise<void> {
  assertOwnedName(name);
  await runProcess("docker", ["rm", "--force", name], { timeoutMs: 30_000 });
}

async function removeVolume(name: string): Promise<void> {
  assertOwnedName(name);
  await runProcess("docker", ["volume", "rm", name], { timeoutMs: 30_000 });
}

async function chownWorkspace(volume: string, image: string, signal?: AbortSignal): Promise<void> {
  const helper = ownedName("chown");
  try {
    await checkedProcess("docker", [
      "run", "--rm", "--name", helper, "--network", "none", "--read-only",
      "--security-opt", "no-new-privileges=true",
      "--mount", `type=volume,src=${volume},dst=/workspace`,
      "--user", "0:0", "--entrypoint", "chown", image,
      "-R", "10001:10001", STRICT_WORKSPACE_PATH,
    ], { signal, timeoutMs: 120_000 });
  } finally {
    await removeContainer(helper);
  }
}

async function copySourceToVolume(
  sourcePath: string,
  volume: string,
  image: string,
  signal?: AbortSignal,
): Promise<void> {
  const provisioner = ownedName("provision");
  try {
    await checkedProcess("docker", [
      "create", "--name", provisioner, "--network", "none",
      "--mount", `type=volume,src=${volume},dst=/workspace`,
      "--entrypoint", "sh", image, "-c", "true",
    ], { signal, timeoutMs: 30_000 });
    await checkedProcess("docker", ["cp", `${sourcePath}${path.sep}.`, `${provisioner}:${STRICT_WORKSPACE_PATH}`], {
      signal,
      timeoutMs: 300_000,
    });
  } finally {
    await removeContainer(provisioner);
  }
  await chownWorkspace(volume, image, signal);
}

async function cloneVolume(
  sourceVolume: string,
  destinationVolume: string,
  image: string,
  signal?: AbortSignal,
): Promise<void> {
  const helper = ownedName("clone");
  try {
    await checkedProcess("docker", [
      "run", "--rm", "--name", helper, "--network", "none", "--read-only",
      "--mount", `type=volume,src=${sourceVolume},dst=/snapshot,readonly`,
      "--mount", `type=volume,src=${destinationVolume},dst=/workspace`,
      "--user", "0:0", "--entrypoint", "sh", image,
      "-c", "cp -a /snapshot/. /workspace/ && chown -R 10001:10001 /workspace",
    ], { signal, timeoutMs: 300_000 });
  } finally {
    await removeContainer(helper);
  }
}

function strictDockerArgs(container: string, volume: string, image: string): readonly string[] {
  return [
    "run", "--rm", "--interactive", "--init", "--name", container,
    "--network", "none",
    "--mount", `type=volume,src=${volume},dst=${STRICT_WORKSPACE_PATH}`,
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=1777",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true",
    "--pids-limit", "256",
    "--memory", "1g",
    "--cpus", "2",
    "--user", "10001:10001",
    "--env", "HOME=/tmp/home",
    "--env", "CODEX_HOME=/tmp/codex-home",
    image,
    "stdio",
  ];
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(createAbortError());
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export class StrictExecutionEnvironment {
  readonly id: string;
  readonly container: string;
  readonly volume: string;
  readonly image: string;
  readonly initialState: WorkspaceState;
  #started = false;
  #cleanupPromise?: Promise<void>;

  constructor(input: {
    id: string;
    container: string;
    volume: string;
    image: string;
    initialState: WorkspaceState;
  }) {
    this.id = input.id;
    this.container = input.container;
    this.volume = input.volume;
    this.image = input.image;
    this.initialState = input.initialState;
  }

  definition(): StrictEnvironmentDefinition {
    return { id: this.id, program: "docker", args: strictDockerArgs(this.container, this.volume, this.image) };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) throw new Error("strict environment is already started");
    const args = this.definition().args;
    const detached = [args[0]!, "--detach", ...args.slice(1)];
    await checkedProcess("docker", detached, { signal, timeoutMs: 120_000 });
    this.#started = true;
    try {
      await checkedProcess("docker", ["exec", this.container, "true"], { signal, timeoutMs: 30_000 });
      await this.facts(signal);
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async exec(command: readonly string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
    if (!this.#started) throw new Error("strict environment is not started");
    if (command.length === 0) throw new TypeError("strict environment command cannot be empty");
    return runProcess("docker", ["exec", this.container, ...command], options);
  }

  async facts(signal?: AbortSignal): Promise<StrictEnvironmentFacts> {
    const inspect = await checkedProcess("docker", ["inspect", this.container], { signal, timeoutMs: 30_000 });
    const value = JSON.parse(inspect.stdout)[0] as {
      Config: { Image: string; Env?: string[]; User?: string };
      HostConfig: {
        NetworkMode: string;
        PortBindings?: Record<string, unknown> | null;
        ReadonlyRootfs: boolean;
        Tmpfs?: Record<string, string> | null;
        Init?: boolean | null;
        CapDrop?: string[];
        SecurityOpt?: string[];
        PidsLimit?: number | null;
        Memory: number;
        NanoCpus: number;
      };
      Mounts: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }>;
    };
    const environmentNames = (value.Config.Env ?? []).map((entry) => entry.split("=", 1)[0]!).sort();
    const facts: StrictEnvironmentFacts = {
      container: this.container,
      volume: this.volume,
      image: value.Config.Image,
      mounts: value.Mounts.map((mount) => ({
        type: mount.Type,
        name: mount.Name ?? null,
        destination: mount.Destination,
        readWrite: mount.RW,
      })),
      environmentNames,
      secretEnvironmentNames: environmentNames.filter((name) => FORBIDDEN_SECRET_ENV.test(name)),
      networkMode: value.HostConfig.NetworkMode,
      publishedPorts: value.HostConfig.PortBindings ?? {},
      readOnlyRootFilesystem: value.HostConfig.ReadonlyRootfs,
      tmpfs: value.HostConfig.Tmpfs ?? {},
      initProcessEnabled: value.HostConfig.Init === true,
      capDrop: value.HostConfig.CapDrop ?? [],
      securityOptions: value.HostConfig.SecurityOpt ?? [],
      user: value.Config.User ?? "",
      pidsLimit: value.HostConfig.PidsLimit ?? null,
      memoryBytes: value.HostConfig.Memory,
      nanoCpus: value.HostConfig.NanoCpus,
      controlTransport: "stdio",
    };
    if (
      facts.networkMode !== "none"
      || Object.keys(facts.publishedPorts).length !== 0
      || !facts.readOnlyRootFilesystem
      || typeof facts.tmpfs["/tmp"] !== "string"
      || !facts.initProcessEnabled
      || !facts.capDrop.includes("ALL")
      || !facts.securityOptions.includes("no-new-privileges=true")
      || facts.user !== "10001:10001"
      || facts.mounts.length !== 1
      || facts.mounts[0]?.type !== "volume"
      || facts.mounts[0]?.destination !== STRICT_WORKSPACE_PATH
      || facts.mounts[0]?.readWrite !== true
      || facts.secretEnvironmentNames.length !== 0
    ) {
      throw new Error("strict Docker policy invariant violated");
    }
    return facts;
  }

  async captureResult(signal?: AbortSignal): Promise<StrictWorkspaceResult> {
    const final = await captureVolumeWorkspaceState(this.volume, this.image, { signal });
    return {
      initial: this.initialState,
      final,
      changedFiles: changedFilesBetween(this.initialState, final),
      diff: final.diff,
    };
  }

  async stop(): Promise<void> {
    await removeContainer(this.container);
    this.#started = false;
  }

  async cleanup(): Promise<void> {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = (async () => {
      await this.stop();
      await removeVolume(this.volume);
    })();
    return this.#cleanupPromise;
  }

  toJSON(): object {
    return { id: this.id, container: this.container, volume: this.volume, image: this.image, mode: "strict" };
  }
}

export class StrictWorkspaceSnapshot {
  readonly target: TargetRef;
  readonly volume: string;
  readonly image: string;
  readonly initialState: WorkspaceState;
  readonly initialSourceState: SourceState;
  readonly sourcePath: string;
  #cleanupPromise?: Promise<void>;

  constructor(input: {
    target: TargetRef;
    sourcePath: string;
    volume: string;
    image: string;
    initialState: WorkspaceState;
    initialSourceState: SourceState;
  }) {
    this.target = input.target;
    this.sourcePath = input.sourcePath;
    this.volume = input.volume;
    this.image = input.image;
    this.initialState = input.initialState;
    this.initialSourceState = input.initialSourceState;
  }

  async verifySourceUnchanged(): Promise<boolean> {
    return sourceStatesEqual(this.initialSourceState, await captureSourceState(this.sourcePath));
  }

  async createEnvironment(label: string, signal?: AbortSignal): Promise<StrictExecutionEnvironment> {
    throwIfAborted(signal);
    const base = ownedName(label);
    const volume = `${base}-workspace`;
    const container = `${base}-agent`;
    for (const name of [volume, container]) assertOwnedName(name);
    await checkedProcess("docker", ["volume", "create", volume], { signal, timeoutMs: 30_000 });
    try {
      await cloneVolume(this.volume, volume, this.image, signal);
      const initialState = await captureVolumeWorkspaceState(volume, this.image, { signal });
      if (initialState.fingerprint !== this.initialState.fingerprint) {
        throw new Error("strict environment initial fingerprint differs from its source snapshot");
      }
      return new StrictExecutionEnvironment({
        id: `strict-${safeLabel(label)}`,
        container,
        volume,
        image: this.image,
        initialState,
      });
    } catch (error) {
      await removeVolume(volume);
      throw error;
    }
  }

  async withEnvironment<T>(
    label: string,
    callback: (environment: StrictExecutionEnvironment) => Promise<T>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    const environment = await this.createEnvironment(label, options.signal);
    let result: T | undefined;
    let primaryError: unknown;
    try {
      await environment.start(options.signal);
      result = await raceWithAbort(callback(environment), options.signal);
    } catch (error) {
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await environment.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "strict environment and cleanup failed");
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
    return result as T;
  }

  async cleanup(): Promise<void> {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = (async () => {
      await removeVolume(this.volume);
      if (!(await this.verifySourceUnchanged())) throw new Error("target source changed during strict runner lifecycle");
    })();
    return this.#cleanupPromise;
  }

  toJSON(): object {
    return {
      target: this.target,
      volume: this.volume,
      initialFingerprint: this.initialState.fingerprint,
      gitHead: this.initialState.gitHead,
      gitTree: this.initialState.gitTree,
      gitStatus: this.initialState.gitStatus,
    };
  }
}

export class StrictRunner {
  readonly image: string;
  readonly labRoot: string;
  readonly forbiddenHostPaths: readonly string[];

  constructor(options: StrictRunnerOptions) {
    assertSupportedCodexVersion(options.hostCodexVersionOutput);
    this.image = options.image ?? STRICT_RUNNER_IMAGE;
    this.labRoot = normalizePath(options.labRoot);
    this.forbiddenHostPaths = [
      this.labRoot,
      ...(options.forbiddenHostPaths ?? []).map(normalizePath),
    ];
  }

  async prepare(input: PrepareSnapshotInput): Promise<StrictWorkspaceSnapshot> {
    throwIfAborted(input.signal);
    const target = createTargetRef(input.target);
    if (typeof input.targetPath !== "string" || input.targetPath.trim() === "") {
      throw new TypeError("targetPath must be explicitly provided");
    }
    const sourcePath = path.resolve(input.targetPath);
    const sourceNormalized = normalizePath(sourcePath);
    if (this.forbiddenHostPaths.some((root) => isWithin(sourceNormalized, root))) {
      throw new Error("targetPath points inside a forbidden host path");
    }
    if (!(await fs.stat(sourcePath)).isDirectory()) throw new TypeError("targetPath must reference a directory");

    const initialSourceState = await captureSourceState(sourcePath);
    const volume = `${ownedName("snapshot")}-workspace`;
    assertOwnedName(volume);
    await checkedProcess("docker", ["volume", "create", volume], { signal: input.signal, timeoutMs: 30_000 });
    try {
      await copySourceToVolume(sourcePath, volume, this.image, input.signal);
      const initialState = await captureVolumeWorkspaceState(volume, this.image, { signal: input.signal });
      if (initialState.fingerprint !== initialSourceState.workspace.fingerprint) {
        throw new Error("provisioned snapshot differs from the explicit target source");
      }
      if (!sourceStatesEqual(initialSourceState, await captureSourceState(sourcePath))) {
        throw new Error("target source changed while preparing the snapshot");
      }
      return new StrictWorkspaceSnapshot({ target, sourcePath, volume, image: this.image, initialState, initialSourceState });
    } catch (error) {
      await removeVolume(volume);
      throw error;
    }
  }

  async withSnapshot<T>(
    input: PrepareSnapshotInput,
    callback: (snapshot: StrictWorkspaceSnapshot) => Promise<T>,
  ): Promise<T> {
    const snapshot = await this.prepare(input);
    let result: T | undefined;
    let primaryError: unknown;
    try {
      result = await raceWithAbort(callback(snapshot), input.signal);
    } catch (error) {
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await snapshot.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "strict snapshot and cleanup failed");
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
    return result as T;
  }
}
