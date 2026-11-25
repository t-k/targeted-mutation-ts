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
// White space and comments in front of the first statement. The text is read as bytes, so the line and
// paragraph separators, which end a line comment as well, are their three bytes each.
const leadingTrivia = /^(?:[ \t\r\n\f\v]+|\/\/(?:(?!\xE2\x80[\xA8\xA9])[^\r\n])*|\/\*[\s\S]*?\*\/)*/;
const comments = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;

// What the file says about the names its type annotations may mention.
const declaringWord = /\b(type|interface|enum|namespace|module|function|class)\b(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*\*?\s*([A-Za-z_$][\w$]*)/g;
const importAlias = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*=/g;
// A variable whose value is the result of a call: `const IFoo = createDecorator<IFoo>('foo')`.
const calledValue = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[<(]/g;
const callable = /\bextends\b|[{;,\n\r/]\s*(?:\(|<|new\b)/;

// Whether the call whose type arguments or arguments begin at `at` ends the statement it stands in.
function wholeCall(text, at) {
  const closing = { '(': ')', '[': ']', '{': '}', '<': '>' };
  for (let round = 0; round < 2; round++) {
    if (round === 0 && text[at] !== '<') continue;
    if (round === 1 && text[at] !== '(') return false;
    const stack = [];
    for (; at < text.length; at++) {
      const unit = text[at];
      // A string, a comment or an arrow inside the call is not followed here.
      if (unit === '"' || unit === "'" || unit === '`' || unit === '/' || (unit === '=' && text[at + 1] === '>')) {
        if (unit === '"' || unit === "'") {
          const end = text.indexOf(unit, at + 1);
          if (end < 0 || /[\\\r\n]/.test(text.slice(at + 1, end))) return false;
          at = end;
          continue;
        }
        return false;
      }
      if (closing[unit] !== undefined && (unit !== '<' || round === 0)) stack.push(closing[unit]);
      else if (unit === ')' || unit === ']' || unit === '}' || (unit === '>' && round === 0)) {
        if (stack.pop() !== unit) return false;
        if (stack.length === 0) { at++; break; }
      }
    }
    if (round === 0) while (text[at] === ' ' || text[at] === '\t') at++;
  }
  const rest = /^[ \t]*(.?)/.exec(text.slice(at, at + 64))[1];
  return rest === ';' || rest === '' || rest === '\r' || rest === '\n';
}

const listedName = /(?:^<|,)\s*(?:(?:const|in|out)\s+)*([A-Za-z_$][\w$]*)/g;

function lowerLegacyDecorators(addon, source, metadata = false, jsx = false) {
  const records = addon.legacyDecoratorRecords?.(source, metadata, jsx);
  if (!records) return null;
  const text = source.latin1Slice();
  const slice = (first, last) => source.utf8Slice(first, last);
  // The line and paragraph separators end a line comment and count as white space. The text is read here as
  // bytes, where they are three bytes each; a source that holds one is left to TypeScript.
  if (/\xE2\x80[\xA8\xA9]/.test(text)) return null;
  // For metadata: where annotations end, by the place of their colon; and the names of the file.
  const annotations = new Map();
  // Type parameters, wherever they are declared.
  const parameters = new Set();
  // Per name: the words that declare it anywhere in the text; what binds it at module level (record kind 61:
  // 1 a class, 2 an interface, 3 a type-only import, 4 an import, 5 a value, 9 anything else); and its
  // interface declarations at module level.
  const declarations = new Map();
  const bindings = new Map();
  const interfaces = new Map();
  const calledValues = new Map();
  const scope = { local: false };
  const temps = [];
  const temp = () => {
    // TypeScript's names for temporaries: _a to _z without _i and _n, then _0, _1 and so on.
    const letters = 'abcdefghjklmopqrstuvwxyz';
    temps.push('_' + (temps.length < letters.length ? letters[temps.length] : temps.length - letters.length));
    return temps[temps.length - 1];
  };
  // What a name in a type annotation stands for: 'class' is a class of the module, 'object' a type without a
  // value, 'unknown' a name whose meaning one file does not show, and 'refused' anything not certain.
  const classify = (root, qualified) => {
    // Inside a function a parameter or a variable may hide the name.
    if (scope.local || parameters.has(root)) return 'refused';
    const kinds = bindings.get(root) ?? [];
    const declared = declarations.get(root);
    // Nothing at module level binds the name, or an import does. A declaration elsewhere in the text may hide it.
    if (kinds.length === 0 || (kinds.length === 1 && kinds[0] === 4)) return declared === undefined ? 'unknown' : 'refused';
    if (qualified) return 'refused';
    if (kinds.length === 1 && kinds[0] === 1) {
      return declared !== undefined && declared.count === 1 && declared.words.size === 1 && declared.words.has('class') ? 'class' : 'refused';
    }
    if (kinds.length === 1 && kinds[0] === 3) {
      // `import { type T }` reads like the head of a type alias; it is the one declaration the name may have.
      const inline = declared !== undefined && declared.count === 1 && declared.words.size === 1 && declared.words.has('type') &&
        new RegExp('[{,]\\s*type\\s+' + root.replace(/\$/g, '\\$') + '\\s*[,}]').test(text);
      return declared === undefined || inline ? 'object' : 'refused';
    }
    // An interface, or several of one name. A value of the same name makes the name a constructor when its
    // type is one; the result of a call to an imported function is not known to be one.
    const faces = kinds.filter(kind => kind === 2).length, values = kinds.filter(kind => kind === 5).length;
    const found = interfaces.get(root);
    if (faces === 0 || faces + values !== kinds.length || values > 1 || found === undefined || found.callable || found.count !== faces ||
        declared === undefined || declared.words.size !== 1 || !declared.words.has('interface') || declared.count !== faces) return 'refused';
    if (values === 1) {
      const called = calledValues.get(root);
      if (called === undefined || called.count !== 1) return 'refused';
      const callee = bindings.get(called.callee) ?? [];
      if (callee.length !== 1 || callee[0] !== 4 || declarations.has(called.callee)) return 'refused';
    }
    return 'object';
  };
  const serialize = serializer(classify, temp);
  if (metadata) {
    // A name that looks like a temporary would change the names TypeScript picks.
    if (/(?<![\w$])_(?:[a-z]|\d+)(?![\w$])/.test(text)) return null;
    for (const found of text.matchAll(declaringWord)) {
      const entry = declarations.get(found[2]) ?? declarations.set(found[2], { count: 0, words: new Set() }).get(found[2]);
      entry.count++;
      entry.words.add(found[1]);
    }
    for (const found of text.matchAll(importAlias)) {
      (declarations.get(found[1]) ?? declarations.set(found[1], { count: 0, words: new Set() }).get(found[1])).words.add('import');
    }
    for (const found of text.matchAll(calledValue)) {
      const entry = calledValues.get(found[1]) ?? calledValues.set(found[1], { count: 0, callee: found[2] }).get(found[1]);
      // The call has to be the whole value: an assertion behind it may name a constructor type.
      entry.count += wholeCall(text, found.index + found[0].length - 1) ? 1 : 2;
    }
    // A second variable of the name, however it gets its value, leaves the name uncertain.
    for (const [name, entry] of calledValues) {
      const escaped = name.replace(/\$/g, '\\$');
      if ([...text.matchAll(new RegExp('(?<![\\w$.])' + escaped + '\\s*=(?![=>])', 'g'))].length !== 1) entry.count = 2;
    }
    for (let at = 0; at < records.length; at += 5) {
      const kind = records[at];
      if (kind === 7 || kind === 22) annotations.set(records[at + 1], records[at + 2]);
      else if (kind === 59) for (const found of text.slice(records[at + 1], records[at + 2]).matchAll(listedName)) parameters.add(found[1]);
      else if (kind === 61) {
        const name = slice(records[at + 1], records[at + 2]);
        (bindings.get(name) ?? bindings.set(name, []).get(name)).push(records[at + 3]);
      } else if (kind === 8) {
        // An erased statement at module level. An interface that can be called or constructed is a Function,
        // and one that extends another may be one.
        const statement = text.slice(records[at + 1], records[at + 2]);
        const found = /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(statement);
        if (found === null) continue;
        const entry = interfaces.get(found[1]) ?? interfaces.set(found[1], { count: 0, callable: false }).get(found[1]);
        entry.count++;
        if (callable.test(statement.slice(found[0].length))) entry.callable = true;
      }
    }
  }
  // The place behind white space from `from` on, or -1 where a comment stands there.
  const behindSpace = from => {
    let at = from;
    while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '\r' || text[at] === '\n')) at++;
    return text[at] === '/' ? -1 : at;
  };
  // The serialized type of the annotation whose colon stands at or behind `from`; Object without one.
  const typeAt = (from, rest) => {
    const colon = behindSpace(from);
    if (colon < 0) return null;
    if (text[colon] !== ':') return 'Object';
    const end = annotations.get(colon);
    if (end === undefined) return null;
    let type = slice(colon + 1, end);
    if (rest) {
      // A rest parameter gives the type of its elements, when it is written as an array of them.
      const element = /^([\s\S]*\S)\s*\[\s*\]\s*$/.exec(type);
      if (element === null || /[|&?]|=>|^\s*readonly\b/.test(element[1])) return null;
      type = element[1];
    }
    return serialize(type);
  };
  const context = { metadata, text, typeAt, behindSpace, used: false };
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
      const head = text.slice(leftFirst, leftLast).replace(comments, ' ');
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
      if (current !== null && depth === current.depth) {
        // A body opened before this one belonged to a class expression in the heritage clause. Its members
        // are not this class's; decorators on them are not lowered here.
        if (current.members.some(member => member.decorators.length !== 0 || member.parameters.length !== 0) ||
            current.constructor.length !== 0) return null;
        current.members = [];
        current.member = null;
        current.erased = [];
        current.bodyFirst = leftFirst;
      }
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
        spelled: slice(rightFirst, rightLast), start: leftFirst, keyFirst: rightFirst, keyLast: flags & 16 ? rightLast + 1 : rightLast, all: [], listEnd: -1 };
      if (pending.length !== 0) {
        // A decorator on an accessor field receives a descriptor that this lowering does not write.
        if (/\baccessor\b/.test(text.slice(pending[pending.length - 1].last, rightFirst).replace(comments, ' '))) return null;
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
      scope.local = current.local;
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
    const identity = (member.flags & 1) + ':' + member.spelled;
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
  // Inside the body of a named class expression its name means the undecorated class, and nothing can assign
  // to it. TypeScript gives the decorated class a second variable, `A_1`, and writes that name for every
  // reference in the body, which takes scope analysis. Here the class expression loses its name and stands in
  // a scope of its own that declares the name again:
  //
  //   let [A, A_1] = (() => { let A; A = class { static { A = this; } ... }; return [A, A_1 => A = A_1]; })();
  //   A = A_1(__decorate([D], A));
  //
  // The body sees the inner variable, which is TypeScript's `A_1`: it holds the class while the static members
  // run and the decorated class afterwards, and an assignment to the outer variable does not reach it. The
  // outer variable is not initialized before the class is, as in TypeScript's text. An arrow function keeps
  // `this`, `arguments` and `super`; it does not keep `await` and `yield`, which may stand in the heritage
  // clause and in computed keys.
  const escaped = found.name.replace(/\$/g, '\\$');
  const within = text.slice(found.nameLast, end);
  // A name behind a single dot is a property; behind three it is spread.
  const named = !anonymous && new RegExp('(?<![\\w$])(?<!(?<!\\.)\\.)' + escaped + '(?![\\w$])').test(within);
  const setter = found.name + '_1';
  // Inside a function TypeScript's second variable belongs to the function, so every run of the function
  // shares it, and the body of an earlier class sees a later one. That is left to TypeScript.
  // TypeScript writes its second name only for references in the body that are expressions of their own. In
  // the heritage clause, and as a shorthand property `{ A }`, the name stays and means the undecorated class.
  // Both are left to TypeScript; a name between a comma or a brace and a comma or a brace may be a shorthand.
  const reference = '(?<![\\w$])(?<!(?<!\\.)\\.)' + escaped + '(?![\\w$])';
  // White space and comments, which may stand between the brace or comma and the name.
  const gap = '(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\n\\r]*)*';
  // Type parameters, type arguments and the implements clause of the head are types, which are erased.
  let heritage = found.bodyFirst !== undefined ? text.slice(found.nameLast, found.bodyFirst).replace(/\bimplements\b[\s\S]*$/, '') : '';
  for (let before = ''; before !== heritage;) { before = heritage; heritage = heritage.replace(/<[^<>]*>/g, ''); }
  // A computed key is evaluated with the heritage clause, where the name means the undecorated class as well.
  // The keys of members without a decorator are not recorded, so the name behind an opening bracket that
  // may begin a member is taken for one (a computed key of an object literal in a method is declined with it).
  const unrenamed = found.bodyFirst !== undefined && (new RegExp(reference).test(heritage) ||
    new RegExp('[{,]' + gap + reference + gap + '[,}]').test(text.slice(found.bodyFirst, end)) ||
    new RegExp('(?:[{};*]|\\b(?:static|async|get|set|readonly|public|private|protected|override|accessor|declare))' + gap +
      '\\[[^\\]\\n\\r]*' + reference).test(text.slice(found.bodyFirst, end)));
  // An await belongs to the function around the class when it stands in the heritage clause or in a computed key.
  const awaits = /\b(?:await|yield)\b/;
  const outside = found.bodyFirst !== undefined && (awaits.test(text.slice(found.nameLast, found.bodyFirst)) ||
    found.members.some(member => (member.flags & 32) && awaits.test(member.key)));
  if (named && (found.local || found.bodyFirst === undefined || text[found.bodyFirst] !== '{' || outside || unrenamed ||
      new RegExp('(?<![\\w$])' + escaped + '_1(?![\\w$])').test(text))) return null;
  const list = found.decorators.map(decorator => decorator.expression);
  for (const parameter of found.constructor) {
    for (const decorator of parameter.decorators) list.push(`__param(${parameter.index}, ${decorator.expression})`);
  }
  if (constructorTypes !== null) context.used = true;
  if (constructorTypes !== null) list.push(`__metadata("design:paramtypes", [${constructorTypes.join(', ')}])`);
  const decorated = `__decorate([${list.join(', ')}], ${found.name})`;
  statements.push(named ? `${found.name} = ${setter}(${decorated});` : `${found.name} = ${decorated};`);
  if (found.isDefault) statements.push(`export default ${found.name};`);
  else if (found.exported) statements.push(`export { ${found.name} };`);
  // A class expression cannot be abstract, so the members that are erased anyway go with the modifier. A
  // semicolon stands where each stood: the field before it may end by a line break alone, and the member
  // behind it may begin with a bracket.
  return [
    ...(named ? [[found.headFirst, found.nameLast, `let [${found.name}, ${setter}] = (() => { let ${found.name}; ${found.name} = class`],
      [found.bodyFirst + 1, found.bodyFirst + 1, ` static { ${found.name} = this; }`]] :
      [[found.headFirst, found.headLast, `let ${found.name} = class `]]),
    ...found.erased.map(([first, last]) => [first, last, ';']),
    [end, end, (named ? `; return [${found.name}, ${setter} => ${found.name} = ${setter}]; })();\n` : ';\n') + statements.join('\n') + '\n'],
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
    // The key may be followed by a question mark or an exclamation mark, then by the annotation.
    const mark = context.behindSpace(member.keyLast);
    if (mark < 0) return null;
    const type = context.typeAt(text[mark] === '?' || text[mark] === '!' ? mark + 1 : mark, false);
    return type === null ? null : [`__metadata("design:type", ${type})`];
  }
  if (member.flags & 8) {
    // TypeScript reads the type of an accessor from both of its declarations.
    const same = found.members.filter(other => (other.flags & 8) && (other.flags & 1) === (member.flags & 1) && other.spelled === member.spelled);
    if (same.length !== 1) return null;
    // A computed key may spell the same name: `set ["value"](v)`.
    if (found.members.some(other => (other.flags & 8) && (other.flags & 32) && !other.key.startsWith('#'))) return null;
    // TypeScript serializes the type of a setter's parameter twice: as the type of the member, then in the list.
    const first = member.all.length === 1 ? parameterTypes(member, context) : member.all.length === 0 ? [context.typeAt(member.listEnd, false)] : null;
    if (first === null || first[0] === null) return null;
    const types = parameterTypes(member, context);
    if (types === null) return null;
    return [`__metadata("design:type", ${first[0]})`, `__metadata("design:paramtypes", [${types.join(', ')}])`];
  }
  const types = parameterTypes(member, context);
  if (types === null) return null;
  const behind = context.behindSpace(member.listEnd);
  if (behind < 0) return null;
  // The words in front of the key, behind the member's decorators: an async method that is no generator
  // returns a Promise when it has no annotation, and any other method nothing.
  const from = member.decorators.length !== 0 ? member.decorators[member.decorators.length - 1].last : member.start;
  const modifiers = text.slice(from, member.keyFirst).replace(comments, ' ');
  const result = text[behind] === ':' ? context.typeAt(member.listEnd, false) :
    /\basync\b/.test(modifiers) && !modifiers.includes('*') ? 'Promise' : 'void 0';
  if (result === null) return null;
  return ['__metadata("design:type", Function)', `__metadata("design:paramtypes", [${types.join(', ')}])`, `__metadata("design:returntype", ${result})`];
}

exports.lowerLegacyDecorators = lowerLegacyDecorators;
