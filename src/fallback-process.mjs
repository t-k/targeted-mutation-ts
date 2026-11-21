import { readFileSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { extractTypeScript } from './typescript-extraction.mjs';

if (isMainThread) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const parser = new Worker(new URL(import.meta.url), {
    workerData: input, resourceLimits: { stackSizeMb: 16 },
  });
  parser.once('message', result => writeFileSync(3, JSON.stringify(result)));
} else {
  const { source, options } = workerData;
  parentPort.postMessage(extractTypeScript(source, options));
}
