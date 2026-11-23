import { createHash } from 'node:crypto';
import { collectMutations } from './builtin-mutations.mjs';
import { byteOffsets } from './source-text.mjs';

// Runtime switches for the built-in mutation set. Expressions become `on(id) ? mutated : (cover(id), original)`;
// blocks, case clauses and removable statements become `if (on(id)) mutated else { cover(id); original }`.
// The helpers speak the test session's protocol: one active mutation and per-test hit counts.
const helpers = (on, cover, scope) => `
function ${on}(id) {
  var scope = ${scope}, ns = scope.__stryker__ || (scope.__stryker__ = {});
  if (ns.activeMutant !== id) return false;
  if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) throw new Error('Mutation hit limit reached (' + ns.hitCount + ')');
  return true;
}
function ${cover}() {
  var scope = ${scope}, ns = scope.__stryker__ || (scope.__stryker__ = {});
  var coverage = ns.mutantCoverage || (ns.mutantCoverage = { static: {}, perTest: {} });
  var counts = ns.currentTestId ? (coverage.perTest[ns.currentTestId] || (coverage.perTest[ns.currentTestId] = {})) : coverage.static;
  for (var i = 0; i < arguments.length; i++) counts[arguments[i]] = (counts[arguments[i]] || 0) + 1;
}
`;
const outerFirst = { statement: 0, block: 0, case: 0, expression: 1 };

function unusedName(text, base) {
  let name = base;
  while (text.includes(name)) name += '_';
  return name;
}

// A plain edit at the start of a statement must not begin with a token that continues the previous line.
function asStatementStart(mutant, text) {
  const edited = mutant.mutated.trimStart();
  const risky = (mutant.statement || mutant.leading) && '([`+-/'.includes(edited[0]) && edited[0] !== text[mutant.placement[0]];
  return risky ? ' void 0, ' + edited : mutant.mutated;
}

export function renderBuiltinSwitches(input, file, selected = () => true, options = {}) {
  const text = input.toString();
  const all = collectMutations(text, file, { ...options, selected });
  const found = options.keep ? all.filter(mutation => options.keep(mutation, text)) : all;
  if (!found.length) return { output: text, mutants: [] };
  const live = found.filter(mutation => mutation.ignored === undefined);
  const bytes = byteOffsets(text);
  const lineStarts = [0];
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) lineStarts.push(match.index + match[0].length);
  const lineOf = offset => {
    let line = lineStarts.length - 1;
    while (lineStarts[line] > offset) line--;
    return line;
  };
  const on = unusedName(text, '__tmtOn');
  const cover = unusedName(text, '__tmtCover');
  const identified = mutation => ({ ...mutation,
    id: createHash('sha256').update(JSON.stringify([file, mutation.name, mutation.start, mutation.end, mutation.replacement])).digest('hex').slice(0, 16) });
  const mutants = live.map(identified);

  const groups = new Map();
  for (const mutant of mutants) {
    const key = `${mutant.placement[0]}:${mutant.placement[1]}:${mutant.kind}`;
    if (!groups.has(key)) groups.set(key, { ...mutant, mutants: [] });
    groups.get(key).mutants.push(mutant);
  }
  const ordered = [...groups.values()].sort((a, b) => a.placement[0] - b.placement[0] || b.placement[1] - a.placement[1] ||
    outerFirst[a.kind] - outerFirst[b.kind]);
  let index = 0;

  function render(start, end) {
    let out = '';
    let from = start;
    while (index < ordered.length && ordered[index].placement[0] < end) {
      const group = ordered[index++];
      const [first, last] = group.placement;
      out += text.slice(from, first);
      const ids = group.mutants.map(mutant => JSON.stringify(mutant.id));
      if (group.kind === 'expression') {
        const inner = render(first, last);
        // An arrow function bound to a variable keeps the variable's name through an inner binding.
        // A property initializer names the function without adding a binding the function body could see.
        const keepName = body => group.named ? `({ ${group.named}: ${body} }).${group.named}` : body;
        const choice = group.mutants.map(mutant => `${on}(${JSON.stringify(mutant.id)}) ? ${keepName(mutant.mutated)} : `).join('') +
          `(${cover}(${ids.join(', ')}), ${keepName(inner)})`;
        // A statement that starts with `(` could continue the previous line as a call.
        // The leading space separates the switch from a keyword such as `do` or `else`.
        out += group.statement ? ` ${choice}` : group.leading ? ` void 0, (${choice})` : `(${choice})`;
      } else if (group.kind === 'block') {
        // The semicolon ends a directive prologue that relies on a line break.
        // A function body returns early instead of moving into a block, which would change how its declarations are scoped.
        out += group.functionBody
          ? `${text.slice(first, group.bodyStart)}; if (${on}(${ids[0]})) return; ${cover}(${ids[0]});` +
            `${render(group.bodyStart, group.bodyEnd)}${text.slice(group.bodyEnd, last)}`
          : `${text.slice(first, group.bodyStart)}; if (${on}(${ids[0]})) {} else { ${cover}(${ids[0]});` +
            `${render(group.bodyStart, group.bodyEnd)}\n} ${text.slice(group.bodyEnd, last)}`;
      } else if (group.kind === 'case') {
        // The case expression can hold switches of its own, so the head is rendered too.
        out += `${render(first, group.bodyStart)} if (${on}(${ids[0]})) {} else { ${cover}(${ids[0]});${render(group.bodyStart, last)}\n}`;
      } else {
        out += ' { ' + group.mutants.map(mutant => `if (${on}(${JSON.stringify(mutant.id)})) { ${mutant.mutated} } else `).join('') +
          `{ ${cover}(${ids.join(', ')}); ${render(first, last)}\n} }`;
      }
      from = last;
    }
    return out + text.slice(from, end);
  }

  // A module that binds its own `globalThis` reaches the real global object through an indirect eval.
  const scope = /\bglobalThis\b/.test(text) ? "(0, eval)('this')" : 'globalThis';
  // A file whose mutations are all ignored keeps its source.
  const output = mutants.length ? render(0, text.length) + helpers(on, cover, scope) : text;
  // Ignored mutations are reported in source order with the others and get no switch.
  const reported = [...mutants, ...found.filter(mutation => mutation.ignored !== undefined).map(identified)]
    .sort((a, b) => a.start - b.start || b.end - a.end);
  return { output, mutants: reported.map(mutant => {
    const line = lineOf(mutant.start);
    const edit = [bytes[mutant.start], bytes[mutant.end]];
    return {
      id: mutant.id, mutatorName: mutant.name,
      location: { file, line: line + 1, column: mutant.start - lineStarts[line] + 1, start: edit[0], end: edit[1] },
      edit, original: text.slice(mutant.start, mutant.end), replacement: mutant.replacement,
      // The same mutation as a plain source edit, for runners that cannot use switches.
      source: { edit: [bytes[mutant.placement[0]], bytes[mutant.placement[1]]], replacement: asStatementStart(mutant, text) },
      ...(mutant.operator ? { operatorSwap: [bytes[mutant.operator[0]], mutant.operator[1]] } : {}),
      ...(mutant.ignored === undefined ? {} : { status: 'ignored', statusReason: mutant.ignored }),
    };
  }) };
}

// The swaps the focused analysis makes at a comparison boundary: `>=` with `>` and `<=` with `<`.
export const boundarySwap = (mutation, text) => mutation.operator !== undefined &&
  ['>', '>=', '<', '<='].includes(mutation.operator[1]) && text[mutation.operator[0]] === mutation.operator[1][0];

// The boundary swaps that a `// Stryker disable` comment covers, as `offset:replacement` keys in UTF-8 bytes.
export function ignoredSwaps(input, file, options = {}) {
  if (!input.includes('Stryker ')) return new Set();
  return new Set(renderBuiltinSwitches(input, file, () => true, { ...options, keep: boundarySwap }).mutants
    .filter(mutant => mutant.status === 'ignored').map(mutant => mutant.operatorSwap.join(':')));
}

export function prepareBuiltinSwitches(subjects, options = {}) {
  const sources = [];
  const mutants = [];
  for (const { file, input, selected } of subjects) {
    const rendered = renderBuiltinSwitches(input, file, selected, options);
    if (!rendered.mutants.length) continue;
    if (rendered.output !== input.toString()) sources.push({ file, output: rendered.output });
    mutants.push(...rendered.mutants);
  }
  return { sources, mutants };
}
