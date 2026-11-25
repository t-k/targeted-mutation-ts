'use strict';
// Decorators of TypeScript's earlier design (experimentalDecorators), lowered by rewriting the source.
//
// The parser reads the module in a mode that takes decorators on parameters and reports where decorators,
// classes, members and parameters stand. From those places the decorators are cut out and the calls that
// TypeScript writes are added behind each class:
//
//   @D class A { @E m(@F a) {} }        let A = class A { m(a) {} };
//                                 ->    __decorate([E, __param(0, F)], A.prototype, "m", null);
//                                       A = __decorate([D], A);
//
// The result is TypeScript without decorators, which the ordinary routes compile. Whatever this first cut does
// not cover returns null, and TypeScript lowers the source. A source without any decorator is returned itself.

const decorateHelper = 'var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {\n' +
  '    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;\n' +
  '    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);\n' +
  '    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;\n' +
  '    return c > 3 && r && Object.defineProperty(target, key, r), r;\n};\n';
const paramHelper = 'var __param = (this && this.__param) || function (paramIndex, decorator) {\n' +
  '    return function (target, key) { decorator(target, key, paramIndex); }\n};\n';

const plainName = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// White space and comments in front of the first statement.
const leadingTrivia = /^(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*/;

function lowerLegacyDecorators(addon, source) {
  const records = addon.legacyDecoratorRecords?.(source);
  if (!records) return null;
  const text = source.latin1Slice();
  const slice = (first, last) => source.utf8Slice(first, last);
  const edits = [];
  let pending = [];
  let current = null;
  let depth = 0;
  let params = false;
  let any = false;
  let decorated = false;
  for (let at = 0; at < records.length; at += 5) {
    const kind = records[at], leftFirst = records[at + 1], leftLast = records[at + 2];
    const rightFirst = records[at + 3], rightLast = records[at + 4];
    if (kind === 50) {
      decorated = true;
      pending.push({ first: leftFirst, last: leftLast, expression: slice(rightFirst, rightLast) });
    } else if (kind === 21) {
      // A member that is erased whole: an abstract member, an overload signature, a declared field.
      if (current !== null && depth >= 1) current.erased.push([leftFirst, leftLast]);
    } else if (kind === 51) {
      // A class at module level. Decorators in front of it are its own.
      if (current !== null || depth !== 0) return null;
      const name = slice(rightFirst, rightLast);
      if (!plainName.test(name)) return null;
      const head = text.slice(leftFirst, leftLast);
      if (/\bdefault\b/.test(head)) return null;
      current = { headFirst: leftFirst, headLast: leftLast, nameLast: rightLast, name, exported: /^export\b/.test(head),
        decorators: pending, members: [], constructor: [], member: null, erased: [] };
      for (const decorator of pending) edits.push([decorator.first, decorator.last, '']);
      pending = [];
    } else if (kind === 55) {
      // A class body. Only the body of the class at module level holds members that are lowered here.
      if (pending.length !== 0) return null;
      depth++;
    } else if (kind === 56) {
      if (pending.length !== 0) return null;
      depth--;
    } else if (kind === 52) {
      if (current === null || depth !== 1) {
        // A member of a class this cut does not lower may carry no decorator.
        if (pending.length !== 0) return null;
        continue;
      }
      const flags = leftLast;
      // A quoted key is written with its quotes.
      const member = { flags, key: flags & 16 ? slice(rightFirst - 1, rightLast + 1) : slice(rightFirst, rightLast), decorators: pending, parameters: [] };
      if (pending.length !== 0) {
        if (flags & (32 | 4)) return null;
        for (const decorator of pending) edits.push([decorator.first, decorator.last, '']);
      }
      pending = [];
      current.member = member;
      current.members.push(member);
    } else if (kind === 53) {
      if (current === null || depth !== 1 || current.member === null || pending.length === 0) return null;
      const member = current.member;
      // A setter counts its one parameter from another base; such an index is not below the list's limit.
      if (leftFirst >= 32 || (member.flags & 32)) return null;
      const entry = { index: leftFirst, decorators: pending };
      if (member.flags & 4) current.constructor.push(entry); else member.parameters.push(entry);
      edits.push([rightFirst, rightLast, '']);
      pending = [];
      params = true;
    } else if (kind === 54) {
      if (current === null || depth !== 0 || pending.length !== 0) return null;
      const lowered = closeClass(current, text, leftLast);
      if (lowered === null) return null;
      if (lowered.length !== 0) { any = true; for (const edit of lowered) edits.push(edit); }
      current = null;
    }
  }
  if (current !== null || pending.length !== 0 || depth !== 0) return null;
  // No decorator at all: the at signs stand in comments or strings, and the source compiles as it is.
  if (!decorated) return source;
  if (!any) return null;
  // The helpers stand in front of the first statement. A directive or an interpreter line has to stay first.
  const start = leadingTrivia.exec(text)[0].length;
  if (text.startsWith('#!') || text[start] === '"' || text[start] === "'") return null;
  edits.push([start, start, decorateHelper + (params ? paramHelper : '')]);
  edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const parts = [];
  let copied = 0;
  for (const [first, last, replacement] of edits) {
    if (first < copied) return null;
    parts.push(source.subarray(copied, first), Buffer.from(replacement));
    copied = last;
  }
  parts.push(source.subarray(copied));
  return Buffer.concat(parts);
}

// The statements behind a class: one __decorate call per decorated member, then the class itself.
function closeClass(found, text, end) {
  const statements = [];
  const seen = new Set();
  // TypeScript writes the members of the instances first and the static ones behind them.
  const ordered = [...found.members.filter(member => !(member.flags & 1)), ...found.members.filter(member => member.flags & 1)];
  for (const member of ordered) {
    if (member.flags & 4) continue;
    if (member.decorators.length === 0 && member.parameters.length === 0) continue;
    const quoted = (member.flags & 16) !== 0;
    if (!quoted && !plainName.test(member.key)) return null;
    // A getter and a setter of one name share their decorators; TypeScript reports decorators on both.
    const identity = (member.flags & 1) + ':' + member.key;
    if (seen.has(identity)) return null;
    seen.add(identity);
    const list = member.decorators.map(decorator => decorator.expression);
    for (const parameter of member.parameters) {
      for (const decorator of parameter.decorators) list.push(`__param(${parameter.index}, ${decorator.expression})`);
    }
    const target = member.flags & 1 ? found.name : found.name + '.prototype';
    const key = quoted ? member.key : JSON.stringify(member.key);
    statements.push(`__decorate([${list.join(', ')}], ${target}, ${key}, ${member.flags & 2 ? 'void 0' : 'null'});`);
  }
  const whole = found.decorators.length !== 0 || found.constructor.length !== 0;
  if (!whole && statements.length === 0) return [];
  if (!whole) return [[end, end, '\n' + statements.join('\n') + '\n']];
  // Inside its own body the name of the class means the undecorated class. TypeScript gives the decorated
  // one a second name there; that case is left to it.
  if (new RegExp('(?<![\\w$.])' + found.name.replace(/\$/g, '\\$') + '(?![\\w$])').test(text.slice(found.nameLast, end))) return null;
  const list = found.decorators.map(decorator => decorator.expression);
  for (const parameter of found.constructor) {
    for (const decorator of parameter.decorators) list.push(`__param(${parameter.index}, ${decorator.expression})`);
  }
  statements.push(`${found.name} = __decorate([${list.join(', ')}], ${found.name});`);
  if (found.exported) statements.push(`export { ${found.name} };`);
  // A class expression cannot be abstract, so the members that are erased anyway go with the modifier.
  return [
    [found.headFirst, found.headLast, `let ${found.name} = class `],
    ...found.erased.map(([first, last]) => [first, last, '']),
    [end, end, ';\n' + statements.join('\n') + '\n'],
  ];
}

exports.lowerLegacyDecorators = lowerLegacyDecorators;
