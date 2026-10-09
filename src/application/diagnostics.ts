export type DiagnosticStatus = "ok" | "warning" | "failure";

export interface DiagnosticCheck {
  readonly id: string;
  readonly status: DiagnosticStatus;
  readonly message: string;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DiagnosticResult {
  readonly ok: boolean;
  readonly checks: readonly DiagnosticCheck[];
}

export interface DiagnosticInput {
  readonly repoDir: string;
  readonly playbookDir: string;
  readonly evidenceStoreDir: string;
  readonly benchmarksDir?: string;
  readonly includeDocker?: boolean;
}

export interface DiagnosticsPort {
  diagnose(input: DiagnosticInput): Promise<DiagnosticResult>;
}
