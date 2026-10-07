import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { runProcess, checkedProcess, type RunProcessOptions } from "./process.js";

export interface FileManifestEntry {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly sha256: string;
}

export interface WorkspaceState {
  readonly fingerprint: string;
  readonly fileFingerprint: string;
  readonly manifest: readonly FileManifestEntry[];
  readonly gitHead: string | null;
  readonly gitTree: string | null;
  readonly gitStatus: string | null;
  readonly diff: string | null;
  readonly diffFingerprint: string | null;
  readonly changedFiles: readonly string[];
}

export interface SourceState {
  readonly sourceFingerprint: string;
  readonly workspace: WorkspaceState;
}

export interface WorkspaceChangeSide {
  readonly kind: "file" | "symlink";
  readonly sha256: string;
}

export interface WorkspaceChange {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "type_changed";
  readonly before: WorkspaceChangeSide | null;
  readonly after: WorkspaceChangeSide | null;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function manifest(root: string, includeGit: boolean): Promise<readonly FileManifestEntry[]> {
  const records: FileManifestEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (!includeGit && entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink()) {
        records.push({ path: relative, kind: "symlink", sha256: sha256(await fs.readlink(absolute)) });
      } else if (entry.isFile()) {
        records.push({ path: relative, kind: "file", sha256: sha256(await fs.readFile(absolute)) });
      }
    }
  }
  await visit(root);
  return records;
}

function parseChangedFiles(status: string | null): readonly string[] {
  if (status === null) return [];
  const fields = status.split("\0").filter(Boolean);
  const changed = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const code = field.slice(0, 2);
    changed.add(field.slice(3));
    if (code.includes("R") || code.includes("C")) {
      index += 1;
      if (fields[index]) changed.add(fields[index]!);
    }
  }
  return [...changed].sort((left, right) => left.localeCompare(right, "en"));
}

async function gitOutput(root: string, args: readonly string[]): Promise<string | null> {
  const result = await runProcess("git", ["-C", root, ...args], { timeoutMs: 30_000 });
  return result.code === 0 ? result.stdout : null;
}

async function gitDiffIncludingUntracked(root: string, status: string): Promise<string> {
  let diff = await gitOutput(root, ["diff", "--binary", "HEAD", "--"]) ?? "";
  const fields = status.split("\0").filter(Boolean);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const code = field.slice(0, 2);
    const pathname = field.slice(3);
    if (code === "??") {
      const added = await runProcess(
        "git",
        ["-C", root, "diff", "--no-index", "--binary", "--", "/dev/null", pathname],
        { timeoutMs: 30_000 },
      );
      if (added.code === 1) diff += added.stdout;
      else if (added.code !== 0) throw new Error("git could not capture an untracked file diff");
    }
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return diff;
}

function createWorkspaceState(
  records: readonly FileManifestEntry[],
  gitHead: string | null,
  gitTree: string | null,
  gitStatus: string | null,
  diff: string | null,
): WorkspaceState {
  const fileFingerprint = sha256(JSON.stringify(records));
  const diffFingerprint = diff === null ? null : sha256(diff);
  return {
    fingerprint: sha256(JSON.stringify({ fileFingerprint, gitHead, gitTree, gitStatus })),
    fileFingerprint,
    manifest: records,
    gitHead,
    gitTree,
    gitStatus,
    diff,
    diffFingerprint,
    changedFiles: parseChangedFiles(gitStatus),
  };
}

export async function captureSourceState(root: string): Promise<SourceState> {
  const [workspaceManifest, sourceManifest, insideWorkTree] = await Promise.all([
    manifest(root, false),
    manifest(root, true),
    gitOutput(root, ["rev-parse", "--is-inside-work-tree"]),
  ]);
  const isGit = insideWorkTree?.trim() === "true";
  const [head, tree, status] = isGit
    ? await Promise.all([
      gitOutput(root, ["rev-parse", "HEAD"]),
      gitOutput(root, ["rev-parse", "HEAD^{tree}"]),
      gitOutput(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ])
    : [null, null, null];
  const diff = isGit && status !== null ? await gitDiffIncludingUntracked(root, status) : null;
  return {
    sourceFingerprint: sha256(JSON.stringify(sourceManifest)),
    workspace: createWorkspaceState(
      workspaceManifest,
      head?.trim() ?? null,
      tree?.trim() ?? null,
      status,
      diff,
    ),
  };
}

export function sourceStatesEqual(left: SourceState, right: SourceState): boolean {
  return left.sourceFingerprint === right.sourceFingerprint
    && left.workspace.fingerprint === right.workspace.fingerprint;
}

const VOLUME_STATE_SCRIPT = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = '/workspace';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const records = [];
function visit(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) visit(absolute);
    else if (entry.isSymbolicLink()) records.push({ path: relative, kind: 'symlink', sha256: hash(fs.readlinkSync(absolute)) });
    else if (entry.isFile()) records.push({ path: relative, kind: 'file', sha256: hash(fs.readFileSync(absolute)) });
  }
}
visit(root);
function git(args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}
const isGit = git(['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
const head = isGit ? git(['rev-parse', 'HEAD'])?.trim() ?? null : null;
const tree = isGit ? git(['rev-parse', 'HEAD^{tree}'])?.trim() ?? null : null;
const status = isGit ? git(['status', '--porcelain=v1', '-z', '--untracked-files=all']) : null;
let diff = isGit ? git(['diff', '--binary', 'HEAD', '--']) ?? '' : null;
if (isGit && status) {
  const fields = status.split('\0').filter(Boolean);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const code = field.slice(0, 2);
    const pathname = field.slice(3);
    if (code === '??') {
      const added = spawnSync('git', ['-C', root, 'diff', '--no-index', '--binary', '--', '/dev/null', pathname], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (added.status === 1) diff += added.stdout;
    }
    if (code.includes('R') || code.includes('C')) index += 1;
  }
}
process.stdout.write(JSON.stringify({ records, head, tree, status, diff }));
`;

export async function captureVolumeWorkspaceState(
  volume: string,
  image: string,
  options: Pick<RunProcessOptions, "signal"> = {},
): Promise<WorkspaceState> {
  const inspectionContainer = `codex-lab-strict-inspect-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  let result;
  try {
    result = await checkedProcess("docker", [
      "run", "--rm", "--name", inspectionContainer, "--network", "none", "--read-only",
      "--mount", `type=volume,src=${volume},dst=/workspace,readonly`,
      "--user", "10001:10001", "--entrypoint", "node",
      image, "-e", VOLUME_STATE_SCRIPT,
    ], { signal: options.signal, timeoutMs: 120_000 });
  } finally {
    await runProcess("docker", ["rm", "--force", inspectionContainer], { timeoutMs: 30_000 });
  }
  const parsed = JSON.parse(result.stdout) as {
    records: FileManifestEntry[];
    head: string | null;
    tree: string | null;
    status: string | null;
    diff: string | null;
  };
  return createWorkspaceState(parsed.records, parsed.head, parsed.tree, parsed.status, parsed.diff);
}

export function changedFilesBetween(
  initial: WorkspaceState,
  final: WorkspaceState,
): readonly string[] {
  return workspaceChangesBetween(initial, final).map((change) => change.path);
}

export function workspaceChangesBetween(
  initial: WorkspaceState,
  final: WorkspaceState,
): readonly WorkspaceChange[] {
  const before = new Map(initial.manifest.map((entry) => [entry.path, `${entry.kind}:${entry.sha256}`]));
  const after = new Map(final.manifest.map((entry) => [entry.path, `${entry.kind}:${entry.sha256}`]));
  const initialEntries = new Map(initial.manifest.map((entry) => [entry.path, entry]));
  const finalEntries = new Map(final.manifest.map((entry) => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((pathname) => before.get(pathname) !== after.get(pathname))
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((pathname) => {
      const initialEntry = initialEntries.get(pathname);
      const finalEntry = finalEntries.get(pathname);
      const beforeSide = initialEntry ? { kind: initialEntry.kind, sha256: initialEntry.sha256 } : null;
      const afterSide = finalEntry ? { kind: finalEntry.kind, sha256: finalEntry.sha256 } : null;
      const status = !initialEntry
        ? "added"
        : !finalEntry
          ? "deleted"
          : initialEntry.kind !== finalEntry.kind
            ? "type_changed"
            : "modified";
      return { path: pathname, status, before: beforeSide, after: afterSide };
    });
}
