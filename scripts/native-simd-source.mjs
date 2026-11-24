import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function simdSource(root, original, scratch, scalar) {
  if (scalar || !['arm64', 'x64'].includes(process.arch) || !['darwin', 'linux'].includes(process.platform) ||
      !existsSync(resolve(root, original))) return original;
  const loops = [
    ['line_comment', 'cf6e07f63ffcc5d57ae9e50d9b68929ce6b9abee12c1d8ce0c30df4174ce353f',
      'bool value = TmtPulseParser_line_break(input, at);', '13, 10'],
    // A terminator is a byte pair, and line breaks matter only until the first one.
    ['block_comment', 'e6770b3162644da48fd1f8ff8e56d3c6b33e7e034d017d507a435ef3f8800e96',
      'bool value = TmtPulseParser_same(input, at, 42U);', null],
    ['string_end', '5c83da47f362169e93a6540a250fc7d3453d5af5bd0624696c117a9bae6508ad',
      'uint8_t value = TmtPulseMemory_peek(input, at);', 'delimiter, 92'],
  ];
  let source = readFileSync(resolve(root, original), 'utf8');
  const include = '#include "Custard.h"\n';
  const simd = '#if defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))\n';
  if (!source.includes(include)) return original;
  for (const [loop, expected, scalar, sentinels] of loops) {
    const start = source.indexOf(`\nTmtPulseParser_${loop}(`);
    const end = source.indexOf('\n}\n', start);
    if (start < 0 || end < 0) return original;
    const body = source.slice(start, end);
    // A changed scalar transition can invalidate skipping, even with the same scalar anchor.
    if (createHash('sha256').update(body).digest('hex') !== expected) return original;
    const anchor = `    else\n    {\n      ${scalar}`;
    const at = body.indexOf(anchor);
    if (at < 0) return original;
    const position = start + at + anchor.length - scalar.length - 6;
    const run = sentinels === null ? ['17U', 'tmt_comment_run(input.source + at, newline)'] :
      ['16U', `tmt_simd_scan(input.source + at, ${sentinels})`];
    const fast = `${simd}      if (at < input.size && fuel >= 16U && input.size - at >= ${run[0]}) {
        const unsigned skipped = ${run[1]};
        if (skipped != 0U) { at += skipped; fuel -= skipped; continue; }
      }
#endif
`;
    source = source.slice(0, position) + fast + source.slice(position);
  }
  const output = resolve(scratch, 'Custard.simd.c');
  const header = simd + '#include "tmt_simd_scan.h"\n#endif\n';
  writeFileSync(output, source.replace(include, include + header));
  return output;
}

// Parser functions for rare syntax. The build inlines aggressively, and their bodies inside the expression and
// statement parsers slowed every file by 2 to 3 percent on x64. Marked cold and not inlined they cost a call
// only where the syntax occurs.
const rare = ['angle_assertion_head', 'local_enum_declaration', 'local_enum_start', 'enum_body_tokens',
  'simple_less_argument', 'single_less_byte', 'type_arguments_end_at_call_close', 'local_abstract_class', 'class_index_signature', 'runtime_namespace', 'runtime_namespace_members',
  'bare_greater_between'];

export function coldSource(root, original, scratch) {
  if (!existsSync(resolve(root, original))) return original;
  let source = readFileSync(resolve(root, original), 'utf8');
  let marked = 0;
  for (const name of rare) {
    const definition = new RegExp(`\\n((?:static )?TmtPulseParser_\\w+\\nTmtPulseParser_${name}\\()`);
    if (!definition.test(source)) continue;
    source = source.replace(definition, '\n__attribute__((noinline, cold)) $1');
    marked++;
  }
  if (marked === 0) return original;
  const output = resolve(scratch, 'Custard.cold.c');
  writeFileSync(output, source);
  return output;
}
