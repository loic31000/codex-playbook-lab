import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApplicationError,
  createLabApplication,
  type ApplicationEvent,
  type DiagnosticResult,
} from "../../src/application/index.js";
import { createGeneratorPromptVersion } from "../../src/explore/index.js";
import {
  openEvidenceStore,
  type FilesystemEvidenceStore,
} from "../../src/evidence/index.js";
import type {
  BackendRunRequest,
  ExecutionBaseline,
  ExperimentAgentExecutor,
  ExperimentExecutionBackend,
  ExperimentExecutionSession,
} from "../../src/experiment/index.js";
import {
  buildExperimentReport,
  renderExperimentReportMarkdown,
  serializeExperimentReportJson,
} from "../../src/report/index.js";
import { createCompleteReportFixture, removeReportFixture } from "../report/helpers.js";
import { createReviewFixture, removeReviewFixture } from "../review/helpers.js";
import { humanReviewRecordRef } from "../../src/review/index.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-application-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const target = { id: "application-target", source: "git", revision: "application-revision" } as const;
const promptDefinition = { id: "application-prompt", name: "Application prompt" } as const;
const promptVersion = {
  id: "application-prompt@v1",
  promptDefinitionId: "application-prompt",
  content: "Apply the application prompt.",
} as const;
const testCases = [{ kind: "fixed", id: "application-case", title: "Application case", input: "Case input" }] as const;

function planInput(storeRoot: string, planId = "application-plan") {
  return {
    evidenceStoreDir: storeRoot,
    planId,
    experimentId: "application-experiment",
    promptDefinition,
    promptVersion,
    target,
    testCases,
    repetitions: 1,
  } as const;
}

class FakeBackend implements ExperimentExecutionBackend {
  readonly executed: Array<{ ordinal: number; attempt: number }> = [];
  private startedResolve: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });

  constructor(
    private readonly options: { readonly crashOrdinal?: number; readonly block?: boolean } = {},
  ) {}

  async open(input: Parameters<ExperimentExecutionBackend["open"]>[0]): Promise<ExperimentExecutionSession> {
    const baseline: ExecutionBaseline = {
      target: input.target,
      workspaceFingerprint: "application-workspace-initial",
      gitHead: "application-revision",
      gitTree: "application-tree",
      gitStatus: "",
      image: "application-runner:1",
      policyFingerprint: "application-policy",
    };
    return {
      baseline,
      executeRun: async (request: BackendRunRequest) => {
        this.executed.push({ ordinal: request.plannedRun.ordinal, attempt: request.attempt });
        this.startedResolve?.();
        if (request.plannedRun.ordinal === this.options.crashOrdinal && request.attempt === 1) {
          throw new Error("simulated application crash");
        }
        if (this.options.block) {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
            if (request.signal?.aborted) abort();
            else request.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        const execution = await request.executor.execute({
          plannedRun: request.plannedRun,
          experiment: request.experiment,
          testCase: request.testCase,
          promptVersion: request.experiment.promptVersion,
          variant: request.plannedRun.variant,
          repetition: request.plannedRun.repetition,
          modelInput: request.modelInput,
          signal: request.signal,
          environment: {
            id: `application-environment-${request.plannedRun.ordinal}`,
            volume: `application-volume-${request.plannedRun.ordinal}`,
            image: baseline.image,
            async exec() { return { code: 0, signal: null, stdout: "", stderr: "" }; },
          },
        });
        return {
          exitCode: execution.exitCode,
          durationMs: 10,
          changedFiles: [],
          evidence: execution.evidence ?? [],
          transcript: execution.transcript,
          facts: {
            environmentId: `application-environment-${request.plannedRun.ordinal}`,
            volume: `application-volume-${request.plannedRun.ordinal}`,
            image: baseline.image,
            initialWorkspaceFingerprint: baseline.workspaceFingerprint,
            initialGitHead: baseline.gitHead,
            initialGitTree: baseline.gitTree,
            initialGitStatus: baseline.gitStatus,
            policyFingerprint: baseline.policyFingerprint,
            finalWorkspaceFingerprint: baseline.workspaceFingerprint,
          },
          workspace: {
            initialWorkspaceFingerprint: baseline.workspaceFingerprint,
            finalWorkspaceFingerprint: baseline.workspaceFingerprint,
            changes: [],
            changedFiles: [],
            initialGitDiffFromHead: "",
            finalGitDiffFromHead: "",
          },
        };
      },
      async close() {},
    };
  }
}

const executor: ExperimentAgentExecutor = {
  async execute({ plannedRun }) {
    return {
      exitCode: 0,
      transcript: {
        model: "fake-application-agent",
        modelOptions: { temperature: 0 },
        finalOutput: `output-${plannedRun.ordinal}`,
        stdout: "",
        stderr: "",
      },
    };
  },
};

function application(input: {
  readonly backend?: FakeBackend;
  readonly events?: ApplicationEvent[];
  readonly operationId?: string;
  readonly generator?: Parameters<typeof createLabApplication>[0]["exploratoryGenerator"];
  readonly diagnostics?: DiagnosticResult;
  readonly openStore?: Parameters<typeof createLabApplication>[0]["openEvidenceStore"];
  readonly promptDiscovery?: Parameters<typeof createLabApplication>[0]["promptDiscovery"];
  readonly benchmarkDiscovery?: Parameters<typeof createLabApplication>[0]["benchmarkDiscovery"];
} = {}) {
  let tick = 0;
  return createLabApplication({
    openEvidenceStore: input.openStore ?? openEvidenceStore,
    ...(input.promptDiscovery === undefined ? {} : { promptDiscovery: input.promptDiscovery }),
    ...(input.benchmarkDiscovery === undefined ? {} : { benchmarkDiscovery: input.benchmarkDiscovery }),
    ...(input.backend === undefined ? {} : {
      executionBackendFactory: async () => input.backend!,
      agentExecutor: executor,
    }),
    ...(input.generator === undefined ? {} : { exploratoryGenerator: input.generator }),
    ...(input.diagnostics === undefined ? {} : {
      diagnostics: { async diagnose() { return input.diagnostics!; } },
    }),
    now: () => new Date(Date.UTC(2026, 9, 9, 8, 0, tick++)),
    ...(input.operationId === undefined ? {} : { createOperationId: () => input.operationId! }),
    ...(input.events === undefined ? {} : { onEvent: (event) => { input.events!.push(event); } }),
  });
}

async function persistedPlan(app: ReturnType<typeof application>, storeRoot: string, id = "application-plan") {
  return app.createExperimentPlan(planInput(storeRoot, id));
}

describe("LabApplication", () => {
  it("cree et persiste un plan deterministe sans lancer de run ni creer de verdict", async () => {
    const root = await temporaryRoot();
    const storeRoot = path.join(root, "store");
    const app = application();
    const first = await persistedPlan(app, storeRoot);
    const second = await persistedPlan(app, storeRoot);
    const store = await openEvidenceStore(storeRoot);

    expect(first.planFingerprint).toBe(second.planFingerprint);
    expect(first.plannedRunCount).toBe(2);
    expect(await store.readPlan(first.planFingerprint)).toEqual(first.plan);
    expect((await store.readLatestCheckpoint(first.planFingerprint)).checkpoint).toBeNull();
    expect(first.plan.experiments[0]?.target).toEqual(target);
    expect(first.plan.experiments[0]?.runs).toEqual([]);
  });

  it("decouvre prompts et benchmarks V2 sans parser alternatif", async () => {
    const app = application();
    const playbookDir = path.resolve("tests/fixtures/fixed/playbook");
    const benchmarksDir = path.resolve("tests/fixtures/fixed/benchmarks");
    const prompts = await app.discoverPrompts({ playbookDir });
    const benchmarks = await app.discoverBenchmarks({ playbookDir, benchmarksDir });

    expect(prompts.map(({ definition }) => definition.id)).toEqual(["09-01-implementer-story"]);
    expect(benchmarks).toHaveLength(1);
    expect(benchmarks[0]?.testCase.input).not.toContain("format:");
  });

  it("classe les erreurs de lookup et valide le fingerprint avant toute execution", async () => {
    const root = await temporaryRoot();
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    const app = application({ backend: new FakeBackend() });
    expect(() => app.startExperiment({ evidenceStoreDir: path.join(root, "store"), planFingerprint: "abc", targetPath }))
      .toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    await expect(app.startExperiment({
      evidenceStoreDir: path.join(root, "store"),
      planFingerprint: "a".repeat(64),
      targetPath,
    }).completion).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(application().discoverPrompts({ playbookDir: path.join(root, "missing") }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(application({
      promptDiscovery: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    }).discoverPrompts({ playbookDir: root }))
      .rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
    await expect(application().discoverPrompts({ playbookDir: root, selector: "" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(application({
      promptDiscovery: async () => [],
      benchmarkDiscovery: async () => { throw Object.assign(new Error("denied"), { code: "EIO" }); },
    }).discoverBenchmarks({ playbookDir: root, benchmarksDir: root }))
      .rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
  });

  it("genere des cas lossless avec un generator injecte et refuse la capability absente", async () => {
    const events: ApplicationEvent[] = [];
    const generator = {
      id: "application-generator",
      version: "1",
      async generate() {
        return {
          model: "fake-generator-model",
          modelOptions: { temperature: 0 },
          reproducibility: "deterministic" as const,
          seedUsed: "seed",
          cases: [{ title: "Generated", markdown: "# Exact generated body\n" }],
        };
      },
    };
    const configured = application({ generator, events });
    const result = await configured.generateCases({
      generationId: "application-generation",
      generatorPrompt: createGeneratorPromptVersion({ id: "generator@1", content: "Generate cases." }),
      promptVersion,
      target,
      requestedSeed: "seed",
    });

    expect(result.cases[0]?.input).toBe("# Exact generated body\n");
    expect(result.cases[0]?.provenance.generatorId).toBe(generator.id);
    expect(events.at(-1)?.type).toBe("cases_generated");
    expect(() => JSON.stringify(events)).not.toThrow();
    await expect(application().generateCases({} as never)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("execute via runStoredExperimentPlan, remplit le store et relaie les events #27", async () => {
    const root = await temporaryRoot();
    const storeRoot = path.join(root, "store");
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    const backend = new FakeBackend();
    const events: ApplicationEvent[] = [];
    const app = application({ backend, events, operationId: "operation-run" });
    const created = await persistedPlan(app, storeRoot);
    const operation = app.startExperiment({ evidenceStoreDir: storeRoot, planFingerprint: created.planFingerprint, targetPath });
    const state = await operation.completion;

    expect(state.status).toBe("completed");
    expect(backend.executed).toHaveLength(2);
    expect((await openEvidenceStore(storeRoot)).readLatestCheckpoint(created.planFingerprint)).resolves.toMatchObject({
      checkpoint: { state: { status: "completed" } },
    });
    const relayed = events.filter(({ type }) => type === "experiment_event");
    expect(relayed.map(({ payload }) => (payload.event as { type: string }).type)).toEqual([
      "plan_started", "run_started", "run_completed", "run_started", "run_completed", "plan_completed",
    ]);
    expect(relayed.map(({ payload }) => (payload.event as { sequence: number }).sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(relayed.every(({ payload }) => (payload.event as { planFingerprint: string }).planFingerprint === created.planFingerprint)).toBe(true);
    expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
    expect(app.activeOperationIds()).toEqual([]);
  });

  it("classe un second run sans resume comme CONFLICT et preserve resume", async () => {
    const root = await temporaryRoot();
    const storeRoot = path.join(root, "store");
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    const firstBackend = new FakeBackend();
    const app = application({ backend: firstBackend, operationId: "checkpoint-operation" });
    const created = await persistedPlan(app, storeRoot, "checkpoint-conflict-plan");
    await app.startExperiment({ evidenceStoreDir: storeRoot, planFingerprint: created.planFingerprint, targetPath }).completion;

    await expect(app.startExperiment({
      evidenceStoreDir: storeRoot,
      planFingerprint: created.planFingerprint,
      targetPath,
    }).completion).rejects.toMatchObject({ code: "CONFLICT" });
    expect(app.activeOperationIds()).toEqual([]);

    const resumedBackend = new FakeBackend();
    const resumed = application({ backend: resumedBackend, operationId: "resume-checkpoint-operation" });
    await expect(resumed.resumeExperiment({
      evidenceStoreDir: storeRoot,
      planFingerprint: created.planFingerprint,
      targetPath,
    }).completion).resolves.toMatchObject({ status: "completed" });
    expect(resumedBackend.executed).toEqual([]);
    expect(resumed.activeOperationIds()).toEqual([]);
  });

  it("reprend apres crash sans rejouer le run terminal", async () => {
    const root = await temporaryRoot();
    const storeRoot = path.join(root, "store");
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    const crashing = new FakeBackend({ crashOrdinal: 2 });
    const first = application({ backend: crashing, operationId: "crash-operation" });
    const created = await persistedPlan(first, storeRoot, "resume-plan");
    await expect(first.startExperiment({ evidenceStoreDir: storeRoot, planFingerprint: created.planFingerprint, targetPath }).completion)
      .rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });

    const resumedBackend = new FakeBackend();
    const events: ApplicationEvent[] = [];
    const resumed = application({ backend: resumedBackend, events, operationId: "resume-operation" });
    const state = await resumed.resumeExperiment({ evidenceStoreDir: storeRoot, planFingerprint: created.planFingerprint, targetPath }).completion;

    expect(state.status).toBe("completed");
    expect(resumedBackend.executed).toEqual([{ ordinal: 2, attempt: 2 }]);
    expect(events.some(({ type, payload }) => type === "experiment_event" && (payload.event as { type: string }).type === "run_skipped")).toBe(true);
  });

  it("annule proprement, checkpoint l'interruption et nettoie le registre", async () => {
    const root = await temporaryRoot();
    const storeRoot = path.join(root, "store");
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    const backend = new FakeBackend({ block: true });
    const events: ApplicationEvent[] = [];
    const app = application({ backend, events, operationId: "cancel-operation" });
    const created = await persistedPlan(app, storeRoot, "cancel-plan");
    const operation = app.startExperiment({ evidenceStoreDir: storeRoot, planFingerprint: created.planFingerprint, targetPath });
    await backend.started;
    await app.cancelOperation(operation.id);
    const state = await operation.completion;

    expect(state.status).toBe("interrupted");
    expect(events.map(({ type }) => type)).toContain("operation_cancel_requested");
    expect(events.map(({ type }) => type)).toContain("operation_cancelled");
    expect(app.activeOperationIds()).toEqual([]);
    expect((await (await openEvidenceStore(storeRoot)).readLatestCheckpoint(created.planFingerprint)).checkpoint?.state.status).toBe("interrupted");
  });

  it("refuse collisions, isole les instances et nettoie aussi apres erreur", async () => {
    const root = await temporaryRoot();
    const storeRoot = path.join(root, "store");
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    const backend = new FakeBackend({ block: true });
    const first = application({ backend, operationId: "same-operation" });
    const created = await persistedPlan(first, storeRoot, "concurrency-plan");
    const operation = first.startExperiment({ evidenceStoreDir: storeRoot, planFingerprint: created.planFingerprint, targetPath });
    expect(() => first.startExperiment({ evidenceStoreDir: storeRoot, planFingerprint: created.planFingerprint, targetPath }))
      .toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(application({ backend: new FakeBackend(), operationId: "same-operation" }).activeOperationIds()).toEqual([]);
    await expect(first.cancelOperation("unknown")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await backend.started;
    await first.cancelOperation(operation.id);
    await operation.completion;

    const failureEvents: ApplicationEvent[] = [];
    const failing = createLabApplication({
      openEvidenceStore,
      executionBackendFactory: async () => { throw new Error("backend unavailable"); },
      agentExecutor: executor,
      createOperationId: () => "failed-operation",
      onEvent: (event) => { failureEvents.push(event); },
    });
    await expect(failing.startExperiment({ evidenceStoreDir: storeRoot, planFingerprint: created.planFingerprint, targetPath }).completion)
      .rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
    expect(failing.activeOperationIds()).toEqual([]);
    expect(failureEvents.at(-1)?.type).toBe("operation_failed");
  });

  it("suit deux operations distinctes sans partager leur registre", async () => {
    const root = await temporaryRoot();
    const targetPath = path.join(root, "target");
    await fs.mkdir(targetPath);
    const backends = [new FakeBackend({ block: true }), new FakeBackend({ block: true })];
    let backendIndex = 0;
    const app = createLabApplication({
      openEvidenceStore,
      executionBackendFactory: async () => backends[backendIndex++]!,
      agentExecutor: executor,
    });
    const firstStore = path.join(root, "store-one");
    const secondStore = path.join(root, "store-two");
    const firstPlan = await app.createExperimentPlan(planInput(firstStore, "parallel-one"));
    const secondPlan = await app.createExperimentPlan(planInput(secondStore, "parallel-two"));
    const first = app.startExperiment({ evidenceStoreDir: firstStore, planFingerprint: firstPlan.planFingerprint, targetPath, operationId: "one" });
    const second = app.startExperiment({ evidenceStoreDir: secondStore, planFingerprint: secondPlan.planFingerprint, targetPath, operationId: "two" });
    await Promise.all(backends.map(({ started }) => started));
    expect([...app.activeOperationIds()].sort()).toEqual(["one", "two"]);
    await Promise.all([app.cancelOperation("one"), app.cancelOperation("two")]);
    await Promise.all([first.completion, second.completion]);
    expect(app.activeOperationIds()).toEqual([]);
  });

  it.each([
    { ok: true, checks: [{ id: "success", status: "ok" as const, message: "fact" }] },
    { ok: true, checks: [{ id: "warning", status: "warning" as const, message: "fact" }] },
    { ok: false, checks: [{ id: "failure", status: "failure" as const, message: "fact" }] },
  ])("expose diagnostics structures sans console: $checks.0.status", async (result) => {
    const events: ApplicationEvent[] = [];
    expect(await application({ diagnostics: result, events }).diagnose({
      repoDir: "repo", playbookDir: "playbook", evidenceStoreDir: "store",
    })).toEqual(result);
    expect(events.at(-1)?.type).toBe("diagnostics_completed");
  });

  it("refuse les diagnostics sans probe configuree", async () => {
    await expect(application().diagnose({ repoDir: "repo", playbookDir: "playbook", evidenceStoreDir: "store" }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("delegue report #30 et lecture d'artifact sans recalcul ni path arbitraire", async () => {
    const fixture = await createCompleteReportFixture("application-report-plan");
    try {
      const app = application();
      const direct = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
      const report = await app.buildReport({ evidenceStoreDir: fixture.storeRoot, planFingerprint: fixture.plan.fingerprint });
      expect(report.structured).toEqual(direct);
      expect(report.json).toBe(serializeExperimentReportJson(direct));
      expect(report.markdown).toBe(renderExperimentReportMarkdown(direct));
      const reference = report.structured.runs[0]!.manifest!.artifacts.finalOutput!;
      const artifact = await app.readArtifact({ evidenceStoreDir: fixture.storeRoot, reference });
      expect(Buffer.from(artifact.bytesBase64, "base64").toString("utf8")).toBe("output-1");
      await expect(app.readArtifact({ evidenceStoreDir: fixture.storeRoot, reference: "../../host" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(app.readArtifact({ evidenceStoreDir: fixture.storeRoot, reference: `blobs/sha256/${"0".repeat(64)}` }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await removeReportFixture(fixture);
    }
  });

  it("classe une source de rapport corrompue comme DATA_INTEGRITY_FAILURE", async () => {
    const fixture = await createCompleteReportFixture("application-corrupt-report-plan", false);
    try {
      const attempt = await fixture.store.readAttempt(
        fixture.plan.fingerprint,
        fixture.plan.plannedRuns[0]!.id,
        1,
      );
      await fs.writeFile(path.join(fixture.storeRoot, ...attempt.summary.manifestRef!.split("/")), "{}\n", "utf8");
      await expect(application().buildReport({
        evidenceStoreDir: fixture.storeRoot,
        planFingerprint: fixture.plan.fingerprint,
      })).rejects.toMatchObject({ code: "DATA_INTEGRITY_FAILURE" });
    } finally {
      await removeReportFixture(fixture);
    }
  });

  it("classe les erreurs I/O apres ouverture du store comme infrastructure", async () => {
    const root = await temporaryRoot();
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const store = {
      root: path.join(root, "store"),
      async readPlan() { throw denied; },
      async readArtifact() { throw denied; },
    } as unknown as FilesystemEvidenceStore;
    const app = application({ openStore: async () => store });
    const planFingerprint = "a".repeat(64);
    await expect(app.buildReport({ evidenceStoreDir: store.root, planFingerprint }))
      .rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
    await expect(app.readCurrentReview({ evidenceStoreDir: store.root, planFingerprint, plannedRunId: "run" }))
      .rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
    await expect(app.reviewRun({
      evidenceStoreDir: store.root,
      planFingerprint,
      plannedRunId: "run",
      status: "rejected",
      reviewer: "human",
    })).rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
    await expect(app.promoteCase({
      evidenceStoreDir: store.root,
      benchmarksDir: root,
      planFingerprint,
      plannedRunId: "run",
      fixedCaseId: "fixed-case",
      title: "Fixed case",
      expectation: "implementation",
      promotedBy: "human",
    })).rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
    await expect(app.readArtifact({
      evidenceStoreDir: store.root,
      reference: `blobs/sha256/${"b".repeat(64)}`,
    })).rejects.toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
  });

  it("distingue conflit de promotion et corruption de revue/promotion", async () => {
    const fixture = await createReviewFixture({ id: "application-error-boundaries" });
    try {
      const app = application();
      const plannedRunId = fixture.plan.plannedRuns[0]!.id;
      const promotion = {
        evidenceStoreDir: fixture.storeRoot,
        benchmarksDir: fixture.benchmarksDir,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId,
        fixedCaseId: "error-boundary-case",
        title: "Error boundary case",
        expectation: "implementation" as const,
        promotedBy: "human",
      };
      await expect(app.promoteCase(promotion)).rejects.toMatchObject({ code: "CONFLICT" });
      const review = await app.reviewRun({
        evidenceStoreDir: fixture.storeRoot,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId,
        status: "rejected",
        reviewer: "human",
      });
      const reviewPath = path.join(fixture.storeRoot, ...humanReviewRecordRef(
        fixture.plan.fingerprint,
        plannedRunId,
        review.sequence,
      ).split("/"));
      await fs.writeFile(reviewPath, "{}\n", "utf8");
      await expect(app.readCurrentReview({
        evidenceStoreDir: fixture.storeRoot,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId,
      })).rejects.toMatchObject({ code: "DATA_INTEGRITY_FAILURE" });
      await expect(app.promoteCase(promotion)).rejects.toMatchObject({ code: "DATA_INTEGRITY_FAILURE" });
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("classe les plans persistés corrompus comme intégrité pour review et promotion", async () => {
    async function corruptPlan(storeRoot: string, fingerprint: string): Promise<void> {
      const filename = path.join(storeRoot, "plans", fingerprint, "plan.json");
      const record = JSON.parse(await fs.readFile(filename, "utf8")) as { plan: { experiments: unknown } };
      record.plan.experiments = null;
      await fs.writeFile(filename, `${JSON.stringify(record)}\n`, "utf8");
    }

    const reviewFixture = await createReviewFixture({ id: "application-corrupt-review-plan" });
    try {
      await corruptPlan(reviewFixture.storeRoot, reviewFixture.plan.fingerprint);
      await expect(reviewFixture.store.readPlan(reviewFixture.plan.fingerprint)).rejects.toBeInstanceOf(TypeError);
      await expect(application().reviewRun({
        evidenceStoreDir: reviewFixture.storeRoot,
        planFingerprint: reviewFixture.plan.fingerprint,
        plannedRunId: reviewFixture.plan.plannedRuns[0]!.id,
        status: "rejected",
        reviewer: "human",
      })).rejects.toMatchObject({ code: "DATA_INTEGRITY_FAILURE" });
    } finally {
      await removeReviewFixture(reviewFixture);
    }

    const promotionFixture = await createReviewFixture({ id: "application-corrupt-promotion-plan" });
    try {
      await corruptPlan(promotionFixture.storeRoot, promotionFixture.plan.fingerprint);
      await expect(application().promoteCase({
        evidenceStoreDir: promotionFixture.storeRoot,
        benchmarksDir: promotionFixture.benchmarksDir,
        planFingerprint: promotionFixture.plan.fingerprint,
        plannedRunId: promotionFixture.plan.plannedRuns[0]!.id,
        fixedCaseId: "corrupt-source-case",
        title: "Corrupt source case",
        expectation: "implementation",
        promotedBy: "human",
      })).rejects.toMatchObject({ code: "DATA_INTEGRITY_FAILURE" });
    } finally {
      await removeReviewFixture(promotionFixture);
    }
  });

  it("conserve les inputs review et promotion invalides en INVALID_ARGUMENT", async () => {
    const fixture = await createReviewFixture({ id: "application-invalid-human-inputs" });
    try {
      const app = application();
      const baseReview = {
        evidenceStoreDir: fixture.storeRoot,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId: fixture.plan.plannedRuns[0]!.id,
        status: "rejected" as const,
        reviewer: "human",
      };
      await expect(app.reviewRun({ ...baseReview, status: "unknown" as never }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(app.reviewRun({ ...baseReview, reviewer: "" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(app.reviewRun({ ...baseReview, reviewedAt: "yesterday" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

      const basePromotion = {
        evidenceStoreDir: fixture.storeRoot,
        benchmarksDir: fixture.benchmarksDir,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId: fixture.plan.plannedRuns[0]!.id,
        fixedCaseId: "valid-case",
        title: "Valid case",
        expectation: "implementation" as const,
        promotedBy: "human",
      };
      await expect(app.promoteCase({ ...basePromotion, fixedCaseId: "Invalid ID" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(app.promoteCase({ ...basePromotion, expectation: "unknown" as never }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(app.promoteCase({ ...basePromotion, title: "invalid\ntitle" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(app.promoteCase({ ...basePromotion, promotedBy: "" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(app.promoteCase({ ...basePromotion, promotedAt: "yesterday" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("enregistre review et promotion uniquement par actions humaines explicites", async () => {
    const fixture = await createReviewFixture({ id: "application-review-plan" });
    try {
      const events: ApplicationEvent[] = [];
      const app = application({ events });
      const plannedRunId = fixture.plan.plannedRuns[0]!.id;
      const before = await fixture.store.readAttempt(fixture.plan.fingerprint, plannedRunId, 1);
      const review = await app.reviewRun({
        evidenceStoreDir: fixture.storeRoot,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId,
        status: "rejected",
        reviewer: "application-reviewer",
        reviewedAt: "2026-10-09T10:00:00.000Z",
      });
      expect(review.previousStatus).toBe("pending_review");
      expect((await app.readCurrentReview({ evidenceStoreDir: fixture.storeRoot, planFingerprint: fixture.plan.fingerprint, plannedRunId })).status).toBe("rejected");
      expect((await app.readReviewHistory({ evidenceStoreDir: fixture.storeRoot, planFingerprint: fixture.plan.fingerprint, plannedRunId }))).toHaveLength(1);
      expect((await fixture.store.readAttempt(fixture.plan.fingerprint, plannedRunId, 1)).manifest?.technicalStatus)
        .toBe(before.manifest?.technicalStatus);
      expect(await fs.readdir(fixture.benchmarksDir)).toEqual([]);

      const promoted = await app.promoteCase({
        evidenceStoreDir: fixture.storeRoot,
        benchmarksDir: fixture.benchmarksDir,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId,
        fixedCaseId: "031-application-promoted",
        title: "Application promoted",
        expectation: "implementation",
        promotedBy: "application-promoter",
        promotedAt: "2026-10-09T10:01:00.000Z",
      });
      expect(promoted.metadata.format).toBe("codex-lab-benchmark-promotion");
      expect(events.map(({ type }) => type)).toEqual(["human_review_recorded", "case_promoted"]);
      expect(JSON.stringify(events)).not.toMatch(/[A-Z]:\\|\/tmp\//);
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("retourne CAPABILITY_UNAVAILABLE sans aucun fallback pour execution", async () => {
    expect(() => application().startExperiment({
      evidenceStoreDir: "store", planFingerprint: "a".repeat(64), targetPath: "target",
    })).toThrowError(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
  });

  it("serialise erreurs et evenements sans cause native", () => {
    const error = new ApplicationError("INFRASTRUCTURE_FAILURE", "failure", { cause: new Error("secret stack") });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "INFRASTRUCTURE_FAILURE", category: "infrastructure", message: "failure",
    });
  });
});
