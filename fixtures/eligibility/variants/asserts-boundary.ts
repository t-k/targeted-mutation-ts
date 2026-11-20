import { expect, it } from 'vitest';
import { eligible } from '../src/eligibility';

it('checks an 18-year-old', () => expect(eligible(18)).toBe(true));
