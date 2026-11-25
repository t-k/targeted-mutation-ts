'use strict';
// The values that emitDecoratorMetadata writes for type annotations, as TypeScript serializes them when it
// compiles one file alone: a primitive names its constructor, an array or a tuple is Array, a function type
// is Function, a reference to a class of the file is the class, and a reference to a name the file does not
// declare is guarded, since it may be a type without a value:
//
//   typeof (_a = typeof Name !== "undefined" && Name) === "function" ? _a : Object
//
// A type is read from its text. Whatever is not read with certainty gives null, and TypeScript lowers the source.

const tokenPattern = new RegExp([
  '\\s+|//[^\\r\\n\\u2028\\u2029]*|/\\*[\\s\\S]*?\\*/', // 1: nothing
  '[A-Za-z_$][\\w$]*', // 2: word
  '\\d[\\w.]*', // 3: number
  '"(?:[^"\\\\\\r\\n]|\\\\.)*"|\'(?:[^\'\\\\\\r\\n]|\\\\.)*\'|`[^`$\\\\]*`', // 4: string
  '=>|\\.\\.\\.|[()\\[\\]{}<>|&.,:;?=\\-]', // 5: sign
].map(part => `(${part})`).join('|'), 'y');

function tokens(text) {
  const list = [];
  tokenPattern.lastIndex = 0;
  let at = 0;
  while (at < text.length) {
    tokenPattern.lastIndex = at;
    const found = tokenPattern.exec(text);
    if (found === null) return null;
    at = tokenPattern.lastIndex;
    if (found[1] !== undefined) continue;
    list.push({ kind: found[2] !== undefined ? 'word' : found[3] !== undefined ? 'number' : found[4] !== undefined ? 'string' : 'sign', text: found[0] });
  }
  return list;
}

const object = { kind: 'name', text: 'Object' };
const nothing = { kind: 'void', text: 'void 0' };
const named = text => ({ kind: 'name', text });
const keywords = new Map([
  ['string', named('String')], ['number', named('Number')], ['boolean', named('Boolean')], ['bigint', named('BigInt')],
  ['symbol', named('Symbol')], ['true', named('Boolean')], ['false', named('Boolean')],
  ['void', nothing], ['undefined', nothing], ['null', nothing], ['never', nothing],
  ['any', object], ['unknown', object], ['object', object], ['this', object],
]);
// Words that start a type this reading leaves alone.
const unread = new Set(['infer', 'import', 'asserts', 'unique', 'abstract', 'is', 'extends']);
const opening = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

// classify(root, qualified) says what a name stands for: 'class' is a class of the module, written as itself;
// 'object' is a type without a value; 'unknown' is a name whose meaning one file does not show, which is
// guarded; anything else is not certain. temp() gives the next temporary name, in the order TypeScript
// creates them.
function serializer(classify, temp) {
  let list, at;
  // Above zero while a part is read that TypeScript does not serialize: no temporary is made for it.
  let dry = 0;
  // A reference gets its temporary once it is known to be written.
  const materialize = value => {
    if (value === null || !value.pending) return value;
    if (dry > 0) return object;
    if (value.refused) return null;
    const name = temp();
    if (name === null) return null;
    return { kind: 'reference', key: value.key,
      text: `typeof (${name} = typeof ${value.root} !== "undefined" && ${value.key}) === "function" ? ${name} : Object` };
  };
  const peek = () => (at < list.length ? list[at].text : '');
  // The index behind the bracket that closes the one at `from`, or -1. An arrow's `>` closes nothing.
  const matching = from => {
    const stack = [];
    for (let index = from; index < list.length; index++) {
      const text = list[index].kind === 'sign' ? list[index].text : '';
      if (opening.has(text)) stack.push(opening.get(text));
      else if (text === ')' || text === ']' || text === '}' || text === '>') {
        if (stack.pop() !== text) return -1;
        if (stack.length === 0) return index + 1;
      }
    }
    return -1;
  };
  // A function type takes the rest of its level.
  const restOfLevel = () => {
    while (at < list.length) {
      const text = list[at].kind === 'sign' ? list[at].text : '';
      if (text === ')' || text === ']' || text === '}' || text === ',' || text === ';') break;
      if (opening.has(text)) { at = matching(at); if (at < 0) return false; } else at++;
    }
    return true;
  };
  const reference = () => {
    const root = list[at++].text;
    const path = [root];
    while (peek() === '.' && at + 1 < list.length && list[at + 1].kind === 'word') { path.push(list[at + 1].text); at += 2; }
    if (peek() === '<') { at = matching(at); if (at < 0) return null; }
    if (dry > 0) return object;
    // What a name stands for matters only once the reference is written: an array of it is Array all the same.
    const meaning = classify(root, path.length !== 1);
    if (meaning === 'class' && path.length === 1) return named(root);
    if (meaning === 'object' && path.length === 1) return object;
    if (meaning !== 'unknown' || path.length > 2) return { pending: true, refused: true };
    return { pending: true, root, key: path.join('.') };
  };
  const primary = () => {
    if (at >= list.length) return null;
    const token = list[at];
    if (token.kind === 'string') { at++; return named('String'); }
    if (token.kind === 'number') { at++; return /n$/.test(token.text) ? named('BigInt') : named('Number'); }
    if (token.kind === 'word') {
      const next = at + 1 < list.length ? list[at + 1].text : '';
      if (token.text === 'new') { at++; return restOfLevel() ? named('Function') : null; }
      if (token.text === 'readonly') { at++; return postfix(); }
      if (token.text === 'keyof') {
        at++;
        dry++;
        const operand = postfix();
        dry--;
        return operand === null ? null : object;
      }
      if (token.text === 'typeof') {
        at++;
        if (at >= list.length || list[at].kind !== 'word' || list[at].text === 'import') return null;
        at++;
        while (peek() === '.' && at + 1 < list.length && list[at + 1].kind === 'word') at += 2;
        if (peek() === '<') { at = matching(at); if (at < 0) return null; }
        return object;
      }
      if (unread.has(token.text)) return null;
      if (keywords.has(token.text) && next !== '.') { at++; return keywords.get(token.text); }
      return reference();
    }
    if (token.text === '-') {
      if (at + 1 >= list.length || list[at + 1].kind !== 'number') return null;
      at += 2;
      return /n$/.test(list[at - 1].text) ? named('BigInt') : named('Number');
    }
    if (token.text === '<') return restOfLevel() ? named('Function') : null;
    if (token.text === '{') { at = matching(at); return at < 0 ? null : object; }
    if (token.text === '[') { at = matching(at); return at < 0 ? null : named('Array'); }
    if (token.text === '(') {
      const behind = matching(at);
      if (behind < 0) return null;
      if (behind < list.length && list[behind].text === '=>') return restOfLevel() ? named('Function') : null;
      // A return type in front of the arrow would be `(...): T =>`, which is no type.
      // Brackets behind the parentheses make an array or an indexed access, whose inside is not serialized.
      const unwritten = behind < list.length && list[behind].text === '[';
      at++;
      if (unwritten) dry++;
      const inner = union();
      if (unwritten) dry--;
      if (inner === null || peek() !== ')') return null;
      at++;
      return inner;
    }
    return null;
  };
  function postfix() {
    let value = primary();
    while (value !== null && peek() === '[') {
      if (at + 1 < list.length && list[at + 1].text === ']') { at += 2; value = named('Array'); } else {
        at = matching(at);
        if (at < 0) return null;
        value = object;
      }
    }
    return materialize(value);
  }
  // TypeScript's rule for the members of a union or an intersection: Object as soon as one member is Object
  // or two members differ, and the members behind that one are not serialized.
  const combine = (sign, next) => {
    if (peek() === sign) at++;
    let result = null, decided = null;
    for (;;) {
      if (decided !== null) dry++;
      const part = next();
      if (decided !== null) dry--;
      if (part === null) return null;
      if (decided === null) {
        if (part.kind === 'name' && part.text === 'Object') decided = object;
        else if (result === null) result = part;
        else if (result.kind !== part.kind || (result.key ?? result.text) !== (part.key ?? part.text)) decided = object;
      }
      if (peek() !== sign) break;
      at++;
    }
    return decided ?? result;
  };
  const intersection = () => combine('&', postfix);
  function union() { return combine('|', intersection); }
  return text => {
    list = tokens(text);
    if (list === null || list.length === 0) return null;
    // never and unknown are told from the other keywords inside unions and intersections, which is not done here.
    if (list.some(token => token.kind === 'word' && (token.text === 'never' || token.text === 'unknown')) &&
        list.some(token => token.kind === 'sign' && (token.text === '|' || token.text === '&'))) return null;
    at = 0;
    dry = 0;
    const value = union();
    return value !== null && at === list.length ? value.text : null;
  };
}

exports.serializer = serializer;
