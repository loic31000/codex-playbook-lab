import { runSuite } from '../core/suite-runner.mjs';
export async function suiteCommand(config, options = {}) {
  const result = await runSuite(config, { selector: options.prompt }); return result.exitCode;
}
