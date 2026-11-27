import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { disableProjectFsModuleCache, inside, runnerPackage, vitestDisableFsCachePlugin, vitestServerCacheOptions, vitestVersionString } from './vitest.mjs';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { workspace, config, targets, output } = input;

const manifest = runnerPackage(workspace, 'vitest');
const vitestVersion = vitestVersionString(manifest);
const fsModuleCacheDir = process.env.VITEST_FS_MODULE_CACHE_PATH;
const vitestNode = createRequire(manifest).resolve('vitest/node');
const { createVitest } = await import(pathToFileURL(vitestNode).href);

const vitest = await createVitest('test', {
  root: workspace,
  ...(config === undefined ? {} : { config: inside(workspace, config) }),
  watch: false,
  api: false,
  ui: false,
  ...vitestServerCacheOptions(vitestVersion, fsModuleCacheDir),
  related: targets.map(file => inside(workspace, file)),
}, { plugins: [vitestDisableFsCachePlugin(vitestVersion, fsModuleCacheDir)] });
disableProjectFsModuleCache(vitestVersion, null, vitest);
for (const project of vitest.projects ?? []) {
  disableProjectFsModuleCache(vitestVersion, project.config, vitest);
}

let specs;
try {
  if (typeof vitest.getRelevantTestSpecifications !== 'function') {
    throw new Error('Installed Vitest version does not support programmatic related test resolution; specify test files with --test <FILE>');
  }
  specs = await vitest.getRelevantTestSpecifications();
} finally {
  await vitest.close();
}

const resolved = [];
const seen = new Set();
for (const spec of specs ?? []) {
  if (!spec?.moduleId) continue;
  const project = spec.project?.name ?? '';
  const file = relative(workspace, inside(workspace, spec.moduleId));
  const key = JSON.stringify([project, file]);
  if (!seen.has(key)) {
    seen.add(key);
    resolved.push({ project, file });
  }
}
resolved.sort((a, b) => a.file.localeCompare(b.file) || a.project.localeCompare(b.project));
writeFileSync(output, JSON.stringify({ specs: resolved }), 'utf8');
