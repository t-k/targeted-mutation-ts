'use strict';

// The source map of a file whose legacy decorators were lowered in two steps: the decorators were rewritten
// in the source, and the rewritten text was compiled with a map of its own. That map leads to the rewritten
// text; here it is led on to the source. Text that the rewriting wrote has no place in the source and is
// marked as generated, as the emitter marks its own.

const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const values = new Map(Array.from(digits, (digit, index) => [digit, index]));

function decodeLine(line, state) {
  const segments = [];
  let column = 0, at = 0;
  while (at < line.length) {
    const fields = [];
    for (; at < line.length && line[at] !== ','; ) {
      let value = 0, shift = 0, digit;
      do {
        digit = values.get(line[at++]);
        if (digit === undefined) return null;
        value += (digit & 31) * 2 ** shift;
        shift += 5;
      } while (digit >= 32 && at < line.length);
      if (digit >= 32) return null;
      fields.push(value % 2 ? -(value - 1) / 2 : value / 2);
    }
    at++;
    column += fields[0];
    if (fields.length === 1) segments.push([column]);
    else if (fields.length === 4 && fields[1] === 0) {
      state.line += fields[2];
      state.column += fields[3];
      segments.push([column, state.line, state.column]);
    } else return null;
  }
  return segments;
}

function encode(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1, text = '';
  do {
    const digit = rest & 31;
    rest >>>= 5;
    text += digits[rest ? digit | 32 : digit];
  } while (rest);
  return text;
}

const lineStarts = text => {
  const starts = [0];
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit === 10 || unit === 0x2028 || unit === 0x2029) starts.push(at + 1);
    else if (unit === 13) { if (text.charCodeAt(at + 1) === 10) at++; starts.push(at + 1); }
  }
  return starts;
};

// `spans` are the pieces of the rewritten text in bytes, as lowerLegacyDecorators reports them, and `code` is
// the output that `mappings` describes. Returns the mappings from the output to `source`, or null when the
// map cannot be led on.
function composeLegacyMappings(source, rewritten, spans, mappings, code) {
  const original = source.toString(), text = rewritten.toString();
  // The pieces in UTF-16 units of the two texts.
  const pieces = [];
  let written = 0, writtenBytes = 0;
  // The copied pieces come in the order of the source, so each place is counted on from the one before.
  let counted = 0, countedBytes = 0;
  for (const [length, at] of spans) {
    if (length === 0) continue;
    const width = rewritten.toString('utf8', writtenBytes, writtenBytes + length).length;
    let from = -1;
    if (at >= 0) {
      if (at < countedBytes) { counted = 0; countedBytes = 0; }
      counted += source.toString('utf8', countedBytes, at).length;
      countedBytes = at;
      from = counted;
    }
    pieces.push({ first: written, last: written + width, from });
    written += width;
    writtenBytes += length;
  }
  if (written !== text.length) return null;
  const rewrittenStarts = lineStarts(text), originalStarts = lineStarts(original);
  const generated = mappings.split(';');
  const rows = code.split(/\r\n|[\n\r\u2028\u2029]/);
  if (generated.length > rows.length) return null;
  const state = { line: 0, column: 0 };
  let piece = 0, sourceLine = 0, previousLine = 0, previousColumn = 0;
  // Generated text is marked once, where it first follows a mapped copy, on the same line or a later one.
  let unmapped = true;
  const out = [];
  for (const [row, line] of generated.entries()) {
    const segments = decodeLine(line, state);
    if (segments === null) return null;
    let text_ = '', column = 0, first = true;
    const put = (at, place) => {
      if (place < 0) {
        if (unmapped) return;
        unmapped = true;
        text_ += (first ? '' : ',') + encode(at - column);
      } else {
        while (sourceLine + 1 < originalStarts.length && originalStarts[sourceLine + 1] <= place) sourceLine++;
        while (originalStarts[sourceLine] > place) sourceLine--;
        const sourceColumn = place - originalStarts[sourceLine];
        text_ += (first ? '' : ',') + encode(at - column) + 'A' + encode(sourceLine - previousLine) + encode(sourceColumn - previousColumn);
        previousLine = sourceLine;
        previousColumn = sourceColumn;
        unmapped = false;
      }
      column = at;
      first = false;
    };
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (segment.length === 1) { put(segment[0], -1); continue; }
      if (segment[1] >= rewrittenStarts.length) return null;
      // The copy runs to the next segment of the line, or to the end of the line of the output: generated
      // text behind a copy has a segment of its own.
      const start = rewrittenStarts[segment[1]] + segment[2];
      const end = start + ((index + 1 < segments.length ? segments[index + 1][0] : rows[row].length) - segment[0]);
      if (start > text.length || end > text.length || end < start) return null;
      while (piece > 0 && pieces[piece].first > start) piece--;
      while (piece + 1 < pieces.length && pieces[piece].last <= start) piece++;
      for (let at = start, current = piece; at < Math.max(end, start + 1) && current < pieces.length; current++) {
        const part = pieces[current];
        if (part.last <= at) continue;
        // A segment that this splitting adds sits on a token, as the emitter's own do: blanks at the start
        // of a piece are passed over.
        let token = at;
        if (at !== start && part.from >= 0) {
          // (The output is looked at, not the rewritten text: where a type was erased it holds blanks.)
          for (let unit; token < part.last && token < end && ((unit = rows[row].charCodeAt(segment[0] + (token - start))) === 32 || unit === 9); ) token++;
        }
        if (token < Math.min(part.last, Math.max(end, start + 1))) put(segment[0] + (token - start), part.from < 0 ? -1 : part.from + (token - part.first));
        at = part.last;
      }
    }
    out.push(text_);
  }
  return out.join(';');
}

// Composes a map of an ECMAScript module (`esmMappings`, mapping `esmBytes` to the original source) with the
// pieces (`spans`: `[byteLength, esmByteOffset]`, `-1` for generated text) that `toCommonJs` assembled into
// `cjsBytes`. Returns the VLQ mappings string from `cjsCode` to the original source, or null if invalid.
function composeCommonJsMappings(esmBytes, cjsBytes, spans, esmMappings, cjsCode) {
  const esmCode = esmBytes.toString();
  const esmLines = esmMappings.split(';');
  const esmStarts = lineStarts(esmCode);
  if (esmLines.length > esmStarts.length) return null;
  const decoded = [];
  const state = { line: 0, column: 0 };
  for (const line of esmLines) {
    const segments = decodeLine(line, state);
    if (segments === null) return null;
    decoded.push(segments);
  }
  const cjsRows = cjsCode.split(/\r\n|[\n\r\u2028\u2029]/);
  const out = Array.from({ length: cjsRows.length }, () => '');
  const lastCol = new Int32Array(cjsRows.length);
  const hasSeg = new Uint8Array(cjsRows.length);
  let previousLine = 0, previousColumn = 0, unmapped = true;
  const put = (row, col, sLine, sCol) => {
    if (row >= cjsRows.length) return;
    if (sLine < 0) {
      if (unmapped) return;
      if (hasSeg[row] && col <= lastCol[row]) return;
      unmapped = true;
      out[row] += (hasSeg[row] ? ',' : '') + encode(col - lastCol[row]);
      lastCol[row] = col;
      hasSeg[row] = 1;
      return;
    }
    if (hasSeg[row] && col <= lastCol[row]) return;
    out[row] += (hasSeg[row] ? ',' : '') + encode(col - lastCol[row]) + 'A' + encode(sLine - previousLine) + encode(sCol - previousColumn);
    previousLine = sLine;
    previousColumn = sCol;
    lastCol[row] = col;
    hasSeg[row] = 1;
    unmapped = false;
  };
  let cjsRow = 0, cjsCol = 0, cjsByte = 0;
  let esmCharCounted = 0, esmByteCounted = 0, esmRow = 0;
  const advanceCjs = str => {
    for (let i = 0; i < str.length; i++) {
      const u = str.charCodeAt(i);
      if (u === 10 || u === 0x2028 || u === 0x2029) { cjsRow++; cjsCol = 0; }
      else if (u === 13) { if (str.charCodeAt(i + 1) === 10) i++; cjsRow++; cjsCol = 0; }
      else cjsCol++;
    }
  };
  for (const [byteLen, esmByteAt] of spans) {
    if (byteLen === 0) continue;
    const chunk = cjsBytes.toString('utf8', cjsByte, cjsByte + byteLen);
    cjsByte += byteLen;
    if (esmByteAt < 0) {
      put(cjsRow, cjsCol, -1, 0);
      advanceCjs(chunk);
      continue;
    }
    if (esmByteAt < esmByteCounted) { esmCharCounted = 0; esmByteCounted = 0; esmRow = 0; }
    esmCharCounted += esmBytes.toString('utf8', esmByteCounted, esmByteAt).length;
    esmByteCounted = esmByteAt;
    let esmPos = esmCharCounted;
    while (esmRow + 1 < esmStarts.length && esmStarts[esmRow + 1] <= esmPos) esmRow++;
    while (esmRow > 0 && esmStarts[esmRow] > esmPos) esmRow--;
    let offset = 0;
    while (offset < chunk.length) {
      let lineEnd = offset;
      while (lineEnd < chunk.length) {
        const u = chunk.charCodeAt(lineEnd);
        if (u === 10 || u === 13 || u === 0x2028 || u === 0x2029) break;
        lineEnd++;
      }
      const sliceLen = lineEnd - offset;
      const esmColStart = esmPos - esmStarts[esmRow];
      const esmColEnd = esmColStart + sliceLen;
      const segs = esmRow < decoded.length ? decoded[esmRow] : [];
      if (sliceLen > 0) {
        // Find active segment at esmColStart.
        let active = null, firstAfter = segs.length;
        for (let i = 0; i < segs.length; i++) {
          if (segs[i][0] < esmColStart) active = segs[i];
          else { firstAfter = i; break; }
        }
        const nextSegCol = firstAfter < segs.length ? Math.min(segs[firstAfter][0], esmColEnd) : esmColEnd;
        if (active !== null && esmColStart < nextSegCol) {
          if (active.length === 1) put(cjsRow, cjsCol, -1, 0);
          else {
            let tok = 0;
            while (esmColStart + tok < nextSegCol) {
              const u = chunk.charCodeAt(offset + tok);
              if (u !== 32 && u !== 9) break;
              tok++;
            }
            if (esmColStart + tok < nextSegCol) {
              put(cjsRow, cjsCol + tok, active[1], active[2] + (esmColStart + tok - active[0]));
            }
          }
        }
        for (let i = firstAfter; i < segs.length && segs[i][0] < esmColEnd; i++) {
          const seg = segs[i];
          const targetCol = cjsCol + (seg[0] - esmColStart);
          if (seg.length === 1) put(cjsRow, targetCol, -1, 0);
          else put(cjsRow, targetCol, seg[1], seg[2]);
        }
      }
      if (lineEnd < chunk.length) {
        const nl = chunk.charCodeAt(lineEnd) === 13 && chunk.charCodeAt(lineEnd + 1) === 10 ? 2 : 1;
        offset = lineEnd + nl;
        esmPos += sliceLen + nl;
        esmRow++;
        cjsRow++;
        cjsCol = 0;
      } else {
        cjsCol += sliceLen;
        offset = lineEnd;
        esmPos += sliceLen;
      }
    }
  }
  if (cjsByte !== cjsBytes.length) return null;
  return out.join(';');
}

exports.composeLegacyMappings = composeLegacyMappings;
exports.composeCommonJsMappings = composeCommonJsMappings;
