import { spawnSync } from 'node:child_process';
import { binaryPath } from './runtime-binaries.mjs';

let executable;
const boundaryFlips = new Map([['<', '<='], ['<=', '<'], ['>', '>='], ['>=', '>']]);

export function runDecisionBatch(requests, args = []) {
  if (!requests.length) return null;
  executable ??= binaryPath('tmt-decide') ?? '';
  if (!executable) return null;
  const result = spawnSync(executable, args, {
    encoding: 'utf8', input: JSON.stringify(requests), timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  try {
    const answers = JSON.parse(result.stdout);
    return Array.isArray(answers) && answers.length === requests.length ? answers : null;
  } catch {
    return null;
  }
}

export function checkReplay(requests) {
  return runDecisionBatch(requests.map(request => {
    if (request != null && Object.hasOwn(request, 'boundarySummary')) return null;
    if (!Array.isArray(request?.observations) || !boundaryFlips.has(request.original) ||
        boundaryFlips.get(request.original) !== request.replacement) return request;
    const { observations, ...header } = request;
    let safeAndUnequal = true;
    for (const pair of observations) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) ||
          !Number.isSafeInteger(pair[1]) || pair[0] === pair[1]) {
        safeAndUnequal = false;
        break;
      }
    }
    return { ...header, boundarySummary: { count: observations.length, safeAndUnequal } };
  }));
}
