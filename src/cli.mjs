#!/usr/bin/env node
import { loadConfig } from './core/config.mjs';
import { checkCommand } from './commands/check.mjs';
import { suiteCommand } from './commands/suite.mjs';
import { testCommand } from './commands/test.mjs';
import { resumeCommand } from './commands/resume.mjs';
import { resultsCommand } from './commands/results.mjs';
import { cleanCommand } from './commands/clean.mjs';
import { mainMenu } from './ui/menu.mjs';
import { fail } from './ui/console.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPrompts } from './core/prompt-discovery.mjs';
import { saveAndValidateRun } from './core/validation.mjs';
import { legacyRunTestCommand } from './commands/legacy-run-test.mjs';

function parse(argv) {
  const positional = []; const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes') options.yes = true;
    else if (arg === '--docker') options.docker = true;
    else if (arg === '--select-only') options.selectOnly = true;
    else if (arg === '--config') options.configPath = argv[++i];
    else if (arg === '--prompt') options.prompt = argv[++i];
    else if (arg === '--id') options.id = argv[++i];
    else if (arg === '--case') options.caseFile = argv[++i];
    else if (arg === '--prompt-path') options.promptPath = argv[++i];
    else if (arg === '--name') options.name = argv[++i];
    else positional.push(arg);
  }
  return { command: positional[0], selector: positional[1], options };
}

export async function main(argv = process.argv.slice(2)) {
  let { command, selector, options } = parse(argv);
  if (!command) {
    const choice = await mainMenu();
    command = ({ 1: 'suite', 2: 'test', 3: 'resume', 4: 'check', 5: 'results', 6: 'clean', q: 'quit' })[choice];
  }
  if (command === 'quit') return 0;
  const config = await loadConfig({ configPath: options.configPath });
  if (command === 'check') return checkCommand(config, options);
  if (command === 'suite') return suiteCommand(config, options);
  if (command === 'test') return testCommand(config, { ...options, selector });
  if (command === 'resume') return resumeCommand(config);
  if (command === 'results') return resultsCommand(config);
  if (command === 'clean') return cleanCommand(config, options);
  if (command === 'list') {
    const prompts = await discoverPrompts(config.playbookDir, config.casesPerPrompt);
    prompts.forEach((p) => console.log(`${p.id}\t${p.relativePath}`)); return 0;
  }
  if (command === 'run-test') return legacyRunTestCommand(config, options);
  if (command === 'save-run') { await saveAndValidateRun({ repoDir: config.repoDir, runDir: path.join(config.resultsDir, options.name), label: options.name }); return 0; }
  throw new Error(`Commande inconnue : ${command ?? '(vide)'}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { fail(error.message); process.exitCode = 1; });
}
