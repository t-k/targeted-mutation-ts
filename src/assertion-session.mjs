import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyVitestSessionSupport, disableProjectFsModuleCache, inside, invalidateVitestSessionModules, vitestDisableFsCachePlugin, vitestServerCacheOptions } from './vitest.mjs';

// Warm Vitest 4/5 child process for `--suggest-assertions`: runs with `cwd: workspace` in an isolated process
// communicating over a dedicated Node IPC channel (so config stdout cannot corrupt protocol messages, Vitest's
// `process.exitCode` mutations never leak to the CLI, and timeouts can terminate the entire process group).
const [, , rawWorkspace, configArg] = process.argv;
const applyEdit = (input, [start, end], replacement) => Buffer.concat([input.subarray(0, start), Buffer.from(replacement), input.subarray(end)]);

function reply(message) {
  if (typeof process.send === 'function' && process.connected) process.send(message);
}

function clearWarmVitestState(instance) {
  const vitestState = instance.state;
  if (!vitestState) return;
  vitestState.filesMap?.clear?.();
  vitestState.idMap?.clear?.();
  vitestState.taskFileMap?.clear?.();
  vitestState.reportedTasksMap?.clear?.();
  vitestState.clearErrors?.();
}

let vitest;
try {
  const workspace = realpathSync(rawWorkspace);
  const config = configArg ? inside(workspace, configArg) : undefined;
  const req = createRequire(resolve(workspace, 'package.json'));
  const version = req('vitest/package.json').version;
  const versionSupport = classifyVitestSessionSupport(version);
  if (!versionSupport.supported) {
    reply({ ready: false, reason: versionSupport.reason });
    process.exit(0);
  }
  const fsModuleCacheDir = process.env.VITEST_FS_MODULE_CACHE_PATH;
  const { createVitest } = await import(pathToFileURL(req.resolve('vitest/node')).href);
  vitest = await createVitest('test', {
    root: workspace, config, watch: false, api: false, ui: false,
    ...vitestServerCacheOptions(version, fsModuleCacheDir),
    pool: 'threads', isolate: true, maxConcurrency: 1, maxWorkers: 1, fileParallelism: false,
    coverage: { enabled: false }, onConsoleLog: () => false,
    reporters: [{ onInit() {} }],
  }, { plugins: [vitestDisableFsCachePlugin(version, fsModuleCacheDir)] });
  disableProjectFsModuleCache(version, null, vitest);
  const configSupport = classifyVitestSessionSupport(version, vitest.projects.map(project => project.config), {
    allowGlobalSetup: false,
    rootGlobalSetup: vitest.config.globalSetup,
  });
  if (!configSupport.supported) {
    reply({ ready: false, reason: configSupport.reason });
    await vitest.close();
    process.exit(0);
  }
  for (const project of vitest.projects) {
    disableProjectFsModuleCache(version, project.config, vitest);
  }
  const specCache = new Map();
  let queue = Promise.resolve();
  let doneResolve;
  const done = new Promise(resolveDone => { doneResolve = resolveDone; });
  process.on('disconnect', () => doneResolve());
  process.on('message', reqMsg => {
    if (!reqMsg || typeof reqMsg !== 'object') return;
    if (reqMsg.close) { doneResolve(); return; }
    queue = queue.then(async () => {
      const { id, testFile, rewriteContent, collect, trial, subjectFile, subjectDigest } = reqMsg;
      const absTest = inside(workspace, testFile);
      const origTest = readFileSync(absTest);
      const absSubject = subjectFile ? inside(workspace, subjectFile) : null;
      const origSubject = absSubject ? readFileSync(absSubject) : null;
      const absCollect = resolve(workspace, collect);
      try {
        if (absSubject && subjectDigest && createHash('sha256').update(origSubject).digest('hex') !== subjectDigest) {
          reply({ id, error: `Source changed during analysis: ${subjectFile}` });
          return;
        }
        if (!specCache.has(absTest)) {
          const specs = await vitest.globTestSpecifications([absTest]);
          if (!specs.length) {
            reply({ id, unsupported: true });
            return;
          }
          specCache.set(absTest, specs);
        }
        writeFileSync(absTest, rewriteContent);
        if (absSubject && trial) writeFileSync(absSubject, applyEdit(origSubject, trial.edit, trial.replacement));
        clearWarmVitestState(vitest);
        invalidateVitestSessionModules(vitest, [absTest, absSubject]);
        await vitest.runTestSpecifications(specCache.get(absTest));
        const collected = existsSync(absCollect) ? readFileSync(absCollect, 'utf8') : '';
        reply({ id, collected });
      } catch (error) {
        reply({ id, error: error?.message ?? String(error) });
      } finally {
        rmSync(absCollect, { force: true });
        writeFileSync(absTest, origTest);
        if (absSubject && origSubject) writeFileSync(absSubject, origSubject);
        invalidateVitestSessionModules(vitest, [absTest, absSubject]);
      }
    });
  });
  reply({ ready: true });
  await done;
  await queue;
} catch (error) {
  reply({ ready: false, reason: error?.message ?? String(error) });
} finally {
  if (vitest) await Promise.race([vitest.close().catch(() => {}), new Promise(resolveClose => setTimeout(resolveClose, 5_000))]);
  process.exit(0);
}
