import { readFileSync, writeFileSync } from 'node:fs';
import { extractFallback } from './extract.mjs';

const { source, options, allowTokens } = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(3, JSON.stringify(extractFallback(source, options, allowTokens)));
