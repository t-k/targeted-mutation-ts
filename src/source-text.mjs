export function byteOffsets(source) {
  const offsets = new Uint32Array(source.length + 1);
  let unit = 0;
  let byte = 0;
  for (const char of source) {
    offsets[unit] = byte;
    unit += char.length;
    byte += Buffer.byteLength(char);
  }
  offsets[unit] = byte;
  return offsets;
}

export function sourceDialect(file) {
  return /\.[jt]sx$/.test(file) ? 'tsx' : 'ts';
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function optionsFor(options) {
  const dialect = options.dialect ?? sourceDialect(options.file);
  const mode = options.mode ?? 'module';
  if (!['ts', 'tsx'].includes(dialect) || !['script', 'module'].includes(mode)) {
    throw new Error('Expected ts/tsx and script/module dialect options');
  }
  return { dialect, mode };
}

export function normalize(input) {
  if (typeof input === 'string') return input.isWellFormed() ? input : null;
  try {
    return decoder.decode(input);
  } catch {
    return null;
  }
}

export function invalidEncoding() {
  return { path: 'diagnostic', reason: 'invalid-utf8', candidates: [], diagnostics: [
    { severity: 'error', message: 'Expected well-formed UTF-8', start: 0, end: 0 },
  ] };
}
