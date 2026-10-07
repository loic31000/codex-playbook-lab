import { describe, expect, it } from "vitest";

import {
  createExperiment,
  createTestCase,
  type Experiment,
  type JsonObject,
} from "../../src/domain/index.js";
import { fingerprintExactText } from "../../src/explore/index.js";
import {
  EXPERIMENT_INPUT_SEPARATOR,
  LocalRunExecutionError,
  buildExperimentModelInput,
  canonicalJson,
  createExperimentExecutionPlan,
  runExperimentPlan,
  sha256Canonical,
  type BackendRunRequest,
  type ExecutionBaseline,
  type ExperimentAgentExecutor,
  type ExperimentExecutionBackend,
  type ExperimentExecutionPlan,
  type ExperimentExecutionSession,
  type ExperimentExecutionState,
} from "../../src/experiment/index.js";

const target = { id: "target-27", source: "git", revision: "abc123" } as const;
const fixedInput = "# Fixed case\n\nApply the fixed change.\n";
const generatedInput = "# Generated case\r\n\r\nPreserve this exact text.  \r\n";
const provenanceSentinel = "ORACLE_PROVENANCE_SENTINEL_27";

function fakeTranscript() {
  return {
    model: "fake-agent-model",
    modelOptions: { temperature: 0 },
    finalOutput: "fake final output",
    stdout: "fake stdout",
    stderr: "",
  };
}

function successfulAgentResult() {
  return { exitCode: 0, transcript: fakeTranscript() };
}

function generatedProvenance(
  markdown = generatedInput,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const instruction = "Generate exploratory cases exactly.";
  return {
    generatorId: "generator-26",
    generatorVersion: "2.0.0",
    generatedAt: "2026-10-07T08:00:00.000Z",
    instruction: { kind: "content", value: instruction },
    instructionVersion: "generator-prompt-v1",
    instructionFingerprint: fingerprintExactText(instruction),
    model: "fake-generation-model",
    modelOptions: { temperature: 0.5, note: provenanceSentinel },
    target,
    contentFingerprint: fingerprintExactText(markdown),
    reproducibility: "not_guaranteed",
    seed: 77,
    parentRef: "generation-26",
    ...overrides,
  };
}

function rawExperiment(input: {
  id?: string;
  repetitions?: number;
  generatedProvenance?: Record<string, unknown>;
  generatedInput?: string;
  target?: typeof target;
} = {}): Record<string, unknown> {
  const experimentTarget = input.target ?? target;
  return {
    id: input.id ?? "experiment-27",
    promptDefinition: { id: "prompt-27", name: "Prompt 27" },
    promptVersion: {
      id: "prompt-27@v1",
      promptDefinitionId: "prompt-27",
      content: "Follow the studied prompt exactly.\n",
      fingerprint: "legacy-domain-fingerprint",
    },
    target: experimentTarget,
    testCases: [
      { kind: "fixed", id: "fixed-1", title: "Fixed", input: fixedInput },
      {
        kind: "generated",
        id: "generated-1",
        title: "Generated",
        input: input.generatedInput ?? generatedInput,
        provenance: input.generatedProvenance ?? generatedProvenance(
          input.generatedInput ?? generatedInput,
          { target: experimentTarget },
        ),
      },
    ],
    configuration: { repetitions: input.repetitions ?? 3 },
    runs: [],
  };
}

function planFromRaw(raw: Record<string, unknown> = rawExperiment()): ExperimentExecutionPlan {
  return createExperimentExecutionPlan({ id: "plan-27", experiments: [raw as unknown as Experiment] });
}

function baseline(overrides: Partial<ExecutionBaseline> = {}): ExecutionBaseline {
  return {
    target,
    workspaceFingerprint: "workspace-fingerprint",
    gitHead: "git-head",
    gitTree: "git-tree",
    gitStatus: " M tracked.txt\0?? untracked.txt\0",
    image: "strict-image:27",
    policyFingerprint: "policy-fingerprint",
    ...overrides,
  };
}

class FakeBackend implements ExperimentExecutionBackend {
  readonly value: ExecutionBaseline;
  readonly requests: BackendRunRequest[] = [];
  openCount = 0;
  closeCount = 0;

  constructor(value: ExecutionBaseline = baseline()) {
    this.value = value;
  }

  async open(): Promise<ExperimentExecutionSession> {
    this.openCount += 1;
    return {
      baseline: this.value,
      executeRun: async (request) => {
        this.requests.push(request);
        let execution;
        try {
          execution = await request.executor.execute({
            plannedRun: request.plannedRun,
            experiment: request.experiment,
            testCase: request.testCase,
            promptVersion: request.experiment.promptVersion,
            variant: request.plannedRun.variant,
            repetition: request.plannedRun.repetition,
            environment: {
              id: `fake-${request.plannedRun.id}`,
              volume: `volume-${request.plannedRun.id}`,
              image: this.value.image,
              async exec() {
                return { code: 0, signal: null, stdout: "", stderr: "" };
              },
            },
            modelInput: request.modelInput,
            signal: request.signal,
          });
        } catch (error) {
          if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
          throw new LocalRunExecutionError(error);
        }
        return {
          exitCode: execution.exitCode,
          durationMs: 5,
          changedFiles: [`run-${request.plannedRun.ordinal}.txt`],
          evidence: execution.evidence ?? [],
          facts: {
            environmentId: `fake-${request.plannedRun.id}`,
            volume: `volume-${request.plannedRun.id}`,
            image: this.value.image,
            initialWorkspaceFingerprint: this.value.workspaceFingerprint,
            initialGitHead: this.value.gitHead,
            initialGitTree: this.value.gitTree,
            initialGitStatus: this.value.gitStatus,
            policyFingerprint: this.value.policyFingerprint,
            finalWorkspaceFingerprint: `final-${request.plannedRun.id}`,
          },
          transcript: execution.transcript,
          workspace: {
            initialWorkspaceFingerprint: this.value.workspaceFingerprint,
            finalWorkspaceFingerprint: `final-${request.plannedRun.id}`,
            changes: [{
              path: `run-${request.plannedRun.ordinal}.txt`,
              status: "added" as const,
              before: null,
              after: { kind: "file" as const, sha256: `sha-${request.plannedRun.ordinal}` },
            }],
            changedFiles: [`run-${request.plannedRun.ordinal}.txt`],
            initialGitDiffFromHead: "",
            finalGitDiffFromHead: `diff --git a/run-${request.plannedRun.ordinal}.txt b/run-${request.plannedRun.ordinal}.txt\n`,
          },
        };
      },
      close: async () => {
        this.closeCount += 1;
      },
    };
  }
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 7, 10, 0, tick++));
}

const successfulExecutor: ExperimentAgentExecutor = {
  async execute() {
    return successfulAgentResult();
  },
};

async function interruptedExecution(
  plan = planFromRaw(),
  executionBaseline: ExecutionBaseline = baseline(),
): Promise<{
  state: ExperimentExecutionState;
  clock: () => Date;
}> {
  const controller = new AbortController();
  const clock = deterministicClock();
  const executor: ExperimentAgentExecutor = {
    async execute({ plannedRun }) {
      if (plannedRun.ordinal === 5) {
        controller.abort();
        throw Object.assign(new Error("interrupted"), { name: "AbortError" });
      }
      return successfulAgentResult();
    },
  };
  const state = await runExperimentPlan({
    plan,
    backend: new FakeBackend(executionBaseline),
    targetPath: "C:/explicit-target",
    executor,
    signal: controller.signal,
    now: clock,
  });
  return { state, clock };
}

function mutable(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

const previousStateCorruptions: ReadonlyArray<readonly [
  string,
  (state: ExperimentExecutionState) => void,
]> = [
  ["pending run changed to completed", (state) => {
    mutable(state.runs[5]!.run).technicalStatus = "completed";
  }],
  ["pending run changed to completed with forged attempt", (state) => {
    mutable(state.runs[5]!.run).technicalStatus = "completed";
    mutable(state.runs[5]).attempt = 1;
  }],
  ["ExperimentRun id", (state) => {
    mutable(state.runs[0]!.run).id = "forged-run";
  }],
  ["ExperimentRun experimentId", (state) => {
    mutable(state.runs[0]!.run).experimentId = "forged-experiment";
  }],
  ["ExperimentRun testCaseId", (state) => {
    mutable(state.runs[0]!.run).testCaseId = "forged-case";
  }],
  ["ExperimentRun technicalStatus", (state) => {
    mutable(state.runs[0]!.run).technicalStatus = "forged-status";
  }],
  ["ExperimentRun humanReviewStatus", (state) => {
    mutable(state.runs[0]!.run).humanReviewStatus = "automatic-winner";
  }],
  ["logical wrapper plannedRunId", (state) => {
    mutable(state.runs[0]).plannedRunId = "forged-planned-run";
  }],
  ["logical wrapper experimentId", (state) => {
    mutable(state.runs[0]).experimentId = "forged-experiment";
  }],
  ["logical wrapper testCaseId", (state) => {
    mutable(state.runs[0]).testCaseId = "forged-case";
  }],
  ["logical wrapper promptVersionId", (state) => {
    mutable(state.runs[0]).promptVersionId = "forged-prompt-version";
  }],
  ["logical wrapper variant", (state) => {
    mutable(state.runs[0]).variant = "treatment";
  }],
  ["logical wrapper repetition", (state) => {
    mutable(state.runs[0]).repetition = 99;
  }],
  ["logical wrapper caseInputFingerprint", (state) => {
    mutable(state.runs[0]).caseInputFingerprint = "forged-fingerprint";
  }],
  ["negative attempt", (state) => {
    mutable(state.runs[0]).attempt = -1;
  }],
  ["completed with attempt 0", (state) => {
    mutable(state.runs[0]).attempt = 0;
  }],
  ["pending with a positive attempt", (state) => {
    mutable(state.runs[5]).attempt = 1;
  }],
  ["started state without baseline", (state) => {
    delete mutable(state).baseline;
  }],
  ["baseline target", (state) => {
    mutable(state.baseline!).target = { id: "forged-target", source: "git", revision: "abc123" };
  }],
  ["event planFingerprint", (state) => {
    mutable(state.events[0]).planFingerprint = "forged-plan-fingerprint";
  }],
  ["event planId", (state) => {
    mutable(state.events[0]).planId = "forged-plan";
  }],
  ["event timestamp", (state) => {
    mutable(state.events[0]).timestamp = "not-an-iso-timestamp";
  }],
  ["run event plannedRunId", (state) => {
    const event = state.events.find(({ type }) => type === "run_started")!;
    mutable(event).plannedRunId = "unknown-planned-run";
  }],
  ["run event variant and repetition", (state) => {
    const event = state.events.find(({ type }) => type === "run_started")!;
    mutable(event).variant = "treatment";
    mutable(event).repetition = 99;
  }],
  ["run event experimentId and testCaseId", (state) => {
    const event = state.events.find(({ type }) => type === "run_started")!;
    mutable(event).experimentId = "forged-experiment";
    mutable(event).testCaseId = "forged-case";
  }],
  ["run event attempt", (state) => {
    const event = state.events.find(({ type }) => type === "run_started")!;
    mutable(event).attempt = 0;
  }],
];

describe("experiment execution plan", () => {
  it("sorts canonical keys by code-unit order without locale or Unicode normalization", () => {
    const first = { "\u4e2d": 6, "\u00e9": 4, a: 1, "\u03a9": 5, z: 2, "\u00e4": 3 };
    const second = { "\u00e4": 3, z: 2, "\u03a9": 5, a: 1, "\u00e9": 4, "\u4e2d": 6 };
    const expected = '{"a":1,"z":2,"\u00e4":3,"\u00e9":4,"\u03a9":5,"\u4e2d":6}';
    expect(canonicalJson(first)).toBe(expected);
    expect(canonicalJson(second)).toBe(expected);
    expect(sha256Canonical(first)).toBe(sha256Canonical(second));
    expect(canonicalJson({ "\u00e9": 1 })).not.toBe(canonicalJson({ "e\u0301": 1 }));
  });

  it("est déterministe, canonique et contient exactement douze PlannedRun ordonnés", () => {
    const first = planFromRaw();
    const second = planFromRaw();
    expect(second).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.plannedRuns).toHaveLength(12);
    expect(new Set(first.plannedRuns.map(({ id }) => id)).size).toBe(12);
    expect(first.plannedRuns.map(({ testCaseId, repetition, variant }) => ({ testCaseId, repetition, variant })))
      .toEqual([
        { testCaseId: "fixed-1", repetition: 1, variant: "baseline" },
        { testCaseId: "fixed-1", repetition: 1, variant: "treatment" },
        { testCaseId: "fixed-1", repetition: 2, variant: "baseline" },
        { testCaseId: "fixed-1", repetition: 2, variant: "treatment" },
        { testCaseId: "fixed-1", repetition: 3, variant: "baseline" },
        { testCaseId: "fixed-1", repetition: 3, variant: "treatment" },
        { testCaseId: "generated-1", repetition: 1, variant: "baseline" },
        { testCaseId: "generated-1", repetition: 1, variant: "treatment" },
        { testCaseId: "generated-1", repetition: 2, variant: "baseline" },
        { testCaseId: "generated-1", repetition: 2, variant: "treatment" },
        { testCaseId: "generated-1", repetition: 3, variant: "baseline" },
        { testCaseId: "generated-1", repetition: 3, variant: "treatment" },
      ]);
    for (let index = 0; index < first.plannedRuns.length; index += 2) {
      expect(first.plannedRuns[index]!.caseInputFingerprint).toBe(first.plannedRuns[index + 1]!.caseInputFingerprint);
    }
    expect(new Set(first.plannedRuns.slice(6).map(({ caseInputFingerprint }) => caseInputFingerprint)))
      .toEqual(new Set([fingerprintExactText(generatedInput)]));
    expect(first.plannedRuns[0]!.promptContentFingerprint).toBe(
      fingerprintExactText(first.experiments[0]!.promptVersion.content),
    );
    expect(first.experiments[0]!.promptVersion.fingerprint).toBe("legacy-domain-fingerprint");
  });

  it("copie puis gèle récursivement le plan sans geler les objets appelants", () => {
    const source = rawExperiment();
    const plan = planFromRaw(source);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.experiments)).toBe(true);
    expect(Object.isFrozen(plan.experiments[0]!.testCases[1])).toBe(true);
    ((source.promptVersion as Record<string, unknown>).content) = "mutated prompt";
    ((source.testCases as Array<Record<string, unknown>>)[0]!.input) = "mutated case";
    ((source.configuration as Record<string, unknown>).repetitions) = 100;
    expect(plan.experiments[0]!.promptVersion.content).toBe("Follow the studied prompt exactly.\n");
    expect(plan.experiments[0]!.testCases[0]!.input).toBe(fixedInput);
    expect(plan.plannedRuns).toHaveLength(12);
    expect(() => {
      (plan.plannedRuns as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it("préserve intégralement la provenance GeneratedCase sur les répétitions", () => {
    const plan = planFromRaw();
    const generated = plan.experiments[0]!.testCases[1]!;
    expect(generated.kind).toBe("generated");
    if (generated.kind !== "generated") throw new Error("generated case missing");
    expect(generated.provenance).toEqual(generatedProvenance());
    expect(generated.provenance.reproducibility).toBe("not_guaranteed");
    expect(generated.provenance.seed).toBe(77);
    expect(plan.plannedRuns.slice(6).every(({ caseInputFingerprint }) => (
      caseInputFingerprint === generated.provenance.contentFingerprint
    ))).toBe(true);
  });

  it("n'invente aucune seed et ne change jamais not_guaranteed", () => {
    const provenance = generatedProvenance(generatedInput);
    delete provenance.seed;
    const plan = planFromRaw(rawExperiment({ generatedProvenance: provenance }));
    const generated = plan.experiments[0]!.testCases[1]!;
    if (generated.kind !== "generated") throw new Error("generated case missing");
    expect(generated.provenance).not.toHaveProperty("seed");
    expect(generated.provenance.reproducibility).toBe("not_guaranteed");
  });

  it("le fingerprint change lorsque la provenance logique change", () => {
    const first = planFromRaw();
    const changed = planFromRaw(rawExperiment({
      generatedProvenance: generatedProvenance(generatedInput, {
        modelOptions: { temperature: 0.6, note: provenanceSentinel },
      }),
    }));
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("refuse un target de provenance différent du target Experiment", () => {
    const provenance = generatedProvenance(generatedInput, {
      target: { id: "another-target", source: "git", revision: "abc123" },
    });
    expect(() => planFromRaw(rawExperiment({ generatedProvenance: provenance })))
      .toThrow(/target differs/);
  });

  it("le domaine refuse un Markdown GeneratedCase substitué sans nouveau fingerprint", () => {
    expect(() => createExperiment(rawExperiment({
      generatedInput: "changed markdown",
      generatedProvenance: generatedProvenance(generatedInput),
    })))
      .toThrow(/contentFingerprint does not match/);
  });

  it("construit les inputs FixedCase et GeneratedCase sans provenance ni oracle", () => {
    const plan = planFromRaw();
    const experiment = plan.experiments[0]!;
    for (const testCase of experiment.testCases) {
      const baselineInput = buildExperimentModelInput({ variant: "baseline", promptVersion: experiment.promptVersion, testCase });
      const treatmentInput = buildExperimentModelInput({ variant: "treatment", promptVersion: experiment.promptVersion, testCase });
      expect(baselineInput).toBe(testCase.input);
      expect(treatmentInput).toBe(
        `${experiment.promptVersion.content}${EXPERIMENT_INPUT_SEPARATOR}${testCase.input}`,
      );
      for (const modelInput of [baselineInput, treatmentInput]) {
        expect(modelInput).not.toContain("generator-26");
        expect(modelInput).not.toContain("not_guaranteed");
        expect(modelInput).not.toContain("temperature");
        expect(modelInput).not.toContain(provenanceSentinel);
        expect(modelInput).not.toContain("seed");
      }
    }
  });
});

describe("experiment orchestration state machine", () => {
  it.each(previousStateCorruptions)(
    "refuse previousState corrompu avant backend.open(): %s",
    async (_label, corrupt) => {
      const plan = planFromRaw();
      const { state } = await interruptedExecution(plan);
      const corrupted = JSON.parse(JSON.stringify(state)) as ExperimentExecutionState;
      corrupt(corrupted);
      const backend = new FakeBackend(state.baseline);
      let agentCalls = 0;
      await expect(runExperimentPlan({
        plan,
        backend,
        targetPath: "C:/explicit-target",
        previousState: corrupted,
        executor: {
          async execute() {
            agentCalls += 1;
            return successfulAgentResult();
          },
        },
      })).rejects.toThrow();
      expect(backend.openCount).toBe(0);
      expect(agentCalls).toBe(0);
    },
  );

  it("rejects a forged run_skipped attempt before backend.open()", async () => {
    const plan = planFromRaw();
    const { state: interrupted, clock } = await interruptedExecution(plan);
    const completed = await runExperimentPlan({
      plan,
      backend: new FakeBackend(interrupted.baseline),
      targetPath: "C:/explicit-target",
      previousState: interrupted,
      executor: successfulExecutor,
      now: clock,
    });
    const corrupted = JSON.parse(JSON.stringify(completed)) as ExperimentExecutionState;
    const skipped = corrupted.events.find(({ type }) => type === "run_skipped")!;
    mutable(skipped).attempt = 99;
    const backend = new FakeBackend(completed.baseline);
    let agentCalls = 0;
    await expect(runExperimentPlan({
      plan,
      backend,
      targetPath: "C:/explicit-target",
      previousState: corrupted,
      executor: {
        async execute() {
          agentCalls += 1;
          return successfulAgentResult();
        },
      },
    })).rejects.toThrow(/skipped event attempt|attempt exceeds/);
    expect(backend.openCount).toBe(0);
    expect(agentCalls).toBe(0);
  });

  it("exécute les douze runs logiques et conserve pending_review", async () => {
    const plan = planFromRaw();
    const backend = new FakeBackend();
    const state = await runExperimentPlan({
      plan,
      backend,
      targetPath: "C:/explicit-target",
      executor: successfulExecutor,
      now: deterministicClock(),
    });
    expect(state.status).toBe("completed");
    expect(state.runs).toHaveLength(12);
    expect(backend.requests).toHaveLength(12);
    expect(state.runs.every(({ run, attempt }) => (
      run.technicalStatus === "completed" && run.humanReviewStatus === "pending_review" && attempt === 1
    ))).toBe(true);
    expect(state.runs.map(({ run }) => run.id)).toEqual(plan.plannedRuns.map(({ id }) => id));
    expect(state.events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: state.events.length }, (_, index) => index + 1),
    );
    expect(state.events.map(({ type }) => type)).toEqual([
      "plan_started",
      ...plan.plannedRuns.flatMap(() => ["run_started", "run_completed"] as const),
      "plan_completed",
    ]);
    expect(JSON.stringify(state)).not.toMatch(/winner|betterPrompt|worsePrompt|verdict|score|approved|rejected/i);
  });

  it("resumes an interrupted clean Git baseline without replaying completed runs", async () => {
    const plan = planFromRaw();
    const cleanBaseline = baseline({ gitStatus: "" });
    const { state: interrupted, clock } = await interruptedExecution(plan, cleanBaseline);
    const resumedIds: string[] = [];
    const backend = new FakeBackend(cleanBaseline);
    const resumed = await runExperimentPlan({
      plan,
      backend,
      targetPath: "C:/explicit-target",
      previousState: interrupted,
      executor: {
        async execute({ plannedRun }) {
          resumedIds.push(plannedRun.id);
          return successfulAgentResult();
        },
      },
      now: clock,
    });
    expect(backend.openCount).toBe(1);
    expect(resumedIds).toEqual(plan.plannedRuns.slice(4).map(({ id }) => id));
    expect(resumed.runs.slice(0, 4).every(({ attempt }) => attempt === 1)).toBe(true);
    expect(resumed.runs[4]!.attempt).toBe(2);
    expect(resumed.runs.slice(5).every(({ attempt }) => attempt === 1)).toBe(true);
    expect(resumed.runs).toHaveLength(12);
    expect(new Set(resumed.runs.map(({ plannedRunId }) => plannedRunId)).size).toBe(12);
    expect(resumed.baseline?.gitStatus).toBe("");
    expect(resumed.status).toBe("completed");
  });

  it.each([42, {}, [], true])("rejects invalid Git status %p before backend.open()", async (invalidGitStatus) => {
    const plan = planFromRaw();
    const { state } = await interruptedExecution(plan);
    const corrupted = JSON.parse(JSON.stringify(state)) as ExperimentExecutionState;
    mutable(corrupted.baseline!).gitStatus = invalidGitStatus;
    const backend = new FakeBackend(state.baseline);
    let agentCalls = 0;
    await expect(runExperimentPlan({
      plan,
      backend,
      targetPath: "C:/explicit-target",
      previousState: corrupted,
      executor: {
        async execute() {
          agentCalls += 1;
          return successfulAgentResult();
        },
      },
    })).rejects.toThrow(/gitStatus must be a string or null/);
    expect(backend.openCount).toBe(0);
    expect(agentCalls).toBe(0);
  });

  it("preserves a valid future human review without rewriting it", async () => {
    const plan = planFromRaw();
    const state = await runExperimentPlan({
      plan,
      backend: new FakeBackend(),
      targetPath: "C:/explicit-target",
      executor: successfulExecutor,
      now: deterministicClock(),
    });
    const reviewed = JSON.parse(JSON.stringify(state)) as ExperimentExecutionState;
    const reviewedRun = mutable(reviewed.runs[0]!.run);
    reviewedRun.humanReviewStatus = "approved";
    reviewedRun.reviewer = "human-reviewer";
    reviewedRun.reviewedAt = "2026-10-07T11:00:00.000Z";
    const backend = new FakeBackend(reviewed.baseline);
    const resumed = await runExperimentPlan({
      plan,
      backend,
      targetPath: "C:/explicit-target",
      previousState: reviewed,
      executor: successfulExecutor,
      now: deterministicClock(),
    });
    expect(resumed.runs[0]!.run).toMatchObject({
      humanReviewStatus: "approved",
      reviewer: "human-reviewer",
      reviewedAt: "2026-10-07T11:00:00.000Z",
    });
    expect(backend.requests).toHaveLength(0);
  });

  it("interrompt le run 5, laisse les suivants pending puis reprend sans dupliquer", async () => {
    const plan = planFromRaw();
    const { state: interrupted, clock } = await interruptedExecution(plan);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.runs).toHaveLength(12);
    expect(interrupted.runs.slice(0, 4).every(({ run }) => run.technicalStatus === "completed")).toBe(true);
    expect(interrupted.runs[4]!.run.technicalStatus).toBe("cancelled");
    expect(interrupted.runs[4]!.attempt).toBe(1);
    expect(interrupted.runs.slice(5).every(({ run }) => run.technicalStatus === "pending")).toBe(true);
    expect(interrupted.events.at(-2)?.type).toBe("run_cancelled");
    expect(interrupted.events.at(-1)?.type).toBe("plan_interrupted");

    const resumedIds: string[] = [];
    const resumed = await runExperimentPlan({
      plan,
      backend: new FakeBackend(interrupted.baseline),
      targetPath: "C:/explicit-target",
      previousState: interrupted,
      executor: {
        async execute({ plannedRun }) {
          resumedIds.push(plannedRun.id);
          return successfulAgentResult();
        },
      },
      now: clock,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.runs).toHaveLength(12);
    expect(new Set(resumed.runs.map(({ plannedRunId }) => plannedRunId)).size).toBe(12);
    expect(resumedIds).toEqual(plan.plannedRuns.slice(4).map(({ id }) => id));
    expect(resumed.runs.slice(0, 4).every(({ attempt }) => attempt === 1)).toBe(true);
    expect(resumed.runs[4]!.attempt).toBe(2);
    expect(resumed.runs.slice(5).every(({ attempt }) => attempt === 1)).toBe(true);
    expect(resumed.events.some(({ type }) => type === "plan_resumed")).toBe(true);
    expect(resumed.events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: resumed.events.length }, (_, index) => index + 1),
    );
  });

  it("reprend aussi un état running hérité avec attempt incrémenté", async () => {
    const plan = planFromRaw();
    const { state } = await interruptedExecution(plan);
    const inherited = JSON.parse(JSON.stringify(state)) as ExperimentExecutionState;
    const inheritedRun = mutable(inherited.runs[4]!.run);
    inheritedRun.technicalStatus = "running";
    delete inheritedRun.finishedAt;
    mutable(inherited).status = "running";
    mutable(inherited).events = inherited.events.slice(0, -2);
    const resumed = await runExperimentPlan({
      plan,
      backend: new FakeBackend(state.baseline),
      targetPath: "C:/explicit-target",
      previousState: inherited,
      executor: successfulExecutor,
      now: deterministicClock(),
    });
    expect(resumed.runs[4]!.attempt).toBe(2);
    expect(resumed.runs[4]!.run.technicalStatus).toBe("completed");
  });

  it("isole une erreur locale, poursuit les runs suivants et ne rejoue pas failed", async () => {
    const plan = planFromRaw();
    const executed: number[] = [];
    const executor: ExperimentAgentExecutor = {
      async execute({ plannedRun }) {
        executed.push(plannedRun.ordinal);
        if (plannedRun.ordinal === 5) throw new Error("synthetic local failure");
        return successfulAgentResult();
      },
    };
    const state = await runExperimentPlan({
      plan,
      backend: new FakeBackend(),
      targetPath: "C:/explicit-target",
      executor,
      now: deterministicClock(),
    });
    expect(executed).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(state.status).toBe("completed_with_failures");
    expect(state.runs[4]!.run.technicalStatus).toBe("failed");
    expect(state.runs[5]!.run.technicalStatus).toBe("completed");
    expect(state.runs.every(({ run }) => run.humanReviewStatus === "pending_review")).toBe(true);

    const resumeExecutions: string[] = [];
    const resumed = await runExperimentPlan({
      plan,
      backend: new FakeBackend(state.baseline),
      targetPath: "C:/explicit-target",
      previousState: state,
      executor: {
        async execute({ plannedRun }) {
          resumeExecutions.push(plannedRun.id);
          return successfulAgentResult();
        },
      },
      now: deterministicClock(),
    });
    expect(resumeExecutions).toEqual([]);
    expect(resumed.status).toBe("completed_with_failures");
    expect(resumed.runs[4]!.attempt).toBe(1);
  });

  it("refuse un plan fingerprint différent avant d'ouvrir le backend", async () => {
    const original = planFromRaw();
    const { state } = await interruptedExecution(original);
    const different = createExperimentExecutionPlan({ id: "different-plan", experiments: original.experiments });
    const backend = new FakeBackend();
    await expect(runExperimentPlan({
      plan: different,
      backend,
      targetPath: "C:/explicit-target",
      previousState: state,
      executor: successfulExecutor,
    })).rejects.toThrow(/plan fingerprint/);
    expect(backend.openCount).toBe(0);
  });

  it.each([
    ["workspace", { workspaceFingerprint: "changed-workspace" }],
    ["HEAD", { gitHead: "changed-head" }],
    ["tree", { gitTree: "changed-tree" }],
    ["status", { gitStatus: "changed-status" }],
    ["image", { image: "changed-image:27" }],
    ["policy", { policyFingerprint: "changed-policy" }],
  ])("refuse une baseline de reprise différente (%s) avant tout run", async (_label, change) => {
    const plan = planFromRaw();
    const { state } = await interruptedExecution(plan);
    const backend = new FakeBackend(baseline(change));
    let agentCalls = 0;
    await expect(runExperimentPlan({
      plan,
      backend,
      targetPath: "C:/explicit-target",
      previousState: state,
      executor: {
        async execute() {
          agentCalls += 1;
          return successfulAgentResult();
        },
      },
    })).rejects.toThrow(/baseline differs/);
    expect(agentCalls).toBe(0);
    expect(backend.closeCount).toBe(1);
  });
});
