import { expect, it } from 'vitest';
import { decode, encode, Store } from '../src/contracts';

it('round-trips a nonpalindromic value', () => {
  expect(decode(encode(0x0102))).toBe(0x0102);
});

it('rejects an invalid batch', () => {
  const store = new Store();
  expect(store.apply([['a', '1'], ['b', '']])).toBe(false);
});

it('reads a successful write', () => {
  const store = new Store();
  expect(store.apply([['a', '1']])).toBe(true);
  expect(store.get('a')).toBe('1');
});
