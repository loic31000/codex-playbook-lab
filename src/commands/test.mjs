import { discoverPrompts, selectPrompt } from '../core/prompt-discovery.mjs';
import { runOneTest } from '../core/test-runner.mjs';
import { choosePrompt } from '../ui/menu.mjs';
export async function testCommand(config, options = {}) {
  const prompts = await discoverPrompts(config.playbookDir, config.casesPerPrompt);
  const test = options.selector ? selectPrompt(prompts, options.selector) : await choosePrompt(prompts);
  if (!test) return 0;
  if (options.selectOnly) { console.log(`${test.id}\t${test.relativePath}`); return 0; }
  await runOneTest(config, test); return 0;
}
