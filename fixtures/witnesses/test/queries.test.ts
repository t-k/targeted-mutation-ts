import { expect, it } from 'vitest';
import { isCurrent, isEntryCurrent, positionOf, hasFlag, sumFirst } from '../src/queries';

it('accepts a current item', () => {
  expect(isCurrent(90, 90, 100)).toBe(true);
});

it('accepts a current record', () => {
  expect(isEntryCurrent({ createdAt: 90, updatedAt: 90, expiresAt: 100 })).toBe(true);
});

it('finds a unique item', () => {
  expect(positionOf([5, 6], 5)).toBe(0);
});

it('reports a missing item', () => {
  expect(positionOf([6, 7], 5)).toBe(-1);
});

it('accepts a set flag', () => {
  expect(hasFlag(1, 1)).toBe(true);
});

it('rejects an unset flag', () => {
  expect(hasFlag(0, 1)).toBe(false);
});

it('sums two items', () => {
  expect(sumFirst([1, 2, 0], 2)).toBe(3);
});
