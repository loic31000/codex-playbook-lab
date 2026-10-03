import { runSuite } from '../core/suite-runner.mjs';
export async function resumeCommand(config) { const result = await runSuite(config); return result.exitCode; }
