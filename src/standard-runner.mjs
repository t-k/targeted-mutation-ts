import { appendFileSync } from 'node:fs';
import { VitestTestRunner } from 'vitest/runners';

export default class StandardMutationRunner extends VitestTestRunner {
  onAfterRunFiles(files) {
    super.onAfterRunFiles(files);
    const state = globalThis[Symbol.for('targeted-mutation-ts/session')];
    if (!state) return;
    const { mutantCoverage, hitCount, focused } = globalThis.__stryker__;
    appendFileSync(state.destination, JSON.stringify({
      modules: files.map(file => [file.projectName ?? '', file.filepath]),
      coverage: mutantCoverage, hits: hitCount, focused,
    }) + '\n');
  }
}
