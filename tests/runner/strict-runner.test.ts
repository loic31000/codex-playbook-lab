import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  STRICT_RESOURCE_PREFIX,
  STRICT_RUNNER_IMAGE,
  StrictExecutionEnvironment,
  StrictRunner,
  assertSupportedCodexVersion,
  buildStrictRunnerImage,
  captureSourceState,
  runProcess,
} from "../../src/runner/strict/index.js";

const dockerAvailable = spawnSync("docker", ["info"], { windowsHide: true, stdio: "ignore" }).status === 0;
const integration = dockerAvailable ? it : it.skip;
const labRoot = path.resolve(".");
const dockerDirectory = path.join(labRoot, "docker");
const labSentinelPath = path.join(labRoot, "fixtures", "app-exec-spike-lab-sentinel.txt");

let targetRoot = "";
let initialSourceState: Awaited<ReturnType<typeof captureSourceState>>;

function createRunner(): StrictRunner {
  return new StrictRunner({
    hostCodexVersionOutput: "codex-cli 0.160.0",
    labRoot,
  });
}

async function git(...args: string[]): Promise<void> {
  const result = await runProcess("git", ["-C", targetRoot, ...args], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`test git command failed with ${result.code}`);
}

async function dockerObjectAbsent(kind: "container" | "volume", name: string): Promise<boolean> {
  const args = kind === "container" ? ["inspect", name] : ["volume", "inspect", name];
  return (await runProcess("docker", args, { timeoutMs: 30_000 })).code !== 0;
}

async function strictResources(): Promise<{ containers: string[]; volumes: string[] }> {
  const [containers, volumes] = await Promise.all([
    runProcess("docker", ["ps", "-a", "--filter", `name=${STRICT_RESOURCE_PREFIX}`, "--format", "{{.Names}}"]),
    runProcess("docker", ["volume", "ls", "--filter", `name=${STRICT_RESOURCE_PREFIX}`, "--format", "{{.Name}}"]),
  ]);
  const split = (value: string): string[] => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { containers: split(containers.stdout), volumes: split(volumes.stdout) };
}

async function strictTempDirectories(): Promise<string[]> {
  return (await fs.readdir(os.tmpdir()))
    .filter((name) => name.startsWith(STRICT_RESOURCE_PREFIX))
    .sort();
}

beforeAll(async () => {
  targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-strict-target-"));
  await fs.mkdir(path.join(targetRoot, "src"));
  await fs.writeFile(path.join(targetRoot, "package.json"), '{"name":"strict-target","private":true}\n', "utf8");
  await fs.writeFile(path.join(targetRoot, "src", "value.txt"), "initial\n", "utf8");
  await git("init", "--quiet");
  await git("config", "user.name", "Strict Runner Test");
  await git("config", "user.email", "strict-runner@example.invalid");
  await git("add", "-A");
  await git("-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "initial");
  await fs.writeFile(path.join(targetRoot, "preexisting-untracked.txt"), "preexisting\n", "utf8");
  initialSourceState = await captureSourceState(targetRoot);
  if (dockerAvailable) await buildStrictRunnerImage({ dockerDirectory });
}, 600_000);

afterAll(async () => {
  try {
    if (dockerAvailable) {
      const leaked = await strictResources();
      for (const container of leaked.containers) {
        if (container.startsWith(STRICT_RESOURCE_PREFIX)) {
          await runProcess("docker", ["rm", "--force", container], { timeoutMs: 30_000 });
        }
      }
      for (const volume of leaked.volumes) {
        if (volume.startsWith(STRICT_RESOURCE_PREFIX)) {
          await runProcess("docker", ["volume", "rm", volume], { timeoutMs: 30_000 });
        }
      }
      const leakedTempDirectories = await strictTempDirectories();
      for (const directory of leakedTempDirectories) {
        await fs.rm(path.join(os.tmpdir(), directory), { recursive: true, force: true });
      }
      await runProcess("docker", ["image", "rm", STRICT_RUNNER_IMAGE], { timeoutMs: 120_000 });
      expect(leaked).toEqual({ containers: [], volumes: [] });
      expect(leakedTempDirectories).toEqual([]);
    }
  } finally {
    if (targetRoot) await fs.rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe.sequential("strict isolated runner", () => {
  it("epingle exactement Codex 0.160.0", () => {
    expect(assertSupportedCodexVersion("codex-cli 0.160.0\n")).toBe("codex-cli 0.160.0");
    expect(() => assertSupportedCodexVersion("codex-cli 0.161.0")).toThrow(/Revalidation is required/);
  });

  it("exige un target explicite et refuse le repository Lab", async () => {
    const runner = createRunner();
    await expect(runner.prepare({
      target: { id: "missing", source: "filesystem" },
      targetPath: "",
    })).rejects.toThrow(/explicitly provided/);
    await expect(runner.prepare({
      target: { id: "lab", source: "git" },
      targetPath: labRoot,
    })).rejects.toThrow(/forbidden host path/);
  });

  it("produit une definition stdio stricte sans port ni bind mount", () => {
    const environment = new StrictExecutionEnvironment({
      id: "strict-unit",
      container: `${STRICT_RESOURCE_PREFIX}unit-agent`,
      volume: `${STRICT_RESOURCE_PREFIX}unit-workspace`,
      image: STRICT_RUNNER_IMAGE,
      initialState: {
        fingerprint: "initial", fileFingerprint: "files", manifest: [], gitHead: null, gitTree: null,
        gitStatus: null, diff: null, diffFingerprint: null, changedFiles: [],
      },
    });
    const definition = environment.definition();
    expect(definition.program).toBe("docker");
    expect(definition.args.slice(0, 3)).toEqual(["run", "--rm", "--interactive"]);
    expect(definition.args[definition.args.indexOf("--network") + 1]).toBe("none");
    expect(definition.args).toContain("--read-only");
    expect(definition.args).toContain("ALL");
    expect(definition.args).toContain("no-new-privileges=true");
    expect(definition.args).not.toContain("--publish");
    expect(definition.args).not.toContain("--volume");
    expect(definition.args.at(-1)).toBe("stdio");
    expect(JSON.stringify(definition)).not.toContain(labRoot);
  });

  integration("isole filesystem, secrets et reseau dans le vrai container agent", async () => {
    const runner = createRunner();
    const sentinel = {
      name: path.basename(labSentinelPath),
      content: (await fs.readFile(labSentinelPath, "utf8")).trim(),
    };
    const fakeSecret = `SYNTHETIC_ACCESS_TOKEN_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
    const previousSecret = process.env.ACCESS_TOKEN;
    process.env.ACCESS_TOKEN = fakeSecret;
    try {
      await runner.withSnapshot({
        target: { id: "strict-target", source: "git", revision: initialSourceState.workspace.gitHead ?? undefined },
        targetPath: targetRoot,
      }, async (snapshot) => {
        await snapshot.withEnvironment("isolation", async (environment) => {
          const facts = await environment.facts();
          const { probeStrictEnvironment } = await import("../../src/runner/strict/index.js");
          const probe = await probeStrictEnvironment(environment, { sentinels: [sentinel] });
          expect(facts.mounts).toEqual([{
            type: "volume",
            name: environment.volume,
            destination: "/workspace",
            readWrite: true,
          }]);
          expect(facts.networkMode).toBe("none");
          expect(facts.publishedPorts).toEqual({});
          expect(facts.readOnlyRootFilesystem).toBe(true);
          expect(facts.tmpfs["/tmp"]).toContain("size=67108864");
          expect(facts.initProcessEnabled).toBe(true);
          expect(facts.capDrop).toContain("ALL");
          expect(facts.securityOptions).toContain("no-new-privileges=true");
          expect(facts.user).toBe("10001:10001");
          expect(facts.pidsLimit).toBe(256);
          expect(facts.memoryBytes).toBe(1024 ** 3);
          expect(facts.nanoCpus).toBe(2_000_000_000);
          expect(facts.secretEnvironmentNames).toEqual([]);
          expect(probe.targetReadable).toBe(true);
          expect(probe.targetWritable).toBe(true);
          expect(probe.labSentinelMatches).toEqual([]);
          expect(probe.labSentinelContentMatches).toEqual([]);
          expect(probe.hostHomeVisible).toBe(false);
          expect(probe.dockerSocketVisible).toBe(false);
          expect(probe.network.interfaces).toEqual(["lo"]);
          expect(probe.network.nonLoopbackInterfaces).toEqual([]);
          expect(probe.network.externalRoutes).toBe("blocked");
          expect(probe.network.hostDockerInternal).toBe("blocked");
          expect(probe.network.gatewayDockerInternal).toBe("blocked");
          expect(probe.network.externalDns).toBe("blocked");
          expect(probe.network.isolated).toBe(true);
          const environmentOutput = await environment.exec(["env"]);
          const workspaceOutput = await environment.exec([
            "sh", "-lc", "find /workspace -type f -readable -exec cat {} + 2>/dev/null",
          ]);
          const controlledError = await environment.exec(["sh", "-lc", "printf controlled-error >&2; exit 7"]);
          const result = await environment.captureResult();
          expect(environmentOutput.stdout).not.toContain(fakeSecret);
          expect(workspaceOutput.stdout).not.toContain(fakeSecret);
          expect(JSON.stringify({ facts, probe, environment, controlledError, result })).not.toContain(fakeSecret);
          expect(result).not.toHaveProperty("winner");
          expect(result).not.toHaveProperty("humanReviewStatus");
          expect(JSON.stringify(facts.mounts)).not.toContain(targetRoot);
        });
      });
    } finally {
      if (previousSecret === undefined) delete process.env.ACCESS_TOKEN;
      else process.env.ACCESS_TOKEN = previousSecret;
    }
    expect(await captureSourceState(targetRoot)).toEqual(initialSourceState);
  }, 180_000);

  integration("cree deux workspaces A/B identiques et independants sans modifier la source", async () => {
    const runner = createRunner();
    await runner.withSnapshot({
      target: { id: "strict-target", source: "git", revision: initialSourceState.workspace.gitHead ?? undefined },
      targetPath: targetRoot,
    }, async (snapshot) => {
      const baseline = await snapshot.createEnvironment("baseline");
      const treatment = await snapshot.createEnvironment("treatment");
      try {
        expect(baseline.volume).not.toBe(treatment.volume);
        expect(baseline.initialState.fingerprint).toBe(treatment.initialState.fingerprint);
        expect(baseline.initialState.gitHead).toBe(treatment.initialState.gitHead);
        expect(baseline.initialState.gitTree).toBe(treatment.initialState.gitTree);
        expect(baseline.initialState.gitStatus).toBe(treatment.initialState.gitStatus);
        expect(baseline.initialState.gitStatus).toContain("preexisting-untracked.txt");
        await baseline.start();
        await treatment.start();
        expect((await baseline.exec(["sh", "-lc", "printf baseline > /workspace/baseline-only.txt"])).code).toBe(0);
        expect((await treatment.exec(["test", "!", "-e", "/workspace/baseline-only.txt"])).code).toBe(0);
        expect((await treatment.exec(["sh", "-lc", "printf treatment > /workspace/treatment-only.txt"])).code).toBe(0);
        expect((await baseline.exec(["test", "!", "-e", "/workspace/treatment-only.txt"])).code).toBe(0);
        const baselineResult = await baseline.captureResult();
        const treatmentResult = await treatment.captureResult();
        expect(baselineResult.changedFiles).toEqual(["baseline-only.txt"]);
        expect(treatmentResult.changedFiles).toEqual(["treatment-only.txt"]);
        expect(baselineResult.diff).toContain("baseline-only.txt");
        expect(treatmentResult.diff).toContain("treatment-only.txt");
      } finally {
        await baseline.cleanup();
        await treatment.cleanup();
      }
      expect(await snapshot.verifySourceUnchanged()).toBe(true);
    });
    expect(await captureSourceState(targetRoot)).toEqual(initialSourceState);
  }, 180_000);

  integration("nettoie container, volume et snapshot apres succes", async () => {
    const runner = createRunner();
    let container = "";
    let volume = "";
    let snapshotVolume = "";
    await runner.withSnapshot({ target: { id: "success", source: "git" }, targetPath: targetRoot }, async (snapshot) => {
      snapshotVolume = snapshot.volume;
      await snapshot.withEnvironment("success", async (environment) => {
        container = environment.container;
        volume = environment.volume;
        expect((await environment.exec(["true"])).code).toBe(0);
      });
    });
    expect(await dockerObjectAbsent("container", container)).toBe(true);
    expect(await dockerObjectAbsent("volume", volume)).toBe(true);
    expect(await dockerObjectAbsent("volume", snapshotVolume)).toBe(true);
    expect(await strictTempDirectories()).toEqual([]);
  }, 180_000);

  integration("nettoie toutes les ressources apres exception", async () => {
    const runner = createRunner();
    let container = "";
    let volume = "";
    let snapshotVolume = "";
    await expect(runner.withSnapshot(
      { target: { id: "failure", source: "git" }, targetPath: targetRoot },
      async (snapshot) => {
        snapshotVolume = snapshot.volume;
        await snapshot.withEnvironment("failure", async (environment) => {
          container = environment.container;
          volume = environment.volume;
          throw new Error("controlled callback failure");
        });
      },
    )).rejects.toThrow(/controlled callback failure/);
    expect(await dockerObjectAbsent("container", container)).toBe(true);
    expect(await dockerObjectAbsent("volume", volume)).toBe(true);
    expect(await dockerObjectAbsent("volume", snapshotVolume)).toBe(true);
  }, 180_000);

  integration("annule un process long et nettoie Docker", async () => {
    const runner = createRunner();
    const controller = new AbortController();
    let container = "";
    let volume = "";
    let snapshotVolume = "";
    await expect(runner.withSnapshot(
      { target: { id: "abort", source: "git" }, targetPath: targetRoot, signal: controller.signal },
      async (snapshot) => {
        snapshotVolume = snapshot.volume;
        await snapshot.withEnvironment("abort", async (environment) => {
          container = environment.container;
          volume = environment.volume;
          setTimeout(() => controller.abort(), 200).unref();
          await environment.exec(["sh", "-lc", "sleep 30"], { signal: controller.signal, timeoutMs: 60_000 });
        }, { signal: controller.signal });
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(await dockerObjectAbsent("container", container)).toBe(true);
    expect(await dockerObjectAbsent("volume", volume)).toBe(true);
    expect(await dockerObjectAbsent("volume", snapshotVolume)).toBe(true);
  }, 180_000);

  integration("cleanup est idempotent", async () => {
    const runner = createRunner();
    const snapshot = await runner.prepare({ target: { id: "idempotent", source: "git" }, targetPath: targetRoot });
    const environment = await snapshot.createEnvironment("idempotent");
    await environment.start();
    await environment.cleanup();
    await environment.cleanup();
    await snapshot.cleanup();
    await snapshot.cleanup();
    expect(await dockerObjectAbsent("container", environment.container)).toBe(true);
    expect(await dockerObjectAbsent("volume", environment.volume)).toBe(true);
    expect(await dockerObjectAbsent("volume", snapshot.volume)).toBe(true);
  }, 180_000);
});
