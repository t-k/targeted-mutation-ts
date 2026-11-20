import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';

const transform = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'h' },
}).outputText;
const activeStrykerMutant = process.env.__STRYKER_ACTIVE_MUTANT__;
const stryker = activeStrykerMutant === undefined ? '' :
  'globalThis.__stryker__ = { activeMutant: ' + JSON.stringify(activeStrykerMutant) + ' };\n';
const factory = stryker + 'const h = (tag, props) => ({ tag, props });\n';
const eligibility = factory + transform(readFileSync(new URL('./src/eligibility.tsx', import.meta.url), 'utf8'));
const save = factory + transform(readFileSync(new URL('./src/save.tsx', import.meta.url), 'utf8'));
const load = source => import('data:text/javascript,' + encodeURIComponent(source));
const { eligibility: eligibilityButton } = await load(eligibility);
const { saveButton } = await load(save);

function markup({ props }) {
  const name = props['aria-label'];
  return `<button type="submit" aria-label="${name}"${props.disabled ? ' disabled' : ''}>${name}</button>`;
}

const action = `
const { saveButton } = await import('/save.js');
const form = document.querySelector('form');
const button = form.querySelector('button');
const valid = form.dataset.valid === 'true';
let saving = false;
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving || !valid) return;
  saving = true;
  button.disabled = saveButton(saving, valid).props.disabled;
  try {
    await fetch('/api/save', { method: 'POST' });
  } finally {
    saving = false;
    button.disabled = saveButton(saving, valid).props.disabled;
  }
});
`;

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/save.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(save);
  } else if (url.pathname === '/api/save') {
    response.writeHead(204).end();
  } else {
    const valid = url.searchParams.get('valid') === 'yes';
    const content = url.pathname === '/save'
      ? `<form data-valid="${valid}">${markup(saveButton(false, valid))}</form><script type="module">${action}</script>`
      : markup(eligibilityButton(Number(url.searchParams.get('age') ?? 17)));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Boundary fixture</title><main>${content}</main></html>`);
  }
});

server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  if (process.env.TMT_SERVER_PID_FILE) writeFileSync(process.env.TMT_SERVER_PID_FILE, String(process.pid));
});
