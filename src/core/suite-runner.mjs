import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runOneTest } from './test-runner.mjs';
import { discoverPrompts, selectPrompt } from './prompt-discovery.mjs';
import { ensureResultsWritable } from './config.mjs';
import { fail } from '../ui/console.mjs';

export async function prepareSuite(config, selector) {
  const prompts = await discoverPrompts(config.playbookDir, config.casesPerPrompt);
  const selected = selector ? [selectPrompt(prompts, selector)] : prompts;
  return { prompts, selected };
}

export async function runSuite(config, { selector, prepared, runOneTestImpl = runOneTest } = {}) {
  await ensureResultsWritable(config.resultsDir);
  const { prompts, selected } = prepared ?? await prepareSuite(config, selector);
  const manifest = prompts.map((test) => test.kind === 'fixed-benchmark' ? {
    kind: 'fixed-benchmark', id: test.id, fingerprint: test.fingerprint, prompt: test.promptId,
    benchmark: test.benchmarkId, expectation: test.expectation, source: test.sourcePath,
    folder: test.id, case: `${test.id}/case.md`, display_name: test.displayName,
  } : {
    kind: 'generated', id: test.id, fingerprint: test.fingerprint, prompt: test.relativePath,
    folder: test.id, case: `${test.id}/case.md`, case_index: test.caseIndex,
    display_name: test.displayName, legacy_id: test.legacyId,
  });
  await writeFile(path.join(config.resultsDir, 'generated-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const summary = [];
  for (let index = 0; index < selected.length; index += 1) {
    const test = selected[index];
    console.log(`\n[${index + 1}/${selected.length}] ${test.displayName}`);
    try {
      const result = await runOneTestImpl(config, test);
      summary.push({ id: test.id, status: result.status });
    } catch (error) {
      fail(`${test.id} : ${error.message}`);
      summary.push({ id: test.id, status: 'failed', error: error.message,
        rateLimit: Boolean(error.rateLimit), infrastructure: Boolean(error.infrastructure), environment: Boolean(error.environment),
        interruptionSignal: error.result?.interruptionSignal ?? null });
      if (error.rateLimit || error.infrastructure || error.environment || error.result?.interrupted) break;
    }
    await writeFile(path.join(config.resultsDir, 'suite-summary.md'), renderSummary(summary), 'utf8');
  }
  await writeFile(path.join(config.resultsDir, 'suite-summary.md'), renderSummary(summary), 'utf8');
  const interrupted = summary.find((x) => x.interruptionSignal);
  const infrastructureFailure = summary.some((x) => x.rateLimit || x.infrastructure || x.environment);
  const failed = summary.some((x) => x.status === 'failed');
  const exitCode = interrupted ? (interrupted.interruptionSignal === 'SIGTERM' ? 143 : 130)
    : infrastructureFailure ? 2 : failed ? 1 : 0;
  return { prompts, summary, exitCode };
}

function renderSummary(items) {
  return `# Résumé de la suite\n\n${items.map((x) => `- ${x.id}: ${x.status}${x.error ? ` — ${x.error}` : ''}`).join('\n')}\n`;
}
