import { it } from 'vitest';
import { eligible } from '../src/eligibility';

it('checks an 18-year-old', () => { eligible(18); });
