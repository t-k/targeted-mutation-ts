export function byteOffsets(source) {
  const offsets = new Uint32Array(source.length + 1);
  let byte = 0;
  for (let unit = 0; unit < source.length; unit++) {
    offsets[unit] = byte;
    const code = source.charCodeAt(unit);
    if (code < 0x80) byte++;
    else if (code < 0x800) byte += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(unit + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        byte += 4;
        unit++;
      } else byte += 3;
    } else byte += 3;
  }
  offsets[source.length] = byte;
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
