import type { JsonObject, Reproducibility, TargetRef } from "../domain/index.js";

export interface ExploratoryCaseProposal {
  readonly title: string;
  readonly markdown: string;
}

export interface ExploratoryGeneratorRequest {
  readonly generationId: string;
  readonly modelInput: string;
  readonly target: TargetRef;
  readonly requestedSeed?: string | number;
}

export interface ExploratoryGeneratorOutput {
  readonly model: string;
  readonly modelOptions: JsonObject;
  readonly seedUsed?: string | number;
  readonly reproducibility?: Reproducibility;
  readonly cases: readonly ExploratoryCaseProposal[];
}

export interface ExploratoryCaseGenerator {
  readonly id: string;
  readonly version?: string;
  generate(request: ExploratoryGeneratorRequest): Promise<ExploratoryGeneratorOutput>;
}
