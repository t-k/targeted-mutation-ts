export function encode(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

export function decode(bytes: Uint8Array) {
  return new DataView(bytes.buffer).getUint16(0, true);
}

export class Store {
  #data = new Map<string, string>();

  apply(entries: [string, string][]) {
    if (entries.some(([, value]) => value === '')) return false;
    for (const [key, value] of entries) {
      if (value === '') return false;
      this.#data.set(key, value);
    }
    return true;
  }

  get(key: string) {
    return this.#data.get(key);
  }
}
