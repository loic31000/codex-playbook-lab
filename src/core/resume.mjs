import { getResumeState, initializeTestStorage, migrateLegacyGeneratedCase } from './result-storage.mjs';

export async function inspectResume(resultsDir, tests) {
  const states = [];
  for (const test of tests) {
    const paths = await initializeTestStorage(resultsDir, test);
    await migrateLegacyGeneratedCase(resultsDir, test, paths);
    states.push({ test, paths, state: await getResumeState(paths) });
  }
  return states;
}
