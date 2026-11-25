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

const metadataHelper = 'var __metadata = (this && this.__metadata) || function (k, v) {\n' +
  '    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);\n};\n';
const { serializer } = require('./compiler-legacy-metadata.cjs');

const plainName = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// White space and comments in front of the first statement.
const leadingTrivia = /^(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*/;

// What the file says about the names its type annotations may mention.
const declaringWord = /\b(type|interface|enum|namespace|module|function|class)\b(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*\*?\s*([A-Za-z_$][\w$]*)/g;
const importAlias = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*=/g;
const callable = /\bextends\b|[{;,\n\r/]\s*(?:\(|<|new\b)/;
const listedName = /(?:^<|,)\s*(?:(?:const|in|out)\s+)*([A-Za-z_$][\w$]*)/g;

function lowerLegacyDecorators(addon, source, metadata = false) {
  const records = metadata ? addon.legacyDecoratorRecords?.(source, true) : addon.legacyDecoratorRecords?.(source);
  if (!records) return null;
  const text = source.latin1Slice();
  const slice = (first, last) => source.utf8Slice(first, last);
  // For metadata: where annotations end, by the place of their colon; and the names of the file.
  const annotations = new Map();
  const names = { classes: new Set(), interfaces: new Set(), typeOnly: new Set(), declared: new Set(), parameters: new Set() };
  const declarations = new Map();
  const temps = [];
  const temp = () => {
    // TypeScript's names for temporaries: _a to _z without _i and _n, then _0, _1 and so on.
    const letters = 'abcdefghjklmopqrstuvwxyz';
    temps.push('_' + (temps.length < letters.length ? letters[temps.length] : temps.length - letters.length));
    return temps[temps.length - 1];
  };
  const serialize = serializer(names, temp);
  if (metadata) {
    // A name that looks like a temporary would change the names TypeScript picks.
    if (/(?<![\w$])_(?:[a-z]|\d+)(?![\w$])/.test(text)) return null;
    // Per name, the words that declare it anywhere in the text, with their count.
    for (const found of text.matchAll(declaringWord)) {
      names.declared.add(found[2]);
      const entry = declarations.get(found[2]) ?? declarations.set(found[2], { count: 0, words: new Set() }).get(found[2]);
      entry.count++;
      entry.words.add(found[1]);
    }
    for (const found of text.matchAll(importAlias)) {
      names.declared.add(found[1]);
      (declarations.get(found[1]) ?? declarations.set(found[1], { count: 0, words: new Set() }).get(found[1])).words.add('import');
    }
    // What stands at module level is known from the records: kind 51 is a class there, kind 8 an erased statement.
    const interfaces = new Map();
    for (let at = 0; at < records.length; at += 5) {
      const kind = records[at];
      if (kind === 7 || kind === 22) annotations.set(records[at + 1], records[at + 2]);
      else if (kind === 59) for (const found of text.slice(records[at + 1], records[at + 2]).matchAll(listedName)) names.parameters.add(found[1]);
      else if (kind === 51) {
        const name = slice(records[at + 3], records[at + 4]);
        const entry = declarations.get(name);
        if (entry !== undefined && entry.count === 1 && entry.words.size === 1) names.classes.add(name);
      } else if (kind === 8) {
        const statement = text.slice(records[at + 1], records[at + 2]);
        const found = /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(statement);
        // An interface that can be called or constructed is a Function, and one that extends another may be
        // one; such a declaration is not counted, so the name stays without a certain meaning.
        if (found !== null && !callable.test(statement.slice(found[0].length))) interfaces.set(found[1], (interfaces.get(found[1]) ?? 0) + 1);
      }
    }
    // A name that only interfaces at module level declare is a type without a value.
    for (const [name, count] of interfaces) {
      const entry = declarations.get(name);
      if (entry !== undefined && entry.count === count && entry.words.size === 1) names.interfaces.add(name);
    }
    if (!typeOnlyImports(text, records, names)) return null;
  }
  // The serialized type of the annotation whose colon stands at or behind `from`; Object without one.
  const typeAt = (from, rest) => {
    const gap = /^[ \t\r\n]*/.exec(text.slice(from, from + 256))[0].length;
    const mark = text[from + gap];
    if (mark === '/') return null;
    if (mark !== ':') return 'Object';
    const end = annotations.get(from + gap);
    if (end === undefined) return null;
    let type = slice(from + gap + 1, end);
    if (rest) {
      // A rest parameter gives the type of its elements.
      const element = /^([\s\S]*\S)\s*\[\s*\]\s*$/.exec(type);
      if (element === null || /[|&?]|=>/.test(element[1])) return null;
      type = element[1];
    }
    return serialize(type);
  };
  const context = { metadata, text, typeAt, used: false };
  const edits = [];
  let pending = [];
  // The classes that are open and lowered here, innermost last. Each knows how many class bodies were open
  // around its head, so that its members can be told from those of a class expression inside it.
  const open = [];
  let depth = 0;
  let params = false;
  let any = false;
  let decorated = false;
  const top = () => (open.length !== 0 ? open[open.length - 1] : null);
  for (let at = 0; at < records.length; at += 5) {
    const kind = records[at], leftFirst = records[at + 1], leftLast = records[at + 2];
    const rightFirst = records[at + 3], rightLast = records[at + 4];
    const current = top();
    if (kind === 50) {
      decorated = true;
      pending.push({ first: leftFirst, last: leftLast, expression: slice(rightFirst, rightLast) });
    } else if (kind === 21) {
      // A member that is erased whole: an abstract member, an overload signature, a declared field.
      if (current !== null && depth > current.depth) current.erased.push([leftFirst, leftLast]);
    } else if (kind === 51 || kind === 60) {
      // A class declaration: at module level, inside a function or a block, or the default export.
      // Decorators in front of it are its own.
      const head = text.slice(leftFirst, leftLast);
      const isDefault = /^export\b/.test(head) && /\bdefault\b/.test(head);
      let name = slice(rightFirst, rightLast);
      if (name === '' && isDefault) {
        // TypeScript names the class of an anonymous default export itself.
        if (text.includes('default_1')) return null;
        name = 'default_1';
      }
      if (!plainName.test(name)) return null;
      open.push({ local: kind === 60, headFirst: leftFirst, headLast: leftLast, nameFirst: rightFirst, nameLast: rightLast, name, depth,
        exported: /^export\b/.test(head), isDefault, decorators: pending, members: [], constructor: [], member: null, erased: [] });
      // A decorator behind `export default` goes with the head when the head is rewritten.
      for (const decorator of pending) if (decorator.first < leftFirst) edits.push([decorator.first, decorator.last, '']);
      pending = [];
    } else if (kind === 55) {
      // A class body. Only the body of a class that is lowered here holds members that are lowered here.
      if (pending.length !== 0) return null;
      if (current !== null && depth === current.depth && current.bodyFirst === undefined) current.bodyFirst = leftFirst;
      depth++;
    } else if (kind === 56) {
      if (pending.length !== 0) return null;
      depth--;
    } else if (kind === 52) {
      if (current === null || depth !== current.depth + 1) {
        // A member of a class this cut does not lower may carry no decorator.
        if (pending.length !== 0) return null;
        continue;
      }
      const flags = leftLast;
      // A quoted key is written with its quotes.
      const member = { flags, key: flags & 16 ? slice(rightFirst - 1, rightLast + 1) : slice(rightFirst, rightLast), decorators: pending, parameters: [],
        start: leftFirst, keyFirst: rightFirst, keyLast: flags & 16 ? rightLast + 1 : rightLast, all: [], listEnd: -1 };
      if (pending.length !== 0) {
        if (flags & (32 | 4)) return null;
        for (const decorator of pending) edits.push([decorator.first, decorator.last, '']);
      }
      pending = [];
      current.member = member;
      current.members.push(member);
    } else if (kind === 53) {
      if (current === null || depth !== current.depth + 1 || current.member === null || pending.length === 0) return null;
      const member = current.member;
      // A setter counts its one parameter from another base; such an index is not below the list's limit.
      if (leftFirst >= 32 || (member.flags & 32)) return null;
      const entry = { index: leftFirst, decorators: pending };
      if (member.flags & 4) current.constructor.push(entry); else member.parameters.push(entry);
      edits.push([rightFirst, rightLast, '']);
      pending = [];
      params = true;
    } else if (kind === 57) {
      // Every parameter of a member, for the types of the metadata.
      if (current !== null && depth === current.depth + 1 && current.member !== null && current.member.listEnd < 0) {
        current.member.all.push({ index: leftFirst, start: leftLast });
      }
    } else if (kind === 58) {
      if (current !== null && depth === current.depth + 1 && current.member !== null && current.member.listEnd < 0) {
        current.member.listEnd = leftFirst;
      }
    } else if (kind === 54) {
      if (current === null || depth !== current.depth || pending.length !== 0) return null;
      const before = temps.length;
      const lowered = closeClass(current, text, leftLast, context);
      // Temporaries of a class inside a function are declared in that function, which is not done here.
      if (lowered !== null && temps.length !== before && current.local) return null;
      if (lowered === null) return null;
      if (lowered.length !== 0) { any = true; for (const edit of lowered) edits.push(edit); }
      open.pop();
    }
  }
  if (open.length !== 0 || pending.length !== 0 || depth !== 0) return null;
  // No decorator at all: the at signs stand in comments or strings, and the source compiles as it is.
  if (!decorated) return source;
  if (!any) return null;
  // The helpers stand in front of the first statement. A directive or an interpreter line has to stay first.
  const start = leadingTrivia.exec(text)[0].length;
  if (text.startsWith('#!') || text[start] === '"' || text[start] === "'") return null;
  edits.push([start, start, decorateHelper + (context.used ? metadataHelper : '') + (params ? paramHelper : '') +
    (temps.length !== 0 ? `var ${temps.join(', ')};\n` : '')]);
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
function closeClass(found, text, end, context) {
  const statements = [];
  const seen = new Set();
  const whole = found.decorators.length !== 0 || found.constructor.length !== 0;
  // The types of the constructor's parameters are serialized first, as TypeScript does.
  let constructorTypes = null;
  if (context.metadata && whole) {
    const constructors = found.members.filter(member => member.flags & 4);
    if (constructors.length > 1) return null;
    if (constructors.length === 1) {
      constructorTypes = parameterTypes(constructors[0], context);
      if (constructorTypes === null) return null;
    }
  }
  // The types of the members follow in the order of the source, which is the order of TypeScript's temporaries.
  const memberValues = new Map();
  if (context.metadata) {
    for (const member of found.members) {
      if ((member.flags & 4) || (member.decorators.length === 0 && member.parameters.length === 0)) continue;
      const values = memberMetadata(member, found, context);
      if (values === null) return null;
      memberValues.set(member, values);
    }
  }
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
    if (context.metadata) { list.push(...memberValues.get(member)); context.used = true; }
    const target = member.flags & 1 ? found.name : found.name + '.prototype';
    const key = quoted ? member.key : JSON.stringify(member.key);
    statements.push(`__decorate([${list.join(', ')}], ${target}, ${key}, ${member.flags & 2 ? 'void 0' : 'null'});`);
  }
  const anonymous = found.nameFirst === found.nameLast;
  if (!whole && statements.length === 0) return [];
  if (!whole) {
    // `export default class {}` gets the name the statements use, and stays the declaration it is.
    return [...(anonymous ? [[found.headLast, found.headLast, ' ' + found.name + ' ']] : []),
      [end, end, '\n' + statements.join('\n') + '\n']];
  }
  // Inside the body of a named class expression its name means the undecorated class. TypeScript gives the
  // decorated one a second name and writes that name for every reference in the body. Here the expression
  // loses its name instead, so that the body sees the variable: a static block stores the class in it before
  // any other static member runs, and the decorated class replaces it afterwards.
  const named = !anonymous &&
    new RegExp('(?<![\\w$.])' + found.name.replace(/\$/g, '\\$') + '(?![\\w$])').test(text.slice(found.nameLast, end));
  if (named && (found.bodyFirst === undefined || text[found.bodyFirst] !== '{')) return null;
  const list = found.decorators.map(decorator => decorator.expression);
  for (const parameter of found.constructor) {
    for (const decorator of parameter.decorators) list.push(`__param(${parameter.index}, ${decorator.expression})`);
  }
  if (constructorTypes !== null) context.used = true;
  if (constructorTypes !== null) list.push(`__metadata("design:paramtypes", [${constructorTypes.join(', ')}])`);
  statements.push(`${found.name} = __decorate([${list.join(', ')}], ${found.name});`);
  if (found.isDefault) statements.push(`export default ${found.name};`);
  else if (found.exported) statements.push(`export { ${found.name} };`);
  // A class expression cannot be abstract, so the members that are erased anyway go with the modifier.
  return [
    ...(named ? [[found.headFirst, found.nameLast, `let ${found.name};\n${found.name} = class`],
      [found.bodyFirst + 1, found.bodyFirst + 1, ` static { ${found.name} = this; }`]] :
      [[found.headFirst, found.headLast, `let ${found.name} = class `]]),
    ...found.erased.map(([first, last]) => [first, last, '']),
    [end, end, ';\n' + statements.join('\n') + '\n'],
  ];
}

const parameterHead = /^(?:(?:public|private|protected|readonly|override)\s+)*(\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*\??/;

// The serialized types of a member's parameters, or null.
function parameterTypes(member, context) {
  if (member.listEnd < 0) return null;
  const types = [];
  for (const [position, parameter] of member.all.entries()) {
    // A setter counts its one parameter from another base.
    if (parameter.index !== position && !(member.flags & 8)) return null;
    const head = parameterHead.exec(context.text.slice(parameter.start, parameter.start + 512));
    if (head === null || head[2] === 'this') return null;
    const type = context.typeAt(parameter.start + head[0].length, head[1] !== undefined);
    if (type === null) return null;
    types.push(type);
  }
  return types;
}

// The __metadata calls of one decorated member: its type, the types of its parameters, its return type.
function memberMetadata(member, found, context) {
  const { text } = context;
  if (member.flags & 2) {
    const mark = text[member.keyLast];
    const type = context.typeAt(mark === '?' || mark === '!' ? member.keyLast + 1 : member.keyLast, false);
    return type === null ? null : [`__metadata("design:type", ${type})`];
  }
  const modifiers = text.slice(member.start, member.keyFirst);
  if (member.flags & 8) {
    // TypeScript reads the type of an accessor from both of its declarations.
    const same = found.members.filter(other => (other.flags & 8) && (other.flags & 1) === (member.flags & 1) && other.key === member.key);
    if (same.length !== 1) return null;
    // TypeScript serializes the type of a setter's parameter twice: as the type of the member, then in the list.
    const first = member.all.length === 1 ? parameterTypes(member, context) : member.all.length === 0 ? [context.typeAt(member.listEnd, false)] : null;
    if (first === null || first[0] === null) return null;
    const types = parameterTypes(member, context);
    if (types === null) return null;
    return [`__metadata("design:type", ${first[0]})`, `__metadata("design:paramtypes", [${types.join(', ')}])`];
  }
  const types = parameterTypes(member, context);
  if (types === null) return null;
  const gap = /^[ \t\r\n]*/.exec(text.slice(member.listEnd, member.listEnd + 256))[0].length;
  const annotated = text[member.listEnd + gap] === ':';
  // Without an annotation an async method returns a Promise, and any other method nothing.
  const result = annotated ? context.typeAt(member.listEnd, false) : /\basync\b/.test(modifiers) ? 'Promise' : 'void 0';
  if (result === null) return null;
  return ['__metadata("design:type", Function)', `__metadata("design:paramtypes", [${types.join(', ')}])`, `__metadata("design:returntype", ${result})`];
}

// Enters the names of type-only imports. They are read at the places the parser erased, so that the words of
// a string or a comment are not taken for an import: kind 8 is an erased statement, kind 14 an erased part
// such as a specifier. False when such a place is written in a way that is not read here.
function typeOnlyImports(text, records, names) {
  for (let at = 0; at < records.length; at += 5) {
    const erased = text.slice(records[at + 1], records[at + 2]);
    if (records[at] === 8) {
      const statement = /^import\s+type\s+([^'"]*?)\s+from\b/.exec(erased);
      if (statement === null) continue;
      const clause = statement[1].replace(/\b[A-Za-z_$][\w$]*\s+as\s+/g, '').replace(/\*\s*as\s+/, '');
      if (/[^\w$\s,{}]/.test(clause)) return false;
      for (const name of clause.matchAll(/[A-Za-z_$][\w$]*/g)) names.typeOnly.add(name[0]);
    } else if (records[at] === 14 && /^type\s/.test(erased)) {
      const specifier = /^type\s+(?:(?:[A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s+as\s+)?([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(erased);
      if (specifier === null) return false;
      names.typeOnly.add(specifier[1]);
    }
  }
  return true;
}

exports.lowerLegacyDecorators = lowerLegacyDecorators;
