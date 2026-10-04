import { discoverBenchmarks, selectBenchmarks } from '../core/benchmark-discovery.mjs';
import { discoverPrompts } from '../core/prompt-discovery.mjs';
import { runSuite } from '../core/suite-runner.mjs';

export async function benchmarkCommand(config, options = {}) {
  if (!config.benchmarksDir) throw new Error('Aucun benchmarks_path configuré.');
  const prompts = await discoverPrompts(config.playbookDir, 1);
  const benchmarks = await discoverBenchmarks(config.benchmarksDir, prompts);
  if (!options.selector) {
    benchmarks.forEach((item) => console.log(`${item.id}\t${item.displayName}`)); return 0;
  }
  const selected = selectBenchmarks(benchmarks, options.selector);
  const result = await runSuite(config, { prepared: { prompts: benchmarks, selected } });
  return result.exitCode;
}
