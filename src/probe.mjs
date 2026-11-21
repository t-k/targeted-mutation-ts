import { copyFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

export function rewrite(source, edit, replacement) {
  const [start, end] = edit;
  return Buffer.concat([source.subarray(0, start), Buffer.from(replacement), source.subarray(end)]);
}

export function instrument(root, file, source, sites) {
  const runtime = resolve(root, '.tmt-probe.mjs');
  const path = relative(dirname(resolve(root, file)), runtime).split(sep).join('/');
  const spellings = source.includes('\\u') ? source.toString().replace(/\\u(?:\{([\da-fA-F]+)\}|([\da-fA-F]{4}))/g,
    (escape, braced, short) => {
      const code = Number.parseInt(braced ?? short, 16);
      return code < 128 ? String.fromCharCode(code) : escape;
    }) : source;
  let alias = '__tmtCompare';
  while (spellings.includes(alias)) alias += '_';
  const sorted = sites.slice().sort((a, b) => a.left[0] - b.left[0] || b.right[1] - a.right[1]);
  let index = 0;

  function render(start, end) {
    const chunks = [];
    let from = start;
    while (index < sorted.length && sorted[index].left[0] < end) {
      const site = sorted[index++];
      const [first, afterLeft] = site.left;
      const [rightStart, last] = site.right;
      if (first < from || last > end || afterLeft > site.edit[0] || rightStart < site.edit[1]) {
        throw new Error('Overlapping probe spans');
      }
      chunks.push(source.subarray(from, first).toString(), alias,
        '(' + [site.id, site.operator, site.replacement].map(JSON.stringify).join(',') + ',(',
        render(first, afterLeft), source.subarray(afterLeft, site.edit[0]).toString(), '),(',
        source.subarray(site.edit[1], rightStart).toString(), render(rightStart, last), '))');
      from = last;
    }
    chunks.push(source.subarray(from, end).toString());
    return chunks.join('');
  }

  return render(0, source.length) +
    '\nimport { compare as ' + alias + ', loaded as ' + alias + 'Loaded } from ' +
    JSON.stringify(path.startsWith('../') ? path : './' + path) + ';\n' +
    alias + 'Loaded(' + JSON.stringify(sites.map(site => site.id)) + ');\n';
}

export function installProbe(root) {
  copyFileSync(new URL('./probe-runtime.mjs', import.meta.url), resolve(root, '.tmt-probe.mjs'), 1);
}
