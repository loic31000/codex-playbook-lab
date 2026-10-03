import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverPrompts, selectPrompt } from '../core/prompt-discovery.mjs';
import { initializeTestStorage } from '../core/result-storage.mjs';
import { runOneTest } from '../core/test-runner.mjs';

export async function legacyRunTestCommand(config, options) {
  if (!options.id || !options.caseFile || !options.promptPath) throw new Error('run-test exige --id, --case et --prompt-path.');
  const prompts = await discoverPrompts(config.playbookDir, config.casesPerPrompt);
  const selected = selectPrompt(prompts, options.promptPath);
  const test = { ...selected, id: options.id };
  const paths = await initializeTestStorage(config.resultsDir, test);
  await readFile(path.resolve(options.caseFile), 'utf8');
  await cp(path.resolve(options.caseFile), paths.caseFile, { force: true });
  await runOneTest(config, test); return 0;
}
