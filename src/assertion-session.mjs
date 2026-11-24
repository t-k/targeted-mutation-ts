import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { inside } from './vitest.mjs';

// Warm Vitest 4 child process for `--suggest-assertions`: runs with `cwd: workspace` in an isolated process
// (so Vitest's `process.exitCode` mutations never leak to the CLI and timeouts can terminate the process group).
const [, , workspace, configArg] = process.argv;
const config = configArg ? inside(workspace, configArg) : undefined;
const applyEdit = (input, [start, end], replacement) => Buffer.concat([input.subarray(0, start), Buffer.from(replacement), input.subarray(end)]);

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

let vitest;
try {
  const req = createRequire(resolve(workspace, 'package.json'));
  const version = req('vitest/package.json').version;
  if (!version.startsWith('4.')) {
    reply({ ready: false, reason: `Requires Vitest 4, found ${version}` });
    process.exit(0);
  }
  const { createVitest } = await import(pathToFileURL(req.resolve('vitest/node')).href);
  vitest = await createVitest('test', {
    root: workspace, config, watch: false, api: false, ui: false, cache: false,
    pool: 'threads', isolate: true, maxConcurrency: 1, maxWorkers: 1, fileParallelism: false,
    coverage: { enabled: false }, onConsoleLog: () => false,
    reporters: [{ onInit() {} }],
  });
  for (const project of vitest.projects) {
    if (project.config.browser?.enabled || project.config.typecheck?.enabled || project.config.runner) {
      reply({ ready: false, reason: 'Unsupported Vitest project configuration for warm session' });
      await vitest.close();
      process.exit(0);
    }
  }
  reply({ ready: true });

  const specCache = new Map();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const reqMsg = JSON.parse(line);
    if (reqMsg.close) break;
    const { id, testFile, rewriteContent, collect, trial, subjectFile, subjectDigest } = reqMsg;
    const absTest = inside(workspace, testFile);
    const origTest = readFileSync(absTest);
    const absSubject = subjectFile ? inside(workspace, subjectFile) : null;
    const origSubject = absSubject ? readFileSync(absSubject) : null;
    const absCollect = resolve(workspace, collect);
    try {
      if (absSubject && subjectDigest && createHash('sha256').update(origSubject).digest('hex') !== subjectDigest) {
        reply({ id, error: `Source changed during analysis: ${subjectFile}` });
        continue;
      }
      if (!specCache.has(absTest)) {
        const specs = await vitest.globTestSpecifications([absTest]);
        if (!specs.length) {
          reply({ id, unsupported: true });
          continue;
        }
        specCache.set(absTest, specs);
      }
      writeFileSync(absTest, rewriteContent);
      if (absSubject && trial) writeFileSync(absSubject, applyEdit(origSubject, trial.edit, trial.replacement));
      vitest.vite?.moduleGraph?.invalidateAll();
      for (const project of vitest.projects) project.vite?.moduleGraph?.invalidateAll();
      await vitest.runTestSpecifications(specCache.get(absTest));
      const collected = existsSync(absCollect) ? readFileSync(absCollect, 'utf8') : '';
      reply({ id, collected });
    } catch (error) {
      reply({ id, error: error?.message ?? String(error) });
    } finally {
      rmSync(absCollect, { force: true });
      writeFileSync(absTest, origTest);
      if (absSubject && origSubject) writeFileSync(absSubject, origSubject);
    }
  }
} catch (error) {
  reply({ ready: false, reason: error?.message ?? String(error) });
} finally {
  if (vitest) await Promise.race([vitest.close().catch(() => {}), new Promise(done => setTimeout(done, 5_000))]);
  process.exit(0);
}
