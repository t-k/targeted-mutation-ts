import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../build/tmt-decide', import.meta.url));

export function runDecisionBatch(requests, args = []) {
  if (!requests.length || !existsSync(executable)) return null;
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
  return runDecisionBatch(requests);
}
