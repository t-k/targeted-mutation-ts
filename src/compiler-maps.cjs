'use strict';

// A type-erased output keeps every byte position, so its map comes from one native scan.
// Lowered output, a byte order mark and unusual names take the router, which asks TypeScript.
function mappedTypeScript(input, file, flags, addon) {
  const slash = file.lastIndexOf('/');
  const name = slash < 0 ? file : file.slice(slash + 1);
  if (!name.endsWith('.mts') && !name.endsWith('.ts') && !name.endsWith('.tsx') || name.includes('\\')) return undefined;
  const text = typeof input === 'string' ? input : Buffer.isBuffer(input) ? undefined : null;
  if (text === null || text !== undefined && (!text.isWellFormed() || text.charCodeAt(0) === 0xFEFF)) return undefined;
  const source = text === undefined ? input : Buffer.from(text);
  if (source[0] === 0xEF) return undefined;
  const emit = addon.emitTypeScript;
  const result = emit === undefined ? undefined : emit(source, flags | 16);
  if (result === undefined) return undefined;
  return { backend: 'pulse', code: result[0], sourceMap: sourceMapObject(file, result[1], text ?? source.toString()), diagnostics: [] };
}

// The fields other than the mappings follow the map TypeScript writes for the same name.
function sourceMapObject(file, mappings, text, preserveJsx = false, format = 'preserve') {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const outExt = preserveJsx && /x$/i.test(name) ? '.jsx' :
    format === 'cjs' && /\.c[jt]s$/i.test(name) ? '.cjs' :
      /\.m[jt]s$/i.test(name) && format !== 'cjs' ? '.mjs' : '.js';
  return { version: 3, file: name.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/i, outExt), sourceRoot: '', sources: [name], names: [],
    mappings, sourcesContent: [text] };
}

// The source kinds and flags of the entry (src/compiler.cjs).
const classic = 4, esm = 2, script = 8;

// An option spelled out with its default value selects the same route as an omitted one. A module format of esm
// and a source map have native routes of their own. Returns undefined for everything the router has to decide.
function compileExplicit(input, options, compile, sourceKind, moduleAddon) {
  const name = options.file;
  const jsx = options.jsx;
  const format = options.module;
  const map = options.sourceMap;
  // The decorator options are the router's to read.
  if (options.experimentalDecorators !== undefined || options.emitDecoratorMetadata !== undefined) return undefined;
  if (options.mode !== undefined && options.mode !== 'transform' || options.target !== undefined && options.target !== 'esnext' ||
      map !== undefined && typeof map !== 'boolean' || name !== undefined && typeof name !== 'string' ||
      jsx !== undefined && jsx !== 'automatic' && jsx !== 'classic' ||
      format !== undefined && format !== 'preserve' && format !== 'esm') return undefined;
  const file = name === undefined ? 'input.ts' : name;
  const kind = sourceKind(file);
  if (map !== true && (format !== 'esm' || kind === (script | esm))) {
    // Every option has its default value, or names the module format that an .mjs name already implies,
    // so the default call gives the same result.
    return compile(input, name === undefined && jsx === undefined ? undefined : { file, jsx });
  }
  if (kind < 0 || kind >= script) return undefined;
  const flags = kind | (jsx === 'classic' ? classic : 0) | (format === 'esm' ? esm : 0);
  if (map === true) return mappedTypeScript(input, file, flags, moduleAddon());
  const source = Buffer.isBuffer(input) ? input : typeof input === 'string' && input.isWellFormed() ? Buffer.from(input) : null;
  const emit = source === null ? undefined : moduleAddon().emitTypeScript;
  const code = emit === undefined ? undefined : emit(source, flags);
  return code === undefined ? undefined : { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
}

exports.compileExplicit = compileExplicit;
exports.mappedTypeScript = mappedTypeScript;
exports.sourceMapObject = sourceMapObject;
