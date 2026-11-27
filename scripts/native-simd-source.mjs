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
  // Optional SIMD fast-paths for multi-byte whitespace runs in `trivia_from` and static text runs in `template_body`.
  const extraLoops = [
    ['trivia_from', '7acc224935178f6b09f022c6f46356a7894690134b6bfe067141b8c375b40502',
      'uint8_t value = TmtPulseMemory_peek(input, at);',
      `${simd}      if (at < input.size && fuel >= 16U && input.size - at >= 16U && input.source[at] <= 32U && input.source[at + 1] <= 32U) {
        const unsigned skipped = tmt_space_run(input.source + at, &newline);
        if (skipped != 0U) { at += skipped; fuel -= skipped; continue; }
      }
#endif
`],
    ['template_body', '270858e67955eed7bc10d9274482b0472740d6c1e04b89a5de603abde024ca20',
      'uint32_t at = state.offset;',
      `${simd}      if (state.offset < input.size && remaining >= 16U && input.size - state.offset >= 16U) {
        const unsigned skipped = tmt_template_run(input.source + state.offset);
        if (skipped != 0U) { state.offset += skipped; remaining -= skipped; continue; }
      }
#endif
`],
  ];
  for (const [loop, expected, scalar, fast] of extraLoops) {
    const start = source.indexOf(`\nTmtPulseParser_${loop}(`);
    if (start < 0) continue;
    const end = source.indexOf('\n}\n', start);
    if (end < 0) continue;
    const body = source.slice(start, end);
    if (createHash('sha256').update(body).digest('hex') !== expected) continue;
    const anchor = `    else\n    {\n      ${scalar}`;
    const at = body.indexOf(anchor);
    if (at < 0) continue;
    const position = start + at + anchor.length - scalar.length - 6;
    source = source.slice(0, position) + fast + source.slice(position);
  }
  // Optional SIMD fast-path for ASCII identifier scanning (`code == 1U`) in `TmtPulseScan_scan_class`.
  const scanStart = source.indexOf('\nuint32_t TmtPulseScan_scan_class(');
  if (scanStart >= 0) {
    const scanEnd = source.indexOf('\n}\n', scanStart);
    if (scanEnd >= 0) {
      const scanBody = source.slice(scanStart, scanEnd);
      if (createHash('sha256').update(scanBody).digest('hex') === 'ae7d121996e7294adf69c2c4b821fff4606fe2cb44a14c68c3ba79a51d9ab38b') {
        const anchor = '  uint32_t cursor = start;\n';
        const at = scanBody.indexOf(anchor);
        if (at >= 0) {
          const pos = scanStart + at + anchor.length;
          const fast = `${simd}  if (code == 1U) {
    while (cursor < size && size - cursor >= 16U) {
      const unsigned skipped = tmt_ident_run(source + cursor);
      cursor += skipped;
      if (skipped < 16U) return cursor;
    }
  } else if (code == 0U) {
    bool dummy_nl = true;
    while (cursor < size && size - cursor >= 16U && source[cursor] <= 32U && source[cursor + 1] <= 32U) {
      const unsigned skipped = tmt_space_run(source + cursor, &dummy_nl);
      cursor += skipped;
      if (skipped < 16U) return cursor;
    }
  } else if (code == 3U) {
    while (cursor < size && size - cursor >= 16U && source[cursor] <= 32U && source[cursor + 1] <= 32U) {
      const unsigned skipped = tmt_hspace_run(source + cursor);
      cursor += skipped;
      if (skipped < 16U) return cursor;
    }
  }
#endif
`;
          source = source.slice(0, pos) + fast + source.slice(pos);
        }
      }
    }
  }
  // Optional module-sequence-first dispatch in `TmtPulseParser_parse_attempt`:
  // For modules (`module_mode == true`), try `module_sequence` first instead of running `parse_state`
  // + `clear_marks` on every multi-statement module. Falls back to `parse_state` if `module_sequence` declines.
  const paStart = source.indexOf('\nTmtPulseParser_parse_attempt(');
  if (paStart >= 0) {
    const paEnd = source.indexOf('\n}\n', paStart);
    if (paEnd >= 0) {
      const paBody = source.slice(paStart, paEnd);
      if (createHash('sha256').update(paBody).digest('hex') === 'c524a1dcb14c782c0fe43c38d87ea27df0518476be22cd65769873d372cc489a') {
        const oldCond = '  if (module_mode || initial.status != 0U)\n    value4 = false;';
        const newCond = '  if (initial.status != 0U)\n    value4 = false;\n  else if (module_mode)\n    value4 = true;';
        if (paBody.includes(oldCond)) {
          source = source.slice(0, paStart) + paBody.replace(oldCond, newCond) + source.slice(paEnd);
        }
      }
    }
  }
  // Optional single-load big-endian word reader in `TmtPulseParser_word`.
  const wordStart = source.indexOf('\nTmtPulseParser_word(');
  if (wordStart >= 0) {
    const wordEnd = source.indexOf('\n}\n', wordStart);
    if (wordEnd >= 0) {
      const wordBody = source.slice(wordStart, wordEnd);
      if (createHash('sha256').update(wordBody).digest('hex') === '7a5c458c4fb779ea880d192e12f1ce4e9b3be0a15f7ed5b5ad12b883a6e1811d') {
        const anchor = '  TmtPulseMemory_tape input = input0;\n';
        const at = wordBody.indexOf(anchor);
        if (at >= 0) {
          const fast = `#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
  if (fuel0 <= 8U && at0 < input0.size && input0.size - at0 >= 8U) {
    if (fuel0 == 0U) return value0;
    uint64_t raw;
    memcpy(&raw, input0.source + at0, 8U);
    raw = __builtin_bswap64(raw);
    if (fuel0 == 8U) return raw;
    return (value0 << (fuel0 * 8U)) | (raw >> ((8U - fuel0) * 8U));
  }
#endif
`;
          source = source.slice(0, wordStart + at) + fast + source.slice(wordStart + at);
        }
      }
    }
  }
  // Optional memcmp fast-path in `TmtPulseParser_same_bytes`.
  const sbStart = source.indexOf('\nTmtPulseParser_same_bytes(');
  if (sbStart >= 0) {
    const sbEnd = source.indexOf('\n}\n', sbStart);
    if (sbEnd >= 0) {
      const sbBody = source.slice(sbStart, sbEnd);
      if (createHash('sha256').update(sbBody).digest('hex') === '2e43bafb1161ba7c9f95800c5ef683625179ab70d3167896efe95ac6a992e75d') {
        const anchor = '  TmtPulseMemory_tape input = input0;\n';
        const at = sbBody.indexOf(anchor);
        if (at >= 0) {
          const fast = `  if (left0 <= input0.size && right0 <= input0.size &&
      input0.size - left0 >= length0 && input0.size - right0 >= length0) {
    return length0 == 0U || memcmp(input0.source + left0, input0.source + right0, length0) == 0;
  }
`;
          source = source.slice(0, sbStart + at) + fast + source.slice(sbStart + at);
        }
      }
    }
  }
  // Optional memset fast-path in `TmtPulseMemory_clear_marks`.
  const cmStart = source.indexOf('\nvoid TmtPulseMemory_clear_marks(');
  if (cmStart >= 0) {
    const cmEnd = source.indexOf('\n}\n', cmStart);
    if (cmEnd >= 0) {
      const cmBody = source.slice(cmStart, cmEnd);
      if (createHash('sha256').update(cmBody).digest('hex') === '06c00e16e4b63b211892b3969fdfa671929f5cfbfb266a661da8929ecef4bf21') {
        const oldLine = '  Pulse_Lib_Array_zeroize((size_t)input.capacity, input.marks);';
        const newLine = '  if (input.capacity) memset(input.marks, 0, (size_t)input.capacity);';
        if (cmBody.includes(oldLine)) {
          source = source.slice(0, cmStart) + cmBody.replace(oldLine, newLine) + source.slice(cmEnd);
        }
      }
    }
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
  'bare_greater_between', 'cover_assignment_members', 'first_less_from', 'record_reference'];
// expression_end and declarators_end are not in the list: every list and every declaration ends in them, and
// only the search they start for an unmatched angle is rare. Out of line they cost about two percent.

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
