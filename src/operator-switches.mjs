import { createHash } from 'node:crypto';
import { byteLocations } from './extract.mjs';
import { collectOperatorSites } from './operator-sites.mjs';

// Each operator becomes `on(id) ? edited : (cover(id), original)`, so one test session can try every edit.
// The helpers speak the session's coverage protocol: per-test hit counts and a single active edit.
const helpers = (on, cover, scope) => `
function ${on}(id) {
  var scope = ${scope}, ns = scope.__stryker__ || (scope.__stryker__ = {});
  if (ns.activeMutant !== id) return false;
  if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) throw new Error('Edit hit limit reached (' + ns.hitCount + ')');
  return true;
}
function ${cover}(id) {
  var scope = ${scope}, ns = scope.__stryker__ || (scope.__stryker__ = {});
  var coverage = ns.mutantCoverage || (ns.mutantCoverage = { static: {}, perTest: {} });
  var counts = ns.currentTestId ? (coverage.perTest[ns.currentTestId] || (coverage.perTest[ns.currentTestId] = {})) : coverage.static;
  counts[id] = (counts[id] || 0) + 1;
}
`;

function unusedName(text, base) {
  let name = base;
  while (text.includes(name)) name += '_';
  return name;
}

export function renderOperatorSwitches(input, file, selected = () => true, options = {}) {
  const candidates = collectOperatorSites(input, file, options);
  if (!candidates.length) return { output: input.toString(), mutants: [] };
  const positions = byteLocations(input, candidates.map(site => site.edit[0]));
  const sites = candidates.map((site, index) => ({ ...site, line: positions[index * 2], column: positions[index * 2 + 1] }))
    .filter(site => selected(site.line));
  if (!sites.length) return { output: input.toString(), mutants: [] };
  const text = input.toString();
  const on = unusedName(text, '__tmtOn');
  const cover = unusedName(text, '__tmtCover');
  const slice = (start, end) => input.subarray(start, end).toString();
  // Outer expressions first: an operator's own span starts at its left operand and ends at its right operand.
  const ordered = sites.map(site => ({ ...site, span: [site.left[0], site.right[1]],
    id: createHash('sha256').update(JSON.stringify([file, site.rule, site.edit])).digest('hex').slice(0, 16) }))
    .sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  let index = 0;

  function render(start, end) {
    let out = '';
    let from = start;
    while (index < ordered.length && ordered[index].span[0] < end) {
      const site = ordered[index++];
      const [first, last] = site.span;
      out += slice(from, first);
      const original = render(first, site.edit[0]) + slice(site.edit[0], site.edit[1]) + render(site.edit[1], last);
      const edited = slice(first, site.edit[0]) + site.replacement + slice(site.edit[1], last);
      const id = JSON.stringify(site.id);
      const choice = `${on}(${id}) ? ${edited} : (${cover}(${id}), ${original})`;
      // A statement that starts with `(` could continue the previous line as a call.
      out += site.statement ? choice : site.leading ? `void 0, (${choice})` : `(${choice})`;
      from = last;
    }
    return out + slice(from, end);
  }

  // A module that binds its own `globalThis` reaches the real global object through an indirect eval.
  const scope = /\bglobalThis\b/.test(text) ? "(0, eval)('this')" : 'globalThis';
  const output = render(0, input.length) + helpers(on, cover, scope);
  return { output, mutants: ordered.sort((a, b) => a.edit[0] - b.edit[0]).map(site => ({
    id: site.id, mutatorName: site.rule,
    location: { file, line: site.line, column: site.column, start: site.edit[0], end: site.edit[1] },
    edit: site.edit, original: site.operator, replacement: site.replacement,
  })) };
}

export function prepareOperatorSwitches(subjects, options = {}) {
  const sources = [];
  const mutants = [];
  for (const { file, input, selected } of subjects) {
    const rendered = renderOperatorSwitches(input, file, selected, options);
    if (!rendered.mutants.length) continue;
    sources.push({ file, output: rendered.output });
    mutants.push(...rendered.mutants);
  }
  return { sources, mutants };
}
