import { expect, it } from 'vitest';
import { byCreated, codeUnits, scalarCount } from '../src/text-order';

it('counts ASCII characters', () => expect(scalarCount('a')).toBe(1));
it('counts ASCII code units', () => expect(codeUnits('a')).toBe(1));
it('orders rows by creation time', () => expect(byCreated([
  { id: 'A', createdAt: 10, updatedAt: 20 },
  { id: 'B', createdAt: 20, updatedAt: 30 },
]).map(row => row.id).join(',')).toBe('A,B'));
