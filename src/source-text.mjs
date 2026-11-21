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
