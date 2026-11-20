import { expect, it } from 'vitest';
import { eligible } from '../src/eligibility';

it('rejects a 17-year-old', () => expect(eligible(17)).toBe(false));
it('accepts a 20-year-old', () => expect(eligible(20)).toBe(true));
