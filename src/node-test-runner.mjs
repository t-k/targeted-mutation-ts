import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { run } from 'node:test';

function canonicalPath(path) {
  try {
    const resolved = realpathSync(path);
    if (process.platform !== 'win32') return resolved;
    const native = realpathSync.native(resolved);
    return !resolved.startsWith('\\\\') && native.startsWith('\\\\') ? resolved : native;
  } catch {
    return path;
  }
}

function normalizeFile(workspace, file) {
  if (typeof file !== 'string' || !file) return undefined;
  const resolved = canonicalPath(resolve(workspace, file));
  const rel = relative(workspace, resolved);
  return sep === '/' ? rel : rel.replaceAll(sep, '/');
}

function serializeError(error) {
  if (!error) return undefined;
  const cause = error.cause && typeof error.cause === 'object' ? error.cause : null;
  const rawMessage = cause?.message ?? error.message ?? String(error);
  return {
    message: String(rawMessage),
    ...(error.failureType ? { failureType: String(error.failureType) } : {}),
    ...(cause?.code ?? error.code ? { code: String(cause?.code ?? error.code) } : {}),
  };
}

const manifestPath = process.argv[2];
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const workspace = canonicalPath(manifest.workspace);
const files = Array.isArray(manifest.files) ? manifest.files : [];
const reportPath = manifest.report;
const timeout = typeof manifest.timeout === 'number' && manifest.timeout > 0 ? manifest.timeout : undefined;

const events = [];
let summary = null;
let fatalError = null;

try {
  const stream = run({
    cwd: workspace,
    isolation: 'process',
    concurrency: 1,
    ...(files.length ? { files } : {}),
    ...(timeout ? { timeout } : {}),
  });
  for await (const { type, data } of stream) {
    if (type === 'test:summary') {
      if (!data.file) {
        summary = { success: Boolean(data.success), counts: data.counts ?? {} };
      } else {
        events.push({
          type: 'test:file-summary',
          file: normalizeFile(workspace, data.file),
          success: Boolean(data.success),
          counts: data.counts ?? {},
        });
      }
      continue;
    }
    if (type !== 'test:start' && type !== 'test:pass' && type !== 'test:fail') continue;
    const file = normalizeFile(workspace, data.file);
    const entry = {
      type,
      file,
      name: String(data.name ?? ''),
      nesting: Number(data.nesting ?? 0),
      testNumber: data.testNumber,
      line: data.line,
      column: data.column,
    };
    if (type !== 'test:start') {
      if (data.skip !== undefined && data.skip !== false) entry.skip = data.skip === true ? true : String(data.skip);
      if (data.todo !== undefined && data.todo !== false) entry.todo = data.todo === true ? true : String(data.todo);
      if (data.details?.type) entry.testType = String(data.details.type);
      if (type === 'test:fail') entry.error = serializeError(data.details?.error);
    }
    events.push(entry);
  }
} catch (error) {
  fatalError = String(error?.message ?? error);
}

const payload = { workspace, events, summary, ...(fatalError ? { error: fatalError } : {}) };
writeFileSync(reportPath + '.part', JSON.stringify(payload), 'utf8');
renameSync(reportPath + '.part', reportPath);
process.exitCode = !fatalError && summary?.success === true ? 0 : 1;
