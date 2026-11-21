import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, relative, resolve, sep } from 'node:path';

export function rewrite(source, edit, replacement) {
  const [start, end] = edit;
  return Buffer.concat([source.subarray(0, start), Buffer.from(replacement), source.subarray(end)]);
}

function sourceSpellings(source) {
  return source.includes('\\u') ? source.toString().replace(/\\u(?:\{([\da-fA-F]+)\}|([\da-fA-F]{4}))/g,
    (escape, braced, short) => {
      const code = Number.parseInt(braced ?? short, 16);
      return code < 128 ? String.fromCharCode(code) : escape;
    }) : source;
}

const require = createRequire(import.meta.url);

function explicitPackageType(root, file) {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const manifest = resolve(directory, 'package.json');
    if (existsSync(manifest)) {
      const contents = readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '');
      try { return JSON.parse(contents)?.type; }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return undefined;
      }
    }
    if (directory === root || dirname(directory) === directory) return undefined;
  }
}

const commonJsWrapperNames = new Set(['require', 'module', 'exports', '__dirname', '__filename']);

function hasWrapperBinding(ts, name) {
  if (ts.isIdentifier(name)) return commonJsWrapperNames.has(name.text);
  return name.elements.some(element => ts.isBindingElement(element) && hasWrapperBinding(ts, element.name));
}

function ambient(ts, node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

function hasRuntimeModuleSyntax(file, source) {
  const ts = require('typescript');
  const parsed = ts.createSourceFile(file, source.toString(), ts.ScriptTarget.Latest, false);
  if (parsed.statements.some(statement => {
    if (ambient(ts, statement)) return false;
    if (ts.isImportDeclaration(statement)) return !statement.importClause?.isTypeOnly;
    if (ts.isExportDeclaration(statement)) return !statement.isTypeOnly;
    if (ts.isExportAssignment(statement)) return !statement.isExportEquals;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false;
    if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
    if (ts.isClassDeclaration(statement) && statement.name && hasWrapperBinding(ts, statement.name)) return true;
    return ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped) &&
      statement.declarationList.declarations.some(declaration => hasWrapperBinding(ts, declaration.name));
  })) return true;

  const pending = [[parsed, true]];
  while (pending.length) {
    const [node, topLevel] = pending.pop();
    if (ambient(ts, node) || ts.isTypeNode(node)) continue;
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return true;
    if (topLevel && (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier))) return true;
    const childTopLevel = topLevel && !ts.isFunctionLike(node) && !ts.isClassLike(node);
    ts.forEachChild(node, child => { pending.push([child, childTopLevel]); });
  }
  return false;
}

export function needsProbePreload(root, file, source) {
  const extension = extname(file).toLowerCase();
  if (extension === '.cjs' || extension === '.cts') return true;
  if (extension !== '.js' && extension !== '.ts') return false;
  const type = explicitPackageType(root, file);
  if (type === 'module' || type === 'commonjs') return type === 'commonjs';
  return !hasRuntimeModuleSyntax(file, source);
}

export function freshProbeBinding(sources) {
  const spellings = sources.map(sourceSpellings);
  let binding = '__tmtProbe_' + randomUUID().replaceAll('-', '');
  while (spellings.some(source => source.includes(binding))) binding += '_';
  return binding;
}

export function instrument(root, file, source, sites, preloadedBinding) {
  const runtime = resolve(root, '.tmt-probe.mjs');
  const path = relative(dirname(resolve(root, file)), runtime).split(sep).join('/');
  const spellings = sourceSpellings(source);
  let alias = '__tmtCompare';
  while (spellings.includes(alias)) alias += '_';
  const comparison = preloadedBinding ? preloadedBinding + '.compare' : alias;
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
      chunks.push(source.subarray(from, first).toString(), comparison,
        '(' + [site.id, site.operator, site.replacement].map(JSON.stringify).join(',') + ',(',
        render(first, afterLeft), source.subarray(afterLeft, site.edit[0]).toString(), '),(',
        source.subarray(site.edit[1], rightStart).toString(), render(rightStart, last), '))');
      from = last;
    }
    chunks.push(source.subarray(from, end).toString());
    return chunks.join('');
  }

  const sourceText = render(0, source.length);
  const specifier = JSON.stringify(path.startsWith('../') ? path : './' + path);
  const ids = JSON.stringify(sites.map(site => site.id));
  if (preloadedBinding) return sourceText + '\n' + preloadedBinding + '.loaded(' + ids + ');\n';
  return sourceText + '\nimport { compare as ' + alias + ', loaded as ' + alias + 'Loaded } from ' +
    specifier + ';\n' + alias + 'Loaded(' + ids + ');\n';
}

export function installProbe(root, preloadedBinding) {
  copyFileSync(new URL('./probe-runtime.mjs', import.meta.url), resolve(root, '.tmt-probe.mjs'), 1);
  if (!preloadedBinding) return;
  const preload = resolve(root, '.tmt-probe-register.cjs');
  writeFileSync(preload, `
'use strict';
let runtime;
const load = () => runtime ??= require('./.tmt-probe.mjs');
Object.defineProperty(globalThis, ${JSON.stringify(preloadedBinding)}, {
  value: {
    compare: (...args) => load().compare(...args),
    loaded: ids => load().loaded(ids),
  },
});
`, { flag: 'wx' });
  return preload;
}
