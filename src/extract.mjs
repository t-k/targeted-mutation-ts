import { isUtf8 } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import { binaryPath } from './runtime-binaries.mjs';
import { invalidEncoding, normalize, optionsFor } from './source-text.mjs';

export { byteOffsets, sourceDialect } from './source-text.mjs';

const load = createRequire(import.meta.url);
const nativePath = binaryPath('tmt.node');
const native = nativePath ? load(nativePath) : null;
const operators = ['', '<', '<=', '>', '>='];
const reasons = ['', 'outside-l1', 'source-limit', 'depth-limit', 'candidate-limit', 'duplicate-lexical'];
export const rule = 'comparison-boundary/v1';

// Extracted operator starts are in byte order and lie on UTF-8 code-point boundaries.
export function byteLocations(source, offsets) {
  if (!offsets.length) return [];
  if (native?.locations && source.length < 0xffffffff) return native.locations(source, Uint32Array.from(offsets));
  return offsets.flatMap(offset => {
    const lines = source.toString('utf8', 0, offset).split(/\r\n|[\n\r\u2028\u2029]/);
    return [lines.length, lines.at(-1).length + 1];
  });
}

function duplicateLexical(source, rows, file, metrics) {
  const [, , , , first, firstEnd, start, end] = rows;
  const name = source.toString('utf8', start, end);
  return { path: 'diagnostic', reason: 'duplicate-lexical', metrics, candidates: [], diagnostics: [{
    severity: 'error', message: `Identifier '${name}' has already been declared`, path: file ?? null, start, end,
    labels: [
      { start: first, end: firstEnd, message: `'${name}' was first declared as a variable here` },
      { start, end, message: 'cannot be redeclared here' },
    ],
    help: `Consider removing or renaming this declaration of '${name}'`,
  }] };
}

export function extractFallback(input, options = {}) {
  const source = normalize(input);
  if (source === null) return invalidEncoding();
  const { dialect, mode } = optionsFor(options);
  const parserOptions = { dialect, mode, logical: !!options.logical, file: options.file };
  if (isMainThread) {
    try {
      const { extractTypeScript } = load('./typescript-extraction.mjs');
      return extractTypeScript(source, parserOptions);
    } catch (error) {
      if (!(error instanceof RangeError && error.message === 'Maximum call stack size exceeded')) throw error;
    }
  }

  // Worker stacks can be smaller than the compiler's recursive parser requires.
  const { spawnSync } = load('node:child_process');
  const child = spawnSync(process.execPath, [
    '--max-old-space-size=512', fileURLToPath(new URL('./fallback-process.mjs', import.meta.url)),
  ], {
    input: JSON.stringify({ source, options: parserOptions }),
    stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL',
  });
  if (child.error || child.status !== 0) {
    const reason = child.error?.message ?? (child.signal ? `signal ${child.signal}` : `status ${child.status}`);
    const stderr = child.stderr?.trim();
    const cause = child.error ?? (stderr ? new Error(stderr.slice(0, 1024)) : undefined);
    throw new Error(`The isolated parser failed with ${reason}`, { cause });
  }
  try {
    return JSON.parse(child.output[3]);
  } catch (cause) {
    throw new Error('The isolated parser returned an unreadable result', { cause });
  }
}

export function extract(input, options = {}) {
  if (!native && options.requireNative) throw new Error(`The native extractor is not available for ${process.platform} ${process.arch}. ` +
      'Prebuilt binaries cover macOS and Linux (glibc) on arm64 and x64; check that optional dependencies were installed. ' +
      'In a source checkout, run npm run build:native to build the extractor.');
  const { dialect, mode } = optionsFor(options);
  let reason = 'native-unavailable';
  let metrics;
  let fallbackInput = input;
  if (native) {
    const inputString = typeof input === 'string';
    let source;
    if (inputString) {
      if (!input.isWellFormed()) return invalidEncoding();
      source = Buffer.from(input);
    } else {
      try {
        const view = ArrayBuffer.isView(input);
        if (!view && !types.isAnyArrayBuffer(input)) return invalidEncoding();
        const buffer = view ? input.buffer : input;
        source = Buffer.from(buffer, view ? input.byteOffset : 0, input.byteLength);
        if (types.isSharedArrayBuffer(buffer)) fallbackInput = source = Buffer.from(source);
        if (!isUtf8(source)) return invalidEncoding();
      } catch {
        return invalidEncoding();
      }
    }
    const rows = native.parse(source, dialect === 'tsx', mode === 'module');
    if (!types.isUint32Array(rows)) throw new Error('Run npm run build:native to rebuild the extractor');
    const status = rows[0];
    metrics = { maxDepth: rows[1], astNodes: rows[2], candidateBytes: rows[3] };
    if (status === 0) {
      const candidates = [];
      for (let i = 4; i < rows.length; i += 8) {
        candidates.push({
          rule, operator: operators[rows[i]], replacement: operators[rows[i + 1]],
          edit: [rows[i + 2], rows[i + 3]], left: [rows[i + 4], rows[i + 5]], right: [rows[i + 6], rows[i + 7]],
        });
      }
      return { path: 'fast', metrics, candidates };
    }
    reason = reasons[status];
    if (status === 5) return duplicateLexical(source, rows, options.file, metrics);
    if (native.standalone) {
      return { path: 'diagnostic', reason, metrics, candidates: [], diagnostics: [{
        severity: 'error', message: 'Standalone Low* extraction declined the source', start: 0, end: 0,
      }] };
    }
  }
  return { ...extractFallback(fallbackInput, options), reason, metrics };
}
